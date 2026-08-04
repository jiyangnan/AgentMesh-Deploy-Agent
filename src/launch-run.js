import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { findActiveApprovals } from './approval.js';
import { withControlLock } from './control-lock.js';
import { LAUNCH_NODE_STATUSES } from './contracts-v2.js';
import { operationError } from './errors.js';
import { executeFixtureLaunch } from './fixture-launch-executor.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const TERMINAL_DEPENDENCIES = new Set(['succeeded', 'skipped', 'compensated']);
const TRANSITIONS = new Map([
  ['planned', new Set(['ready', 'needs-approval', 'blocked', 'skipped'])],
  ['ready', new Set(['running', 'needs-approval', 'blocked', 'skipped'])],
  ['running', new Set(['waiting-external', 'succeeded', 'failed-retryable', 'failed-terminal'])],
  ['waiting-external', new Set(['ready', 'succeeded', 'failed-retryable', 'failed-terminal'])],
  ['needs-approval', new Set(['planned', 'ready', 'blocked'])],
  ['blocked', new Set(['planned', 'ready', 'needs-approval'])],
  ['failed-retryable', new Set(['ready', 'running', 'failed-terminal'])],
  ['failed-terminal', new Set(['compensating'])],
  ['compensating', new Set(['compensated', 'failed-terminal'])],
]);

