import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { executeAdapterGraph, reconciliationOnlyNodeIds } from './adapter-graph-executor.js';
import { showBackupEvidence } from './backup-evidence.js';
import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { findActiveApprovals } from './approval.js';
import { listConnections } from './connection-service.js';
import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { withControlLockAsync } from './control-lock.js';
import { attachDatabaseRuntime, authorizeDatabaseRuntimeProfile } from './database-runtime-profile.js';
import { operationError } from './errors.js';
import {
  createGraphRun,
  patchLaunchRun,
  readLaunchRun,
  refreshGraphRun,
  transitionNodeState,
  writeLaunchRunRevision,
} from './launch-run.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { authorizeSandboxRuntime } from './sandbox-profile.js';
import { prepareAdapterRuntime } from './secret-store.js';
import { nowIso } from './utils.js';

const TERMINAL = new Set(['succeeded', 'skipped', 'compensated']);

export async function startAdapterLaunchRun(options) {
  assertAdapterExecutionOptions(options, 'apply');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'adapter-launch-apply', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graphReport = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId });
    const graph = graphReport.graph;
    const planReport = showAdapterExecutionPlan({
      home, projectId: project.id, graphId: graph.id, planId: options.planId,
    });
    const plan = planReport.plan;
    verifyPlanBackupEvidence(home, project.id, graph.id, plan);
    const connections = listConnections({ home, projectId: project.id }).connections;
    const currentTime = options.now || nowIso();
    const deployment = readExternalDeployment(home, project.id);
    const approvals = findActiveApprovals(home, project.id, graph, { now: currentTime });
    const authorizedRuntime = authorizeSandboxRuntime({
      ...options, home, project, graph, plan, runtime: options.runtime, now: currentTime,
    });
    const preparedRuntime = await prepareAdapterRuntime(connections, plan, authorizedRuntime);
    const databaseRuntimeProfile = authorizeDatabaseRuntimeProfile({
      ...options, home, project, graph, plan, profileId: options.databaseRuntimeProfileId, now: currentTime,
    });
    const runtime = attachDatabaseRuntime({
      ...options, home, project, graph, plan, connections, runtime: preparedRuntime,
      profile: databaseRuntimeProfile,
    });
    let run = createGraphRun(graph, approvals, {
      now: currentTime,
      mode: 'execute',
      providerMode: authorizedRuntime.sandboxProfile ? 'sandbox' : 'real',
      adapterPlan: plan,
      sandboxProfile: authorizedRuntime.sandboxProfile || null,
      sandboxPreflight: options.sandboxPreflightEvidence || null,
      databaseRuntimeProfile,
      transportProvenance: authorizedRuntime.sandboxProfile ? authorizedRuntime.transportProvenance : null,
      deploymentState: deployment.state,
    });
    let files = writeLaunchRunRevision(home, project.id, run);
    const writeRevision = (next) => {
      files = writeLaunchRunRevision(home, project.id, next);
      run = next;
    };
    run = verifyConnectionsNode({
      home, project, graph, plan, connections, run, now: currentTime, writeRevision,
      failAfterConnectionEvidence: options.failAfterConnectionEvidence,
    });
    const execution = await executeAdapterGraph({
      ...options,
      runtime,
      home,
      project,
      graph,
      plan,
      connections,
      approvals,
      initialRun: run,
      now: currentTime,
      transitionNode: transitionNodeState,
      patchRun: patchLaunchRun,
      writeRevision,
    });
    run = execution.run;
    const repositoryGuard = completeSourceGuard(project.source, before);
    return launchReport('apply', {
      home, project, graphReport, planReport, run, execution, files, repositoryGuard,
    });
  });
}

