import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { nowIso } from './utils.js';

const PROFILE_ID = /^sandbox-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RESOURCE_PREFIX = /^[a-z][a-z0-9-]{2,31}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_PROFILE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_ENVIRONMENTS = new Set(['test']);
const PROVIDER_API_HOSTS = Object.freeze({
  github: 'api.github.com',
  cloudflare: 'api.cloudflare.com',
  vercel: 'api.vercel.com',
  railway: 'backboard.railway.com',
  resend: 'api.resend.com',
  neon: 'console.neon.tech',
  supabase: 'api.supabase.com',
});

export function createSandboxProfile(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Sandbox profile creation requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'sandbox-profile-create', () => {
    const project = readProjectRecord(home, options.projectId);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const plan = showAdapterExecutionPlan({
      home, projectId: project.id, graphId: graph.id, planId: options.planId,
    }).plan;
    const createdAt = options.now || nowIso();
    const expiresAt = normalizeExpiration(options.expiresAt, createdAt);
    const resourcePrefix = String(options.resourcePrefix || '');
    if (!RESOURCE_PREFIX.test(resourcePrefix)) throw operationError('VALIDATION_FAILED', 'Sandbox resource prefix is invalid.');
    const allowedDomains = normalizeDomains(options.allowedDomains || []);
    const protectedDomains = normalizeDomains(options.protectedDomains || []);
    assertNonOverlappingDomainPolicy(allowedDomains, protectedDomains);
    assertSandboxActionScope(plan, resourcePrefix, allowedDomains, protectedDomains);
    const providers = [...new Set(plan.actions.map((action) => action.provider))].sort();
    const apiHosts = providers.map((provider) => PROVIDER_API_HOSTS[provider]).filter(Boolean).sort();
    if (apiHosts.length !== providers.length) throw operationError('UNSUPPORTED', 'Sandbox profile contains a provider without a fixed API host.');
    const connectionIds = [...new Set(plan.actions.map((action) => action.connectionId))].sort();
    const estimatedProviderMutations = estimateSandboxPlanMutations(plan);
    const maxProviderMutations = Number(options.maxProviderMutations);
    if (!Number.isInteger(maxProviderMutations) || maxProviderMutations < estimatedProviderMutations) {
      throw operationError(
        'VALIDATION_FAILED',
        `Sandbox max provider mutations must be an integer >= estimated ${estimatedProviderMutations}.`
      );
    }
    const hasCostNodes = graph.nodes.some((node) =>
      plan.actions.some((action) => action.nodeId === node.id) && node.sideEffect === 'cost-mutation'
    );
    if (hasCostNodes && options.allowPaidResources !== true) {
      throw operationError('APPROVAL_REQUIRED', 'Sandbox plan contains cost-mutation nodes and requires allowPaidResources=true.');
    }
    const base = {
      schemaVersion: 1,
      kind: 'SandboxExecutionProfile',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      adapterPlanId: plan.id,
      adapterPlanFingerprint: plan.fingerprint,
      providers,
      connectionIds,
      resourcePrefix,
      allowedDomains,
      protectedDomains,
      apiHosts,
      ...(options.accountEnvironment ? { accountEnvironment: normalizeAccountEnvironment(options.accountEnvironment) } : {}),
      allowPaidResources: options.allowPaidResources === true,
      estimatedProviderMutations,
      maxProviderMutations,
      createdAt,
      expiresAt,
    };
    const fingerprint = sandboxProfileFingerprint(base);
    let profile = {
      ...base,
      id: `sandbox-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateSandboxProfile(profile, { projectId: project.id, graph, plan, now: createdAt, requireActive: true });
    const directory = path.join(projectPath(home, project.id), 'sandbox-profiles');
    const profileFile = path.join(directory, `${profile.id}.json`);
    let reused = false;
    if (fs.existsSync(profileFile)) {
      const existing = readProfile(profileFile, { projectId: project.id, graph, plan, now: createdAt, requireActive: true });
      if (existing.fingerprint !== profile.fingerprint) throw operationError('CONFLICT', `Sandbox Profile ID collision: ${profile.id}`);
      profile = existing;
      reused = true;
    } else {
      writeJsonAtomic(profileFile, profile);
    }
    return {
      kind: 'sandbox-execution-profile', operation: 'create', status: 'succeeded', home,
      projectId: project.id, profile, profileFile, effectiveStatus: 'active', reused, providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function showSandboxProfile(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: graph.id, planId: options.planId,
  }).plan;
  if (!PROFILE_ID.test(options.profileId || '')) throw operationError('VALIDATION_FAILED', 'Sandbox Profile ID is invalid.');
  const profileFile = path.join(projectPath(home, project.id), 'sandbox-profiles', `${options.profileId}.json`);
  if (!fs.existsSync(profileFile)) throw operationError('NOT_FOUND', `Sandbox Profile not found: ${options.profileId}`);
  const currentTime = options.now || nowIso();
  const profile = readProfile(profileFile, { projectId: project.id, graph, plan, now: currentTime });
  const effectiveStatus = sandboxProfileStatus(home, project.id, profile, currentTime);
  return { kind: 'sandbox-execution-profile', operation: 'read', home, projectId: project.id, profile, profileFile, effectiveStatus };
}

export function revokeSandboxProfile(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Sandbox Profile revocation requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'sandbox-profile-revoke', () => {
    const current = showSandboxProfile(options);
    const revokedAt = options.now || nowIso();
    const revocationFile = sandboxRevocationPath(home, current.projectId, current.profile.id);
    let revocation;
    let reused = false;
    if (fs.existsSync(revocationFile)) {
      revocation = readSandboxRevocation(revocationFile, current.profile);
      reused = true;
    } else {
      const base = {
        schemaVersion: 1,
        kind: 'SandboxProfileRevocation',
        profileId: current.profile.id,
        projectId: current.projectId,
        profileFingerprint: current.profile.fingerprint,
        revokedBy: normalizeActor(options.approvedBy),
        revokedAt,
      };
      revocation = { ...base, fingerprint: sandboxRevocationFingerprint(base) };
      validateSandboxRevocation(revocation, current.profile);
      writeJsonAtomic(revocationFile, revocation);
    }
    return {
      kind: 'sandbox-execution-profile', operation: 'revoke', status: 'succeeded', home,
      projectId: current.projectId, profile: current.profile, profileFile: current.profileFile,
      effectiveStatus: 'revoked', revocation, revocationFile, reused,
      providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function authorizeSandboxRuntime(options) {
  const { home, project, graph, plan, runtime, now } = options;
  if (runtime.allowNetworkTransport !== true) return runtime;
  if (options.executionEnvironment !== 'sandbox' || options.allowSandboxNetwork !== true) {
    throw operationError('APPROVAL_REQUIRED', 'Network transport requires executionEnvironment=sandbox and explicit sandbox network authorization.');
  }
  const profileReport = showSandboxProfile({
    home,
    projectId: project.id,
    graphId: graph.id,
    planId: plan.id,
    profileId: options.sandboxProfileId,
    now,
  });
  if (profileReport.effectiveStatus !== 'active') {
    throw operationError(
      profileReport.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REVOKED',
      `Sandbox Profile is ${profileReport.effectiveStatus}: ${profileReport.profile.id}`
    );
  }
  const profile = profileReport.profile;
  const providerOptions = { ...(runtime.providerOptions || {}) };
  if (runtime.adapters) throw operationError('VALIDATION_FAILED', 'Sandbox network mode does not allow injected Adapter instances.');
  for (const provider of profile.providers) {
    const current = { ...(providerOptions[provider] || {}) };
    if (current.transport) throw operationError('VALIDATION_FAILED', 'Sandbox network mode does not allow injected provider Transports.');
    const delegate = current.httpOptions?.fetchImpl || runtime.fetchImpl || globalThis.fetch;
    current.httpOptions = {
      ...(current.httpOptions || {}),
      fetchImpl: createSandboxFetch(profile, delegate),
    };
    providerOptions[provider] = current;
  }
  return { ...runtime, providerOptions, sandboxProfile: profile };
}

export function createSandboxFetch(profile, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw operationError('CAPABILITY_MISSING', 'Sandbox network runtime requires a fetch implementation.');
  const allowed = new Set(profile.apiHosts || []);
  return async function sandboxFetch(input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url); }
    catch { throw operationError('PATH_BOUNDARY_VIOLATION', 'Sandbox network request URL is invalid.'); }
    if (
      url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password ||
      !allowed.has(url.hostname) || isPrivateHost(url.hostname)
    ) {
      throw operationError('PATH_BOUNDARY_VIOLATION', `Sandbox network host is not allowed: ${url.hostname || '(missing)'}`);
    }
    return fetchImpl(input, { ...(init || {}), redirect: 'manual' });
  };
}

export function validateSandboxProfile(profile, expected = {}) {
  const issues = [];
  if (profile?.schemaVersion !== 1 || profile?.kind !== 'SandboxExecutionProfile') issues.push('kind|schemaVersion');
  if (!PROFILE_ID.test(profile?.id || '') || !SHA256.test(profile?.fingerprint || '')) issues.push('id|fingerprint');
  if (!RESOURCE_PREFIX.test(profile?.resourcePrefix || '')) issues.push('resourcePrefix');
  for (const key of ['providers', 'connectionIds', 'allowedDomains', 'apiHosts']) {
    if (!Array.isArray(profile?.[key]) || new Set(profile[key]).size !== profile[key].length) issues.push(key);
  }
  if (profile?.protectedDomains !== undefined &&
      (!Array.isArray(profile.protectedDomains) || new Set(profile.protectedDomains).size !== profile.protectedDomains.length)) {
    issues.push('protectedDomains');
  }
  if ((profile?.allowedDomains || []).some((domain) => !DOMAIN.test(domain))) issues.push('allowedDomains');
  if ((profile?.protectedDomains || []).some((domain) => !DOMAIN.test(domain))) issues.push('protectedDomains');
  try { assertNonOverlappingDomainPolicy(profile?.allowedDomains || [], profile?.protectedDomains || []); }
  catch { issues.push('domainPolicy'); }
  if ((profile?.apiHosts || []).some((host) => !/^[a-z0-9.-]+$/.test(host))) issues.push('apiHosts');
  if (profile?.accountEnvironment !== undefined && !ACCOUNT_ENVIRONMENTS.has(profile.accountEnvironment)) {
    issues.push('accountEnvironment');
  }
  if (!Number.isInteger(profile?.estimatedProviderMutations) || profile.estimatedProviderMutations < 0) issues.push('estimatedProviderMutations');
  if (!Number.isInteger(profile?.maxProviderMutations) || profile.maxProviderMutations < profile.estimatedProviderMutations) issues.push('maxProviderMutations');
  if (typeof profile?.allowPaidResources !== 'boolean') issues.push('allowPaidResources');
  if (!isDate(profile?.createdAt) || !isDate(profile?.expiresAt) || Date.parse(profile.expiresAt) <= Date.parse(profile.createdAt)) issues.push('time');
  if (expected.projectId && profile?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.graph && (profile?.graphId !== expected.graph.id || profile?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.plan && (profile?.adapterPlanId !== expected.plan.id || profile?.adapterPlanFingerprint !== expected.plan.fingerprint)) issues.push('plan');
  if (expected.plan) {
    const providers = [...new Set(expected.plan.actions.map((action) => action.provider))].sort();
    const connectionIds = [...new Set(expected.plan.actions.map((action) => action.connectionId))].sort();
    const apiHosts = providers.map((provider) => PROVIDER_API_HOSTS[provider]).filter(Boolean).sort();
    if (stableStringify(profile.providers) !== stableStringify(providers)) issues.push('providers');
    if (stableStringify(profile.connectionIds) !== stableStringify(connectionIds)) issues.push('connectionIds');
    if (stableStringify(profile.apiHosts) !== stableStringify(apiHosts)) issues.push('apiHosts');
    if (profile.estimatedProviderMutations !== estimateSandboxPlanMutations(expected.plan)) issues.push('estimatedProviderMutations');
    try {
      assertSandboxActionScope(
        expected.plan, profile.resourcePrefix, profile.allowedDomains, profile.protectedDomains || []
      );
    }
    catch { issues.push('resourceScope'); }
  }
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Sandbox Execution Profile is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (profile.fingerprint !== sandboxProfileFingerprint(profile)) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Profile fingerprint mismatch: ${profile.id}`);
  if (profile.id !== `sandbox-${profile.fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Profile ID mismatch: ${profile.id}`);
  }
  if (expected.requireActive && expected.now && Date.parse(profile.expiresAt) <= Date.parse(expected.now)) {
    throw operationError('APPROVAL_EXPIRED', `Sandbox Profile expired: ${profile.id}`);
  }
  return profile;
}

