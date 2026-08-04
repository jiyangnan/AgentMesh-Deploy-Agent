import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { resolveDeployHome, writeJsonAtomic } from './project-store.js';
import {
  PROVIDER_ACCEPTANCE_CAPABILITIES,
  showProviderAcceptanceSuite,
} from './provider-acceptance-suite.js';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PORTFOLIO_ID = /^acceptance-portfolio-[a-f0-9]{24}$/;
const SUITE_ID = /^acceptance-suite-[a-f0-9]{24}$/;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function createProviderAcceptancePortfolio(options) {
  const home = resolveDeployHome(options.home);
  const requiredProviders = normalizeProviders(options.providers);
  const suiteRefs = normalizeSuiteRefs(options.suiteRefs);
  const suiteReader = options.suiteReader || showProviderAcceptanceSuite;
  const sources = suiteRefs.map((suiteRef) => loadSuiteSource({ home, suiteRef, suiteReader }));
  const coverage = deriveProviderAcceptancePortfolioCoverage(sources, requiredProviders);
  const requiredCapabilities = requiredProviders.map((provider) => ({
    provider,
    methods: [...PROVIDER_ACCEPTANCE_CAPABILITIES[provider]],
  }));
  const base = {
    schemaVersion: 1,
    kind: 'ProviderAcceptancePortfolio',
    validationRelease: {
      packageName: PACKAGE.name,
      packageVersion: PACKAGE.version,
      capabilityContractFingerprint: fingerprint(requiredCapabilities),
    },
    requiredProviders,
    requiredCapabilities,
    sources,
    coverage,
    status: coverage.every((item) => item.status === 'passed') ? 'passed' : 'incomplete',
    createdAt: sources.map((item) => item.suiteCreatedAt).sort().at(-1),
  };
  const portfolioFingerprint = providerAcceptancePortfolioFingerprint(base);
  let portfolio = {
    ...base,
    id: `acceptance-portfolio-${portfolioFingerprint.slice(7, 31)}`,
    fingerprint: portfolioFingerprint,
  };
  validateProviderAcceptancePortfolio(portfolio, { sources, coverage });

  const result = withControlLock(home, 'registry', 'provider-acceptance-portfolio-create', () => {
    const directory = portfolioDirectory(home);
    const portfolioFile = path.join(directory, `${portfolio.id}.json`);
    let reused = false;
    if (fs.existsSync(portfolioFile)) {
      const existing = readPortfolio(portfolioFile, { sources, coverage });
      if (existing.fingerprint !== portfolio.fingerprint) {
        throw operationError('CONFLICT', `Provider Acceptance Portfolio ID collision: ${portfolio.id}`);
      }
      portfolio = existing;
      reused = true;
    } else {
      writeJsonAtomic(portfolioFile, portfolio);
    }
    return { portfolio, portfolioFile, reused };
  });

  return portfolioResult({ home, operation: 'create', ...result });
}

export function showProviderAcceptancePortfolio(options) {
  const home = resolveDeployHome(options.home);
  if (!PORTFOLIO_ID.test(options.portfolioId || '')) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Portfolio ID is invalid.');
  }
  const portfolioFile = path.join(portfolioDirectory(home), `${options.portfolioId}.json`);
  if (!fs.existsSync(portfolioFile)) {
    throw operationError('NOT_FOUND', `Provider Acceptance Portfolio not found: ${options.portfolioId}`);
  }
  const shell = validateProviderAcceptancePortfolio(readPortfolioJson(portfolioFile));
  const suiteReader = options.suiteReader || showProviderAcceptanceSuite;
  const sources = normalizeStoredSources(shell.sources).map((source) => loadSuiteSource({
    home,
    suiteRef: { projectId: source.projectId, suiteId: source.suiteId },
    suiteReader,
  }));
  const coverage = deriveProviderAcceptancePortfolioCoverage(sources, shell.requiredProviders || []);
  const portfolio = validateProviderAcceptancePortfolio(shell, { sources, coverage });
  return portfolioResult({ home, operation: 'read', portfolio, portfolioFile, reused: true });
}

