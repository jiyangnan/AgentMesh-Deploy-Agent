import { operationError } from './errors.js';
import { createSecretRuntime, parseSecretRef } from './secret-store.js';

const MAX_SECRET_BYTES = 64 * 1024;

export async function captureSecret(options) {
  if (!options.fromStdin) {
    throw operationError('APPROVAL_REQUIRED', 'Secret capture requires explicit --stdin; secret values in arguments are forbidden.');
  }
  if (!options.yes) {
    throw operationError('APPROVAL_REQUIRED', 'Secret capture requires explicit --yes confirmation.');
  }
  const parsed = parseSecretRef(options.secretRef);
  if (parsed.scheme !== 'keychain' && !options.secretRuntime) {
    throw operationError('CAPABILITY_MISSING', 'Public Secret capture currently supports native keychain:// destinations only.');
  }
  const runtime = options.secretRuntime || createSecretRuntime({
    commandRunner: options.commandRunner,
    keychainWritable: options.keychainWritable,
  });
  const readiness = await runtime.check(options.secretRef);
  if (!readiness.writable) {
    throw operationError('CAPABILITY_MISSING', `Secret destination is not writable: ${parsed.scheme}://.`);
  }
  if (readiness.present && !options.overwriteSecret) {
    throw operationError('CONFLICT', 'Secret destination already contains a value; use --overwrite only after confirming rotation intent.');
  }
  const value = await readSecretInput(options.input, options.stdin || process.stdin);
  await runtime.store(options.secretRef, value, {
    purpose: 'provider-bootstrap',
    writeMode: options.overwriteSecret ? 'overwrite' : 'create-only',
  });
  return {
    kind: 'secret-capture',
    operation: 'capture',
    status: 'succeeded',
    ref: options.secretRef,
    backend: parsed.scheme,
    overwritten: readiness.present,
    inputSource: 'stdin',
    secretValueExposed: false,
    secretValuePersistedInControlPlane: false,
    providerMutationsExecuted: 0,
    productRepositoryChanged: false,
  };
}

async function readSecretInput(injected, stdin) {
  if (injected !== undefined) return normalizeSecretInput(injected);
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== 'function') {
    throw operationError('VALIDATION_FAILED', 'Secret capture stdin is unavailable.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.length;
    if (bytes > MAX_SECRET_BYTES + 2) {
      throw operationError('VALIDATION_FAILED', `Secret capture input exceeds ${MAX_SECRET_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return normalizeSecretInput(Buffer.concat(chunks));
}

function normalizeSecretInput(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  let text = buffer.toString('utf8');
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (!text || text.includes('\0')) throw operationError('VALIDATION_FAILED', 'Secret capture stdin is empty or invalid.');
  if (Buffer.byteLength(text, 'utf8') > MAX_SECRET_BYTES) {
    throw operationError('VALIDATION_FAILED', `Secret capture input exceeds ${MAX_SECRET_BYTES} bytes.`);
  }
  return text;
}
