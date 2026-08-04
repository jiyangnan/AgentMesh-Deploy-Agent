import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { readAdapterActionReceipt } from './adapter-graph-executor.js';
import { showBackupEvidence } from './backup-evidence.js';
import { readExternalDeployment } from './contracts-v2.js';
import { withControlLock } from './control-lock.js';
import { showDnsChangeSet } from './dns-change-set.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { showDatabaseMigrationPlan } from './migration-plan.js';
import {
  readProductVerificationEvidence,
  showProductVerificationPlan,
} from './product-verification.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue } from './provider-contract.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^rollback-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
const TOP_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'configurationId', 'configurationFingerprint', 'trigger', 'dns', 'release', 'database',
  'steps', 'status', 'blockers', 'createdAt',
];

export function createRollbackPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'rollback-plan-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    const deployment = readExternalDeployment(home, project.id);
    const trigger = deriveTrigger(home, project, graph, configuration, deployment.state);
    const dns = deriveDnsRollback(home, project, graph, configuration, deployment.state);
    const database = deriveDatabaseRollback(home, project, graph, configuration, deployment);
    const blockers = deriveBlockers(dns, database);
    const status = rollbackStatus(dns, blockers);
    const base = {
      schemaVersion: 1,
      kind: 'RollbackPlan',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      trigger,
      dns,
      release: {
        strategy: 'retain-candidate-and-restore-route',
        candidateResultRef: deployment.state.nodes?.['candidate.deploy']?.resultRef || '',
      },
      database,
      steps: buildSteps(dns, database, status),
      status,
      blockers,
      createdAt: options.now || nowIso(),
    };
    const fingerprint = rollbackPlanFingerprint(base);
    let plan = {
      ...base,
      id: `rollback-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateRollbackPlan(plan, { project, graph, configuration, trigger, dns, database });
    const directory = path.join(projectPath(home, project.id), 'rollback-plans');
    const planFile = path.join(directory, `${plan.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'rollback-plan.json');
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readRollbackPlanFile(planFile, { project, graph, configuration });
      if (existing.fingerprint !== plan.fingerprint) throw operationError('CONFLICT', `Rollback Plan ID collision: ${plan.id}`);
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    writeJsonAtomic(currentFile, plan);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'rollback-plan', operation: 'create', status: plan.status, home, projectId: project.id,
      plan, planFile, currentFile, reused, repositoryGuard, networkRequestsExecuted: 0,
      providerMutationsExecuted: 0, databaseMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function showRollbackPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
  }).configuration;
  const planFile = options.planId
    ? rollbackPlanPath(home, project.id, options.planId)
    : path.join(projectPath(home, project.id), 'rollback-plan.json');
  if (!fs.existsSync(planFile)) throw operationError('NOT_FOUND', `Rollback Plan not found: ${planFile}`);
  const plan = readRollbackPlanFile(planFile, { project, graph, configuration });
  return { kind: 'rollback-plan', operation: 'read', home, projectId: project.id, plan, planFile };
}

export function assertRollbackPlanCurrent(options) {
  const shown = showRollbackPlan(options);
  const home = shown.home;
  const project = readProjectRecord(home, shown.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: shown.plan.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: shown.plan.configurationId,
  }).configuration;
  const deployment = readExternalDeployment(home, project.id);
  const trigger = deriveTrigger(home, project, graph, configuration, deployment.state);
  const dns = deriveDnsRollback(home, project, graph, configuration, deployment.state);
  const database = deriveDatabaseRollback(home, project, graph, configuration, deployment);
  validateRollbackPlan(shown.plan, { project, graph, configuration, trigger, dns, database });
  return { ...shown, project, graph, configuration, deployment };
}

