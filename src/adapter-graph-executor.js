import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { validateAdapterExecutionPlan } from './adapter-execution-plan.js';
import { createAdapterRegistry } from './adapter-registry.js';
import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { operationError } from './errors.js';
import { readLaunchRun } from './launch-run.js';
import { projectPath, writeJsonAtomic } from './project-store.js';
import { validateActionResult } from './provider-contract.js';
import { estimateSandboxActionMutations } from './sandbox-profile.js';

const TERMINAL = new Set(['succeeded', 'skipped', 'compensated']);
const WAITING = 'waiting-external';

export async function executeAdapterGraph(options) {
  const {
    home,
    project,
    graph,
    plan,
    connections,
    initialRun,
    approvals = [],
    runtime = {},
    now,
    transitionNode,
    patchRun,
    writeRevision,
  } = options;
  validateAdapterExecutionPlan(plan, { projectId: project.id, graph, connections });
  assertExecutorCallbacks({ transitionNode, patchRun, writeRevision });
  const actionsByNode = groupActions(plan.actions);
  const initialResults = loadAvailableActionResults(home, project.id, initialRun.id, plan);
  assertExecutionPolicy(graph, actionsByNode, approvals, options, initialRun, initialResults);
  const registry = createAdapterRegistry(connections, runtime);
  let run = initialRun;
  let progressed = true;
  const deferredRetryNodeIds = new Set();

  while (progressed) {
    progressed = false;
    const sourceResults = loadAvailableActionResults(home, project.id, run.id, plan);
    for (const node of graph.nodes) {
      const actions = actionsByNode.get(node.id) || [];
      if (actions.length === 0) continue;
      const current = run.nodeStates[node.id];
      if (deferredRetryNodeIds.has(node.id)) continue;
      if (current.status === 'failed-retryable' && current.nextPollAt &&
          Date.parse(current.nextPollAt) > Date.parse(now)) {
        deferredRetryNodeIds.add(node.id);
        continue;
      }
      if (TERMINAL.has(current.status) || ['blocked', 'needs-approval', 'failed-terminal', 'compensating', WAITING].includes(current.status)) continue;
      if (!node.dependsOn.every((id) => TERMINAL.has(run.nodeStates[id]?.status))) continue;
      if (['planned', 'failed-retryable'].includes(current.status)) {
        run = persistTransition(run, graph, node.id, 'ready', { updatedAt: now }, transitionNode, writeRevision);
      }
      if (run.nodeStates[node.id].status === 'ready') {
        run = persistTransition(run, graph, node.id, 'running', { updatedAt: now }, transitionNode, writeRevision);
      }
      if (run.nodeStates[node.id].status !== 'running') continue;

      let nodeDeferred = false;
      for (const action of actions) {
        const prior = sourceResults.get(action.actionId);
        if (prior?.result.ok && prior.result.status === 'succeeded') continue;
        assertSandboxActionMutationBudget(home, project.id, plan, runtime.sandboxProfile, action, prior);
        const outcome = await executeAction({
          home, project, graph, plan, run, node, action, prior, sourceResults, registry, approvals, options, now,
        });
        sourceResults.set(action.actionId, outcome.receipt);
        persistAdapterActionState(home, project.id, graph, run, node, action, outcome.receipt, sourceResults, now);
        run = synchronizeMutationCount(
          home, project.id, graph, plan, run, patchRun, writeRevision, now, runtime.sandboxProfile
        );
        if (options.failAfterReceiptActionId === action.actionId) {
          throw operationError('ADAPTER_EXECUTION_INTERRUPTED', `Injected interruption after Adapter receipt: ${action.actionId}`);
        }
        const result = outcome.receipt.result;
        if (result.status === WAITING) {
          run = persistTransition(run, graph, node.id, WAITING, {
            updatedAt: now,
            nextPollAt: new Date(Date.parse(now) + (options.pollIntervalMs || 1000)).toISOString(),
            timeoutAt: current.timeoutAt || new Date(Date.parse(now) + (options.pollTimeoutMs || 15 * 60 * 1000)).toISOString(),
            resultRef: outcome.receiptFile,
          }, transitionNode, writeRevision);
          nodeDeferred = true;
          progressed = true;
          break;
        }
        if (!result.ok) {
          const retryable = result.error?.retryable === true;
          const status = retryable ? 'failed-retryable' : 'failed-terminal';
          const nextPollAt = retryable ? retryAfterTimestamp(result.error, now) : null;
          run = persistTransition(run, graph, node.id, status, {
            updatedAt: now,
            nextPollAt,
            lastError: result.error,
            resultRef: outcome.receiptFile,
          }, transitionNode, writeRevision);
          if (retryable) deferredRetryNodeIds.add(node.id);
          nodeDeferred = true;
          progressed = true;
          break;
        }
        if (!['succeeded', 'ready', 'skipped'].includes(result.status)) {
          throw operationError('PROVIDER_RESPONSE_INVALID', `Adapter action ${action.actionId} returned non-terminal status ${result.status}.`);
        }
      }

      if (nodeDeferred) continue;

      const latest = latestReceiptForNode(sourceResults, actions);
      run = persistTransition(run, graph, node.id, 'succeeded', {
        updatedAt: now,
        nextPollAt: null,
        timeoutAt: null,
        lastError: null,
        resultRef: latest?.file || null,
      }, transitionNode, writeRevision);
      progressed = true;
    }
  }
  return finalize(home, project.id, graph, run, now);
}

