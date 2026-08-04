import path from 'node:path';

import { CONFIG_DIR } from './manifest.js';
import { runsDir, summarizeDeployState } from './state.js';
import { nowIso, pathExists, readJson } from './utils.js';

export function buildRunsReport(root, state, options = {}) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const latest = options.latestRun ? runs.at(-1) : null;
  const selectedId = options.runId || latest?.id || '';
  const selectedSummary = selectedId ? runs.find((run) => run.id === selectedId) : null;
  const selectedRun = selectedId ? readRunArtifact(root, selectedId, selectedSummary) : null;
  const limit = options.limit || 10;

  return {
    version: 1,
    generatedAt: nowIso(),
    appId: state.appId || '',
    state: summarizeDeployState(state),
    runs: runs.slice(-limit).reverse(),
    selectedRun,
  };
}

function readRunArtifact(root, runId, summary) {
  const file = summary?.file || `runs/${runId}.json`;
  const artifactPath = resolveRunArtifactPath(root, file);
  if (!artifactPath) {
    return {
      id: runId,
      status: 'missing',
      error: `Run artifact path is outside ${CONFIG_DIR}/runs.`,
    };
  }
  if (!pathExists(artifactPath)) {
    return {
      id: runId,
      status: 'missing',
      file,
      error: `Run artifact not found: ${path.join(CONFIG_DIR, file)}`,
    };
  }
  return {
    status: 'loaded',
    file,
    artifact: readJson(artifactPath),
  };
}

function resolveRunArtifactPath(root, file) {
  const runRoot = path.resolve(runsDir(root));
  const artifactPath = path.resolve(root, CONFIG_DIR, file);
  if (artifactPath !== runRoot && !artifactPath.startsWith(`${runRoot}${path.sep}`)) {
    return '';
  }
  return artifactPath;
}
