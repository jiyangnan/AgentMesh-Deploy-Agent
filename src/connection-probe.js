import { spawnSync } from 'node:child_process';

import { AgentMeshDeployError, operationError } from './errors.js';
import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from './provider-contract.js';
import { createProviderHttpTransport } from './provider-http.js';
import { providerById } from './provider-catalog.js';
import { connectionRecovery, recordConnectionProbe, showConnection } from './connection-service.js';
import { createSecretRuntime, materializeProviderConnection } from './secret-store.js';
import { nowIso } from './utils.js';

export async function probeConnection(options) {
  if (!options.probeAuth) {
    throw operationError('APPROVAL_REQUIRED', 'Read-only provider authentication probe requires explicit --probe-auth.');
  }
  const shown = showConnection(options);
  const connection = shown.connection;
  const provider = providerById(connection.provider);
  const secretRuntime = options.secretRuntime || createSecretRuntime({
    env: options.env || process.env,
    stores: options.secretStores,
    commandRunner: options.secretCommandRunner,
    keychainWritable: options.keychainWritable,
  });
  const secrets = (await materializeProviderConnection(connection, secretRuntime)).env;
  const requestId = options.requestId || `probe-${connection.id}-${connection.version}`;
  const transport = options.transport || defaultTransport();
  let actionResult;
  try {
    const response = await executeIdentityProbe(provider.id, connection, secrets, transport);
    if (!response.ok) {
      const mapped = mapProviderError(provider.id, response);
      actionResult = actionFailure('connection.identity-probe', connection.projectId, mapped, { requestId });
    } else {
      actionResult = actionSuccess('connection.identity-probe', connection.projectId, {
        provider: provider.id,
        identity: normalizeIdentity(provider.id, response.data),
        capabilities: response.capabilities || ['identity.read'],
      }, { requestId });
    }
  } catch (error) {
    const mapped = error instanceof AgentMeshDeployError
      ? { code: error.code, message: error.message, retryable: false, provider: provider.id }
      : mapProviderError(provider.id, { status: 503, message: error.message });
    actionResult = actionFailure('connection.identity-probe', connection.projectId, mapped, { requestId });
  }
  validateActionResult(actionResult, { operation: 'connection.identity-probe', appId: connection.projectId });
  const nextConnection = recordConnectionProbe({
    home: shown.home,
    projectId: connection.projectId,
    connectionId: connection.id,
    expectedVersion: connection.version,
    now: options.now || nowIso(),
  }, actionResult);
  return {
    kind: 'connection-probe',
    operation: 'probe',
    status: actionResult.status,
    home: shown.home,
    projectId: connection.projectId,
    connectionId: connection.id,
    connection: nextConnection,
    recovery: connectionRecovery(nextConnection),
    result: actionResult,
    secretValuesExposed: false,
    providerMutationsExecuted: 0,
    productRepositoryChanged: false,
  };
}