export function retryAfterTimestamp(error, now) {
  const value = error?.details?.retryAfter;
  if (value === undefined || value === null || value === '') return null;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  const text = String(value).trim();
  let targetMs;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    targetMs = nowMs + Math.ceil(Number(text) * 1000);
  } else {
    targetMs = Date.parse(text);
  }
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) return null;
  return new Date(targetMs).toISOString();
}

function groupActions(actions) {
  const grouped = new Map();
  for (const action of actions) grouped.set(action.nodeId, [...(grouped.get(action.nodeId) || []), action]);
  return grouped;
}

function assertExecutionPolicy(graph, actionsByNode, approvals, options, run, sourceResults) {
  const activeApprovalByNode = approvalMap(approvals, graph);
  for (const node of graph.nodes) {
    const actions = actionsByNode.get(node.id);
    if (!actions || TERMINAL.has(run.nodeStates[node.id]?.status)) continue;
    const pollOnly = isPollOnlyResume(actions, sourceResults);
    if (node.approval && !activeApprovalByNode.has(node.id) && !pollOnly) {
      throw operationError('APPROVAL_REQUIRED', `Adapter node requires an active Graph-scoped approval: ${node.id}`);
    }
    if (!pollOnly && ['provider-mutation', 'cost-mutation', 'destructive'].includes(node.sideEffect) && !options.allowProviderMutations) {
      throw operationError('APPROVAL_REQUIRED', `Adapter node requires provider mutation authorization: ${node.id}`);
    }
    if (!pollOnly && node.sideEffect === 'cost-mutation' && !options.allowCostMutations) {
      throw operationError('APPROVAL_REQUIRED', `Adapter node requires cost mutation authorization: ${node.id}`);
    }
    if (node.sideEffect === 'destructive' && options.allowDatabaseMigration !== true) {
      throw operationError('APPROVAL_REQUIRED', `Destructive database execution requires explicit database-migration authorization: ${node.id}`);
    }
  }
}

function isPollOnlyResume(actions, sourceResults) {
  const pending = actions.filter((action) => {
    const result = sourceResults.get(action.actionId)?.result;
    return !(result?.ok && result.status === 'succeeded');
  });
  if (pending.length !== 1 || pending[0] !== actions.at(-1) || !pending[0].pollMethod) return false;
  return sourceResults.get(pending[0].actionId)?.result?.status === WAITING;
}

