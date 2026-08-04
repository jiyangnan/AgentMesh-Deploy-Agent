import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { listConnections } from './connection-service.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchGraph } from './launch-service.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showDnsChangeSet } from './dns-change-set.js';
import { showDatabaseMigrationPlan } from './migration-plan.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^adapter-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONNECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const BINDING_DESTINATION = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const BINDING_SOURCE_PATH = /^data(?:\.[A-Za-z0-9_-]+)+$/;
const SECRET_REF = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+)$/;
const RESERVED_INPUT_KEYS = new Set([
  'appId', 'requestId', 'execute', 'yes', 'allowProviderMutations', 'allowCostMutations',
  'allowProviderDeletes', 'allowSecretRead', 'approvalFingerprint', 'planFingerprint',
  'allowDatabaseMigration',
]);
const PROVIDER_METHODS = Object.freeze({
  github: new Set([
    'readRepositoryCommit',
  ]),
  cloudflare: new Set([
    'readZone', 'ensureZone', 'planDnsChangeSet', 'executeDnsChangeSet',
  ]),
  vercel: new Set([
    'readProject', 'ensureProject', 'planCandidateDeployment', 'executeCandidateDeployment', 'pollDeployment',
  ]),
  railway: new Set([
    'readProjectTokenScope', 'readProject', 'ensureProject', 'ensureEnvironment', 'ensureService', 'ensureServiceDomain',
    'planVariables', 'executeVariablePlan', 'planCandidateDeployment', 'executeCandidateDeployment', 'pollDeployment',
  ]),
  resend: new Set([
    'readDomain', 'ensureDomain', 'planVerification', 'executeVerification', 'pollDomain',
    'planSendingKey', 'executeSendingKey',
  ]),
  neon: new Set([
    'readProject', 'planProject', 'executeProject', 'planConnectionCapture', 'executeConnectionCapture',
    'readBranch', 'readBranchByName', 'readBranchCatalog', 'inspectSchema', 'planBranch', 'executeBranch', 'readSnapshotCatalog', 'readSnapshot',
    'planSnapshot', 'executeSnapshot', 'pollOperation',
    'planMigration', 'executeMigration',
  ]),
  supabase: new Set([
    'readOrganization', 'readProject', 'planProject', 'executeProject', 'pollProject',
    'planConnectionCapture', 'executeConnectionCapture', 'planRuntimeCredentials',
    'executeRuntimeCredentials', 'readProjectCatalog',
  ]),
});
const METHOD_CONTRACTS = Object.freeze({
  github: Object.freeze({
    readRepositoryCommit: contract('call', [['verify', 'source.repository']]),
  }),
  cloudflare: Object.freeze({
    readZone: contract('call', [['ensure', 'dns.zone']]),
    ensureZone: contract('call', [['ensure', 'dns.zone']]),
    planDnsChangeSet: contract('plan', [['update', 'dns.records']], 'dns-change-set'),
    executeDnsChangeSet: contract('execute', [['update', 'dns.records']], 'dns-change-set'),
  }),
  vercel: Object.freeze({
    readProject: contract('call', [['ensure', 'runtime.project']]),
    ensureProject: contract('call', [['ensure', 'runtime.project']]),
    planCandidateDeployment: contract('plan', [['deploy', 'runtime.deployment']], 'candidate-deployment'),
    executeCandidateDeployment: contract('execute', [['deploy', 'runtime.deployment']], 'candidate-deployment'),
    pollDeployment: contract('poll', [['deploy', 'runtime.deployment']]),
  }),
  railway: Object.freeze({
    readProjectTokenScope: contract('call', [['ensure', 'runtime.project']]),
    readProject: contract('call', [['ensure', 'runtime.project']]),
    ensureProject: contract('call', [['ensure', 'runtime.project']]),
    ensureEnvironment: contract('call', [['ensure', 'runtime.project']]),
    ensureService: contract('call', [['ensure', 'runtime.project']]),
    ensureServiceDomain: contract('call', [['ensure', 'runtime.project']]),
    planVariables: contract('plan', [['ensure', 'runtime.project']], 'runtime-variables'),
    executeVariablePlan: contract('execute', [['ensure', 'runtime.project']], 'runtime-variables'),
    planCandidateDeployment: contract('plan', [['deploy', 'runtime.deployment']], 'candidate-deployment'),
    executeCandidateDeployment: contract('execute', [['deploy', 'runtime.deployment']], 'candidate-deployment'),
    pollDeployment: contract('poll', [['deploy', 'runtime.deployment']]),
  }),
  resend: Object.freeze({
    readDomain: contract('call', [['ensure', 'email.domain'], ['verify', 'email.domain']]),
    ensureDomain: contract('call', [['ensure', 'email.domain']]),
    planVerification: contract('plan', [['verify', 'email.domain']], 'domain-verification'),
    executeVerification: contract('execute', [['verify', 'email.domain']], 'domain-verification'),
    pollDomain: contract('poll', [['verify', 'email.domain']]),
    planSendingKey: contract('plan', [['ensure', 'email.domain']], 'sending-key'),
    executeSendingKey: contract('execute', [['ensure', 'email.domain']], 'sending-key'),
  }),
  neon: Object.freeze({
    readProject: contract('call', [['ensure', 'database.project']]),
    planProject: contract('plan', [['ensure', 'database.project']], 'database-project'),
    executeProject: contract('execute', [['ensure', 'database.project']], 'database-project'),
    planConnectionCapture: contract('plan', [['ensure', 'database.project']], 'connection-capture'),
    executeConnectionCapture: contract('execute', [['ensure', 'database.project']], 'connection-capture'),
    readBranch: contract('call', [['ensure', 'database.project']]),
    readBranchByName: contract('call', [['inspect', 'database.schema']]),
    readBranchCatalog: contract('call', [['ensure', 'database.project']]),
    inspectSchema: contract('call', [['inspect', 'database.schema']]),
    planBranch: contract('plan', [['ensure', 'database.project']], 'database-branch'),
    executeBranch: contract('execute', [['ensure', 'database.project']], 'database-branch'),
    readSnapshotCatalog: contract('call', [['backup', 'database.backup']]),
    readSnapshot: contract('call', [['backup', 'database.backup']]),
    planSnapshot: contract('plan', [['backup', 'database.backup']], 'database-backup'),
    executeSnapshot: contract('execute', [['backup', 'database.backup']], 'database-backup'),
    pollOperation: contract('poll', [['ensure', 'database.project'], ['backup', 'database.backup']]),
    planMigration: contract('plan', [['migrate', 'database.schema']], 'database-migration'),
    executeMigration: contract('execute', [['migrate', 'database.schema']], 'database-migration'),
  }),
  supabase: Object.freeze({
    readOrganization: contract('call', [['ensure', 'database.project']]),
    readProject: contract('call', [['ensure', 'database.project']]),
    planProject: contract('plan', [['ensure', 'database.project']], 'database-project'),
    executeProject: contract('execute', [['ensure', 'database.project']], 'database-project'),
    pollProject: contract('poll', [['ensure', 'database.project']]),
    planConnectionCapture: contract('plan', [['ensure', 'database.project']], 'connection-capture'),
    executeConnectionCapture: contract('execute', [['ensure', 'database.project']], 'connection-capture'),
    planRuntimeCredentials: contract('plan', [['ensure', 'database.project']], 'runtime-credentials'),
    executeRuntimeCredentials: contract('execute', [['ensure', 'database.project']], 'runtime-credentials'),
    readProjectCatalog: contract('call', [['ensure', 'database.project']]),
  }),
});