export function assertSandboxActionScope(plan, prefix, allowedDomains, protectedDomains = []) {
  for (const action of plan.actions) {
    const method = action.executeMethod || action.method;
    const name = action.input?.name;
    if (['ensureProject', 'executeProject', 'executeCandidateDeployment'].includes(method) && name &&
        !(name === prefix || name.startsWith(`${prefix}-`))) {
      throw operationError('VALIDATION_FAILED', `Sandbox resource name must use prefix ${prefix}: ${action.actionId}`);
    }
    if (['ensureProject', 'executeProject'].includes(method) && !name) {
      throw operationError('VALIDATION_FAILED', `Sandbox resource name must use prefix ${prefix}: ${action.actionId}`);
    }
    if (action.provider === 'resend' && ['ensureDomain', 'executeVerification', 'executeSendingKey'].includes(method)) {
      const domain = String(action.input?.domainName || action.input?.name || '').toLowerCase();
      assertDomainNotProtected(domain, protectedDomains, action.actionId);
      if (!domainWithinAllowed(domain, allowedDomains)) {
        throw operationError('VALIDATION_FAILED', `Sandbox Resend domain is outside allowedDomains: ${action.actionId}`);
      }
    }
    if (action.provider === 'cloudflare' && method === 'ensureZone') {
      const zone = String(action.input?.name || '').toLowerCase();
      assertDomainNotProtected(zone, protectedDomains, action.actionId);
      if (!zoneContainsAllowedDomain(zone, allowedDomains)) {
        throw operationError('VALIDATION_FAILED', `Sandbox Cloudflare Zone does not contain an allowed domain: ${action.actionId}`);
      }
    }
    if (action.provider === 'cloudflare' && method === 'executeDnsChangeSet') {
      const changeSet = action.input?.changeSet;
      const zone = String(changeSet?.zoneName || '').toLowerCase();
      const records = Array.isArray(changeSet?.records) ? changeSet.records : [];
      for (const record of records) {
        assertDomainNotProtected(String(record?.name || '').toLowerCase(), protectedDomains, action.actionId);
      }
      if (!zoneContainsAllowedDomain(zone, allowedDomains) || records.length === 0 ||
          records.some((record) => !domainWithinAllowed(String(record?.name || '').toLowerCase(), allowedDomains))) {
        throw operationError('VALIDATION_FAILED', `Sandbox Cloudflare DNS ChangeSet is outside allowedDomains: ${action.actionId}`);
      }
    }
  }
}