async function executeAction(context) {
  const { action, prior } = context;
  if (prior?.result.status === WAITING) {
    if (!action.pollMethod) return { receipt: prior, receiptFile: prior.file };
    return invokeAndJournal(context, 'poll', action.pollMethod, buildPollInput(context));
  }
  if (action.mode === 'call') {
    return invokeAndJournal(context, 'call', action.method, buildBaseInput(context));
  }
  const adapter = context.registry.get(action.connectionId, action.provider);
  if (typeof adapter[action.planMethod] !== 'function') {
    throw operationError('UNSUPPORTED', `Adapter method is unavailable: ${action.provider}.${action.planMethod}`);
  }
  const planInput = {
    ...buildBaseInput(context),
    ...reconciliationBinding(action, prior),
  };
  let planned;
  try {
    planned = await adapter[action.planMethod](planInput);
  } catch (error) {
    throw operationError('PROVIDER_OPERATION_FAILED', `Adapter ${action.provider}.${action.planMethod} threw before returning ActionResult: ${safeMessage(error.message)}`);
  }
  validateActionResult(planned, { appId: context.graph.appId });
  if (!planned.ok) return journalExistingResult(context, 'plan', action.planMethod, planInput, planned);
  if (!planned.data?.planFingerprint) {
    throw operationError('PROVIDER_RESPONSE_INVALID', `Adapter plan ${action.planMethod} did not return planFingerprint.`);
  }
  const executeInput = {
    ...planInput,
    ...planned.data,
    ...executionGates(context),
    planFingerprint: planned.data.planFingerprint,
    ...(planInput.knownProviderId ? { knownPlanFingerprint: planned.data.planFingerprint } : {}),
  };
  return invokeAndJournal(context, 'execute', action.executeMethod, executeInput);
}

async function invokeAndJournal(context, phase, method, input) {
  const adapter = context.registry.get(context.action.connectionId, context.action.provider);
  if (typeof adapter[method] !== 'function') throw operationError('UNSUPPORTED', `Adapter method is unavailable: ${context.action.provider}.${method}`);
  const intent = writeIntent(context, phase, method, input);
  let result;
  try {
    result = await adapter[method](input);
  } catch (error) {
    throw operationError('PROVIDER_OPERATION_FAILED', `Adapter ${context.action.provider}.${method} threw before returning ActionResult: ${safeMessage(error.message)}`);
  }
  validateActionResult(result, { appId: context.graph.appId });
  const receipt = writeReceipt(context, intent, result);
  return { receipt, receiptFile: receipt.file };
}

function journalExistingResult(context, phase, method, input, result) {
  const intent = writeIntent(context, phase, method, input);
  const receipt = writeReceipt(context, intent, result);
  return { receipt, receiptFile: receipt.file };
}

function buildBaseInput(context) {
  const input = applyBindings(context.action.input, context.action.inputBindings, context.sourceResults);
  const deployment = readExternalDeployment(context.home, context.project.id);
  const known = knownResourceBindingFromState(
    deployment.state, context.action, context.plan, input
  );
  return {
    ...input,
    ...known,
    appId: context.graph.appId,
    logicalId: input.logicalId || context.node.id,
    idempotencyKey: input.idempotencyKey || `${context.graph.fingerprint}:${context.action.actionId}`,
    now: context.now,
  };
}

export function knownResourceBindingFromState(state, action, plan, input = {}) {
  const nodeState = state?.nodes?.[action?.nodeId];
  const resource = state?.resources?.[`${action?.nodeId}:${action?.actionId}`];
  const actionBound = nodeState?.actionId === action?.actionId ||
    (nodeState?.completedActionIds || []).includes(action?.actionId);
  if (
    !nodeState || nodeState.adapterPlanId !== plan?.id || !actionBound ||
    !resource || resource.provider !== action?.provider || typeof resource.providerId !== 'string' ||
    !resource.providerId || (input.name && resource.name !== input.name)
  ) return {};
  return { knownProviderId: resource.providerId };
}

export function isReconciliationOnlyAction(action, prior) {
  return action?.provider === 'neon' && action?.mode === 'plan-execute' &&
    action.executeMethod === 'executeSnapshot' && prior?.phase === 'execute' &&
    prior.method === 'executeSnapshot' && prior.result?.ok === false &&
    prior.result?.status === 'blocked' && prior.result?.error?.code === 'PROVIDER_RESPONSE_INVALID' &&
    prior.result?.data?.providerMutationsExecuted === 1 &&
    /^snap-[a-z0-9-]{8,}$/.test(prior.result.data?.snapshotId || '');
}

export function isReconciliationOnlyActionState(home, projectId, plan, action, state) {
  if (
    state?.status !== 'blocked' || state?.adapterPlanId !== plan?.id ||
    state?.actionId !== action?.actionId || !state?.runId || !state?.resultRef
  ) return false;
  const prior = loadLatestActionResults(home, projectId, state.runId, plan).get(action.actionId);
  return Boolean(
    prior && path.resolve(prior.file) === path.resolve(state.resultRef) &&
    isReconciliationOnlyAction(action, prior)
  );
}

