import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';
import { validateDnsChangeSet } from '../dns-change-set.js';

const PROVIDER = 'cloudflare';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/;
const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
const SHA256_RAW = /^[a-f0-9]{64}$/;

export class CloudflareV2Adapter {
  #token;
  #accountId;
  #transport;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Cloudflare API token is required.');
    if (options.accountId && !SAFE_ID.test(options.accountId)) throw new Error('Cloudflare Account ID is invalid.');
    this.#token = options.token;
    this.#accountId = options.accountId || '';
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
  }

  async readZone(input) {
    const operation = 'cloudflare.zone.read';
    const invalid = validateZoneInput(input, false);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const found = await this.#findZone(input.name);
    if (found.error) return this.#providerFailure(operation, input.appId, found.error, input);
    if (!found.zone) return this.#failure(operation, input.appId, notFoundError('Cloudflare Zone was not found.'), input);
    return this.#success(operation, input.appId, { resource: normalizeZone(found.zone, input, 'external') }, input);
  }

  async ensureZone(input) {
    const operation = 'cloudflare.zone.ensure';
    const invalid = validateZoneInput(input, true);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const found = await this.#findZone(input.name);
    if (found.error) return this.#providerFailure(operation, input.appId, found.error, input);
    if (found.zone) {
      return this.#success(operation, input.appId, {
        resource: normalizeZone(found.zone, input, 'external'), created: false, adopted: true,
        changed: false, providerMutationsExecuted: 0,
      }, input);
    }
    if (!this.#accountId) {
      return this.#failure(operation, input.appId, {
        code: 'CREDENTIAL_MISSING', message: 'Cloudflare Zone creation requires CLOUDFLARE_ACCOUNT_ID.',
        retryable: false, provider: PROVIDER,
      }, input);
    }
    const created = await this.#requestSafe('POST', '/zones', {
      name: input.name, account: { id: this.#accountId }, type: 'full', jump_start: false,
    });
    if (created.ok) {
      const zone = unwrapSingle(created.data);
      const invalidResponse = validateZoneResponse(zone, input.name);
      if (invalidResponse) return this.#failure(operation, input.appId, invalidResponse, input);
      return this.#success(operation, input.appId, {
        resource: normalizeZone(zone, input, 'managed'), created: true, adopted: false,
        changed: true, providerMutationsExecuted: 1,
      }, input);
    }
    if (created.status === 409 || created.status === 429 || created.status >= 500 || created.uncertain) {
      const recovered = await this.#findZone(input.name);
      if (recovered.zone && !recovered.error) {
        return this.#success(operation, input.appId, {
          resource: normalizeZone(recovered.zone, input, 'managed'), created: true, adopted: false,
          changed: true, recoveredAfterUncertainCreate: true, providerMutationsExecuted: 1,
        }, input);
      }
    }
    return this.#providerFailure(operation, input.appId, created, input, { providerMutationsExecuted: 1 });
  }

  planDnsChangeSet(input) {
    const operation = 'cloudflare.dns.plan-change-set';
    const invalid = validateChangeSetInput(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = changeSetPlanFingerprint(input.zoneId, input.changeSet);
    return this.#success(operation, input.appId, {
      mode: 'plan-only', zoneId: input.zoneId, changeSetId: input.changeSet.id,
      changeSetFingerprint: input.changeSet.fingerprint, planFingerprint,
      recordCount: input.changeSet.records.length, providerMutationsExecuted: 0,
    }, input, { status: 'planned' });
  }

  async executeDnsChangeSet(input) {
    const operation = 'cloudflare.dns.execute-change-set';
    const invalid = validateChangeSetInput(input) || validateExecutionGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, { status: 'needs-approval' });
    const expectedPlan = changeSetPlanFingerprint(input.zoneId, input.changeSet);
    if (input.planFingerprint !== expectedPlan) {
      return this.#failure(operation, input.appId, conflictError('Cloudflare DNS plan fingerprint does not match the approved change set.'), input);
    }
    const applied = [];
    const before = [];
    let providerMutationsExecuted = 0;
    for (const record of input.changeSet.records) {
      const current = await this.#listRecords(input.zoneId, record.name);
      if (current.error) return this.#providerFailure(operation, input.appId, current.error, input, { applied, before, providerMutationsExecuted });
      const decision = decideRecordMutation(current.records, record);
      if (decision.error) {
        return this.#failure(operation, input.appId, decision.error, input, {
          data: { applied, before, providerMutationsExecuted },
        });
      }
      before.push({ desiredId: record.id, records: current.records.map(safeRecord) });
      if (decision.mode === 'unchanged') {
        applied.push({ desiredId: record.id, mode: 'unchanged', record: safeRecord(decision.record) });
        continue;
      }
      const path = decision.mode === 'create'
        ? `/zones/${encodeURIComponent(input.zoneId)}/dns_records`
        : `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(decision.record.id)}`;
      const method = decision.mode === 'create' ? 'POST' : 'PUT';
      const response = await this.#requestSafe(method, path, recordBody(record));
      providerMutationsExecuted += 1;
      if (response.ok) {
        const changed = unwrapSingle(response.data);
        const normalized = normalizeDnsRecord(changed);
        if (!recordMatches(normalized, record)) {
          return this.#failure(operation, input.appId, providerResponseError('Cloudflare DNS mutation response does not match the desired record.'), input, {
            data: { applied, before, providerMutationsExecuted },
          });
        }
        applied.push({ desiredId: record.id, mode: decision.mode, record: safeRecord(normalized) });
        continue;
      }
      if (response.status === 409 || response.status === 429 || response.status >= 500 || response.uncertain) {
        const recovered = await this.#listRecords(input.zoneId, record.name);
        const matches = (recovered.records || []).filter((item) => recordMatches(item, record));
        if (!recovered.error && matches.length === 1) {
          applied.push({ desiredId: record.id, mode: decision.mode, record: safeRecord(matches[0]), recoveredAfterUncertainMutation: true });
          continue;
        }
        return this.#failure(operation, input.appId, {
          code: 'RECONCILIATION_REQUIRED',
          message: 'Cloudflare may have applied a DNS mutation, but exact reconciliation was inconclusive.',
          retryable: false, provider: PROVIDER,
        }, input, { data: { applied, before, providerMutationsExecuted, duplicateMutationPrevented: true } });
      }
      return this.#providerFailure(operation, input.appId, response, input, { applied, before, providerMutationsExecuted });
    }
    return this.#success(operation, input.appId, {
      zoneId: input.zoneId, changeSetId: input.changeSet.id, changeSetFingerprint: input.changeSet.fingerprint,
      applied, before, changed: providerMutationsExecuted > 0, providerMutationsExecuted,
    }, input, { evidenceRefs: [`dns-change-set://${input.changeSet.id}`] });
  }

  planDnsRollback(input) {
    const operation = 'cloudflare.dns.plan-rollback';
    const invalid = validateDnsRollbackInput(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      rollbackPlanId: input.rollbackPlanId,
      rollbackPlanFingerprint: input.rollbackPlanFingerprint,
      zoneId: input.zoneId,
      planFingerprint: dnsRollbackFingerprint(input),
      networkRequestsExecuted: 0,
      providerMutationsExecuted: 0,
    }, input, { status: 'planned' });
  }

  async executeDnsRollback(input) {
    const operation = 'cloudflare.dns.execute-rollback';
    const invalid = validateDnsRollbackInput(input) || validateRollbackExecutionGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== dnsRollbackFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Cloudflare DNS rollback fingerprint does not match the approved Rollback Plan.'), input);
    }
    const current = await this.#listRecords(input.zoneId, input.restoreRecord.name);
    if (current.error) {
      return this.#providerFailure(operation, input.appId, current.error, input, {
        networkRequestsExecuted: 1, providerMutationsExecuted: 0,
      });
    }
    const restored = current.records.filter((record) => rollbackRecordMatches(record, input.restoreRecord));
    if (restored.length === 1 && current.records.length === 1) {
      return this.#success(operation, input.appId, {
        rollbackPlanId: input.rollbackPlanId,
        rollbackPlanFingerprint: input.rollbackPlanFingerprint,
        zoneId: input.zoneId,
        restored: safeRecord(restored[0]),
        adopted: true,
        changed: false,
        networkRequestsExecuted: 1,
        providerMutationsExecuted: 0,
      }, input, { evidenceRefs: [`rollback-plan://${input.rollbackPlanId}`] });
    }
    if (current.records.length !== 1 || !rollbackRecordMatches(current.records[0], input.appliedRecord) ||
      input.restoreRecord.id !== input.appliedRecord.id) {
      return this.#failure(operation, input.appId, conflictError('Current Cloudflare Web record drifted from the exact applied rollback source.'), input, {
        data: { networkRequestsExecuted: 1, providerMutationsExecuted: 0 },
      });
    }
    const before = safeRecord(current.records[0]);
    const response = await this.#requestSafe(
      'PUT',
      `/zones/${encodeURIComponent(input.zoneId)}/dns_records/${encodeURIComponent(current.records[0].id)}`,
      recordBody(input.restoreRecord)
    );
    if (response.ok) {
      const value = normalizeDnsRecord(unwrapSingle(response.data));
      if (!rollbackRecordMatches(value, input.restoreRecord)) {
        return this.#failure(operation, input.appId, providerResponseError('Cloudflare DNS rollback response does not match the previous record.'), input, {
          data: { before, networkRequestsExecuted: 2, providerMutationsExecuted: 1 },
        });
      }
      return this.#success(operation, input.appId, {
        rollbackPlanId: input.rollbackPlanId,
        rollbackPlanFingerprint: input.rollbackPlanFingerprint,
        zoneId: input.zoneId,
        before,
        restored: safeRecord(value),
        adopted: false,
        changed: true,
        networkRequestsExecuted: 2,
        providerMutationsExecuted: 1,
      }, input, { evidenceRefs: [`rollback-plan://${input.rollbackPlanId}`] });
    }
    if (response.status === 409 || response.status === 429 || response.status >= 500 || response.uncertain) {
      const recovered = await this.#listRecords(input.zoneId, input.restoreRecord.name);
      const matches = (recovered.records || []).filter((record) => rollbackRecordMatches(record, input.restoreRecord));
      if (!recovered.error && matches.length === 1 && recovered.records.length === 1) {
        return this.#success(operation, input.appId, {
          rollbackPlanId: input.rollbackPlanId,
          rollbackPlanFingerprint: input.rollbackPlanFingerprint,
          zoneId: input.zoneId,
          before,
          restored: safeRecord(matches[0]),
          adopted: false,
          changed: true,
          recoveredAfterUncertainMutation: true,
          duplicateMutationPrevented: true,
          networkRequestsExecuted: 3,
          providerMutationsExecuted: 1,
        }, input, { evidenceRefs: [`rollback-plan://${input.rollbackPlanId}`] });
      }
      return this.#failure(operation, input.appId, {
        code: 'RECONCILIATION_REQUIRED',
        message: 'Cloudflare DNS rollback may have applied, but exact reconciliation was inconclusive.',
        retryable: false,
        provider: PROVIDER,
      }, input, { data: {
        before, networkRequestsExecuted: 3, providerMutationsExecuted: 1,
        duplicateMutationPrevented: true,
      } });
    }
    return this.#providerFailure(operation, input.appId, response, input, {
      before, networkRequestsExecuted: 2, providerMutationsExecuted: 1,
    });
  }

  deleteZone(input) {
    return this.#failure('cloudflare.zone.delete', input?.appId || '', {
      code: 'UNSUPPORTED', message: 'Cloudflare Zone and DNS record deletion are disabled.',
      retryable: false, provider: PROVIDER,
    }, input || {});
  }

  async #findZone(name) {
    const query = new URLSearchParams({ name, per_page: '50', page: '1' });
    if (this.#accountId) query.set('account.id', this.#accountId);
    const response = await this.#requestSafe('GET', `/zones?${query.toString()}`);
    if (!response.ok) return { error: response };
    const zones = unwrapList(response.data).filter((zone) => zone?.name === name);
    if (zones.length > 1) return { error: { ok: false, status: 409, message: 'Multiple exact Cloudflare Zones found.', data: {} } };
    if (zones[0]) {
      const invalid = validateZoneResponse(zones[0], name);
      if (invalid) return { error: { ok: false, status: 502, message: invalid.message, data: {} } };
    }
    return { zone: zones[0] || null };
  }

  async #listRecords(zoneId, name) {
    const query = new URLSearchParams({ name, per_page: '100', page: '1' });
    const response = await this.#requestSafe('GET', `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`);
    if (!response.ok) return { error: response, records: [] };
    const records = unwrapList(response.data).map(normalizeDnsRecord);
    if (records.some((record) => !record.id || !RECORD_TYPES.has(record.type) || !DNS_NAME.test(record.name))) {
      return { error: { ok: false, status: 502, message: 'Cloudflare DNS list response is invalid.', data: {} }, records: [] };
    }
    return { records };
  }

  async #requestSafe(method, path, body) {
    try {
      const response = await this.#transport.request({
        method, url: `${API_BASE}${path}`,
        headers: {
          authorization: `Bearer ${this.#token}`, accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (response.ok && response.data?.success !== true) {
        return { ok: false, status: 502, message: 'Cloudflare API envelope reported failure.', data: {} };
      }
      return response;
    } catch (error) {
      return { ok: false, status: 503, message: error.message, data: {}, uncertain: method !== 'GET' };
    }
  }

  #providerFailure(operation, appId, response, input, data = {}) {
    return this.#failure(operation, appId, mapProviderError(PROVIDER, response), input, { data });
  }

  #success(operation, appId, data, input, options = {}) {
    return validateActionResult(actionSuccess(operation, appId, data, {
      requestId: input?.requestId, status: options.status,
      warnings: options.warnings, nextActions: options.nextActions, evidenceRefs: options.evidenceRefs,
    }), { operation, appId });
  }

  #failure(operation, appId, error, input, options = {}) {
    return validateActionResult(actionFailure(operation, appId, error, {
      requestId: input?.requestId, status: options.status, data: options.data,
      warnings: options.warnings, nextActions: options.nextActions,
    }), { operation, appId });
  }
}