export function validateRollbackPlan(plan, expected = {}) {
  const issues = [];
  exactKeys(plan, TOP_KEYS, '$', issues);
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'RollbackPlan') issues.push('kind|schemaVersion');
  if (!PLAN_ID.test(plan?.id || '') || !SHA256.test(plan?.fingerprint || '')) issues.push('id|fingerprint');
  if (!isDate(plan?.createdAt)) issues.push('createdAt');
  if (expected.project && plan?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (plan?.graphId !== expected.graph.id || plan?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    plan?.configurationId !== expected.configuration.id ||
    plan?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  validateTrigger(plan?.trigger, issues);
  validateDns(plan?.dns, issues);
  validateRelease(plan?.release, issues);
  validateDatabase(plan?.database, issues);
  validateBlockers(plan?.blockers, issues);
  validateSteps(plan?.steps, plan?.dns, plan?.database, plan?.status, issues);
  const semanticStatus = rollbackStatus(plan?.dns || {}, plan?.blockers || []);
  if (plan?.status !== semanticStatus) issues.push('status(semantic)');
  if (expected.trigger && stableStringify(plan?.trigger) !== stableStringify(expected.trigger)) issues.push('trigger(binding)');
  if (expected.dns && stableStringify(plan?.dns) !== stableStringify(expected.dns)) issues.push('dns(binding)');
  if (expected.database && stableStringify(plan?.database) !== stableStringify(expected.database)) issues.push('database(binding)');
  if (containsSecretLikeValue(plan)) issues.push('secret-like-value');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Rollback Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = rollbackPlanFingerprint(plan);
  if (plan.fingerprint !== actual || plan.id !== `rollback-plan-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Plan fingerprint mismatch: ${plan.id}`);
  }
  return plan;
}

export function rollbackPlanFingerprint(plan) {
  const value = structuredClone(plan);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function deriveTrigger(home, project, graph, configuration, state) {
  const node = state.nodes?.['product.verify'];
  if (!node?.resultRef || node.graphId !== graph.id || node.resultData?.evidenceKind !== 'ProductVerificationEvidence') {
    throw operationError('VERIFICATION_FAILED', 'Rollback planning requires Product Verification Evidence for the current Graph.');
  }
  const file = path.resolve(node.resultRef);
  assertInside(file, path.join(projectPath(home, project.id), 'evidence', 'product-verification'), 'Product Verification Evidence');
  const verificationPlan = showProductVerificationPlan({
    home, projectId: project.id, graphId: graph.id, configurationId: configuration.id,
    planId: node.resultData.planId,
  }).plan;
  const evidence = readProductVerificationEvidence(file, { project, graph, configuration, plan: verificationPlan });
  if (evidence.phase !== 'production' || evidence.status !== 'failed' ||
    node.resultData.fingerprint !== evidence.fingerprint || node.resultData.planFingerprint !== verificationPlan.fingerprint) {
    throw operationError('CONFLICT', 'Rollback planning requires a current failed production Product Verification result.');
  }
  return {
    nodeId: 'product.verify',
    verificationPlanId: verificationPlan.id,
    verificationPlanFingerprint: verificationPlan.fingerprint,
    evidenceId: evidence.id,
    evidenceFingerprint: evidence.fingerprint,
    status: 'failed',
    targetUrl: evidence.target.url,
  };
}

function deriveDnsRollback(home, project, graph, configuration, state) {
  const node = state.nodes?.['production.dns.apply'];
  if (node?.status !== 'succeeded' || node.graphId !== graph.id || !node.resultRef || !node.adapterPlanId || !node.runId) {
    throw operationError('CONFLICT', 'Rollback planning requires a succeeded current-Graph production DNS apply receipt.');
  }
  const adapterPlan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: node.adapterPlanId,
  }).plan;
  const action = adapterPlan.actions.find((item) => item.actionId === 'cloudflare-dns-change-set' && item.nodeId === 'production.dns.apply');
  if (!action) throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS Adapter Plan does not contain the expected Cloudflare action.');
  const receiptFile = path.resolve(node.resultRef);
  assertInside(receiptFile, path.join(projectPath(home, project.id), 'adapter-runs'), 'DNS Apply Receipt');
  const receipt = readAdapterActionReceipt(receiptFile, {
    projectId: project.id, runId: node.runId, plan: adapterPlan, action,
  });
  if (!receipt.result?.ok || receipt.result.status !== 'succeeded' || receipt.method !== action.executeMethod) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS Apply Receipt is not a successful execute result.');
  }
  const data = receipt.result.data || {};
  const changeSet = showDnsChangeSet({
    home, projectId: project.id, graphId: graph.id, configurationId: configuration.id,
    changeSetId: data.changeSetId,
  }).changeSet;
  if (data.changeSetFingerprint !== changeSet.fingerprint || adapterPlan.dnsChangeSetId !== changeSet.id ||
    adapterPlan.dnsChangeSetFingerprint !== changeSet.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS Apply Receipt does not match the immutable DNS ChangeSet.');
  }
  const desired = changeSet.records.find((record) => record.purpose === 'web');
  const before = data.before?.find((item) => item.desiredId === desired?.id);
  const applied = data.applied?.find((item) => item.desiredId === desired?.id);
  if (!desired || !before || !applied || !Array.isArray(before.records) || before.records.length > 1 ||
    !['unchanged', 'create', 'update'].includes(applied.mode)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS Apply Receipt does not contain an unambiguous Web before/applied pair.');
  }
  const desiredRecord = normalizeRecord(desired);
  const appliedRecord = {
    desiredId: applied.desiredId,
    mode: applied.mode,
    record: normalizeRecord(applied.record),
  };
  const beforeRecords = before.records.map(normalizeRecord);
  if (!sameDnsValue(desiredRecord, appliedRecord.record)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS Apply Receipt applied record differs from the desired Web record.');
  }
  const strategy = applied.mode === 'update' && beforeRecords.length === 1
    ? 'restore-exact'
    : (applied.mode === 'create' && beforeRecords.length === 0 ? 'manual-remove-new-record' : 'no-change');
  return {
    provider: 'cloudflare',
    connectionId: action.connectionId,
    strategy,
    zoneId: String(data.zoneId || ''),
    changeSetId: changeSet.id,
    changeSetFingerprint: changeSet.fingerprint,
    applyReceipt: {
      runId: receipt.runId,
      actionId: receipt.actionId,
      sequence: receipt.sequence,
      fingerprint: receipt.fingerprint,
    },
    desiredRecord,
    appliedRecord,
    beforeRecords,
  };
}

