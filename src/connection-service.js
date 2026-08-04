import fs from 'node:fs';
import path from 'node:path';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { providerById } from './provider-catalog.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const CONNECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const SECRET_REF = /^(?:env:\/\/[A-Z][A-Z0-9_]*|keychain:\/\/[A-Za-z0-9._/-]+|op:\/\/[A-Za-z0-9._/-]+|secret:\/\/[A-Za-z0-9._/-]+)$/;

export function addConnection(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'connection-add', () => {
    const project = readProjectRecord(home, options.projectId);
    const store = readConnectionStore(home, project.id);
    const id = assertConnectionId(options.connectionId);
    if (store.connections.some((connection) => connection.id === id)) {
      throw operationError('ALREADY_EXISTS', `Connection already exists: ${id}`);
    }
    const provider = providerById(options.provider);
    const secretRefs = parseAndValidateSecretRefs(options.secretRefs, provider);
    const timestamp = options.now || nowIso();
    const connection = {
      schemaVersion: 1,
      kind: 'ProviderConnection',
      id,
      projectId: project.id,
      provider: provider.id,
      authMethod: inferAuthMethod(secretRefs, provider),
      scope: options.connectionScope || 'default',
      secretRefs,
      version: 1,
      status: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    validateConnection(connection, project.id);
    writeConnectionStore(home, project.id, {
      ...store,
      connections: [...store.connections, connection].sort((left, right) => left.id.localeCompare(right.id)),
    });
    return connectionReport('create', home, connection);
  });
}

export function copyConnection(options) {
  const home = resolveDeployHome(options.home);
  const sourceProject = readProjectRecord(home, options.connectionSourceProjectId);
  const targetProject = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, sourceProject.source);
  assertControlHomeSeparated(home, targetProject.source);
  const sourceBefore = captureSourceGuard(sourceProject.source);
  const targetBefore = captureSourceGuard(targetProject.source);

  const report = withControlLock(home, `project:${targetProject.id}`, 'connection-copy', () => {
    const sourceStore = readConnectionStore(home, sourceProject.id);
    const source = findConnection(sourceStore, options.connectionSourceId, false);
    assertExpectedVersion(source, options.expectedVersion);
    const targetStore = readConnectionStore(home, targetProject.id);
    const targetId = assertConnectionId(options.connectionId);
    if (sourceProject.id === targetProject.id && source.id === targetId) {
      throw operationError('CONFLICT', 'Source and target Connection must be different.');
    }
    if (targetStore.connections.some((connection) => connection.id === targetId)) {
      throw operationError('ALREADY_EXISTS', `Connection already exists: ${targetId}`);
    }

    const provider = providerById(source.provider);
    const secretRefs = parseAndValidateSecretRefs(
      Object.entries(source.secretRefs).map(([name, ref]) => `${name}=${ref}`),
      provider
    );
    const timestamp = options.now || nowIso();
    const connection = {
      schemaVersion: 1,
      kind: 'ProviderConnection',
      id: targetId,
      projectId: targetProject.id,
      provider: provider.id,
      authMethod: inferAuthMethod(secretRefs, provider),
      scope: source.scope,
      secretRefs,
      copiedFrom: {
        projectId: sourceProject.id,
        connectionId: source.id,
        version: source.version,
      },
      version: 1,
      status: 'unverified',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    validateConnection(connection, targetProject.id);
    writeConnectionStore(home, targetProject.id, {
      ...targetStore,
      connections: [...targetStore.connections, connection].sort((left, right) => left.id.localeCompare(right.id)),
    });
    return connectionReport('copy', home, connection);
  });

  return {
    ...report,
    sourceConnection: {
      projectId: sourceProject.id,
      connectionId: report.connection.copiedFrom.connectionId,
      version: report.connection.copiedFrom.version,
    },
    sourceRepositoryGuard: completeSourceGuard(sourceProject.source, sourceBefore),
    targetRepositoryGuard: completeSourceGuard(targetProject.source, targetBefore),
    providerProbeInherited: false,
    secretValuesRead: false,
  };
}

