import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { readLaunchRun } from './launch-run.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { createSandboxAcceptanceReport } from './sandbox-acceptance.js';

const SUITE_ID = /^acceptance-suite-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^launch-[a-f0-9-]+$/;

export const PROVIDER_ACCEPTANCE_CAPABILITIES = Object.freeze({
  cloudflare: Object.freeze(['ensureZone', 'executeDnsChangeSet']),
  neon: Object.freeze(['executeProject', 'inspectSchema', 'executeSnapshot', 'readSnapshot', 'executeMigration']),
  railway: Object.freeze(['ensureProject', 'ensureEnvironment', 'ensureService', 'ensureServiceDomain', 'executeCandidateDeployment']),
  resend: Object.freeze(['ensureDomain', 'executeVerification']),
  supabase: Object.freeze(['executeProject']),
  vercel: Object.freeze(['ensureProject', 'executeCandidateDeployment']),
});

export function createProviderAcceptanceSuite(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const requiredProviders = normalizeProviders(options.providers);
  const runIds = normalizeRunIds(options.runIds);
  const sources = runIds.map((runId) => loadRunSource({ home, project, runId, persistReport: true }));
  const coverage = deriveProviderAcceptanceCoverage(sources, requiredProviders);
  const base = {
    schemaVersion: 1,
    kind: 'ProviderAcceptanceSuite',
    projectId: project.id,
    sourceCommit: project.source.commit,
    requiredProviders,
    requiredCapabilities: requiredProviders.map((provider) => ({
      provider,
      methods: [...PROVIDER_ACCEPTANCE_CAPABILITIES[provider]],
    })),
    sources,
    coverage,
    status: coverage.every((item) => item.status === 'passed') ? 'passed' : 'incomplete',
    createdAt: sources.map((item) => item.reportCreatedAt).sort().at(-1),
  };
  const fingerprint = providerAcceptanceSuiteFingerprint(base);
  let suite = {
    ...base,
    id: `acceptance-suite-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    fingerprint,
  };
  validateProviderAcceptanceSuite(suite, { project, sources, coverage });
  const result = withControlLock(home, `project:${project.id}`, 'provider-acceptance-suite-create', () => {
    const directory = path.join(projectPath(home, project.id), 'provider-acceptance-suites');
    const suiteFile = path.join(directory, `${suite.id}.json`);
    let reused = false;
    if (fs.existsSync(suiteFile)) {
      const existing = readSuite(suiteFile, { project, sources, coverage });
      if (existing.fingerprint !== suite.fingerprint) {
        throw operationError('CONFLICT', `Provider Acceptance Suite ID collision: ${suite.id}`);
      }
      suite = existing;
      reused = true;
    } else {
      writeJsonAtomic(suiteFile, suite);
    }
    return { suite, suiteFile, reused };
  });
  const repositoryGuard = completeSourceGuard(project.source, before);
  return {
    kind: 'provider-acceptance-suite', operation: 'create', status: result.suite.status,
    home, projectId: project.id, ...result, repositoryGuard,
    networkRequestsExecuted: 0, providerMutationsExecuted: 0,
    secretValuesExposed: false, productRepositoryChanged: false,
  };
}

export function showProviderAcceptanceSuite(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  if (!SUITE_ID.test(options.suiteId || '')) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Suite ID is invalid.');
  }
  const suiteFile = path.join(
    projectPath(home, project.id), 'provider-acceptance-suites', `${options.suiteId}.json`
  );
  if (!fs.existsSync(suiteFile)) {
    throw operationError('NOT_FOUND', `Provider Acceptance Suite not found: ${options.suiteId}`);
  }
  let shell;
  try { shell = JSON.parse(fs.readFileSync(suiteFile, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Acceptance Suite JSON is invalid: ${error.message}`); }
  const sources = (shell.sources || []).map((source) => loadRunSource({
    home, project, runId: source.runId, persistReport: false,
  }));
  const coverage = deriveProviderAcceptanceCoverage(sources, shell.requiredProviders || []);
  const suite = validateProviderAcceptanceSuite(shell, { project, sources, coverage });
  return {
    kind: 'provider-acceptance-suite', operation: 'read', status: suite.status,
    home, projectId: project.id, suite, suiteFile,
    networkRequestsExecuted: 0, providerMutationsExecuted: 0,
    secretValuesExposed: false, productRepositoryChanged: false,
  };
}

