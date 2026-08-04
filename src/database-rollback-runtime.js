import { createHash } from 'node:crypto';

import {
  actionFailure,
  actionSuccess,
  containsSecretLikeValue,
  validateActionResult,
} from './provider-contract.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const STRATEGIES = new Set(['apply-down', 'restore-backup']);

export function planDatabaseRollback(input) {
  const operation = 'database.rollback.plan';
  const invalid = validateInput(input);
  if (invalid) return failure(operation, input?.appId || '', invalid, input);
  return success(operation, input.appId, {
    mode: 'plan-only',
    strategy: input.strategy,
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    backupProviderId: input.backupProviderId,
    databaseProjectId: input.databaseProjectId,
    databaseBranchId: input.databaseBranchId,
    planFingerprint: databaseRollbackFingerprint(input),
    databaseMutationsExecuted: 0,
    rawSqlPersisted: false,
    secretValuesExposed: false,
  }, input, { status: 'planned' });
}

export async function executeDatabaseRollback(input, runtime) {
  const operation = `database.rollback.${input?.strategy || 'unknown'}`;
  const invalid = validateInput(input) || validateExecution(input);
  if (invalid) {
    return failure(operation, input?.appId || '', invalid, input, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
  }
  if (input.planFingerprint !== databaseRollbackFingerprint(input)) {
    return failure(operation, input.appId, conflict('Database rollback fingerprint does not match the approved plan.'), input);
  }
  const method = input.strategy === 'apply-down' ? 'applyDown' : 'restoreBackup';
  if (!runtime || typeof runtime.inspect !== 'function' || typeof runtime[method] !== 'function') {
    return failure(operation, input.appId, capability(`Database rollback requires injected inspect and ${method} Runtime methods.`), input);
  }

  const context = runtimeContext(input);
  const before = await inspect(runtime, context);
  if (before.error) return failure(operation, input.appId, before.error, input);
  if (isRecovered(before, input)) {
    return success(operation, input.appId, successData(input, before, before, 0, true), input);
  }
  if (before.schemaVersion !== input.expectedSchemaVersion ||
    before.knownMigrationPlanFingerprint !== input.migrationPlanFingerprint) {
    return failure(operation, input.appId, conflict('Current database state drifted from the exact applied Migration ownership.'), input);
  }

  try {
    const result = await runtime[method](context);
    if (!safeRuntimeMutationResult(result)) {
      return failure(operation, input.appId, invalidResponse('Database rollback Runtime returned an unsafe result.'), input, {
        data: { databaseMutationsExecuted: 1, duplicateMutationPrevented: true },
      });
    }
  } catch {
    return reconcile(operation, input, runtime, context, before);
  }

  const after = await inspect(runtime, context);
  if (after.error || !isRecovered(after, input)) {
    return failure(operation, input.appId, reconciliation('Database rollback returned, but exact post-operation verification failed; automatic replay is disabled.'), input, {
      data: { databaseMutationsExecuted: 1, duplicateMutationPrevented: true },
    });
  }
  return success(operation, input.appId, successData(input, before, after, 1, false), input);
}

export async function reconcileDatabaseRollback(input, runtime) {
  const operation = `database.rollback.${input?.strategy || 'unknown'}`;
  const invalid = validateInput(input) || validateExecution(input);
  if (invalid) {
    return failure(operation, input?.appId || '', invalid, input, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
  }
  if (input.planFingerprint !== databaseRollbackFingerprint(input)) {
    return failure(operation, input.appId, conflict('Database rollback fingerprint does not match the approved plan.'), input);
  }
  if (!runtime || typeof runtime.inspect !== 'function') {
    return failure(operation, input.appId, capability('Database rollback reconciliation requires an injected inspect Runtime method.'), input, {
      data: missingReceiptFailureData(),
    });
  }

  const observed = await inspect(runtime, runtimeContext(input));
  if (!observed.error && isRecovered(observed, input)) {
    return success(operation, input.appId, {
      ...successData(input, observed, observed, 0, true),
      recoveredByReadOnlyReconciliation: true,
      reconciliationReadsExecuted: 1,
      duplicateMutationPrevented: true,
    }, input);
  }
  return failure(operation, input.appId, reconciliation(
    'Database rollback has an existing mutation Intent without a Receipt, and exact read-only reconciliation was inconclusive; automatic replay is disabled.'
  ), input, { data: missingReceiptFailureData() });
}

export function databaseRollbackFingerprint(input) {
  return createHash('sha256').update(stableStringify({
    strategy: input.strategy,
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    backupProviderId: input.backupProviderId,
    databaseProjectId: input.databaseProjectId,
    databaseBranchId: input.databaseBranchId,
    provider: input.provider,
    databaseName: input.databaseName,
    expectedSchemaVersion: input.expectedSchemaVersion,
    baselineSchemaFingerprint: input.baselineSchemaFingerprint,
  })).digest('hex');
}

async function reconcile(operation, input, runtime, context, before) {
  const after = await inspect(runtime, context);
  if (!after.error && isRecovered(after, input)) {
    return success(operation, input.appId, {
      ...successData(input, before, after, 1, false),
      recoveredAfterUncertainMutation: true,
      reconciliationReadsExecuted: 1,
      duplicateMutationPrevented: true,
    }, input);
  }
  return failure(operation, input.appId, reconciliation('Database rollback may have completed, but one exact reconciliation read was inconclusive; automatic replay is disabled.'), input, {
    data: {
      databaseMutationsExecuted: 1,
      reconciliationReadsExecuted: 1,
      duplicateMutationPrevented: true,
    },
  });
}

function missingReceiptFailureData() {
  return {
    databaseMutationsExecuted: 1,
    reconciliationReadsExecuted: 1,
    duplicateMutationPrevented: true,
  };
}

async function inspect(runtime, context) {
  let value;
  try { value = await runtime.inspect(context); }
  catch { return { error: unavailable('Database rollback inspection failed.') }; }
  if (!value || typeof value !== 'object' || containsSecretLikeValue(value)) {
    return { error: invalidResponse('Database rollback inspection returned unsafe data.') };
  }
  const allowed = new Set([
    'schemaVersion', 'schemaFingerprint', 'knownMigrationPlanFingerprint',
    'knownRollbackPlanFingerprint', 'knownRollbackStrategy',
  ]);
  if (Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: invalidResponse('Database rollback inspection returned unsupported fields.') };
  }
  const result = {
    schemaVersion: String(value.schemaVersion || ''),
    schemaFingerprint: String(value.schemaFingerprint || ''),
    knownMigrationPlanFingerprint: String(value.knownMigrationPlanFingerprint || ''),
    knownRollbackPlanFingerprint: String(value.knownRollbackPlanFingerprint || ''),
    knownRollbackStrategy: String(value.knownRollbackStrategy || ''),
  };
  if (!VERSION.test(result.schemaVersion) || !SHA256.test(result.schemaFingerprint) ||
    (result.knownMigrationPlanFingerprint && !SHA256.test(result.knownMigrationPlanFingerprint)) ||
    (result.knownRollbackPlanFingerprint && !SHA256.test(result.knownRollbackPlanFingerprint)) ||
    (result.knownRollbackStrategy && !STRATEGIES.has(result.knownRollbackStrategy))) {
    return { error: invalidResponse('Database rollback inspection returned invalid ownership evidence.') };
  }
  return result;
}

function isRecovered(value, input) {
  return value.schemaFingerprint === input.baselineSchemaFingerprint &&
    value.knownRollbackPlanFingerprint === input.rollbackPlanFingerprint &&
    value.knownRollbackStrategy === input.strategy;
}

function safeRuntimeMutationResult(value) {
  return value === undefined || value === null || (
    typeof value === 'object' && !Array.isArray(value) && !containsSecretLikeValue(value) &&
    Object.keys(value).every((key) => ['databaseMutationsExecuted'].includes(key)) &&
    (value.databaseMutationsExecuted === undefined || value.databaseMutationsExecuted === 1)
  );
}

function successData(input, before, after, mutationCount, adopted) {
  return {
    strategy: input.strategy,
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    backupProviderId: input.backupProviderId,
    databaseProjectId: input.databaseProjectId,
    databaseBranchId: input.databaseBranchId,
    before,
    after,
    adopted,
    changed: !adopted,
    databaseMutationsExecuted: mutationCount,
    rawSqlPersisted: false,
    secretValuesExposed: false,
  };
}

function runtimeContext(input) {
  return {
    projectId: input.projectId,
    graphId: input.graphId,
    strategy: input.strategy,
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    backupProviderId: input.backupProviderId,
    databaseProjectId: input.databaseProjectId,
    databaseBranchId: input.databaseBranchId,
    provider: input.provider,
    databaseName: input.databaseName,
    expectedSchemaVersion: input.expectedSchemaVersion,
    baselineSchemaFingerprint: input.baselineSchemaFingerprint,
  };
}

function validateInput(input) {
  if (!input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.graphId || '') ||
    !STRATEGIES.has(input.strategy) || !SAFE_ID.test(input.rollbackPlanId || '') ||
    !SHA256.test(input.rollbackPlanFingerprint || '') || !SAFE_ID.test(input.migrationPlanId || '') ||
    !SHA256.test(input.migrationPlanFingerprint || '') || !SAFE_ID.test(input.backupEvidenceId || '') ||
    !SHA256.test(input.backupEvidenceFingerprint || '') || !SAFE_ID.test(input.backupProviderId || '') ||
    !SAFE_ID.test(input.databaseProjectId || '') || !SAFE_ID.test(input.databaseBranchId || '') ||
    !SAFE_ID.test(input.provider || '') ||
    !SAFE_ID.test(input.databaseName || '') || !VERSION.test(input.expectedSchemaVersion || '') ||
    !SHA256.test(input.baselineSchemaFingerprint || '')) {
    return validation('Database rollback requires exact Plan, Migration, Backup, provider, database, and Schema evidence.');
  }
  return null;
}