async function executeIdentityProbe(provider, connection, secrets, transport) {
  if (provider === 'railway' && secrets.RAILWAY_TOKEN) {
    const response = await transport.request({
      method: 'POST',
      url: 'https://backboard.railway.com/graphql/v2',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'project-access-token': secrets.RAILWAY_TOKEN,
      },
      body: { query: 'query { projectToken { projectId environmentId } }' },
    });
    if (
      response.ok &&
      (!response.data?.data?.projectToken?.projectId || !response.data?.data?.projectToken?.environmentId)
    ) {
      return { ok: false, status: 401, message: 'Railway Project Token probe returned no project/environment scope.', data: {} };
    }
    return response;
  }
  if (provider === 'railway' && secrets.RAILWAY_API_TOKEN && secrets.RAILWAY_WORKSPACE_ID) {
    const response = await transport.request({
      method: 'POST',
      url: 'https://backboard.railway.com/graphql/v2',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${secrets.RAILWAY_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: {
        query: 'query AgentMeshWorkspaceIdentity($workspaceId: String!) { workspace(workspaceId: $workspaceId) { id name } }',
        variables: { workspaceId: secrets.RAILWAY_WORKSPACE_ID },
      },
    });
    if (response.ok && (!response.data?.data?.workspace?.id || response.data?.errors?.length)) {
      return { ok: false, status: 403, message: 'Railway Workspace Token cannot read the configured workspace.', data: {} };
    }
    return response;
  }
  if (provider === 'railway') return transport.command('railway', ['whoami', '--json'], secrets);
  if (provider === 'resend' && secrets.RESEND_API_KEY) {
    const response = await transport.request({
      method: 'GET',
      url: 'https://api.resend.com/domains?limit=1',
      headers: bearer(secrets.RESEND_API_KEY),
    });
    if (!response.ok) return response;
    if (!Array.isArray(response.data?.data)) {
      return { ok: false, status: 403, message: 'Resend Full Access probe returned no readable Domain List.', data: {} };
    }
    return {
      ...response,
      data: { scope: 'full-access', accessibleDomains: arrayCount(response.data?.data) },
      capabilities: ['identity.read', 'domains.read'],
    };
  }
  if (provider === 'resend') {
    return transport.command('resend', ['whoami', '--json'], {
      ...secrets,
      RESEND_API_KEY: secrets.RESEND_SENDING_API_KEY,
    });
  }
  if (provider === 'github') return transport.command('gh', ['api', 'user'], secrets);
  if (provider === 'digitalocean') return transport.command('doctl', ['account', 'get', '--output', 'json'], secrets);
  if (provider === 'vercel' && secrets.VERCEL_ORG_ID) {
    const team = secrets.VERCEL_ORG_ID;
    const direct = team.startsWith('team_');
    const response = await transport.request({
      method: 'GET',
      url: direct
        ? `https://api.vercel.com/v2/teams/${encodeURIComponent(team)}`
        : 'https://api.vercel.com/v2/teams?limit=100',
      headers: bearer(secrets.VERCEL_TOKEN),
    });
    if (!response.ok) return response;
    const identity = direct
      ? response.data
      : (response.data?.teams || []).find((item) => item?.slug === team || item?.id === team);
    if (!identity?.id || !identity?.slug) {
      return { ok: false, status: 403, message: 'Vercel token cannot read the configured Team ID or slug.', data: {} };
    }
    return { ...response, data: { team: identity, plan: vercelPlan(identity) } };
  }
  if (provider === 'vercel') return transport.request({
    method: 'GET', url: 'https://api.vercel.com/v2/user', headers: bearer(secrets.VERCEL_TOKEN),
  });
  if (provider === 'neon') {
    const response = await transport.request({
      method: 'GET', url: 'https://console.neon.tech/api/v2/auth', headers: bearer(secrets.NEON_API_KEY),
    });
    if (
      response.ok &&
      (!stringField(response.data, 'account_id') || !/^api_key_(?:user|org)$/.test(stringField(response.data, 'auth_method')))
    ) {
      return { ok: false, status: 401, message: 'Neon API Key probe returned no API-key identity.', data: {} };
    }
    if (!response.ok) return response;
    const organizations = await transport.request({
      method: 'GET',
      url: 'https://console.neon.tech/api/v2/users/me/organizations',
      headers: bearer(secrets.NEON_API_KEY),
    });
    if (!organizations.ok) return organizations;
    if (!Array.isArray(organizations.data?.organizations)) {
      return { ok: false, status: 502, message: 'Neon organization probe returned no organization list.', data: {} };
    }
    const safeOrganizations = organizations.data.organizations
      .filter((item) => stringField(item, 'id'))
      .map((item) => pick(item, ['id', 'name']))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const scopedOrganizationId = neonOrganizationId(connection.scope);
    if (scopedOrganizationId && !safeOrganizations.some((item) => item.id === scopedOrganizationId)) {
      return { ok: false, status: 403, message: 'Neon API Key cannot read the configured organization scope.', data: {} };
    }
    return {
      ...response,
      data: { ...response.data, organizations: safeOrganizations },
      capabilities: ['identity.read', 'organizations.read'],
    };
  }
  if (provider === 'supabase') return probeSupabase(connection, secrets, transport);
  if (provider === 'cloudflare') return probeCloudflare(connection, secrets, transport);
  if (provider === 'porkbun') return transport.request({
    method: 'POST',
    url: 'https://api.porkbun.com/api/json/v3/ping',
    headers: { 'content-type': 'application/json' },
    body: { apikey: secrets.PORKBUN_API_KEY, secretapikey: secrets.PORKBUN_SECRET_API_KEY },
  });
  throw operationError('UNSUPPORTED', `No identity probe is defined for provider: ${provider}`);
}