export function deriveProviderAcceptanceCoverage(sources, providers) {
  const requiredProviders = normalizeProviders(providers);
  return requiredProviders.map((provider) => {
    const acceptedSources = (sources || []).filter((source) => source.reportStatus === 'passed');
    const coveredMethods = [...new Set(acceptedSources.flatMap((source) =>
      source.methods.filter((item) => item.provider === provider).map((item) => item.method)
    ))].sort();
    const requiredMethods = [...PROVIDER_ACCEPTANCE_CAPABILITIES[provider]];
    const missingMethods = requiredMethods.filter((method) => !coveredMethods.includes(method));
    const reportIds = [...new Set(acceptedSources.filter((source) =>
      source.methods.some((item) => item.provider === provider)
    ).map((source) => source.reportId))].sort();
    return {
      provider,
      requiredMethods,
      coveredMethods: coveredMethods.filter((method) => requiredMethods.includes(method)),
      missingMethods,
      reportIds,
      status: missingMethods.length === 0 ? 'passed' : 'incomplete',
    };
  });
}

export function discoverProviderAcceptanceProgress({ home, project, providers }) {
  const requiredProviders = normalizeProviders(providers);
  const runsDirectory = path.join(projectPath(home, project.id), 'runs');
  const runIds = fs.existsSync(runsDirectory)
    ? fs.readdirSync(runsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : [];
  const sources = [];
  const rejectedRuns = [];
  for (const runId of runIds) {
    let methods = [];
    try {
      const run = readLaunchRun(home, project.id, runId);
      if (run.providerMode !== 'sandbox') continue;
      const plan = showAdapterExecutionPlan({
        home, projectId: project.id, graphId: run.graphId, planId: run.adapterPlanId,
      }).plan;
      methods = plan.actions.map((action) => ({
        provider: action.provider,
        method: action.executeMethod || action.method,
      })).filter((item) => requiredProviders.includes(item.provider));
      if (methods.length === 0) continue;
      const source = loadRunSource({ home, project, runId, persistReport: false });
      sources.push(source);
    } catch (error) {
      rejectedRuns.push({
        runId,
        code: error?.code || 'VALIDATION_FAILED',
        methods: methods.sort((left, right) =>
          `${left.provider}:${left.method}`.localeCompare(`${right.provider}:${right.method}`)
        ),
      });
    }
  }
  const coverage = deriveProviderAcceptanceCoverage(sources, requiredProviders);
  const qualifiedRunIds = sources
    .filter((source) => source.reportStatus === 'passed')
    .filter((source) => source.methods.some((item) => requiredProviders.includes(item.provider)))
    .map((source) => source.runId)
    .sort();
  const status = coverage.every((item) => item.status === 'passed') ? 'ready-to-create-suite' : 'incomplete';
  return {
    status,
    requiredProviders,
    coverage,
    qualifiedRunIds,
    discoveredSandboxRuns: sources.length,
    rejectedRuns,
    createSuiteArgv: status === 'ready-to-create-suite'
      ? [
          'agentmesh-deploy', 'acceptance-suite', 'create', project.id,
          ...qualifiedRunIds.flatMap((runId) => ['--acceptance-run', runId]),
          ...requiredProviders.flatMap((provider) => ['--acceptance-provider', provider]),
          '--home', home, '--json',
        ]
      : [],
  };
}

export function validateProviderAcceptanceSuite(suite, expected = {}) {
  const issues = [];
  exactKeys(suite, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceCommit',
    'requiredProviders', 'requiredCapabilities', 'sources', 'coverage', 'status', 'createdAt',
  ], '$', issues);
  if (suite?.schemaVersion !== 1 || suite?.kind !== 'ProviderAcceptanceSuite') issues.push('kind|schemaVersion');
  if (!SUITE_ID.test(suite?.id || '') || !SHA256.test(suite?.fingerprint || '')) issues.push('id|fingerprint');
  if (!/^[a-f0-9]{40,64}$/.test(suite?.sourceCommit || '')) issues.push('sourceCommit');
  let providers = [];
  try { providers = normalizeProviders(suite?.requiredProviders); }
  catch { issues.push('requiredProviders'); }
  if (providers.length > 0 && stableStringify(providers) !== stableStringify(suite.requiredProviders)) {
    issues.push('requiredProviders.order');
  }
  validateRequiredCapabilities(suite?.requiredCapabilities, providers, issues);
  validateSources(suite?.sources, issues);
  validateCoverage(suite?.coverage, providers, issues);
  if (providers.length > 0 && Array.isArray(suite?.sources) &&
      stableStringify(suite?.coverage) !== stableStringify(deriveProviderAcceptanceCoverage(suite.sources, providers))) {
    issues.push('coverage.semantic');
  }
  if (!['passed', 'incomplete'].includes(suite?.status) || !isDate(suite?.createdAt)) issues.push('status|createdAt');
  const derivedStatus = (suite?.coverage || []).every((item) => item.status === 'passed') ? 'passed' : 'incomplete';
  if (suite?.status !== derivedStatus) issues.push('status.derived');
  if (expected.project && (
    suite?.projectId !== expected.project.id || suite?.sourceCommit !== expected.project.source.commit
  )) issues.push('project');
  if (expected.sources && stableStringify(suite?.sources) !== stableStringify(expected.sources)) issues.push('sources.derived');
  if (expected.coverage && stableStringify(suite?.coverage) !== stableStringify(expected.coverage)) issues.push('coverage.derived');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Provider Acceptance Suite is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = providerAcceptanceSuiteFingerprint(suite);
  if (suite.fingerprint !== actual || suite.id !== `acceptance-suite-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Acceptance Suite fingerprint mismatch: ${suite.id}`);
  }
  return suite;
}

