import { spawnSync } from 'node:child_process';

import { operationError } from './errors.js';
import { parseSecretRef } from './secret-store.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

export function createPostgresMigrationExecutor(options = {}) {
  if (!options.secretRuntime || typeof options.secretRuntime.resolve !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'PostgreSQL Migration Runtime requires a Secret Runtime.');
  }
  parseSecretRef(options.connectionSecretRef);
  if (typeof options.bundleLoader !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'PostgreSQL Migration Runtime requires a locked-commit bundle loader.');
  }
  if (typeof options.schemaInspector !== 'function') {
    throw operationError(
      'CAPABILITY_MISSING',
      'PostgreSQL Migration Runtime requires a provider-specific Schema Inspector; generic psql fingerprints are not accepted.'
    );
  }
  const allowedHosts = normalizePostgresAllowedHosts(options.allowedHosts);
  const commandRunner = options.commandRunner || runPsqlCommand;
  const timeoutMs = normalizePostgresTimeout(options.timeoutMs);

  return Object.freeze({
    async inspect(context) {
      const session = await resolvePostgresSession(options.secretRuntime, options.connectionSecretRef, allowedHosts, context);
      const inspection = await options.schemaInspector(context, {
        query: (sql) => executePostgresQuery(commandRunner, session, sql, timeoutMs),
      });
      return normalizeInspection(inspection);
    },

    async apply(context) {
      if (options.allowSqlExecution !== true) {
        throw operationError('APPROVAL_REQUIRED', 'PostgreSQL Migration Runtime SQL execution is disabled.');
      }
      const bundle = await options.bundleLoader(context);
      validateBundle(bundle, context);
      if (bundle.migrations.some((migration) => migration.transactionMode !== 'transactional')) {
        throw operationError(
          'CAPABILITY_MISSING',
          'Native PostgreSQL Runtime currently executes only fully transactional migration bundles.'
        );
      }
      const session = await resolvePostgresSession(options.secretRuntime, options.connectionSecretRef, allowedHosts, context);
      const args = [
        '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--single-transaction',
        '--command', LEDGER_BOOTSTRAP_SQL,
      ];
      for (const migration of bundle.migrations) args.push('--file', migration.file);
      args.push('--command', migrationLedgerCommitSql(context));
      const result = await commandRunner('psql', args, {
        env: session.env,
        timeoutMs,
        maxOutputBytes: 1024 * 1024,
      });
      if (!result || result.status !== 0) {
        throw operationError(
          'DATABASE_COMMAND_FAILED',
          'PostgreSQL migration command failed; output was suppressed and automatic replay is disabled.'
        );
      }
      return {
        sqlStatementsExecuted: bundle.statementCount,
        migrationPlanId: bundle.migrationPlanId,
        migrationPlanFingerprint: bundle.migrationPlanFingerprint,
        sourceCommit: bundle.sourceCommit,
        ledgerUpdated: true,
        rawSqlPersisted: false,
        secretValuesExposed: false,
      };
    },
  });
}

function validateBundle(bundle, context) {
  if (!bundle || bundle.kind !== 'committed-migration-bundle' || bundle.direction !== 'up') {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Migration Runtime received an invalid committed SQL bundle.');
  }
  if (
    bundle.migrationPlanId !== context.migrationPlanId ||
    bundle.migrationPlanFingerprint !== context.migrationPlanFingerprint ||
    bundle.statementCount !== context.statementCount ||
    !Array.isArray(bundle.migrations) || bundle.migrations.length === 0 ||
    bundle.migrations.length !== context.migrationCount
  ) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Committed SQL bundle does not match the approved Migration context.');
  }
  for (const migration of bundle.migrations) {
    if (
      typeof migration?.file !== 'string' || !migration.file ||
      !/^[a-f0-9]{64}$/.test(migration?.sha256 || '') ||
      !/^[a-f0-9]{40,64}$/.test(migration?.blobId || '') ||
      !Number.isInteger(migration?.statementCount) || migration.statementCount < 1 ||
      !['transactional', 'non-transactional', 'mixed'].includes(migration?.transactionMode)
    ) throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Committed SQL bundle contains an invalid migration entry.');
  }
}