function normalizeIdentity(provider, data) {
  if (provider === 'railway' && data?.data?.projectToken) {
    return pick(data.data.projectToken, ['projectId', 'environmentId']);
  }
  if (provider === 'railway' && data?.data?.workspace) {
    return pick(data.data.workspace, ['id', 'name']);
  }
  if (provider === 'vercel' && data?.team) {
    return {
      ...pick(data.team, ['id', 'slug', 'name']),
      ...(stringField(data, 'plan') ? { plan: stringField(data, 'plan') } : {}),
    };
  }
  if (provider === 'vercel') return pick(data?.user || data, ['id', 'username', 'name', 'email']);
  if (provider === 'github') return pick(data, ['id', 'login', 'name']);
  if (provider === 'digitalocean') return pick(Array.isArray(data) ? data[0] : data, ['uuid', 'email', 'status']);
  if (provider === 'resend' && data?.scope === 'full-access') {
    return pick(data, ['scope', 'accessibleDomains']);
  }
  if (provider === 'cloudflare' && data?.token && data?.zone) {
    return {
      tokenId: stringField(data.token, 'id'),
      status: stringField(data.token, 'status'),
      zoneId: stringField(data.zone, 'id'),
      zoneName: stringField(data.zone, 'name'),
      accountId: stringField(data.zone?.account, 'id'),
    };
  }
  if (provider === 'cloudflare') return pick(data?.result || data, ['id', 'status']);
  if (provider === 'porkbun') return pick(data, ['status']);
  if (provider === 'neon') {
    const organizations = Array.isArray(data?.organizations) ? data.organizations : [];
    return {
      accountId: stringField(data, 'account_id'),
      authMethod: stringField(data, 'auth_method'),
      organizationCount: organizations.length,
      ...(organizations.length === 1 ? {
        organizationId: stringField(organizations[0], 'id'),
        organizationName: stringField(organizations[0], 'name'),
      } : {}),
    };
  }
  if (provider === 'supabase') {
    const organizations = Array.isArray(data?.organizations) ? data.organizations : [];
    const availableRegions = Array.isArray(data?.availableRegions) ? data.availableRegions : [];
    return {
      accessibleProjects: Number.isInteger(data?.accessibleProjects) ? data.accessibleProjects : 0,
      activeProjectCount: Number.isInteger(data?.activeProjectCount) ? data.activeProjectCount : 0,
      pausedProjectCount: Number.isInteger(data?.pausedProjectCount) ? data.pausedProjectCount : 0,
      removedProjectCount: Number.isInteger(data?.removedProjectCount) ? data.removedProjectCount : 0,
      organizationCount: organizations.length,
      organizations: organizations.map((organization) => pick(organization, ['id', 'slug', 'name'])),
      ...(data?.regionOrganizationSlug ? {
        regionOrganizationSlug: data.regionOrganizationSlug,
        ...(stringField(data, 'organizationPlan') ? { organizationPlan: stringField(data, 'organizationPlan') } : {}),
        availableRegionCount: availableRegions.length,
        availableRegions: availableRegions.map((region) => pick(region, ['name', 'code', 'type', 'provider', 'status'])),
      } : {}),
    };
  }
  return pick(data, ['id', 'userId', 'name', 'username', 'email', 'teamId']);
}

function defaultTransport() {
  const http = createProviderHttpTransport();
  return {
    request: http.request,
    command(command, args, secretEnv) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...secretEnv },
        maxBuffer: 4 * 1024 * 1024,
      });
      return normalizeProbeCommandResult(result);
    },
  };
}

export function normalizeProbeCommandResult(result) {
  if (result.error) return { ok: false, status: 503, message: result.error.message, data: {} };
  let data;
  try { data = JSON.parse(String(result.stdout || '{}')); } catch { data = {}; }
  const message = String(result.stderr || '').trim() || `Command exited ${result.status}`;
  return {
    ok: result.status === 0,
    status: result.status === 0 ? 200 : classifyProbeCommandFailure(message),
    message,
    data,
  };
}