export function deriveProviderAcceptancePortfolioCoverage(sources, providers) {
  const requiredProviders = normalizeProviders(providers);
  return requiredProviders.map((provider) => {
    const qualifications = (sources || []).flatMap((source) =>
      (Array.isArray(source?.qualifications) ? source.qualifications : [])
        .filter((item) => item.provider === provider)
        .map((item) => ({ source, item }))
    );
    const coveredMethods = [...new Set(qualifications.flatMap(({ item }) => item.methods))]
      .filter((method) => PROVIDER_ACCEPTANCE_CAPABILITIES[provider].includes(method))
      .sort();
    const requiredMethods = [...PROVIDER_ACCEPTANCE_CAPABILITIES[provider]];
    const missingMethods = requiredMethods.filter((method) => !coveredMethods.includes(method));
    const suiteRefs = qualifications.map(({ source, item }) => ({
      projectId: source.projectId,
      suiteId: source.suiteId,
      suiteFingerprint: source.suiteFingerprint,
      reportIds: [...item.reportIds],
    })).sort((left, right) =>
      `${left.projectId}:${left.suiteId}`.localeCompare(`${right.projectId}:${right.suiteId}`)
    );
    return {
      provider,
      requiredMethods,
      coveredMethods,
      missingMethods,
      suiteRefs,
      status: missingMethods.length === 0 ? 'passed' : 'incomplete',
    };
  });
}

export function validateProviderAcceptancePortfolio(portfolio, expected = {}) {
  const issues = [];
  exactKeys(portfolio, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'validationRelease', 'requiredProviders',
    'requiredCapabilities', 'sources', 'coverage', 'status', 'createdAt',
  ], '$', issues);
  if (portfolio?.schemaVersion !== 1 || portfolio?.kind !== 'ProviderAcceptancePortfolio') {
    issues.push('kind|schemaVersion');
  }
  if (!PORTFOLIO_ID.test(portfolio?.id || '') || !SHA256.test(portfolio?.fingerprint || '')) {
    issues.push('id|fingerprint');
  }
  let providers = [];
  try { providers = normalizeProviders(portfolio?.requiredProviders); }
  catch { issues.push('requiredProviders'); }
  if (providers.length > 0 && stableStringify(providers) !== stableStringify(portfolio.requiredProviders)) {
    issues.push('requiredProviders.order');
  }
  validateRequiredCapabilities(portfolio?.requiredCapabilities, providers, issues);
  validateRelease(portfolio?.validationRelease, portfolio?.requiredCapabilities, issues);
  validateSources(portfolio?.sources, issues);
  validateCoverage(portfolio?.coverage, providers, issues);
  if (providers.length > 0 && Array.isArray(portfolio?.sources)) {
    try {
      if (stableStringify(portfolio.coverage) !==
          stableStringify(deriveProviderAcceptancePortfolioCoverage(portfolio.sources, providers))) {
        issues.push('coverage.semantic');
      }
    } catch {
      issues.push('coverage.semantic');
    }
  }
  const coverageValues = Array.isArray(portfolio?.coverage) ? portfolio.coverage : [];
  const derivedStatus = coverageValues.every((item) => item.status === 'passed')
    ? 'passed'
    : 'incomplete';
  if (!['passed', 'incomplete'].includes(portfolio?.status) || portfolio?.status !== derivedStatus) {
    issues.push('status');
  }
  const derivedCreatedAt = Array.isArray(portfolio?.sources)
    ? portfolio.sources.map((item) => item?.suiteCreatedAt || '').sort().at(-1)
    : '';
  if (!isDate(portfolio?.createdAt) || portfolio.createdAt !== derivedCreatedAt) issues.push('createdAt');
  if (expected.sources && stableStringify(portfolio?.sources) !== stableStringify(expected.sources)) {
    issues.push('sources.derived');
  }
  if (expected.coverage && stableStringify(portfolio?.coverage) !== stableStringify(expected.coverage)) {
    issues.push('coverage.derived');
  }
  if (issues.length > 0) {
    throw operationError(
      'VALIDATION_FAILED',
      `Provider Acceptance Portfolio is invalid at: ${[...new Set(issues)].join(', ')}`
    );
  }
  const actual = providerAcceptancePortfolioFingerprint(portfolio);
  if (portfolio.fingerprint !== actual || portfolio.id !== `acceptance-portfolio-${actual.slice(7, 31)}`) {
    throw operationError(
      'ARTIFACT_INTEGRITY_FAILED',
      `Provider Acceptance Portfolio fingerprint mismatch: ${portfolio.id}`
    );
  }
  return portfolio;
}

export function providerAcceptancePortfolioFingerprint(portfolio) {
  const value = structuredClone(portfolio);
  delete value.id;
  delete value.fingerprint;
  return fingerprint(value);
}