function assertNonOverlappingDomainPolicy(allowedDomains, protectedDomains) {
  const overlap = allowedDomains.find((allowed) => protectedDomains.some((protectedDomain) =>
    allowed === protectedDomain || allowed.endsWith(`.${protectedDomain}`) || protectedDomain.endsWith(`.${allowed}`)
  ));
  if (overlap) throw operationError('VALIDATION_FAILED', `Sandbox allowed and protected domains overlap: ${overlap}`);
}

function assertDomainNotProtected(domain, protectedDomains, actionId) {
  if (domain && protectedDomains.some((protectedDomain) =>
    domain === protectedDomain || domain.endsWith(`.${protectedDomain}`)
  )) {
    throw operationError('VALIDATION_FAILED', `Sandbox action targets a protected domain: ${actionId}`);
  }
}

function domainWithinAllowed(domain, allowedDomains) {
  return Boolean(domain) && allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function zoneContainsAllowedDomain(zone, allowedDomains) {
  return Boolean(zone) && allowedDomains.some((allowed) => allowed === zone || allowed.endsWith(`.${zone}`));
}

export function estimateSandboxPlanMutations(plan) {
  return plan.actions.reduce((total, action) => total + estimateSandboxActionMutations(action), 0);
}

export function estimateSandboxActionMutations(action) {
  const method = action.executeMethod || action.method;
  if (method === 'executeCandidateDeployment' && action.provider === 'vercel') {
    return (action.input?.artifact?.blobs?.length || 0) + 1;
  }
  if (method === 'executeDnsChangeSet' && action.provider === 'cloudflare') {
    return action.input?.changeSet?.records?.length || 0;
  }
  if (/^(?:read|poll|plan)/.test(method || '') ||
      ['inspectSchema', 'executeConnectionCapture', 'readProjectCatalog', 'readBranchCatalog'].includes(method)) return 0;
  if (method === 'executeRuntimeCredentials' && action.provider === 'supabase') return 2;
  return 1;
}

function normalizeExpiration(value, createdAt) {
  if (!isDate(value)) throw operationError('VALIDATION_FAILED', 'Sandbox Profile expiresAt must be ISO-8601.');
  const created = Date.parse(createdAt);
  const expires = Date.parse(value);
  if (expires <= created || expires - created > MAX_PROFILE_LIFETIME_MS) {
    throw operationError('VALIDATION_FAILED', 'Sandbox Profile lifetime must be greater than zero and at most 7 days.');
  }
  return new Date(expires).toISOString();
}

function normalizeDomains(values) {
  const domains = [...new Set(values.map((value) => String(value).toLowerCase()))].sort();
  if (domains.some((domain) => !DOMAIN.test(domain))) throw operationError('VALIDATION_FAILED', 'Sandbox allowedDomains contains an invalid domain.');
  return domains;
}

function normalizeAccountEnvironment(value) {
  const environment = String(value || '').toLowerCase();
  if (!ACCOUNT_ENVIRONMENTS.has(environment)) {
    throw operationError('VALIDATION_FAILED', 'Sandbox account environment must be test.');
  }
  return environment;
}

function readProfile(file, expected) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Sandbox Profile JSON is invalid: ${error.message}`); }
  return validateSandboxProfile(profile, expected);
}

export function sandboxProfileStatusAt(home, projectId, profile, now) {
  const revocationFile = sandboxRevocationPath(home, projectId, profile.id);
  if (fs.existsSync(revocationFile)) {
    const revocation = readSandboxRevocation(revocationFile, profile);
    if (Date.parse(revocation.revokedAt) <= Date.parse(now)) return 'revoked';
  }
  if (Date.parse(profile.expiresAt) <= Date.parse(now)) return 'expired';
  return 'active';
}

function sandboxProfileStatus(home, projectId, profile, now) {
  return sandboxProfileStatusAt(home, projectId, profile, now);
}

function sandboxRevocationPath(home, projectId, profileId) {
  return path.join(projectPath(home, projectId), 'sandbox-profiles', 'revocations', `${profileId}.json`);
}

function sandboxProfileFingerprint(profile) {
  const value = structuredClone(profile);
  delete value.id;
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function readSandboxRevocation(file, profile) {
  let revocation;
  try { revocation = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Profile revocation JSON is invalid: ${error.message}`); }
  return validateSandboxRevocation(revocation, profile);
}

