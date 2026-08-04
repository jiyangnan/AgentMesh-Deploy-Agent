import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readProjectAnalysis } from './analysis-contract.js';
import { withControlLock } from './control-lock.js';
import { validateDeploymentManifestV2, validateDeploymentStateV2 } from './contracts-v2.js';
import { operationError } from './errors.js';
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  updateProjectRecord,
  writeJsonAtomic,
} from './project-store.js';
import { showRecipe } from './recipe-service.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

export function createExternalManifest(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'manifest-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const recipe = showRecipe({ home, projectId: project.id, recipeId: options.recipeId }).recipe;
    const root = projectPath(home, project.id);
    const manifestFile = path.join(root, 'manifest.json');
    const stateFile = path.join(root, 'state.json');
    if (fs.existsSync(manifestFile) || fs.existsSync(stateFile)) {
      throw operationError('ALREADY_EXISTS', `External Deployment Manifest or State already exists for project: ${project.id}`);
    }
    const analysis = readProjectAnalysis(project);
    const createdAt = options.now || nowIso();
    const base = {
      schemaVersion: 2,
      kind: 'DeploymentManifest',
      projectId: project.id,
      sourceRef: recipe.sourceRef,
      app: { id: project.id, name: project.name },
      requirements: recipe.requirements,
      providers: recipe.providers,
      requiredConnections: recipe.requiredConnections,
      recipeRef: { id: recipe.id, fingerprint: recipe.fingerprint },
      runtime: {
        type: analysis.detection.runtimeType,
        packageManager: analysis.detection.packageManager,
        frameworks: analysis.detection.frameworks,
      },
      commands: analysis.detection.commands,
      env: { required: analysis.detection.envKeys || [] },
      verification: buildVerification(recipe.requirements),
      createdAt,
    };
    const manifest = { ...base, fingerprint: fingerprintManifest(base) };
    const state = {
      schemaVersion: 2,
      kind: 'DeploymentState',
      projectId: project.id,
      appId: project.id,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      sourceRef: recipe.sourceRef,
      nodes: {},
      resources: {},
      facts: {},
      runs: [],
      migration: {},
    };
    validateDeploymentManifestV2(manifest, project.id);
    validateDeploymentStateV2(state, project.id, manifest);
    writeJsonAtomic(manifestFile, manifest);
    writeJsonAtomic(stateFile, state);
    const repositoryGuard = completeSourceGuard(project.source, before);
    registerManifest(home, project, manifest, manifestFile, stateFile);
    return {
      kind: 'deployment-manifest',
      operation: 'create',
      status: 'succeeded',
      home,
      projectId: project.id,
      manifest,
      state,
      manifestFile,
      stateFile,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function showExternalManifest(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const manifestFile = path.join(projectPath(home, project.id), 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw operationError('NOT_FOUND', `External Deployment Manifest not found: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  validateDeploymentManifestV2(manifest, project.id);
  if (manifest.fingerprint && manifest.fingerprint !== fingerprintManifest(manifest)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Deployment Manifest fingerprint mismatch: ${manifestFile}`);
  }
  return { kind: 'deployment-manifest', operation: 'read', home, projectId: project.id, manifest, manifestFile };
}

function buildVerification(requirements) {
  const checks = ['runtime.https', 'runtime.release'];
  if (requirements.database) checks.push('database.schema');
  if (requirements.auth) checks.push('auth.real-login');
  if (requirements.email) checks.push('email.domain', 'email.delivery');
  checks.push('operations.rollback');
  return { contractId: 'saas-production-v1', checks };
}

function registerManifest(home, project, manifest, manifestFile, stateFile) {
  withControlLock(home, 'registry', 'manifest-create-register', () => {
    const latest = readProjectRecord(home, project.id, { includeArchived: true });
    if (latest.status !== 'active' || latest.source.commit !== project.source.commit) {
      throw operationError('CONFLICT', `Project changed while Manifest was created: ${project.id}`);
    }
    updateProjectRecord(home, {
      ...latest,
      lastManifest: {
        fingerprint: manifest.fingerprint,
        recipeId: manifest.recipeRef.id,
        createdAt: manifest.createdAt,
        manifestFile,
        stateFile,
      },
      updatedAt: manifest.createdAt,
    });
  });
}

function fingerprintManifest(manifest) {
  const value = structuredClone(manifest);
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
