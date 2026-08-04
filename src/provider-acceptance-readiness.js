import { checkConnection, listConnections } from './connection-service.js';
import process from 'node:process';
import { operationError } from './errors.js';
import {
  discoverProviderAcceptanceProgress,
  PROVIDER_ACCEPTANCE_CAPABILITIES,
} from './provider-acceptance-suite.js';
import { providerById } from './provider-catalog.js';
import { readProjectRecord, resolveDeployHome } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { parseSecretRef } from './secret-store.js';

const REQUIREMENTS = Object.freeze({
  cloudflare: Object.freeze([
    requirement('cloudflare-control', 'initial', ['api-token'], ['dns:*'],
      ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], 'cloudflare-control', 'dns:<existing-zone-name>', {
        requiredCapabilities: Object.freeze(['zone.read', 'dns.read']),
      }),
  ]),
  neon: Object.freeze([
    requirement('neon-provisioning', 'initial', ['api-key'], ['personal', 'organization', 'organization:*'],
      ['NEON_API_KEY'], 'neon-provisioning', 'personal'),
  ]),
  railway: Object.freeze([
    requirement('railway-workspace', 'initial', ['workspace-token'], ['account', 'account-or-workspace', 'workspace:*'],
      ['RAILWAY_API_TOKEN'], 'railway-workspace', 'account-or-workspace', {
        scopeSecretRefs: Object.freeze([
          Object.freeze({ scope: 'workspace:*', names: Object.freeze(['RAILWAY_WORKSPACE_ID']) }),
        ]),
      }),
  ]),
  resend: Object.freeze([
    requirement('resend-provisioning', 'initial', ['provisioning-key'], ['full-access'],
      ['RESEND_API_KEY'], 'resend-provisioning', 'full-access', {
        requiredCapabilities: Object.freeze(['domains.read']),
      }),
    requirement('resend-sending', 'post-domain-verify', ['sending-key'], ['sending-access'],
      ['RESEND_SENDING_API_KEY'], 'resend-sending', 'sending-access', {
        suggestedKeychainAccountSuffixes: Object.freeze({ RESEND_SENDING_API_KEY: 'api-key' }),
      }),
  ]),
  supabase: Object.freeze([
    requirement('supabase-provisioning', 'initial', ['personal-access-token', 'oauth'], ['default', 'organization'],
      ['SUPABASE_DB_PASSWORD'], 'supabase-provisioning', 'organization', {
        authSecretRefs: Object.freeze({
          'personal-access-token': 'SUPABASE_ACCESS_TOKEN',
          oauth: 'SUPABASE_OAUTH_ACCESS_TOKEN',
        }),
      }),
  ]),
  vercel: Object.freeze([
    requirement('vercel-team', 'initial', ['access-token'], ['default', 'team', 'personal-or-team'],
      ['VERCEL_TOKEN', 'VERCEL_ORG_ID'], 'vercel-team', 'team'),
  ]),
});

export const PROVIDER_ACCEPTANCE_CONNECTION_REQUIREMENTS = REQUIREMENTS;

