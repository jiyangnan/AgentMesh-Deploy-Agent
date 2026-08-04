import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { operationError } from './errors.js';

const SECRET_REF = /^(env|keychain|op|secret):\/\/([A-Za-z0-9._/-]+)$/;
const MAX_SECRET_BYTES = 64 * 1024;
const KEYCHAIN_WRITER = fileURLToPath(new URL('../scripts/keychain-write.exp', import.meta.url));

export function createSecretRuntime(options = {}) {
  const env = options.env || process.env;
  const stores = options.stores || {};
  const commandRunner = options.commandRunner || runSecretCommand;
  const keychainWriter = options.keychainWriter || (options.commandRunner ? null : runNativeKeychainWrite);
  const keychainWritable = options.keychainWritable === undefined
    ? process.platform === 'darwin'
    : options.keychainWritable === true;
  return Object.freeze({
    async resolve(ref) {
      const parsed = parseSecretRef(ref);
      const backend = lookup(stores, parsed.scheme);
      if (backend?.resolve) return validateSecretValue(await backend.resolve(ref), ref);
      if (backend?.read) return validateSecretValue((await backend.read(ref))?.value, ref);
      if (parsed.scheme === 'env') {
        if (!env[parsed.target]) throw operationError('CREDENTIAL_MISSING', `Environment Secret Ref is missing: ${parsed.target}`);
        return validateSecretValue(env[parsed.target], ref);
      }
      if (parsed.scheme === 'keychain') return resolveKeychain(parsed, commandRunner);
      if (parsed.scheme === 'op') return resolveOnePassword(ref, parsed, commandRunner);
      throw operationError('CAPABILITY_MISSING', `No Secret Store backend is configured for ${parsed.scheme}://.`);
    },
    async read(ref) {
      return { ref, value: await this.resolve(ref) };
    },
    async check(ref) {
      const parsed = parseSecretRef(ref);
      const backend = lookup(stores, parsed.scheme);
      if (backend?.check) return normalizeCheck(ref, await backend.check(ref));
      const writable = Boolean(backend?.store) || (parsed.scheme === 'keychain' && keychainWritable);
      try {
        await this.resolve(ref);
        return { ref, present: true, readable: true, writable };
      } catch (error) {
        if (['CREDENTIAL_MISSING', 'NOT_FOUND'].includes(error.code)) {
          return { ref, present: false, readable: false, writable };
        }
        throw error;
      }
    },
    async store(ref, value, metadata = {}) {
      const parsed = parseSecretRef(ref);
      const backend = lookup(stores, parsed.scheme);
      if (!backend?.store && !(parsed.scheme === 'keychain' && keychainWritable)) {
        throw operationError('CAPABILITY_MISSING', `Secret Store ${parsed.scheme}:// is not writable in this runtime.`);
      }
      const secret = validateSecretValue(value, ref);
      const result = backend?.store
        ? await backend.store(ref, secret, sanitizeMetadata(metadata))
        : storeKeychain(parsed, secret, commandRunner, metadata, keychainWriter);
      if (result?.ref !== ref) throw operationError('SECRET_CAPTURE_FAILED', 'Secret Store returned a different destination Ref.');
      return { ref };
    },
  });
}

export async function materializeProviderConnection(connection, secretRuntime) {
  if (!secretRuntime || typeof secretRuntime.resolve !== 'function') {
    throw operationError('CAPABILITY_MISSING', 'A Secret Runtime is required to materialize ProviderConnection credentials.');
  }
  const env = {};
  const secretRefs = {};
  for (const [name, ref] of Object.entries(connection.secretRefs || {})) {
    env[name] = await secretRuntime.resolve(ref);
    secretRefs[name] = `env://${name}`;
  }
  return {
    connection: { ...connection, secretRefs },
    env,
    resolvedRefCount: Object.keys(secretRefs).length,
  };
}

export async function prepareAdapterRuntime(connections, plan, runtime = {}) {
  const usedConnectionIds = new Set((plan.actions || []).map((action) => action.connectionId));
  const selected = (connections || []).filter((connection) => usedConnectionIds.has(connection.id));
  const requiresMaterialization = selected.filter((connection) =>
    Object.values(connection.secretRefs || {}).some((ref) => !String(ref).startsWith('env://'))
  );
  if (requiresMaterialization.length === 0) return runtime;
  if (!runtime.secretRuntime) {
    throw operationError('CAPABILITY_MISSING', 'Adapter plan uses non-env Secret Refs but no Secret Runtime was injected.');
  }
  const materializedConnections = new Map();
  const connectionOptions = new Map();
  for (const connection of requiresMaterialization) {
    const materialized = await materializeProviderConnection(connection, runtime.secretRuntime);
    materializedConnections.set(connection.id, materialized.connection);
    connectionOptions.set(connection.id, { env: materialized.env });
  }
  return {
    ...runtime,
    materializedConnections,
    connectionOptions,
  };
}

