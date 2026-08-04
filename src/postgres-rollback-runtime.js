import { operationError } from './errors.js';
import { parseSecretRef } from './secret-store.js';
import {
  executePostgresQuery,
  normalizePostgresAllowedHosts,
  normalizePostgresTimeout,
  postgresStringLiteral,
  resolvePostgresSession,
  runPsqlCommand,
} from './postgres-migration-runtime.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const STRATEGIES = new Set(['apply-down', 'restore-backup']);

export function createPostgresRollbackRuntime(options = {}) {
  if (!options.secretRuntime || typeof options.secretRuntime.resolve !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'PostgreSQL Rollback Runtime requires a Secret Runtime.');
  }
  parseSecretRef(options.connectionSecretRef);
  if (typeof options.schemaInspector !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'PostgreSQL Rollback Runtime requires a provider-specific Schema Inspector.');
  }
  if (typeof options.bundleLoader !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'PostgreSQL Rollback Runtime requires a locked-commit Down bundle loader.');
  }
  const allowedHosts = normalizePostgresAllowedHosts(options.allowedHosts);
  const commandRunner = options.commandRunner || runPsqlCommand;
  const timeoutMs = normalizePostgresTimeout(options.timeoutMs);
  const sleep = options.sleep || defaultSleep;
  const verificationAttempts = normalizeAttempts(options.verificationAttempts);
  const verificationIntervalMs = normalizeInterval(options.verificationIntervalMs);

  async function session(context) {
    validateRuntimeContext(context);
    return resolvePostgresSession(
      options.secretRuntime,
      options.connectionSecretRef,
      allowedHosts,
      context
    );
  }

  async function inspect(context) {
    const activeSession = await session(context);
    const structural = normalizeStructuralInspection(await options.schemaInspector(context));
    const migrationLedgerExists = String(await executePostgresQuery(
      commandRunner,
      activeSession,
      MIGRATION_LEDGER_EXISTS_SQL,
      timeoutMs
    )).trim() === 'agentmesh_deploy.migration_ledger';
    const rollbackLedgerExists = String(await executePostgresQuery(
      commandRunner,
      activeSession,
      ROLLBACK_LEDGER_EXISTS_SQL,
      timeoutMs
    )).trim() === 'agentmesh_deploy.rollback_ledger';
    const migration = migrationLedgerExists
      ? parseMigrationLedgerRow(await executePostgresQuery(
          commandRunner,
          activeSession,
          migrationLedgerReadSql(context.expectedSchemaVersion),
          timeoutMs
        ))
      : { schemaVersion: context.expectedSchemaVersion, migrationPlanFingerprint: '' };
    const rollback = rollbackLedgerExists
      ? parseRollbackLedgerRow(await executePostgresQuery(
          commandRunner,
          activeSession,
          rollbackLedgerReadSql(context.rollbackPlanFingerprint),
          timeoutMs
        ))
      : { rollbackPlanFingerprint: '', strategy: '' };
    return {
      schemaVersion: migration.schemaVersion,
      schemaFingerprint: structural.schemaFingerprint,
      knownMigrationPlanFingerprint: migration.migrationPlanFingerprint,
      knownRollbackPlanFingerprint: rollback.rollbackPlanFingerprint,
      knownRollbackStrategy: rollback.strategy,
    };
  }

  async function applyDown(context) {
    validateRuntimeContext(context, 'apply-down');
    if (options.allowSqlExecution !== true) {
      throw operationError('APPROVAL_REQUIRED', 'PostgreSQL Down execution is disabled.');
    }
    const bundle = await options.bundleLoader(context);
    validateDownBundle(bundle, context);
    if (bundle.migrations.some((migration) => migration.transactionMode !== 'transactional')) {
      throw operationError('CAPABILITY_MISSING', 'Native PostgreSQL Down requires a fully transactional committed bundle.');
    }
    const activeSession = await session(context);
    const args = rollbackCommandArgs(context, true);
    for (const migration of bundle.migrations) args.push('--file', migration.file);
    args.push('--command', rollbackLedgerCommitSql(context));
    const result = await commandRunner('psql', args, {
      env: activeSession.env,
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    if (!result || result.status !== 0) {
      throw operationError(
        'DATABASE_COMMAND_FAILED',
        'PostgreSQL Down failed; output was suppressed and automatic replay is disabled until exact reconciliation.'
      );
    }
    return { databaseMutationsExecuted: 1 };
  }

  async function restoreBackup(context) {
    validateRuntimeContext(context, 'restore-backup');
    if (typeof options.snapshotRestorer !== 'function') {
      throw operationError('CAPABILITY_MISSING', 'Snapshot Restore requires an exact provider restore Runtime.');
    }
    const restored = await options.snapshotRestorer(context);
    if (!safeRestoreResult(restored)) {
      throw operationError('PROVIDER_RESPONSE_INVALID', 'Snapshot Restore Runtime returned unsafe or incomplete evidence.');
    }
    await waitForBaseline(context);
    await stampRollbackLedger(context);
    return { databaseMutationsExecuted: 1 };
  }

  async function waitForBaseline(context) {
    for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
      const structural = normalizeStructuralInspection(await options.schemaInspector(context));
      if (structural.schemaFingerprint === context.baselineSchemaFingerprint) return;
      if (attempt < verificationAttempts) await sleep(verificationIntervalMs);
    }
    throw operationError(
      'DATABASE_VERIFICATION_FAILED',
      'Snapshot Restore completed, but the exact baseline Schema fingerprint was not observed.'
    );
  }

  async function stampRollbackLedger(context) {
    const activeSession = await session(context);
    const result = await commandRunner('psql', rollbackCommandArgs(context, false).concat(
      '--command', rollbackLedgerCommitSql(context)
    ), {
      env: activeSession.env,
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    if (!result || result.status !== 0) {
      throw operationError(
        'DATABASE_COMMAND_FAILED',
        'Snapshot Restore ownership could not be recorded; output was suppressed and provider restore will not be replayed.'
      );
    }
  }

  return Object.freeze({ inspect, applyDown, restoreBackup });
}

function rollbackCommandArgs(context, singleTransaction) {
  return [
    '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1',
    ...(singleTransaction ? ['--single-transaction'] : []),
    '--command', ROLLBACK_LEDGER_BOOTSTRAP_SQL,
  ];
}

function validateRuntimeContext(context, strategy) {
  if (!context || !STRATEGIES.has(context.strategy) || (strategy && context.strategy !== strategy) ||
      !SAFE_ID.test(context.rollbackPlanId || '') || !SHA256.test(context.rollbackPlanFingerprint || '') ||
      !SAFE_ID.test(context.migrationPlanId || '') || !SHA256.test(context.migrationPlanFingerprint || '') ||
      !SAFE_ID.test(context.backupEvidenceId || '') || !SHA256.test(context.backupEvidenceFingerprint || '') ||
      !SAFE_ID.test(context.backupProviderId || '') || !SAFE_ID.test(context.databaseProjectId || '') ||
      !SAFE_ID.test(context.databaseBranchId || '') || !SAFE_ID.test(context.databaseName || '') ||
      !VERSION.test(context.expectedSchemaVersion || '') || !SHA256.test(context.baselineSchemaFingerprint || '')) {
    throw operationError('VALIDATION_FAILED', 'PostgreSQL Rollback Runtime received an invalid evidence-bound context.');
  }
}

function validateDownBundle(bundle, context) {
  if (!bundle || bundle.kind !== 'committed-migration-bundle' || bundle.direction !== 'down' ||
      bundle.migrationPlanId !== context.migrationPlanId ||
      bundle.migrationPlanFingerprint !== context.migrationPlanFingerprint ||
      !Array.isArray(bundle.migrations) || bundle.migrations.length === 0 ||
      !Number.isInteger(bundle.statementCount) || bundle.statementCount < 1) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Down bundle does not match the approved Migration Plan.');
  }
  for (const migration of bundle.migrations) {
    if (typeof migration?.file !== 'string' || !migration.file ||
        !/^[a-f0-9]{64}$/.test(migration.sha256 || '') ||
        !/^[a-f0-9]{40,64}$/.test(migration.blobId || '') ||
        !Number.isInteger(migration.statementCount) || migration.statementCount < 1 ||
        !['transactional', 'non-transactional', 'mixed'].includes(migration.transactionMode)) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Down bundle contains an invalid committed migration entry.');
    }
  }
}

