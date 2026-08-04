import fs from 'node:fs';
import path from 'node:path';

import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { operationError } from './errors.js';
import { projectPath, writeJsonAtomic } from './project-store.js';
import { actionSuccess, FixtureProviderAdapter, validateActionResult } from './provider-contract.js';

const TERMINAL = new Set(['succeeded', 'skipped', 'compensated']);

export function executeFixtureLaunch(options) {
  const {
    home,
    project,
    graph,
    initialRun,
    now,
    allowProviderMutations,
    allowCostMutations,
    transitionNode,
    patchRun,
    writeRevision,
    failAfterProviderMutationNode = '',
  } = options;
  assertFixturePolicy(graph, initialRun, { allowProviderMutations, allowCostMutations });
  const adapters = loadFixtureAdapters(home, project.id);
  let run = reconcileRunningNodes({ home, project, graph, run: initialRun, now, transitionNode, writeRevision });
  let fixtureMutationsExecuted = run.fixtureMutationsExecuted || 0;
  let progressed = true;

  while (progressed) {
    progressed = false;
    for (const node of graph.nodes) {
      const current = run.nodeStates[node.id];
      if (TERMINAL.has(current.status) || ['blocked', 'needs-approval', 'waiting-external', 'failed-terminal', 'compensating'].includes(current.status)) {
        continue;
      }
      const dependenciesReady = node.dependsOn.every((id) => TERMINAL.has(run.nodeStates[id]?.status));
      if (!dependenciesReady) continue;
      if (['planned', 'failed-retryable'].includes(current.status)) {
        run = persistTransition(run, graph, node.id, 'ready', { updatedAt: now }, transitionNode, writeRevision);
      }
      if (run.nodeStates[node.id].status !== 'ready') continue;
      run = persistTransition(run, graph, node.id, 'running', { updatedAt: now }, transitionNode, writeRevision);
      const outcome = executeFixtureNode({ home, project, graph, run, node, now, adapters });
      if (outcome.fixtureMutation) {
        fixtureMutationsExecuted += 1;
        saveFixtureAdapters(home, project.id, adapters);
        run = setFixtureMutationCount(run, graph, fixtureMutationsExecuted, patchRun, writeRevision);
        if (failAfterProviderMutationNode === node.id) {
          throw operationError('FIXTURE_INTERRUPTED', `Injected interruption after fixture provider mutation: ${node.id}`);
        }
      }
      const evidenceRef = writeNodeEvidence(home, project.id, run, node, outcome.result, now);
      if (outcome.result.status === 'waiting-external') {
        persistDeploymentNode(home, project.id, graph, run, node, outcome, evidenceRef, now);
        run = persistTransition(run, graph, node.id, 'waiting-external', {
          updatedAt: now,
          nextPollAt: new Date(Date.parse(now) + 1000).toISOString(),
          timeoutAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
          resultRef: evidenceRef,
        }, transitionNode, writeRevision);
        run = setFixtureMutationCount(run, graph, fixtureMutationsExecuted, patchRun, writeRevision);
        return finalizeFixtureExecution(home, project.id, graph, run, now, fixtureMutationsExecuted);
      }
      if (!outcome.result.ok) {
        const failureStatus = outcome.result.error?.retryable ? 'failed-retryable' : 'failed-terminal';
        persistDeploymentNode(home, project.id, graph, run, node, outcome, evidenceRef, now);
        run = persistTransition(run, graph, node.id, failureStatus, {
          updatedAt: now,
          lastError: outcome.result.error,
          resultRef: evidenceRef,
        }, transitionNode, writeRevision);
        run = setFixtureMutationCount(run, graph, fixtureMutationsExecuted, patchRun, writeRevision);
        return finalizeFixtureExecution(home, project.id, graph, run, now, fixtureMutationsExecuted);
      }
      persistDeploymentNode(home, project.id, graph, run, node, outcome, evidenceRef, now);
      run = persistTransition(run, graph, node.id, 'succeeded', {
        updatedAt: now,
        nextPollAt: null,
        timeoutAt: null,
        lastError: null,
        resultRef: evidenceRef,
      }, transitionNode, writeRevision);
      progressed = true;
    }
  }

  run = setFixtureMutationCount(run, graph, fixtureMutationsExecuted, patchRun, writeRevision);
  return finalizeFixtureExecution(home, project.id, graph, run, now, fixtureMutationsExecuted);
}

