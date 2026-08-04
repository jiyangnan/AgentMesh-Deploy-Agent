import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { withControlLock, withControlLockAsync } from './control-lock.js';
import { authorizeDatabaseVerificationRuntimeProfile } from './database-runtime-profile.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue } from './provider-contract.js';
import { createFixedHostFetch } from './provider-http.js';
import {
  executePostgresQuery,
  normalizePostgresAllowedHosts,
  normalizePostgresTimeout,
  resolvePostgresSession,
  runPsqlCommand,
} from './postgres-migration-runtime.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { createSecretRuntime } from './secret-store.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^verification-plan-[a-f0-9]{24}$/;
const EVIDENCE_ID = /^product-verification-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SECRET_REF = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._\/-]+)$/;
const CHECK_ID = /^(candidate|production)\.[a-z0-9][a-z0-9._-]{0,126}$/;
const CONTRACT_CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CONTENT_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PHASES = new Set(['candidate', 'production']);
const MODES = new Set(['http', 'control', 'runtime', 'human']);
const CAPABILITIES = new Set([
  'https', 'api', 'release', 'database', 'auth', 'email-domain', 'email-delivery', 'rollback',
]);
const PLAN_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'configurationId', 'configurationFingerprint', 'contractId', 'requirements', 'checks', 'createdAt',
];
const CHECK_KEYS = [
  'id', 'contractCheckId', 'phase', 'capability', 'mode', 'required', 'method', 'path',
  'expectedStatuses', 'expectedContentTypes', 'timeoutMs', 'secretRefs', 'handoff',
];
const EVIDENCE_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'configurationId', 'configurationFingerprint', 'planId', 'planFingerprint', 'phase', 'target',
  'status', 'checks', 'createdAt',
];
const RESULT_KEYS = [
  'id', 'contractCheckId', 'capability', 'mode', 'required', 'status', 'reasonCode',
  'latencyMs', 'statusCode', 'contentType', 'evidenceRefs', 'handoff',
];

export function createProductVerificationPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'product-verification-plan-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    const deployment = readExternalDeployment(home, project.id);
    const spec = normalizeSpec(options.spec || {}, deployment.manifest);
    const requirements = {
      runtime: true,
      api: Boolean(spec.api.path),
      database: Boolean(deployment.manifest.requirements?.database),
      auth: Boolean(deployment.manifest.requirements?.auth),
      email: Boolean(deployment.manifest.requirements?.email),
      rollback: true,
    };
    const base = {
      schemaVersion: 1,
      kind: 'ProductVerificationPlan',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      contractId: String(deployment.manifest.verification?.contractId || 'saas-production-v1'),
      requirements,
      checks: buildChecks(spec, requirements, configuration),
      createdAt: options.now || nowIso(),
    };
    const fingerprint = productVerificationPlanFingerprint(base);
    let plan = {
      ...base,
      id: `verification-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateProductVerificationPlan(plan, {
      projectId: project.id, graph, configuration, requirements,
    });
    const directory = path.join(projectPath(home, project.id), 'verification-plans');
    const planFile = path.join(directory, `${plan.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'verification-plan.json');
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readPlanFile(planFile, { projectId: project.id, graph, configuration, requirements });
      if (existing.fingerprint !== plan.fingerprint) {
        throw operationError('CONFLICT', `Product Verification Plan ID collision: ${plan.id}`);
      }
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    writeJsonAtomic(currentFile, plan);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'product-verification-plan', operation: 'create', status: 'succeeded', home,
      projectId: project.id, plan, planFile, currentFile, reused, repositoryGuard,
      networkRequestsExecuted: 0, providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function showProductVerificationPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
  }).configuration;
  const manifest = readExternalDeployment(home, project.id).manifest;
  const requirements = {
    runtime: true,
    api: undefined,
    database: Boolean(manifest.requirements?.database),
    auth: Boolean(manifest.requirements?.auth),
    email: Boolean(manifest.requirements?.email),
    rollback: true,
  };
  const planFile = options.planId
    ? productVerificationPlanPath(home, project.id, options.planId)
    : path.join(projectPath(home, project.id), 'verification-plan.json');
  if (!fs.existsSync(planFile)) throw operationError('NOT_FOUND', `Product Verification Plan not found: ${planFile}`);
  const plan = readPlanFile(planFile, { projectId: project.id, graph, configuration, requirements });
  return { kind: 'product-verification-plan', operation: 'read', home, projectId: project.id, plan, planFile };
}

export function showProductVerificationEvidence(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  if (!EVIDENCE_ID.test(options.evidenceId || '')) {
    throw operationError('VALIDATION_FAILED', 'Product Verification Evidence id is invalid.');
  }
  const evidenceFile = path.join(
    projectPath(home, project.id), 'evidence', 'product-verification', `${options.evidenceId}.json`
  );
  if (!fs.existsSync(evidenceFile)) {
    throw operationError('NOT_FOUND', `Product Verification Evidence not found: ${options.evidenceId}`);
  }
  const shell = readProductVerificationEvidence(evidenceFile);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: shell.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: shell.configurationId,
  }).configuration;
  const plan = showProductVerificationPlan({
    home, projectId: project.id, graphId: graph.id,
    configurationId: configuration.id, planId: shell.planId,
  }).plan;
  const evidence = readProductVerificationEvidence(evidenceFile, { project, graph, configuration, plan });
  return {
    kind: 'product-verification', operation: 'read-evidence', home, projectId: project.id,
    plan, evidence, evidenceFile,
  };
}