export function parseSecretRef(ref) {
  const match = String(ref || '').match(SECRET_REF);
  if (!match) throw operationError('VALIDATION_FAILED', 'Secret Ref is invalid.');
  const parsed = { scheme: match[1], target: match[2] };
  if (parsed.scheme === 'env' && !/^[A-Z][A-Z0-9_]*$/.test(parsed.target)) {
    throw operationError('VALIDATION_FAILED', 'Environment Secret Ref name is invalid.');
  }
  if (parsed.scheme === 'keychain') {
    const parts = parsed.target.split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) {
      throw operationError('VALIDATION_FAILED', 'Keychain Secret Ref must be keychain://service/account.');
    }
    parsed.service = parts[0];
    parsed.account = parts[1];
  }
  if (parsed.scheme === 'op' && parsed.target.split('/').filter(Boolean).length < 3) {
    throw operationError('VALIDATION_FAILED', '1Password Secret Ref must identify vault/item/field.');
  }
  return parsed;
}

function resolveKeychain(parsed, commandRunner) {
  const result = commandRunner('security', [
    'find-generic-password', '-s', parsed.service, '-a', parsed.account, '-w',
  ]);
  if (result.status !== 0) throw operationError('CREDENTIAL_MISSING', 'macOS Keychain Secret Ref could not be resolved.');
  return validateSecretValue(String(result.stdout || '').replace(/\r?\n$/, ''), `keychain://${parsed.target}`);
}

function storeKeychain(parsed, value, commandRunner, metadata = {}, keychainWriter) {
  const ref = `keychain://${parsed.target}`;
  if (/[\r\n]/.test(value)) {
    throw operationError('VALIDATION_FAILED', 'macOS Keychain Secret values must be a single line.');
  }
  const result = keychainWriter
    ? keychainWriter(parsed, value, metadata)
    : commandRunner('security', [
      'add-generic-password', ...(metadata.writeMode === 'create-only' ? [] : ['-U']),
      '-s', parsed.service, '-a', parsed.account, '-w',
    ], { input: `${value}\n` });
  if (result.status !== 0) {
    throw operationError('SECRET_CAPTURE_FAILED', 'macOS Keychain could not store the destination Secret Ref.');
  }
  return { ref };
}

function runNativeKeychainWrite(parsed, value, metadata = {}) {
  const writeMode = metadata.writeMode === 'create-only' ? 'create-only' : 'overwrite';
  const result = spawnSync('/usr/bin/expect', [
    KEYCHAIN_WRITER, parsed.service, parsed.account, writeMode,
  ], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    timeout: 20000,
    input: `${value}\n`,
  });
  return { status: result.status ?? 1, stdout: '', stderr: '' };
}

function resolveOnePassword(ref, parsed, commandRunner) {
  const result = commandRunner('op', ['read', `op://${parsed.target}`]);
  if (result.status !== 0) throw operationError('CREDENTIAL_MISSING', '1Password Secret Ref could not be resolved.');
  return validateSecretValue(String(result.stdout || '').replace(/\r?\n$/, ''), ref);
}

function runSecretCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: process.env,
    timeout: 10000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: '' };
}

function validateSecretValue(value, ref) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw operationError('CREDENTIAL_MISSING', `Secret Ref returned no usable value: ${ref.split('://')[0]}://.`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw operationError('VALIDATION_FAILED', `Secret Ref value exceeds ${MAX_SECRET_BYTES} bytes.`);
  }
  return value;
}

function normalizeCheck(ref, result) {
  if (!result || result.ref !== ref) throw operationError('SECRET_CAPTURE_FAILED', 'Secret Store check returned a different Ref.');
  return {
    ref,
    present: result.present === true,
    readable: result.readable !== false,
    writable: result.writable === true,
  };
}

function sanitizeMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([key, value]) =>
    !/(?:token|secret|password|authorization|cookie|value)$/i.test(key) &&
    ['string', 'number', 'boolean'].includes(typeof value)
  ));
}

function lookup(collection, key) {
  if (!collection) return undefined;
  if (collection instanceof Map) return collection.get(key);
  return collection[key];
}
