import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import {
  isReconciliationOnlyActionState,
  totalSandboxProfileReceiptMutations,
} from './adapter-graph-executor.js';
import { findActiveApprovals } from './approval.js';
import { listConnections } from './connection-service.js';
import { readExternalDeployment } from './contracts-v2.js';
import { withControlLockAsync } from './control-lock.js';
import { operationError } from './errors.js';
import { showDatabaseRuntimeProfile } from './database-runtime-profile.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { estimateSandboxActionMutations, showSandboxProfile } from './sandbox-profile.js';
import { createSecretRuntime } from './secret-store.js';
import { nowIso } from './utils.js';

const EVIDENCE_ID = /^sandbox-preflight-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_VALIDITY_MS = 15 * 60 * 1000;
const NATIVE_RUNTIME_CAPABILITIES = new Set(['provider-http', 'env-secret-source']);

const SECRET_SINK_METHODS = new Set([
  'executeSendingKey',
  'executeProject:neon',
  'executeBranch',
  'executeConnectionCapture:neon',
  'executeProject:supabase',
  'executeConnectionCapture:supabase',
  'executeRuntimeCredentials',
]);

export async function createSandboxPreflight(options) {
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'sandbox-preflight-create', async () => {
    const context = loadContext({ ...options, home });
    assertControlHomeSeparated(home, context.project.source);
    const before = captureSourceGuard(context.project.source);
    const checkedAt = options.now || nowIso();
    const facts = await derivePreflightFacts(context, { ...options, checkedAt });
    const base = {
      schemaVersion: 1,
      kind: 'SandboxPreflightEvidence',
      projectId: context.project.id,
      graphId: context.graph.id,
      graphFingerprint: context.graph.fingerprint,
      adapterPlanId: context.plan.id,
      adapterPlanFingerprint: context.plan.fingerprint,
      sandboxProfileId: context.profile.id,
      sandboxProfileFingerprint: context.profile.fingerprint,
      ...(context.databaseRuntimeProfile ? {
        databaseRuntimeProfileId: context.databaseRuntimeProfile.id,
        databaseRuntimeProfileFingerprint: context.databaseRuntimeProfile.fingerprint,
      } : {}),
      connectionChecks: facts.connectionChecks,
      quotaChecks: facts.quotaChecks,
      approvalChecks: facts.approvalChecks,
      runtimeChecks: facts.runtimeChecks,
      mutationBudget: facts.mutationBudget,
      blockers: facts.blockers,
      status: facts.blockers.length === 0 ? 'ready' : 'blocked',
      checkedAt,
      validUntil: facts.validUntil,
    };
    const fingerprint = sandboxPreflightFingerprint(base);
    let evidence = {
      ...base,
      id: `sandbox-preflight-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateSandboxPreflightEvidence(evidence, { ...context, facts });
    const directory = path.join(projectPath(home, context.project.id), 'sandbox-preflights');
    const evidenceFile = path.join(directory, `${evidence.id}.json`);
    const currentFile = path.join(projectPath(home, context.project.id), 'sandbox-preflight.json');
    let reused = false;
    if (fs.existsSync(evidenceFile)) {
      const existing = readEvidence(evidenceFile, context);
      if (existing.fingerprint !== evidence.fingerprint) {
        throw operationError('CONFLICT', `Sandbox Preflight Evidence ID collision: ${evidence.id}`);
      }
      evidence = existing;
      reused = true;
    } else {
      writeJsonAtomic(evidenceFile, evidence);
    }
    writeJsonAtomic(currentFile, evidence);
    const repositoryGuard = completeSourceGuard(context.project.source, before);
    return {
      kind: 'sandbox-preflight-evidence', operation: 'create', status: evidence.status,
      home, projectId: context.project.id, evidence, evidenceFile, currentFile, reused,
      repositoryGuard, networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function showSandboxPreflight(options) {
  let context = loadContext(options);
  if (!EVIDENCE_ID.test(options.evidenceId || '')) {
    throw operationError('VALIDATION_FAILED', 'Sandbox Preflight Evidence ID is invalid.');
  }
  const evidenceFile = path.join(
    projectPath(context.home, context.project.id), 'sandbox-preflights', `${options.evidenceId}.json`
  );
  if (!fs.existsSync(evidenceFile)) {
    throw operationError('NOT_FOUND', `Sandbox Preflight Evidence not found: ${options.evidenceId}`);
  }
  let shell;
  try { shell = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Preflight Evidence JSON is invalid: ${error.message}`); }
  if (shell.databaseRuntimeProfileId && !context.databaseRuntimeProfile) {
    context = loadContext({ ...options, databaseRuntimeProfileId: shell.databaseRuntimeProfileId });
  }
  const evidence = validateSandboxPreflightEvidence(shell, context);
  const currentTime = options.now || nowIso();
  const expired = Date.parse(evidence.validUntil) <= Date.parse(currentTime);
  const current = preflightControlFactsCurrent(context, evidence, currentTime);
  const effectiveStatus = expired ? 'expired' : (current ? evidence.status : 'stale');
  return {
    kind: 'sandbox-preflight-evidence', operation: 'read', home: context.home,
    projectId: context.project.id, evidence, evidenceFile, effectiveStatus,
  };
}