export function createCloudflareV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Cloudflare ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, { env: options.env, purpose: 'Cloudflare adapter' });
  return new CloudflareV2Adapter({
    token: values.CLOUDFLARE_API_TOKEN,
    accountId: options.accountId || values.CLOUDFLARE_ACCOUNT_ID || '',
    transport: options.transport, httpOptions: options.httpOptions,
  });
}

function validateZoneInput(input, create) {
  if (!input?.appId || !input.logicalId || !DOMAIN.test(input.name || '')) return validationError('Cloudflare Zone requires appId, logicalId, and an exact zone name.');
  if (create && input.name !== input.name.toLowerCase()) return validationError('Cloudflare Zone name must be lowercase.');
  return null;
}

function validateChangeSetInput(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.zoneId || '') || !validChangeSet(input.changeSet)) {
    return validationError('Cloudflare DNS execution requires exact Zone identity and an immutable DNS ChangeSet.');
  }
  return null;
}

function validateExecutionGates(input) {
  if (!input.execute || !input.yes || !input.allowProviderMutations ||
    !SHA256_RAW.test(input.approvalFingerprint || '') || !SHA256_RAW.test(input.planFingerprint || '')) {
    return approvalError('Cloudflare production DNS requires execute, confirmation, provider mutation, plan, and approval gates.');
  }
  return null;
}

