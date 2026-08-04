import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { readExternalDeployment } from './contracts-v2.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { showDatabaseMigrationPlan } from './migration-plan.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { validateActionResult } from './provider-contract.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const EVIDENCE_ID = /^backup-evidence-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^launch-[a-f0-9-]{36}$/;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function createBackupEvidence(options) {
  const context = loadContext(options);
  const { home, project, graph, configuration, adapterPlan, migrationPlan } = context;
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const facts = deriveBackupFacts(context);
  const base = {
    schemaVersion: 1,
    kind: 'BackupEvidence',
    projectId: project.id,
    graphId: graph.id,
    graphFingerprint: graph.fingerprint,
    configurationId: configuration.id,
    configurationFingerprint: configuration.fingerprint,
    migrationPlanId: migrationPlan.id,
    migrationPlanFingerprint: migrationPlan.fingerprint,
    adapterPlanId: adapterPlan.id,
    adapterPlanFingerprint: adapterPlan.fingerprint,
    provider: 'neon',
    backupType: 'neon-snapshot',
    schemaInspection: facts.schemaInspection,
    backup: facts.backup,
    verification: facts.verification,
    status: 'verified',
    createdAt: options.now || nowIso(),
  };
  const fingerprint = backupEvidenceFingerprint(base);
  let evidence = {
    ...base,
    id: `backup-evidence-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    fingerprint,
  };
  validateBackupEvidence(evidence, { ...context, facts });
  const directory = path.join(projectPath(home, project.id), 'backup-evidence');
  const evidenceFile = path.join(directory, `${evidence.id}.json`);
  const currentFile = path.join(projectPath(home, project.id), 'backup-evidence.json');
  let reused = false;
  if (fs.existsSync(evidenceFile)) {
    const existing = readBackupEvidenceFile(evidenceFile, context);
    if (existing.fingerprint !== evidence.fingerprint) {
      throw operationError('CONFLICT', `Backup Evidence ID collision: ${evidence.id}`);
    }
    evidence = existing;
    reused = true;
  } else {
    writeJsonAtomic(evidenceFile, evidence);
  }
  writeJsonAtomic(currentFile, evidence);
  const repositoryGuard = completeSourceGuard(project.source, before);
  return {
    kind: 'backup-evidence', operation: 'create', status: evidence.status, home,
    projectId: project.id, evidence, evidenceFile, currentFile, reused, repositoryGuard,
    providerMutationsExecuted: 0, sqlStatementsExecuted: 0, productRepositoryChanged: false,
  };
}

export function showBackupEvidence(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const evidenceFile = options.evidenceId
    ? backupEvidencePath(home, project.id, options.evidenceId)
    : path.join(projectPath(home, project.id), 'backup-evidence.json');
  if (!fs.existsSync(evidenceFile)) throw operationError('NOT_FOUND', `Backup Evidence not found: ${evidenceFile}`);
  const shell = readJson(evidenceFile, 'Backup Evidence');
  const context = loadContext({
    home, projectId: project.id, graphId: graph.id,
    adapterPlanId: options.adapterPlanId || shell.adapterPlanId,
  });
  const evidence = validateBackupEvidence(shell, { ...context, facts: deriveBackupFacts(context) });
  return { kind: 'backup-evidence', operation: 'read', home, projectId: project.id, evidence, evidenceFile };
}

export function validateBackupEvidence(evidence, expected = {}) {
  const issues = [];
  validateExactKeys(evidence, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
    'configurationId', 'configurationFingerprint', 'migrationPlanId', 'migrationPlanFingerprint',
    'adapterPlanId', 'adapterPlanFingerprint', 'provider', 'backupType', 'schemaInspection',
    'backup', 'verification', 'status', 'createdAt',
  ], '$', issues);
  validateExactKeys(evidence?.schemaInspection, [
    'receipt', 'schemaFingerprint', 'tableCount', 'columnCount', 'constraintCount', 'observedAt',
  ], 'schemaInspection', issues);
  validateExactKeys(evidence?.backup, [
    'resource', 'createReceipt', 'operationReceipt', 'verifyReceipt', 'verifiedAt',
  ], 'backup', issues);
  validateExactKeys(evidence?.verification, [
    'providerVisible', 'exactIdentityMatch', 'operationComplete', 'restoreTested',
    'rawSchemaPersisted', 'sqlExecuted',
  ], 'verification', issues);
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== 'BackupEvidence') issues.push('kind|schemaVersion');
  if (!EVIDENCE_ID.test(evidence?.id || '') || !SHA256.test(evidence?.fingerprint || '')) issues.push('id|fingerprint');
  if (typeof evidence?.projectId !== 'string' || !evidence.projectId) issues.push('projectId');
  for (const key of [
    'graphFingerprint', 'configurationFingerprint', 'migrationPlanFingerprint', 'adapterPlanFingerprint',
  ]) if (!SHA256.test(evidence?.[key] || '')) issues.push(key);
  if (evidence?.provider !== 'neon' || evidence?.backupType !== 'neon-snapshot' || evidence?.status !== 'verified') {
    issues.push('provider|backupType|status');
  }
  if (!isDate(evidence?.createdAt)) issues.push('createdAt');
  validateReceiptRef(evidence?.schemaInspection?.receipt, 'schemaInspection.receipt', issues);
  validateReceiptRef(evidence?.backup?.createReceipt, 'backup.createReceipt', issues);
  if (evidence?.backup?.operationReceipt !== null) {
    validateReceiptRef(evidence?.backup?.operationReceipt, 'backup.operationReceipt', issues);
  }
  validateReceiptRef(evidence?.backup?.verifyReceipt, 'backup.verifyReceipt', issues);
  if (
    !SHA256.test(evidence?.schemaInspection?.schemaFingerprint || '') ||
    !nonNegativeInteger(evidence?.schemaInspection?.tableCount) ||
    !nonNegativeInteger(evidence?.schemaInspection?.columnCount) ||
    !nonNegativeInteger(evidence?.schemaInspection?.constraintCount)
  ) issues.push('schemaInspection');
  const resource = evidence?.backup?.resource;
  validateExactKeys(resource, [
    'logicalId', 'provider', 'providerId', 'type', 'name', 'lifecycle', 'version', 'attributes',
  ], 'backup.resource', issues);
  validateExactKeys(resource?.attributes, [
    'projectId', 'sourceBranchId', 'createdAt', 'expiresAt', 'manual', 'fullSizeBytes',
    'diffSizeBytes', 'migrationPlanId', 'migrationPlanFingerprint', 'snapshotPlanFingerprint',
    'restoreTested',
  ], 'backup.resource.attributes', issues);
  if (
    !resource || resource.provider !== 'neon' || resource.type !== 'database.backup' ||
    typeof resource.logicalId !== 'string' || !resource.logicalId ||
    typeof resource.providerId !== 'string' || !resource.providerId ||
    typeof resource.name !== 'string' || !resource.name ||
    !['managed', 'adopted'].includes(resource.lifecycle) ||
    !Number.isInteger(resource.version) || resource.version < 1
  ) issues.push('backup.resource');
  const attributes = resource?.attributes;
  if (
    !attributes || typeof attributes.projectId !== 'string' || !attributes.projectId ||
    typeof attributes.sourceBranchId !== 'string' || !attributes.sourceBranchId ||
    !isDate(attributes.createdAt) ||
    (attributes.expiresAt !== '' && !isDate(attributes.expiresAt)) ||
    typeof attributes.manual !== 'boolean' ||
    !nonNegativeIntegerOrNull(attributes.fullSizeBytes) ||
    !nonNegativeIntegerOrNull(attributes.diffSizeBytes) ||
    attributes.migrationPlanId !== evidence?.migrationPlanId ||
    attributes.migrationPlanFingerprint !== evidence?.migrationPlanFingerprint ||
    !HEX256.test(attributes.snapshotPlanFingerprint || '') || attributes.restoreTested !== false
  ) issues.push('backup.resource.attributes');
  if (
    evidence?.verification?.providerVisible !== true || evidence?.verification?.exactIdentityMatch !== true ||
    evidence?.verification?.operationComplete !== true || evidence?.verification?.restoreTested !== false ||
    evidence?.verification?.rawSchemaPersisted !== false || evidence?.verification?.sqlExecuted !== false
  ) issues.push('verification');
  if (expected.project && evidence?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (evidence?.graphId !== expected.graph.id || evidence?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    evidence?.configurationId !== expected.configuration.id ||
    evidence?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  if (expected.migrationPlan && (
    evidence?.migrationPlanId !== expected.migrationPlan.id ||
    evidence?.migrationPlanFingerprint !== expected.migrationPlan.fingerprint
  )) issues.push('migrationPlan');
  if (expected.adapterPlan && (
    evidence?.adapterPlanId !== expected.adapterPlan.id ||
    evidence?.adapterPlanFingerprint !== expected.adapterPlan.fingerprint
  )) issues.push('adapterPlan');
  if (expected.facts && (
    stableStringify(evidence.schemaInspection) !== stableStringify(expected.facts.schemaInspection) ||
    stableStringify(evidence.backup) !== stableStringify(expected.facts.backup) ||
    stableStringify(evidence.verification) !== stableStringify(expected.facts.verification)
  )) issues.push('derivedEvidence');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Backup Evidence is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = backupEvidenceFingerprint(evidence);
  if (evidence.fingerprint !== actual || evidence.id !== `backup-evidence-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Backup Evidence fingerprint mismatch: ${evidence.id}`);
  }
  return evidence;
}

export function backupEvidenceFingerprint(evidence) {
  const value = structuredClone(evidence);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return fingerprint(value);
}

function loadContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const adapterPlan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: options.adapterPlanId,
  }).plan;
  if (!adapterPlan.configurationId || !adapterPlan.migrationPlanId) {
    throw operationError('CONFLICT', 'Backup Evidence requires an Adapter Plan bound to Launch Configuration and Database Migration Plan.');
  }
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: adapterPlan.configurationId,
  }).configuration;
  const migrationPlan = showDatabaseMigrationPlan({
    home, projectId: project.id, graphId: graph.id,
    configurationId: configuration.id, planId: adapterPlan.migrationPlanId,
  }).plan;
  return { home, project, graph, configuration, adapterPlan, migrationPlan };
}

function deriveBackupFacts(context) {
  const deployment = readExternalDeployment(context.home, context.project.id);
  const inspectState = deployment.state.nodes?.['database.inspect'];
  const backupState = deployment.state.nodes?.['database.backup'];
  const candidateState = deployment.state.nodes?.['candidate.deploy'];
  if (inspectState?.status !== 'succeeded' || backupState?.status !== 'succeeded' || candidateState?.status !== 'succeeded') {
    throw operationError('CONFLICT', 'Backup Evidence requires succeeded candidate.deploy, database.inspect, and database.backup nodes.');
  }
  const schemaAction = findAction(context.adapterPlan, 'neon-schema-inspect', 'database.inspect');
  const createAction = findAction(context.adapterPlan, 'neon-pre-migration-snapshot', 'database.backup');
  const verifyAction = findAction(context.adapterPlan, 'neon-snapshot-verify', 'database.backup');
  const schemaReceipts = readActionReceipts(context, inspectState.runId, schemaAction);
  const createReceipts = readActionReceipts(context, backupState.runId, createAction);
  const verifyReceipts = readActionReceipts(context, backupState.runId, verifyAction);
  const schemaReceipt = latestSuccessful(schemaReceipts, 'neon.schema.inspect');
  const createReceipt = createReceipts.find((receipt) =>
    receipt.phase === 'execute' && receipt.method === 'executeSnapshot' && receipt.result.data?.resource
  );
  const verifyReceipt = latestSuccessful(verifyReceipts, 'neon.snapshot.read');
  if (!schemaReceipt || !createReceipt || !verifyReceipt) {
    throw operationError('CONFLICT', 'Required immutable Schema, Snapshot Create, or Snapshot Verify receipts are missing.');
  }
  const operationReceipt = createReceipt.result.status === 'waiting-external'
    ? createReceipts.find((receipt) => receipt.phase === 'poll' && receipt.method === 'pollOperation' &&
        receipt.result.ok && receipt.result.status === 'succeeded')
    : null;
  if (createReceipt.result.status === 'waiting-external' && !operationReceipt) {
    throw operationError('CONFLICT', 'Neon Snapshot operation has not reached a verified terminal success state.');
  }
  const created = createReceipt.result.data.resource;
  const verified = verifyReceipt.result.data?.verifiedResource;
  if (
    verifyReceipt.result.data?.backupVerified !== true || !verified ||
    created.providerId !== verified.providerId || created.name !== verified.name ||
    created.attributes?.sourceBranchId !== verified.attributes?.sourceBranchId ||
    created.attributes?.migrationPlanFingerprint !== context.migrationPlan.fingerprint ||
    verified.attributes?.migrationPlanFingerprint !== context.migrationPlan.fingerprint
  ) throw operationError('CONFLICT', 'Snapshot Create and exact provider verification receipts do not identify the same Migration-bound backup.');
  const schema = schemaReceipt.result.data;
  if (
    schema.schemaInspected !== true || schema.rawSchemaPersisted !== false || schema.sqlExecuted !== false ||
    schema.projectId !== created.attributes?.projectId || schema.branchId !== created.attributes?.sourceBranchId
  ) throw operationError('CONFLICT', 'Schema Inspection does not match the Snapshot Project and source Branch.');
  return {
    schemaInspection: {
      receipt: receiptRef(schemaReceipt),
      schemaFingerprint: schema.schemaFingerprint,
      tableCount: schema.tableCount,
      columnCount: schema.columnCount,
      constraintCount: schema.constraintCount,
      observedAt: schema.observedAt,
    },
    backup: {
      resource: created,
      createReceipt: receiptRef(createReceipt),
      operationReceipt: operationReceipt ? receiptRef(operationReceipt) : null,
      verifyReceipt: receiptRef(verifyReceipt),
      verifiedAt: verifyReceipt.result.data.observedAt,
    },
    verification: {
      providerVisible: true,
      exactIdentityMatch: true,
      operationComplete: true,
      restoreTested: false,
      rawSchemaPersisted: false,
      sqlExecuted: false,
    },
  };
}

function readActionReceipts(context, runId, action) {
  if (!RUN_ID.test(runId || '')) throw operationError('VALIDATION_FAILED', `Adapter LaunchRun ID is invalid: ${runId || ''}`);
  const directory = path.join(projectPath(context.home, context.project.id), 'adapter-runs', runId, 'actions', action.actionId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^\d{6}-receipt\.json$/.test(name))
    .sort()
    .map((name) => readReceipt(path.join(directory, name), { ...context, runId, action }));
}

function readReceipt(file, expected) {
  const receipt = readJson(file, 'Adapter receipt');
  const issues = [];
  if (receipt?.kind !== 'AdapterActionReceipt' || receipt?.version !== 1) issues.push('kind|version');
  if (receipt?.projectId !== expected.project.id || receipt?.runId !== expected.runId) issues.push('ownership');
  if (receipt?.graphId !== expected.graph.id || receipt?.graphFingerprint !== expected.graph.fingerprint) issues.push('graph');
  if (receipt?.adapterPlanId !== expected.adapterPlan.id || receipt?.adapterPlanFingerprint !== expected.adapterPlan.fingerprint) issues.push('adapterPlan');
  if (receipt?.actionId !== expected.action.actionId || receipt?.nodeId !== expected.action.nodeId || receipt?.provider !== 'neon') issues.push('action');
  if (!Number.isInteger(receipt?.sequence) || receipt.sequence < 1 || receipt?.fingerprint !== fingerprintWithoutOwn(receipt)) issues.push('sequence|fingerprint');
  const intentFile = path.join(path.dirname(file), `${String(receipt?.sequence || 0).padStart(6, '0')}-intent.json`);
  const intent = readJson(intentFile, 'Adapter intent');
  if (
    intent?.kind !== 'AdapterMutationIntent' || intent?.version !== 1 ||
    intent?.projectId !== expected.project.id || intent?.runId !== expected.runId ||
    intent?.adapterPlanId !== expected.adapterPlan.id || intent?.adapterPlanFingerprint !== expected.adapterPlan.fingerprint ||
    intent?.actionId !== expected.action.actionId || intent?.nodeId !== expected.action.nodeId ||
    intent?.provider !== 'neon' || intent?.fingerprint !== fingerprintWithoutOwn(intent) ||
    receipt?.intentFingerprint !== intent?.fingerprint
  ) issues.push('intent');
  if (issues.length > 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Backup receipt integrity failed at ${issues.join(', ')}: ${file}`);
  validateActionResult(receipt.result, { appId: expected.graph.appId });
  return receipt;
}