export function startLaunchRun(options) {
  assertExecutionMode(options, 'apply');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'launch-apply', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graphReport = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId });
    const graph = graphReport.graph;
    if (options.execute) assertFixtureExecutionFlags(graph, options);
    const currentTime = options.now || nowIso();
    const approvals = findActiveApprovals(home, project.id, graph, { now: currentTime });
    let run = createGraphRun(graph, approvals, {
      now: currentTime,
      mode: options.execute ? 'execute' : 'dry-run',
      providerMode: options.execute ? options.providerMode : 'none',
    });
    let files = writeLaunchRunRevision(home, project.id, run);
    let execution = null;
    if (options.execute) {
      execution = executeFixtureLaunch({
        home,
        project,
        graph,
        initialRun: run,
        now: currentTime,
        allowProviderMutations: options.allowProviderMutations,
        allowCostMutations: options.allowCostMutations,
        transitionNode: transitionNodeState,
        patchRun: patchLaunchRun,
        writeRevision(next) {
          files = writeLaunchRunRevision(home, project.id, next);
        },
        failAfterProviderMutationNode: options.fixtureFailAfterProviderMutationNode,
      });
      run = execution.run;
    }
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'launch-run',
      operation: 'apply',
      status: run.status,
      home,
      projectId: project.id,
      graph,
      graphFile: graphReport.graphFile,
      run,
      ...(execution ? { state: execution.state, fixtureMutationsExecuted: execution.fixtureMutationsExecuted } : {}),
      ...files,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function resumeLaunchRun(options) {
  assertExecutionMode(options, 'resume');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'launch-resume', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const current = readLaunchRun(home, project.id, options.runId);
    const graphReport = showLaunchGraph({ home, projectId: project.id, graphId: current.graphId });
    const graph = graphReport.graph;
    if (options.execute) assertFixtureExecutionFlags(graph, options);
    const currentTime = options.now || nowIso();
    const approvals = findActiveApprovals(home, project.id, graph, { now: currentTime });
    if (options.execute && current.mode !== 'execute') {
      throw operationError('CONFLICT', 'A dry-run LaunchRun cannot be upgraded in place. Start a new launch apply execution.');
    }
    let run = refreshGraphRun(current, graph, approvals, { now: currentTime });
    let files = writeLaunchRunRevision(home, project.id, run);
    let execution = null;
    if (options.execute) {
      if (current.providerMode !== 'fixture') {
        throw operationError('CONFLICT', `LaunchRun provider mode is ${current.providerMode || 'unknown'}, not fixture.`);
      }
      execution = executeFixtureLaunch({
        home,
        project,
        graph,
        initialRun: run,
        now: currentTime,
        allowProviderMutations: options.allowProviderMutations,
        allowCostMutations: options.allowCostMutations,
        transitionNode: transitionNodeState,
        patchRun: patchLaunchRun,
        writeRevision(next) {
          files = writeLaunchRunRevision(home, project.id, next);
        },
        failAfterProviderMutationNode: options.fixtureFailAfterProviderMutationNode,
      });
      run = execution.run;
    }
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'launch-run',
      operation: 'resume',
      status: run.status,
      home,
      projectId: project.id,
      graph,
      graphFile: graphReport.graphFile,
      run,
      ...(execution ? { state: execution.state, fixtureMutationsExecuted: execution.fixtureMutationsExecuted } : {}),
      ...files,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function createGraphRun(
  graph,
  approvals = [],
  {
    now = nowIso(), mode = 'dry-run', providerMode = 'none', adapterPlan = null,
    sandboxProfile = null, sandboxPreflight = null, databaseRuntimeProfile = null,
    transportProvenance = null,
    deploymentState = null,
  } = {}
) {
  const covered = approvedNodeIds(approvals, graph);
  const adapterNodeIds = new Set((adapterPlan?.actions || []).map((action) => action.nodeId));
  const nodeStates = {};
  for (const node of graph.nodes) {
    const persisted = deploymentState?.nodes?.[node.id];
    const compatibleAdapterState = !adapterNodeIds.has(node.id) || persisted?.adapterPlanId === adapterPlan.id;
    if (
      persisted?.graphId === graph.id && compatibleAdapterState &&
      TERMINAL_DEPENDENCIES.has(persisted.status)
    ) {
      nodeStates[node.id] = {
        ...initialNodeState(persisted.status, now),
        resultRef: persisted.resultRef || null,
      };
      continue;
    }
    const dependenciesReady = node.dependsOn.every((id) => TERMINAL_DEPENDENCIES.has(nodeStates[id]?.status));
    let status;
    if (TERMINAL_DEPENDENCIES.has(node.status)) status = node.status;
    else if (node.status === 'blocked') status = 'blocked';
    else if (node.approval && !covered.has(node.id)) status = 'needs-approval';
    else status = dependenciesReady ? 'ready' : 'planned';
    nodeStates[node.id] = initialNodeState(status, now);
  }
  const run = withRunFingerprint({
    schemaVersion: 1,
    kind: 'LaunchRun',
    id: `launch-${randomUUID()}`,
    projectId: graph.projectId,
    graphId: graph.id,
    graphFingerprint: graph.fingerprint,
    revision: 1,
    mode,
    providerMode,
    ...(adapterPlan ? { adapterPlanId: adapterPlan.id, adapterPlanFingerprint: adapterPlan.fingerprint } : {}),
    ...(sandboxProfile ? {
      sandboxProfileId: sandboxProfile.id,
      sandboxProfileFingerprint: sandboxProfile.fingerprint,
    } : {}),
    ...(sandboxPreflight ? {
      sandboxPreflightId: sandboxPreflight.id,
      sandboxPreflightFingerprint: sandboxPreflight.fingerprint,
    } : {}),
    ...(databaseRuntimeProfile ? {
      databaseRuntimeProfileId: databaseRuntimeProfile.id,
      databaseRuntimeProfileFingerprint: databaseRuntimeProfile.fingerprint,
    } : {}),
    ...(transportProvenance ? { transportProvenance } : {}),
    status: summarizeRunStatus(nodeStates),
    nodeStates,
    createdAt: now,
    updatedAt: now,
    providerMutationsExecuted: 0,
    fixtureMutationsExecuted: 0,
  });
  validateLaunchRun(run, graph);
  return run;
}

export function refreshGraphRun(
  run,
  graph,
  approvals = [],
  { now = nowIso(), reconciliationNodeIds = [] } = {}
) {
  validateLaunchRun(run, graph);
  const covered = approvedNodeIds(approvals, graph);
  const reconciliationNodes = new Set(reconciliationNodeIds);
  const nodeStates = structuredClone(run.nodeStates);
  for (const node of graph.nodes) {
    const current = nodeStates[node.id];
    const dependenciesReady = node.dependsOn.every((id) => TERMINAL_DEPENDENCIES.has(nodeStates[id]?.status));
    if (current.status === 'failed-terminal' && reconciliationNodes.has(node.id)) {
      nodeStates[node.id] = {
        ...current,
        status: dependenciesReady ? 'ready' : 'planned',
        nextPollAt: null,
        timeoutAt: null,
        lastError: null,
        updatedAt: now,
      };
      continue;
    }
    if (TERMINAL_DEPENDENCIES.has(current.status) || ['running', 'failed-terminal', 'compensating'].includes(current.status)) {
      continue;
    }
    let nextStatus = current.status;
    if (current.status === 'waiting-external') {
      if (current.timeoutAt && Date.parse(current.timeoutAt) <= Date.parse(now)) {
        nextStatus = 'failed-retryable';
        nodeStates[node.id] = {
          ...current,
          status: nextStatus,
          lastError: { code: 'ASYNC_TIMEOUT', retryable: true },
          updatedAt: now,
        };
        continue;
      }
      if (current.nextPollAt && Date.parse(current.nextPollAt) > Date.parse(now)) continue;
      nextStatus = dependenciesReady ? 'ready' : 'planned';
    } else if (node.approval && !covered.has(node.id)) {
      nextStatus = 'needs-approval';
    } else if (current.status === 'failed-retryable') {
      if (current.nextPollAt && Date.parse(current.nextPollAt) > Date.parse(now)) continue;
      nextStatus = current.attempt >= 3 ? 'failed-terminal' : (dependenciesReady ? 'ready' : 'planned');
    } else {
      nextStatus = dependenciesReady ? 'ready' : 'planned';
    }
    nodeStates[node.id] = { ...current, status: nextStatus, updatedAt: now };
  }
  const next = withRunFingerprint({
    ...run,
    revision: run.revision + 1,
    status: summarizeRunStatus(nodeStates),
    nodeStates,
    updatedAt: now,
  });
  validateLaunchRun(next, graph);
  return next;
}

export function transitionNodeState(run, graph, nodeId, nextStatus, patch = {}, { expectedRevision } = {}) {
  validateLaunchRun(run, graph);
  if (expectedRevision !== undefined && run.revision !== expectedRevision) {
    throw operationError('CONFLICT', `Launch Run revision mismatch. Expected ${expectedRevision}, current ${run.revision}.`);
  }
  if (!LAUNCH_NODE_STATUSES.has(nextStatus)) throw operationError('VALIDATION_FAILED', `Unknown node status: ${nextStatus}`);
  const current = run.nodeStates[nodeId];
  if (!current) throw operationError('NOT_FOUND', `Launch node not found in run: ${nodeId}`);
  if (!TRANSITIONS.get(current.status)?.has(nextStatus)) {
    throw operationError('CONFLICT', `Illegal node transition: ${nodeId} ${current.status} -> ${nextStatus}`);
  }
  const now = patch.updatedAt || nowIso();
  const nodeStates = {
    ...run.nodeStates,
    [nodeId]: {
      ...current,
      ...patch,
      status: nextStatus,
      attempt: nextStatus === 'running' ? current.attempt + 1 : current.attempt,
      updatedAt: now,
    },
  };
  const next = withRunFingerprint({
    ...run,
    revision: run.revision + 1,
    status: summarizeRunStatus(nodeStates),
    nodeStates,
    updatedAt: now,
  });
  validateLaunchRun(next, graph);
  return next;
}

export function patchLaunchRun(run, graph, patch = {}, { expectedRevision } = {}) {
  validateLaunchRun(run, graph);
  if (expectedRevision !== undefined && run.revision !== expectedRevision) {
    throw operationError('CONFLICT', `Launch Run revision mismatch. Expected ${expectedRevision}, current ${run.revision}.`);
  }
  const next = withRunFingerprint({
    ...run,
    ...patch,
    revision: run.revision + 1,
    updatedAt: patch.updatedAt || run.updatedAt,
  });
  validateLaunchRun(next, graph);
  return next;
}

export function readLaunchRun(home, projectId, runId) {
  if (!/^launch-[a-f0-9-]+$/.test(runId || '')) throw operationError('VALIDATION_FAILED', 'Launch Run id is invalid.');
  const directory = path.join(projectPath(home, projectId), 'runs', runId);
  const revisionsDirectory = path.join(directory, 'revisions');
  if (!fs.existsSync(revisionsDirectory)) throw operationError('NOT_FOUND', `Launch Run not found: ${runId}`);
  const revisions = fs.readdirSync(revisionsDirectory)
    .filter((name) => /^\d{6}\.json$/.test(name))
    .sort();
  if (revisions.length === 0) throw operationError('NOT_FOUND', `Launch Run has no revisions: ${runId}`);
  const file = path.join(revisionsDirectory, revisions.at(-1));
  let run;
  try {
    run = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Launch Run JSON is invalid: ${error.message}`);
  }
  if (run.projectId !== projectId) throw operationError('CONFLICT', `Launch Run belongs to another project: ${run.projectId}`);
  validateLaunchRun(run);
  return run;
}

export function validateLaunchRun(run, graph = null) {
  const issues = [];
  if (run?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (run?.kind !== 'LaunchRun') issues.push('$.kind');
  if (!/^launch-[a-f0-9-]+$/.test(run?.id || '')) issues.push('$.id');
  if (typeof run?.projectId !== 'string' || !run.projectId) issues.push('$.projectId');
  if (!Number.isInteger(run?.revision) || run.revision < 1) issues.push('$.revision');
  if (!['dry-run', 'execute'].includes(run?.mode)) issues.push('$.mode');
  if (run?.providerMode !== undefined && !['none', 'fixture', 'real', 'sandbox'].includes(run.providerMode)) issues.push('$.providerMode');
  if (run?.mode === 'dry-run' && run?.providerMode !== undefined && run.providerMode !== 'none') issues.push('$.providerMode');
  if (run?.mode === 'execute' && run?.providerMode === 'none') issues.push('$.providerMode');
  if (run?.adapterPlanId !== undefined && !/^adapter-plan-[a-f0-9]{24}$/.test(run.adapterPlanId)) issues.push('$.adapterPlanId');
  if (run?.adapterPlanFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/.test(run.adapterPlanFingerprint)) issues.push('$.adapterPlanFingerprint');
  if (['real', 'sandbox'].includes(run?.providerMode) && (!run.adapterPlanId || !run.adapterPlanFingerprint)) issues.push('$.adapterPlanId|adapterPlanFingerprint');
  if (!['real', 'sandbox'].includes(run?.providerMode) && (run.adapterPlanId !== undefined || run.adapterPlanFingerprint !== undefined)) {
    issues.push('$.adapterPlanId|adapterPlanFingerprint');
  }
  if (run?.sandboxProfileId !== undefined && !/^sandbox-[a-f0-9]{24}$/.test(run.sandboxProfileId)) issues.push('$.sandboxProfileId');
  if (run?.sandboxProfileFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/.test(run.sandboxProfileFingerprint)) issues.push('$.sandboxProfileFingerprint');
  if ((run?.sandboxProfileId === undefined) !== (run?.sandboxProfileFingerprint === undefined)) issues.push('$.sandboxProfileId|sandboxProfileFingerprint');
  if (run?.sandboxPreflightId !== undefined && !/^sandbox-preflight-[a-f0-9]{24}$/.test(run.sandboxPreflightId)) issues.push('$.sandboxPreflightId');
  if (run?.sandboxPreflightFingerprint !== undefined && !/^sha256:[a-f0-9]{64}$/.test(run.sandboxPreflightFingerprint)) issues.push('$.sandboxPreflightFingerprint');
  if ((run?.sandboxPreflightId === undefined) !== (run?.sandboxPreflightFingerprint === undefined)) issues.push('$.sandboxPreflightId|sandboxPreflightFingerprint');
  if (run?.sandboxPreflightId !== undefined && run?.sandboxProfileId === undefined) issues.push('$.sandboxProfileId(required-by-preflight)');
  if (run?.databaseRuntimeProfileId !== undefined &&
      !/^database-runtime-[a-f0-9]{24}$/.test(run.databaseRuntimeProfileId)) issues.push('$.databaseRuntimeProfileId');
  if (run?.databaseRuntimeProfileFingerprint !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(run.databaseRuntimeProfileFingerprint)) issues.push('$.databaseRuntimeProfileFingerprint');
  if ((run?.databaseRuntimeProfileId === undefined) !==
      (run?.databaseRuntimeProfileFingerprint === undefined)) issues.push('$.databaseRuntimeProfileId|databaseRuntimeProfileFingerprint');
  if (run?.databaseRuntimeProfileId !== undefined && run?.providerMode !== 'sandbox') {
    issues.push('$.databaseRuntimeProfileId(providerMode)');
  }
  if (run?.providerMode === 'sandbox' && (!run.sandboxProfileId || !run.sandboxProfileFingerprint)) {
    issues.push('$.sandboxProfileId|sandboxProfileFingerprint');
  }
  if (run?.providerMode !== 'sandbox' && (
    run?.sandboxProfileId !== undefined || run?.sandboxProfileFingerprint !== undefined ||
    run?.sandboxPreflightId !== undefined || run?.sandboxPreflightFingerprint !== undefined
  )) issues.push('$.sandboxProfileId|sandboxPreflightId');
  if (run?.transportProvenance !== undefined &&
      !['native-cli-fixed-host', 'injected-test'].includes(run.transportProvenance)) {
    issues.push('$.transportProvenance');
  }
  if (run?.providerMode !== 'sandbox' && run?.transportProvenance !== undefined) {
    issues.push('$.transportProvenance');
  }
  if (run?.providerMutationsExecuted !== undefined && (!Number.isInteger(run.providerMutationsExecuted) || run.providerMutationsExecuted < 0)) issues.push('$.providerMutationsExecuted');
  if (run?.fixtureMutationsExecuted !== undefined && (!Number.isInteger(run.fixtureMutationsExecuted) || run.fixtureMutationsExecuted < 0)) issues.push('$.fixtureMutationsExecuted');
  if (!/^sha256:[a-f0-9]{64}$/.test(run?.fingerprint || '')) issues.push('$.fingerprint');
  if (!run?.nodeStates || typeof run.nodeStates !== 'object' || Array.isArray(run.nodeStates)) issues.push('$.nodeStates');
  for (const [id, state] of Object.entries(run?.nodeStates || {})) {
    if (!LAUNCH_NODE_STATUSES.has(state?.status)) issues.push(`$.nodeStates.${id}.status`);
    if (!Number.isInteger(state?.attempt) || state.attempt < 0) issues.push(`$.nodeStates.${id}.attempt`);
  }
  if (graph) {
    if (run?.projectId !== graph.projectId) issues.push('$.projectId');
    if (run?.graphId !== graph.id) issues.push('$.graphId');
    if (run?.graphFingerprint !== graph.fingerprint) issues.push('$.graphFingerprint');
    const graphIds = graph.nodes.map((node) => node.id).sort();
    const stateIds = Object.keys(run?.nodeStates || {}).sort();
    if (JSON.stringify(graphIds) !== JSON.stringify(stateIds)) issues.push('$.nodeStates');
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Launch Run is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = runFingerprint(run);
  if (run.fingerprint !== actual) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Launch Run fingerprint mismatch: ${run.id} revision ${run.revision}`);
  }
  return run;
}

