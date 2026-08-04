import { randomUUID } from 'node:crypto';

const RESULT_STATUSES = new Set([
  'planned',
  'ready',
  'running',
  'waiting-external',
  'needs-approval',
  'blocked',
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'compensating',
  'compensated',
  'skipped',
]);

export function actionSuccess(operation, appId, data = {}, options = {}) {
  return {
    version: 1,
    ok: true,
    operation,
    requestId: options.requestId || `req-${randomUUID()}`,
    appId,
    status: options.status || 'succeeded',
    data,
    warnings: options.warnings || [],
    nextActions: options.nextActions || [],
    evidenceRefs: options.evidenceRefs || [],
    error: null,
  };
}

export function actionFailure(operation, appId, error, options = {}) {
  return {
    version: 1,
    ok: false,
    operation,
    requestId: options.requestId || `req-${randomUUID()}`,
    appId,
    status: options.status || statusForError(error.code),
    data: options.data || null,
    warnings: options.warnings || [],
    nextActions: options.nextActions || [],
    evidenceRefs: options.evidenceRefs || [],
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable === true,
      provider: error.provider || '',
      resourceId: error.resourceId || '',
      details: redactDetails(error.details || {}),
    },
  };
}

export function validateActionResult(result, expected = {}) {
  const issues = [];
  if (result?.version !== 1) issues.push('$.version');
  if (typeof result?.ok !== 'boolean') issues.push('$.ok');
  if (typeof result?.operation !== 'string' || !result.operation) issues.push('$.operation');
  if (expected.operation && result?.operation !== expected.operation) issues.push('$.operation');
  if (typeof result?.requestId !== 'string' || !result.requestId) issues.push('$.requestId');
  if (typeof result?.appId !== 'string' || !result.appId) issues.push('$.appId');
  if (expected.appId && result?.appId !== expected.appId) issues.push('$.appId');
  if (!RESULT_STATUSES.has(result?.status)) issues.push('$.status');
  for (const key of ['warnings', 'nextActions', 'evidenceRefs']) if (!Array.isArray(result?.[key])) issues.push(`$.${key}`);
  if (result?.ok && result?.error !== null) issues.push('$.error');
  if (!result?.ok && (!result?.error || typeof result.error.code !== 'string')) issues.push('$.error');
  if (containsSecretValue(result)) issues.push('$(secret-like-value)');
  if (issues.length > 0) throw new Error(`ActionResult is invalid at: ${[...new Set(issues)].join(', ')}`);
  return result;
}

export function containsSecretLikeValue(value) {
  return containsSecretValue(value);
}

export function mapProviderError(provider, input) {
  const status = Number(input.status || 0);
  const code =
    status === 401 ? 'CREDENTIAL_MISSING' :
    status === 403 ? 'CAPABILITY_MISSING' :
    status === 404 ? 'NOT_FOUND' :
    status === 409 ? 'CONFLICT' :
    status === 429 ? 'RATE_LIMITED' :
    status >= 500 ? 'PROVIDER_UNAVAILABLE' :
    input.code || 'VALIDATION_FAILED';
  return {
    code,
    message: safeProviderMessage(input.message || `Provider request failed with status ${status || 'unknown'}.`),
    retryable: ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE'].includes(code),
    provider,
    resourceId: input.resourceId || '',
    details: {
      status: status || undefined,
      retryAfter: input.retryAfter || undefined,
    },
  };
}

export class FixtureProviderAdapter {
  constructor(provider = 'fixture') {
    this.provider = provider;
    this.resources = new Map();
    this.idempotency = new Map();
    this.calls = [];
    this.sequence = 0;
  }