export async function resumeAdapterLaunchRun(options) {
  assertAdapterExecutionOptions(options, 'resume');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'adapter-launch-resume', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const current = readLaunchRun(home, project.id, options.runId);
    if (current.mode !== 'execute' || !['real', 'sandbox'].includes(current.providerMode)) {
      throw operationError('CONFLICT', 'Only an Adapter LaunchRun in real or sandbox provider mode can use Adapter resume.');
    }
    const graphReport = showLaunchGraph({ home, projectId: project.id, graphId: current.graphId });
    const graph = graphReport.graph;
    const planReport = showAdapterExecutionPlan({
      home, projectId: project.id, graphId: graph.id, planId: current.adapterPlanId,
    });
    const plan = planReport.plan;
    verifyPlanBackupEvidence(home, project.id, graph.id, plan);
    if (current.adapterPlanFingerprint !== plan.fingerprint) {
      throw operationError('CONFLICT', 'LaunchRun is bound to a different Adapter Execution Plan fingerprint.');
    }
    const connections = listConnections({ home, projectId: project.id }).connections;
    const currentTime = options.now || nowIso();
    const approvals = findActiveApprovals(home, project.id, graph, { now: currentTime });
    const authorizedRuntime = authorizeSandboxRuntime({
      ...options, home, project, graph, plan, runtime: options.runtime, now: currentTime,
    });
    verifySandboxRunBinding(
      current,
      authorizedRuntime.sandboxProfile,
      options.sandboxPreflightEvidence,
      authorizedRuntime.transportProvenance
    );
    const preparedRuntime = await prepareAdapterRuntime(connections, plan, authorizedRuntime);
    const databaseRuntimeProfile = authorizeDatabaseRuntimeProfile({
      ...options, home, project, graph, plan, profileId: options.databaseRuntimeProfileId, now: currentTime,
    });
    verifyDatabaseRuntimeRunBinding(current, databaseRuntimeProfile);
    const runtime = attachDatabaseRuntime({
      ...options, home, project, graph, plan, connections, runtime: preparedRuntime,
      profile: databaseRuntimeProfile,
    });
    const reconciliationNodeIds = reconciliationOnlyNodeIds(home, project.id, current, plan);
    let run = refreshGraphRun(current, graph, approvals, { now: currentTime, reconciliationNodeIds });
    let files = writeLaunchRunRevision(home, project.id, run);
    const writeRevision = (next) => {
      files = writeLaunchRunRevision(home, project.id, next);
      run = next;
    };
    run = verifyConnectionsNode({ home, project, graph, plan, connections, run, now: currentTime, writeRevision });
    const execution = await executeAdapterGraph({
      ...options,
      runtime,
      home,
      project,
      graph,
      plan,
      connections,
      approvals,
      initialRun: run,
      now: currentTime,
      transitionNode: transitionNodeState,
      patchRun: patchLaunchRun,
      writeRevision,
    });
    run = execution.run;
    const repositoryGuard = completeSourceGuard(project.source, before);
    return launchReport('resume', {
      home, project, graphReport, planReport, run, execution, files, repositoryGuard,
    });
  });
}

function verifyDatabaseRuntimeRunBinding(run, profile) {
  if (!run.databaseRuntimeProfileId && !profile) return;
  if (!profile || run.databaseRuntimeProfileId !== profile.id ||
      run.databaseRuntimeProfileFingerprint !== profile.fingerprint) {
    throw operationError('CONFLICT', 'LaunchRun is bound to a different Database Runtime Profile.');
  }
}

function verifySandboxRunBinding(run, profile, preflight, transportProvenance) {
  if (run.providerMode !== 'sandbox') {
    if (profile || preflight) throw operationError('CONFLICT', 'A real-provider Adapter Run cannot resume with Sandbox authorization objects.');
    return;
  }
  if (!profile || run.sandboxProfileId !== profile.id || run.sandboxProfileFingerprint !== profile.fingerprint) {
    throw operationError('CONFLICT', 'Sandbox LaunchRun is bound to a different Sandbox Execution Profile.');
  }
  if (run.transportProvenance && run.transportProvenance !== transportProvenance) {
    throw operationError('CONFLICT', 'Sandbox LaunchRun cannot resume through a different transport provenance.');
  }
  if (run.sandboxPreflightId) {
    if (!preflight || run.sandboxPreflightId !== preflight.id || run.sandboxPreflightFingerprint !== preflight.fingerprint) {
      throw operationError('CONFLICT', 'Sandbox LaunchRun is bound to a different Sandbox Preflight Evidence object.');
    }
  } else if (preflight) {
    throw operationError('CONFLICT', 'Sandbox LaunchRun was created without a Sandbox Preflight Evidence binding.');
  }
}

function verifyPlanBackupEvidence(home, projectId, graphId, plan) {
  if (!plan.backupEvidenceId) return;
  const evidence = showBackupEvidence({
    home, projectId, graphId, evidenceId: plan.backupEvidenceId,
  }).evidence;
  if (
    evidence.fingerprint !== plan.backupEvidenceFingerprint ||
    evidence.migrationPlanId !== plan.migrationPlanId ||
    evidence.migrationPlanFingerprint !== plan.migrationPlanFingerprint
  ) throw operationError('CONFLICT', 'Adapter Plan Backup Evidence binding does not match the verified external evidence.');
}