function deriveDatabaseRollback(home, project, graph, configuration, deployment) {
  if (!deployment.manifest.requirements?.database) return emptyDatabase();
  const node = deployment.state.nodes?.['database.migrate'];
  if (node?.status !== 'succeeded' || node.graphId !== graph.id) return emptyDatabase();
  if (!node.resultRef || !node.adapterPlanId || !node.runId) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Succeeded Database Migration State is missing its Adapter Plan, Run, or Receipt binding.');
  }
  const adapterPlan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: node.adapterPlanId,
  }).plan;
  const action = adapterPlan.actions.find((item) =>
    item.nodeId === 'database.migrate' && item.executeMethod === 'executeMigration'
  );
  if (!action || action.provider !== configuration.database.provider) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Migration Adapter Plan does not contain the expected database execute action.');
  }
  const receiptFile = path.resolve(node.resultRef);
  assertInside(receiptFile, path.join(projectPath(home, project.id), 'adapter-runs'), 'Database Migration Receipt');
  const receipt = readAdapterActionReceipt(receiptFile, {
    projectId: project.id, runId: node.runId, plan: adapterPlan, action,
  });
  if (!receipt.result?.ok || receipt.result.status !== 'succeeded' || receipt.method !== action.executeMethod) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Migration Receipt is not a successful execute result.');
  }
  const receiptResource = receipt.result.data?.resource;
  if (!receiptResource?.attributes ||
    stableStringify(receiptResource) !== stableStringify(node.resultData?.resource)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Migration State differs from its immutable execute Receipt.');
  }
  const attributes = receiptResource.attributes;
  if (!attributes.migrationPlanId || !attributes.migrationPlanFingerprint) {
    return {
      required: true,
      provider: configuration.database.provider,
      strategy: 'manual-review',
      migrationPlanId: '', migrationPlanFingerprint: '', backupEvidenceId: '', backupEvidenceFingerprint: '',
    };
  }
  const migrationPlan = showDatabaseMigrationPlan({
    home, projectId: project.id, graphId: graph.id, configurationId: configuration.id,
    planId: attributes.migrationPlanId,
  }).plan;
  if (migrationPlan.fingerprint !== attributes.migrationPlanFingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Migration State does not match the immutable Migration Plan.');
  }
  const base = {
    required: true,
    provider: configuration.database.provider,
    migrationPlanId: migrationPlan.id,
    migrationPlanFingerprint: migrationPlan.fingerprint,
    backupEvidenceId: String(attributes.backupEvidenceId || ''),
    backupEvidenceFingerprint: String(attributes.backupEvidenceFingerprint || ''),
  };
  if (migrationPlan.summary.classification === 'additive') return { ...base, strategy: 'retain-additive' };
  if (!base.backupEvidenceId || !base.backupEvidenceFingerprint || !node.adapterPlanId) {
    return { ...base, strategy: 'manual-review' };
  }
  const backup = showBackupEvidence({
    home, projectId: project.id, graphId: graph.id, evidenceId: base.backupEvidenceId,
  }).evidence;
  if (backup.fingerprint !== base.backupEvidenceFingerprint || backup.migrationPlanId !== migrationPlan.id) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Backup Evidence does not match Migration State.');
  }
  return {
    ...base,
    strategy: migrationPlan.summary.classification === 'reversible' ? 'apply-down' : 'restore-backup',
  };
}

