import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readExternalDeployment } from './contracts-v2.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue } from './provider-contract.js';
import { showRecipe } from './recipe-service.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const CONFIG_ID = /^launch-config-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_PREFIX = /^[a-z][a-z0-9-]{2,31}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const POSTGRES_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_REF = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._\/-]+)$/;
const SECRET_DESTINATION = /^(?:keychain|op|secret):\/\/[A-Za-z0-9._\/-]+$/;
const RUNTIME_PROVIDERS = new Set(['vercel', 'railway', 'cloudflare']);
const DATABASE_PROVIDERS = new Set(['', 'neon', 'supabase', 'railway', 'cloudflare']);

export function createLaunchConfiguration(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'launch-config-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const deployment = readExternalDeployment(home, project.id);
    const recipe = showRecipe({ home, projectId: project.id, recipeId: deployment.manifest.recipeRef.id }).recipe;
    const settings = structuredClone(options.settings || {});
    const normalized = normalizeSettings(settings, project, deployment.manifest, recipe);
    const base = {
      schemaVersion: 1,
      kind: 'LaunchConfiguration',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      recipeId: recipe.id,
      recipeFingerprint: recipe.fingerprint,
      ...normalized,
      createdAt: options.now || nowIso(),
    };
    const fingerprint = launchConfigurationFingerprint(base);
    let configuration = {
      ...base,
      id: `launch-config-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateLaunchConfiguration(configuration, { projectId: project.id, graph, recipe, manifest: deployment.manifest });
    const directory = path.join(projectPath(home, project.id), 'launch-configurations');
    const configurationFile = path.join(directory, `${configuration.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'launch-configuration.json');
    let reused = false;
    if (fs.existsSync(configurationFile)) {
      const existing = readConfigurationFile(configurationFile, {
        projectId: project.id, graph, recipe, manifest: deployment.manifest,
      });
      if (existing.fingerprint !== configuration.fingerprint) {
        throw operationError('CONFLICT', `Launch Configuration ID collision: ${configuration.id}`);
      }
      configuration = existing;
      reused = true;
    } else {
      writeJsonAtomic(configurationFile, configuration);
    }
    writeJsonAtomic(currentFile, configuration);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'launch-configuration', operation: 'create', status: 'succeeded', home,
      projectId: project.id, configuration, configurationFile, currentFile, reused,
      repositoryGuard, providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function showLaunchConfiguration(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const deployment = readExternalDeployment(home, project.id);
  const recipe = showRecipe({ home, projectId: project.id, recipeId: deployment.manifest.recipeRef.id }).recipe;
  const configurationFile = options.configurationId
    ? configurationPath(home, project.id, options.configurationId)
    : path.join(projectPath(home, project.id), 'launch-configuration.json');
  if (!fs.existsSync(configurationFile)) {
    throw operationError('NOT_FOUND', `Launch Configuration not found: ${configurationFile}`);
  }
  const configuration = readConfigurationFile(configurationFile, {
    projectId: project.id, graph, recipe, manifest: deployment.manifest,
  });
  return { kind: 'launch-configuration', operation: 'read', home, projectId: project.id, configuration, configurationFile };
}

export function validateLaunchConfiguration(configuration, expected = {}) {
  const issues = [];
  if (configuration?.schemaVersion !== 1 || configuration?.kind !== 'LaunchConfiguration') issues.push('kind|schemaVersion');
  if (!CONFIG_ID.test(configuration?.id || '') || !SHA256.test(configuration?.fingerprint || '')) issues.push('id|fingerprint');
  if (!RESOURCE_PREFIX.test(configuration?.resourcePrefix || '')) issues.push('resourcePrefix');
  if (!isDate(configuration?.createdAt)) issues.push('createdAt');
  if (expected.projectId && configuration?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.graph && (configuration?.graphId !== expected.graph.id || configuration?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.recipe && (configuration?.recipeId !== expected.recipe.id || configuration?.recipeFingerprint !== expected.recipe.fingerprint)) issues.push('recipe');
  validateDomain(configuration?.domain, expected.manifest, issues);
  validateRuntime(configuration?.runtime, expected.manifest, issues);
  validateDatabase(configuration?.database, expected.manifest, issues);
  validateEmail(configuration?.email, configuration?.domain, expected.manifest, issues);
  validateBudget(configuration?.budget, issues);
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Launch Configuration is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = launchConfigurationFingerprint(configuration);
  if (configuration.fingerprint !== actual) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Launch Configuration fingerprint mismatch: ${configuration.id}`);
  }
  const expectedId = `launch-config-${actual.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (configuration.id !== expectedId) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Launch Configuration ID mismatch: ${configuration.id}`);
  }
  return configuration;
}

export function readLaunchConfigurationSettingsFile(file) {
  const resolved = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw operationError('NOT_FOUND', `Launch Configuration settings file not found: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operationError('VALIDATION_FAILED', 'Launch Configuration settings file must be a regular non-symlink file.');
  }
  if (stat.size > 1024 * 1024) throw operationError('VALIDATION_FAILED', 'Launch Configuration settings file exceeds 1 MiB.');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Launch Configuration settings JSON is invalid: ${error.message}`); }
  if (!isObject(settings)) throw operationError('VALIDATION_FAILED', 'Launch Configuration settings must be a JSON object.');
  return { settings, settingsFile: resolved };
}

export function launchConfigurationFingerprint(configuration) {
  const value = structuredClone(configuration);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function normalizeSettings(settings, project, manifest, recipe) {
  if (containsSecretLikeValue(settings)) {
    throw operationError('VALIDATION_FAILED', 'Launch Configuration settings contain a secret-like value; use a Secret Ref instead.');
  }
  assertKeys(settings, ['resourcePrefix', 'domain', 'runtime', 'database', 'email', 'budget'], '$');
  const domain = object(settings.domain);
  const runtime = object(settings.runtime);
  const database = object(settings.database);
  const email = object(settings.email);
  const budget = object(settings.budget);
  assertKeys(domain, ['apex', 'webHostname', 'emailDomain', 'registrationMode'], '$.domain');
  assertKeys(runtime, [
    'projectName', 'framework', 'buildCommand', 'installCommand', 'outputDirectory',
    'environmentName', 'serviceName', 'repository',
  ], '$.runtime');
  assertKeys(database, [
    'name', 'regionId', 'pgVersion', 'branchName', 'databaseName', 'roleName', 'minCu', 'maxCu',
    'suspendTimeoutSeconds', 'orgId', 'organizationSlug', 'regionType', 'regionCode', 'instanceSize',
    'passwordSecretRef', 'connectionSecretRef',
  ], '$.database');
  assertKeys(email, ['domain', 'region', 'tls'], '$.email');
  assertKeys(budget, ['maxMonthlyUsd', 'maxOneTimeUsd'], '$.budget');
  const runtimeProvider = recipe.providers.runtime || '';
  const databaseProvider = recipe.requirements.database ? recipe.providers.database : '';
  const emailProvider = recipe.requirements.email ? recipe.providers.email : '';
  return {
    resourcePrefix: String(settings.resourcePrefix || project.id).toLowerCase(),
    domain: {
      apex: lower(domain.apex),
      webHostname: lower(domain.webHostname || domain.apex),
      emailDomain: lower(domain.emailDomain || email.domain),
      registrationMode: String(domain.registrationMode || 'adopt-existing'),
    },
    runtime: {
      provider: runtimeProvider,
      projectName: String(runtime.projectName || settings.resourcePrefix || project.id).toLowerCase(),
      framework: Object.prototype.hasOwnProperty.call(runtime, 'framework') && runtime.framework === null
        ? null
        : String(runtime.framework || manifest.runtime?.frameworks?.[0] || '') ||
          (runtimeProvider === 'vercel' ? null : ''),
      buildCommand: runtimeProvider === 'vercel'
        ? String(runtime.buildCommand || manifest.commands?.build || '')
        : '',
      installCommand: runtimeProvider === 'vercel'
        ? String(runtime.installCommand || manifest.commands?.install || '')
        : '',
      outputDirectory: runtimeProvider === 'vercel' ? String(runtime.outputDirectory || '') : '',
      environmentName: String(runtime.environmentName || 'preview'),
      serviceName: String(runtime.serviceName || 'web'),
      repository: String(runtime.repository || ''),
      sourceBranch: runtimeProvider === 'railway' && runtime.repository
        ? `agentmesh-candidate-${manifest.sourceRef.commit.slice(0, 12).toLowerCase()}`
        : '',
    },
    database: {
      provider: databaseProvider,
      name: String(database.name || `${settings.resourcePrefix || project.id}-database`).toLowerCase(),
      regionId: String(database.regionId || ''),
      pgVersion: number(database.pgVersion, 17),
      branchName: String(database.branchName || 'main'),
      databaseName: String(database.databaseName || 'appdb'),
      roleName: String(database.roleName || 'app_owner'),
      minCu: number(database.minCu, 0.25),
      maxCu: number(database.maxCu, 1),
      suspendTimeoutSeconds: number(database.suspendTimeoutSeconds, 300),
      orgId: String(database.orgId || ''),
      organizationSlug: String(database.organizationSlug || ''),
      regionType: String(database.regionType || 'specific'),
      regionCode: String(database.regionCode || ''),
      instanceSize: String(database.instanceSize || 'micro'),
      passwordSecretRef: String(database.passwordSecretRef || ''),
      connectionSecretRef: String(database.connectionSecretRef || ''),
    },
    email: {
      provider: emailProvider,
      domain: lower(email.domain || domain.emailDomain),
      region: String(email.region || 'us-east-1'),
      tls: String(email.tls || 'enforced'),
    },
    budget: {
      maxMonthlyUsd: number(budget.maxMonthlyUsd, null),
      maxOneTimeUsd: number(budget.maxOneTimeUsd, null),
    },
  };
}

function validateDomain(domain, manifest, issues) {
  if (!isObject(domain) || !DOMAIN.test(domain.apex || '') || !DOMAIN.test(domain.webHostname || '')) {
    issues.push('domain');
    return;
  }
  if (!(domain.webHostname === domain.apex || domain.webHostname.endsWith(`.${domain.apex}`))) issues.push('domain.webHostname');
  if (!['adopt-existing', 'register-new'].includes(domain.registrationMode)) issues.push('domain.registrationMode');
  if (manifest?.requirements?.email) {
    if (!DOMAIN.test(domain.emailDomain || '') || domain.emailDomain === domain.apex || !domain.emailDomain.endsWith(`.${domain.apex}`)) {
      issues.push('domain.emailDomain');
    }
  } else if (domain.emailDomain) issues.push('domain.emailDomain');
}

function validateRuntime(runtime, manifest, issues) {
  if (!isObject(runtime) || !RUNTIME_PROVIDERS.has(runtime.provider) || runtime.provider !== manifest?.providers?.runtime) {
    issues.push('runtime.provider');
    return;
  }
  if (
    !SAFE_NAME.test(runtime.projectName || '') ||
    !(runtime.framework === null || typeof runtime.framework === 'string') ||
    !validRuntimeCommand(runtime.buildCommand) || !validRuntimeCommand(runtime.installCommand) ||
    !validOutputDirectory(runtime.outputDirectory)
  ) issues.push('runtime.projectName|build');
  if (runtime.provider === 'railway') {
    if (!SAFE_NAME.test(runtime.environmentName || '') || !SAFE_NAME.test(runtime.serviceName || '') ||
      !REPOSITORY.test(runtime.repository || '') || !/^agentmesh-candidate-[a-f0-9]{12}$/.test(runtime.sourceBranch || '')) {
      issues.push('runtime.railway');
    }
  } else if (runtime.repository || runtime.sourceBranch) issues.push('runtime.repository');
  if (runtime.provider !== 'vercel' && (runtime.buildCommand || runtime.installCommand || runtime.outputDirectory)) {
    issues.push('runtime.providerBuildSettings');
  }
}

function validateDatabase(database, manifest, issues) {
  if (!isObject(database) || !DATABASE_PROVIDERS.has(database.provider) || database.provider !== (manifest?.providers?.database || '')) {
    issues.push('database.provider');
    return;
  }
  if (!manifest?.requirements?.database) {
    if (database.provider) issues.push('database.provider');
    return;
  }
  if (!SAFE_NAME.test(database.name || '')) issues.push('database.name');
  if (['neon', 'supabase'].includes(database.provider) && !SECRET_DESTINATION.test(database.connectionSecretRef || '')) {
    issues.push('database.connectionSecretRef');
  }
  if (database.provider === 'neon') {
    if (!/^[a-z0-9-]{3,63}$/.test(database.regionId || '') || !Number.isInteger(database.pgVersion) ||
      !SAFE_NAME.test(database.branchName || '') || !POSTGRES_NAME.test(database.databaseName || '') ||
      !POSTGRES_NAME.test(database.roleName || '') || !validPositive(database.minCu) || !validPositive(database.maxCu) ||
      database.maxCu < database.minCu || !Number.isInteger(database.suspendTimeoutSeconds) ||
      database.suspendTimeoutSeconds < 0 || (database.orgId && !SAFE_NAME.test(database.orgId))) issues.push('database.neon');
    if (database.passwordSecretRef || database.organizationSlug || database.regionCode) issues.push('database.neon.unused');
  }
  if (database.provider === 'supabase') {
    if (!/^[a-z0-9-]{3,63}$/.test(database.organizationSlug || '') || !['specific', 'smartGroup'].includes(database.regionType) ||
      !/^[a-z0-9-]{2,63}$/.test(database.regionCode || '') || !SAFE_NAME.test(database.instanceSize || '') ||
      !SECRET_REF.test(database.passwordSecretRef || '') || database.passwordSecretRef === database.connectionSecretRef) {
      issues.push('database.supabase');
    }
    if (database.regionId || database.orgId) issues.push('database.supabase.unused');
  }
  if (['railway', 'cloudflare'].includes(database.provider) && (database.passwordSecretRef || database.connectionSecretRef)) {
    issues.push('database.unsupportedProviderFields');
  }
}

function validateEmail(email, domain, manifest, issues) {
  const expectedProvider = manifest?.requirements?.email ? manifest?.providers?.email : '';
  if (!isObject(email) || email.provider !== expectedProvider) {
    issues.push('email.provider');
    return;
  }
  if (!expectedProvider) {
    if (email.domain) issues.push('email.domain');
    return;
  }
  if (email.provider !== 'resend' || email.domain !== domain?.emailDomain || !DOMAIN.test(email.domain || '') ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(email.region || '') || !['enforced', 'opportunistic'].includes(email.tls)) {
    issues.push('email');
  }
}

function validateBudget(budget, issues) {
  if (!isObject(budget) || !validMoney(budget.maxMonthlyUsd) || !validMoney(budget.maxOneTimeUsd)) issues.push('budget');
}

function readConfigurationFile(file, expected) {
  let configuration;
  try { configuration = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Launch Configuration JSON is invalid: ${error.message}`); }
  return validateLaunchConfiguration(configuration, expected);
}

function configurationPath(home, projectId, configurationId) {
  if (!CONFIG_ID.test(configurationId || '')) throw operationError('VALIDATION_FAILED', 'Launch Configuration ID is invalid.');
  return path.join(projectPath(home, projectId), 'launch-configurations', `${configurationId}.json`);
}

function assertKeys(value, allowed, label) {
  if (!isObject(value)) throw operationError('VALIDATION_FAILED', `${label} must be an object.`);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw operationError('VALIDATION_FAILED', `${label} contains unsupported fields: ${extra.join(', ')}`);
}

function object(value) { return isObject(value) ? value : {}; }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function lower(value) { return String(value || '').toLowerCase(); }
function number(value, fallback) { return value === undefined || value === null || value === '' ? fallback : Number(value); }
function validPositive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function validMoney(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000; }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validRuntimeCommand(value) {
  return value === undefined || (typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value));
}
function validOutputDirectory(value) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string' || value.length > 255 || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
