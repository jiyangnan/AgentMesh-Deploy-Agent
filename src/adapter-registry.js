import { createCloudflareV2AdapterFromConnection } from './adapters/cloudflare-v2.js';
import { createGitHubV2AdapterFromConnection } from './adapters/github-v2.js';
import { createNeonV2AdapterFromConnection } from './adapters/neon-v2.js';
import { createRailwayV2AdapterFromConnection } from './adapters/railway-v2.js';
import { createResendV2AdapterFromConnection } from './adapters/resend-v2.js';
import { createSupabaseV2AdapterFromConnection } from './adapters/supabase-v2.js';
import { createVercelV2AdapterFromConnection } from './adapters/vercel-v2.js';
import { operationError } from './errors.js';

const FACTORIES = Object.freeze({
  github: createGitHubV2AdapterFromConnection,
  cloudflare: createCloudflareV2AdapterFromConnection,
  vercel: createVercelV2AdapterFromConnection,
  railway: createRailwayV2AdapterFromConnection,
  resend: createResendV2AdapterFromConnection,
  neon: createNeonV2AdapterFromConnection,
  supabase: createSupabaseV2AdapterFromConnection,
});

export function createAdapterRegistry(connections, runtime = {}) {
  const byId = new Map((connections || []).map((connection) => [connection.id, connection]));
  const instances = new Map();
  return Object.freeze({
    get(connectionId, expectedProvider = '') {
      const connection = lookup(runtime.materializedConnections, connectionId) || byId.get(connectionId);
      if (!connection) throw operationError('NOT_FOUND', `Provider Connection not found: ${connectionId}`);
      if (connection.status !== 'ready') throw operationError('CREDENTIAL_MISSING', `Provider Connection is not ready: ${connectionId}`);
      if (expectedProvider && connection.provider !== expectedProvider) {
        throw operationError('CONFLICT', `Provider Connection ${connectionId} belongs to ${connection.provider}, not ${expectedProvider}.`);
      }
      if (instances.has(connectionId)) return instances.get(connectionId);
      const injected = lookup(runtime.adapters, connectionId) || lookup(runtime.adapters, connection.provider);
      const adapter = injected || instantiateAdapter(connection, runtime);
      instances.set(connectionId, adapter);
      return adapter;
    },
  });
}

export function supportedAdapterProviders() {
  return Object.keys(FACTORIES).sort();
}

function instantiateAdapter(connection, runtime) {
  const factory = FACTORIES[connection.provider];
  if (!factory) throw operationError('UNSUPPORTED', `No V2 Adapter factory is registered for ${connection.provider}.`);
  const options = {
    ...(lookup(runtime.providerOptions, connection.provider) || {}),
    ...(lookup(runtime.connectionOptions, connection.id) || {}),
  };
  if (!options.transport && runtime.allowNetworkTransport !== true) {
    throw operationError(
      'UNSUPPORTED',
      `Adapter ${connection.provider} requires an injected Transport; real network transport is disabled in this executor.`
    );
  }
  return factory(connection, options);
}

function lookup(collection, key) {
  if (!collection) return undefined;
  if (collection instanceof Map) return collection.get(key);
  return collection[key];
}