export function createProviderAcceptanceReadiness(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const requiredProviders = normalizeProviders(options.providers);
  const connections = listConnections({ home, projectId: project.id }).connections;
  const providers = requiredProviders.map((provider) => inspectProvider({
    home, project, provider, connections, env: options.env || process.env,
  }));
  const acceptance = discoverProviderAcceptanceProgress({ home, project, providers: requiredProviders });
  const acceptanceByProvider = new Map(acceptance.coverage.map((item) => [item.provider, item]));
  const providersWithAcceptance = providers.map((item) => ({
    ...item,
    acceptance: acceptanceByProvider.get(item.provider),
  }));
  const initialReady = providers.every((item) => item.initialStatus === 'ready');
  const completionReady = providers.every((item) => item.completionStatus === 'ready');
  const status = completionReady
    ? 'ready-for-complete-acceptance'
    : (initialReady ? 'ready-for-initial-sandbox' : 'blocked');
  const blockers = providers.flatMap((item) => item.blockers.map((blocker) => ({
    provider: item.provider,
    ...blocker,
  })));
  const nextActions = [
    ...providers.flatMap((item) => item.nextActions),
    ...acceptance.coverage.filter((item) => item.status !== 'passed').map((item) => ({
      kind: 'execute-provider-acceptance-run',
      provider: item.provider,
      missingMethods: item.missingMethods,
      requiresNetwork: true,
      requiresProviderMutations: true,
      requiresSandboxProfile: true,
      requiresCurrentPreflight: true,
    })),
    ...(acceptance.status === 'ready-to-create-suite' ? [{
      kind: 'create-provider-acceptance-suite',
      argv: acceptance.createSuiteArgv,
      requiresNetwork: false,
    }] : []),
  ];
  const repositoryGuard = completeSourceGuard(project.source, before);
  return {
    kind: 'provider-acceptance-readiness',
    operation: 'readiness',
    status,
    home,
    projectId: project.id,
    sourceCommit: project.source.commit,
    requiredProviders,
    providers: providersWithAcceptance,
    acceptance,
    summary: {
      providersReadyForInitialSandbox: providers.filter((item) => item.initialStatus === 'ready').length,
      providersReadyForCompleteAcceptance: providers.filter((item) => item.completionStatus === 'ready').length,
      totalProviders: providers.length,
      connectionsReady: providers.flatMap((item) => item.connections).filter((item) => item.status === 'ready').length,
      connectionsNeedingSecretPreflight: providers.flatMap((item) => item.connections)
        .filter((item) => item.status === 'needs-secret-preflight').length,
      totalConnectionRequirements: providers.flatMap((item) => item.connections).length,
      providersWithQualifiedMethodCoverage: acceptance.coverage.filter((item) => item.status === 'passed').length,
      qualifiedAcceptanceRuns: acceptance.qualifiedRunIds.length,
    },
    blockers,
    nextActions,
    repositoryGuard,
    networkRequestsExecuted: 0,
    providerProbesExecuted: 0,
    providerMutationsExecuted: 0,
    secretValuesRead: false,
    secretValuesExposed: false,
    productRepositoryChanged: false,
  };
}

function inspectProvider({ home, project, provider, connections, env }) {
  const catalog = providerById(provider);
  const providerConnections = connections.filter((connection) => connection.provider === provider);
  const inspected = REQUIREMENTS[provider].map((definition) => inspectRequirement({
    home, project, definition, providerConnections, env,
  }));
  const initial = inspected.filter((item) => item.stage === 'initial');
  const initialStatus = initial.every(isExecutionReady) ? 'ready' : 'blocked';
  const completionStatus = inspected.every(isExecutionReady) ? 'ready' : 'incomplete';
  const blockers = inspected.flatMap((item) => item.blockers);
  const nextActions = [
    {
      kind: 'review-provider-guide',
      provider,
      stage: 'initial',
      argv: ['agentmesh-deploy', 'provider', 'guide', provider, '--json'],
      requiresNetwork: false,
    },
    ...inspected.flatMap((item) => item.nextActions),
  ];
  return {
    provider,
    name: catalog.name,
    initialStatus,
    completionStatus,
    requiredMethods: [...PROVIDER_ACCEPTANCE_CAPABILITIES[provider]],
    connections: inspected,
    blockers,
    nextActions,
    docs: [...catalog.docs],
  };
}