function validateExecution(input) {
  if (!input.execute || !input.yes || !input.allowDatabaseRestore ||
    !RAW_SHA256.test(input.planFingerprint || '') || !RAW_SHA256.test(input.approvalFingerprint || '')) {
    return approval('Database rollback requires execute, confirmation, dedicated database approval, and plan fingerprints.');
  }
  return null;
}

function success(operation, appId, data, input, options = {}) {
  return validateActionResult(actionSuccess(operation, appId, data, {
    requestId: input?.requestId, status: options.status,
  }), { operation, appId });
}
function failure(operation, appId, error, input, options = {}) {
  return validateActionResult(actionFailure(operation, appId, error, {
    requestId: input?.requestId, status: options.status, data: options.data,
  }), { operation, appId });
}
function validation(message) { return error('VALIDATION_FAILED', message, false); }
function approval(message) { return error('APPROVAL_REQUIRED', message, false); }
function conflict(message) { return error('CONFLICT', message, false); }
function invalidResponse(message) { return error('PROVIDER_RESPONSE_INVALID', message, false); }
function unavailable(message) { return error('PROVIDER_UNAVAILABLE', message, true); }
function reconciliation(message) { return error('RECONCILIATION_REQUIRED', message, false); }
function capability(message) { return error('CAPABILITY_MISSING', message, false); }
function error(code, message, retryable) { return { code, message, retryable, provider: 'database-runtime' }; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
