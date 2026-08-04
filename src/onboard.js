import path from 'node:path';

import { detectProject } from './detect.js';
import { createManifest, loadManifest, manifestPath, writeManifest } from './manifest.js';
import { prepareHandoffArtifacts } from './prepare.js';
import { writeManagedFile } from './renderers.js';
import { buildStatus } from './status.js';
import { prepareInitialState, readState, statePath, writeState } from './state.js';
import { nowIso, pathExists } from './utils.js';
import { validateManifest } from './validate.js';

export function onboardProduct(root, options = {}) {
  const generatedAt = nowIso();
  const detection = detectProject(root);
  const manifestFile = manifestPath(root);
  const stateFile = statePath(root);
  const manifestExisted = pathExists(manifestFile);
  const shouldCreateOrRefresh = !manifestExisted || options.force;
  let manifest;
  let state = null;
  let sidecarStatus = 'reused';
  let stateStatus = pathExists(stateFile) ? 'reused' : 'missing';

  if (shouldCreateOrRefresh) {
    manifest = createManifest(root, detection, options);
    state = prepareInitialState(root, manifest, { force: options.force });
    writeManifest(root, manifest, { force: options.force });
    state = writeState(root, state);
    sidecarStatus = manifestExisted ? 'refreshed' : 'created';
    stateStatus = 'written';
  } else {
    manifest = loadManifest(root);
  }

  const validation = validateManifest(manifest);
  const valid = validation.status !== 'invalid';
  const inspectionOptions = {
    ...options,
    deploymentLock: null,
  };

  if (valid) {
    state = state || readState(root, manifest);
    if (!pathExists(stateFile)) {
      state = writeState(root, state);
      stateStatus = 'written';
    }
    writeSidecarManagedFiles(root, manifest, state);
  }

  const prepared = prepareHandoffArtifacts(root, manifest, validation, valid ? state : null, inspectionOptions);
  const status = buildStatus(manifest, validation, valid ? state : null, inspectionOptions);

  return {
    version: 1,
    kind: 'product-onboarding',
    generatedAt,
    root,
    appId: prepared.appId,
    target: prepared.target,
    readinessStatus: prepared.status,
    sidecar: {
      status: sidecarStatus,
      manifestExisted,
      stateStatus,
      files: {
        manifest: manifestFile,
        state: stateFile,
        gitignore: path.join(root, '.gitignore'),
        runbook: path.join(root, '.agentmesh-deploy/RUNBOOK.md'),
      },
    },
    detection,
    validation,
    status,
    prepared,
    artifacts: prepared.artifacts,
    approvalArtifacts: prepared.approvalArtifacts,
    nextActions: prepared.nextActions,
    commandContracts: prepared.commandContracts,
    suggestedCommands: prepared.suggestedCommands,
    applyDecision: prepared.applyDecision,
  };
}

function writeSidecarManagedFiles(root, manifest, state) {
  writeManagedFile(
    root,
    {
      type: 'file',
      path: '.gitignore',
      effect: 'upsert deployment-safe ignore rules',
      sideEffect: 'filesystem',
    },
    manifest,
    state
  );
  writeManagedFile(
    root,
    {
      type: 'file',
      path: '.agentmesh-deploy/RUNBOOK.md',
      effect: 'write AI deployment handoff runbook',
      sideEffect: 'filesystem',
    },
    manifest,
    state
  );
}