export async function resolvePostgresSession(secretRuntime, connectionSecretRef, allowedHosts, context) {
  const value = await secretRuntime.resolve(connectionSecretRef);
  let url;
  try { url = new URL(value); }
  catch { throw operationError('CREDENTIAL_MISSING', 'Database connection Secret Ref did not resolve to a valid PostgreSQL URI.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || !url.username || !url.password ||
      !url.hostname || !url.pathname || url.pathname === '/') {
    throw operationError('CREDENTIAL_MISSING', 'Database connection Secret Ref did not resolve to a complete PostgreSQL URI.');
  }
  const hostname = url.hostname.toLowerCase();
  if (!HOST.test(hostname) || !allowedHosts.has(hostname) || isPrivateHost(hostname)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Database connection host is outside the approved Runtime Profile.');
  }
  const databaseName = decode(url.pathname.slice(1), 'database name');
  if (databaseName !== context.databaseName) {
    throw operationError('CONFLICT', 'Database connection Secret Ref targets a different database name.');
  }
  const sslmode = url.searchParams.get('sslmode') || 'require';
  const channelBinding = url.searchParams.get('channel_binding') || '';
  const unknown = [...url.searchParams.keys()].filter((key) => !['sslmode', 'channel_binding'].includes(key));
  if (!['require', 'verify-ca', 'verify-full'].includes(sslmode) ||
      (channelBinding && channelBinding !== 'require') || unknown.length > 0) {
    throw operationError('VALIDATION_FAILED', 'Database connection URI contains unsupported or unsafe connection parameters.');
  }
  const port = url.port || '5432';
  if (!/^\d{2,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw operationError('VALIDATION_FAILED', 'Database connection URI port is invalid.');
  }
  return {
    env: Object.freeze({
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C',
      PGHOST: hostname,
      PGPORT: port,
      PGDATABASE: databaseName,
      PGUSER: decode(url.username, 'database user'),
      PGPASSWORD: decode(url.password, 'database password'),
      PGSSLMODE: sslmode,
      ...(channelBinding ? { PGCHANNELBINDING: channelBinding } : {}),
      PGCONNECT_TIMEOUT: '10',
    }),
  };
}

export async function executePostgresQuery(commandRunner, session, sql, timeoutMs) {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql, 'utf8') > 64 * 1024 || sql.includes('\0')) {
    throw operationError('VALIDATION_FAILED', 'Schema Inspector query is invalid.');
  }
  const result = await commandRunner('psql', [
    '--no-psqlrc', '--no-password', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align',
    '--command', sql,
  ], { env: session.env, timeoutMs, maxOutputBytes: 1024 * 1024 });
  if (!result || result.status !== 0) {
    throw operationError('DATABASE_INSPECTION_FAILED', 'PostgreSQL Schema inspection failed; command output was suppressed.');
  }
  const stdout = String(result.stdout || '');
  if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'PostgreSQL Schema inspection output exceeded the safe limit.');
  }
  return stdout;
}

function normalizeInspection(value) {
  const schemaVersion = String(value?.schemaVersion || '');
  const schemaFingerprint = String(value?.schemaFingerprint || '');
  const migrationPlanFingerprint = String(value?.migrationPlanFingerprint || '');
  const backupEvidenceFingerprint = String(value?.backupEvidenceFingerprint || '');
  if (!VERSION.test(schemaVersion) || !SHA256.test(schemaFingerprint) ||
      (migrationPlanFingerprint && !SHA256.test(migrationPlanFingerprint)) ||
      (backupEvidenceFingerprint && !SHA256.test(backupEvidenceFingerprint)) ||
      Boolean(migrationPlanFingerprint) !== Boolean(backupEvidenceFingerprint) ||
      Object.keys(value || {}).some((key) => ![
        'schemaVersion', 'schemaFingerprint', 'migrationPlanFingerprint', 'backupEvidenceFingerprint',
      ].includes(key))) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'Provider-specific Schema Inspector returned invalid evidence.');
  }
  return { schemaVersion, schemaFingerprint, migrationPlanFingerprint, backupEvidenceFingerprint };
}

const LEDGER_BOOTSTRAP_SQL = [
  'CREATE SCHEMA IF NOT EXISTS agentmesh_deploy;',
  'CREATE TABLE IF NOT EXISTS agentmesh_deploy.migration_ledger (',
  'schema_version text PRIMARY KEY,',
  'migration_plan_id text NOT NULL,',
  'migration_plan_fingerprint text NOT NULL,',
  'backup_evidence_id text NOT NULL,',
  'backup_evidence_fingerprint text NOT NULL,',
  'applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),',
  "CHECK (migration_plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),",
  "CHECK (backup_evidence_fingerprint ~ '^sha256:[a-f0-9]{64}$')",
  ');',
].join(' ');

function migrationLedgerCommitSql(context) {
  const values = [
    context.expectedSchemaVersion,
    context.migrationPlanId,
    context.migrationPlanFingerprint,
    context.backupEvidenceId,
    context.backupEvidenceFingerprint,
  ];
  if (!VERSION.test(values[0] || '') ||
      !SAFE_CONTROL_ID.test(values[1] || '') || !SHA256.test(values[2] || '') ||
      !SAFE_CONTROL_ID.test(values[3] || '') || !SHA256.test(values[4] || '')) {
    throw operationError('VALIDATION_FAILED', 'Migration Ledger ownership values are invalid.');
  }
  return [
    'INSERT INTO agentmesh_deploy.migration_ledger (',
    'schema_version, migration_plan_id, migration_plan_fingerprint,',
    'backup_evidence_id, backup_evidence_fingerprint',
    `) VALUES (${values.map(postgresStringLiteral).join(', ')});`,
  ].join(' ');
}

export function postgresStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function normalizePostgresAllowedHosts(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw operationError('VALIDATION_FAILED', 'PostgreSQL Migration Runtime requires at least one approved database host.');
  }
  const hosts = new Set(values.map((value) => String(value || '').toLowerCase()));
  if ([...hosts].some((host) => !HOST.test(host) || isPrivateHost(host))) {
    throw operationError('VALIDATION_FAILED', 'PostgreSQL Migration Runtime contains an invalid approved host.');
  }
  return hosts;
}

export function normalizePostgresTimeout(value) {
  const timeout = value === undefined ? 5 * 60 * 1000 : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw operationError('VALIDATION_FAILED', 'PostgreSQL Migration Runtime timeout must be between 1 second and 15 minutes.');
  }
  return timeout;
}

function decode(value, label) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes('\0')) throw new Error('empty');
    return decoded;
  } catch {
    throw operationError('CREDENTIAL_MISSING', `Database connection URI ${label} is invalid.`);
  }
}

function isPrivateHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) || hostname === '::1';
}

export function runPsqlCommand(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: '',
  };
}