function findAction(plan, actionId, nodeId) {
  const action = plan.actions.find((item) => item.actionId === actionId && item.nodeId === nodeId && item.provider === 'neon');
  if (!action) throw operationError('CONFLICT', `Migration Adapter Plan is missing required action: ${actionId}`);
  return action;
}

function latestSuccessful(receipts, operation) {
  return [...receipts].reverse().find((receipt) =>
    receipt.result.ok && receipt.result.status === 'succeeded' && receipt.result.operation === operation
  );
}

function receiptRef(receipt) {
  return {
    runId: receipt.runId,
    actionId: receipt.actionId,
    sequence: receipt.sequence,
    fingerprint: receipt.fingerprint,
  };
}

function validateReceiptRef(ref, label, issues) {
  validateExactKeys(ref, ['runId', 'actionId', 'sequence', 'fingerprint'], label, issues);
  if (
    !ref || !RUN_ID.test(ref.runId || '') || !ACTION_ID.test(ref.actionId || '') ||
    !Number.isInteger(ref.sequence) || ref.sequence < 1 || !SHA256.test(ref.fingerprint || '')
  ) issues.push(label);
}

function validateExactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) issues.push(`${label}.unsupported(${unexpected.sort().join('|')})`);
}

function readBackupEvidenceFile(file, context) {
  const evidence = readJson(file, 'Backup Evidence');
  return validateBackupEvidence(evidence, { ...context, facts: deriveBackupFacts(context) });
}

function backupEvidencePath(home, projectId, evidenceId) {
  if (!EVIDENCE_ID.test(evidenceId || '')) throw operationError('VALIDATION_FAILED', 'Backup Evidence ID is invalid.');
  return path.join(projectPath(home, projectId), 'backup-evidence', `${evidenceId}.json`);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `${label} JSON is missing or invalid: ${file}: ${error.message}`); }
}

function fingerprintWithoutOwn(value) {
  const clone = structuredClone(value);
  delete clone.fingerprint;
  return fingerprint(clone);
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }
function nonNegativeIntegerOrNull(value) { return value === null || nonNegativeInteger(value); }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
