import fs from 'node:fs';

const PUBLIC_KEY_ALGORITHMS = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export function inspectSshKeyMaterial(action, env = process.env) {
  const issues = [];
  const privateIssue = inspectPrivateIdentity(action, env);
  if (privateIssue) issues.push(privateIssue);

  const publicIssue = inspectPublicKey(action, env);
  if (publicIssue) issues.push(publicIssue);

  return issues;
}

function inspectPrivateIdentity(action, env) {
  const identityFileEnv = action.identityFileEnv || 'AGENTMESH_DEPLOY_SSH_KEY_PATH';
  const privateKeyEnv = action.privateKeyEnv || 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY';
  const identityFile = env[identityFileEnv];
  if (identityFile) {
    if (!fs.existsSync(identityFile)) {
      return issue('identity-file-missing', identityFileEnv, `SSH identity file does not exist: ${identityFile}`);
    }
    try {
      const stat = fs.statSync(identityFile);
      if (!stat.isFile()) {
        return issue('identity-file-invalid', identityFileEnv, `SSH identity path is not a file: ${identityFile}`);
      }
      const validation = validatePrivateKey(fs.readFileSync(identityFile, 'utf8'));
      if (!validation.valid) {
        return issue('identity-file-invalid', identityFileEnv, `SSH identity file is not a valid private key: ${validation.reason}`);
      }
    } catch (error) {
      return issue(
        'identity-file-unreadable',
        identityFileEnv,
        `SSH identity file cannot be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }

  const privateKey = env[privateKeyEnv];
  if (!privateKey) return null;
  const validation = validatePrivateKey(privateKey);
  return validation.valid
    ? null
    : issue('private-key-invalid', privateKeyEnv, `SSH private key is malformed: ${validation.reason}`);
}

function inspectPublicKey(action, env) {
  const publicKeyEnv = action.publicKeyEnv || '';
  if (!publicKeyEnv) return null;

  const sshKeysEnv = action.sshKeysEnv || '';
  if (sshKeysEnv && env[sshKeysEnv]) return null;

  const publicKey = env[publicKeyEnv];
  if (!publicKey) return null;
  const validation = validatePublicKey(publicKey);
  return validation.valid
    ? null
    : issue('public-key-invalid', publicKeyEnv, `SSH public key is malformed: ${validation.reason}`);
}

function validatePrivateKey(value) {
  const text = normalizeKeyText(value);
  const begin = text.match(/^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----$/m);
  const end = text.match(/^-----END ([A-Z0-9 ]*PRIVATE KEY)-----$/m);
  if (!begin || !end) {
    return { valid: false, reason: 'missing private key BEGIN/END markers' };
  }
  if (begin[1] !== end[1]) {
    return { valid: false, reason: 'private key BEGIN/END labels do not match' };
  }

  const start = text.indexOf(begin[0]) + begin[0].length;
  const finish = text.indexOf(end[0]);
  const body = text.slice(start, finish).trim();
  if (!body) {
    return { valid: false, reason: 'private key body is empty' };
  }
  return { valid: true };
}

function validatePublicKey(value) {
  const firstLine = String(value || '').replace(/\\n/g, '\n').trim().split(/\r?\n/).find(Boolean) || '';
  const parts = firstLine.split(/\s+/);
  if (parts.length < 2) {
    return { valid: false, reason: 'expected "<algorithm> <base64-key>"' };
  }

  const [algorithm, encoded] = parts;
  if (!PUBLIC_KEY_ALGORITHMS.has(algorithm)) {
    return { valid: false, reason: `unsupported algorithm ${algorithm}` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return { valid: false, reason: 'public key payload is not valid base64' };
  }
  try {
    if (Buffer.from(encoded, 'base64').length === 0) {
      return { valid: false, reason: 'public key payload is empty' };
    }
  } catch {
    return { valid: false, reason: 'public key payload is not valid base64' };
  }
  return { valid: true };
}

function normalizeKeyText(value) {
  const text = String(value || '').replace(/\\n/g, '\n').trim();
  return text.endsWith('\n') ? text : `${text}\n`;
}

function issue(id, source, message) {
  return { id, source, message };
}
