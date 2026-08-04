import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { createNeonV2AdapterFromConnection } from './adapters/neon-v2.js';
import { showBackupEvidence } from './backup-evidence.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { loadCommittedMigrationBundle, showDatabaseMigrationPlan } from './migration-plan.js';
import { createPostgresMigrationExecutor } from './postgres-migration-runtime.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { parseSecretRef } from './secret-store.js';
import { nowIso } from './utils.js';

const PROFILE_ID = /^database-runtime-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const POSTGRES_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function createDatabaseRuntimeProfile(options) {
  if (!options.yes) {
    throw operationError('APPROVAL_REQUIRED', 'Database Runtime Profile creation requires explicit --yes confirmation.');
  }
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'database-runtime-profile-create', () => {
    const context = loadContext({ ...options, home });
    assertControlHomeSeparated(home, context.project.source);
    const before = captureSourceGuard(context.project.source);
    const createdAt = options.now || nowIso();
    const expiresAt = normalizeExpiration(options.expiresAt, createdAt);
    const allowedHosts = normalizeHosts(options.allowedHosts || options.databaseHosts || []);
    const approvedBy = normalizeActor(options.approvedBy);
    const action = migrationAction(context.plan);
    assertActionBindings(action, context);
    const base = {
      schemaVersion: 1,
      kind: 'DatabaseRuntimeProfile',
      projectId: context.project.id,
      graphId: context.graph.id,
      graphFingerprint: context.graph.fingerprint,
      configurationId: context.configuration.id,
      configurationFingerprint: context.configuration.fingerprint,
      migrationPlanId: context.migrationPlan.id,
      migrationPlanFingerprint: context.migrationPlan.fingerprint,
      backupEvidenceId: context.backupEvidence.id,
      backupEvidenceFingerprint: context.backupEvidence.fingerprint,
      adapterPlanId: context.plan.id,
      adapterPlanFingerprint: context.plan.fingerprint,
      provider: 'neon',
      providerProjectId: action.input.projectId,
      branchId: action.input.branchId,
      databaseName: action.input.databaseName,
      connectionId: action.connectionId,
      connectionSecretRef: context.configuration.database.connectionSecretRef,
      allowedHosts,
      baselineSchemaFingerprint: action.input.baselineSchemaFingerprint,
      expectedSchemaVersion: action.input.expectedSchemaVersion,
      classification: action.input.classification,
      migrationCount: action.input.migrationCount,
      statementCount: action.input.statementCount,
      ledger: {
        schema: 'agentmesh_deploy',
        table: 'migration_ledger',
        ownership: 'immutable-plan-and-backup-fingerprints',
      },
      allowSqlExecution: true,
      approvedBy,
      createdAt,
      expiresAt,
    };
    const fingerprint = databaseRuntimeProfileFingerprint(base);
    let profile = {
      ...base,
      id: `database-runtime-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateDatabaseRuntimeProfile(profile, { ...context, now: createdAt, requireActive: true });
    const directory = path.join(projectPath(home, context.project.id), 'database-runtime-profiles');
    const profileFile = path.join(directory, `${profile.id}.json`);
    let reused = false;
    if (fs.existsSync(profileFile)) {
      const existing = readProfile(profileFile, { ...context, now: createdAt, requireActive: true });
      if (existing.fingerprint !== profile.fingerprint) {
        throw operationError('CONFLICT', `Database Runtime Profile ID collision: ${profile.id}`);
      }
      profile = existing;
      reused = true;
    } else {
      writeJsonAtomic(profileFile, profile);
    }
    const repositoryGuard = completeSourceGuard(context.project.source, before);
    return {
      kind: 'database-runtime-profile', operation: 'create', status: 'succeeded', home,
      projectId: context.project.id, profile, profileFile, effectiveStatus: 'active', reused,
      repositoryGuard, networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      sqlStatementsExecuted: 0, secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function showDatabaseRuntimeProfile(options) {
  if (!PROFILE_ID.test(options.profileId || '')) {
    throw operationError('VALIDATION_FAILED', 'Database Runtime Profile ID is invalid.');
  }
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const profileFile = path.join(
    projectPath(home, project.id), 'database-runtime-profiles', `${options.profileId}.json`
  );
  if (!fs.existsSync(profileFile)) {
    throw operationError('NOT_FOUND', `Database Runtime Profile not found: ${options.profileId}`);
  }
  let shell;
  try { shell = JSON.parse(fs.readFileSync(profileFile, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Runtime Profile JSON is invalid: ${error.message}`); }
  const context = loadContext({ ...options, home, adapterPlanId: options.adapterPlanId || shell.adapterPlanId });
  const currentTime = options.now || nowIso();
  const profile = readProfile(profileFile, { ...context, now: currentTime });
  const effectiveStatus = databaseRuntimeProfileStatus(
    context.home, context.project.id, profile, currentTime
  );
  return {
    kind: 'database-runtime-profile', operation: 'read', home: context.home,
    projectId: context.project.id, profile, profileFile, effectiveStatus,
  };
}