export async function runProductVerification(options) {
  if (!options.yes || options.allowNetwork !== true) {
    throw operationError('APPROVAL_REQUIRED', 'Product verification requires explicit --allow-network --yes.');
  }
  if (!PHASES.has(options.phase)) throw operationError('VALIDATION_FAILED', 'Product verification phase must be candidate or production.');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'product-verification-run', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    const deployment = readExternalDeployment(home, project.id);
    const plan = showProductVerificationPlan({
      home, projectId: project.id, graphId: graph.id, configurationId: configuration.id, planId: options.planId,
    }).plan;
    const target = verificationTarget(options.phase, deployment.state, graph, configuration);
    if (options.phase === 'production') {
      await assertPublicResolution(target.hostname, options.resolveHost);
    }
    const phaseChecks = plan.checks.filter((check) => check.phase === options.phase);
    const emailDelivery = options.phase === 'production' && options.emailDeliveryRunId
      ? await loadEmailDeliveryEvidence({
          home, project, graph, configuration, plan, runId: options.emailDeliveryRunId,
      })
      : null;
    const verificationRuntime = buildVerificationRuntime({
      ...options, home, project, graph, configuration, plan,
    });
    const baseFetch = options.fetchImpl || globalThis.fetch;
    const context = {
      project, graph, configuration, deployment, target,
      fetchImpl: options.fetchImpl || (typeof baseFetch === 'function'
        ? createFixedHostFetch([target.hostname], baseFetch)
        : baseFetch),
      runtime: verificationRuntime,
      emailDelivery,
      timeoutMs: options.timeoutMs,
      nowMs: options.nowMs || (() => Date.now()),
    };
    const results = [];
    let networkRequestsExecuted = 0;
    for (const check of phaseChecks) {
      const executed = await executeCheck(check, context);
      results.push(executed.result);
      networkRequestsExecuted += executed.networkRequestsExecuted;
    }
    const status = overallStatus(results);
    const createdAt = options.now || nowIso();
    const base = {
      schemaVersion: 1,
      kind: 'ProductVerificationEvidence',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      phase: options.phase,
      target,
      status,
      checks: results,
      createdAt,
    };
    const fingerprint = productVerificationEvidenceFingerprint(base);
    let evidence = {
      ...base,
      id: `product-verification-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateProductVerificationEvidence(evidence, { project, graph, configuration, plan, target });
    const evidenceDirectory = path.join(projectPath(home, project.id), 'evidence', 'product-verification');
    const evidenceFile = path.join(evidenceDirectory, `${evidence.id}.json`);
    let reused = false;
    if (fs.existsSync(evidenceFile)) {
      const existing = readProductVerificationEvidence(evidenceFile, { project, graph, configuration, plan, target });
      if (existing.fingerprint !== evidence.fingerprint) {
        throw operationError('CONFLICT', `Product Verification Evidence ID collision: ${evidence.id}`);
      }
      evidence = existing;
      reused = true;
    } else {
      writeJsonAtomic(evidenceFile, evidence);
    }
    const state = persistVerificationState(deployment, graph, plan, evidence, evidenceFile, createdAt);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'product-verification', operation: 'run', status, home, projectId: project.id,
      plan, evidence, evidenceFile, state, reused, repositoryGuard, networkRequestsExecuted,
      providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function validateProductVerificationPlan(plan, expected = {}) {
  const issues = [];
  exactKeys(plan, PLAN_KEYS, '$', issues);
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'ProductVerificationPlan') issues.push('kind|schemaVersion');
  if (!PLAN_ID.test(plan?.id || '') || !SHA256.test(plan?.fingerprint || '')) issues.push('id|fingerprint');
  if (!isDate(plan?.createdAt)) issues.push('createdAt');
  if (!CONTRACT_CHECK_ID.test(plan?.contractId || '')) issues.push('contractId');
  if (expected.projectId && plan?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.graph && (plan?.graphId !== expected.graph.id || plan?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    plan?.configurationId !== expected.configuration.id ||
    plan?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  validateRequirements(plan?.requirements, expected.requirements, issues);
  if (!Array.isArray(plan?.checks) || plan.checks.length < 2 || plan.checks.length > 32) issues.push('checks');
  const ids = new Set();
  for (const [index, check] of (plan?.checks || []).entries()) {
    validatePlanCheck(check, index, issues);
    if (ids.has(check?.id)) issues.push(`checks[${index}].id(duplicate)`);
    ids.add(check?.id);
  }
  const httpChecks = (plan?.checks || []).filter((check) => check?.mode === 'http');
  const protectedHttpChecks = httpChecks.filter((check) => check.secretRefs?.length > 0);
  const protectedHttpRefs = new Set(protectedHttpChecks.flatMap((check) => check.secretRefs || []));
  if (protectedHttpChecks.length > 0 && (
    protectedHttpChecks.length !== httpChecks.length || protectedHttpRefs.size !== 1
  )) issues.push('checks.httpProtection.binding');
  if (protectedHttpChecks.length > 0 && expected.configuration?.runtime?.provider !== 'vercel') {
    issues.push('checks.httpProtection.provider');
  }
  validateCoverage(plan, issues);
  throwIntegrityOrValidation('Product Verification Plan', issues);
  const actual = productVerificationPlanFingerprint(plan);
  if (plan.fingerprint !== actual || plan.id !== `verification-plan-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Plan fingerprint mismatch: ${plan.id}`);
  }
  return plan;
}

export function validateProductVerificationEvidence(evidence, expected = {}) {
  const issues = [];
  exactKeys(evidence, EVIDENCE_KEYS, '$', issues);
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== 'ProductVerificationEvidence') issues.push('kind|schemaVersion');
  if (!EVIDENCE_ID.test(evidence?.id || '') || !SHA256.test(evidence?.fingerprint || '')) issues.push('id|fingerprint');
  if (!PHASES.has(evidence?.phase) || !['passed', 'failed', 'needs-human'].includes(evidence?.status)) issues.push('phase|status');
  if (!isDate(evidence?.createdAt)) issues.push('createdAt');
  if (expected.project && evidence?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (evidence?.graphId !== expected.graph.id || evidence?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    evidence?.configurationId !== expected.configuration.id ||
    evidence?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  if (expected.plan && (
    evidence?.planId !== expected.plan.id || evidence?.planFingerprint !== expected.plan.fingerprint
  )) issues.push('plan');
  validateTarget(evidence?.target, evidence?.phase, issues);
  if (expected.target && stableStringify(evidence?.target) !== stableStringify(expected.target)) issues.push('target(binding)');
  const planChecks = new Map((expected.plan?.checks || []).filter((item) => item.phase === evidence?.phase).map((item) => [item.id, item]));
  if (!Array.isArray(evidence?.checks) || evidence.checks.length === 0 ||
    (expected.plan && evidence.checks.length !== planChecks.size)) issues.push('checks');
  const ids = new Set();
  for (const [index, result] of (evidence?.checks || []).entries()) {
    validateEvidenceResult(result, index, issues);
    if (ids.has(result?.id)) issues.push(`checks[${index}].id(duplicate)`);
    ids.add(result?.id);
    const check = planChecks.get(result?.id);
    if (expected.plan && (!check || !sameResultContract(result, check))) issues.push(`checks[${index}].planBinding`);
  }
  if (evidence?.status !== overallStatus(evidence?.checks || [])) issues.push('status(semantic)');
  throwIntegrityOrValidation('Product Verification Evidence', issues);
  const actual = productVerificationEvidenceFingerprint(evidence);
  if (evidence.fingerprint !== actual || evidence.id !== `product-verification-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Evidence fingerprint mismatch: ${evidence.id}`);
  }
  return evidence;
}

export function readProductVerificationEvidence(file, expected = {}) {
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Evidence JSON is invalid: ${safeMessage(error.message)}`);
  }
  try {
    return validateProductVerificationEvidence(evidence, expected);
  } catch (error) {
    if (error?.code === 'VALIDATION_FAILED') {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Evidence failed integrity validation: ${safeMessage(error.message)}`);
    }
    throw error;
  }
}

export function readProductVerificationSpecFile(file) {
  const resolved = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw operationError('NOT_FOUND', `Product Verification spec file not found: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operationError('VALIDATION_FAILED', 'Product Verification spec must be a regular non-symlink file.');
  }
  if (stat.size > 1024 * 1024) throw operationError('VALIDATION_FAILED', 'Product Verification spec exceeds 1 MiB.');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Product Verification spec JSON is invalid: ${safeMessage(error.message)}`); }
  if (!isObject(spec)) throw operationError('VALIDATION_FAILED', 'Product Verification spec must be a JSON object.');
  return { spec, specFile: resolved };
}

export function productVerificationPlanFingerprint(plan) {
  return fingerprintWithout(plan, ['id', 'fingerprint', 'createdAt']);
}

export function productVerificationEvidenceFingerprint(evidence) {
  return fingerprintWithout(evidence, ['id', 'fingerprint', 'createdAt']);
}

function normalizeSpec(input, manifest) {
  if (!isObject(input)) throw operationError('VALIDATION_FAILED', 'Product Verification spec must be an object.');
  if (containsSecretLikeValue(input)) {
    throw operationError('VALIDATION_FAILED', 'Product Verification spec contains a secret-like value; use Secret Refs only.');
  }
  assertKeys(input, ['api', 'auth', 'email', 'httpProtection', 'rollback'], '$');
  const api = object(input.api);
  const auth = object(input.auth);
  const email = object(input.email);
  const httpProtection = object(input.httpProtection);
  const rollback = object(input.rollback);
  assertKeys(api, ['path', 'expectedStatuses', 'expectedContentTypes'], '$.api');
  assertKeys(auth, ['callbackPath', 'callbackExpectedStatuses', 'productionMode', 'testAccountSecretRefs', 'handoff'], '$.auth');
  assertKeys(email, ['recipientSecretRef'], '$.email');
  assertKeys(httpProtection, ['provider', 'secretRef'], '$.httpProtection');
  assertKeys(rollback, ['mode', 'handoff'], '$.rollback');
  const protectionSecretRef = String(httpProtection.secretRef || '');
  const protectionProvider = String(httpProtection.provider || '');
  const normalized = {
    api: {
      path: normalizePath(api.path || ''),
      expectedStatuses: statuses(api.expectedStatuses, [200]),
      expectedContentTypes: contentTypes(api.expectedContentTypes, ['application/json']),
    },
    auth: {
      callbackPath: normalizePath(auth.callbackPath || ''),
      callbackExpectedStatuses: statuses(auth.callbackExpectedStatuses, [200, 401]),
      productionMode: String(auth.productionMode || 'human'),
      testAccountSecretRefs: secretRefs(auth.testAccountSecretRefs || []),
      handoff: safeText(auth.handoff || 'complete-real-login-and-callback', 256),
    },
    email: { recipientSecretRef: String(email.recipientSecretRef || '') },
    httpProtection: {
      provider: protectionProvider,
      secretRef: protectionSecretRef,
    },
    rollback: {
      mode: String(rollback.mode || 'human'),
      handoff: safeText(rollback.handoff || 'approve-and-run-rollback-drill', 256),
    },
  };
  if (!['human', 'runtime'].includes(normalized.auth.productionMode)) {
    throw operationError('VALIDATION_FAILED', '$.auth.productionMode must be human or runtime.');
  }
  if (!['human', 'runtime'].includes(normalized.rollback.mode)) {
    throw operationError('VALIDATION_FAILED', '$.rollback.mode must be human or runtime.');
  }
  if (Boolean(protectionProvider) !== Boolean(protectionSecretRef) ||
    (protectionProvider && protectionProvider !== 'vercel') ||
    (protectionSecretRef && !SECRET_REF.test(protectionSecretRef))) {
    throw operationError('VALIDATION_FAILED', '$.httpProtection requires provider vercel and one valid Secret Ref.');
  }
  if (protectionProvider && manifest.providers?.runtime !== protectionProvider) {
    throw operationError('VALIDATION_FAILED', '$.httpProtection provider must match the configured runtime provider.');
  }
  if (manifest.requirements?.auth && normalized.auth.productionMode === 'runtime' && normalized.auth.testAccountSecretRefs.length === 0) {
    throw operationError('VALIDATION_FAILED', 'Runtime auth verification requires testAccountSecretRefs.');
  }
  if (manifest.requirements?.email && !SECRET_REF.test(normalized.email.recipientSecretRef)) {
    throw operationError('VALIDATION_FAILED', 'Email delivery verification requires recipientSecretRef.');
  }
  return normalized;
}

function buildChecks(spec, requirements, configuration) {
  const checks = [];
  const httpSecretRefs = spec.httpProtection.secretRef ? [spec.httpProtection.secretRef] : [];
  const add = (value) => checks.push({
    required: true, method: null, path: '', expectedStatuses: [], expectedContentTypes: [],
    timeoutMs: 15000, secretRefs: [], handoff: '', ...value,
  });
  for (const phase of ['candidate', 'production']) {
    add({
      id: `${phase}.runtime.https`, contractCheckId: 'runtime.https', phase, capability: 'https', mode: 'http',
      method: 'GET', path: '/', expectedStatuses: [200], expectedContentTypes: ['text/html', 'application/json'],
      secretRefs: httpSecretRefs,
    });
    if (requirements.api) {
      add({
        id: `${phase}.runtime.api`, contractCheckId: 'runtime.api', phase, capability: 'api', mode: 'http',
        method: 'GET', path: spec.api.path, expectedStatuses: spec.api.expectedStatuses,
        expectedContentTypes: spec.api.expectedContentTypes,
        secretRefs: httpSecretRefs,
      });
    }
  }
  add({
    id: 'candidate.runtime.release', contractCheckId: 'runtime.release', phase: 'candidate',
    capability: 'release', mode: 'control',
  });
  add({
    id: 'production.runtime.release', contractCheckId: 'runtime.release', phase: 'production',
    capability: 'release', mode: 'control',
  });
  if (requirements.database) {
    add({
      id: 'candidate.database.schema', contractCheckId: 'database.schema', phase: 'candidate',
      capability: 'database', mode: 'control',
    });
    add({
      id: 'production.database.connectivity', contractCheckId: 'database.connectivity', phase: 'production',
      capability: 'database', mode: 'runtime',
      secretRefs: configuration.database.connectionSecretRef ? [configuration.database.connectionSecretRef] : [],
    });
  }
  if (requirements.auth) {
    add(spec.auth.callbackPath ? {
      id: 'candidate.auth.callback', contractCheckId: 'auth.callback', phase: 'candidate',
      capability: 'auth', mode: 'http', method: 'GET', path: spec.auth.callbackPath,
      expectedStatuses: spec.auth.callbackExpectedStatuses, expectedContentTypes: [],
      secretRefs: httpSecretRefs,
    } : {
      id: 'candidate.auth.callback', contractCheckId: 'auth.callback', phase: 'candidate',
      capability: 'auth', mode: 'human', handoff: 'confirm-auth-callback-configuration',
    });
    add({
      id: 'production.auth.real-login', contractCheckId: 'auth.real-login', phase: 'production',
      capability: 'auth', mode: spec.auth.productionMode,
      secretRefs: spec.auth.productionMode === 'runtime' ? spec.auth.testAccountSecretRefs : [],
      handoff: spec.auth.handoff,
    });
  }
  if (requirements.email) {
    add({
      id: 'production.email.domain', contractCheckId: 'email.domain', phase: 'production',
      capability: 'email-domain', mode: 'control',
    });
    add({
      id: 'production.email.delivery', contractCheckId: 'email.delivery', phase: 'production',
      capability: 'email-delivery', mode: 'runtime', secretRefs: [spec.email.recipientSecretRef],
    });
  }
  add({
    id: 'production.operations.rollback', contractCheckId: 'operations.rollback', phase: 'production',
    capability: 'rollback', mode: spec.rollback.mode, handoff: spec.rollback.handoff,
  });
  return checks.sort((left, right) => left.id.localeCompare(right.id));
}

async function executeCheck(check, context) {
  if (check.mode === 'human') {
    return { result: resultFor(check, { status: 'needs-human', reasonCode: 'HUMAN_ACTION_REQUIRED', handoff: check.handoff }), networkRequestsExecuted: 0 };
  }
  if (check.mode === 'control') {
    return { result: executeControlCheck(check, context), networkRequestsExecuted: 0 };
  }
  if (check.mode === 'runtime') {
    return executeRuntimeCheck(check, context);
  }
  return executeHttpCheck(check, context);
}

async function executeHttpCheck(check, context) {
  if (typeof context.fetchImpl !== 'function') {
    return {
      result: resultFor(check, { status: 'failed', reasonCode: 'CAPABILITY_MISSING' }),
      networkRequestsExecuted: 0,
    };
  }
  const url = new URL(check.path, context.target.url);
  if (url.protocol !== 'https:' || url.hostname !== context.target.hostname || url.port || url.username || url.password || url.search || url.hash) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `Verification check ${check.id} escaped the approved HTTPS origin.`);
  }
  const started = context.nowMs();
  let protectionHeaders = {};
  if (check.secretRefs.length > 0) {
    if (typeof context.runtime?.httpProtectionHeaders !== 'function') {
      return {
        result: resultFor(check, { status: 'failed', reasonCode: 'CAPABILITY_MISSING' }),
        networkRequestsExecuted: 0,
      };
    }
    try {
      protectionHeaders = await context.runtime.httpProtectionHeaders(structuredClone(check));
    } catch {
      return {
        result: resultFor(check, { status: 'failed', reasonCode: 'PROTECTION_CREDENTIAL_FAILED' }),
        networkRequestsExecuted: 0,
      };
    }
  }
  let response;
  try {
    response = await context.fetchImpl(url.toString(), {
      method: check.method,
      redirect: 'manual',
      headers: {
        accept: check.expectedContentTypes.length > 0 ? check.expectedContentTypes.join(',') : '*/*',
        'user-agent': 'AgentMesh-Deploy-Product-Verifier/1',
        ...protectionHeaders,
      },
      signal: typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(context.timeoutMs || check.timeoutMs)
        : undefined,
    });
    const latencyMs = elapsed(started, context.nowMs());
    const statusCode = Number.isInteger(response?.status) ? response.status : null;
    const contentType = normalizeContentType(response?.headers?.get?.('content-type'));
    const responseUrl = response?.url ? new URL(response.url) : url;
    const sameTarget = responseUrl.protocol === 'https:' && responseUrl.hostname === context.target.hostname &&
      !responseUrl.port && !responseUrl.username && !responseUrl.password;
    const statusPassed = statusCode !== null && check.expectedStatuses.includes(statusCode);
    const contentPassed = check.expectedContentTypes.length === 0 ||
      check.expectedContentTypes.some((expected) => contentType === expected);
    if (!sameTarget) return httpResult(check, { status: 'failed', reasonCode: 'TARGET_BOUNDARY_VIOLATION', latencyMs, statusCode, contentType });
    if (!statusPassed) return httpResult(check, { status: 'failed', reasonCode: 'HTTP_STATUS_MISMATCH', latencyMs, statusCode, contentType });
    if (!contentPassed) return httpResult(check, { status: 'failed', reasonCode: 'CONTENT_TYPE_MISMATCH', latencyMs, statusCode, contentType });
    return httpResult(check, { status: 'passed', reasonCode: 'CHECK_PASSED', latencyMs, statusCode, contentType });
  } catch (error) {
    return httpResult(check, {
      status: 'failed', reasonCode: error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NETWORK_REQUEST_FAILED',
      latencyMs: elapsed(started, context.nowMs()),
    });
  } finally {
    try { await response?.body?.cancel?.(); } catch {}
  }
}

function httpResult(check, value) {
  return { result: resultFor(check, value), networkRequestsExecuted: 1 };
}

function executeControlCheck(check, context) {
  const nodes = context.deployment.state.nodes || {};
  const current = (id) => nodes[id]?.status === 'succeeded' && nodes[id]?.graphId === context.graph.id && Boolean(nodes[id]?.resultRef);
  if (check.capability === 'release') {
    const nodeId = check.phase === 'candidate' ? 'candidate.deploy' : 'production.dns.apply';
    return resultFor(check, current(nodeId)
      ? { status: 'passed', reasonCode: 'CHECK_PASSED', evidenceRefs: [nodes[nodeId].resultRef] }
      : { status: 'failed', reasonCode: check.phase === 'candidate' ? 'CANDIDATE_RELEASE_MISSING' : 'PRODUCTION_CUTOVER_EVIDENCE_MISSING' });
  }
  if (check.capability === 'database') {
    return resultFor(check, current('database.migrate')
      ? { status: 'passed', reasonCode: 'CHECK_PASSED', evidenceRefs: [nodes['database.migrate'].resultRef] }
      : { status: 'failed', reasonCode: 'DATABASE_MIGRATION_EVIDENCE_MISSING' });
  }
  if (check.capability === 'email-domain') {
    return resultFor(check, current('email.domain.verify')
      ? { status: 'passed', reasonCode: 'CHECK_PASSED', evidenceRefs: [nodes['email.domain.verify'].resultRef] }
      : { status: 'failed', reasonCode: 'EMAIL_DOMAIN_EVIDENCE_MISSING' });
  }
  return resultFor(check, { status: 'failed', reasonCode: 'CAPABILITY_MISSING' });
}

async function executeRuntimeCheck(check, context) {
  if (check.capability === 'email-delivery' && context.emailDelivery) {
    return {
      result: resultFor(check, {
        status: 'passed',
        reasonCode: 'EMAIL_DELIVERY_PASSED',
        evidenceRefs: [context.emailDelivery.runFile],
      }),
      networkRequestsExecuted: 0,
    };
  }
  const key = check.capability === 'email-delivery' ? 'emailDelivery' : check.capability;
  const probe = context.runtime?.[key];
  if (typeof probe !== 'function') {
    return {
      result: resultFor(check, { status: 'failed', reasonCode: 'CAPABILITY_MISSING' }),
      networkRequestsExecuted: 0,
    };
  }
  const started = context.nowMs();
  try {
    const raw = await probe({
      projectId: context.project.id,
      graphId: context.graph.id,
      configurationId: context.configuration.id,
      phase: check.phase,
      check: structuredClone(check),
      target: structuredClone(context.target),
    });
    if (!isObject(raw) || containsSecretLikeValue(raw)) {
      return {
        result: resultFor(check, { status: 'failed', reasonCode: 'UNSAFE_PROBE_RESULT', latencyMs: elapsed(started, context.nowMs()) }),
        networkRequestsExecuted: 0,
      };
    }
    const status = ['passed', 'failed', 'needs-human'].includes(raw.status) ? raw.status : 'failed';
    return {
      result: resultFor(check, {
        status,
        reasonCode: REASON_CODE.test(raw.reasonCode || '')
          ? raw.reasonCode
          : (status === 'passed' ? 'CHECK_PASSED' : (status === 'needs-human' ? 'HUMAN_ACTION_REQUIRED' : 'RUNTIME_CHECK_FAILED')),
        latencyMs: elapsed(started, context.nowMs()),
        evidenceRefs: safeEvidenceRefs(raw.evidenceRefs),
        handoff: safeText(raw.handoff || check.handoff, 256),
      }),
      networkRequestsExecuted: Number.isInteger(raw.networkRequestsExecuted) &&
        raw.networkRequestsExecuted >= 0 && raw.networkRequestsExecuted <= 16
        ? raw.networkRequestsExecuted
        : 0,
    };
  } catch (error) {
    return {
      result: resultFor(check, {
        status: 'failed', reasonCode: 'RUNTIME_CHECK_FAILED', latencyMs: elapsed(started, context.nowMs()),
        handoff: safeMessage(error?.message),
      }),
      networkRequestsExecuted: 0,
    };
  }
}

function buildVerificationRuntime(options) {
  const runtime = { ...(options.runtime || {}) };
  const protectedHttpChecks = options.plan.checks.filter((check) =>
    check.mode === 'http' && check.secretRefs.length > 0
  );
  let secretRuntime = runtime.secretRuntime;
  if (protectedHttpChecks.length > 0) {
    if (options.configuration.runtime.provider !== 'vercel' ||
      new Set(protectedHttpChecks.flatMap((check) => check.secretRefs)).size !== 1) {
      throw operationError('CONFLICT', 'Protected HTTP verification requires one Vercel-bound Secret Ref.');
    }
    secretRuntime ||= createSecretRuntime({
      env: options.env || process.env,
      stores: options.secretStores || {},
      commandRunner: options.commandRunner,
    });
    runtime.httpProtectionHeaders = async (check) => {
      if (check.mode !== 'http' || check.secretRefs.length !== 1 ||
        !protectedHttpChecks.some((planned) => planned.id === check.id &&
          stableStringify(planned.secretRefs) === stableStringify(check.secretRefs))) {
        throw operationError('CONFLICT', 'HTTP protection Secret Ref differs from the immutable Verification Plan.');
      }
      return { 'x-vercel-protection-bypass': await secretRuntime.resolve(check.secretRefs[0]) };
    };
  }
  if (!options.databaseRuntimeProfileId) return runtime;
  if (runtime.database) {
    throw operationError('VALIDATION_FAILED', 'Injected database verification Runtime cannot be combined with a Database Runtime Profile.');
  }
  const profile = authorizeDatabaseVerificationRuntimeProfile({
    home: options.home,
    project: options.project,
    graph: options.graph,
    configuration: options.configuration,
    profileId: options.databaseRuntimeProfileId,
    now: options.now || nowIso(),
  });
  secretRuntime ||= createSecretRuntime({
    env: options.env || process.env,
    stores: options.secretStores || {},
    commandRunner: options.commandRunner,
  });
  runtime.database = createNativeDatabaseConnectivityProbe({
    profile,
    secretRuntime,
    commandRunner: options.databaseCommandRunner || runPsqlCommand,
    timeoutMs: options.timeoutMs,
  });
  return runtime;
}

function createNativeDatabaseConnectivityProbe(options) {
  const allowedHosts = normalizePostgresAllowedHosts(options.profile.allowedHosts);
  const timeoutMs = normalizePostgresTimeout(options.timeoutMs);
  return async ({ check }) => {
    if (stableStringify(check.secretRefs) !== stableStringify([options.profile.connectionSecretRef])) {
      throw operationError('CONFLICT', 'Database connectivity check Secret Ref differs from its Runtime Profile.');
    }
    const session = await resolvePostgresSession(
      options.secretRuntime,
      options.profile.connectionSecretRef,
      allowedHosts,
      { databaseName: options.profile.databaseName }
    );
    const value = String(await executePostgresQuery(
      options.commandRunner,
      session,
      'SELECT 1;',
      timeoutMs
    )).trim();
    if (value !== '1') {
      return {
        status: 'failed',
        reasonCode: 'DATABASE_CONNECTIVITY_FAILED',
        evidenceRefs: [options.profile.id],
        networkRequestsExecuted: 1,
      };
    }
    return {
      status: 'passed',
      reasonCode: 'DATABASE_CONNECTIVITY_PASSED',
      evidenceRefs: [options.profile.id],
      networkRequestsExecuted: 1,
    };
  };
}

async function loadEmailDeliveryEvidence({ home, project, graph, configuration, plan, runId }) {
  const { showEmailDeliveryRun } = await import('./email-delivery-run.js');
  const shown = showEmailDeliveryRun({ home, projectId: project.id, runId });
  if (shown.run.status !== 'succeeded' || shown.run.projectId !== project.id ||
    shown.run.graphId !== graph.id || shown.run.graphFingerprint !== graph.fingerprint ||
    shown.plan.configurationId !== configuration.id ||
    shown.plan.configurationFingerprint !== configuration.fingerprint ||
    shown.plan.verificationPlanId !== plan.id ||
    shown.plan.verificationPlanFingerprint !== plan.fingerprint ||
    shown.plan.emailCheckId !== 'production.email.delivery') {
    throw operationError('VERIFICATION_FAILED', 'Email Delivery Run is not a succeeded exact match for the current Product Verification Plan.');
  }
  const check = plan.checks.find((item) => item.id === 'production.email.delivery');
  if (!check || check.secretRefs.length !== 1 || shown.plan.recipientSecretRef !== check.secretRefs[0]) {
    throw operationError('VERIFICATION_FAILED', 'Email Delivery Run recipient binding differs from the Product Verification Plan.');
  }
  return { run: shown.run, runFile: shown.runFile };
}

function resultFor(check, overrides = {}) {
  return {
    id: check.id,
    contractCheckId: check.contractCheckId,
    capability: check.capability,
    mode: check.mode,
    required: check.required,
    status: 'failed',
    reasonCode: 'CHECK_FAILED',
    latencyMs: 0,
    statusCode: null,
    contentType: '',
    evidenceRefs: [],
    handoff: '',
    ...overrides,
  };
}

function persistVerificationState(deployment, graph, plan, evidence, evidenceFile, now) {
  const nodeId = evidence.phase === 'candidate' ? 'candidate.verify' : 'product.verify';
  const nodeStatus = evidence.status === 'passed'
    ? 'succeeded'
    : (evidence.status === 'needs-human' ? 'blocked' : 'failed-retryable');
  const state = {
    ...deployment.state,
    revision: deployment.state.revision + 1,
    updatedAt: now,
    nodes: {
      ...deployment.state.nodes,
      [nodeId]: {
        ...(deployment.state.nodes?.[nodeId] || {}),
        status: nodeStatus,
        graphId: graph.id,
        resultRef: evidenceFile,
        resultData: {
          evidenceKind: evidence.kind,
          evidenceId: evidence.id,
          fingerprint: evidence.fingerprint,
          planId: plan.id,
          planFingerprint: plan.fingerprint,
          phase: evidence.phase,
          status: evidence.status,
          url: evidence.target.url,
        },
        updatedAt: now,
      },
    },
  };
  validateDeploymentStateV2(state, deployment.state.projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, state);
  return state;
}

function verificationTarget(phase, state, graph, configuration) {
  if (phase === 'production') {
    const cutover = state.nodes?.['production.dns.apply'];
    if (cutover?.status !== 'succeeded' || cutover.graphId !== graph.id || !cutover.resultRef) {
      throw operationError('VERIFICATION_FAILED', 'Production DNS apply must succeed for the current Graph before product verification.');
    }
    const hostname = configuration.domain.webHostname;
    if (isPrivateHostname(hostname)) throw operationError('PATH_BOUNDARY_VIOLATION', 'Production verification cannot target localhost or a private address.');
    return { source: 'production-configuration', url: `https://${hostname}/`, hostname };
  }
  const candidate = state.nodes?.['candidate.deploy'];
  if (candidate?.status !== 'succeeded' || candidate.graphId !== graph.id || !candidate.resultRef) {
    throw operationError('VERIFICATION_FAILED', 'Candidate deployment must succeed for the current Graph before product verification.');
  }
  let url;
  try { url = new URL(String(candidate.resultData?.deployment?.url || '').startsWith('http')
    ? candidate.resultData.deployment.url
    : `https://${candidate.resultData?.deployment?.url || ''}`); }
  catch { throw operationError('VALIDATION_FAILED', 'Candidate deployment URL is invalid.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    isPrivateHostname(url.hostname) || !isProviderCandidateHost(url.hostname, configuration.runtime.provider)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification target is outside the approved provider HTTPS domain.');
  }
  if (url.hostname === configuration.domain.webHostname) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification cannot target the production hostname.');
  }
  return { source: 'candidate-state', url: url.toString(), hostname: url.hostname };
}