function validateDnsRollbackInput(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.zoneId || '') ||
    !/^rollback-plan-[a-f0-9]{24}$/.test(input.rollbackPlanId || '') ||
    !/^sha256:[a-f0-9]{64}$/.test(input.rollbackPlanFingerprint || '') ||
    !/^sha256:[a-f0-9]{64}$/.test(input.applyReceiptFingerprint || '') ||
    !validRollbackRecord(input.appliedRecord) || !validRollbackRecord(input.restoreRecord) ||
    input.appliedRecord.id !== input.restoreRecord.id || input.appliedRecord.name !== input.restoreRecord.name ||
    input.appliedRecord.type !== input.restoreRecord.type || recordMatches(input.appliedRecord, input.restoreRecord)) {
    return validationError('Cloudflare DNS rollback requires exact Rollback Plan, Receipt, applied record, and distinct previous record identities.');
  }
  return null;
}

function validateRollbackExecutionGates(input) {
  if (!input.execute || !input.yes || !input.allowProviderMutations ||
    !SHA256_RAW.test(input.approvalFingerprint || '') || !SHA256_RAW.test(input.planFingerprint || '')) {
    return approvalError('Cloudflare DNS rollback requires execute, confirmation, provider mutation, plan, and dedicated Rollback Approval gates.');
  }
  return null;
}