export function normalizeProviderAcceptanceSuiteRefs(values) {
  return normalizeSuiteRefs(values);
}

function loadSuiteSource({ home, suiteRef, suiteReader }) {
  const result = suiteReader({
    home,
    projectId: suiteRef.projectId,
    suiteId: suiteRef.suiteId,
  });
  const suite = result?.suite;
  if (!suite || suite.projectId !== suiteRef.projectId || suite.id !== suiteRef.suiteId) {
    throw operationError(
      'ARTIFACT_INTEGRITY_FAILED',
      `Provider Acceptance Suite source binding is invalid: ${suiteRef.projectId}:${suiteRef.suiteId}`
    );
  }
  if (suite.status !== 'passed' || !Array.isArray(suite.coverage) || suite.coverage.length === 0 ||
      suite.coverage.some((item) => item.status !== 'passed')) {
    throw operationError(
      'CONFLICT',
      `Provider Acceptance Portfolio accepts only passed project Suites: ${suiteRef.projectId}:${suiteRef.suiteId}`
    );
  }
  return {
    projectId: suite.projectId,
    sourceCommit: suite.sourceCommit,
    suiteId: suite.id,
    suiteFingerprint: suite.fingerprint,
    suiteCreatedAt: suite.createdAt,
    qualifications: suite.coverage.map((item) => ({
      provider: item.provider,
      methods: [...item.coveredMethods].sort(),
      reportIds: [...item.reportIds].sort(),
    })).sort((left, right) => left.provider.localeCompare(right.provider)),
  };
}

function normalizeSuiteRefs(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Portfolio requires at least one Suite reference.');
  }
  const refs = values.map((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { projectId: String(value.projectId || ''), suiteId: String(value.suiteId || '') };
    }
    const raw = String(value || '');
    const separator = raw.indexOf(':');
    return separator < 1
      ? { projectId: '', suiteId: '' }
      : { projectId: raw.slice(0, separator), suiteId: raw.slice(separator + 1) };
  });
  if (refs.some((item) => !PROJECT_ID.test(item.projectId) || !SUITE_ID.test(item.suiteId))) {
    throw operationError(
      'VALIDATION_FAILED',
      'Suite references must use project-id:acceptance-suite-id.'
    );
  }
  const unique = new Map(refs.map((item) => [`${item.projectId}:${item.suiteId}`, item]));
  return [...unique.values()].sort((left, right) =>
    `${left.projectId}:${left.suiteId}`.localeCompare(`${right.projectId}:${right.suiteId}`)
  );
}

function normalizeStoredSources(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Portfolio has no Suite sources.');
  }
  return [...values].sort((left, right) =>
    `${left?.projectId}:${left?.suiteId}`.localeCompare(`${right?.projectId}:${right?.suiteId}`)
  );
}

function normalizeProviders(values) {
  const requested = values && values.length > 0 ? values : Object.keys(PROVIDER_ACCEPTANCE_CAPABILITIES);
  const providers = [...new Set(requested.map((value) => String(value || '').toLowerCase()))].sort();
  if (providers.length === 0 || providers.some((provider) => !PROVIDER_ACCEPTANCE_CAPABILITIES[provider])) {
    throw operationError('VALIDATION_FAILED', 'Provider Acceptance Portfolio contains an unsupported provider.');
  }
  return providers;
}