function inspectRequirement({ home, project, definition, providerConnections, env }) {
  const compatible = providerConnections.filter((connection) => connectionMatches(connection, definition))
    .sort(compareConnections);
  const connection = compatible[0] || null;
  const requiredSecretRefNames = connection
    ? requiredSecretRefsForConnection(connection, definition)
    : definition.requiredSecretRefNames;
  const homeArgs = home ? ['--home', home] : [];
  const base = {
    id: definition.id,
    stage: definition.stage,
    acceptedAuthMethods: [...definition.acceptedAuthMethods],
    acceptedScopes: [...definition.acceptedScopes],
    requiredProbeCapabilities: [...(definition.requiredCapabilities || [])],
    requiredSecretRefNames: [...requiredSecretRefNames],
    connectionId: connection?.id || '',
    connectionVersion: connection?.version || 0,
    connectionStatus: connection?.status || 'missing',
  };
  if (!connection) {
    const providerHasConnections = providerConnections.length > 0;
    const status = definition.stage === 'post-domain-verify' ? 'deferred' : 'needs-connection';
    return {
      ...base,
      status,
      blockers: definition.stage === 'post-domain-verify' ? [] : [{
        code: providerHasConnections ? 'CONNECTION_SCOPE_MISMATCH' : 'CONNECTION_MISSING',
        requirementId: definition.id,
        message: providerHasConnections
          ? 'Existing Connection does not match the required auth method, scope, or context refs.'
          : 'Required Provider Connection has not been registered.',
      }],
      nextActions: [buildConnectionAction(project.id, definition, homeArgs, providerConnections)],
    };
  }
  const readiness = checkConnection({
    home, projectId: project.id, connectionId: connection.id, env,
  });
  if (readiness.status === 'blocked') {
    return {
      ...base,
      status: 'secret-ref-missing',
      blockers: [{
        code: 'SECRET_REF_MISSING',
        requirementId: definition.id,
        message: `Connection is missing runtime values for refs: ${readiness.missing.join(', ')}`,
      }],
      nextActions: [{
        kind: 'check-connection', provider: connection.provider, requirementId: definition.id,
        argv: ['agentmesh-deploy', 'connection', 'check', project.id, connection.id, ...homeArgs, '--json'],
        requiresNetwork: false,
      }],
    };
  }
  if (connection.status !== 'ready') {
    const errorCode = connection.lastProbe?.errorCode || '';
    const credentialBlocked = errorCode === 'CREDENTIAL_MISSING';
    const capabilityBlocked = errorCode === 'CAPABILITY_MISSING';
    return {
      ...base,
      status: connection.status === 'blocked' ? 'provider-probe-blocked' : 'needs-provider-probe',
      blockers: [{
        code: connection.status === 'blocked' ? 'PROVIDER_PROBE_BLOCKED' : 'PROVIDER_PROBE_REQUIRED',
        requirementId: definition.id,
        message: credentialBlocked
          ? 'Connection credential is expired, invalid, or inactive; create a replacement credential and pass a new read-only probe.'
          : (capabilityBlocked
            ? 'Connection is missing the required provider scope; create a minimum-scope replacement and pass a new read-only probe.'
            : 'Connection must pass its read-only provider identity and scope probe.'),
      }],
      nextActions: [{
        kind: 'probe-connection', provider: connection.provider, requirementId: definition.id,
        argv: ['agentmesh-deploy', 'connection', 'probe', project.id, connection.id, '--probe-auth', ...homeArgs, '--json'],
        requiresNetwork: true,
      }],
    };
  }
  const missingCapabilities = (definition.requiredCapabilities || [])
    .filter((capability) => !connection.capabilities?.includes(capability));
  if (missingCapabilities.length > 0) {
    return {
      ...base,
      status: 'needs-provider-probe',
      blockers: [{
        code: 'PROVIDER_SCOPE_PROBE_REQUIRED',
        requirementId: definition.id,
        message: `Connection must re-run its read-only scope probe for: ${missingCapabilities.join(', ')}`,
      }],
      nextActions: [{
        kind: 'probe-connection', provider: connection.provider, requirementId: definition.id,
        argv: ['agentmesh-deploy', 'connection', 'probe', project.id, connection.id, '--probe-auth', ...homeArgs, '--json'],
        requiresNetwork: true,
      }],
    };
  }
  if (readiness.status === 'needs-probe') {
    return {
      ...base,
      status: 'needs-secret-preflight',
      blockers: [],
      nextActions: [{
        kind: 'verify-secret-in-sandbox-preflight', provider: connection.provider,
        requirementId: definition.id, connectionId: connection.id,
        requiresNetwork: false, requiresSecretValueRead: false,
      }],
    };
  }
  return { ...base, status: 'ready', blockers: [], nextActions: [] };
}