export function providerAcceptanceSuiteFingerprint(suite) {
  const value = structuredClone(suite);
  delete value.id;
  delete value.fingerprint;
  return fingerprint(value);
}

export function loadProviderAcceptanceRunSource({ home, project, runId, persistReport = false }) {
  return loadRunSource({ home, project, runId, persistReport });
}

function loadRunSource({ home, project, runId, persistReport }) {
  if (!RUN_ID.test(runId || '')) throw operationError('VALIDATION_FAILED', `Acceptance Run ID is invalid: ${runId}`);
  const run = readLaunchRun(home, project.id, runId);
  if (run.providerMode !== 'sandbox' || !run.adapterPlanId || !run.sandboxProfileId) {
    throw operationError('CONFLICT', `Provider Acceptance Suite accepts only Sandbox Adapter Runs: ${run.id}`);
  }
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: run.graphId }).graph;
  if (graph.sourceRef?.commit !== project.source.commit) {
    throw operationError('CONFLICT', `Provider Acceptance Run belongs to a stale source Commit: ${run.id}`);
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: run.adapterPlanId,
  }).plan;
  const acceptance = createSandboxAcceptanceReport({
    home, projectId: project.id, graphId: graph.id, planId: plan.id,
    profileId: run.sandboxProfileId, runId: run.id,
    persist: persistReport,
  }).report;
  return {
    runId: run.id,
    runRevision: run.revision,
    runFingerprint: run.fingerprint,
    graphId: graph.id,
    graphFingerprint: graph.fingerprint,
    adapterPlanId: plan.id,
    adapterPlanFingerprint: plan.fingerprint,
    reportId: acceptance.id,
    reportFingerprint: acceptance.fingerprint,
    reportStatus: acceptance.status,
    reportCreatedAt: acceptance.createdAt,
    methods: plan.actions.map((action) => ({
      provider: action.provider,
      method: action.executeMethod || action.method,
    })).sort((left, right) => `${left.provider}:${left.method}`.localeCompare(`${right.provider}:${right.method}`)),
  };
}