export function authorizeDatabaseVerificationRuntimeProfile(options) {
  if (!options.profileId) return null;
  const shown = showDatabaseRuntimeProfile({
    home: options.home,
    projectId: options.project.id,
    graphId: options.graph.id,
    configurationId: options.configuration.id,
    profileId: options.profileId,
    now: options.now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      `Database Runtime Profile is ${shown.effectiveStatus}: ${shown.profile.id}`
    );
  }
  const profile = shown.profile;
  if (profile.provider !== 'neon' || options.configuration.database.provider !== 'neon' ||
      profile.graphId !== options.graph.id || profile.graphFingerprint !== options.graph.fingerprint ||
      profile.configurationId !== options.configuration.id ||
      profile.configurationFingerprint !== options.configuration.fingerprint ||
      profile.databaseName !== options.configuration.database.databaseName ||
      profile.connectionSecretRef !== options.configuration.database.connectionSecretRef) {
    throw operationError('CONFLICT', 'Database Runtime Profile does not match Product Verification database identity.');
  }
  return profile;
}

export function revokeDatabaseRuntimeProfile(options) {
  if (!options.yes) {
    throw operationError('APPROVAL_REQUIRED', 'Database Runtime Profile revocation requires explicit --yes confirmation.');
  }
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'database-runtime-profile-revoke', () => {
    const shown = showDatabaseRuntimeProfile({ ...options, home });
    const revokedAt = options.now || nowIso();
    const revocationFile = revocationPath(home, shown.projectId, shown.profile.id);
    let revocation;
    let reused = false;
    if (fs.existsSync(revocationFile)) {
      revocation = readRevocation(revocationFile, shown.profile);
      reused = true;
    } else {
      const base = {
        schemaVersion: 1,
        kind: 'DatabaseRuntimeProfileRevocation',
        profileId: shown.profile.id,
        profileFingerprint: shown.profile.fingerprint,
        projectId: shown.projectId,
        revokedBy: normalizeActor(options.approvedBy),
        revokedAt,
      };
      revocation = { ...base, fingerprint: fingerprint(base) };
      validateRevocation(revocation, shown.profile);
      writeJsonAtomic(revocationFile, revocation);
    }
    return {
      ...shown, operation: 'revoke', status: 'succeeded', effectiveStatus: 'revoked',
      revocation, revocationFile, reused, providerMutationsExecuted: 0,
      sqlStatementsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function validateDatabaseRuntimeProfile(profile, expected = {}) {
  const issues = [];
  exactKeys(profile, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
    'configurationId', 'configurationFingerprint', 'migrationPlanId', 'migrationPlanFingerprint',
    'backupEvidenceId', 'backupEvidenceFingerprint', 'adapterPlanId', 'adapterPlanFingerprint',
    'provider', 'providerProjectId', 'branchId', 'databaseName', 'connectionId',
    'connectionSecretRef', 'allowedHosts', 'baselineSchemaFingerprint', 'expectedSchemaVersion',
    'classification', 'migrationCount', 'statementCount', 'ledger', 'allowSqlExecution',
    'approvedBy', 'createdAt', 'expiresAt',
  ], '$', issues);
  exactKeys(profile?.ledger, ['schema', 'table', 'ownership'], '$.ledger', issues);
  if (profile?.schemaVersion !== 1 || profile?.kind !== 'DatabaseRuntimeProfile') issues.push('kind|schemaVersion');
  if (!PROFILE_ID.test(profile?.id || '') || !SHA256.test(profile?.fingerprint || '')) issues.push('id|fingerprint');
  for (const key of [
    'graphFingerprint', 'configurationFingerprint', 'migrationPlanFingerprint',
    'backupEvidenceFingerprint', 'adapterPlanFingerprint', 'baselineSchemaFingerprint',
  ]) if (!SHA256.test(profile?.[key] || '')) issues.push(key);
  if (profile?.provider !== 'neon' || !SAFE_ID.test(profile?.providerProjectId || '') ||
      !SAFE_ID.test(profile?.branchId || '') || !POSTGRES_NAME.test(profile?.databaseName || '')) {
    issues.push('providerIdentity');
  }
  try { parseSecretRef(profile?.connectionSecretRef); } catch { issues.push('connectionSecretRef'); }
  if (!Array.isArray(profile?.allowedHosts) || profile.allowedHosts.length !== 1 ||
      new Set(profile.allowedHosts).size !== profile.allowedHosts.length ||
      profile.allowedHosts.some((host) => !HOST.test(host) || isPrivateHost(host) || !host.endsWith('.neon.tech'))) {
    issues.push('allowedHosts');
  }
  if (!VERSION.test(profile?.expectedSchemaVersion || '') ||
      !['additive', 'reversible', 'destructive', 'unknown'].includes(profile?.classification) ||
      !Number.isInteger(profile?.migrationCount) || profile.migrationCount < 1 ||
      !Number.isInteger(profile?.statementCount) || profile.statementCount < 1) issues.push('migration');
  if (profile?.ledger?.schema !== 'agentmesh_deploy' || profile?.ledger?.table !== 'migration_ledger' ||
      profile?.ledger?.ownership !== 'immutable-plan-and-backup-fingerprints') issues.push('ledger');
  if (profile?.allowSqlExecution !== true || !ACTOR.test(profile?.approvedBy || '')) issues.push('authorization');
  if (!isDate(profile?.createdAt) || !isDate(profile?.expiresAt) ||
      Date.parse(profile.expiresAt) <= Date.parse(profile.createdAt) ||
      Date.parse(profile.expiresAt) - Date.parse(profile.createdAt) > MAX_LIFETIME_MS) issues.push('time');
  if (expected.project && profile?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (profile?.graphId !== expected.graph.id || profile?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    profile?.configurationId !== expected.configuration.id ||
    profile?.configurationFingerprint !== expected.configuration.fingerprint ||
    profile?.connectionSecretRef !== expected.configuration.database.connectionSecretRef
  )) issues.push('configuration');
  if (expected.migrationPlan && (
    profile?.migrationPlanId !== expected.migrationPlan.id ||
    profile?.migrationPlanFingerprint !== expected.migrationPlan.fingerprint
  )) issues.push('migrationPlan');
  if (expected.backupEvidence && (
    profile?.backupEvidenceId !== expected.backupEvidence.id ||
    profile?.backupEvidenceFingerprint !== expected.backupEvidence.fingerprint
  )) issues.push('backupEvidence');
  if (expected.plan && (
    profile?.adapterPlanId !== expected.plan.id || profile?.adapterPlanFingerprint !== expected.plan.fingerprint
  )) issues.push('adapterPlan');
  if (expected.plan && expected.configuration && expected.migrationPlan && expected.backupEvidence) {
    try { assertActionBindings(migrationAction(expected.plan), expected); }
    catch { issues.push('actionBinding'); }
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Database Runtime Profile is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = databaseRuntimeProfileFingerprint(profile);
  if (profile.fingerprint !== actual || profile.id !== `database-runtime-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Runtime Profile fingerprint mismatch: ${profile.id}`);
  }
  if (expected.requireActive && expected.now && Date.parse(profile.expiresAt) <= Date.parse(expected.now)) {
    throw operationError('APPROVAL_EXPIRED', `Database Runtime Profile expired: ${profile.id}`);
  }
  return profile;
}

export function databaseRuntimeProfileFingerprint(profile) {
  const value = structuredClone(profile);
  delete value.id;
  delete value.fingerprint;
  return fingerprint(value);
}

export function authorizeDatabaseRuntimeProfile(options) {
  const action = (options.plan?.actions || []).find((item) =>
    item.provider === 'neon' && item.nodeId === 'database.migrate' && item.executeMethod === 'executeMigration'
  );
  if (!action) {
    if (options.profileId) {
      throw operationError('CONFLICT', 'Database Runtime Profile was supplied for a plan without Neon migration execution.');
    }
    return null;
  }
  if (!options.profileId) return null;
  const shown = showDatabaseRuntimeProfile({
    home: options.home,
    projectId: options.project.id,
    graphId: options.graph.id,
    configurationId: options.plan.configurationId,
    migrationPlanId: options.plan.migrationPlanId,
    backupEvidenceId: options.plan.backupEvidenceId,
    adapterPlanId: options.plan.id,
    profileId: options.profileId,
    now: options.now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      `Database Runtime Profile is ${shown.effectiveStatus}: ${shown.profile.id}`
    );
  }
  return shown.profile;
}

export function authorizeDatabaseRollbackRuntimeProfile(options) {
  const database = options.rollbackPlan?.database;
  const executable = ['apply-down', 'restore-backup'].includes(database?.strategy);
  if (!executable) {
    if (options.profileId) {
      throw operationError('CONFLICT', 'Database Runtime Profile was supplied for a Rollback Plan without database execution.');
    }
    return null;
  }
  if (!options.profileId) {
    throw operationError(
      'APPROVAL_REQUIRED',
      'Executable database rollback requires --database-runtime-profile before any provider mutation.'
    );
  }
  const backup = showBackupEvidence({
    home: options.home,
    projectId: options.project.id,
    graphId: options.graph.id,
    evidenceId: database.backupEvidenceId,
  }).evidence;
  const shown = showDatabaseRuntimeProfile({
    home: options.home,
    projectId: options.project.id,
    graphId: options.graph.id,
    configurationId: options.configuration.id,
    migrationPlanId: database.migrationPlanId,
    backupEvidenceId: database.backupEvidenceId,
    profileId: options.profileId,
    now: options.now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      `Database Runtime Profile is ${shown.effectiveStatus}: ${shown.profile.id}`
    );
  }
  const profile = shown.profile;
  if (profile.provider !== 'neon' || database.provider !== 'neon' ||
      profile.migrationPlanId !== database.migrationPlanId ||
      profile.migrationPlanFingerprint !== database.migrationPlanFingerprint ||
      profile.backupEvidenceId !== database.backupEvidenceId ||
      profile.backupEvidenceFingerprint !== database.backupEvidenceFingerprint ||
      profile.providerProjectId !== backup.backup.resource.attributes.projectId ||
      profile.branchId !== backup.backup.resource.attributes.sourceBranchId ||
      profile.databaseName !== options.configuration.database.databaseName) {
    throw operationError('CONFLICT', 'Database Runtime Profile does not match the exact Rollback Plan and Backup Evidence.');
  }
  return profile;
}

export function attachDatabaseRuntime(options) {
  const profile = options.profile;
  if (!profile) return options.runtime;
  if (options.allowDatabaseMigration !== true) {
    throw operationError(
      'APPROVAL_REQUIRED',
      'Database Runtime Profile execution requires explicit --allow-database-migration authorization.'
    );
  }
  const action = migrationAction(options.plan);
  const connection = (options.connections || []).find((item) => item.id === profile.connectionId);
  if (!connection || connection.provider !== 'neon' || connection.status !== 'ready' ||
      action.connectionId !== connection.id) {
    throw operationError('CREDENTIAL_MISSING', 'Database Runtime Profile Neon Connection is missing, mismatched, or not ready.');
  }
  if (!options.runtime?.secretRuntime) {
    throw operationError('CAPABILITY_MISSING', 'Database Runtime execution requires a Secret Runtime.');
  }
  const providerOptions = { ...(options.runtime.providerOptions || {}) };
  const neonOptions = { ...(providerOptions.neon || {}) };
  if (neonOptions.migrationExecutor) {
    throw operationError('VALIDATION_FAILED', 'Native Database Runtime does not accept an injected migration executor.');
  }
  const materialized = lookup(options.runtime.materializedConnections, connection.id) || connection;
  const connectionOptions = lookup(options.runtime.connectionOptions, connection.id) || {};
  const inspectorAdapter = createNeonV2AdapterFromConnection(materialized, {
    ...neonOptions,
    ...connectionOptions,
    migrationExecutor: undefined,
  });
  const schemaInspector = createNeonRuntimeInspector(inspectorAdapter);
  const migrationExecutor = createPostgresMigrationExecutor({
    secretRuntime: options.runtime.secretRuntime,
    connectionSecretRef: profile.connectionSecretRef,
    allowedHosts: profile.allowedHosts,
    allowSqlExecution: profile.allowSqlExecution,
    schemaInspector,
    commandRunner: options.databaseCommandRunner,
    bundleLoader: () => loadCommittedMigrationBundle({
      home: options.home,
      projectId: options.project.id,
      graphId: options.graph.id,
      configurationId: profile.configurationId,
      planId: profile.migrationPlanId,
      direction: 'up',
    }),
  });
  providerOptions.neon = { ...neonOptions, migrationExecutor };
  return { ...options.runtime, providerOptions, databaseRuntimeProfile: profile };
}

function createNeonRuntimeInspector(adapter) {
  return async (context, runtime) => {
    const result = await adapter.inspectSchema({
      appId: 'agentmesh-database-runtime',
      logicalId: 'database.inspect',
      projectId: context.projectId,
      branchId: context.branchId,
      databaseName: context.databaseName,
    });
    if (!result?.ok || result.status !== 'succeeded') {
      throw operationError('DATABASE_INSPECTION_FAILED', 'Neon structural Schema inspection failed.');
    }
    const ledgerExists = String(await runtime.query(LEDGER_EXISTS_SQL)).trim() === 'agentmesh_deploy.migration_ledger';
    const ownership = ledgerExists
      ? parseLedgerRow(await runtime.query(ledgerReadSql(context.expectedSchemaVersion)))
      : { schemaVersion: 'unmanaged', migrationPlanFingerprint: '', backupEvidenceFingerprint: '' };
    return {
      schemaVersion: ownership.schemaVersion,
      schemaFingerprint: result.data.schemaFingerprint,
      migrationPlanFingerprint: ownership.migrationPlanFingerprint,
      backupEvidenceFingerprint: ownership.backupEvidenceFingerprint,
    };
  };
}

const LEDGER_EXISTS_SQL = "SELECT COALESCE(to_regclass('agentmesh_deploy.migration_ledger')::text, '');";

function ledgerReadSql(expectedSchemaVersion) {
  if (!VERSION.test(expectedSchemaVersion || '')) {
    throw operationError('VALIDATION_FAILED', 'Expected Schema Version is invalid for Ledger inspection.');
  }
  return [
    "SELECT COALESCE((SELECT schema_version || E'\\t' || migration_plan_fingerprint || E'\\t' || backup_evidence_fingerprint",
    `FROM agentmesh_deploy.migration_ledger WHERE schema_version = '${expectedSchemaVersion}'),`,
    "E'unmanaged\\t\\t');",
  ].join(' ');
}

function parseLedgerRow(stdout) {
  const line = String(stdout || '').trim();
  const parts = line.split('\t');
  if (parts.length !== 3 || !VERSION.test(parts[0]) ||
      (parts[1] && !SHA256.test(parts[1])) || (parts[2] && !SHA256.test(parts[2])) ||
      Boolean(parts[1]) !== Boolean(parts[2])) {
    throw operationError('PROVIDER_RESPONSE_INVALID', 'Database migration Ledger returned invalid ownership evidence.');
  }
  return {
    schemaVersion: parts[0],
    migrationPlanFingerprint: parts[1],
    backupEvidenceFingerprint: parts[2],
  };
}

function loadContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: options.adapterPlanId,
  }).plan;
  if (!plan.configurationId || !plan.migrationPlanId || !plan.backupEvidenceId) {
    throw operationError('CONFLICT', 'Database Runtime Profile requires an Adapter Plan bound to Configuration, Migration Plan, and Backup Evidence.');
  }
  if (options.configurationId && options.configurationId !== plan.configurationId) {
    throw operationError('CONFLICT', 'Database Runtime Profile Configuration differs from its Adapter Plan binding.');
  }
  if (options.migrationPlanId && options.migrationPlanId !== plan.migrationPlanId) {
    throw operationError('CONFLICT', 'Database Runtime Profile Migration Plan differs from its Adapter Plan binding.');
  }
  if (options.backupEvidenceId && options.backupEvidenceId !== plan.backupEvidenceId) {
    throw operationError('CONFLICT', 'Database Runtime Profile Backup Evidence differs from its Adapter Plan binding.');
  }
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: plan.configurationId,
  }).configuration;
  const migrationPlan = showDatabaseMigrationPlan({
    home, projectId: project.id, graphId: graph.id,
    configurationId: configuration.id, planId: plan.migrationPlanId,
  }).plan;
  const backupEvidence = showBackupEvidence({
    home, projectId: project.id, graphId: graph.id, evidenceId: plan.backupEvidenceId,
  }).evidence;
  return { home, project, graph, plan, configuration, migrationPlan, backupEvidence };
}