function normalizeStructuralInspection(value) {
  const schemaFingerprint = String(value?.schemaFingerprint || '');
  if (!SHA256.test(schemaFingerprint) || Object.keys(value || {}).some((key) => key !== 'schemaFingerprint')) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'Schema Inspector returned invalid or unsafe rollback evidence.');
  }
  return { schemaFingerprint };
}

function safeRestoreResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    value.databaseMutationsExecuted === 1 &&
    value.snapshotId && SAFE_ID.test(value.snapshotId) &&
    Object.keys(value).every((key) => ['databaseMutationsExecuted', 'snapshotId'].includes(key));
}

function parseMigrationLedgerRow(value) {
  const parts = String(value || '').trim().split('\t');
  if (parts.length !== 2 || !VERSION.test(parts[0] || '') ||
      (parts[1] && !SHA256.test(parts[1]))) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'Migration Ledger returned invalid rollback ownership evidence.');
  }
  return { schemaVersion: parts[0], migrationPlanFingerprint: parts[1] };
}

function parseRollbackLedgerRow(value) {
  const parts = String(value || '').trim().split('\t');
  if (parts.length !== 2 || (parts[0] && !SHA256.test(parts[0])) ||
      (parts[1] && !STRATEGIES.has(parts[1]))) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'Rollback Ledger returned invalid ownership evidence.');
  }
  return { rollbackPlanFingerprint: parts[0], strategy: parts[1] };
}