export function reconciliationOnlyNodeIds(home, projectId, run, plan) {
  const results = loadLatestActionResults(home, projectId, run.id, plan);
  return [...new Set(plan.actions
    .filter((action) => run.nodeStates?.[action.nodeId]?.status === 'failed-terminal')
    .filter((action) => isReconciliationOnlyAction(action, results.get(action.actionId)))
    .map((action) => action.nodeId))].sort();
}

function reconciliationBinding(action, prior) {
  return isReconciliationOnlyAction(action, prior)
    ? { knownProviderId: prior.result.data.snapshotId }
    : {};
}

function buildPollInput(context) {
  const input = applyBindings(
    context.action.pollInput || {},
    context.action.pollInputBindings,
    context.sourceResults,
    (binding) => readHistoricalBinding(context, binding)
  );
  return {
    ...input,
    appId: context.graph.appId,
    logicalId: input.logicalId || context.node.id,
    now: context.now,
  };
}

function applyBindings(base, bindings, sourceResults, fallback = null) {
  const output = structuredClone(base || {});
  for (const [destination, binding] of Object.entries(bindings || {})) {
    const source = sourceResults.get(binding.actionId)?.result;
    const currentValue = readPath(source, binding.path);
    const value = currentValue === undefined && fallback ? fallback(binding) : currentValue;
    if (value === undefined) {
      throw operationError('CONFLICT', `Adapter binding source is unavailable: ${binding.actionId}.${binding.path}`);
    }
    writePath(output, destination, value);
  }
  return output;
}