export async function assertPublicResolution(hostname, resolveHost) {
  const resolver = resolveHost || (async (host) => dns.lookup(host, { all: true, verbatim: true }));
  let values;
  try { values = await resolver(hostname); }
  catch (error) { throw operationError('VERIFICATION_FAILED', `Production hostname resolution failed: ${safeMessage(error.message)}`); }
  const addresses = (Array.isArray(values) ? values : [values]).map((item) => typeof item === 'string' ? item : item?.address).filter(Boolean);
  if (addresses.length === 0) throw operationError('VERIFICATION_FAILED', 'Production hostname did not resolve to an address.');
  if (addresses.some(isPrivateAddress)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Production hostname resolves to a private, loopback, or link-local address.');
  }
}

function validatePlanCheck(check, index, issues) {
  const prefix = `checks[${index}]`;
  exactKeys(check, CHECK_KEYS, prefix, issues);
  if (!CHECK_ID.test(check?.id || '') || !CONTRACT_CHECK_ID.test(check?.contractCheckId || '')) issues.push(`${prefix}.id`);
  if (!PHASES.has(check?.phase) || !check?.id?.startsWith(`${check.phase}.`)) issues.push(`${prefix}.phase`);
  if (!CAPABILITIES.has(check?.capability) || !MODES.has(check?.mode) || typeof check?.required !== 'boolean') issues.push(`${prefix}.contract`);
  if (!Number.isInteger(check?.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 30000) issues.push(`${prefix}.timeoutMs`);
  if (!Array.isArray(check?.secretRefs) || check.secretRefs.length > 4 || new Set(check.secretRefs).size !== check.secretRefs.length ||
    check.secretRefs.some((value) => !SECRET_REF.test(value))) issues.push(`${prefix}.secretRefs`);
  if (typeof check?.handoff !== 'string' || check.handoff.length > 256) issues.push(`${prefix}.handoff`);
  const http = check?.mode === 'http';
  if (http) {
    if (!['GET', 'HEAD'].includes(check.method) || !validPath(check.path) || !Array.isArray(check.expectedStatuses) ||
      check.expectedStatuses.length === 0 || new Set(check.expectedStatuses).size !== check.expectedStatuses.length ||
      check.expectedStatuses.some((value) => !Number.isInteger(value) || value < 100 || value > 599) ||
      !Array.isArray(check.expectedContentTypes) || check.expectedContentTypes.some((value) => !CONTENT_TYPE.test(value))) {
      issues.push(`${prefix}.http`);
    }
    if (check.secretRefs.length > 1) issues.push(`${prefix}.http.secretRefs`);
  } else if (check?.method !== null || check?.path !== '' || check?.expectedStatuses?.length !== 0 || check?.expectedContentTypes?.length !== 0) {
    issues.push(`${prefix}.nonHttp`);
  }
  if (!['runtime', 'http'].includes(check?.mode) && check?.secretRefs?.length > 0) issues.push(`${prefix}.secretRefs.mode`);
  if (!validCapabilityMode(check)) issues.push(`${prefix}.capabilityMode`);
}

function validateEvidenceResult(result, index, issues) {
  const prefix = `checks[${index}]`;
  exactKeys(result, RESULT_KEYS, prefix, issues);
  if (!CHECK_ID.test(result?.id || '') || !CONTRACT_CHECK_ID.test(result?.contractCheckId || '')) issues.push(`${prefix}.id`);
  if (!CAPABILITIES.has(result?.capability) || !MODES.has(result?.mode) || typeof result?.required !== 'boolean') issues.push(`${prefix}.contract`);
  if (!['passed', 'failed', 'needs-human', 'skipped'].includes(result?.status) || !REASON_CODE.test(result?.reasonCode || '')) issues.push(`${prefix}.status`);
  if (!Number.isInteger(result?.latencyMs) || result.latencyMs < 0 || result.latencyMs > 3600000) issues.push(`${prefix}.latencyMs`);
  if (result?.statusCode !== null && (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599)) issues.push(`${prefix}.statusCode`);
  if (typeof result?.contentType !== 'string' || result.contentType.length > 127) issues.push(`${prefix}.contentType`);
  if (!Array.isArray(result?.evidenceRefs) || result.evidenceRefs.length > 16 || new Set(result.evidenceRefs).size !== result.evidenceRefs.length ||
    result.evidenceRefs.some((value) => typeof value !== 'string' || !value || value.length > 512)) issues.push(`${prefix}.evidenceRefs`);
  if (typeof result?.handoff !== 'string' || result.handoff.length > 256) issues.push(`${prefix}.handoff`);
  if (containsSecretLikeValue(result)) issues.push(`${prefix}.secret`);
}

function validateCoverage(plan, issues) {
  const ids = new Set((plan?.checks || []).map((check) => check.id));
  for (const required of [
    'candidate.runtime.https', 'candidate.runtime.release', 'production.runtime.https',
    'production.runtime.release', 'production.operations.rollback',
  ]) {
    if (!ids.has(required)) issues.push(`checks.coverage.${required}`);
  }
  if (plan?.requirements?.api) for (const id of ['candidate.runtime.api', 'production.runtime.api']) if (!ids.has(id)) issues.push(`checks.coverage.${id}`);
  if (plan?.requirements?.database) for (const id of ['candidate.database.schema', 'production.database.connectivity']) if (!ids.has(id)) issues.push(`checks.coverage.${id}`);
  if (plan?.requirements?.auth) for (const id of ['candidate.auth.callback', 'production.auth.real-login']) if (!ids.has(id)) issues.push(`checks.coverage.${id}`);
  if (plan?.requirements?.email) for (const id of ['production.email.domain', 'production.email.delivery']) if (!ids.has(id)) issues.push(`checks.coverage.${id}`);
  for (const check of plan?.checks || []) {
    if (check.capability === 'api' && !plan.requirements.api) issues.push('checks.api(unexpected)');
    if (check.capability === 'database' && !plan.requirements.database) issues.push('checks.database(unexpected)');
    if (check.capability === 'auth' && !plan.requirements.auth) issues.push('checks.auth(unexpected)');
    if (['email-domain', 'email-delivery'].includes(check.capability) && !plan.requirements.email) issues.push('checks.email(unexpected)');
  }
}

function validateRequirements(value, expected, issues) {
  const keys = ['runtime', 'api', 'database', 'auth', 'email', 'rollback'];
  exactKeys(value, keys, 'requirements', issues);
  for (const key of keys) if (typeof value?.[key] !== 'boolean') issues.push(`requirements.${key}`);
  for (const key of keys) {
    if (expected && expected[key] !== undefined && value?.[key] !== expected[key]) issues.push(`requirements.${key}(binding)`);
  }
  if (value && (!value.runtime || !value.rollback)) issues.push('requirements.runtime|rollback');
}

function validateTarget(target, phase, issues) {
  exactKeys(target, ['source', 'url', 'hostname'], 'target', issues);
  if (target?.source !== (phase === 'candidate' ? 'candidate-state' : 'production-configuration')) issues.push('target.source');
  let url;
  try { url = new URL(target?.url); } catch { issues.push('target.url'); return; }
  if (url.protocol !== 'https:' || url.hostname !== target?.hostname || url.port || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash || isPrivateHostname(url.hostname)) issues.push('target');
}

function validCapabilityMode(check) {
  if (['https', 'api'].includes(check.capability)) return check.mode === 'http';
  if (check.capability === 'release') return check.mode === 'control';
  if (check.capability === 'database') return check.phase === 'candidate' ? check.mode === 'control' : check.mode === 'runtime';
  if (check.capability === 'auth') return ['http', 'runtime', 'human'].includes(check.mode);
  if (check.capability === 'email-domain') return check.mode === 'control';
  if (check.capability === 'email-delivery') return check.mode === 'runtime';
  if (check.capability === 'rollback') return ['runtime', 'human'].includes(check.mode);
  return false;
}

function sameResultContract(result, check) {
  return result.contractCheckId === check.contractCheckId && result.capability === check.capability &&
    result.mode === check.mode && result.required === check.required;
}

function overallStatus(results) {
  const required = results.filter((result) => result.required);
  if (required.some((result) => result.status === 'failed' || result.status === 'skipped')) return 'failed';
  if (required.some((result) => result.status === 'needs-human')) return 'needs-human';
  return 'passed';
}

function readPlanFile(file, expected) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Plan JSON is invalid: ${safeMessage(error.message)}`); }
  try {
    return validateProductVerificationPlan(plan, expected);
  } catch (error) {
    if (error?.code === 'VALIDATION_FAILED') {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Product Verification Plan failed integrity validation: ${safeMessage(error.message)}`);
    }
    throw error;
  }
}

function productVerificationPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Product Verification Plan ID is invalid.');
  return path.join(projectPath(home, projectId), 'verification-plans', `${planId}.json`);
}

function assertKeys(value, allowed, label) {
  if (!isObject(value)) throw operationError('VALIDATION_FAILED', `${label} must be an object.`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw operationError('VALIDATION_FAILED', `${label} contains unsupported fields: ${extras.join(', ')}`);
}

function exactKeys(value, keys, label, issues) {
  if (!isObject(value)) { issues.push(label); return; }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (stableStringify(actual) !== stableStringify(expected)) issues.push(`${label}(fields)`);
}

function throwIntegrityOrValidation(label, issues) {
  const values = [...new Set(issues)];
  if (values.length > 0) throw operationError('VALIDATION_FAILED', `${label} is invalid at: ${values.join(', ')}`);
}

function normalizePath(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!validPath(text)) throw operationError('VALIDATION_FAILED', `Verification path must be an absolute path without query or fragment: ${text}`);
  return text;
}

function validPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512 || value.includes('?') || value.includes('#') || value.includes('\\')) return false;
  try {
    const parsed = new URL(value, 'https://verification.invalid');
    return parsed.origin === 'https://verification.invalid' && parsed.pathname === value && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function statuses(value, fallback) {
  const values = value === undefined ? fallback : value;
  if (!Array.isArray(values) || values.length === 0 || values.length > 16 || new Set(values).size !== values.length ||
    values.some((item) => !Number.isInteger(item) || item < 100 || item > 599)) {
    throw operationError('VALIDATION_FAILED', 'Expected HTTP statuses must be a unique non-empty array of 100..599 integers.');
  }
  return [...values].sort((left, right) => left - right);
}

function contentTypes(value, fallback) {
  const values = value === undefined ? fallback : value;
  if (!Array.isArray(values) || values.length > 8 || new Set(values).size !== values.length ||
    values.some((item) => typeof item !== 'string' || !CONTENT_TYPE.test(item.toLowerCase()))) {
    throw operationError('VALIDATION_FAILED', 'Expected content types must be unique MIME types.');
  }
  return values.map((item) => item.toLowerCase()).sort();
}

function secretRefs(values) {
  if (!Array.isArray(values) || values.length > 4 || new Set(values).size !== values.length || values.some((value) => !SECRET_REF.test(value))) {
    throw operationError('VALIDATION_FAILED', 'Verification test account values must use unique Secret Refs.');
  }
  return [...values].sort();
}

function safeEvidenceRefs(values) {
  if (!Array.isArray(values)) return [];
  const refs = [...new Set(values.filter((value) => typeof value === 'string' && value && value.length <= 512))].slice(0, 16);
  return containsSecretLikeValue(refs) ? [] : refs;
}

function normalizeContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase().replace(/[^a-z0-9.+\/-]/g, '').slice(0, 127);
}