function validRollbackRecord(record) {
  return Boolean(record) && SAFE_ID.test(record.id || '') && RECORD_TYPES.has(record.type) &&
    DNS_NAME.test(record.name || '') && typeof record.content === 'string' && record.content.length > 0 &&
    record.content.length <= 2048 && Number.isInteger(record.ttl) && record.ttl >= 1 &&
    typeof record.proxied === 'boolean' &&
    (record.type === 'MX' ? Number.isInteger(record.priority) && record.priority >= 0 : record.priority === null);
}

function validChangeSet(changeSet) {
  try {
    validateDnsChangeSet(changeSet);
    return true;
  } catch {
    return false;
  }
}

function decideRecordMutation(existing, desired) {
  const sameName = existing.filter((record) => record.name === desired.name);
  const sameType = sameName.filter((record) => record.type === desired.type);
  const exact = sameType.filter((record) => recordMatches(record, desired));
  if (exact.length === 1 && sameType.length === 1) return { mode: 'unchanged', record: exact[0] };
  if (exact.length > 1 || sameType.length > 1) return { error: conflictError(`Cloudflare DNS record set is ambiguous: ${desired.name} ${desired.type}.`) };
  const cnameConflict = desired.type === 'CNAME'
    ? sameName.some((record) => record.type !== 'CNAME')
    : sameName.some((record) => record.type === 'CNAME');
  if (cnameConflict) return { error: conflictError(`Cloudflare DNS CNAME conflict at ${desired.name}.`) };
  if (sameType.length === 0) return { mode: 'create' };
  if (desired.updatePolicy !== 'replace-exact-record-set') {
    return { error: conflictError(`Cloudflare DNS record differs and create-only policy forbids replacement: ${desired.name} ${desired.type}.`) };
  }
  return { mode: 'update', record: sameType[0] };
}

