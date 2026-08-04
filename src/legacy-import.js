import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { loadManifest, manifestPath } from './manifest.js';
import { buildPlan } from './plan.js';
import { addProject } from './project-service.js';
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
  inspectRepositorySource,
} from './repository.js';
import { readState, statePath } from './state.js';
import { nowIso } from './utils.js';
import { validateManifest } from './validate.js';

const IMPORT_SOURCE = 'legacy-sidecar-import';

export function importLegacyProject(options) {
  const home = resolveDeployHome(options.home);
  const source = inspectRepositorySource(options.repo);
  if (source.kind !== 'local-git') {
    throw operationError('UNSUPPORTED', 'Legacy Sidecar import requires a local Git repository path.');
  }
  assertControlHomeSeparated(home, source);
  const before = captureSourceGuard(source);
  const legacy = readLegacySource(source.locator);
  const repositoryGuard = completeSourceGuard(source, before);
  const projectId = options.projectId || legacy.manifest.app.id;
  const project = ensureProjectRegistration(home, source, projectId, options.name || legacy.manifest.app.name);

  return withControlLock(home, `project:${project.id}`, 'import-legacy', () => {
    const importedAt = nowIso();
    const importId = hashText([
      source.commit,
      legacy.manifestSha256,
      legacy.stateSha256,
    ].join(':')).slice(0, 24);
    const migration = {
      source: IMPORT_SOURCE,
      importId,
      importedAt,
      sourceRef: {
        kind: source.kind,
        locator: source.locator,
        commit: source.commit,
      },
      sourceManifestSha256: legacy.manifestSha256,
      sourceStateSha256: legacy.stateSha256,
      legacyManifestVersion: legacy.manifest.version,
      approvalsInvalidated: true,
    };
    const importedManifest = buildImportedManifest(project, legacy.manifest, migration);
    const importedState = buildImportedState(project, legacy.state, migration);
    const compatibilityState = restoreLegacyCompatibilityState(importedState);
    const legacyPlan = buildPlan(legacy.manifest, legacy.state);
    const compatibilityPlan = buildPlan(legacy.manifest, compatibilityState);
    if (legacyPlan.fingerprint !== compatibilityPlan.fingerprint) {
      throw operationError('CONFLICT', 'Imported State does not produce a plan equivalent to the V1 State.');
    }

    const root = projectPath(home, project.id);
    const manifestFile = path.join(root, 'manifest.json');
    const stateFile = path.join(root, 'state.json');
    const evidenceFile = path.join(root, 'evidence', `import-${importId}.json`);
    const runFile = path.join(root, 'runs', `import-${importId}.json`);
    const existingManifest = readJsonIfExists(manifestFile);
    const existingState = readJsonIfExists(stateFile);
    assertCompatibleExistingImport(existingManifest, migration, manifestFile);
    assertCompatibleExistingImport(existingState, migration, stateFile);
    const reused = Boolean(existingManifest && existingState);

    if (!existingManifest) writeJsonAtomic(manifestFile, importedManifest);
    if (!existingState) writeJsonAtomic(stateFile, importedState);

    const evidence = {
      version: 1,
      kind: 'legacy-import-evidence',
      importId,
      projectId: project.id,
      createdAt: importedAt,
      sourceRef: migration.sourceRef,
      sourceFiles: {
        manifest: {
          path: '.agentmesh-deploy/manifest.json',
          sha256: legacy.manifestSha256,
        },
        state: {
          path: '.agentmesh-deploy/state.json',
          present: legacy.statePresent,
          sha256: legacy.stateSha256,
        },
      },
      validation: {
        status: legacy.validation.status,
        warnings: legacy.validation.warnings,
      },
      planEquivalence: {
        status: 'equivalent',
        legacyFingerprint: legacyPlan.fingerprint,
        compatibilityFingerprint: compatibilityPlan.fingerprint,
      },
      migrated: {
        completedSteps: legacy.state.completedSteps.length,
        resources: Object.keys(legacy.state.resources).length,
        legacyRunsReferenced: legacy.state.runs.length,
        legacyRunsCopied: 0,
        approvalsCopied: 0,
      },
      staleFacts: countStaleFacts(importedState),
      legacyApprovals: {
        reviewPresent: fs.existsSync(path.join(source.locator, '.agentmesh-deploy', 'reviews', 'latest.json')),
        diffPresent: fs.existsSync(path.join(source.locator, '.agentmesh-deploy', 'diffs', 'latest.json')),
        invalidated: true,
      },
      repositoryGuard,
      productRepositoryChanged: false,
      sourceFilesDeleted: false,
      sourceFilesWritten: false,
    };
    if (!fs.existsSync(evidenceFile)) writeJsonAtomic(evidenceFile, evidence);
    if (!fs.existsSync(runFile)) {
      writeJsonAtomic(runFile, {
        version: 1,
        kind: 'legacy-import-run',
        id: `import-${importId}`,
        command: 'import legacy',
        mode: 'local-read-only',
        status: 'succeeded',
        createdAt: importedAt,
        projectId: project.id,
        evidenceFile,
      });
    }

    withControlLock(home, 'registry', 'import-register', () => {
      const latest = readProjectRecord(home, project.id, { includeArchived: true });
      if (latest.status !== 'active') {
        throw operationError('CONFLICT', `Project was archived while import was running: ${project.id}`);
      }
      if (latest.source.locator !== source.locator || latest.source.commit !== source.commit) {
        throw operationError('CONFLICT', `Project source changed while import was running: ${project.id}`);
      }
      updateProjectRecord(home, {
        ...latest,
        lastImport: {
          source: IMPORT_SOURCE,
          importId,
          importedAt,
          manifestFile,
          stateFile,
          evidenceFile,
        },
        updatedAt: importedAt,
      });
    });

    return {
      kind: 'legacy-import',
      status: 'succeeded',
      home,
      projectId: project.id,
      importId,
      reused,
      manifestFile,
      stateFile,
      evidenceFile,
      runFile,
      repositoryGuard,
      planEquivalence: evidence.planEquivalence,
      migrated: evidence.migrated,
      staleFacts: evidence.staleFacts,
      approvalsInvalidated: true,
      productRepositoryChanged: false,
    };
  });
}