function validateSandboxRevocation(revocation, profile) {
  const issues = [];
  if (revocation?.schemaVersion !== 1 || revocation?.kind !== 'SandboxProfileRevocation') issues.push('kind|schemaVersion');
  if (revocation?.profileId !== profile.id) issues.push('profileId');
  if (revocation?.projectId !== profile.projectId) issues.push('projectId');
  if (revocation?.profileFingerprint !== profile.fingerprint) issues.push('profileFingerprint');
  if (!ACTOR.test(revocation?.revokedBy || '')) issues.push('revokedBy');
  if (!isDate(revocation?.revokedAt)) issues.push('revokedAt');
  if (!SHA256.test(revocation?.fingerprint || '')) issues.push('fingerprint');
  if (issues.length > 0) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Profile revocation is invalid at: ${issues.join(', ')}`);
  }
  if (revocation.fingerprint !== sandboxRevocationFingerprint(revocation)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Profile revocation fingerprint mismatch: ${profile.id}`);
  }
  return revocation;
}

function sandboxRevocationFingerprint(revocation) {
  const value = structuredClone(revocation);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function normalizeActor(value) {
  const actor = String(value || 'user');
  if (!ACTOR.test(actor)) throw operationError('VALIDATION_FAILED', 'Sandbox Profile revocation actor is invalid.');
  return actor;
}

function isPrivateHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.local') ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) || hostname === '::1';
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