function preflightControlFactsCurrent(context, evidence, now) {
  if (context.profileStatus !== 'active') return false;
  if (context.databaseRuntimeProfile && context.databaseRuntimeProfileStatus !== 'active') return false;
  const connections = listConnections({ home: context.home, projectId: context.project.id }).connections;
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  for (const check of evidence.connectionChecks) {
    const connection = connectionById.get(check.connectionId);
    if (!connection || connection.provider !== check.provider || connection.version !== check.version ||
        connection.status !== check.status) return false;
  }
  const currentState = readExternalDeployment(context.home, context.project.id).state;
  const currentQuotaChecks = sandboxProviderQuotaChecks(context.plan, connections, currentState);
  if (
    !Array.isArray(evidence.quotaChecks) ||
    stableStringify(evidence.quotaChecks) !== stableStringify(currentQuotaChecks)
  ) return false;
  const activeApprovals = findActiveApprovals(context.home, context.project.id, context.graph, { now });
  for (const check of evidence.approvalChecks) {
    const approval = activeApprovals.find((item) => item.id === check.approvalId);
    if (check.status === 'ready' && (
      !approval || approval.fingerprint !== check.fingerprint || !approval.nodeIds.includes(check.nodeId)
    )) return false;
    if (check.status === 'missing' && activeApprovals.some((item) => item.nodeIds.includes(check.nodeId))) return false;
  }
  const expectedBudget = context.mutationBudget;
  if (!mutationBudgetRemainsAuthorized(evidence.mutationBudget, expectedBudget)) {
    return false;
  }
  return true;
}

function mutationBudgetRemainsAuthorized(approved, current) {
  if (stableStringify(approved) === stableStringify(current)) return true;
  const approvedUsed = approved.used ?? Math.max(0, approved.maximum - approved.remaining);
  const approvedRequired = approved.required ?? approved.estimated;
  return approved.estimated === current.estimated && approved.maximum === current.maximum &&
    Number.isInteger(current.used) && current.used >= approvedUsed &&
    current.remaining <= approved.remaining && current.remaining >= current.required &&
    current.required <= approvedRequired && current.status === 'ready';
}