function normalizeProviders(values) {
  const requested = values && values.length > 0 ? values : Object.keys(PROVIDER_ACCEPTANCE_CAPABILITIES);
  const providers = [...new Set(requested.map((value) => String(value || '').toLowerCase()))].sort();
  if (providers.length === 0 || providers.some((provider) => !PROVIDER_ACCEPTANCE_CAPABILITIES[provider])) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Suite contains an unsupported provider.');
  }
  return providers;
}

function normalizeRunIds(values) {
  const runIds = [...new Set((values || []).map((value) => String(value || '')))].sort();
  if (runIds.length === 0 || runIds.some((runId) => !RUN_ID.test(runId))) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Suite requires at least one valid Sandbox Run ID.');
  }
  return runIds;
}

function validateRequiredCapabilities(values, providers, issues) {
  if (!Array.isArray(values) || values.length !== providers.length) return issues.push('requiredCapabilities');
  values.forEach((item, index) => {
    exactKeys(item, ['provider', 'methods'], `requiredCapabilities[${index}]`, issues);
    if (item?.provider !== providers[index] ||
        stableStringify(item?.methods) !== stableStringify(PROVIDER_ACCEPTANCE_CAPABILITIES[item?.provider] || [])) {
      issues.push(`requiredCapabilities[${index}]`);
    }
  });
}

function validateSources(values, issues) {
  if (!Array.isArray(values) || values.length === 0) return issues.push('sources');
  const runIds = new Set();
  values.forEach((item, index) => {
    exactKeys(item, [
      'runId', 'runRevision', 'runFingerprint', 'graphId', 'graphFingerprint', 'adapterPlanId',
      'adapterPlanFingerprint', 'reportId', 'reportFingerprint', 'reportStatus', 'reportCreatedAt', 'methods',
    ], `sources[${index}]`, issues);
    if (!RUN_ID.test(item?.runId || '') || runIds.has(item.runId) ||
        !Number.isInteger(item?.runRevision) || item.runRevision < 1 ||
        !['passed', 'not-qualified'].includes(item?.reportStatus) || !isDate(item?.reportCreatedAt)) {
      issues.push(`sources[${index}]`);
    }
    for (const key of ['runFingerprint', 'graphFingerprint', 'adapterPlanFingerprint', 'reportFingerprint']) {
      if (!SHA256.test(item?.[key] || '')) issues.push(`sources[${index}].${key}`);
    }
    if (!Array.isArray(item?.methods) || item.methods.some((method) =>
      !PROVIDER_ACCEPTANCE_CAPABILITIES[method?.provider] || typeof method?.method !== 'string' || !method.method
    )) issues.push(`sources[${index}].methods`);
    runIds.add(item?.runId);
  });
}

function validateCoverage(values, providers, issues) {
  if (!Array.isArray(values) || values.length !== providers.length) return issues.push('coverage');
  values.forEach((item, index) => {
    exactKeys(item, [
      'provider', 'requiredMethods', 'coveredMethods', 'missingMethods', 'reportIds', 'status',
    ], `coverage[${index}]`, issues);
    if (item?.provider !== providers[index] || !['passed', 'incomplete'].includes(item?.status) ||
        stableStringify(item?.requiredMethods) !== stableStringify(PROVIDER_ACCEPTANCE_CAPABILITIES[item?.provider] || []) ||
        !Array.isArray(item?.coveredMethods) || !Array.isArray(item?.missingMethods) || !Array.isArray(item?.reportIds) ||
        (item.status === 'passed') !== (item.missingMethods.length === 0)) issues.push(`coverage[${index}]`);
  });
}

function readSuite(file, expected) {
  let suite;
  try { suite = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Acceptance Suite JSON is invalid: ${error.message}`); }
  return validateProviderAcceptanceSuite(suite, expected);
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(label);
    return;
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0) issues.push(`${label}.unsupported(${extras.sort().join('|')})`);
  if (missing.length > 0) issues.push(`${label}.missing(${missing.sort().join('|')})`);
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
