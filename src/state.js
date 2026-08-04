import path from 'node:path';

import { CONFIG_DIR } from './manifest.js';
import { ensureDir, nowIso, pathExists, readJson, writeJson } from './utils.js';

export const STATE_FILE = 'state.json';

export function statePath(root) {
  return path.join(root, CONFIG_DIR, STATE_FILE);
}

export function runsDir(root) {
  return path.join(root, CONFIG_DIR, 'runs');
}

export function createInitialState(manifest) {
  const timestamp = nowIso();
  return {
    version: 1,
    appId: manifest.app.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedSteps: [],
    resources: {},
    infrastructure: {},
    domain: {},
    dns: {},
    deploymentUrl: '',
    github: {},
    runs: [],
  };
}

export function prepareInitialState(root, manifest, { force = false } = {}) {
  const filePath = statePath(root);
  if (!pathExists(filePath)) return createInitialState(manifest);

  const existing = readJson(filePath);
  if (!force) {
    throw new Error(`State already exists: ${filePath}. Use --force to preserve and refresh it.`);
  }
  if (existing.appId && existing.appId !== manifest.app.id) {
    throw new Error(
      `State belongs to app ${existing.appId}; refusing to initialize ${manifest.app.id}. Move the existing state file before reinitializing a different app.`
    );
  }
  return normalizeState(existing, manifest);
}

export function readState(root, manifest) {
  const filePath = statePath(root);
  if (!pathExists(filePath)) return createInitialState(manifest);
  return normalizeState(readJson(filePath), manifest);
}

export function writeState(root, state) {
  const next = {
    ...state,
    updatedAt: nowIso(),
  };
  writeJson(statePath(root), next);
  return next;
}

export function markCompleted(state, stepId) {
  if (state.completedSteps.includes(stepId)) return state;
  return {
    ...state,
    completedSteps: [...state.completedSteps, stepId],
  };
}

export function recordRun(root, state, run) {
  ensureDir(runsDir(root));
  const runId = run.id || `run-${Date.now()}`;
  const filePath = path.join(runsDir(root), `${runId}.json`);
  writeJson(filePath, { ...run, id: runId });
  const summary = summarizeRun({ ...run, id: runId }, path.relative(path.join(root, CONFIG_DIR), filePath));
  return writeState(root, {
    ...state,
    runs: [...(state.runs || []), summary].slice(-50),
  });
}

export function summarizeRun(run, file) {
  const failed = (run.results || []).find((result) => result.status === 'failed');
  const failedStep = failed
    ? (run.plan?.steps || []).find((step) => step.id === failed.stepId)
    : undefined;
  return {
    id: run.id,
    command: run.command,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    file,
    resultCounts: countRunResults(run.results || []),
    ...(failed
      ? {
          failedStep: {
            stepId: failed.stepId,
            stepTitle: failedStep?.title || '',
            error: compactError(failed.error),
          },
        }
      : {}),
  };
}

export function summarizeDeployState(state = {}) {
  const resources = Object.entries(state.resources || {}).map(([id, resource]) => ({
    id,
    type: resource.type || '',
    name: resource.name || '',
    provider: resource.provider || '',
    providerId: resource.providerId || '',
  }));
  const lastRun = state.runs?.at(-1) || null;

  return {
    appId: state.appId || '',
    updatedAt: state.updatedAt || '',
    completedSteps: state.completedSteps || [],
    resources,
    infrastructure: {
      provider: state.infrastructure?.provider || '',
      dropletName: state.infrastructure?.dropletName || '',
      hostId: state.infrastructure?.hostId || '',
      publicIp: state.infrastructure?.publicIp || '',
      sshHost: state.infrastructure?.sshHost || '',
      sshKeyIds: state.infrastructure?.sshKeyIds || '',
      sshKeyFingerprint: state.infrastructure?.sshKeyFingerprint || '',
    },
    domain: {
      zoneId: state.domain?.zoneId || '',
      nameservers: state.domain?.nameservers || '',
      registration: {
        provider: state.domain?.registration?.provider || '',
        domain: state.domain?.registration?.domain || '',
        costUsd: state.domain?.registration?.costUsd || '',
        orderId: state.domain?.registration?.orderId || '',
        nameserversBound: state.domain?.registration?.nameserversBound || '',
      },
    },
    dns: {
      production: {
        hostname: state.dns?.production?.hostname || '',
        recordId: state.dns?.production?.recordId || '',
        target: state.dns?.production?.target || '',
      },
    },
    deploymentUrl: state.deploymentUrl || '',
    github: {
      repoUrl: state.github?.repoUrl || '',
    },
    lastRun,
  };
}

function normalizeState(state, manifest) {
  return {
    version: 1,
    appId: manifest.app.id,
    createdAt: state.createdAt || nowIso(),
    updatedAt: state.updatedAt || nowIso(),
    completedSteps: Array.isArray(state.completedSteps) ? state.completedSteps : [],
    resources: state.resources && typeof state.resources === 'object' ? state.resources : {},
    infrastructure: state.infrastructure && typeof state.infrastructure === 'object' ? state.infrastructure : {},
    domain: state.domain && typeof state.domain === 'object' ? state.domain : {},
    dns: state.dns && typeof state.dns === 'object' ? state.dns : {},
    deploymentUrl: typeof state.deploymentUrl === 'string' ? state.deploymentUrl : '',
    github: state.github && typeof state.github === 'object' ? state.github : {},
    runs: Array.isArray(state.runs) ? state.runs : [],
  };
}

function countRunResults(results) {
  const counts = { total: results.length };
  for (const result of results) {
    const status = result.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function compactError(error) {
  const value = String(error || '').replace(/\s+/g, ' ').trim();
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}