function migrationLedgerReadSql(schemaVersion) {
  if (!VERSION.test(schemaVersion || '')) throw operationError('VALIDATION_FAILED', 'Schema Version is invalid.');
  return [
    "SELECT COALESCE((SELECT schema_version || E'\\t' || migration_plan_fingerprint",
    `FROM agentmesh_deploy.migration_ledger WHERE schema_version = '${schemaVersion}'),`,
    `'${schemaVersion}' || E'\\t');`,
  ].join(' ');
}

function rollbackLedgerReadSql(rollbackPlanFingerprint) {
  if (!SHA256.test(rollbackPlanFingerprint || '')) {
    throw operationError('VALIDATION_FAILED', 'Rollback Plan fingerprint is invalid.');
  }
  return [
    "SELECT COALESCE((SELECT rollback_plan_fingerprint || E'\\t' || strategy",
    `FROM agentmesh_deploy.rollback_ledger WHERE rollback_plan_fingerprint = '${rollbackPlanFingerprint}'),`,
    "E'\\t');",
  ].join(' ');
}

const MIGRATION_LEDGER_EXISTS_SQL = "SELECT COALESCE(to_regclass('agentmesh_deploy.migration_ledger')::text, '');";
const ROLLBACK_LEDGER_EXISTS_SQL = "SELECT COALESCE(to_regclass('agentmesh_deploy.rollback_ledger')::text, '');";

const ROLLBACK_LEDGER_BOOTSTRAP_SQL = [
  'CREATE SCHEMA IF NOT EXISTS agentmesh_deploy;',
  'CREATE TABLE IF NOT EXISTS agentmesh_deploy.rollback_ledger (',
  'rollback_plan_fingerprint text PRIMARY KEY,',
  'rollback_plan_id text NOT NULL,',
  'strategy text NOT NULL,',
  'migration_plan_id text NOT NULL,',
  'migration_plan_fingerprint text NOT NULL,',
  'backup_evidence_id text NOT NULL,',
  'backup_evidence_fingerprint text NOT NULL,',
  'backup_provider_id text NOT NULL,',
  'baseline_schema_fingerprint text NOT NULL,',
  'completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),',
  "CHECK (rollback_plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),",
  "CHECK (strategy IN ('apply-down', 'restore-backup'))",
  ');',
].join(' ');

function rollbackLedgerCommitSql(context) {
  validateRuntimeContext(context);
  const values = [
    context.rollbackPlanFingerprint,
    context.rollbackPlanId,
    context.strategy,
    context.migrationPlanId,
    context.migrationPlanFingerprint,
    context.backupEvidenceId,
    context.backupEvidenceFingerprint,
    context.backupProviderId,
    context.baselineSchemaFingerprint,
  ];
  return [
    'INSERT INTO agentmesh_deploy.rollback_ledger (',
    'rollback_plan_fingerprint, rollback_plan_id, strategy, migration_plan_id,',
    'migration_plan_fingerprint, backup_evidence_id, backup_evidence_fingerprint,',
    'backup_provider_id, baseline_schema_fingerprint',
    `) VALUES (${values.map(postgresStringLiteral).join(', ')})`,
    'ON CONFLICT (rollback_plan_fingerprint) DO NOTHING;',
  ].join(' ');
}

function normalizeAttempts(value) {
  const attempts = value === undefined ? 30 : Number(value);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) {
    throw operationError('VALIDATION_FAILED', 'Restore verification attempts must be between 1 and 120.');
  }
  return attempts;
}

function normalizeInterval(value) {
  const interval = value === undefined ? 2000 : Number(value);
  if (!Number.isInteger(interval) || interval < 0 || interval > 30000) {
    throw operationError('VALIDATION_FAILED', 'Restore verification interval must be between 0 and 30 seconds.');
  }
  return interval;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