export function validateSandboxPreflightEvidence(evidence, expected = {}) {
  const issues = [];
  exactKeys(evidence, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
    'adapterPlanId', 'adapterPlanFingerprint', 'sandboxProfileId', 'sandboxProfileFingerprint',
    'databaseRuntimeProfileId', 'databaseRuntimeProfileFingerprint',
    'connectionChecks', 'quotaChecks', 'approvalChecks', 'runtimeChecks', 'mutationBudget', 'blockers',
    'status', 'checkedAt', 'validUntil',
  ], '$', issues);
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== 'SandboxPreflightEvidence') issues.push('kind|schemaVersion');
  if (!EVIDENCE_ID.test(evidence?.id || '') || !SHA256.test(evidence?.fingerprint || '')) issues.push('id|fingerprint');
  for (const key of ['graphFingerprint', 'adapterPlanFingerprint', 'sandboxProfileFingerprint']) {
    if (!SHA256.test(evidence?.[key] || '')) issues.push(key);
  }
  if (!['ready', 'blocked'].includes(evidence?.status)) issues.push('status');
  if (!isDate(evidence?.checkedAt) || !isDate(evidence?.validUntil) ||
      Date.parse(evidence.validUntil) <= Date.parse(evidence.checkedAt) ||
      Date.parse(evidence.validUntil) - Date.parse(evidence.checkedAt) > MAX_VALIDITY_MS) issues.push('time');
  validateConnectionChecks(evidence?.connectionChecks, issues);
  validateQuotaChecks(evidence?.quotaChecks, issues);
  validateApprovalChecks(evidence?.approvalChecks, issues);
  validateRuntimeChecks(evidence?.runtimeChecks, issues);
  validateMutationBudget(evidence?.mutationBudget, issues);
  validateBlockers(evidence?.blockers, issues);
  if ((evidence?.blockers?.length === 0 ? 'ready' : 'blocked') !== evidence?.status) issues.push('status|blockers');
  if (expected.project && evidence?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (
    evidence?.graphId !== expected.graph.id || evidence?.graphFingerprint !== expected.graph.fingerprint
  )) issues.push('graph');
  if (expected.plan && (
    evidence?.adapterPlanId !== expected.plan.id || evidence?.adapterPlanFingerprint !== expected.plan.fingerprint
  )) issues.push('adapterPlan');
  if (expected.profile && (
    evidence?.sandboxProfileId !== expected.profile.id ||
    evidence?.sandboxProfileFingerprint !== expected.profile.fingerprint
  )) issues.push('sandboxProfile');
  if ((evidence?.databaseRuntimeProfileId === undefined) !==
      (evidence?.databaseRuntimeProfileFingerprint === undefined)) issues.push('databaseRuntimeProfileBinding');
  if (evidence?.databaseRuntimeProfileId !== undefined &&
      !/^database-runtime-[a-f0-9]{24}$/.test(evidence.databaseRuntimeProfileId)) issues.push('databaseRuntimeProfileId');
  if (evidence?.databaseRuntimeProfileFingerprint !== undefined &&
      !SHA256.test(evidence.databaseRuntimeProfileFingerprint)) issues.push('databaseRuntimeProfileFingerprint');
  if (expected.databaseRuntimeProfile && (
    evidence?.databaseRuntimeProfileId !== expected.databaseRuntimeProfile.id ||
    evidence?.databaseRuntimeProfileFingerprint !== expected.databaseRuntimeProfile.fingerprint
  )) issues.push('databaseRuntimeProfile');
  if (!expected.databaseRuntimeProfile && evidence?.databaseRuntimeProfileId !== undefined) {
    issues.push('databaseRuntimeProfile.externalBinding');
  }
  if (expected.profile) {
    const connectionIds = (evidence?.connectionChecks || []).map((item) => item.connectionId);
    if (stableStringify(connectionIds) !== stableStringify(expected.profile.connectionIds)) {
      issues.push('connectionChecks.profileCoverage');
    }
    if (
      evidence?.mutationBudget?.estimated !== expected.profile.estimatedProviderMutations ||
      evidence?.mutationBudget?.maximum !== expected.profile.maxProviderMutations
    ) issues.push('mutationBudget.profileBinding');
  }
  if (expected.plan && expected.graph) {
    const requiredApprovalNodes = [...new Set(expected.plan.actions.map((action) => action.nodeId))]
      .filter((nodeId) => expected.graph.nodes.find((node) => node.id === nodeId)?.approval)
      .sort();
    const checkedApprovalNodes = (evidence?.approvalChecks || []).map((item) => item.nodeId);
    if (stableStringify(checkedApprovalNodes) !== stableStringify(requiredApprovalNodes)) {
      issues.push('approvalChecks.planCoverage');
    }
    const requiredRuntime = sandboxRuntimeRequirements(expected.plan).map(runtimeRequirementIdentity);
    const checkedRuntime = (evidence?.runtimeChecks || []).map(runtimeRequirementIdentity);
    if (stableStringify(checkedRuntime) !== stableStringify(requiredRuntime)) {
      issues.push('runtimeChecks.planCoverage');
    }
  }
  validateCheckSemantics(evidence, issues);
  if (expected.facts) {
    for (const key of ['connectionChecks', 'quotaChecks', 'approvalChecks', 'runtimeChecks', 'mutationBudget', 'blockers', 'validUntil']) {
      if (stableStringify(evidence?.[key]) !== stableStringify(expected.facts[key])) issues.push(`derived.${key}`);
    }
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Sandbox Preflight Evidence is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const fingerprint = sandboxPreflightFingerprint(evidence);
  if (evidence.fingerprint !== fingerprint || evidence.id !== `sandbox-preflight-${fingerprint.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Preflight Evidence fingerprint mismatch: ${evidence.id}`);
  }
  return evidence;
}