function classifyProbeCommandFailure(message) {
  const text = String(message || '');
  if (/failed to fetch|network|connect(?:ion)?|timed? out|timeout|dns|tls|handshake|econn|enotfound|socket/i.test(text)) {
    return 503;
  }
  if (/not authenticated|not logged in|unauthorized|invalid (?:api )?(?:key|token)|authentication failed|please (?:run )?.*login/i.test(text)) {
    return 401;
  }
  return 500;
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

async function probeCloudflare(connection, secrets, transport) {
  const headers = bearer(secrets.CLOUDFLARE_API_TOKEN);
  const verified = await transport.request({
    method: 'GET',
    url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    headers,
  });
  if (!verified.ok) return verified;
  if (
    verified.data?.success === false ||
    !verified.data?.result?.id ||
    verified.data?.result?.status !== 'active'
  ) {
    return { ok: false, status: 401, message: 'Cloudflare User API Token is not active.', data: {} };
  }
  const scopedForDns = String(connection.scope || '').startsWith('dns:');
  const zoneName = dnsZoneFromScope(connection.scope);
  if (!scopedForDns) return verified;
  if (!zoneName) {
    return { ok: false, status: 400, message: 'Cloudflare DNS Connection scope must be dns:<existing-zone-name>.', data: {} };
  }

  const accountId = secrets.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    return { ok: false, status: 403, message: 'Cloudflare DNS scope probe requires the configured Account ID.', data: {} };
  }
  const query = new URLSearchParams({ name: zoneName, 'account.id': accountId, per_page: '50', page: '1' });
  const zones = await transport.request({
    method: 'GET',
    url: `https://api.cloudflare.com/client/v4/zones?${query}`,
    headers,
  });
  if (!zones.ok) return zones;
  if (zones.data?.success === false) {
    return { ok: false, status: 403, message: 'Cloudflare token cannot read the configured Zone.', data: {} };
  }
  const exact = (Array.isArray(zones.data?.result) ? zones.data.result : [])
    .filter((zone) => zone?.name === zoneName && zone?.account?.id === accountId);
  if (exact.length !== 1 || !exact[0]?.id) {
    return {
      ok: false,
      status: 403,
      message: 'Cloudflare token cannot read exactly one configured Zone in the configured Account.',
      data: {},
    };
  }
  const zone = exact[0];
  const records = await transport.request({
    method: 'GET',
    url: `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.id)}/dns_records?per_page=5&page=1`,
    headers,
  });
  if (!records.ok) return records;
  if (records.data?.success === false || !Array.isArray(records.data?.result)) {
    return { ok: false, status: 403, message: 'Cloudflare token cannot read DNS records in the configured Zone.', data: {} };
  }
  return {
    ok: true,
    status: 200,
    data: { token: verified.data?.result || {}, zone },
    capabilities: ['identity.read', 'zone.read', 'dns.read'],
  };
}

