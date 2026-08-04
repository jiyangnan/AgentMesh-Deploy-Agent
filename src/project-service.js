import path from 'node:path';

import { fingerprintAnalysis } from './analysis-contract.js';
import { withControlLock } from './control-lock.js';
import { detectProject } from './detect.js';
import { operationError } from './errors.js';
import {
  createProjectRecord,
  listProjectRecords,
  projectFilePath,
  readProjectRecord,
  registryPath,
  resolveDeployHome,
  updateProjectRecord,
  writeProjectArtifact,
} from './project-store.js';
import {
  assertControlHomeSeparated,
  captureSourceGuard,
  completeSourceGuard,
  inspectRepositorySource,
  repositoryName,
} from './repository.js';
import { createIsolatedWorkspace } from './workspace.js';
import { nowIso, slugify } from './utils.js';

export function addProject(options) {
  const home = resolveDeployHome(options.home);
  const source = inspectRepositorySource(options.repo);
  assertControlHomeSeparated(home, source);
  const name = options.name || repositoryName(source.locator);
  const id = options.projectId || slugify(name);
  return withControlLock(home, 'registry', 'project-add', () => {
    const before = captureSourceGuard(source);
    const createdAt = nowIso();
    const project = {
      version: 1,
      id,
      name,
      status: 'active',
      source,
      createdAt,
      updatedAt: createdAt,
      lastAnalysis: null,
    };
    createProjectRecord(home, project);
    const repositoryGuard = completeSourceGuard(source, before);
    return {
      kind: 'project-registration',
      operation: 'create',
      home,
      registryFile: registryPath(home),
      projectFile: projectFilePath(home, id),
      project,
      repositoryGuard,
    };
  });
}

export function listProjects(options) {
  const home = resolveDeployHome(options.home);
  return {
    kind: 'project-list',
    home,
    count: listProjectRecords(home, { includeArchived: options.includeArchived }).length,
    projects: listProjectRecords(home, { includeArchived: options.includeArchived }),
  };
}

export function showProject(options) {
  const home = resolveDeployHome(options.home);
  return {
    kind: 'project-registration',
    operation: 'read',
    home,
    project: readProjectRecord(home, options.projectId, { includeArchived: options.includeArchived }),
  };
}

export function updateProject(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, 'registry', 'project-update', () => {
    const current = readProjectRecord(home, options.projectId);
    const source = options.repo || options.refreshSource
      ? inspectRepositorySource(options.repo || current.source.locator)
      : current.source;
    assertControlHomeSeparated(home, source);
    const before = captureSourceGuard(source);
    const changedSource = source.locator !== current.source.locator || source.commit !== current.source.commit;
    const updatedAt = nowIso();
    const project = {
      ...current,
      name: options.name || current.name,
      source,
      sourceHistory: changedSource
        ? [
            ...(current.sourceHistory || []),
            {
              locator: current.source.locator,
              commit: current.source.commit,
              replacedAt: updatedAt,
            },
          ]
        : current.sourceHistory || [],
      updatedAt,
    };
    updateProjectRecord(home, project);
    const repositoryGuard = completeSourceGuard(source, before);
    return {
      kind: 'project-registration',
      operation: 'update',
      home,
      project,
      repositoryGuard,
    };
  });
}

export function removeProject(options) {
  if (!options.yes) {
    throw operationError('APPROVAL_REQUIRED', 'Removing a project registration requires --yes. Product resources are not deleted.');
  }
  const home = resolveDeployHome(options.home);
  return withControlLock(home, 'registry', 'project-remove', () => {
    const current = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, current.source);
    const before = captureSourceGuard(current.source);
    const archivedAt = nowIso();
    const project = {
      ...current,
      status: 'archived',
      archivedAt,
      updatedAt: archivedAt,
    };
    updateProjectRecord(home, project);
    const repositoryGuard = completeSourceGuard(current.source, before);
    return {
      kind: 'project-registration',
      operation: 'archive',
      home,
      project,
      repositoryGuard,
      providerResourcesChanged: false,
      productRepositoryChanged: false,
    };
  });
}

export function analyzeProject(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'analyze', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const currentSource = inspectRepositorySource(project.source.locator);
    const workspace = createIsolatedWorkspace(home, project);
    const detection = detectProject(workspace.paths.source);
    const repositoryGuard = completeSourceGuard(project.source, before);
    const analysisBase = {
      version: 1,
      kind: 'project-analysis',
      projectId: project.id,
      runId: workspace.runId,
      createdAt: nowIso(),
      sourceRef: {
        kind: project.source.kind,
        locator: project.source.locator,
        lockedCommit: project.source.commit,
        currentCommit: currentSource.commit,
        drifted: currentSource.commit !== project.source.commit,
      },
      repositoryGuard,
      workspace,
      detection,
    };
    const analysis = {
      ...analysisBase,
      fingerprint: fingerprintAnalysis(analysisBase),
    };
    const analysisFile = writeProjectArtifact(home, project.id, 'analysis.json', analysis);
    const runFile = writeProjectArtifact(home, project.id, path.join('runs', `${workspace.runId}.json`), analysis);
    const nextProject = {
      ...project,
      lastAnalysis: {
        runId: workspace.runId,
        createdAt: analysis.createdAt,
        commit: project.source.commit,
        analysisFile,
        runFile,
      },
      updatedAt: analysis.createdAt,
    };
    withControlLock(home, 'registry', 'analyze-register', () => {
      const latest = readProjectRecord(home, project.id, { includeArchived: true });
      if (latest.status !== 'active') {
        throw operationError('CONFLICT', `Project was archived while analysis was running: ${project.id}`);
      }
      if (latest.source.locator !== project.source.locator || latest.source.commit !== project.source.commit) {
        throw operationError('CONFLICT', `Project source changed while analysis was running: ${project.id}`);
      }
      updateProjectRecord(home, {
        ...latest,
        lastAnalysis: nextProject.lastAnalysis,
        updatedAt: nextProject.updatedAt,
      });
    });
    return { ...analysis, analysisFile, runFile };
  });
}