function approvedNodeIds(approvals, graph) {
  const ids = new Set();
  for (const approval of approvals) {
    if (approval.graphId !== graph.id || approval.graphFingerprint !== graph.fingerprint) continue;
    for (const id of approval.nodeIds) ids.add(id);
  }
  return ids;
}

function initialNodeState(status, now) {
  return {
    status,
    attempt: 0,
    nextPollAt: null,
    timeoutAt: null,
    lastError: null,
    updatedAt: now,
  };
}

function summarizeRunStatus(nodeStates) {
  const statuses = Object.values(nodeStates).map((state) => state.status);
  if (statuses.every((status) => TERMINAL_DEPENDENCIES.has(status))) return 'succeeded';
  if (statuses.includes('failed-terminal')) return 'failed-terminal';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('needs-approval')) return 'needs-approval';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('waiting-external')) return 'waiting-external';
  if (statuses.includes('failed-retryable')) return 'failed-retryable';
  if (statuses.includes('ready')) return 'ready';
  return 'planned';
}

export function writeLaunchRunRevision(home, projectId, run) {
  const directory = path.join(projectPath(home, projectId), 'runs', run.id);
  const revisionFile = path.join(directory, 'revisions', `${String(run.revision).padStart(6, '0')}.json`);
  const currentFile = path.join(directory, 'current.json');
  if (fs.existsSync(revisionFile)) throw operationError('CONFLICT', `Launch Run revision already exists: ${run.revision}`);
  writeJsonAtomic(revisionFile, run);
  writeJsonAtomic(currentFile, run);
  return { runFile: revisionFile, currentRunFile: currentFile };
}