function deriveBlockers(dns, database) {
  const blockers = [];
  if (dns.strategy === 'manual-remove-new-record') blockers.push({
    code: 'DNS_DELETE_REQUIRES_HUMAN', scope: 'dns.restore',
    message: 'The failed release created a new Web record; automatic DNS DELETE remains disabled.',
  });
  if (dns.strategy === 'no-change') blockers.push({
    code: 'DNS_PREVIOUS_TARGET_UNAVAILABLE', scope: 'dns.restore',
    message: 'The DNS apply receipt did not capture a distinct previous Web target to restore.',
  });
  if (database.strategy === 'manual-review') blockers.push({
    code: 'DATABASE_ROLLBACK_EVIDENCE_INCOMPLETE', scope: 'database.rollback',
    message: 'Database rollback ownership or backup evidence is incomplete and requires human review.',
  });
  return blockers;
}

function buildSteps(dns, database, status) {
  const dnsReady = dns.strategy === 'restore-exact';
  const databaseOperation = database.strategy === 'apply-down'
    ? 'apply-down'
    : (database.strategy === 'restore-backup' ? 'restore-backup' : 'retain');
  const databaseBlocked = database.strategy === 'manual-review';
  return [{
    id: 'dns.restore', operation: 'restore', risk: 'provider-mutation',
    status: dnsReady ? 'ready' : 'blocked', dependsOn: [], approval: 'rollback-dns',
  }, {
    id: 'release.retain', operation: 'retain', risk: 'read-only', status: 'not-required',
    dependsOn: ['dns.restore'], approval: null,
  }, {
    id: 'database.rollback', operation: databaseOperation,
    risk: ['apply-down', 'restore-backup'].includes(databaseOperation) ? 'destructive' : 'read-only',
    status: databaseBlocked ? 'blocked' : (['apply-down', 'restore-backup'].includes(databaseOperation) ? 'ready' : 'not-required'),
    dependsOn: ['dns.restore'],
    approval: ['apply-down', 'restore-backup'].includes(databaseOperation) ? 'rollback-database' : null,
  }, {
    id: 'verification.repeat', operation: 'verify', risk: 'read-only',
    status: status === 'ready' ? 'ready' : 'blocked', dependsOn: ['dns.restore', 'database.rollback'], approval: null,
  }];
}

function rollbackStatus(dns, blockers) {
  if (blockers.length === 0 && dns.strategy === 'restore-exact') return 'ready';
  if (dns.strategy === 'restore-exact') return 'partially-ready';
  return 'blocked';
}