export function sandboxPreflightFingerprint(evidence) {
  const value = structuredClone(evidence);
  delete value.id;
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function loadContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: options.planId,
  }).plan;
  const profileReport = showSandboxProfile({
    home, projectId: project.id, graphId: graph.id, planId: plan.id,
    profileId: options.profileId, now: options.now,
  });
  const databaseRuntimeReport = options.databaseRuntimeProfileId
    ? showDatabaseRuntimeProfile({
        home, projectId: project.id, graphId: graph.id, adapterPlanId: plan.id,
        profileId: options.databaseRuntimeProfileId, now: options.now,
      })
    : null;
  return {
    home, project, graph, plan, profile: profileReport.profile, profileStatus: profileReport.effectiveStatus,
    databaseRuntimeProfile: databaseRuntimeReport?.profile || null,
    databaseRuntimeProfileStatus: databaseRuntimeReport?.effectiveStatus || 'missing',
    mutationBudget: deriveMutationBudget(home, project.id, graph, plan, profileReport.profile),
  };
}

function deriveMutationBudget(home, projectId, graph, plan, profile) {
  const used = totalSandboxProfileReceiptMutations(home, projectId, plan, profile);
  const deployment = readExternalDeployment(home, projectId);
  const required = plan.actions.reduce((total, action) => {
    const state = deployment.state.nodes?.[action.nodeId];
    const completed = state?.graphId === graph.id && state?.adapterPlanId === plan.id &&
      (state.completedActionIds || []).includes(action.actionId);
    const pollOnly = state?.graphId === graph.id && state?.adapterPlanId === plan.id &&
      state.status === 'waiting-external' && state.actionId === action.actionId && Boolean(action.pollMethod);
    const reconciliationOnly = state?.graphId === graph.id &&
      isReconciliationOnlyActionState(home, projectId, plan, action, state);
    return completed || pollOnly || reconciliationOnly
      ? total
      : total + estimateSandboxActionMutations(action);
  }, 0);
  const remaining = Math.max(0, profile.maxProviderMutations - used);
  return {
    estimated: profile.estimatedProviderMutations,
    maximum: profile.maxProviderMutations,
    used,
    remaining,
    required,
    status: used <= profile.maxProviderMutations && remaining >= required ? 'ready' : 'blocked',
  };
}