export function listConnections(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId, { includeArchived: options.includeArchived });
  const connections = readConnectionStore(home, project.id).connections
    .filter((connection) => options.includeArchived || connection.status !== 'archived')
    .sort((left, right) => left.id.localeCompare(right.id));
  return { kind: 'connection-list', home, projectId: project.id, count: connections.length, connections };
}

export function showConnection(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId, { includeArchived: options.includeArchived });
  const connection = findConnection(readConnectionStore(home, project.id), options.connectionId, options.includeArchived);
  return connectionReport('read', home, connection);
}

export function updateConnection(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'connection-update', () => {
    const project = readProjectRecord(home, options.projectId);
    const store = readConnectionStore(home, project.id);
    const current = findConnection(store, options.connectionId, false);
    assertExpectedVersion(current, options.expectedVersion);
    const provider = providerById(options.providerExplicit ? options.provider : current.provider);
    const secretRefs = options.secretRefs.length > 0
      ? parseAndValidateSecretRefs(options.secretRefs, provider)
      : current.secretRefs;
    const timestamp = options.now || nowIso();
    const connection = {
      ...current,
      provider: provider.id,
      authMethod: inferAuthMethod(secretRefs, provider),
      scope: options.connectionScope || current.scope,
      secretRefs,
      version: current.version + 1,
      status: 'unverified',
      updatedAt: timestamp,
    };
    validateConnection(connection, project.id);
    writeConnectionStore(home, project.id, replaceConnection(store, connection));
    return connectionReport('update', home, connection);
  });
}

export function removeConnection(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Archiving a connection requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'connection-remove', () => {
    const project = readProjectRecord(home, options.projectId);
    const store = readConnectionStore(home, project.id);
    const current = findConnection(store, options.connectionId, false);
    assertExpectedVersion(current, options.expectedVersion);
    const timestamp = options.now || nowIso();
    const connection = {
      ...current,
      version: current.version + 1,
      status: 'archived',
      archivedAt: timestamp,
      updatedAt: timestamp,
    };
    writeConnectionStore(home, project.id, replaceConnection(store, connection));
    return {
      ...connectionReport('archive', home, connection),
      providerCredentialRevoked: false,
      nextAction: '如不再使用该凭证，请由用户在供应商控制台撤销，或由未来受控 Adapter 执行撤销。',
    };
  });
}

export function checkConnection(options) {
  const report = showConnection(options);
  const env = options.env || process.env;
  const refs = Object.entries(report.connection.secretRefs).map(([name, ref]) => {
    const envName = ref.startsWith('env://') ? ref.slice('env://'.length) : '';
    return {
      name,
      ref,
      source: ref.split('://')[0],
      status: envName ? (Object.prototype.hasOwnProperty.call(env, envName) && env[envName] ? 'present' : 'missing') : 'not-probed',
    };
  });
  const missing = refs.filter((item) => item.status === 'missing').map((item) => item.name);
  return {
    kind: 'connection-readiness',
    operation: 'check',
    home: report.home,
    projectId: report.projectId,
    connectionId: report.connection.id,
    provider: report.connection.provider,
    status: missing.length > 0 ? 'blocked' : (refs.some((item) => item.status === 'not-probed') ? 'needs-probe' : 'ready'),
    refs,
    missing,
    secretValuesExposed: false,
    providerProbeExecuted: false,
  };
}

export function recordConnectionProbe(options, actionResult) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'connection-probe-record', () => {
    const project = readProjectRecord(home, options.projectId);
    const store = readConnectionStore(home, project.id);
    const current = findConnection(store, options.connectionId, false);
    assertExpectedVersion(current, options.expectedVersion);
    const timestamp = options.now || nowIso();
    const connection = {
      ...current,
      version: current.version + 1,
      status: actionResult.ok ? 'ready' : 'blocked',
      identity: actionResult.ok ? actionResult.data.identity : current.identity || {},
      capabilities: actionResult.ok ? actionResult.data.capabilities : current.capabilities || [],
      verifiedAt: actionResult.ok ? timestamp : current.verifiedAt || '',
      lastProbe: {
        status: actionResult.status,
        errorCode: actionResult.error?.code || '',
        probedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    validateConnection(connection, project.id);
    writeConnectionStore(home, project.id, replaceConnection(store, connection));
    return connection;
  });
}