function withRunFingerprint(run) {
  const next = { ...run };
  delete next.fingerprint;
  return { ...next, fingerprint: runFingerprint(next) };
}

function runFingerprint(run) {
  const value = structuredClone(run);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function assertExecutionMode(options, operation) {
  if (!options.execute) {
    if (options.providerMode) throw operationError('VALIDATION_FAILED', '--provider-mode requires --execute --yes.');
    return;
  }
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', `launch ${operation} execution requires --execute --yes.`);
  if (options.providerMode !== 'fixture') {
    throw operationError('UNSUPPORTED', `V2 real provider execution is not enabled yet; launch ${operation} only supports explicit --provider-mode fixture.`);
  }
}

function assertFixtureExecutionFlags(graph, options) {
  const providerNodes = graph.nodes.filter((node) => ['provider-mutation', 'cost-mutation', 'destructive'].includes(node.sideEffect));
  if (providerNodes.length > 0 && !options.allowProviderMutations) {
    throw operationError('APPROVAL_REQUIRED', 'Fixture Graph execution requires --allow-provider-mutations for provider, cost, or destructive nodes.');
  }
  if (graph.nodes.some((node) => node.sideEffect === 'cost-mutation') && !options.allowCostMutations) {
    throw operationError('APPROVAL_REQUIRED', 'Fixture Graph execution requires --allow-cost-mutations for cost nodes.');
  }
}