async function probeSupabase(connection, secrets, transport) {
  const headers = bearer(secrets.SUPABASE_ACCESS_TOKEN || secrets.SUPABASE_OAUTH_ACCESS_TOKEN);
  const projects = await transport.request({
    method: 'GET',
    url: 'https://api.supabase.com/v1/projects',
    headers,
  });
  if (!projects.ok) return projects;
  if (!Array.isArray(projects.data)) {
    return { ok: false, status: 502, message: 'Supabase identity probe returned no readable Project List.', data: {} };
  }
  const projectStatuses = projects.data.map((project) => stringField(project, 'status').toUpperCase());
  if (projectStatuses.some((status) => !status)) {
    return { ok: false, status: 502, message: 'Supabase Project List contains a project without status.', data: {} };
  }
  const pausedProjectCount = projectStatuses.filter((status) => status === 'INACTIVE').length;
  const removedProjectCount = projectStatuses.filter((status) => status === 'REMOVED').length;
  const activeProjectCount = projectStatuses.length - pausedProjectCount - removedProjectCount;
  const organizations = await transport.request({
    method: 'GET',
    url: 'https://api.supabase.com/v1/organizations',
    headers,
  });
  if (!organizations.ok) return organizations;
  if (!Array.isArray(organizations.data)) {
    return { ok: false, status: 502, message: 'Supabase identity probe returned no readable Organization List.', data: {} };
  }
  const safeOrganizations = organizations.data
    .filter((organization) => stringField(organization, 'id') && stringField(organization, 'slug'))
    .map((organization) => pick(organization, ['id', 'slug', 'name']))
    .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  if (safeOrganizations.length !== organizations.data.length) {
    return { ok: false, status: 502, message: 'Supabase Organization List contains an invalid organization identity.', data: {} };
  }
  const scopedOrganizationSlug = supabaseOrganizationSlug(connection.scope);
  if (scopedOrganizationSlug && !safeOrganizations.some((organization) => organization.slug === scopedOrganizationSlug)) {
    return { ok: false, status: 403, message: 'Supabase token cannot read the configured organization scope.', data: {} };
  }
  const regionOrganizationSlug = scopedOrganizationSlug || (safeOrganizations.length === 1 ? safeOrganizations[0].slug : '');
  let organizationPlan = '';
  let availableRegions = [];
  if (regionOrganizationSlug) {
    const selectedOrganization = safeOrganizations.find((item) => item.slug === regionOrganizationSlug);
    const organization = await transport.request({
      method: 'GET',
      url: `https://api.supabase.com/v1/organizations/${encodeURIComponent(regionOrganizationSlug)}`,
      headers,
    });
    if (!organization.ok) return organization;
    if (stringField(organization.data, 'id') !== selectedOrganization?.id || !stringField(organization.data, 'plan')) {
      return { ok: false, status: 502, message: 'Supabase Organization Detail returned no matching organization plan.', data: {} };
    }
    organizationPlan = stringField(organization.data, 'plan');
    const query = new URLSearchParams({ organization_slug: regionOrganizationSlug });
    const regions = await transport.request({
      method: 'GET',
      url: `https://api.supabase.com/v1/projects/available-regions?${query}`,
      headers,
    });
    if (!regions.ok) return regions;
    const specific = regions.data?.all?.specific;
    const smartGroup = regions.data?.all?.smartGroup;
    if (!Array.isArray(specific) || !Array.isArray(smartGroup)) {
      return { ok: false, status: 502, message: 'Supabase available-regions probe returned no readable region catalog.', data: {} };
    }
    availableRegions = [...specific, ...smartGroup]
      .filter((region) => stringField(region, 'code') && ['specific', 'smartGroup'].includes(stringField(region, 'type')))
      .map((region) => pick(region, ['name', 'code', 'type', 'provider', 'status']))
      .sort((left, right) => `${left.type}:${left.code}`.localeCompare(`${right.type}:${right.code}`));
    if (availableRegions.length !== specific.length + smartGroup.length) {
      return { ok: false, status: 502, message: 'Supabase available-regions catalog contains an invalid region identity.', data: {} };
    }
  }
  return {
    ...projects,
    data: {
      accessibleProjects: projects.data.length,
      activeProjectCount,
      pausedProjectCount,
      removedProjectCount,
      organizations: safeOrganizations,
      ...(regionOrganizationSlug ? { regionOrganizationSlug, organizationPlan, availableRegions } : {}),
    },
    capabilities: [
      'identity.read',
      'projects.read',
      'organizations.read',
      ...(regionOrganizationSlug ? ['organization-plan.read', 'available-regions.read'] : []),
    ],
  };
}

function dnsZoneFromScope(scope) {
  const value = String(scope || '');
  if (!value.startsWith('dns:')) return '';
  const zone = value.slice('dns:'.length).trim().toLowerCase();
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(zone)
    ? zone
    : '';
}

function neonOrganizationId(scope) {
  const value = String(scope || '');
  return value.startsWith('organization:') ? value.slice('organization:'.length) : '';
}

function supabaseOrganizationSlug(scope) {
  const value = String(scope || '');
  return value.startsWith('organization:') ? value.slice('organization:'.length) : '';
}

function vercelPlan(identity) {
  return stringField(identity?.billing, 'plan') || stringField(identity, 'plan');
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' ? value[key] : '';
}

function pick(value, keys) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(keys.filter((key) => ['string', 'number', 'boolean'].includes(typeof source[key])).map((key) => [key, source[key]]));
}

function arrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}