function verifyConnectionsNode(context) {
  const node = context.graph.nodes.find((item) => item.id === 'connections.verify');
  if (!node) return context.run;
  let run = context.run;
  const current = run.nodeStates[node.id];
  if (TERMINAL.has(current.status)) return run;
  const deployment = readExternalDeployment(context.home, context.project.id);
  const byId = new Map(context.connections.map((connection) => [connection.id, connection]));
  const requiredConnections = [...new Map(context.plan.actions.map((action) => [
    `${action.provider}:${action.connectionId}`,
    { provider: action.provider, connectionId: action.connectionId },
  ])).values()].sort((left, right) => left.provider.localeCompare(right.provider));
  const missing = requiredConnections.filter((required) => {
    const connection = byId.get(required.connectionId);
    return !connection || connection.status !== 'ready' || connection.provider !== required.provider;
  });
  if (missing.length > 0) {
    throw operationError('CREDENTIAL_MISSING', `Required Provider Connections are not ready: ${missing.map((item) => item.provider).join(', ')}`);
  }
  if (run.nodeStates[node.id].status === 'blocked') {
    run = transitionNodeState(run, context.graph, node.id, 'ready', {
      updatedAt: context.now,
      lastError: null,
    }, { expectedRevision: run.revision });
    context.writeRevision(run);
  }
  if (current.status === 'running') {
    const evidenceFile = connectionEvidencePath(context.home, context.project.id, run.id);
    if (fs.existsSync(evidenceFile)) {
      readConnectionEvidence(evidenceFile, context);
      persistConnectionState(context, readExternalDeployment(context.home, context.project.id), evidenceFile, context.now);
      run = transitionNodeState(run, context.graph, node.id, 'succeeded', {
        updatedAt: context.now,
        resultRef: evidenceFile,
        lastError: null,
      }, { expectedRevision: run.revision });
      context.writeRevision(run);
      return run;
    }
    run = transitionNodeState(run, context.graph, node.id, 'failed-retryable', {
      updatedAt: context.now,
      lastError: { code: 'INTERRUPTED', retryable: true },
    }, { expectedRevision: run.revision });
    context.writeRevision(run);
  }
  if (['planned', 'failed-retryable'].includes(run.nodeStates[node.id].status)) {
    run = transitionNodeState(run, context.graph, node.id, 'ready', { updatedAt: context.now }, { expectedRevision: run.revision });
    context.writeRevision(run);
  }
  if (run.nodeStates[node.id].status !== 'ready') return run;
  run = transitionNodeState(run, context.graph, node.id, 'running', { updatedAt: context.now }, { expectedRevision: run.revision });
  context.writeRevision(run);
  const evidenceFile = writeConnectionEvidence(context, requiredConnections);
  persistConnectionState(context, deployment, evidenceFile, context.now);
  if (context.failAfterConnectionEvidence) {
    throw operationError('ADAPTER_EXECUTION_INTERRUPTED', 'Injected interruption after Connection verification evidence.');
  }
  run = transitionNodeState(run, context.graph, node.id, 'succeeded', {
    updatedAt: context.now,
    resultRef: evidenceFile,
    lastError: null,
  }, { expectedRevision: run.revision });
  context.writeRevision(run);
  return run;
}

function writeConnectionEvidence(context, requiredConnections) {
  const file = connectionEvidencePath(context.home, context.project.id, context.run.id);
  const base = {
    version: 1,
    kind: 'ConnectionVerificationEvidence',
    projectId: context.project.id,
    runId: context.run.id,
    graphId: context.graph.id,
    graphFingerprint: context.graph.fingerprint,
    adapterPlanId: context.plan.id,
    connections: requiredConnections.map((required) => ({
      provider: required.provider,
      connectionId: required.connectionId,
      status: 'ready',
    })).sort((left, right) => left.provider.localeCompare(right.provider)),
    createdAt: context.now,
  };
  const evidence = { ...base, fingerprint: fingerprint(base) };
  if (fs.existsSync(file)) {
    readConnectionEvidence(file, context);
    return file;
  }
  writeJsonAtomic(file, evidence);
  return file;
}

function readConnectionEvidence(file, context) {
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Connection evidence JSON is invalid: ${error.message}`); }
  const value = { ...evidence };
  delete value.fingerprint;
  if (
    evidence.kind !== 'ConnectionVerificationEvidence' || evidence.version !== 1 ||
    evidence.projectId !== context.project.id || evidence.runId !== context.run.id ||
    evidence.graphId !== context.graph.id || evidence.graphFingerprint !== context.graph.fingerprint ||
    evidence.adapterPlanId !== context.plan.id || evidence.fingerprint !== fingerprint(value)
  ) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Connection evidence integrity check failed: ${file}`);
  return evidence;
}

function connectionEvidencePath(home, projectId, runId) {
  return path.join(projectPath(home, projectId), 'adapter-runs', runId, 'control', 'connections.verify.json');
}

function persistConnectionState(context, deployment, evidenceFile, now) {
  const next = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    nodes: {
      ...deployment.state.nodes,
      'connections.verify': {
        status: 'succeeded',
        runId: context.run.id,
        graphId: context.graph.id,
        evidenceRef: evidenceFile,
        updatedAt: now,
      },
    },
  };
  validateDeploymentStateV2(next, context.project.id, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, next);
}

function launchReport(operation, context) {
  return {
    kind: 'adapter-launch-run',
    operation,
    status: context.run.status,
    home: context.home,
    projectId: context.project.id,
    graph: context.graphReport.graph,
    graphFile: context.graphReport.graphFile,
    adapterPlan: context.planReport.plan,
    adapterPlanFile: context.planReport.planFile,
    run: context.run,
    state: context.execution.state,
    providerMutationsExecuted: context.execution.providerMutationsExecuted,
    ...context.files,
    repositoryGuard: context.repositoryGuard,
    productRepositoryChanged: false,
  };
}

function assertAdapterExecutionOptions(options, operation) {
  if (!options.execute || !options.yes) {
    throw operationError('APPROVAL_REQUIRED', `Adapter launch ${operation} requires explicit execute and yes authorization.`);
  }
  if (!options.runtime || typeof options.runtime !== 'object') {
    throw operationError('VALIDATION_FAILED', 'Adapter launch requires an injected runtime.');
  }
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