  read(input) {
    this.calls.push({ operation: 'read', logicalId: input.logicalId });
    const resource = this.resources.get(input.logicalId);
    if (!resource) return actionFailure('resource.read', input.appId, {
      code: 'NOT_FOUND', message: `Resource not found: ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    return actionSuccess('resource.read', input.appId, { resource: structuredClone(resource), observedAt: input.now || new Date().toISOString() });
  }

  create(input) {
    this.calls.push({ operation: 'create', logicalId: input.logicalId, idempotencyKey: input.idempotencyKey });
    if (!input.idempotencyKey) return actionFailure('resource.create', input.appId, {
      code: 'VALIDATION_FAILED', message: 'Create requires an idempotency key.', retryable: false, provider: this.provider,
    });
    const prior = this.idempotency.get(input.idempotencyKey);
    if (prior) return actionSuccess('resource.create', input.appId, { resource: structuredClone(prior), created: true, replayed: true });
    if (this.resources.has(input.logicalId)) return actionFailure('resource.create', input.appId, {
      code: 'ALREADY_EXISTS', message: `Resource already exists: ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    const resource = {
      logicalId: input.logicalId,
      provider: this.provider,
      providerId: `${this.provider}-${++this.sequence}`,
      type: input.type,
      name: input.name,
      lifecycle: 'managed',
      version: 1,
      attributes: structuredClone(input.attributes || {}),
    };
    this.resources.set(input.logicalId, resource);
    this.idempotency.set(input.idempotencyKey, resource);
    return actionSuccess('resource.create', input.appId, { resource: structuredClone(resource), created: true, replayed: false });
  }

  ensure(input) {
    this.calls.push({ operation: 'ensure', logicalId: input.logicalId });
    const existing = this.resources.get(input.logicalId);
    if (!existing) {
      const created = this.create(input);
      return created.ok
        ? actionSuccess('resource.ensure', input.appId, { ...created.data, adopted: false })
        : { ...created, operation: 'resource.ensure' };
    }
    const identityMatches = existing.type === input.type && existing.name === input.name;
    if (!identityMatches) return actionFailure('resource.ensure', input.appId, {
      code: 'CONFLICT', message: `Resource identity is ambiguous or different: ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    const changed = stableStringify(existing.attributes) !== stableStringify(input.attributes || {});
    if (changed) {
      const updated = { ...existing, attributes: structuredClone(input.attributes || {}), version: existing.version + 1 };
      this.resources.set(input.logicalId, updated);
      return actionSuccess('resource.ensure', input.appId, { resource: structuredClone(updated), created: false, adopted: false, changed: true });
    }
    if (existing.lifecycle === 'external') {
      const adopted = { ...existing, lifecycle: 'adopted', version: existing.version + 1 };
      this.resources.set(input.logicalId, adopted);
      return actionSuccess('resource.ensure', input.appId, { resource: structuredClone(adopted), created: false, adopted: true, changed: false });
    }
    return actionSuccess('resource.ensure', input.appId, { resource: structuredClone(existing), created: false, adopted: existing.lifecycle === 'adopted', changed: false });
  }

  update(input) {
    this.calls.push({ operation: 'update', logicalId: input.logicalId });
    const existing = this.resources.get(input.logicalId);
    if (!existing) return actionFailure('resource.update', input.appId, {
      code: 'NOT_FOUND', message: `Resource not found: ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    if (input.expectedVersion !== existing.version) return actionFailure('resource.update', input.appId, {
      code: 'CONFLICT', message: `Resource version mismatch for ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    const changed = stableStringify(existing.attributes) !== stableStringify(input.attributes || {});
    if (!changed) return actionSuccess('resource.update', input.appId, { resource: structuredClone(existing), changed: false });
    const resource = { ...existing, attributes: structuredClone(input.attributes || {}), version: existing.version + 1 };
    this.resources.set(input.logicalId, resource);
    return actionSuccess('resource.update', input.appId, { resource: structuredClone(resource), changed: true });
  }

  delete(input) {
    this.calls.push({ operation: 'delete', logicalId: input.logicalId });
    const existing = this.resources.get(input.logicalId);
    if (!existing) return actionSuccess('resource.delete', input.appId, { deleted: false, alreadyAbsent: true });
    if (existing.lifecycle === 'external') return actionFailure('resource.delete', input.appId, {
      code: 'UNSUPPORTED', message: 'External resources cannot be deleted by AgentMesh Deploy.', retryable: false, provider: this.provider,
    });
    if (existing.lifecycle === 'adopted' && !input.allowAdoptedDelete) return actionFailure('resource.delete', input.appId, {
      code: 'APPROVAL_REQUIRED', message: 'Deleting an adopted resource requires separate approval.', retryable: false, provider: this.provider,
    });
    if (input.expectedVersion !== existing.version) return actionFailure('resource.delete', input.appId, {
      code: 'CONFLICT', message: `Resource version mismatch for ${input.logicalId}`, retryable: false, provider: this.provider,
    });
    this.resources.delete(input.logicalId);
    return actionSuccess('resource.delete', input.appId, { deleted: true, alreadyAbsent: false, tombstone: structuredClone(existing) });
  }

  seed(resource) {
    this.resources.set(resource.logicalId, structuredClone(resource));
    const match = String(resource.providerId || '').match(new RegExp(`^${escapeRegExp(this.provider)}-(\\d+)$`));
    if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
  }
}

function statusForError(code) {
  if (['APPROVAL_REQUIRED', 'DESTRUCTIVE_CHANGE'].includes(code)) return 'needs-approval';
  if (['PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'ASYNC_TIMEOUT'].includes(code)) return 'failed-retryable';
  if (['NOT_FOUND', 'ALREADY_EXISTS', 'CAPTURE_REQUIRED', 'VERIFICATION_FAILED'].includes(code)) return 'failed-terminal';
  return 'blocked';
}

function redactDetails(details) {
  return Object.fromEntries(Object.entries(details).filter(([key]) => !/(?:token|secret|password|authorization|cookie|key)$/i.test(key)));
}

function safeProviderMessage(message) {
  return String(message)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:re_|ghp_|github_pat_|sbp_|sb_publishable_|sb_secret_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
}

function containsSecretValue(value) {
  const text = JSON.stringify(value);
  return /Bearer\s+(?!\[redacted\])\S+/i.test(text) ||
    /(?:re_|ghp_|github_pat_|sbp_|sb_publishable_|sb_secret_)[A-Za-z0-9_-]{8,}/.test(text) ||
    /postgres(?:ql)?:\/\/(?!\[redacted\])[^\s"]+/i.test(text);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