function recordMatches(current, desired) {
  return current.type === desired.type && current.name === desired.name &&
    normalizeContent(current.content, current.type) === normalizeContent(desired.content, desired.type) &&
    Boolean(current.proxied) === Boolean(desired.proxied) &&
    (desired.type !== 'MX' || Number(current.priority) === desired.priority);
}

function rollbackRecordMatches(current, expected) {
  return current.id === expected.id && recordMatches(current, expected) && Number(current.ttl) === expected.ttl;
}

function recordBody(record) {
  return {
    type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: record.proxied,
    ...(record.type === 'MX' ? { priority: record.priority } : {}),
    comment: `Managed by AgentMesh Deploy ${record.id}`,
  };
}

function normalizeDnsRecord(record) {
  return {
    id: String(record?.id || ''), type: String(record?.type || '').toUpperCase(),
    name: String(record?.name || '').toLowerCase(), content: String(record?.content || ''),
    ttl: Number(record?.ttl || 1), proxied: Boolean(record?.proxied),
    priority: record?.priority === undefined || record?.priority === null ? null : Number(record.priority),
  };
}

function safeRecord(record) {
  return { id: record.id, type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: record.proxied, priority: record.priority };
}

function normalizeZone(zone, input, lifecycle) {
  return {
    logicalId: input.logicalId, provider: PROVIDER, providerId: zone.id,
    type: 'dns.zone', name: zone.name, lifecycle,
    attributes: { status: String(zone.status || ''), nameServers: Array.isArray(zone.name_servers) ? zone.name_servers : [] },
  };
}

function validateZoneResponse(zone, expectedName) {
  if (!SAFE_ID.test(zone?.id || '') || zone?.name !== expectedName) return providerResponseError('Cloudflare Zone response identity is invalid.');
  return null;
}

function unwrapList(data) { return Array.isArray(data?.result) ? data.result : []; }
function unwrapSingle(data) { return data?.result && typeof data.result === 'object' ? data.result : null; }
function normalizeContent(value, type) {
  const text = String(value || '').trim();
  return ['CNAME', 'MX'].includes(type) ? text.replace(/\.$/, '').toLowerCase() : text;
}
function changeSetPlanFingerprint(zoneId, changeSet) {
  return createHash('sha256').update(stableStringify({ zoneId, id: changeSet.id, fingerprint: changeSet.fingerprint })).digest('hex');
}
function dnsRollbackFingerprint(input) {
  return createHash('sha256').update(stableStringify({
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    applyReceiptFingerprint: input.applyReceiptFingerprint,
    zoneId: input.zoneId,
    appliedRecord: input.appliedRecord,
    restoreRecord: input.restoreRecord,
  })).digest('hex');
}
function validationError(message) { return { code: 'VALIDATION_FAILED', message, retryable: false, provider: PROVIDER }; }
function conflictError(message) { return { code: 'CONFLICT', message, retryable: false, provider: PROVIDER }; }
function approvalError(message) { return { code: 'APPROVAL_REQUIRED', message, retryable: false, provider: PROVIDER }; }
function notFoundError(message) { return { code: 'NOT_FOUND', message, retryable: false, provider: PROVIDER }; }
function providerResponseError(message) { return { code: 'PROVIDER_RESPONSE_INVALID', message, retryable: false, provider: PROVIDER }; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