function buildConnectionAction(projectId, definition, homeArgs, providerConnections) {
  const authMethod = definition.acceptedAuthMethods[0];
  const authRefName = definition.authSecretRefs?.[authMethod];
  const refs = [...definition.requiredSecretRefNames];
  if (authRefName && !refs.includes(authRefName)) refs.unshift(authRefName);
  const suggestedSecretRefs = Object.fromEntries(refs.map((name) => [
    name,
    suggestSecretRef(name, definition, providerConnections),
  ]));
  return {
    kind: definition.stage === 'post-domain-verify'
      ? 'register-deferred-provider-connection'
      : 'register-provider-connection',
    provider: definition.provider,
    requirementId: definition.id,
    stage: definition.stage,
    argv: [
      'agentmesh-deploy', 'connection', 'add', projectId, definition.suggestedConnectionId,
      '--provider', definition.provider,
      ...refs.flatMap((name) => ['--secret-ref', `${name}=${suggestedSecretRefs[name]}`]),
      '--scope', definition.suggestedScope,
      ...homeArgs,
      '--json',
    ],
    requiresNetwork: false,
    requiresSecretValueOnCommandLine: false,
    suggestedSecretRefs,
  };
}

function suggestSecretRef(name, definition, providerConnections) {
  const parsed = providerConnections
    .flatMap((connection) => Object.values(connection.secretRefs || {}))
    .map((ref) => {
      try { return parseSecretRef(ref); } catch { return null; }
    })
    .filter(Boolean);
  const schemes = new Set(parsed.map((item) => item.scheme));
  if (schemes.size !== 1 || !schemes.has('keychain')) return `env://${name}`;
  const services = new Set(parsed.map((item) => item.service));
  if (services.size !== 1) return `env://${name}`;
  const suffix = definition.suggestedKeychainAccountSuffixes?.[name];
  if (!suffix) return `env://${name}`;
  return `keychain://${[...services][0]}/${definition.suggestedConnectionId}-${suffix}`;
}

function requirement(id, stage, acceptedAuthMethods, acceptedScopes, requiredSecretRefNames,
  suggestedConnectionId, suggestedScope, extra = {}) {
  return Object.freeze({
    id,
    provider: id.split('-')[0],
    stage,
    acceptedAuthMethods: Object.freeze(acceptedAuthMethods),
    acceptedScopes: Object.freeze(acceptedScopes),
    requiredSecretRefNames: Object.freeze(requiredSecretRefNames),
    suggestedConnectionId,
    suggestedScope,
    ...extra,
  });
}

function connectionMatches(connection, definition) {
  if (!definition.acceptedAuthMethods.includes(connection.authMethod)) return false;
  if (!definition.acceptedScopes.some((scope) => scopeMatches(connection.scope, scope))) return false;
  const names = new Set(Object.keys(connection.secretRefs || {}));
  if (!requiredSecretRefsForConnection(connection, definition).every((name) => names.has(name))) return false;
  const authRefName = definition.authSecretRefs?.[connection.authMethod];
  return !authRefName || names.has(authRefName);
}

function requiredSecretRefsForConnection(connection, definition) {
  const conditional = (definition.scopeSecretRefs || [])
    .filter((item) => scopeMatches(connection.scope, item.scope))
    .flatMap((item) => item.names);
  return [...new Set([...definition.requiredSecretRefNames, ...conditional])];
}

function scopeMatches(actual, expected) {
  return expected.endsWith('*') ? actual.startsWith(expected.slice(0, -1)) : actual === expected;
}

function compareConnections(left, right) {
  const rank = { ready: 0, unverified: 1, blocked: 2, archived: 3 };
  return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || left.id.localeCompare(right.id);
}

function isExecutionReady(item) {
  return item.status === 'ready' || item.status === 'needs-secret-preflight';
}

function normalizeProviders(values) {
  const requested = values && values.length > 0 ? values : Object.keys(REQUIREMENTS);
  const providers = [...new Set(requested.map((value) => String(value || '').toLowerCase()))].sort();
  if (providers.length === 0 || providers.some((provider) => !REQUIREMENTS[provider])) {
    throw operationError('VALIDATION_FAILED', 'Provider acceptance readiness contains an unsupported provider.');
  }
  return providers;
}