function isProviderCandidateHost(hostname, provider) {
  if (provider === 'vercel') return hostname.endsWith('.vercel.app');
  if (provider === 'railway') return hostname.endsWith('.up.railway.app') || hostname.endsWith('.railway.app');
  return false;
}

function isPrivateHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') || isPrivateAddress(hostname);
}

function isPrivateAddress(value) {
  const address = String(value || '').toLowerCase();
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 198 && [18, 19].includes(octets[1]));
  }
  if (family === 6) {
    return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') ||
      /^fe[89ab]/.test(address) || address.startsWith('ff') || address.startsWith('::ffff:127.') ||
      address.startsWith('::ffff:10.') || address.startsWith('::ffff:192.168.');
  }
  return false;
}

function fingerprintWithout(value, excluded) {
  const copy = structuredClone(value);
  for (const key of excluded) delete copy[key];
  return `sha256:${createHash('sha256').update(stableStringify(copy)).digest('hex')}`;
}

function elapsed(start, end) {
  return Math.max(0, Math.min(3600000, Math.round(Number(end) - Number(start)) || 0));
}

function object(value) { return isObject(value) ? value : {}; }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeText(value, max) { return String(value || '').replace(/[\r\n]/g, ' ').slice(0, max); }
function safeMessage(value) { return safeText(String(value || 'verification error').replace(/https?:\/\/\S+/gi, '[url]'), 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