function readLegacySource(root) {
  const manifestFile = manifestPath(root);
  if (!fs.existsSync(manifestFile)) {
    throw operationError('NOT_FOUND', `Legacy manifest not found: ${manifestFile}`);
  }
  let manifest;
  let rawState;
  try {
    manifest = loadManifest(root);
    rawState = readJsonIfExists(statePath(root));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Legacy Sidecar JSON is invalid: ${error.message}`);
  }
  const validation = validateManifest(manifest);
  if (validation.status === 'invalid') {
    throw operationError(
      'VALIDATION_FAILED',
      `Legacy manifest is invalid: ${validation.issues.map((issue) => issue.path).join(', ')}`
    );
  }
  if (rawState?.appId && rawState.appId !== manifest.app.id) {
    throw operationError(
      'CONFLICT',
      `Legacy State belongs to ${rawState.appId}, but Manifest belongs to ${manifest.app.id}.`
    );
  }
  const state = readState(root, manifest);
  const safeIntent = sanitizeLegacyManifest(manifest);
  const secretPaths = [
    ...findEmbeddedSecretPaths(safeIntent),
    ...findEmbeddedSecretPaths(state),
  ];
  if (secretPaths.length > 0) {
    throw operationError(
      'SECRET_IN_INPUT',
      `Legacy control data contains embedded secret values at: ${secretPaths.join(', ')}`
    );
  }
  const stateFile = statePath(root);
  return {
    manifest: safeIntent,
    state,
    validation,
    statePresent: fs.existsSync(stateFile),
    manifestSha256: sha256File(manifestFile),
    stateSha256: fs.existsSync(stateFile) ? sha256File(stateFile) : 'missing',
  };
}

function ensureProjectRegistration(home, source, projectId, name) {
  try {
    return addProject({ home, repo: source.locator, projectId, name }).project;
  } catch (error) {
    if (error.code !== 'ALREADY_EXISTS') throw error;
    const project = readProjectRecord(home, projectId);
    if (project.source.locator !== source.locator || project.source.commit !== source.commit) {
      throw operationError(
        'CONFLICT',
        `Existing project ${projectId} is not bound to the same repository Commit.`
      );
    }
    return project;
  }
}

function buildImportedManifest(project, manifest, migration) {
  return {
    schemaVersion: 2,
    kind: 'DeploymentManifest',
    projectId: project.id,
    sourceRef: migration.sourceRef,
    intent: manifest,
    migration,
  };
}

function buildImportedState(project, state, migration) {
  const resources = {};
  for (const [logicalId, resource] of Object.entries(state.resources || {})) {
    resources[logicalId] = staleFact(resource, { lifecycle: 'adopted', logicalId });
  }
  const nodes = {};
  for (const stepId of state.completedSteps || []) {
    nodes[stepId] = {
      status: 'succeeded',
      source: 'legacy-completed-step',
      verificationStatus: 'stale',
    };
  }
  return {
    schemaVersion: 2,
    kind: 'DeploymentState',
    projectId: project.id,
    appId: state.appId,
    revision: 1,
    createdAt: state.createdAt,
    updatedAt: migration.importedAt,
    sourceRef: migration.sourceRef,
    nodes,
    resources,
    facts: {
      infrastructure: staleFact(state.infrastructure),
      domain: staleFact(state.domain),
      dns: staleFact(state.dns),
      deployment: staleFact({ url: state.deploymentUrl }),
      github: staleFact(state.github),
    },
    runs: [],
    migration: {
      ...migration,
      legacyCompletedSteps: [...state.completedSteps],
      legacyRunCount: state.runs.length,
      legacyRunsCopied: 0,
      approvalsCopied: 0,
    },
  };
}

function restoreLegacyCompatibilityState(state) {
  const resources = {};
  for (const [logicalId, fact] of Object.entries(state.resources || {})) {
    resources[logicalId] = fact.observed;
  }
  return {
    version: 1,
    appId: state.appId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedSteps: Object.entries(state.nodes || {})
      .filter(([, node]) => node.status === 'succeeded')
      .map(([stepId]) => stepId),
    resources,
    infrastructure: state.facts.infrastructure.observed,
    domain: state.facts.domain.observed,
    dns: state.facts.dns.observed,
    deploymentUrl: state.facts.deployment.observed.url || '',
    github: state.facts.github.observed,
    runs: [],
  };
}

function staleFact(observed, extra = {}) {
  return {
    ...extra,
    verificationStatus: 'stale',
    verificationReason: 'imported-provider-fact-not-reverified',
    observed: structuredClone(observed || {}),
  };
}

function countStaleFacts(state) {
  return Object.keys(state.resources || {}).length + Object.keys(state.facts || {}).length;
}

function assertCompatibleExistingImport(value, migration, file) {
  if (!value) return;
  const existing = value.migration || {};
  if (
    existing.source !== IMPORT_SOURCE ||
    existing.importId !== migration.importId ||
    existing.sourceManifestSha256 !== migration.sourceManifestSha256 ||
    existing.sourceStateSha256 !== migration.sourceStateSha256 ||
    existing.sourceRef?.commit !== migration.sourceRef.commit
  ) {
    throw operationError('CONFLICT', `External control file already exists with different ownership: ${file}`);
  }
}

function sanitizeLegacyManifest(manifest) {
  const keys = [
    'schema',
    'version',
    'app',
    'runtime',
    'target',
    'commands',
    'resources',
    'env',
    'domain',
    'deployment',
    'github',
    'safety',
  ];
  return Object.fromEntries(
    keys.filter((key) => Object.prototype.hasOwnProperty.call(manifest, key))
      .map((key) => [key, structuredClone(manifest[key])])
  );
}

function findEmbeddedSecretPaths(value, currentPath = '$') {
  const issues = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => issues.push(...findEmbeddedSecretPaths(item, `${currentPath}[${index}]`)));
    return issues;
  }
  if (!value || typeof value !== 'object') return issues;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (typeof item === 'string') {
      const secretKey = /(?:password|token|secret|privatekey|apikey)$/i.test(key);
      const envReference = /^[A-Z][A-Z0-9_]*$/.test(item);
      const commandAssignment = currentPath.endsWith('.commands') && /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)=[^$\s][^\s]*/i.test(item);
      if ((secretKey && item && !envReference) || commandAssignment || urlHasCredentials(item)) {
        issues.push(nextPath);
      }
    } else {
      issues.push(...findEmbeddedSecretPaths(item, nextPath));
    }
  }
  return issues;
}

function urlHasCredentials(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}