function readHistoricalBinding(context, binding) {
  const action = context.plan.actions.find((candidate) => candidate.actionId === binding.actionId);
  if (!action) return undefined;
  const directory = actionJournalDirectory(context.home, context.project.id, context.run.id, action.actionId);
  if (!fs.existsSync(directory)) return undefined;
  const files = fs.readdirSync(directory)
    .filter((name) => /^\d{6}-receipt\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of files) {
    const receipt = readAdapterActionReceipt(path.join(directory, name), {
      projectId: context.project.id,
      runId: context.run.id,
      plan: context.plan,
      action,
    });
    const value = readPath(receipt.result, binding.path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function executionGates(context) {
  const approval = approvalMap(context.approvals, context.graph).get(context.node.id);
  return {
    execute: true,
    yes: true,
    allowProviderMutations: context.options.allowProviderMutations === true,
    allowCostMutations: context.options.allowCostMutations === true,
    allowSecretRead: context.options.allowSecretRead === true,
    allowDatabaseMigration: context.options.allowDatabaseMigration === true,
    approvalFingerprint: stripSha256(approval?.fingerprint || ''),
  };
}

function writeIntent(context, phase, method, input) {
  const sequence = nextJournalSequence(context.home, context.project.id, context.run.id, context.action.actionId);
  const base = {
    version: 1,
    kind: 'AdapterMutationIntent',
    projectId: context.project.id,
    runId: context.run.id,
    graphId: context.graph.id,
    graphFingerprint: context.graph.fingerprint,
    adapterPlanId: context.plan.id,
    adapterPlanFingerprint: context.plan.fingerprint,
    nodeId: context.node.id,
    actionId: context.action.actionId,
    provider: context.action.provider,
    connectionId: context.action.connectionId,
    sequence,
    phase,
    method,
    inputFingerprint: fingerprint(input),
    createdAt: context.now,
  };
  const intent = withFingerprint(base);
  const file = journalFile(context.home, context.project.id, context.run.id, context.action.actionId, sequence, 'intent');
  if (fs.existsSync(file)) throw operationError('CONFLICT', `Adapter intent already exists: ${file}`);
  writeJsonAtomic(file, intent);
  return { intent, file };
}

function writeReceipt(context, intentRecord, result) {
  const mutationCount = resultMutationCount(result);
  const receipt = withFingerprint({
    version: 1,
    kind: 'AdapterActionReceipt',
    projectId: context.project.id,
    runId: context.run.id,
    graphId: context.graph.id,
    graphFingerprint: context.graph.fingerprint,
    adapterPlanId: context.plan.id,
    adapterPlanFingerprint: context.plan.fingerprint,
    nodeId: context.node.id,
    actionId: context.action.actionId,
    provider: context.action.provider,
    sequence: intentRecord.intent.sequence,
    phase: intentRecord.intent.phase,
    method: intentRecord.intent.method,
    intentFingerprint: intentRecord.intent.fingerprint,
    mutationCount,
    result,
    createdAt: context.now,
  });
  const file = journalFile(
    context.home, context.project.id, context.run.id, context.action.actionId, intentRecord.intent.sequence, 'receipt'
  );
  if (fs.existsSync(file)) throw operationError('CONFLICT', `Adapter receipt already exists: ${file}`);
  writeJsonAtomic(file, receipt);
  return { ...receipt, file };
}

function loadLatestActionResults(home, projectId, runId, plan) {
  const results = new Map();
  for (const action of plan.actions) {
    const directory = actionJournalDirectory(home, projectId, runId, action.actionId);
    if (!fs.existsSync(directory)) continue;
    const files = fs.readdirSync(directory).filter((name) => /^\d{6}-receipt\.json$/.test(name)).sort();
    if (files.length === 0) continue;
    const file = path.join(directory, files.at(-1));
    const receipt = readAdapterActionReceipt(file, { projectId, runId, plan, action });
    results.set(action.actionId, { ...receipt, file });
  }
  return results;
}

function loadAvailableActionResults(home, projectId, runId, plan) {
  const results = loadLatestActionResults(home, projectId, runId, plan);
  const deployment = readExternalDeployment(home, projectId);
  for (const nodeState of Object.values(deployment.state.nodes || {})) {
    if (!nodeState?.runId || nodeState.runId === runId || nodeState.adapterPlanId !== plan.id) continue;
    const prior = loadLatestActionResults(home, projectId, nodeState.runId, plan);
    if (nodeState.status === WAITING && nodeState.actionId && nodeState.resultRef) {
      const receipt = prior.get(nodeState.actionId);
      if (
        !results.has(nodeState.actionId) && receipt?.result?.status === WAITING &&
        path.resolve(receipt.file) === path.resolve(nodeState.resultRef)
      ) results.set(nodeState.actionId, receipt);
    }
    const completed = new Set(nodeState.completedActionIds || []);
    if (completed.size === 0) continue;
    for (const actionId of completed) {
      const receipt = prior.get(actionId);
      if (!results.has(actionId) && receipt?.result?.ok && receipt.result.status === 'succeeded') {
        results.set(actionId, receipt);
      }
    }
  }
  return results;
}

export function readAdapterActionReceipt(file, expected) {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Adapter receipt JSON is invalid: ${error.message}`); }
  const issues = [];
  if (receipt?.kind !== 'AdapterActionReceipt' || receipt?.version !== 1) issues.push('kind|version');
  if (receipt?.projectId !== expected.projectId || receipt?.runId !== expected.runId) issues.push('ownership');
  if (receipt?.adapterPlanId !== expected.plan.id || receipt?.adapterPlanFingerprint !== expected.plan.fingerprint) issues.push('plan');
  if (receipt?.actionId !== expected.action.actionId || receipt?.nodeId !== expected.action.nodeId) issues.push('action');
  if (receipt?.provider !== expected.action.provider) issues.push('provider');
  if (receipt?.fingerprint !== fingerprintWithoutOwn(receipt)) issues.push('fingerprint');
  const adjacentIntentFile = path.join(path.dirname(file), `${String(receipt?.sequence || 0).padStart(6, '0')}-intent.json`);
  const intent = readIntent(adjacentIntentFile, expected);
  if (receipt?.intentFingerprint !== intent.fingerprint) issues.push('intentFingerprint');
  if (issues.length > 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter receipt is invalid at ${issues.join(', ')}: ${file}`);
  validateActionResult(receipt.result);
  return receipt;
}

export function listAdapterActionReceipts(home, projectId, runId, plan) {
  const receipts = [];
  for (const action of plan.actions) {
    const directory = actionJournalDirectory(home, projectId, runId, action.actionId);
    if (!fs.existsSync(directory)) continue;
    const files = fs.readdirSync(directory)
      .filter((name) => /^\d{6}-receipt\.json$/.test(name))
      .sort();
    for (const name of files) {
      const file = path.join(directory, name);
      receipts.push({
        ...readAdapterActionReceipt(file, { projectId, runId, plan, action }),
        file,
      });
    }
  }
  return receipts;
}

function readIntent(file, expected) {
  let intent;
  try { intent = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter intent is missing or invalid: ${file}: ${error.message}`); }
  const valid =
    intent?.kind === 'AdapterMutationIntent' && intent?.version === 1 &&
    intent.projectId === expected.projectId && intent.runId === expected.runId &&
    intent.adapterPlanId === expected.plan.id && intent.adapterPlanFingerprint === expected.plan.fingerprint &&
    intent.actionId === expected.action.actionId && intent.nodeId === expected.action.nodeId &&
    intent.provider === expected.action.provider && intent.fingerprint === fingerprintWithoutOwn(intent);
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter intent integrity check failed: ${file}`);
  return intent;
}

function persistAdapterActionState(home, projectId, graph, run, node, action, receipt, sourceResults, now) {
  const deployment = readExternalDeployment(home, projectId);
  const completedActionIds = [...sourceResults.entries()]
    .filter(([, record]) => record.result.ok && record.result.status === 'succeeded')
    .filter(([, record]) => record.nodeId === node.id)
    .map(([actionId]) => actionId)
    .sort();
  const resource = receipt.result.data?.resource;
  const next = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    nodes: {
      ...deployment.state.nodes,
      [node.id]: {
        ...(deployment.state.nodes[node.id] || {}),
        status: receipt.result.status,
        runId: run.id,
        graphId: graph.id,
        adapterPlanId: receipt.adapterPlanId,
        actionId: action.actionId,
        completedActionIds,
        resultRef: receipt.file,
        resultData: receipt.result.data,
        updatedAt: now,
      },
    },
    resources: resource ? {
      ...deployment.state.resources,
      [`${node.id}:${action.actionId}`]: { ...resource, verificationStatus: 'current', observedAt: now },
    } : deployment.state.resources,
  };
  validateDeploymentStateV2(next, projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, next);
}

function synchronizeMutationCount(home, projectId, graph, plan, run, patchRun, writeRevision, now, sandboxProfile = null) {
  const count = totalReceiptMutations(home, projectId, run.id);
  const cumulative = sandboxProfile
    ? totalSandboxProfileReceiptMutations(home, projectId, plan, sandboxProfile)
    : count;
  if (sandboxProfile && cumulative > sandboxProfile.maxProviderMutations) {
    throw operationError(
      'SANDBOX_BUDGET_EXCEEDED',
      `Sandbox Profile cumulative provider mutation count ${cumulative} exceeds approved maximum ${sandboxProfile.maxProviderMutations}.`
    );
  }
  if ((run.providerMutationsExecuted || 0) === count) return run;
  const next = patchRun(run, graph, { providerMutationsExecuted: count, updatedAt: now }, { expectedRevision: run.revision });
  writeRevision(next);
  return next;
}

function assertSandboxActionMutationBudget(home, projectId, plan, profile, action, prior) {
  if (!profile || prior?.result?.status === WAITING || isReconciliationOnlyAction(action, prior)) return;
  const estimated = estimateSandboxActionMutations(action);
  if (estimated === 0) return;
  const used = totalSandboxProfileReceiptMutations(home, projectId, plan, profile);
  if (used + estimated > profile.maxProviderMutations) {
    throw operationError(
      'SANDBOX_BUDGET_EXCEEDED',
      `Sandbox action ${action.actionId} may require ${estimated} provider mutations, but Profile ${profile.id} has only ${Math.max(0, profile.maxProviderMutations - used)} remaining.`
    );
  }
}

export function totalSandboxProfileReceiptMutations(home, projectId, plan, profile) {
  const runsRoot = path.join(projectPath(home, projectId), 'runs');
  if (!fs.existsSync(runsRoot)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^launch-[a-f0-9-]+$/.test(entry.name)) continue;
    const run = readLaunchRun(home, projectId, entry.name);
    if (
      run.providerMode !== 'sandbox' ||
      run.sandboxProfileId !== profile.id || run.sandboxProfileFingerprint !== profile.fingerprint ||
      run.adapterPlanId !== plan.id || run.adapterPlanFingerprint !== plan.fingerprint
    ) continue;
    total += totalReceiptMutations(home, projectId, run.id);
  }
  return total;
}