async function derivePreflightFacts(context, options) {
  const blockers = [];
  if (context.profileStatus !== 'active') {
    blockers.push(blocker(
      context.profileStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      'sandbox-profile', `Sandbox Profile is ${context.profileStatus}.`
    ));
  }
  if (context.databaseRuntimeProfile && context.databaseRuntimeProfileStatus !== 'active') {
    blockers.push(blocker(
      context.databaseRuntimeProfileStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      'database-runtime-profile', `Database Runtime Profile is ${context.databaseRuntimeProfileStatus}.`
    ));
  }
  const connections = listConnections({ home: context.home, projectId: context.project.id }).connections;
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const runtime = options.secretRuntime || createSecretRuntime({
    env: options.env || process.env,
    stores: options.secretStores || {},
    commandRunner: options.commandRunner,
  });
  const connectionChecks = [];
  for (const connectionId of context.profile.connectionIds) {
    const connection = connectionById.get(connectionId);
    const provider = context.plan.actions.find((action) => action.connectionId === connectionId)?.provider || '';
    if (!connection || connection.provider !== provider || connection.status !== 'ready') {
      connectionChecks.push({
        connectionId, provider, version: connection?.version || 0,
        status: connection ? connection.status : 'missing', secretChecks: [],
      });
      blockers.push(blocker('CREDENTIAL_MISSING', `connection:${connectionId}`, 'Provider Connection is missing, mismatched, or not ready.'));
      continue;
    }
    const secretChecks = [];
    for (const [name, ref] of Object.entries(connection.secretRefs || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const source = ref.split('://')[0];
      let status = 'not-probed';
      if (source === 'env') {
        const envName = ref.slice('env://'.length);
        status = (options.env || process.env)[envName] ? 'ready' : 'missing';
      } else if (options.probeSecrets === true) {
        try {
          const result = await runtime.check(ref);
          status = result.present && result.readable ? 'ready' : 'missing';
        } catch (error) {
          status = 'unavailable';
        }
      }
      secretChecks.push({ name, source, status });
      if (status === 'missing') blockers.push(blocker('CREDENTIAL_MISSING', `connection:${connectionId}:${name}`, 'Required Secret Ref is missing or unreadable.'));
      if (status === 'not-probed') blockers.push(blocker('SECRET_PROBE_REQUIRED', `connection:${connectionId}:${name}`, 'Non-environment Secret Ref requires --probe-secrets before Sandbox execution.'));
      if (status === 'unavailable') blockers.push(blocker('CAPABILITY_MISSING', `connection:${connectionId}:${name}`, 'Secret Store backend is unavailable.'));
    }
    if (context.databaseRuntimeProfile?.connectionId === connectionId) {
      const ref = context.databaseRuntimeProfile.connectionSecretRef;
      const source = ref.split('://')[0];
      let status = 'not-probed';
      if (source === 'env') {
        const envName = ref.slice('env://'.length);
        status = (options.env || process.env)[envName] ? 'ready' : 'missing';
      } else if (options.probeSecrets === true) {
        try {
          const result = await runtime.check(ref);
          status = result.present && result.readable ? 'ready' : 'missing';
        } catch {
          status = 'unavailable';
        }
      }
      secretChecks.push({ name: 'DATABASE_CONNECTION_URI', source, status });
      if (status === 'missing') blockers.push(blocker(
        'CREDENTIAL_MISSING', `connection:${connectionId}:DATABASE_CONNECTION_URI`,
        'Database connection Secret Ref is missing or unreadable.'
      ));
      if (status === 'not-probed') blockers.push(blocker(
        'SECRET_PROBE_REQUIRED', `connection:${connectionId}:DATABASE_CONNECTION_URI`,
        'Database connection Secret Ref requires --probe-secrets before Sandbox execution.'
      ));
      if (status === 'unavailable') blockers.push(blocker(
        'CAPABILITY_MISSING', `connection:${connectionId}:DATABASE_CONNECTION_URI`,
        'Database connection Secret Store backend is unavailable.'
      ));
    }
    connectionChecks.push({
      connectionId, provider: connection.provider, version: connection.version,
      status: 'ready',
      secretChecks,
    });
  }

  const activeApprovals = findActiveApprovals(context.home, context.project.id, context.graph, { now: options.checkedAt });
  const deploymentState = readExternalDeployment(context.home, context.project.id).state;
  const quotaChecks = sandboxProviderQuotaChecks(context.plan, connections, deploymentState);
  for (const check of quotaChecks) {
    if (check.status === 'blocked') blockers.push(blocker(
      'QUOTA_EXHAUSTED', `connection:${check.connectionId}:${check.quota}`,
      `Supabase Free active-project quota is exhausted (${check.used}/${check.limit}).`
    ));
    if (check.status === 'unknown') blockers.push(blocker(
      'REVERIFICATION_REQUIRED', `connection:${check.connectionId}:${check.quota}`,
      'Supabase Free active-project quota requires a fresh Connection Probe before Sandbox execution.'
    ));
  }
  const approvalChecks = [];
  const plannedNodeIds = [...new Set(context.plan.actions.map((action) => action.nodeId))].sort();
  for (const nodeId of plannedNodeIds) {
    const node = context.graph.nodes.find((item) => item.id === nodeId);
    if (!node?.approval) continue;
    const approval = activeApprovals.find((item) => item.nodeIds.includes(nodeId));
    approvalChecks.push({
      nodeId, status: approval ? 'ready' : 'missing',
      approvalId: approval?.id || '', fingerprint: approval?.fingerprint || '', expiresAt: approval?.expiresAt || '',
    });
    if (!approval) blockers.push(blocker('APPROVAL_REQUIRED', `node:${nodeId}`, 'Graph-scoped approval is missing or inactive.'));
  }

  const availableCapabilities = new Set([
    ...NATIVE_RUNTIME_CAPABILITIES,
    ...(options.runtimeCapabilities || []),
  ]);
  if (context.databaseRuntimeProfile && context.databaseRuntimeProfileStatus === 'active' &&
      postgresCommandAvailable(options)) availableCapabilities.add('migration-executor');
  const requiredCapabilities = sandboxRuntimeRequirements(context.plan);
  const runtimeChecks = await Promise.all(requiredCapabilities.map(async (item) => {
    const action = context.plan.actions.find((candidate) => candidate.actionId === item.actionId);
    const status = await probeSandboxRuntimeRequirement({
      requirement: item,
      action,
      availableCapabilities,
      secretRuntime: runtime,
      probeSecrets: options.probeSecrets === true,
    });
    if (status === 'missing') blockers.push(blocker(
      'CAPABILITY_MISSING', `action:${item.actionId}:${item.capability}`,
      `Sandbox runtime requires ${item.capability} for ${item.provider}.${item.method}.`
    ));
    return { ...item, status };
  }));

  const mutationBudget = context.mutationBudget;
  if (mutationBudget.status !== 'ready') {
    blockers.push(blocker(
      'MUTATION_BUDGET_EXCEEDED',
      'mutation-budget',
      `Sandbox Profile has ${mutationBudget.remaining} mutations remaining but unresolved actions may require ${mutationBudget.required}.`
    ));
  }
  const approvalExpirations = approvalChecks.filter((item) => item.status === 'ready').map((item) => Date.parse(item.expiresAt));
  const checkedAtMs = Date.parse(options.checkedAt);
  const profileBoundary = Date.parse(context.profile.expiresAt) > checkedAtMs
    ? Date.parse(context.profile.expiresAt)
    : checkedAtMs + 1000;
  const databaseRuntimeBoundary = context.databaseRuntimeProfile &&
      Date.parse(context.databaseRuntimeProfile.expiresAt) > checkedAtMs
    ? Date.parse(context.databaseRuntimeProfile.expiresAt)
    : Number.POSITIVE_INFINITY;
  const validUntilMs = Math.min(
    profileBoundary,
    databaseRuntimeBoundary,
    checkedAtMs + MAX_VALIDITY_MS,
    ...(approvalExpirations.length > 0 ? approvalExpirations : [Number.POSITIVE_INFINITY])
  );
  return {
    connectionChecks,
    quotaChecks,
    approvalChecks,
    runtimeChecks,
    mutationBudget,
    blockers: uniqueSortedBlockers(blockers),
    validUntil: new Date(validUntilMs).toISOString(),
  };
}

export function sandboxProviderQuotaChecks(plan, connections, deploymentState = null) {
  const byId = new Map((connections || []).map((connection) => [connection.id, connection]));
  const checks = [];
  const seen = new Set();
  for (const action of plan?.actions || []) {
    const method = action.executeMethod || action.method || '';
    if (action.provider !== 'supabase' || method !== 'executeProject' || seen.has(action.connectionId)) continue;
    seen.add(action.connectionId);
    const nodeState = deploymentState?.nodes?.[action.nodeId];
    const alreadyProvisioned = nodeState?.adapterPlanId === plan?.id && (
      (nodeState.completedActionIds || []).includes(action.actionId) ||
      (nodeState.status === 'waiting-external' && nodeState.actionId === action.actionId)
    );
    if (alreadyProvisioned) continue;
    const connection = byId.get(action.connectionId);
    const organizationPlan = connection?.identity?.organizationPlan;
    if (typeof organizationPlan === 'string' && organizationPlan && organizationPlan !== 'free') continue;
    const used = connection?.identity?.activeProjectCount;
    checks.push({
      connectionId: action.connectionId,
      provider: 'supabase',
      quota: 'active-free-projects',
      status: organizationPlan === 'free' && Number.isInteger(used)
        ? (used < 2 ? 'ready' : 'blocked')
        : 'unknown',
      used: organizationPlan === 'free' && Number.isInteger(used) ? used : -1,
      limit: 2,
    });
  }
  return checks.sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

export function sandboxRuntimeRequirements(plan) {
  const requirements = [];
  for (const action of plan.actions) {
    const method = action.executeMethod || action.method || '';
    const scopedMethod = `${method}:${action.provider}`;
    if (SECRET_SINK_METHODS.has(method) || SECRET_SINK_METHODS.has(scopedMethod)) {
      requirements.push({ actionId: action.actionId, provider: action.provider, method, capability: 'secret-sink' });
    }
    if (action.provider === 'supabase' && ['executeProject', 'executeConnectionCapture'].includes(method) &&
        !String(action.input?.databasePasswordRef || '').startsWith('env://')) {
      requirements.push({ actionId: action.actionId, provider: action.provider, method, capability: 'secret-source' });
    }
    if (action.provider === 'neon' && method === 'executeMigration') {
      requirements.push({ actionId: action.actionId, provider: action.provider, method, capability: 'migration-executor' });
    }
  }
  return requirements.sort((left, right) =>
    `${left.actionId}:${left.capability}`.localeCompare(`${right.actionId}:${right.capability}`)
  );
}

export async function probeSandboxRuntimeRequirement(options) {
  const { requirement, action, availableCapabilities, secretRuntime, probeSecrets } = options;
  if (availableCapabilities?.has(requirement.capability)) return 'ready';
  if (!action || !secretRuntime || typeof secretRuntime.check !== 'function') return 'missing';
  const input = action.input || {};
  if (requirement.capability === 'secret-sink') {
    const ref = input.destinationSecretRef || input.connectionDestinationSecretRef || '';
    if (!ref) return 'missing';
    try {
      const result = await secretRuntime.check(ref);
      return result?.ref === ref && result.writable === true ? 'ready' : 'missing';
    } catch {
      return 'missing';
    }
  }
  if (requirement.capability === 'secret-source') {
    const ref = input.databasePasswordRef || '';
    if (!ref || (!ref.startsWith('env://') && probeSecrets !== true)) return 'missing';
    try {
      const result = await secretRuntime.check(ref);
      return result?.ref === ref && result.present === true && result.readable === true ? 'ready' : 'missing';
    } catch {
      return 'missing';
    }
  }
  return 'missing';
}

function validateConnectionChecks(checks, issues) {
  if (!Array.isArray(checks)) return issues.push('connectionChecks');
  for (const [index, check] of checks.entries()) {
    const label = `connectionChecks[${index}]`;
    exactKeys(check, ['connectionId', 'provider', 'version', 'status', 'secretChecks'], label, issues);
    if (!check?.connectionId || !check.provider || !Number.isInteger(check.version) || check.version < 0 ||
        !['ready', 'blocked', 'missing', 'unverified', 'archived'].includes(check.status) || !Array.isArray(check.secretChecks)) issues.push(label);
    for (const [secretIndex, secret] of (check.secretChecks || []).entries()) {
      exactKeys(secret, ['name', 'source', 'status'], `${label}.secretChecks[${secretIndex}]`, issues);
      if (!secret?.name || !['env', 'keychain', 'op', 'secret'].includes(secret?.source) ||
          !['ready', 'missing', 'not-probed', 'unavailable'].includes(secret?.status)) issues.push(`${label}.secretChecks[${secretIndex}]`);
    }
  }
}

function validateQuotaChecks(checks, issues) {
  // Evidence created before quota probing remains readable but is stale and cannot authorize execution.
  if (checks === undefined) return;
  if (!Array.isArray(checks)) return issues.push('quotaChecks');
  for (const [index, check] of checks.entries()) {
    const label = `quotaChecks[${index}]`;
    exactKeys(check, ['connectionId', 'provider', 'quota', 'status', 'used', 'limit'], label, issues);
    if (
      !check?.connectionId || check.provider !== 'supabase' || check.quota !== 'active-free-projects' ||
      !['ready', 'blocked', 'unknown'].includes(check.status) || !Number.isInteger(check.used) ||
      !Number.isInteger(check.limit) || check.limit !== 2 ||
      (check.status === 'unknown' ? check.used !== -1 : check.used < 0) ||
      (check.status === 'ready' && check.used >= check.limit) ||
      (check.status === 'blocked' && check.used < check.limit)
    ) issues.push(label);
  }
}

function validateApprovalChecks(checks, issues) {
  if (!Array.isArray(checks)) return issues.push('approvalChecks');
  for (const [index, check] of checks.entries()) {
    const label = `approvalChecks[${index}]`;
    exactKeys(check, ['nodeId', 'status', 'approvalId', 'fingerprint', 'expiresAt'], label, issues);
    if (!check?.nodeId || !['ready', 'missing'].includes(check?.status)) issues.push(label);
    if (check?.status === 'ready' && (!check.approvalId || !SHA256.test(check.fingerprint || '') || !isDate(check.expiresAt))) issues.push(label);
    if (check?.status === 'missing' && (check.approvalId || check.fingerprint || check.expiresAt)) issues.push(label);
  }
}

function validateRuntimeChecks(checks, issues) {
  if (!Array.isArray(checks)) return issues.push('runtimeChecks');
  for (const [index, check] of checks.entries()) {
    const label = `runtimeChecks[${index}]`;
    exactKeys(check, ['actionId', 'provider', 'method', 'capability', 'status'], label, issues);
    if (!check?.actionId || !check.provider || !check.method ||
        !['secret-sink', 'secret-source', 'migration-executor'].includes(check.capability) ||
        !['ready', 'missing'].includes(check.status)) issues.push(label);
  }
}

function validateMutationBudget(budget, issues) {
  exactKeys(budget, ['estimated', 'maximum', 'used', 'remaining', 'required', 'status'], 'mutationBudget', issues);
  if (!budget || !Number.isInteger(budget.estimated) || budget.estimated < 0 ||
      !Number.isInteger(budget.maximum) || budget.maximum < 0 ||
      !Number.isInteger(budget.remaining) || budget.remaining < 0 ||
      !['ready', 'blocked'].includes(budget.status)) issues.push('mutationBudget');
  const hasUsage = budget?.used !== undefined || budget?.required !== undefined;
  if (hasUsage && (
    !Number.isInteger(budget?.used) || budget.used < 0 ||
    !Number.isInteger(budget?.required) || budget.required < 0 ||
    budget.remaining !== Math.max(0, budget.maximum - budget.used) ||
    budget.status !== (budget.used <= budget.maximum && budget.remaining >= budget.required ? 'ready' : 'blocked')
  )) issues.push('mutationBudget.usage');
}

function validateBlockers(blockers, issues) {
  if (!Array.isArray(blockers)) return issues.push('blockers');
  for (const [index, item] of blockers.entries()) {
    exactKeys(item, ['code', 'scope', 'message'], `blockers[${index}]`, issues);
    if (!/^[A-Z][A-Z0-9_]+$/.test(item?.code || '') || !item?.scope || !item?.message) issues.push(`blockers[${index}]`);
  }
}

function validateCheckSemantics(evidence, issues) {
  const required = [];
  for (const check of evidence?.connectionChecks || []) {
    if (check.status !== 'ready') {
      required.push({ code: 'CREDENTIAL_MISSING', scope: `connection:${check.connectionId}` });
    }
    for (const secret of check.secretChecks || []) {
      if (secret.status === 'missing') required.push({ code: 'CREDENTIAL_MISSING', scope: `connection:${check.connectionId}:${secret.name}` });
      if (secret.status === 'not-probed') required.push({ code: 'SECRET_PROBE_REQUIRED', scope: `connection:${check.connectionId}:${secret.name}` });
      if (secret.status === 'unavailable') required.push({ code: 'CAPABILITY_MISSING', scope: `connection:${check.connectionId}:${secret.name}` });
    }
  }
  for (const check of evidence?.quotaChecks || []) {
    if (check.status === 'blocked') required.push({
      code: 'QUOTA_EXHAUSTED', scope: `connection:${check.connectionId}:${check.quota}`,
    });
    if (check.status === 'unknown') required.push({
      code: 'REVERIFICATION_REQUIRED', scope: `connection:${check.connectionId}:${check.quota}`,
    });
  }
  for (const check of evidence?.approvalChecks || []) {
    if (check.status === 'missing') required.push({ code: 'APPROVAL_REQUIRED', scope: `node:${check.nodeId}` });
  }
  for (const check of evidence?.runtimeChecks || []) {
    if (check.status === 'missing') required.push({ code: 'CAPABILITY_MISSING', scope: `action:${check.actionId}:${check.capability}` });
  }
  if (evidence?.mutationBudget?.status === 'blocked') {
    required.push({ code: 'MUTATION_BUDGET_EXCEEDED', scope: 'mutation-budget' });
  }
  const actual = new Set((evidence?.blockers || []).map((item) => `${item.code}|${item.scope}`));
  for (const item of required) if (!actual.has(`${item.code}|${item.scope}`)) issues.push(`blockers.missing(${item.code}|${item.scope})`);
  const allowedExtra = new Set([
    'APPROVAL_EXPIRED|sandbox-profile', 'APPROVAL_REVOKED|sandbox-profile',
    'APPROVAL_EXPIRED|database-runtime-profile', 'APPROVAL_REVOKED|database-runtime-profile',
  ]);
  const requiredKeys = new Set(required.map((item) => `${item.code}|${item.scope}`));
  for (const key of actual) if (!requiredKeys.has(key) && !allowedExtra.has(key)) issues.push(`blockers.unexpected(${key})`);
  const allReady = (evidence?.connectionChecks || []).every((item) => item.status === 'ready') &&
    (evidence?.quotaChecks || []).every((item) => item.status === 'ready') &&
    (evidence?.approvalChecks || []).every((item) => item.status === 'ready') &&
    (evidence?.runtimeChecks || []).every((item) => item.status === 'ready') &&
    evidence?.mutationBudget?.status === 'ready' && actual.size === 0;
  if ((allReady ? 'ready' : 'blocked') !== evidence?.status) issues.push('status.semantic');
}

function runtimeRequirementIdentity(value) {
  return {
    actionId: value.actionId,
    provider: value.provider,
    method: value.method,
    capability: value.capability,
  };
}

function blocker(code, scope, message) { return { code, scope, message }; }

function uniqueSortedBlockers(items) {
  const unique = new Map(items.map((item) => [`${item.code}|${item.scope}|${item.message}`, item]));
  return [...unique.values()].sort((left, right) =>
    `${left.code}:${left.scope}`.localeCompare(`${right.code}:${right.scope}`)
  );
}

function readEvidence(file, context) {
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Preflight Evidence JSON is invalid: ${error.message}`); }
  return validateSandboxPreflightEvidence(evidence, context);
}

function postgresCommandAvailable(options) {
  if (typeof options.psqlAvailable === 'boolean') return options.psqlAvailable;
  const result = spawnSync('psql', ['--version'], {
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000,
    env: { PATH: (options.env || process.env).PATH || '/usr/bin:/bin' },
  });
  return result.status === 0;
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) issues.push(`${label}.unsupported(${extras.sort().join('|')})`);
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