function migrationAction(plan) {
  const matches = (plan.actions || []).filter((action) =>
    action.nodeId === 'database.migrate' && action.provider === 'neon' &&
    action.planMethod === 'planMigration' && action.executeMethod === 'executeMigration'
  );
  if (matches.length !== 1) {
    throw operationError('CONFLICT', 'Database Runtime Profile requires exactly one Neon Migration Apply action.');
  }
  return matches[0];
}

function assertActionBindings(action, context) {
  const input = action.input || {};
  const backup = context.backupEvidence;
  const migration = context.migrationPlan;
  const configuration = context.configuration;
  if (
    configuration.database.provider !== 'neon' || migration.provider !== 'neon' || backup.provider !== 'neon' ||
    input.projectId !== backup.backup.resource.attributes.projectId ||
    input.branchId !== backup.backup.resource.attributes.sourceBranchId ||
    input.databaseName !== configuration.database.databaseName ||
    input.expectedSchemaVersion !== migration.expectedSchemaVersion ||
    input.baselineSchemaFingerprint !== backup.schemaInspection.schemaFingerprint ||
    input.classification !== migration.summary.classification ||
    input.migrationCount !== migration.summary.migrationCount ||
    input.statementCount !== migration.summary.statementCount ||
    input.migrationPlanId !== migration.id || input.migrationPlanFingerprint !== migration.fingerprint ||
    input.backupEvidenceId !== backup.id || input.backupEvidenceFingerprint !== backup.fingerprint
  ) throw operationError('CONFLICT', 'Neon Migration action does not match Configuration, Migration Plan, and Backup Evidence.');
}

