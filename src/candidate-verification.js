import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { withControlLockAsync } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export async function verifyCandidate(options) {
  if (!options.yes || options.allowNetwork !== true) {
    throw operationError('APPROVAL_REQUIRED', 'Candidate verification requires explicit --allow-network --yes.');
  }
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'candidate-verify', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    const deployment = readExternalDeployment(home, project.id);
    const candidate = deployment.state.nodes?.['candidate.deploy'];
    if (candidate?.status !== 'succeeded' || candidate.graphId !== graph.id || !candidate.resultRef) {
      throw operationError('VERIFICATION_FAILED', 'Candidate deployment must succeed for the current Graph before verification.');
    }
    const target = normalizeCandidateUrl(candidate.resultData?.deployment?.url, configuration);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw operationError('CAPABILITY_MISSING', 'Candidate verification requires fetch.');
    let response;
    try {
      response = await fetchImpl(target.url, {
        method: 'GET', redirect: 'manual',
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.1', 'user-agent': 'AgentMesh-Deploy-Candidate-Verifier/1' },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(options.timeoutMs || 15000) : undefined,
      });
    } catch (error) {
      throw operationError('VERIFICATION_FAILED', `Candidate HTTPS request failed: ${safeMessage(error.message)}`);
    } finally {
      // Response bodies are never persisted or inspected by this release-level probe.
    }
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      try { await response?.body?.cancel?.(); } catch {}
      throw operationError('VERIFICATION_FAILED', `Candidate HTTPS returned status ${response?.status || 0}.`);
    }
    const responseUrl = response.url ? new URL(response.url) : new URL(target.url);
    if (responseUrl.protocol !== 'https:' || responseUrl.hostname !== target.hostname || responseUrl.port) {
      try { await response?.body?.cancel?.(); } catch {}
      throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification response escaped the approved HTTPS host.');
    }
    const observedAt = options.now || nowIso();
    const base = {
      version: 1,
      kind: 'CandidateVerificationEvidence',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      candidateResultRef: candidate.resultRef,
      url: target.url,
      hostname: target.hostname,
      statusCode: response.status,
      contentType: safeHeader(response.headers?.get?.('content-type')),
      verifiedChecks: ['https', 'exact-candidate-host', 'release-endpoint-2xx'],
      createdAt: observedAt,
    };
    const fingerprint = evidenceFingerprint(base);
    let evidence = {
      ...base,
      id: `candidate-verification-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    const evidenceFile = path.join(projectPath(home, project.id), 'evidence', 'candidate', `${evidence.id}.json`);
    let reused = false;
    if (fs.existsSync(evidenceFile)) {
      const existing = readCandidateVerificationEvidence(evidenceFile, { project, graph, configuration, candidate });
      if (existing.fingerprint !== evidence.fingerprint) throw operationError('CONFLICT', `Candidate Verification ID collision: ${evidence.id}`);
      evidence = existing;
      reused = true;
    } else {
      writeJsonAtomic(evidenceFile, evidence);
    }
    try { await response.body?.cancel?.(); } catch {}
    const state = persistCandidateVerification(deployment, graph, evidence, evidenceFile, observedAt);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'candidate-verification', operation: 'verify', status: 'succeeded', home,
      projectId: project.id, evidence, evidenceFile, state, reused, repositoryGuard,
      providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function validateCandidateVerificationEvidence(evidence, expected = {}) {
  const issues = [];
  if (evidence?.version !== 1 || evidence?.kind !== 'CandidateVerificationEvidence') issues.push('kind|version');
  if (!/^candidate-verification-[a-f0-9]{24}$/.test(evidence?.id || '') || !SHA256.test(evidence?.fingerprint || '')) issues.push('id|fingerprint');
  if (expected.project && evidence?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (evidence?.graphId !== expected.graph.id || evidence?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    evidence?.configurationId !== expected.configuration.id ||
    evidence?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  if (expected.candidate && evidence?.candidateResultRef !== expected.candidate.resultRef) issues.push('candidateResultRef');
  if (expected.candidate && expected.configuration) {
    const target = normalizeCandidateUrl(expected.candidate.resultData?.deployment?.url, expected.configuration);
    if (evidence?.url !== target.url || evidence?.hostname !== target.hostname) issues.push('candidateUrl');
  }
  if (!Number.isInteger(evidence?.statusCode) || evidence.statusCode < 200 || evidence.statusCode >= 300 ||
    !Array.isArray(evidence?.verifiedChecks) ||
    !['https', 'exact-candidate-host', 'release-endpoint-2xx'].every((check) => evidence.verifiedChecks.includes(check))) {
    issues.push('result');
  }
  if (issues.length > 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Candidate Verification Evidence is invalid at: ${issues.join(', ')}`);
  const actual = evidenceFingerprint(evidence);
  if (evidence.fingerprint !== actual || evidence.id !== `candidate-verification-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Candidate Verification Evidence fingerprint mismatch: ${evidence.id}`);
  }
  return evidence;
}

function normalizeCandidateUrl(value, configuration) {
  let url;
  try { url = new URL(String(value).startsWith('http') ? value : `https://${value}`); }
  catch { throw operationError('VALIDATION_FAILED', 'Candidate deployment URL is invalid.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification allows only a root HTTPS URL without credentials, port, query, or fragment.');
  }
  if (url.hostname === configuration.domain.webHostname || isPrivateHost(url.hostname)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification cannot target the production hostname, localhost, or a private address.');
  }
  if (!isProviderCandidateHost(url.hostname, configuration.runtime.provider)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `Candidate verification host is outside the approved ${configuration.runtime.provider} candidate domain.`);
  }
  return { url: url.toString(), hostname: url.hostname };
}

function isProviderCandidateHost(hostname, provider) {
  if (provider === 'vercel') return hostname.endsWith('.vercel.app');
  if (provider === 'railway') return hostname.endsWith('.up.railway.app') || hostname.endsWith('.railway.app');
  return false;
}

function persistCandidateVerification(deployment, graph, evidence, evidenceFile, now) {
  const state = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    nodes: {
      ...deployment.state.nodes,
      'candidate.verify': {
        ...(deployment.state.nodes?.['candidate.verify'] || {}),
        status: 'succeeded', graphId: graph.id, resultRef: evidenceFile,
        resultData: { evidenceId: evidence.id, fingerprint: evidence.fingerprint, url: evidence.url },
        updatedAt: now,
      },
    },
  };
  validateDeploymentStateV2(state, deployment.state.projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, state);
  return state;
}

export function readCandidateVerificationEvidence(file, expected) {
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Candidate Verification Evidence JSON is invalid: ${error.message}`); }
  return validateCandidateVerificationEvidence(evidence, expected);
}

function evidenceFingerprint(evidence) {
  const value = structuredClone(evidence);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}
function isPrivateHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') || hostname === '::1' ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
}
function safeHeader(value) { return String(value || '').replace(/[\r\n]/g, '').slice(0, 256); }
function safeMessage(value) { return String(value || 'network error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