function validateRelease(value, requiredCapabilities, issues) {
  exactKeys(value, ['packageName', 'packageVersion', 'capabilityContractFingerprint'], 'validationRelease', issues);
  const contractFingerprint = Array.isArray(requiredCapabilities) ? fingerprint(requiredCapabilities) : '';
  if (value?.packageName !== '@agentmesh/deploy' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value?.packageVersion || '') ||
      !SHA256.test(value?.capabilityContractFingerprint || '') ||
      value?.capabilityContractFingerprint !== contractFingerprint) {
    issues.push('validationRelease');
  }
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
  const refs = new Set();
  values.forEach((item, index) => {
    const label = `sources[${index}]`;
    exactKeys(item, [
      'projectId', 'sourceCommit', 'suiteId', 'suiteFingerprint', 'suiteCreatedAt', 'qualifications',
    ], label, issues);
    const ref = `${item?.projectId}:${item?.suiteId}`;
    if (!PROJECT_ID.test(item?.projectId || '') || !/^[a-f0-9]{40,64}$/.test(item?.sourceCommit || '') ||
        !SUITE_ID.test(item?.suiteId || '') || !SHA256.test(item?.suiteFingerprint || '') ||
        !isDate(item?.suiteCreatedAt) || refs.has(ref)) {
      issues.push(label);
    }
    if (!Array.isArray(item?.qualifications) || item.qualifications.length === 0) {
      issues.push(`${label}.qualifications`);
    } else {
      const providers = new Set();
      item.qualifications.forEach((qualification, qualificationIndex) => {
        const qualificationLabel = `${label}.qualifications[${qualificationIndex}]`;
        exactKeys(qualification, ['provider', 'methods', 'reportIds'], qualificationLabel, issues);
        const expectedMethods = PROVIDER_ACCEPTANCE_CAPABILITIES[qualification?.provider] || [];
        if (!expectedMethods.length || providers.has(qualification?.provider) ||
            stableStringify(qualification?.methods) !== stableStringify([...expectedMethods].sort()) ||
            !Array.isArray(qualification?.reportIds) || qualification.reportIds.length === 0 ||
            qualification.reportIds.some((reportId) => !/^sandbox-acceptance-[a-f0-9]{24}$/.test(reportId))) {
          issues.push(qualificationLabel);
        }
        providers.add(qualification?.provider);
      });
    }
    refs.add(ref);
  });
  const sorted = [...values].sort((left, right) =>
    `${left?.projectId || ''}:${left?.suiteId || ''}`.localeCompare(
      `${right?.projectId || ''}:${right?.suiteId || ''}`
    )
  );
  if (stableStringify(values) !== stableStringify(sorted)) issues.push('sources.order');
}

function validateCoverage(values, providers, issues) {
  if (!Array.isArray(values) || values.length !== providers.length) return issues.push('coverage');
  values.forEach((item, index) => {
    const label = `coverage[${index}]`;
    exactKeys(item, [
      'provider', 'requiredMethods', 'coveredMethods', 'missingMethods', 'suiteRefs', 'status',
    ], label, issues);
    if (item?.provider !== providers[index] || !['passed', 'incomplete'].includes(item?.status) ||
        stableStringify(item?.requiredMethods) !==
        stableStringify(PROVIDER_ACCEPTANCE_CAPABILITIES[item?.provider] || []) ||
        !Array.isArray(item?.coveredMethods) || !Array.isArray(item?.missingMethods) ||
        !Array.isArray(item?.suiteRefs) || (item.status === 'passed') !== (item.missingMethods.length === 0)) {
      issues.push(label);
    }
    (item?.suiteRefs || []).forEach((suiteRef, suiteIndex) => {
      const suiteLabel = `${label}.suiteRefs[${suiteIndex}]`;
      exactKeys(
        suiteRef,
        ['projectId', 'suiteId', 'suiteFingerprint', 'reportIds'],
        suiteLabel,
        issues
      );
      if (!PROJECT_ID.test(suiteRef?.projectId || '') || !SUITE_ID.test(suiteRef?.suiteId || '') ||
          !SHA256.test(suiteRef?.suiteFingerprint || '') ||
          !Array.isArray(suiteRef?.reportIds) || suiteRef.reportIds.length === 0 ||
          suiteRef.reportIds.some((reportId) => !/^sandbox-acceptance-[a-f0-9]{24}$/.test(reportId))) {
        issues.push(suiteLabel);
      }
    });
  });
}

function portfolioDirectory(home) {
  return path.join(home, 'provider-acceptance-portfolios');
}

function readPortfolio(file, expected) {
  return validateProviderAcceptancePortfolio(readPortfolioJson(file), expected);
}

function readPortfolioJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw operationError(
      'ARTIFACT_INTEGRITY_FAILED',
      `Provider Acceptance Portfolio JSON is invalid: ${error.message}`
    );
  }
}

function portfolioResult({ home, operation, portfolio, portfolioFile, reused }) {
  return {
    kind: 'provider-acceptance-portfolio',
    operation,
    status: portfolio.status,
    home,
    portfolio,
    portfolioFile,
    reused,
    sourceProjectsRevalidated: [...new Set(portfolio.sources.map((source) => source.projectId))].sort(),
    networkRequestsExecuted: 0,
    providerMutationsExecuted: 0,
    secretValuesRead: false,
    secretValuesExposed: false,
    productRepositoryChanged: false,
  };
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

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(',')}}`;
}