function validateTrigger(value, issues) {
  exactKeys(value, [
    'nodeId', 'verificationPlanId', 'verificationPlanFingerprint', 'evidenceId',
    'evidenceFingerprint', 'status', 'targetUrl',
  ], 'trigger', issues);
  if (value?.nodeId !== 'product.verify' || value?.status !== 'failed' || !SHA256.test(value?.verificationPlanFingerprint || '') ||
    !SHA256.test(value?.evidenceFingerprint || '') || !/^verification-plan-[a-f0-9]{24}$/.test(value?.verificationPlanId || '') ||
    !/^product-verification-[a-f0-9]{24}$/.test(value?.evidenceId || '') || !validHttps(value?.targetUrl)) issues.push('trigger');
}

function validateDns(value, issues) {
  exactKeys(value, [
    'provider', 'connectionId', 'strategy', 'zoneId', 'changeSetId', 'changeSetFingerprint', 'applyReceipt',
    'desiredRecord', 'appliedRecord', 'beforeRecords',
  ], 'dns', issues);
  if (value?.provider !== 'cloudflare' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value?.connectionId || '') ||
    !['restore-exact', 'manual-remove-new-record', 'no-change'].includes(value?.strategy) ||
    !value?.zoneId || !/^dns-change-[a-f0-9]{24}$/.test(value?.changeSetId || '') || !SHA256.test(value?.changeSetFingerprint || '')) issues.push('dns');
  validateReceiptRef(value?.applyReceipt, issues);
  validateRecord(value?.desiredRecord, 'dns.desiredRecord', issues);
  exactKeys(value?.appliedRecord, ['desiredId', 'mode', 'record'], 'dns.appliedRecord', issues);
  if (value?.appliedRecord?.desiredId !== value?.desiredRecord?.id || !['unchanged', 'create', 'update'].includes(value?.appliedRecord?.mode)) issues.push('dns.appliedRecord');
  validateRecord(value?.appliedRecord?.record, 'dns.appliedRecord.record', issues);
  if (!sameDnsValue(value?.desiredRecord, value?.appliedRecord?.record)) issues.push('dns.appliedRecord.value');
  if (!Array.isArray(value?.beforeRecords) || value.beforeRecords.length > 1) issues.push('dns.beforeRecords');
  for (const record of value?.beforeRecords || []) validateRecord(record, 'dns.beforeRecords', issues);
  if (value?.strategy === 'restore-exact' && !(value.beforeRecords?.length === 1 && value.appliedRecord?.mode === 'update')) issues.push('dns.strategy');
  if (value?.strategy === 'manual-remove-new-record' && !(value.beforeRecords?.length === 0 && value.appliedRecord?.mode === 'create')) issues.push('dns.strategy');
  if (value?.strategy === 'no-change' && value.appliedRecord?.mode !== 'unchanged') issues.push('dns.strategy');
}

function validateReceiptRef(value, issues) {
  exactKeys(value, ['runId', 'actionId', 'sequence', 'fingerprint'], 'dns.applyReceipt', issues);
  if (!value?.runId || value?.actionId !== 'cloudflare-dns-change-set' || !Number.isInteger(value?.sequence) || value.sequence < 1 ||
    !SHA256.test(value?.fingerprint || '')) issues.push('dns.applyReceipt');
}

function validateRelease(value, issues) {
  exactKeys(value, ['strategy', 'candidateResultRef'], 'release', issues);
  if (value?.strategy !== 'retain-candidate-and-restore-route' || typeof value?.candidateResultRef !== 'string' || !value.candidateResultRef) issues.push('release');
}