function totalReceiptMutations(home, projectId, runId) {
  const root = path.join(projectPath(home, projectId), 'adapter-runs', runId, 'actions');
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const actionId of fs.readdirSync(root)) {
    const directory = path.join(root, actionId);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const name of fs.readdirSync(directory).filter((value) => /^\d{6}-receipt\.json$/.test(value))) {
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (
        receipt.kind !== 'AdapterActionReceipt' || receipt.runId !== runId ||
        receipt.fingerprint !== fingerprintWithoutOwn(receipt) || !Number.isInteger(receipt.mutationCount)
      ) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Adapter receipt integrity check failed: ${path.join(directory, name)}`);
      total += receipt.mutationCount;
    }
  }
  return total;
}

function finalize(home, projectId, graph, run, now) {
  const deployment = readExternalDeployment(home, projectId);
  const summary = {
    id: run.id,
    graphId: graph.id,
    revision: run.revision,
    mode: 'adapter',
    status: run.status,
    providerMutationsExecuted: run.providerMutationsExecuted || 0,
    updatedAt: now,
  };
  const nextState = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    runs: [...(deployment.state.runs || []).filter((item) => item.id !== run.id), summary],
  };
  validateDeploymentStateV2(nextState, projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, nextState);
  return { run, state: nextState, providerMutationsExecuted: run.providerMutationsExecuted || 0 };
}

function persistTransition(run, graph, nodeId, status, patch, transitionNode, writeRevision) {
  const next = transitionNode(run, graph, nodeId, status, patch, { expectedRevision: run.revision });
  writeRevision(next);
  return next;
}

function latestReceiptForNode(sourceResults, actions) {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const receipt = sourceResults.get(actions[index].actionId);
    if (receipt) return receipt;
  }
  return null;
}

function approvalMap(approvals, graph) {
  const map = new Map();
  for (const approval of approvals) {
    if (approval.graphId !== graph.id || approval.graphFingerprint !== graph.fingerprint) continue;
    for (const nodeId of approval.nodeIds || []) if (!map.has(nodeId)) map.set(nodeId, approval);
  }
  return map;
}

function nextJournalSequence(home, projectId, runId, actionId) {
  const directory = actionJournalDirectory(home, projectId, runId, actionId);
  if (!fs.existsSync(directory)) return 1;
  const values = fs.readdirSync(directory)
    .map((name) => Number(name.match(/^(\d{6})-(?:intent|receipt)\.json$/)?.[1] || 0));
  return Math.max(0, ...values) + 1;
}

function actionJournalDirectory(home, projectId, runId, actionId) {
  return path.join(projectPath(home, projectId), 'adapter-runs', runId, 'actions', actionId);
}

function journalFile(home, projectId, runId, actionId, sequence, kind) {
  return path.join(actionJournalDirectory(home, projectId, runId, actionId), `${String(sequence).padStart(6, '0')}-${kind}.json`);
}

function resultMutationCount(result) {
  if (Number.isInteger(result.data?.providerMutationsExecuted)) return result.data.providerMutationsExecuted;
  return result.ok && (result.data?.created === true || result.data?.changed === true) ? 1 : 0;
}

function withFingerprint(value) {
  const canonical = canonicalJson(value);
  return { ...canonical, fingerprint: fingerprintCanonical(canonical) };
}

function fingerprintWithoutOwn(value) {
  const clone = structuredClone(value);
  delete clone.fingerprint;
  return fingerprint(clone);
}

function fingerprint(value) {
  return fingerprintCanonical(canonicalJson(value));
}

function fingerprintCanonical(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function canonicalJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripSha256(value) {
  return String(value).replace(/^sha256:/, '');
}

function readPath(value, dotted) {
  return dotted.split('.').reduce((current, part) => current?.[part], value);
}

function writePath(target, dotted, value) {
  const parts = dotted.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(value);
}

function safeMessage(value) {
  return String(value || 'unknown error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
}

function assertExecutorCallbacks(callbacks) {
  for (const [name, value] of Object.entries(callbacks)) {
    if (typeof value !== 'function') throw operationError('VALIDATION_FAILED', `Adapter Graph Executor requires callback: ${name}`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
