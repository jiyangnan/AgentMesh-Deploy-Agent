import fs from 'node:fs';
import path from 'node:path';

import { currentDeployArtifact } from './artifact.js';
import { withControlLock } from './control-lock.js';
import { readExternalDeployment, sameSourceRef } from './contracts-v2.js';
import { operationError } from './errors.js';
import { assertLaunchGraphIntegrity, buildLaunchGraph } from './launch-graph.js';
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  updateProjectRecord,
  writeJsonAtomic,
} from './project-store.js';
import {
  assertControlHomeSeparated,
  captureSourceGuard,
  completeSourceGuard,
} from './repository.js';
import { nowIso } from './utils.js';

export function planLaunch(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'launch-plan', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const deployment = readExternalDeployment(home, project.id);
    assertDeploymentOwnership(project, deployment);
    const runtimeProvider = deployment.manifest.providers?.runtime || deployment.manifest.intent?.target?.provider || '';
    const artifact = currentDeployArtifact(home, project.id, project.source.commit, { provider: runtimeProvider });
    let graph = buildLaunchGraph(project, deployment.manifest, deployment.state, { createdAt: nowIso(), artifact });
    const root = projectPath(home, project.id);
    const graphFile = path.join(root, 'graphs', `${graph.id}.json`);
    const currentFile = path.join(root, 'graph.json');
    const runFile = path.join(root, 'runs', `launch-plan-${graph.id}.json`);
    let reused = false;
    if (fs.existsSync(graphFile)) {
      graph = readGraphFile(graphFile, project);
      reused = true;
    } else {
      writeJsonAtomic(graphFile, graph);
    }
    writeJsonAtomic(currentFile, graph);
    if (!fs.existsSync(runFile)) {
      writeJsonAtomic(runFile, {
        schemaVersion: 1,
        kind: 'LaunchPlanRun',
        id: `launch-plan-${graph.id}`,
        projectId: project.id,
        graphId: graph.id,
        graphFingerprint: graph.fingerprint,
        status: 'succeeded',
        createdAt: graph.createdAt,
        providerMutationsExecuted: 0,
        productRepositoryChanged: false,
      });
    }
    const repositoryGuard = completeSourceGuard(project.source, before);
    registerLatestGraph(home, project, graph, graphFile, currentFile, runFile);
    return {
      kind: 'launch-plan',
      status: 'succeeded',
      home,
      projectId: project.id,
      graph,
      graphFile,
      currentFile,
      runFile,
      reused,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function listLaunchGraphs(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const directory = path.join(projectPath(home, project.id), 'graphs');
  const graphs = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((name) => /^graph-[a-f0-9]{24}\.json$/.test(name))
        .map((name) => readGraphFile(path.join(directory, name), project))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(summarizeGraph)
    : [];
  return { kind: 'launch-graph-list', home, projectId: project.id, count: graphs.length, graphs };
}

export function showLaunchGraph(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const file = options.graphId
    ? graphPath(home, project.id, options.graphId)
    : path.join(projectPath(home, project.id), 'graph.json');
  if (!fs.existsSync(file)) throw operationError('NOT_FOUND', `Launch Graph not found: ${file}`);
  const graph = readGraphFile(file, project);
  return { kind: 'launch-graph', home, projectId: project.id, graph, graphFile: file };
}

function assertDeploymentOwnership(project, deployment) {
  if (!sameSourceRef(project.source, deployment.manifest.sourceRef)) {
    throw operationError('CONFLICT', `Deployment Manifest source does not match ProjectRegistration: ${project.id}`);
  }
  if (!sameSourceRef(project.source, deployment.state.sourceRef)) {
    throw operationError('CONFLICT', `Deployment State source does not match ProjectRegistration: ${project.id}`);
  }
}

function registerLatestGraph(home, project, graph, graphFile, currentFile, runFile) {
  if (project.lastGraph?.graphId === graph.id) return;
  withControlLock(home, 'registry', 'launch-plan-register', () => {
    const latest = readProjectRecord(home, project.id, { includeArchived: true });
    if (latest.status !== 'active') {
      throw operationError('CONFLICT', `Project was archived while launch plan was running: ${project.id}`);
    }
    if (!sameSourceRef(latest.source, project.source)) {
      throw operationError('CONFLICT', `Project source changed while launch plan was running: ${project.id}`);
    }
    updateProjectRecord(home, {
      ...latest,
      lastGraph: {
        graphId: graph.id,
        fingerprint: graph.fingerprint,
        createdAt: graph.createdAt,
        graphFile,
        currentFile,
        runFile,
      },
      updatedAt: graph.createdAt,
    });
  });
}

function readGraphFile(file, project) {
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Launch Graph JSON is invalid: ${error.message}`);
  }
  try {
    return assertLaunchGraphIntegrity(graph, { projectId: project.id });
  } catch (error) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `${error.message} File: ${file}`);
  }
}

function summarizeGraph(graph) {
  return {
    id: graph.id,
    fingerprint: graph.fingerprint,
    appId: graph.appId,
    createdAt: graph.createdAt,
    sourceRef: graph.sourceRef,
    summary: graph.summary,
  };
}

function graphPath(home, projectId, graphId) {
  if (!/^graph-[a-f0-9]{24}$/.test(graphId || '')) {
    throw operationError('VALIDATION_FAILED', 'Graph id must use graph- followed by 24 lowercase hexadecimal characters.');
  }
  return path.join(projectPath(home, projectId), 'graphs', `${graphId}.json`);
}