function executeFixtureNode({ home, project, graph, run, node, now, adapters }) {
  const operation = `fixture.${node.operation}`;
  if (node.id === 'email.domain.verify') {
    const deployment = readExternalDeployment(home, project.id);
    const prior = deployment.state.nodes?.[node.id];
    if (!prior || prior.status !== 'waiting-external') {
      const result = actionSuccess(operation, graph.appId, { poll: 'scheduled' }, {
        status: 'waiting-external',
        evidenceRefs: [`fixture://${project.id}/${node.id}/waiting`],
      });
      validateActionResult(result, { appId: graph.appId });
      return { result, resource: null, fixtureMutation: false };
    }
  }

  if (['ensure', 'deploy', 'update'].includes(node.operation) && node.provider) {
    const adapter = adapters.get(node.provider) || new FixtureProviderAdapter(node.provider);
    adapters.set(node.provider, adapter);
    const result = adapter.ensure({
      appId: graph.appId,
      logicalId: node.id,
      type: node.resourceType,
      name: `${project.id}-${node.id}`,
      attributes: {
        graphId: graph.id,
        operation: node.operation,
        sourceCommit: graph.sourceRef.commit,
      },
      idempotencyKey: `${graph.fingerprint}:${node.id}`,
      now,
    });
    validateActionResult(result, { appId: graph.appId });
    return {
      result,
      resource: result.data?.resource || null,
      fixtureMutation: result.ok && Boolean(result.data?.created || result.data?.changed || result.data?.adopted),
    };
  }

  const result = actionSuccess(operation, graph.appId, {
    nodeId: node.id,
    verified: node.operation === 'verify',
    recorded: node.operation === 'record',
    simulated: true,
  }, { evidenceRefs: [`fixture://${project.id}/${run.id}/${node.id}`] });
  validateActionResult(result, { appId: graph.appId });
  return { result, resource: null, fixtureMutation: false };
}

function reconcileRunningNodes({ home, project, graph, run, now, transitionNode, writeRevision }) {
  let currentRun = run;
  const deployment = readExternalDeployment(home, project.id);
  const providerStore = readFixtureProviderStore(home, project.id);
  for (const node of graph.nodes) {
    if (currentRun.nodeStates[node.id].status !== 'running') continue;
    const recorded = deployment.state.nodes?.[node.id];
    const providerResource = findFixtureResource(providerStore, node.id);
    if (recorded?.status === 'succeeded' || providerResource) {
      if (providerResource && recorded?.status !== 'succeeded') {
        const result = actionSuccess('fixture.reconcile', graph.appId, {
          resource: providerResource,
          adopted: true,
          created: false,
        }, { evidenceRefs: [`fixture://${project.id}/${node.id}/reconciled`] });
        const evidenceRef = writeNodeEvidence(home, project.id, currentRun, node, result, now);
        persistDeploymentNode(home, project.id, graph, currentRun, node, { result, resource: providerResource }, evidenceRef, now);
      }
      currentRun = persistTransition(currentRun, graph, node.id, 'succeeded', {
        updatedAt: now,
        resultRef: recorded?.evidenceRef || `fixture://${project.id}/${node.id}/reconciled`,
        lastError: null,
      }, transitionNode, writeRevision);
      continue;
    }
    currentRun = persistTransition(currentRun, graph, node.id, 'failed-retryable', {
      updatedAt: now,
      lastError: { code: 'INTERRUPTED', retryable: true },
    }, transitionNode, writeRevision);
  }
  return currentRun;
}

function persistDeploymentNode(home, projectId, graph, run, node, outcome, evidenceRef, now) {
  const deployment = readExternalDeployment(home, projectId);
  const state = deployment.state;
  const next = {
    ...state,
    revision: state.revision + 1,
    updatedAt: now,
    nodes: {
      ...state.nodes,
      [node.id]: {
        status: outcome.result.status,
        runId: run.id,
        graphId: graph.id,
        evidenceRef,
        providerId: outcome.resource?.providerId || '',
        updatedAt: now,
      },
    },
    resources: outcome.resource
      ? {
          ...state.resources,
          [node.id]: {
            ...outcome.resource,
            verificationStatus: 'current',
            observedAt: now,
          },
        }
      : state.resources,
  };
  validateDeploymentStateV2(next, projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, next);
  return next;
}