function normalizeHosts(values) {
  const hosts = [...new Set(values.map((value) => String(value || '').toLowerCase()))].sort();
  if (hosts.length !== 1 || hosts.some((host) =>
    !HOST.test(host) || isPrivateHost(host) || !host.endsWith('.neon.tech')
  )) {
    throw operationError('VALIDATION_FAILED', 'Database Runtime Profile requires exactly one public Neon PostgreSQL host.');
  }
  return hosts;
}

function normalizeActor(value) {
  const actor = String(value || '');
  if (!ACTOR.test(actor)) throw operationError('VALIDATION_FAILED', 'Database Runtime Profile actor is invalid.');
  return actor;
}

function normalizeExpiration(value, createdAt) {
  if (!isDate(value)) throw operationError('VALIDATION_FAILED', 'Database Runtime Profile expiresAt must be ISO-8601.');
  const lifetime = Date.parse(value) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_MS) {
    throw operationError('VALIDATION_FAILED', 'Database Runtime Profile lifetime must be greater than zero and at most 24 hours.');
  }
  return new Date(Date.parse(value)).toISOString();
}

function readProfile(file, expected) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Runtime Profile JSON is invalid: ${error.message}`); }
  return validateDatabaseRuntimeProfile(profile, expected);
}

export function databaseRuntimeProfileStatusAt(home, projectId, profile, now) {
  const file = revocationPath(home, projectId, profile.id);
  if (fs.existsSync(file)) {
    const revocation = readRevocation(file, profile);
    if (Date.parse(revocation.revokedAt) <= Date.parse(now)) return 'revoked';
  }
  return Date.parse(profile.expiresAt) <= Date.parse(now) ? 'expired' : 'active';
}

function databaseRuntimeProfileStatus(home, projectId, profile, now) {
  return databaseRuntimeProfileStatusAt(home, projectId, profile, now);
}

function revocationPath(home, projectId, profileId) {
  return path.join(projectPath(home, projectId), 'database-runtime-profiles', 'revocations', `${profileId}.json`);
}

function readRevocation(file, profile) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Runtime Profile revocation JSON is invalid: ${error.message}`); }
  return validateRevocation(value, profile);
}

function validateRevocation(value, profile) {
  const issues = [];
  exactKeys(value, [
    'schemaVersion', 'kind', 'profileId', 'profileFingerprint', 'projectId',
    'revokedBy', 'revokedAt', 'fingerprint',
  ], '$', issues);
  if (value?.schemaVersion !== 1 || value?.kind !== 'DatabaseRuntimeProfileRevocation' ||
      value?.profileId !== profile.id || value?.profileFingerprint !== profile.fingerprint ||
      value?.projectId !== profile.projectId || !ACTOR.test(value?.revokedBy || '') ||
      !isDate(value?.revokedAt) || !SHA256.test(value?.fingerprint || '')) issues.push('revocation');
  if (issues.length > 0 || value.fingerprint !== fingerprint(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'fingerprint')
  ))) throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Runtime Profile revocation is invalid.');
  return value;
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(label);
    return;
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0) issues.push(`${label}.unsupported(${extras.sort().join('|')})`);
  if (missing.length > 0) issues.push(`${label}.missing(${missing.sort().join('|')})`);
}

function isPrivateHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) || hostname === '::1';
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function lookup(collection, key) {
  if (!collection) return undefined;
  if (collection instanceof Map) return collection.get(key);
  return collection[key];
}