export function createAdapterExecutionPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'adapter-plan-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const connections = listConnections({ home, projectId: project.id }).connections;
    const actions = structuredClone(options.actions || []);
    const base = {
      schemaVersion: 1,
      kind: 'AdapterExecutionPlan',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      ...(options.configuration ? {
        configurationId: options.configuration.id,
        configurationFingerprint: options.configuration.fingerprint,
      } : {}),
      ...(options.dnsChangeSet ? {
        dnsChangeSetId: options.dnsChangeSet.id,
        dnsChangeSetFingerprint: options.dnsChangeSet.fingerprint,
      } : {}),
      ...(options.migrationPlan ? {
        migrationPlanId: options.migrationPlan.id,
        migrationPlanFingerprint: options.migrationPlan.fingerprint,
      } : {}),
      ...(options.backupEvidence ? {
        backupEvidenceId: options.backupEvidence.id,
        backupEvidenceFingerprint: options.backupEvidence.fingerprint,
      } : {}),
      actions,
      createdAt: options.now || nowIso(),
    };
    const fingerprint = adapterExecutionPlanFingerprint(base);
    let plan = {
      ...base,
      id: `adapter-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateAdapterExecutionPlan(plan, {
      projectId: project.id, graph, connections,
      ...(options.configuration ? { configuration: options.configuration } : {}),
      ...(options.dnsChangeSet ? { dnsChangeSet: options.dnsChangeSet } : {}),
      ...(options.migrationPlan ? { migrationPlan: options.migrationPlan } : {}),
      ...(options.backupEvidence ? { backupEvidence: options.backupEvidence } : {}),
    });
    const directory = path.join(projectPath(home, project.id), 'adapter-plans');
    const planFile = path.join(directory, `${plan.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'adapter-plan.json');
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readAdapterExecutionPlanFile(planFile, { projectId: project.id, graph, connections });
      if (existing.fingerprint !== plan.fingerprint) throw operationError('CONFLICT', `Adapter Execution Plan ID collision: ${plan.id}`);
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    writeJsonAtomic(currentFile, plan);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'adapter-execution-plan',
      operation: 'create',
      status: 'succeeded',
      home,
      projectId: project.id,
      plan,
      planFile,
      currentFile,
      reused,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function showAdapterExecutionPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const connections = listConnections({ home, projectId: project.id }).connections;
  const file = options.planId
    ? adapterExecutionPlanPath(home, project.id, options.planId)
    : path.join(projectPath(home, project.id), 'adapter-plan.json');
  if (!fs.existsSync(file)) throw operationError('NOT_FOUND', `Adapter Execution Plan not found: ${file}`);
  let plan = readAdapterExecutionPlanFile(file, { projectId: project.id, graph, connections });
  if (plan.configurationId) {
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: plan.configurationId,
    }).configuration;
    plan = validateAdapterExecutionPlan(plan, { projectId: project.id, graph, connections, configuration });
    if (plan.dnsChangeSetId) {
      const dnsChangeSet = showDnsChangeSet({
        home, projectId: project.id, graphId: graph.id,
        configurationId: configuration.id, changeSetId: plan.dnsChangeSetId,
      }).changeSet;
      plan = validateAdapterExecutionPlan(plan, { projectId: project.id, graph, connections, configuration, dnsChangeSet });
    }
    if (plan.migrationPlanId) {
      const migrationPlan = showDatabaseMigrationPlan({
        home, projectId: project.id, graphId: graph.id,
        configurationId: configuration.id, planId: plan.migrationPlanId,
      }).plan;
      plan = validateAdapterExecutionPlan(plan, { projectId: project.id, graph, connections, configuration, migrationPlan });
    }
  }
  return { kind: 'adapter-execution-plan', operation: 'read', home, projectId: project.id, plan, planFile: file };
}