function finalizeFixtureExecution(home, projectId, graph, run, now, fixtureMutationsExecuted) {
  const deployment = readExternalDeployment(home, projectId);
  const priorRuns = deployment.state.runs || [];
  const summary = {
    id: run.id,
    graphId: graph.id,
    revision: run.revision,
    mode: 'fixture',
    status: run.status,
    fixtureMutationsExecuted,
    updatedAt: now,
  };
  const runs = [...priorRuns.filter((item) => item.id !== run.id), summary];
  const nextState = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    runs,
  };
  validateDeploymentStateV2(nextState, projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, nextState);
  return { run, state: nextState, fixtureMutationsExecuted };
}

function writeNodeEvidence(home, projectId, run, node, result, now) {
  const directory = path.join(projectPath(home, projectId), 'evidence', run.id);
  const file = path.join(directory, `${String(run.revision).padStart(6, '0')}-${safeNodeId(node.id)}.json`);
  if (fs.existsSync(file)) throw operationError('CONFLICT', `Fixture node evidence already exists: ${file}`);
  writeJsonAtomic(file, {
    version: 1,
    kind: 'FixtureNodeEvidence',
    projectId,
    runId: run.id,
    runRevision: run.revision,
    graphId: run.graphId,
    nodeId: node.id,
    provider: node.provider,
    sideEffect: node.sideEffect,
    createdAt: now,
    result,
  });
  return file;
}

function persistTransition(run, graph, nodeId, status, patch, transitionNode, writeRevision) {
  const next = transitionNode(run, graph, nodeId, status, patch, { expectedRevision: run.revision });
  writeRevision(next);
  return next;
}

function setFixtureMutationCount(run, graph, count, patchRun, writeRevision) {
  if ((run.fixtureMutationsExecuted || 0) === count) return run;
  const next = patchRun(run, graph, { fixtureMutationsExecuted: count });
  writeRevision(next);
  return next;
}

function assertFixturePolicy(graph, run, options) {
  const pending = graph.nodes.filter((node) => !TERMINAL.has(run.nodeStates[node.id]?.status));
  const providerEffects = pending.filter((node) => ['provider-mutation', 'cost-mutation', 'destructive'].includes(node.sideEffect));
  if (providerEffects.length > 0 && !options.allowProviderMutations) {
    throw operationError('APPROVAL_REQUIRED', 'Fixture provider nodes require --allow-provider-mutations to exercise mutation policy.');
  }
  const costEffects = pending.filter((node) => node.sideEffect === 'cost-mutation');
  if (costEffects.length > 0 && !options.allowCostMutations) {
    throw operationError('APPROVAL_REQUIRED', 'Fixture cost nodes require --allow-cost-mutations to exercise budget policy.');
  }
}

function loadFixtureAdapters(home, projectId) {
  const store = readFixtureProviderStore(home, projectId);
  const adapters = new Map();
  for (const [provider, resources] of Object.entries(store.providers)) {
    const adapter = new FixtureProviderAdapter(provider);
    for (const resource of resources) adapter.seed(resource);
    adapters.set(provider, adapter);
  }
  return adapters;
}

function saveFixtureAdapters(home, projectId, adapters) {
  const providers = Object.fromEntries([...adapters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, adapter]) => [provider, [...adapter.resources.values()].sort((left, right) => left.logicalId.localeCompare(right.logicalId))]));
  writeJsonAtomic(fixtureProviderStorePath(home, projectId), { version: 1, projectId, providers });
}

function readFixtureProviderStore(home, projectId) {
  const file = fixtureProviderStorePath(home, projectId);
  if (!fs.existsSync(file)) return { version: 1, projectId, providers: {} };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || value.projectId !== projectId || !value.providers || typeof value.providers !== 'object') {
    throw operationError('VALIDATION_FAILED', `Fixture provider store is invalid: ${file}`);
  }
  return value;
}

function findFixtureResource(store, logicalId) {
  for (const resources of Object.values(store.providers)) {
    const resource = resources.find((item) => item.logicalId === logicalId);
    if (resource) return resource;
  }
  return null;
}

function fixtureProviderStorePath(home, projectId) {
  return path.join(projectPath(home, projectId), 'fixture', 'providers.json');
}

function safeNodeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
