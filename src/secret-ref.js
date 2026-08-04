import { operationError } from './errors.js';

export function resolveConnectionSecretRefs(connection, options = {}) {
  const env = options.env || process.env;
  const purpose = options.purpose || 'Provider operation';
  const resolved = {};
  for (const [name, ref] of Object.entries(connection.secretRefs || {})) {
    if (!ref.startsWith('env://')) {
      throw operationError('CREDENTIAL_MISSING', `${purpose} cannot resolve ${ref.split('://')[0]} Secret Ref yet: ${name}`);
    }
    const envName = ref.slice('env://'.length);
    if (!env[envName]) throw operationError('CREDENTIAL_MISSING', `Environment Secret Ref is missing: ${envName}`);
    resolved[name] = env[envName];
  }
  return resolved;
}
