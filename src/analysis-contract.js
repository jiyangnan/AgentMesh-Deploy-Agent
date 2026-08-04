import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { operationError } from './errors.js';

export function fingerprintAnalysis(analysis) {
  const value = structuredClone(analysis);
  delete value.fingerprint;
  delete value.createdAt;
  delete value.runId;
  delete value.workspace;
  delete value.repositoryGuard;
  delete value.analysisFile;
  delete value.runFile;
  if (value.detection) delete value.detection.root;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function readProjectAnalysis(project) {
  const file = project.lastAnalysis?.analysisFile;
  if (!file || !fs.existsSync(file)) {
    throw operationError('NOT_FOUND', `Project has no external analysis. Run: agentmesh-deploy analyze ${project.id}`);
  }
  let analysis;
  try {
    analysis = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Project analysis JSON is invalid: ${error.message}`);
  }
  if (analysis.projectId !== project.id || analysis.sourceRef?.lockedCommit !== project.source.commit) {
    throw operationError('CONFLICT', `Project analysis is stale or belongs to another source: ${project.id}`);
  }
  if (!analysis.fingerprint || analysis.fingerprint !== fingerprintAnalysis(analysis)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Project analysis fingerprint mismatch. Re-run: agentmesh-deploy analyze ${project.id}`);
  }
  return analysis;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