export function validateConnection(connection, expectedProjectId = '') {
  const issues = [];
  if (connection?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (connection?.kind !== 'ProviderConnection') issues.push('$.kind');
  if (!CONNECTION_ID.test(connection?.id || '')) issues.push('$.id');
  if (expectedProjectId && connection?.projectId !== expectedProjectId) issues.push('$.projectId');
  if (!Number.isInteger(connection?.version) || connection.version < 1) issues.push('$.version');
  if (!['unverified', 'ready', 'blocked', 'archived'].includes(connection?.status)) issues.push('$.status');
  if (!connection?.secretRefs || typeof connection.secretRefs !== 'object' || Array.isArray(connection.secretRefs)) issues.push('$.secretRefs');
  for (const [name, ref] of Object.entries(connection?.secretRefs || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !SECRET_REF.test(ref)) issues.push(`$.secretRefs.${name}`);
  }
  if (connection?.identity !== undefined && (!connection.identity || typeof connection.identity !== 'object' || Array.isArray(connection.identity))) issues.push('$.identity');
  if (connection?.capabilities !== undefined && !Array.isArray(connection.capabilities)) issues.push('$.capabilities');
  if (connection?.copiedFrom !== undefined && (
    !connection.copiedFrom || typeof connection.copiedFrom !== 'object' || Array.isArray(connection.copiedFrom) ||
    typeof connection.copiedFrom.projectId !== 'string' || !connection.copiedFrom.projectId ||
    !CONNECTION_ID.test(connection.copiedFrom.connectionId || '') ||
    !Number.isInteger(connection.copiedFrom.version) || connection.copiedFrom.version < 1 ||
    Object.keys(connection.copiedFrom).sort().join(',') !== 'connectionId,projectId,version'
  )) issues.push('$.copiedFrom');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Provider Connection is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  return connection;
}

function parseAndValidateSecretRefs(values, provider) {
  const refs = {};
  for (const value of values || []) {
    const separator = value.indexOf('=');
    if (separator < 1) throw operationError('VALIDATION_FAILED', '--secret-ref must use ENV_NAME=secret-reference.');
    const name = value.slice(0, separator);
    const ref = value.slice(separator + 1);
    if (Object.prototype.hasOwnProperty.call(refs, name)) throw operationError('CONFLICT', `Duplicate Secret Ref key: ${name}`);
    if (!SECRET_REF.test(ref)) {
      throw operationError('SECRET_IN_INPUT', `Secret values are forbidden; ${name} must use env://, keychain://, op://, or secret://.`);
    }
    refs[name] = ref;
  }
  const allowed = new Set([
    ...provider.credentialContract.options.map((option) => option.env),
    ...(provider.credentialContract.contextEnv || []),
  ]);
  const unknown = Object.keys(refs).filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw operationError('VALIDATION_FAILED', `Provider does not declare Secret Ref keys: ${unknown.join(', ')}`);
  const credentialKeys = provider.credentialContract.options.map((option) => option.env);
  const selected = credentialKeys.filter((name) => refs[name]);
  const requiredCount = provider.credentialContract.mode === 'all' ? credentialKeys.length : 1;
  if (selected.length !== requiredCount) {
    throw operationError(
      'VALIDATION_FAILED',
      provider.credentialContract.mode === 'all'
        ? `Provider requires all credential refs: ${credentialKeys.join(', ')}`
        : `Provider requires exactly one credential ref: ${credentialKeys.join(' or ')}`
    );
  }
  return Object.fromEntries(Object.entries(refs).sort(([left], [right]) => left.localeCompare(right)));
}

function inferAuthMethod(secretRefs, provider) {
  return provider.credentialContract.options
    .filter((option) => secretRefs[option.env])
    .map((option) => option.id)
    .join('+');
}

function readConnectionStore(home, projectId) {
  const file = connectionStorePath(home, projectId);
  if (!fs.existsSync(file)) return { schemaVersion: 1, kind: 'ProviderConnectionStore', projectId, connections: [] };
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Connection store JSON is invalid: ${error.message}`);
  }
  if (store.schemaVersion !== 1 || store.kind !== 'ProviderConnectionStore' || store.projectId !== projectId || !Array.isArray(store.connections)) {
    throw operationError('VALIDATION_FAILED', `Connection store is invalid: ${file}`);
  }
  store.connections.forEach((connection) => validateConnection(connection, projectId));
  return store;
}

function writeConnectionStore(home, projectId, store) {
  writeJsonAtomic(connectionStorePath(home, projectId), store);
}

function connectionStorePath(home, projectId) {
  return path.join(projectPath(home, projectId), 'connections.json');
}

function findConnection(store, connectionId, includeArchived) {
  const id = assertConnectionId(connectionId);
  const connection = store.connections.find((item) => item.id === id);
  if (!connection || (!includeArchived && connection.status === 'archived')) {
    throw operationError('NOT_FOUND', `Connection not found: ${id}`);
  }
  return connection;
}

function replaceConnection(store, connection) {
  return {
    ...store,
    connections: store.connections.map((item) => item.id === connection.id ? connection : item),
  };
}

function assertExpectedVersion(connection, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion !== connection.version) {
    throw operationError('CONFLICT', `Connection version mismatch. Expected ${expectedVersion || '(missing)'}, current ${connection.version}.`);
  }
}

function assertConnectionId(value) {
  if (!CONNECTION_ID.test(value || '')) {
    throw operationError('VALIDATION_FAILED', 'Connection id must use 1-63 lowercase letters, numbers, or hyphens.');
  }
  return value;
}

function connectionReport(operation, home, connection) {
  return {
    kind: 'connection',
    operation,
    status: 'succeeded',
    home,
    projectId: connection.projectId,
    connection,
    recovery: connectionRecovery(connection),
    connectionFile: connectionStorePath(home, connection.projectId),
    secretValuesStored: false,
    providerMutationsExecuted: 0,
    productRepositoryChanged: false,
  };
}

export function connectionRecovery(connection) {
  if (connection.status !== 'blocked') {
    return { status: 'not-required', errorCode: '', requiresHumanCredentialAction: false, nextActions: [] };
  }
  const errorCode = connection.lastProbe?.errorCode || 'PROVIDER_PROBE_BLOCKED';
  const credentialFailure = errorCode === 'CREDENTIAL_MISSING';
  const capabilityFailure = errorCode === 'CAPABILITY_MISSING';
  const nextActions = [];
  if (credentialFailure || capabilityFailure) {
    nextActions.push({
      kind: credentialFailure ? 'replace-expired-or-invalid-credential' : 'create-minimum-scope-credential',
      requiresHumanCredentialAction: true,
      providerMutationAuthorized: false,
      instruction: credentialFailure
        ? '在供应商后台创建替代凭证，先登记为并行 Connection 并完成只读 Probe；新计划接管后再人工撤销旧凭证。'
        : '按阻断消息补齐最小 Scope，登记为并行 Connection 并完成只读 Scope Probe；不要扩大现有凭证权限。',
    });
  }
  nextActions.push({
    kind: 'probe-connection',
    requiresHumanCredentialAction: false,
    providerMutationAuthorized: false,
    instruction: '凭证或临时供应商故障处理后，显式执行只读 connection probe；写 API 不会自动重试。',
  });
  return {
    status: credentialFailure ? 'reauthorization-required'
      : (capabilityFailure ? 'minimum-scope-required' : 'probe-retry-required'),
    errorCode,
    requiresHumanCredentialAction: credentialFailure || capabilityFailure,
    nextActions,
  };
}