function validateDatabase(value, issues) {
  exactKeys(value, [
    'required', 'provider', 'strategy', 'migrationPlanId', 'migrationPlanFingerprint',
    'backupEvidenceId', 'backupEvidenceFingerprint',
  ], 'database', issues);
  if (typeof value?.required !== 'boolean' || typeof value?.provider !== 'string' ||
    !['not-required', 'retain-additive', 'apply-down', 'restore-backup', 'manual-review'].includes(value?.strategy)) issues.push('database');
  if (!value?.required && (value?.strategy !== 'not-required' || value.provider || value.migrationPlanId || value.backupEvidenceId)) issues.push('database.notRequired');
  if (['retain-additive', 'apply-down', 'restore-backup'].includes(value?.strategy) &&
    (!/^migration-plan-[a-f0-9]{24}$/.test(value?.migrationPlanId || '') || !SHA256.test(value?.migrationPlanFingerprint || ''))) issues.push('database.migration');
  if (value?.strategy === 'restore-backup' &&
    (!/^backup-evidence-[a-f0-9]{24}$/.test(value?.backupEvidenceId || '') || !SHA256.test(value?.backupEvidenceFingerprint || ''))) issues.push('database.backup');
}

function validateBlockers(value, issues) {
  if (!Array.isArray(value) || value.length > 16) { issues.push('blockers'); return; }
  const keys = new Set();
  for (const blocker of value) {
    exactKeys(blocker, ['code', 'scope', 'message'], 'blockers.item', issues);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(blocker?.code || '') || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(blocker?.scope || '') ||
      typeof blocker?.message !== 'string' || !blocker.message || blocker.message.length > 512 || keys.has(`${blocker.code}:${blocker.scope}`)) issues.push('blockers.item');
    keys.add(`${blocker?.code}:${blocker?.scope}`);
  }
}

function validateSteps(value, dns, database, status, issues) {
  if (!Array.isArray(value) || value.length !== 4) { issues.push('steps'); return; }
  const expected = buildSteps(dns, database, status);
  if (stableStringify(value) !== stableStringify(expected)) issues.push('steps(semantic)');
}

function validateRecord(value, label, issues) {
  exactKeys(value, ['id', 'type', 'name', 'content', 'ttl', 'proxied', 'priority'], label, issues);
  if (!value?.id || !RECORD_TYPES.has(value?.type) || !value?.name || typeof value?.content !== 'string' || !value.content ||
    value.content.length > 2048 || !Number.isInteger(value?.ttl) || value.ttl < 1 || typeof value?.proxied !== 'boolean' ||
    (value.type === 'MX' ? !Number.isInteger(value.priority) : value.priority !== null)) issues.push(label);
}

function normalizeRecord(record) {
  const value = {
    id: String(record?.id || ''),
    type: String(record?.type || '').toUpperCase(),
    name: String(record?.name || '').toLowerCase(),
    content: String(record?.content || ''),
    ttl: Number(record?.ttl || 1),
    proxied: Boolean(record?.proxied),
    priority: record?.priority === undefined || record?.priority === null ? null : Number(record.priority),
  };
  const issues = [];
  validateRecord(value, 'record', issues);
  if (issues.length > 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS rollback record is invalid.');
  return value;
}

function sameDnsValue(left, right) {
  return left?.type === right?.type && left?.name === right?.name &&
    normalizeContent(left?.content, left?.type) === normalizeContent(right?.content, right?.type) &&
    Boolean(left?.proxied) === Boolean(right?.proxied) &&
    (left?.type !== 'MX' || Number(left?.priority) === Number(right?.priority));
}

function normalizeContent(value, type) {
  const text = String(value || '').trim();
  return ['CNAME', 'MX'].includes(type) ? text.replace(/\.$/, '').toLowerCase() : text;
}

function emptyDatabase() {
  return {
    required: false, provider: '', strategy: 'not-required', migrationPlanId: '',
    migrationPlanFingerprint: '', backupEvidenceId: '', backupEvidenceFingerprint: '',
  };
}

function readRollbackPlanFile(file, expected) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Plan JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateRollbackPlan(plan, expected); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Plan failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
}

function rollbackPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Rollback Plan ID is invalid.');
  return path.join(projectPath(home, projectId), 'rollback-plans', `${planId}.json`);
}

function assertInside(file, root, label) {
  if (!(file === root || file.startsWith(`${root}${path.sep}`))) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `${label} is outside this project control workspace.`);
  }
}

function exactKeys(value, keys, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  if (stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) issues.push(`${label}(fields)`);
}

function validHttps(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'rollback plan error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