export function validateAdapterExecutionPlan(plan, expected = {}) {
  const issues = [];
  if (plan?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (plan?.kind !== 'AdapterExecutionPlan') issues.push('$.kind');
  if (!PLAN_ID.test(plan?.id || '')) issues.push('$.id');
  if (!SHA256.test(plan?.fingerprint || '')) issues.push('$.fingerprint');
  if (typeof plan?.projectId !== 'string' || !plan.projectId) issues.push('$.projectId');
  if (expected.projectId && plan?.projectId !== expected.projectId) issues.push('$.projectId');
  if (typeof plan?.graphId !== 'string' || !plan.graphId) issues.push('$.graphId');
  if (!SHA256.test(plan?.graphFingerprint || '')) issues.push('$.graphFingerprint');
  if ((plan?.configurationId === undefined) !== (plan?.configurationFingerprint === undefined)) {
    issues.push('$.configurationId|configurationFingerprint');
  }
  if (plan?.configurationId !== undefined && !/^launch-config-[a-f0-9]{24}$/.test(plan.configurationId)) {
    issues.push('$.configurationId');
  }
  if (plan?.configurationFingerprint !== undefined && !SHA256.test(plan.configurationFingerprint)) {
    issues.push('$.configurationFingerprint');
  }
  if (expected.configuration && (
    plan?.configurationId !== expected.configuration.id ||
    plan?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('$.configurationId|configurationFingerprint');
  if ((plan?.dnsChangeSetId === undefined) !== (plan?.dnsChangeSetFingerprint === undefined)) {
    issues.push('$.dnsChangeSetId|dnsChangeSetFingerprint');
  }
  if (plan?.dnsChangeSetId !== undefined && plan?.configurationId === undefined) issues.push('$.configurationId(required-by-dnsChangeSet)');
  if (plan?.dnsChangeSetId !== undefined && !/^dns-change-[a-f0-9]{24}$/.test(plan.dnsChangeSetId)) issues.push('$.dnsChangeSetId');
  if (plan?.dnsChangeSetFingerprint !== undefined && !SHA256.test(plan.dnsChangeSetFingerprint)) issues.push('$.dnsChangeSetFingerprint');
  if (expected.dnsChangeSet && (
    plan?.dnsChangeSetId !== expected.dnsChangeSet.id ||
    plan?.dnsChangeSetFingerprint !== expected.dnsChangeSet.fingerprint
  )) issues.push('$.dnsChangeSetId|dnsChangeSetFingerprint');
  if ((plan?.migrationPlanId === undefined) !== (plan?.migrationPlanFingerprint === undefined)) {
    issues.push('$.migrationPlanId|migrationPlanFingerprint');
  }
  if (plan?.migrationPlanId !== undefined && plan?.configurationId === undefined) {
    issues.push('$.configurationId(required-by-migrationPlan)');
  }
  if (plan?.migrationPlanId !== undefined && !/^migration-plan-[a-f0-9]{24}$/.test(plan.migrationPlanId)) {
    issues.push('$.migrationPlanId');
  }
  if (plan?.migrationPlanFingerprint !== undefined && !SHA256.test(plan.migrationPlanFingerprint)) {
    issues.push('$.migrationPlanFingerprint');
  }
  if (expected.migrationPlan && (
    plan?.migrationPlanId !== expected.migrationPlan.id ||
    plan?.migrationPlanFingerprint !== expected.migrationPlan.fingerprint
  )) issues.push('$.migrationPlanId|migrationPlanFingerprint');
  if ((plan?.backupEvidenceId === undefined) !== (plan?.backupEvidenceFingerprint === undefined)) {
    issues.push('$.backupEvidenceId|backupEvidenceFingerprint');
  }
  if (plan?.backupEvidenceId !== undefined && plan?.migrationPlanId === undefined) {
    issues.push('$.migrationPlanId(required-by-backupEvidence)');
  }
  if (plan?.backupEvidenceId !== undefined && !/^backup-evidence-[a-f0-9]{24}$/.test(plan.backupEvidenceId)) {
    issues.push('$.backupEvidenceId');
  }
  if (plan?.backupEvidenceFingerprint !== undefined && !SHA256.test(plan.backupEvidenceFingerprint)) {
    issues.push('$.backupEvidenceFingerprint');
  }
  if (expected.backupEvidence && (
    plan?.backupEvidenceId !== expected.backupEvidence.id ||
    plan?.backupEvidenceFingerprint !== expected.backupEvidence.fingerprint ||
    expected.backupEvidence.migrationPlanId !== plan?.migrationPlanId ||
    expected.backupEvidence.migrationPlanFingerprint !== plan?.migrationPlanFingerprint
  )) issues.push('$.backupEvidenceId|backupEvidenceFingerprint');
  if (!Array.isArray(plan?.actions) || plan.actions.length === 0) issues.push('$.actions');
  if (typeof plan?.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt))) issues.push('$.createdAt');
  const graphNodes = new Map((expected.graph?.nodes || []).map((node) => [node.id, node]));
  const connections = new Map((expected.connections || []).map((connection) => [connection.id, connection]));
  const actionIndexById = new Map();
  for (const [index, action] of (plan?.actions || []).entries()) {
    if (ACTION_ID.test(action?.actionId || '') && !actionIndexById.has(action.actionId)) actionIndexById.set(action.actionId, index);
  }
  const actionIds = new Set();
  for (const [index, action] of (plan?.actions || []).entries()) {
    const prefix = `$.actions[${index}]`;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      issues.push(prefix);
      continue;
    }
    if (!ACTION_ID.test(action.actionId || '') || actionIds.has(action.actionId)) issues.push(`${prefix}.actionId`);
    actionIds.add(action.actionId);
    if (typeof action.nodeId !== 'string' || !action.nodeId) issues.push(`${prefix}.nodeId`);
    const graphNode = graphNodes.get(action.nodeId);
    if (expected.graph && (!graphNode || graphNode.provider !== action.provider)) issues.push(`${prefix}.provider`);
    if (!PROVIDER_METHODS[action.provider]) issues.push(`${prefix}.provider`);
    if (!CONNECTION_ID.test(action.connectionId || '')) issues.push(`${prefix}.connectionId`);
    const connection = connections.get(action.connectionId);
    if (expected.connections && (!connection || connection.status !== 'ready' || connection.provider !== action.provider)) {
      issues.push(`${prefix}.connectionId`);
    }
    if (!['call', 'plan-execute'].includes(action.mode)) issues.push(`${prefix}.mode`);
    if (!isPlainObject(action.input)) issues.push(`${prefix}.input`);
    else validateSafeInput(action.input, `${prefix}.input`, issues);
    if (action.pollInput !== undefined) {
      if (!isPlainObject(action.pollInput)) issues.push(`${prefix}.pollInput`);
      else validateSafeInput(action.pollInput, `${prefix}.pollInput`, issues);
    }
    validateBindings(action.inputBindings, `${prefix}.inputBindings`, index, actionIndexById, false, issues);
    validateBindings(action.pollInputBindings, `${prefix}.pollInputBindings`, index, actionIndexById, true, issues);
    if (action.provider === 'cloudflare' && action.executeMethod === 'executeDnsChangeSet') {
      const changeSet = action.input?.changeSet;
      const zoneBinding = action.inputBindings?.zoneId;
      const zoneActionIndex = zoneBinding ? actionIndexById.get(zoneBinding.actionId) : undefined;
      const zoneAction = Number.isInteger(zoneActionIndex) ? plan.actions[zoneActionIndex] : null;
      if (!plan.dnsChangeSetId || !plan.dnsChangeSetFingerprint) issues.push(`${prefix}.dnsChangeSet(binding)`);
      if (!changeSet || changeSet.id !== plan.dnsChangeSetId || changeSet.fingerprint !== plan.dnsChangeSetFingerprint) {
        issues.push(`${prefix}.input.changeSet(binding)`);
      }
      if (expected.dnsChangeSet && stableStringify(changeSet) !== stableStringify(expected.dnsChangeSet)) {
        issues.push(`${prefix}.input.changeSet(external)`);
      }
      if (action.input?.zoneId !== undefined || zoneBinding?.path !== 'data.resource.providerId' ||
        !zoneAction || zoneAction.provider !== 'cloudflare' || zoneAction.method !== 'ensureZone') {
        issues.push(`${prefix}.inputBindings.zoneId`);
      }
    }
    if (['database.inspect', 'database.backup', 'database.migrate'].includes(action.nodeId)) {
      if (!plan.migrationPlanId || !plan.migrationPlanFingerprint) issues.push(`${prefix}.migrationPlan(binding)`);
      if (
        action.input?.migrationPlanId !== plan.migrationPlanId ||
        action.input?.migrationPlanFingerprint !== plan.migrationPlanFingerprint
      ) issues.push(`${prefix}.input.migrationPlan(binding)`);
      if (expected.migrationPlan && (
        action.input?.migrationPlanId !== expected.migrationPlan.id ||
        action.input?.migrationPlanFingerprint !== expected.migrationPlan.fingerprint
      )) issues.push(`${prefix}.input.migrationPlan(external)`);
    }
    if (action.nodeId === 'database.migrate') {
      if (!plan.backupEvidenceId || !plan.backupEvidenceFingerprint) issues.push(`${prefix}.backupEvidence(binding)`);
      if (
        action.input?.backupEvidenceId !== plan.backupEvidenceId ||
        action.input?.backupEvidenceFingerprint !== plan.backupEvidenceFingerprint
      ) issues.push(`${prefix}.input.backupEvidence(binding)`);
      if (expected.backupEvidence && (
        action.input?.backupEvidenceId !== expected.backupEvidence.id ||
        action.input?.backupEvidenceFingerprint !== expected.backupEvidence.fingerprint
      )) issues.push(`${prefix}.input.backupEvidence(external)`);
    }
    if (action.mode === 'call') {
      if (!methodAllowed(action.provider, action.method)) issues.push(`${prefix}.method`);
      else if (graphNode && !methodMatchesNode(action.provider, action.method, 'call', graphNode)) issues.push(`${prefix}.method(node-semantics)`);
      if (action.planMethod !== undefined || action.executeMethod !== undefined) issues.push(`${prefix}.planMethod|executeMethod`);
    }
    if (action.mode === 'plan-execute') {
      if (!methodAllowed(action.provider, action.planMethod)) issues.push(`${prefix}.planMethod`);
      if (!methodAllowed(action.provider, action.executeMethod)) issues.push(`${prefix}.executeMethod`);
      if (action.method !== undefined) issues.push(`${prefix}.method`);
      if (!String(action.planMethod || '').startsWith('plan') || !String(action.executeMethod || '').startsWith('execute')) {
        issues.push(`${prefix}.planMethod|executeMethod`);
      }
      if (
        graphNode &&
        (!methodMatchesNode(action.provider, action.planMethod, 'plan', graphNode) ||
          !methodMatchesNode(action.provider, action.executeMethod, 'execute', graphNode) ||
          !methodsFormPair(action.provider, action.planMethod, action.executeMethod))
      ) issues.push(`${prefix}.planMethod|executeMethod(node-semantics)`);
    }
    if (action.pollMethod !== undefined) {
      if (!methodAllowed(action.provider, action.pollMethod)) issues.push(`${prefix}.pollMethod`);
      else if (graphNode && !methodMatchesNode(action.provider, action.pollMethod, 'poll', graphNode)) issues.push(`${prefix}.pollMethod(node-semantics)`);
    }
  }
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Adapter Execution Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = adapterExecutionPlanFingerprint(plan);
  if (plan.fingerprint !== actual) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter Execution Plan fingerprint mismatch: ${plan.id}`);
  const expectedId = `adapter-plan-${actual.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (plan.id !== expectedId) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter Execution Plan ID mismatch: ${plan.id}`);
  if (expected.graph && (plan.graphId !== expected.graph.id || plan.graphFingerprint !== expected.graph.fingerprint)) {
    throw operationError('CONFLICT', 'Adapter Execution Plan is bound to a different LaunchGraph revision.');
  }
  return plan;
}

export function adapterExecutionPlanFingerprint(plan) {
  const value = structuredClone(plan);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function allowedAdapterMethods(provider) {
  return [...(PROVIDER_METHODS[provider] || [])].sort();
}

export function readAdapterActionsFile(file) {
  const resolved = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw operationError('NOT_FOUND', `Adapter actions file not found: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operationError('VALIDATION_FAILED', 'Adapter actions file must be a regular non-symlink file.');
  }
  if (stat.size > 1024 * 1024) throw operationError('VALIDATION_FAILED', 'Adapter actions file exceeds 1 MiB.');
  let value;
  try { value = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Adapter actions JSON is invalid: ${error.message}`); }
  const actions = Array.isArray(value) ? value : value?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw operationError('VALIDATION_FAILED', 'Adapter actions file must contain a non-empty array or {"actions": [...]}.');
  }
  return { actions: structuredClone(actions), actionsFile: resolved };
}

function readAdapterExecutionPlanFile(file, expected) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Adapter Execution Plan JSON is invalid: ${error.message}`); }
  return validateAdapterExecutionPlan(plan, expected);
}

function adapterExecutionPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Adapter Execution Plan ID is invalid.');
  return path.join(projectPath(home, projectId), 'adapter-plans', `${planId}.json`);
}

function methodAllowed(provider, method) {
  return typeof method === 'string' && PROVIDER_METHODS[provider]?.has(method);
}

function methodMatchesNode(provider, method, role, node) {
  const definition = METHOD_CONTRACTS[provider]?.[method];
  return Boolean(
    definition &&
    definition.role === role &&
    definition.targets.some(([operation, resourceType]) => operation === node.operation && resourceType === node.resourceType)
  );
}

function methodsFormPair(provider, planMethod, executeMethod) {
  const planned = METHOD_CONTRACTS[provider]?.[planMethod];
  const executed = METHOD_CONTRACTS[provider]?.[executeMethod];
  return Boolean(planned?.pair && planned.pair === executed?.pair);
}

function contract(role, targets, pair = '') {
  return Object.freeze({ role, targets: Object.freeze(targets.map((target) => Object.freeze(target))), pair });
}

function validateSafeInput(value, prefix, issues) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 1024 * 1024) issues.push(`${prefix}(size)`);
  walk(value, prefix);

  function walk(item, current) {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => walk(entry, `${current}[${index}]`));
      return;
    }
    if (isPlainObject(item)) {
      for (const [key, entry] of Object.entries(item)) {
        if (RESERVED_INPUT_KEYS.has(key)) issues.push(`${current}.${key}`);
        if (/(?:authorization|cookie|db_pass)$/i.test(key)) issues.push(`${current}.${key}`);
        if (/(?:token|password|secret|api_?key)$/i.test(key) && !/ref$/i.test(key) && key !== 'keyName') {
          issues.push(`${current}.${key}`);
        }
        walk(entry, `${current}.${key}`);
      }
      return;
    }
    if (typeof item === 'string') {
      if (item.length > 65536) issues.push(`${current}(size)`);
      if (
        /Bearer\s+\S+/i.test(item) ||
        /(?:re_|ghp_|github_pat_|sbp_|sb_publishable_|sb_secret_)[A-Za-z0-9_-]{8,}/.test(item) ||
        /postgres(?:ql)?:\/\/[^\s]+/i.test(item)
      ) issues.push(`${current}(secret-like-value)`);
      const key = current.split('.').at(-1) || '';
      if (/(?:secret|password|token|api_?key).*ref$/i.test(key) && !SECRET_REF.test(item)) issues.push(`${current}(secret-ref)`);
      return;
    }
    if (item !== null && !['number', 'boolean'].includes(typeof item)) issues.push(current);
  }
}

function validateBindings(bindings, prefix, currentIndex, actionIndexById, allowCurrent, issues) {
  if (bindings === undefined) return;
  if (!isPlainObject(bindings)) {
    issues.push(prefix);
    return;
  }
  for (const [destination, binding] of Object.entries(bindings)) {
    const current = `${prefix}.${destination}`;
    if (!BINDING_DESTINATION.test(destination) || RESERVED_INPUT_KEYS.has(destination.split('.')[0])) issues.push(current);
    if (!isPlainObject(binding) || Object.keys(binding).some((key) => !['actionId', 'path'].includes(key))) {
      issues.push(current);
      continue;
    }
    const sourceIndex = actionIndexById.get(binding.actionId);
    if (
      !ACTION_ID.test(binding.actionId || '') || sourceIndex === undefined ||
      sourceIndex > currentIndex || (!allowCurrent && sourceIndex === currentIndex)
    ) issues.push(`${current}.actionId`);
    if (!BINDING_SOURCE_PATH.test(binding.path || '')) issues.push(`${current}.path`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
