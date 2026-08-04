import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { findCloudflareResource, parseCapture } from './parsers.js';
import { parseEnvContent } from './renderers.js';
import { writeManagedFile } from './renderers.js';
import { inspectSshKeyMaterial } from './ssh-keys.js';
import {
  defaultToolResolver,
  githubRemoteUrlsMatch,
  githubRepoSlugFromTarget,
  githubRepoSlugFromUrl,
  githubRepoTargetMatches,
  githubRepoUrlFromRepo,
  inspectGitIdentity,
  readGitTrackedFiles,
  sensitiveTrackedFiles,
} from './tooling.js';
import { formatCommand, readTextIfExists } from './utils.js';

const GITHUB_SECRET_DEFAULT_MAX_ATTEMPTS = 4;
const GITHUB_SECRET_DEFAULT_RETRY_DELAY_MS = 5000;

export function executeActions(root, step, options = {}) {
  const actions = step.actions || [];
  if (actions.length === 0) {
    if (step.kind === 'check') return { status: 'completed', outputs: [], captures: {} };
    throw new Error(`Step ${step.id} has no executable actions.`);
  }

  const outputs = [];
  const captures = {};
  const stateUpdates = {};
  const renderContext = options.renderContext || {};

  for (const action of actions) {
    enforcePolicy(action, options);
    let result;
    try {
      result = executeAction(root, action, { ...options, renderContext });
    } catch (error) {
      result = {
        status: 'failed',
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    outputs.push(result);
    if (result.status !== 'completed') {
      return {
        status: 'failed',
        outputs,
        captures,
        error: result.error || `Action failed: ${action.effect}`,
      };
    }

    Object.assign(stateUpdates, action.stateUpdates || {});

    for (const capture of action.captures || []) {
      const value = parseCapture(`${result.stdout}\n${result.stderr}`, capture);
      if (value) {
        captures[capture.key] = value;
        if (capture.statePath) {
          stateUpdates[capture.statePath] = value;
        }
        if (capture.statePath?.endsWith('.providerId')) {
          captures.providerId = value;
        }
      }
      if (!value && capture.required) {
        return {
          status: 'failed',
          outputs,
          captures,
          stateUpdates,
          error: `Required capture ${capture.key} was not found for action: ${action.effect}`,
        };
      }
    }
  }

  return { status: 'completed', outputs, captures, stateUpdates };
}

export function canExecuteAction(action, options = {}) {
  const sideEffect = action.sideEffect || 'unknown';
  if (sideEffect === 'provider-mutation') {
    if (options.allowProviderMutations !== true) return false;
    if (action.requiresCostApproval && options.allowCostMutations !== true) return false;
    return true;
  }
  if (sideEffect === 'provider-delete') return options.allowProviderDeletes === true;
  if (sideEffect === 'unknown') return false;
  return true;
}

function enforcePolicy(action, options) {
  if (canExecuteAction(action, options)) return;
  if (action.sideEffect === 'provider-mutation' && action.requiresCostApproval) {
    throw new Error(
      `Action blocked by policy: ${action.effect}. sideEffect=provider-mutation requires --allow-provider-mutations and --allow-cost-mutations`
    );
  }
  throw new Error(
    `Action blocked by policy: ${action.effect}. sideEffect=${action.sideEffect || 'unknown'}`
  );
}

function executeAction(root, action, options) {
  if (action.type === 'command') {
    return runCommand(root, action.command, resolveCommandInput(root, action, options.state), {
      allowProductShell: action.commandTrust === 'product-manifest',
      redactOutput: shouldRedactOutput(action),
      ...retryOptions(action),
      quiet: options.quiet,
    });
  }

  if (action.type === 'provider-auth-check') {
    const result = runCommand(root, action.command, undefined, {
      ...retryOptions(action),
      quiet: options.quiet,
    });
    return applyFailurePatterns(result, action);
  }

  if (action.type === 'cloudflare-resource') {
    return ensureCloudflareResource(root, action, options);
  }

  if (action.type === 'cloudflare-zone') {
    return ensureCloudflareZone(root, action, options);
  }

  if (action.type === 'digitalocean-droplet') {
    return ensureDigitalOceanDroplet(root, action, options);
  }

  if (action.type === 'digitalocean-ssh-key') {
    return ensureDigitalOceanSshKey(root, action, options);
  }

  if (action.type === 'cloudflare-domain-registration') {
    return ensureCloudflareDomainRegistration(root, action, options);
  }

  if (action.type === 'porkbun-domain-registration') {
    return ensurePorkbunDomainRegistration(root, action, options);
  }

  if (action.type === 'porkbun-nameservers') {
    return ensurePorkbunNameservers(root, action, options);
  }

  if (action.type === 'cloudflare-dns-record') {
    return ensureCloudflareDnsRecord(root, action, options);
  }

  if (action.type === 'ssh-command') {
    return withSshIdentity(action, (identityAction) => {
      const resolved = buildSshCommand(identityAction, options.state);
      if (resolved.status !== 'completed') return failedResolution(resolved);
      return runCommand(root, resolved.command, undefined, {
        ...retryOptions(identityAction),
        quiet: options.quiet,
      });
    });
  }

  if (action.type === 'rsync-to-host') {
    return withSshIdentity(action, (identityAction) => {
      const resolved = buildRsyncCommand(identityAction, options.state);
      if (resolved.status !== 'completed') return failedResolution(resolved);
      return runCommand(root, resolved.command, undefined, {
        ...retryOptions(identityAction),
        quiet: options.quiet,
      });
    });
  }

  if (action.type === 'env-check') {
    return checkEnvironment(action);
  }

  if (action.type === 'env-any-check') {
    return checkAnyEnvironment(action);
  }

  if (action.type === 'tool-check') {
    return checkTools(action, options);
  }

  if (action.type === 'ssh-key-check') {
    return checkSshKeyMaterial(action);
  }

  if (action.type === 'git-tracked-check') {
    return checkGitTrackedFiles(root, action, options);
  }

  if (action.type === 'git-identity-check') {
    return checkGitIdentity(root, action, options);
  }

  if (action.type === 'github-repo') {
    return ensureGithubRepo(root, action, options);
  }

  if (action.type === 'github-secret') {
    return syncGithubSecret(root, action, options);
  }

  if (action.type === 'git-commit-if-changed') {
    return commitIfChanged(root, action, options);
  }

  if (action.type === 'git-init-if-missing') {
    return initGitIfMissing(root, action, options);
  }

  if (action.type === 'git-remote-ensure') {
    return ensureGitRemote(root, action, options);
  }

  if (action.type === 'http-check') {
    return checkHttp(action, options);
  }

  if (action.type === 'file') {
    return writeManagedFile(root, action, options.manifest, options.state, options.renderContext);
  }

  return {
    status: 'failed',
    stdout: '',
    stderr: '',
    error: `Unsupported action type: ${action.type}`,
  };
}

function applyFailurePatterns(result, action) {
  if (result.status !== 'completed') return result;
  const patterns = action.failurePatterns || [];
  if (patterns.length === 0) return result;

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  const matched = patterns.find((pattern) => output.includes(String(pattern).toLowerCase()));
  if (!matched) return result;

  return {
    ...result,
    status: 'failed',
    error: `Provider authentication failed: matched "${matched}" in command output`,
  };
}

function commitIfChanged(root, action, options = {}) {
  const status = runCommand(root, ['git', 'status', '--porcelain'], undefined, {
    quiet: options.quiet,
  });
  if (status.status !== 'completed') return status;
  if (!status.stdout.trim()) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: 'No git changes to commit.\n',
      stderr: '',
      skipped: true,
    };
  }
  return runCommand(root, action.command, undefined, { quiet: options.quiet });
}

function initGitIfMissing(root, action, options = {}) {
  const workTree = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (workTree.status === 'completed' && workTree.stdout.trim() === 'true') {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: 'Git repository already initialized.\n',
      stderr: '',
      skipped: true,
    };
  }

  const initialized = runCommand(root, ['git', 'init'], undefined, { quiet: options.quiet });
  if (initialized.status !== 'completed') return initialized;
  return {
    ...initialized,
    stdout: initialized.stdout || `${action.effect || 'Initialized Git repository'}.\n`,
  };
}

function ensureGitRemote(root, action, options = {}) {
  const remote = action.remote || 'origin';
  const expectedUrl = resolveGitRemoteUrl(action, options.state);
  const current = runGit(root, ['remote', 'get-url', remote]);

  if (current.status === 'completed') {
    const currentUrl = current.stdout.trim();
    if (expectedUrl && !remoteUrlMatches(currentUrl, expectedUrl)) {
      return {
        status: 'failed',
        stdout: '',
        stderr: '',
        error: `Git remote ${remote} points to ${currentUrl}, expected ${expectedUrl}. Update the remote or manifest.github.repo before apply.`,
      };
    }
    return {
      status: 'completed',
      exitCode: 0,
      stdout: `Git remote ${remote} already configured: ${currentUrl}\n`,
      stderr: '',
      skipped: true,
    };
  }

  if (!isMissingGitRemote(current, remote)) {
    return current;
  }

  if (!expectedUrl) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `No URL is available for Git remote ${remote}. Set manifest.github.repo to owner/name or create/connect the GitHub repository first.`,
    };
  }

  return runCommand(root, ['git', 'remote', 'add', remote, expectedUrl], undefined, {
    quiet: options.quiet,
  });
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.status !== 0) {
    return {
      status: 'failed',
      exitCode: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error?.message || `git ${args.join(' ')} exited with ${result.status}`,
    };
  }

  return {
    status: 'completed',
    exitCode: 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function isMissingGitRemote(result, remote) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`.toLowerCase();
  return output.includes(`no such remote '${remote.toLowerCase()}'`);
}

function resolveGitRemoteUrl(action, state) {
  const fromState = getStatePath(state, action.remoteUrlStatePath);
  if (fromState && (!action.repo || githubRepoTargetMatches(fromState, action.repo))) {
    return fromState;
  }
  return githubRepoUrlFromRepo(action.repo);
}

function remoteUrlMatches(current, expected) {
  return githubRemoteUrlsMatch(current, expected);
}

export function buildGithubSecretCommand(action, state) {
  const secret = action.key || action.secret;
  const repo =
    githubRepoSlugFromUrl(getStatePath(state, action.repoUrlStatePath)) ||
    githubRepoSlugFromTarget(action.repo);

  if (!repo) {
    return {
      status: 'failed',
      error: `No owner/repo GitHub repository is available for secret ${secret}.`,
    };
  }

  return {
    status: 'completed',
    command: ['gh', 'secret', 'set', secret, '--repo', repo],
  };
}

function ensureCloudflareResource(root, action, options = {}) {
  const listed = runCommand(root, action.listCommand, undefined, { quiet: options.quiet });
  if (listed.status !== 'completed') return listed;

  const existing = findCloudflareResource(listed.stdout, action.resource);
  if (existing) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: `${cloudflareCaptureLine(action.resource, existing.id)}\n`,
      stderr: '',
      adopted: true,
    };
  }

  const created = runCommand(root, action.createCommand, undefined, { quiet: options.quiet });
  if (created.status !== 'completed') return created;
  return {
    ...created,
    stdout: `${created.stdout || ''}${cloudflareCreatedFallback(action.resource)}`,
  };
}

function cloudflareCaptureLine(resource, id) {
  if (resource.type === 'cloudflare.d1') return `database_id = ${id}`;
  if (resource.type === 'cloudflare.kv') return `id = ${id}`;
  return `provider_id = ${id}`;
}

function cloudflareCreatedFallback(resource) {
  if (resource.type === 'cloudflare.r2') return `provider_id = ${resource.name}\n`;
  return '';
}

function ensureDigitalOceanDroplet(root, action, options = {}) {
  const name = action.dropletName || action.name;
  if (!name) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'DigitalOcean droplet action requires dropletName.',
    };
  }

  const listCommand = ['doctl', 'compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'];
  const listed = runCommand(root, listCommand, undefined, { quiet: options.quiet });
  if (listed.status !== 'completed') return listed;

  const existing = findDigitalOceanDroplet(listed.stdout, name);
  if (existing?.invalidIp) return invalidDigitalOceanIp(name);
  if (existing) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: digitalOceanDropletCapture(existing),
      stderr: '',
      adopted: true,
    };
  }

  const sshKeys =
    process.env[action.sshKeysEnv || 'DIGITALOCEAN_SSH_KEY_IDS'] ||
    getStatePath(options.state, action.sshKeysStatePath);
  if (!sshKeys) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing DigitalOcean SSH keys. Set ${action.sshKeysEnv || 'DIGITALOCEAN_SSH_KEY_IDS'} or run the SSH key provisioning step first.`,
    };
  }

  const createCommand = [
    'doctl',
    'compute',
    'droplet',
    'create',
    name,
    '--region',
    action.region || 'sgp1',
    '--size',
    action.size || 's-1vcpu-1gb',
    '--image',
    action.image || 'ubuntu-24-04-x64',
    '--ssh-keys',
    sshKeys,
    '--wait',
    '--format',
    'ID,Name,PublicIPv4',
    '--no-header',
  ];
  const created = runCommand(root, createCommand, undefined, { quiet: options.quiet });
  if (created.status !== 'completed') return created;

  const fromCreate = findDigitalOceanDroplet(created.stdout, name);
  if (fromCreate?.ip) {
    return {
      ...created,
      stdout: `${created.stdout || ''}${digitalOceanDropletCapture(fromCreate)}`,
    };
  }

  const verified = runCommand(root, listCommand, undefined, { quiet: options.quiet });
  if (verified.status !== 'completed') return verified;
  const fromList = findDigitalOceanDroplet(verified.stdout, name);
  if (fromList?.invalidIp) return invalidDigitalOceanIp(name);
  if (!fromList?.ip) {
    return {
      status: 'failed',
      stdout: `${created.stdout || ''}${verified.stdout || ''}`,
      stderr: `${created.stderr || ''}${verified.stderr || ''}`,
      error: `DigitalOcean droplet ${name} was created or requested, but no public IPv4 address could be captured.`,
    };
  }

  return {
    status: 'completed',
    exitCode: 0,
    stdout: `${created.stdout || ''}${digitalOceanDropletCapture(fromList)}`,
    stderr: created.stderr || '',
  };
}

function ensureDigitalOceanSshKey(root, action, options = {}) {
  const sshKeysEnv = action.sshKeysEnv || 'DIGITALOCEAN_SSH_KEY_IDS';
  const publicKeyEnv = action.publicKeyEnv || 'AGENTMESH_DEPLOY_SSH_PUBLIC_KEY';
  const existingIds = process.env[sshKeysEnv];
  if (existingIds) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: `digitalocean_ssh_key_ids = ${existingIds}\n`,
      stderr: '',
      adopted: true,
    };
  }

  const keyName = action.keyName || action.name;
  if (!keyName) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'DigitalOcean SSH key action requires keyName.',
    };
  }

  const publicKey = process.env[publicKeyEnv];
  if (!publicKey) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing DigitalOcean SSH key source. Set ${sshKeysEnv} or ${publicKeyEnv}.`,
    };
  }

  const listCommand = ['doctl', 'compute', 'ssh-key', 'list', '--format', 'ID,Name,FingerPrint', '--no-header'];
  const listed = runCommand(root, listCommand, undefined, { quiet: options.quiet });
  if (listed.status !== 'completed') return listed;

  const existing = findDigitalOceanSshKey(listed.stdout, keyName);
  if (existing) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: digitalOceanSshKeyCapture(existing),
      stderr: '',
      adopted: true,
    };
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-deploy-do-ssh-key-'));
  const publicKeyFile = path.join(directory, 'id.pub');
  try {
    fs.writeFileSync(publicKeyFile, normalizePublicKey(publicKey), { mode: 0o600 });
    fs.chmodSync(publicKeyFile, 0o600);
    const imported = runCommand(
      root,
      [
        'doctl',
        'compute',
        'ssh-key',
        'import',
        keyName,
        '--public-key-file',
        publicKeyFile,
        '--format',
        'ID,Name,FingerPrint',
        '--no-header',
      ],
      undefined,
      { quiet: options.quiet }
    );
    if (imported.status !== 'completed') return imported;

    const fromImport = findDigitalOceanSshKey(imported.stdout, keyName);
    if (fromImport?.id) {
      return {
        ...imported,
        stdout: `${imported.stdout || ''}${digitalOceanSshKeyCapture(fromImport)}`,
      };
    }

    const verified = runCommand(root, listCommand, undefined, { quiet: options.quiet });
    if (verified.status !== 'completed') return verified;
    const fromList = findDigitalOceanSshKey(verified.stdout, keyName);
    if (!fromList?.id) {
      return {
        status: 'failed',
        stdout: `${imported.stdout || ''}${verified.stdout || ''}`,
        stderr: `${imported.stderr || ''}${verified.stderr || ''}`,
        error: `DigitalOcean SSH key ${keyName} was imported, but no key id could be captured.`,
      };
    }

    return {
      status: 'completed',
      exitCode: 0,
      stdout: `${imported.stdout || ''}${digitalOceanSshKeyCapture(fromList)}`,
      stderr: imported.stderr || '',
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function ensurePorkbunDomainRegistration(root, action, options = {}) {
  const missing = porkbunMissingEnv(action);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }
  if (!action.root) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Porkbun domain registration requires root.',
    };
  }
  if (action.agreeToTerms !== true) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Porkbun domain registration requires agreeToTerms: true.',
    };
  }
  if (!Number.isFinite(Number(action.maxCostUsd)) || Number(action.maxCostUsd) <= 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Porkbun domain registration requires a positive maxCostUsd cap.',
    };
  }

  const payload = {
    root: action.root,
    maxCostUsd: Number(action.maxCostUsd),
    whoisPrivacy: action.whoisPrivacy !== false,
    apiKeyEnv: action.apiKeyEnv || 'PORKBUN_API_KEY',
    secretApiKeyEnv: action.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
  };
  return runCommand(root, [process.execPath, '-e', porkbunDomainRegistrationScript(), JSON.stringify(payload)], undefined, {
    quiet: options.quiet,
  });
}

function ensureCloudflareDomainRegistration(root, action, options = {}) {
  const missing = cloudflareRegistrarMissingEnv(action);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }
  if (!action.root) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Cloudflare domain registration requires root.',
    };
  }
  if (action.agreeToTerms !== true) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Cloudflare domain registration requires agreeToTerms: true.',
    };
  }
  if (!Number.isFinite(Number(action.maxCostUsd)) || Number(action.maxCostUsd) <= 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Cloudflare domain registration requires a positive maxCostUsd cap.',
    };
  }

  const payload = {
    root: action.root,
    years: action.years || 1,
    maxCostUsd: Number(action.maxCostUsd),
    privacyMode: action.privacyMode || 'redaction',
    autoRenew: action.autoRenew === true,
    accountIdEnv: action.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID',
    apiTokenEnv: action.apiTokenEnv || 'CLOUDFLARE_API_TOKEN',
  };
  return runCommand(root, [process.execPath, '-e', cloudflareDomainRegistrationScript(), JSON.stringify(payload)], undefined, {
    quiet: options.quiet,
  });
}

function ensurePorkbunNameservers(root, action, options = {}) {
  const missing = porkbunMissingEnv(action);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }
  const nameservers = nameserversFromAction(action, options.state);
  if (!action.root) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Porkbun nameserver action requires root.',
    };
  }
  if (nameservers.length < 2) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `No nameservers are available for ${action.root}.`,
    };
  }

  const payload = {
    root: action.root,
    nameservers,
    apiKeyEnv: action.apiKeyEnv || 'PORKBUN_API_KEY',
    secretApiKeyEnv: action.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
  };
  return runCommand(root, [process.execPath, '-e', porkbunNameserversScript(), JSON.stringify(payload)], undefined, {
    quiet: options.quiet,
  });
}

function porkbunMissingEnv(action) {
  return [action.apiKeyEnv || 'PORKBUN_API_KEY', action.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'].filter(
    (key) => !process.env[key]
  );
}

function cloudflareRegistrarMissingEnv(action) {
  return [action.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID', action.apiTokenEnv || 'CLOUDFLARE_API_TOKEN'].filter(
    (key) => !process.env[key]
  );
}

function nameserversFromAction(action, state) {
  const value = action.nameservers || getStatePath(state, action.nameserversStatePath);
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureCloudflareDnsRecord(root, action, options = {}) {
  const missing = (action.envKeys || ['CLOUDFLARE_API_TOKEN']).filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }

  const value = action.value || getStatePath(options.state, action.valueStatePath);
  if (!value) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `No DNS record target is available for ${action.name || '<record>'}.`,
    };
  }

  const payload = {
    zone: action.zone || '',
    zoneId: action.zoneId || getStatePath(options.state, action.zoneIdStatePath),
    type: action.recordType || 'A',
    name: action.name || '',
    content: value,
    ttl: action.ttl || 300,
    proxied: action.proxied === true,
  };
  return runCommand(root, [process.execPath, '-e', cloudflareDnsUpsertScript(), JSON.stringify(payload)], undefined, {
    quiet: options.quiet,
  });
}

function ensureCloudflareZone(root, action, options = {}) {
  const envKeys = action.envKeys || [action.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  const missing = envKeys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }
  if (!action.zoneName) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'Cloudflare zone action requires zoneName.',
    };
  }

  const payload = {
    name: action.zoneName,
    accountIdEnv: action.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID',
    type: action.zoneType || 'full',
  };
  return runCommand(root, [process.execPath, '-e', cloudflareZoneEnsureScript(), JSON.stringify(payload)], undefined, {
    quiet: options.quiet,
  });
}

export function buildSshCommand(action, state = {}) {
  const host = action.host || getStatePath(state, action.hostStatePath);
  if (!host) {
    return {
      status: 'failed',
      error: `No SSH host is available for action: ${action.effect || 'ssh-command'}`,
    };
  }
  const user = action.user || 'root';
  const port = String(action.port || 22);
  const remoteCommand = action.remoteCommand || action.command;
  if (!remoteCommand) {
    return {
      status: 'failed',
      error: `No remote command is configured for action: ${action.effect || 'ssh-command'}`,
    };
  }
  return {
    status: 'completed',
    command: [
      'ssh',
      '-p',
      port,
      ...sshIdentityArgs(action),
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ConnectionAttempts=1',
      `${user}@${host}`,
      remoteCommand,
    ],
  };
}

export function buildRsyncCommand(action, state = {}) {
  const host = action.host || getStatePath(state, action.hostStatePath);
  if (!host) {
    return {
      status: 'failed',
      error: `No rsync host is available for action: ${action.effect || 'rsync-to-host'}`,
    };
  }
  const user = action.user || 'root';
  const port = String(action.port || 22);
  const source = action.source || './';
  const destination = action.destinationIsFile
    ? action.destination || '/opt/agentmesh-app/.agentmesh-deploy/runtime.env.next'
    : withTrailingSlash(action.destination || '/opt/agentmesh-app');
  const includes = (action.includes || []).flatMap((value) => ['--include', value]);
  const excludes = (action.excludes || []).flatMap((value) => ['--exclude', value]);
  const sshCommand = [
    `ssh -p ${port}`,
    action.identityFile ? `-i ${shellQuote(action.identityFile)}` : '',
    '-o StrictHostKeyChecking=accept-new',
    '-o ConnectTimeout=10',
    '-o ConnectionAttempts=1',
  ].filter(Boolean).join(' ');
  return {
    status: 'completed',
    command: [
      'rsync',
      '-az',
      ...(action.delete === false ? [] : ['--delete']),
      ...includes,
      ...excludes,
      '-e',
      sshCommand,
      source,
      `${user}@${host}:${destination}`,
    ],
  };
}

function sshIdentityArgs(action) {
  if (!action.identityFile) return [];
  return ['-i', action.identityFile];
}

function withSshIdentity(action, fn) {
  const prepared = prepareSshIdentity(action);
  try {
    return fn(prepared.action);
  } finally {
    prepared.cleanup?.();
  }
}

function prepareSshIdentity(action) {
  if (action.identityFile) return { action };

  const identityFileEnv = action.identityFileEnv || 'AGENTMESH_DEPLOY_SSH_KEY_PATH';
  const privateKeyEnv = action.privateKeyEnv || 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY';
  const identityFile = process.env[identityFileEnv];
  if (identityFile) {
    return {
      action: {
        ...action,
        identityFile,
      },
    };
  }

  const privateKey = process.env[privateKeyEnv];
  if (!privateKey) return { action };

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-deploy-ssh-'));
  const keyFile = path.join(directory, 'identity');
  fs.writeFileSync(keyFile, normalizePrivateKey(privateKey), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  return {
    action: {
      ...action,
      identityFile: keyFile,
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function normalizePrivateKey(value) {
  const text = String(value || '').replace(/\\n/g, '\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

function normalizePublicKey(value) {
  const text = String(value || '').replace(/\\n/g, '\n').trim();
  return text.endsWith('\n') ? text : `${text}\n`;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function failedResolution(result) {
  return {
    status: 'failed',
    stdout: '',
    stderr: '',
    error: result.error || 'Action could not be resolved.',
  };
}

function retryOptions(action) {
  return {
    maxAttempts: action.maxAttempts,
    retryDelayMs: action.retryDelayMs,
    retryExitCodes: action.retryExitCodes,
  };
}

function githubSecretRetryOptions(action) {
  return {
    ...retryOptions(action),
    maxAttempts: action.maxAttempts ?? GITHUB_SECRET_DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: action.retryDelayMs ?? GITHUB_SECRET_DEFAULT_RETRY_DELAY_MS,
  };
}

function findDigitalOceanDroplet(output, name) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [id, dropletName, ip] = parts;
    if (dropletName === name && /^\d+$/.test(id)) {
      return isIP(ip) === 4
        ? { id, name: dropletName, ip }
        : { id, name: dropletName, ip: '', invalidIp: true };
    }
  }
  return null;
}

function invalidDigitalOceanIp(name) {
  return {
    status: 'failed',
    stdout: '',
    stderr: '',
    error: `DigitalOcean droplet ${name} returned an invalid public IPv4 value.`,
  };
}

function findDigitalOceanSshKey(output, name) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const id = parts[0];
    const fingerprint = parts.length > 2 ? parts.at(-1) : '';
    const keyName = parts.length > 2 ? parts.slice(1, -1).join(' ') : parts[1];
    if (keyName === name && /^\d+$/.test(id)) {
      return { id, name: keyName, fingerprint };
    }
  }
  return null;
}

function digitalOceanDropletCapture(droplet) {
  return `droplet_id = ${droplet.id}\ndroplet_ip = ${droplet.ip}\n`;
}

function digitalOceanSshKeyCapture(key) {
  return [
    `digitalocean_ssh_key_ids = ${key.id}`,
    key.fingerprint ? `digitalocean_ssh_key_fingerprint = ${key.fingerprint}` : '',
  ].filter(Boolean).join('\n') + '\n';
}

function withTrailingSlash(value) {
  const stringValue = String(value || '');
  return stringValue.endsWith('/') ? stringValue : `${stringValue}/`;
}

function cloudflareDnsUpsertScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const base = 'https://api.cloudflare.com/client/v4';
    async function request(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Cloudflare returned a non-JSON response');
      }
      if (!response.ok || body.success === false) {
        const message = (body.errors || []).map((error) => error.message).filter(Boolean).join('; ');
        throw new Error(message || ('Cloudflare API request failed: ' + response.status));
      }
      return body;
    }
    async function main() {
      if (!token) throw new Error('Missing CLOUDFLARE_API_TOKEN');
      let zoneId = payload.zoneId || process.env.CLOUDFLARE_ZONE_ID || '';
      if (!zoneId) {
        if (!payload.zone) throw new Error('Cloudflare DNS record requires zone or CLOUDFLARE_ZONE_ID');
        const zones = await request('/zones?name=' + encodeURIComponent(payload.zone));
        zoneId = zones.result && zones.result[0] && zones.result[0].id;
      }
      if (!zoneId) throw new Error('Cloudflare zone was not found: ' + payload.zone);
      const type = payload.type || 'A';
      const name = payload.name;
      const listed = await request('/zones/' + zoneId + '/dns_records?type=' + encodeURIComponent(type) + '&name=' + encodeURIComponent(name));
      const body = {
        type,
        name,
        content: payload.content,
        ttl: Number(payload.ttl || 300),
        proxied: payload.proxied === true,
      };
      const existing = (listed.result || [])[0];
      const record = existing
        ? (await request('/zones/' + zoneId + '/dns_records/' + existing.id, {
            method: 'PUT',
            body: JSON.stringify(body),
          })).result
        : (await request('/zones/' + zoneId + '/dns_records', {
            method: 'POST',
            body: JSON.stringify(body),
          })).result;
      console.log('dns_record_id = ' + record.id);
      console.log('dns_record_target = ' + record.content);
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function cloudflareZoneEnsureScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env[payload.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID'];
    const base = 'https://api.cloudflare.com/client/v4';
    async function request(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Cloudflare returned a non-JSON response');
      }
      if (!response.ok || body.success === false) {
        const message = (body.errors || []).map((error) => error.message).filter(Boolean).join('; ');
        throw new Error(message || ('Cloudflare API request failed: ' + response.status));
      }
      return body;
    }
    async function main() {
      if (!token) throw new Error('Missing CLOUDFLARE_API_TOKEN');
      if (!accountId) throw new Error('Missing ' + (payload.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID'));
      if (!payload.name) throw new Error('Missing zone name');
      const listed = await request('/zones?name=' + encodeURIComponent(payload.name));
      let zone = (listed.result || [])[0];
      if (!zone) {
        zone = (await request('/zones', {
          method: 'POST',
          body: JSON.stringify({
            name: payload.name,
            account: { id: accountId },
            type: payload.type || 'full',
          }),
        })).result;
      }
      console.log('cloudflare_zone_id = ' + zone.id);
      const nameservers = (zone.name_servers || zone.nameServers || []).join(',');
      if (nameservers) console.log('cloudflare_nameservers = ' + nameservers);
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function porkbunDomainRegistrationScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const apiKey = process.env[payload.apiKeyEnv || 'PORKBUN_API_KEY'];
    const secretApiKey = process.env[payload.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'];
    const base = 'https://api.porkbun.com/api/json/v3';
    function centsToUsd(cents) {
      const number = Number(cents || 0);
      return (number / 100).toFixed(2);
    }
    function priceToCents(value) {
      if (value === undefined || value === null || value === '') return 0;
      const number = Number(String(value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(number)) return 0;
      return Math.round(number * 100);
    }
    function domainPriceCents(body) {
      return (
        priceToCents(body.price) ||
        priceToCents(body.registration) ||
        priceToCents(body.pricing && body.pricing.registration) ||
        priceToCents(body.prices && body.prices.registration) ||
        Number(body.cost || 0)
      );
    }
    async function request(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          ...(secretApiKey ? { 'X-Secret-API-Key': secretApiKey } : {}),
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Porkbun returned a non-JSON response');
      }
      if (!response.ok || body.status === 'ERROR') {
        const code = body.code ? body.code + ': ' : '';
        throw new Error(code + (body.message || ('Porkbun API request failed: ' + response.status)));
      }
      return body;
    }
    async function domainInAccount(domain) {
      try {
        const body = await request('/domain/get/' + encodeURIComponent(domain), { method: 'GET' });
        return body.domain || null;
      } catch (error) {
        if (String(error.message || '').includes('DOMAIN_NOT_FOUND')) return null;
        return null;
      }
    }
    async function main() {
      if (!apiKey) throw new Error('Missing ' + (payload.apiKeyEnv || 'PORKBUN_API_KEY'));
      if (!secretApiKey) throw new Error('Missing ' + (payload.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'));
      if (!payload.root) throw new Error('Missing root domain');
      const existing = await domainInAccount(payload.root);
      if (existing) {
        console.log('domain_registered = ' + (existing.domain || payload.root));
        console.log('domain_cost_usd = 0.00');
        return;
      }
      const availability = await request('/domain/checkDomain/' + encodeURIComponent(payload.root), {
        method: 'POST',
        body: JSON.stringify({ apikey: apiKey, secretapikey: secretApiKey }),
      });
      const available = String(availability.avail || availability.available || '').toLowerCase();
      if (available && available !== 'yes' && available !== 'available' && available !== 'true') {
        throw new Error('Domain is not available for registration: ' + payload.root);
      }
      const cost = domainPriceCents(availability);
      if (!cost) throw new Error('Porkbun did not return a registration price for ' + payload.root);
      const maxCost = Math.round(Number(payload.maxCostUsd) * 100);
      if (cost > maxCost) {
        throw new Error('Domain registration cost $' + centsToUsd(cost) + ' exceeds maxCostUsd $' + centsToUsd(maxCost));
      }
      const body = {
        apikey: apiKey,
        secretapikey: secretApiKey,
        cost,
        agreeToTerms: 'yes',
        whoisPrivacy: payload.whoisPrivacy === false ? 'no' : 'yes',
      };
      const dryRun = await request('/domain/create/' + encodeURIComponent(payload.root), {
        method: 'POST',
        body: JSON.stringify({ ...body, dryRun: true }),
      });
      if (dryRun.wouldSucceed === false) {
        throw new Error(dryRun.message || 'Porkbun dry-run registration did not succeed.');
      }
      const created = await request('/domain/create/' + encodeURIComponent(payload.root), {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'agentmesh-deploy-register-' + payload.root + '-' + cost,
        },
        body: JSON.stringify(body),
      });
      console.log('domain_registered = ' + (created.domain || payload.root));
      console.log('domain_cost_usd = ' + centsToUsd(created.cost || cost));
      if (created.orderId) console.log('domain_order_id = ' + created.orderId);
      if (created.requestId) console.log('domain_registration_request_id = ' + created.requestId);
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function cloudflareDomainRegistrationScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const accountIdEnv = payload.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID';
    const apiTokenEnv = payload.apiTokenEnv || 'CLOUDFLARE_API_TOKEN';
    const accountId = process.env[accountIdEnv];
    const token = process.env[apiTokenEnv];
    const base = 'https://api.cloudflare.com/client/v4';
    function normalizeDomain(value) {
      return String(value || '').trim().replace(/\\.$/, '').toLowerCase();
    }
    function centsToUsd(cents) {
      const number = Number(cents || 0);
      return (number / 100).toFixed(2);
    }
    function priceToCents(value) {
      if (value === undefined || value === null || value === '') return 0;
      const number = Number(String(value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(number)) return 0;
      return Math.round(number * 100);
    }
    function totalRegistrationCostCents(pricing, years) {
      const firstYear = priceToCents(pricing && pricing.registration_cost);
      const renewal = priceToCents(pricing && pricing.renewal_cost) || firstYear;
      return firstYear + Math.max(0, years - 1) * renewal;
    }
    function apiErrorMessage(body, status) {
      const messages = (body.errors || [])
        .map((error) => [error.code, error.message].filter(Boolean).join(': '))
        .filter(Boolean);
      return messages.join('; ') || ('Cloudflare API request failed: ' + status);
    }
    function workflowStatusPath(workflow) {
      const self = workflow && workflow.links && workflow.links.self;
      if (!self) return '';
      if (!/^https?:\\/\\//i.test(self)) return self;
      const url = new URL(self);
      return url.pathname.replace(/^\\/client\\/v4/, '');
    }
    async function sleep(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    async function request(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Cloudflare returned a non-JSON response');
      }
      if (!response.ok || body.success === false) {
        const error = new Error(apiErrorMessage(body, response.status));
        error.status = response.status;
        throw error;
      }
      return body;
    }
    function registrarPath(path) {
      return '/accounts/' + encodeURIComponent(accountId) + '/registrar' + path;
    }
    async function registrationInAccount(domain) {
      try {
        const body = await request(registrarPath('/registrations/' + encodeURIComponent(domain)), { method: 'GET' });
        return body.result || null;
      } catch (error) {
        const message = String(error.message || '').toLowerCase();
        if (error.status === 404 || message.includes('not found')) return null;
        throw error;
      }
    }
    async function waitForWorkflow(workflow) {
      let current = workflow || {};
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const state = String(current.state || '').toLowerCase();
        if (!state || state === 'succeeded') return current;
        if (state === 'failed') {
          const detail = current.error && current.error.message ? ': ' + current.error.message : '';
          throw new Error('Cloudflare registration workflow failed' + detail);
        }
        if (state === 'action_required') {
          throw new Error('Cloudflare registration workflow requires manual action. Poll ' + workflowStatusPath(current));
        }
        if (attempt === 11) break;
        const path = workflowStatusPath(current);
        if (!path) break;
        await sleep(5000);
        current = (await request(path, { method: 'GET' })).result || {};
      }
      throw new Error('Cloudflare registration workflow did not complete. Current state: ' + (current.state || 'unknown'));
    }
    async function main() {
      if (!accountId) throw new Error('Missing ' + accountIdEnv);
      if (!token) throw new Error('Missing ' + apiTokenEnv);
      if (!payload.root) throw new Error('Missing root domain');
      const years = Number(payload.years || 1);
      if (!Number.isInteger(years) || years < 1 || years > 10) throw new Error('years must be an integer from 1 to 10');
      const existing = await registrationInAccount(payload.root);
      if (existing) {
        console.log('domain_registered = ' + (existing.domain_name || existing.name || payload.root));
        console.log('domain_cost_usd = 0.00');
        console.log('domain_registration_state = succeeded');
        return;
      }
      const availability = await request(registrarPath('/domain-check'), {
        method: 'POST',
        body: JSON.stringify({ domains: [payload.root] }),
      });
      const domains = (availability.result && availability.result.domains) || availability.domains || [];
      const checked = domains.find((item) => normalizeDomain(item.name) === normalizeDomain(payload.root));
      if (!checked) throw new Error('Cloudflare did not return availability for ' + payload.root);
      if (String(checked.tier || 'standard').toLowerCase() === 'premium') {
        throw new Error('Cloudflare Registrar API does not support premium domain registration: ' + payload.root);
      }
      if (checked.registrable !== true) {
        throw new Error('Domain cannot be registered via Cloudflare Registrar: ' + payload.root + (checked.reason ? ' (' + checked.reason + ')' : ''));
      }
      const pricing = checked.pricing || {};
      const currency = String(pricing.currency || 'USD').toUpperCase();
      if (currency !== 'USD') {
        throw new Error('Cloudflare returned ' + currency + ' pricing; maxCostUsd requires USD pricing.');
      }
      const cost = totalRegistrationCostCents(pricing, years);
      if (!cost) throw new Error('Cloudflare did not return a registration price for ' + payload.root);
      const maxCost = Math.round(Number(payload.maxCostUsd) * 100);
      if (cost > maxCost) {
        throw new Error('Domain registration cost $' + centsToUsd(cost) + ' exceeds maxCostUsd $' + centsToUsd(maxCost));
      }
      const body = {
        domain_name: payload.root,
        privacy_mode: payload.privacyMode || 'redaction',
        years,
      };
      if (payload.autoRenew === true) body.auto_renew = true;
      const created = await request(registrarPath('/registrations'), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const workflow = await waitForWorkflow(created.result || {});
      const domain =
        (workflow.context && (workflow.context.domain_name || (workflow.context.registration && workflow.context.registration.domain_name))) ||
        payload.root;
      console.log('domain_registered = ' + domain);
      console.log('domain_cost_usd = ' + centsToUsd(cost));
      console.log('domain_registration_state = ' + (workflow.state || 'succeeded'));
      const statusPath = workflowStatusPath(workflow);
      if (statusPath) console.log('domain_registration_status_url = ' + statusPath);
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function porkbunNameserversScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const apiKey = process.env[payload.apiKeyEnv || 'PORKBUN_API_KEY'];
    const secretApiKey = process.env[payload.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'];
    const base = 'https://api.porkbun.com/api/json/v3';
    function normalize(ns) {
      return String(ns || '').trim().replace(/\\.$/, '').toLowerCase();
    }
    function sameNameservers(a, b) {
      const left = [...a.map(normalize)].sort();
      const right = [...b.map(normalize)].sort();
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    async function request(path, init = {}) {
      const response = await fetch(base + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          ...(secretApiKey ? { 'X-Secret-API-Key': secretApiKey } : {}),
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Porkbun returned a non-JSON response');
      }
      if (!response.ok || body.status === 'ERROR') {
        const code = body.code ? body.code + ': ' : '';
        throw new Error(code + (body.message || ('Porkbun API request failed: ' + response.status)));
      }
      return body;
    }
    async function main() {
      if (!apiKey) throw new Error('Missing ' + (payload.apiKeyEnv || 'PORKBUN_API_KEY'));
      if (!secretApiKey) throw new Error('Missing ' + (payload.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'));
      if (!payload.root) throw new Error('Missing root domain');
      const desired = (payload.nameservers || []).map((item) => String(item).trim()).filter(Boolean);
      if (desired.length < 2) throw new Error('At least two nameservers are required.');
      const current = await request('/domain/getNs/' + encodeURIComponent(payload.root), { method: 'GET' });
      const currentNs = Array.isArray(current.ns) ? current.ns : [];
      if (!sameNameservers(currentNs, desired)) {
        const body = { apikey: apiKey, secretapikey: secretApiKey, ns: desired };
        const dryRun = await request('/domain/updateNs/' + encodeURIComponent(payload.root), {
          method: 'POST',
          body: JSON.stringify({ ...body, dryRun: true }),
        });
        if (dryRun.wouldSucceed === false) {
          throw new Error(dryRun.message || 'Porkbun dry-run nameserver update did not succeed.');
        }
        await request('/domain/updateNs/' + encodeURIComponent(payload.root), {
          method: 'POST',
          headers: {
            'Idempotency-Key': 'agentmesh-deploy-ns-' + payload.root + '-' + desired.join('-'),
          },
          body: JSON.stringify(body),
        });
      }
      console.log('nameservers_bound = ' + payload.root);
      console.log('domain_nameservers = ' + desired.join(','));
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function shouldRedactOutput(action) {
  return Boolean(
    action.redactOutput ||
      action.secret ||
      action.stdinFromEnv ||
      action.stdinFromManagedEnvFile ||
      action.stdinFromState
  );
}

function checkEnvironment(action) {
  const missing = (action.keys || []).filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing environment variables: ${missing.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `Environment variables present: ${(action.keys || []).join(', ')}\n`,
    stderr: '',
  };
}

function checkAnyEnvironment(action) {
  const keys = action.keys || [];
  const present = keys.filter((key) => process.env[key]);
  if (present.length === 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing one of environment variables: ${keys.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `Environment variable source present: ${present[0]}\n`,
    stderr: '',
  };
}

function checkTools(action, options) {
  const missing = (action.tools || []).filter((tool) => !resolveTool(tool, options));
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing local tools: ${missing.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `Local tools present: ${(action.tools || []).join(', ')}\n`,
    stderr: '',
  };
}

function checkSshKeyMaterial(action) {
  const issues = inspectSshKeyMaterial(action);
  if (issues.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Invalid SSH key material: ${issues.map((item) => `${item.source}: ${item.message}`).join('; ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `${action.effect || 'SSH key material check'}: SSH key material is well-formed.\n`,
    stderr: '',
  };
}

function checkGitTrackedFiles(root, action, options = {}) {
  const tracked =
    Array.isArray(options.trackedFiles)
      ? { status: 'completed', files: options.trackedFiles }
      : readGitTrackedFiles(root);

  if (tracked.status !== 'completed') {
    return {
      status: 'completed',
      stdout: `Git tracked-file check skipped: ${tracked.error}\n`,
      stderr: '',
      skipped: true,
    };
  }

  const sensitive = sensitiveTrackedFiles(tracked.files);
  if (sensitive.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Sensitive files are already tracked by git: ${sensitive.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `${action.effect || 'Git tracked-file check'}: no sensitive tracked files found.\n`,
    stderr: '',
  };
}

function checkGitIdentity(root, action, options = {}) {
  const identity = options.gitIdentity || inspectGitIdentity(root);
  const missing = identity.missing || [];
  if (missing.length > 0) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: `Missing Git commit identity: ${missing.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    stdout: `${action.effect || 'Git commit identity check'}: user.name and user.email are configured.\n`,
    stderr: '',
  };
}

function resolveTool(tool, options) {
  if (typeof options.toolResolver === 'function') {
    return Boolean(options.toolResolver(tool));
  }
  return defaultToolResolver(tool);
}

function checkHttp(action, options) {
  const url = action.url || getStatePath(options.state, action.urlStatePath);
  if (!url) {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: 'No URL is available for HTTP verification.',
    };
  }

  if (typeof options.httpCheck === 'function') {
    try {
      const checked = options.httpCheck(url, action);
      const statusCode = Number(checked.statusCode || checked.status || 0);
      const stdout = checked.stdout || `status=${statusCode}\n`;
      return {
        status: statusCode >= 200 && statusCode < 400 ? 'completed' : 'failed',
        exitCode: statusCode >= 200 && statusCode < 400 ? 0 : 1,
        stdout,
        stderr: checked.stderr || '',
        ...(statusCode >= 200 && statusCode < 400
          ? {}
          : { error: checked.error || `HTTP verification failed for ${url}` }),
      };
    } catch (error) {
      return {
        status: 'failed',
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!options.quiet) {
    console.log(`GET ${url}`);
  }
  const script = `
    const url = process.argv[1];
    const timeoutMs = Number(process.argv[2] || 10000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { redirect: 'manual', signal: controller.signal })
      .then((response) => {
        clearTimeout(timer);
        console.log('status=' + response.status);
        process.exit(response.status >= 200 && response.status < 400 ? 0 : 1);
      })
      .catch((error) => {
        clearTimeout(timer);
        console.error(error.message || String(error));
        process.exit(1);
      });
  `;
  const result = spawnSync(process.execPath, ['-e', script, url, String(action.timeoutMs || 10000)], {
    cwd: options.root || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (!options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    return {
      status: 'failed',
      exitCode: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error?.message || `HTTP verification failed for ${url}`,
    };
  }

  return {
    status: 'completed',
    exitCode: 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function getStatePath(state, pathValue) {
  if (!pathValue) return '';
  let cursor = state || {};
  for (const part of String(pathValue).split('.').filter(Boolean)) {
    cursor = cursor?.[part];
  }
  return typeof cursor === 'string' ? cursor : '';
}

function resolveCommandInput(root, action, state = {}) {
  if (action.stdinFromEnv) {
    const value = process.env[action.stdinFromEnv];
    if (!value) {
      return {
        status: 'failed',
        error: `Missing environment variable for stdin: ${action.stdinFromEnv}`,
      };
    }
    return { status: 'completed', input: `${value}\n` };
  }

  if (action.stdinFromManagedEnvFile) {
    const filePath = path.join(root, action.stdinFromManagedEnvFile.file);
    const values = parseEnvContent(readTextIfExists(filePath));
    const value = values[action.stdinFromManagedEnvFile.key];
    if (!value) {
      return {
        status: 'failed',
        error: `Missing managed env value for stdin: ${action.stdinFromManagedEnvFile.file}:${action.stdinFromManagedEnvFile.key}`,
      };
    }
    return { status: 'completed', input: `${value}\n` };
  }

  if (action.stdinFromState) {
    const value = getStatePath(state, action.stdinFromState.path);
    if (!value) {
      return {
        status: 'failed',
        error: `Missing state value for stdin: ${action.stdinFromState.path}`,
      };
    }
    return { status: 'completed', input: `${value}\n` };
  }

  if (action.stdin) {
    return {
      status: 'failed',
      error: `Command requires stdin and has no safe stdin source: ${action.effect}`,
    };
  }

  return { status: 'completed', input: undefined };
}

function ensureGithubRepo(root, action, options = {}) {
  const [viewCommand, createCommand] = action.commands || [];
  const view = runCommand(root, viewCommand, undefined, { quiet: options.quiet });
  if (view.status === 'completed') {
    return view;
  }
  if (!isGithubRepoMissing(view)) {
    return view;
  }

  const created = runCommand(root, createCommand, undefined, { quiet: options.quiet });
  if (created.status !== 'completed') return created;

  const verify = runCommand(root, viewCommand, undefined, { quiet: options.quiet });
  return verify.status === 'completed' ? verify : created;
}

function syncGithubSecret(root, action, options = {}) {
  const resolved = buildGithubSecretCommand(action, options.state);
  if (resolved.status !== 'completed') {
    return {
      status: 'failed',
      stdout: '',
      stderr: '',
      error: resolved.error,
    };
  }

  return runCommand(root, resolved.command, resolveCommandInput(root, action, options.state), {
    redactOutput: true,
    ...githubSecretRetryOptions(action),
    quiet: options.quiet,
  });
}

function isGithubRepoMissing(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`.toLowerCase();
  return (
    output.includes('could not resolve to a repository') ||
    output.includes('repository not found') ||
    output.includes('not found') ||
    output.includes('http 404')
  );
}

function runCommand(
  root,
  command,
  inputResult = { status: 'completed', input: undefined },
  options = {}
) {
  if (inputResult.status !== 'completed') {
    return {
      status: 'failed',
      exitCode: undefined,
      stdout: '',
      stderr: '',
      error: inputResult.error,
    };
  }

  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const retryDelayMs = normalizeRetryDelayMs(options.retryDelayMs);
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!options.quiet) {
      console.log(`$ ${formatCommand(command)}`);
    }

    if (!Array.isArray(command) && options.allowProductShell !== true) {
      return {
        status: 'failed',
        exitCode: undefined,
        stdout: '',
        stderr: '',
        error: 'String commands are restricted to explicitly marked product-manifest scripts.',
        attempts: attempt,
        maxAttempts,
      };
    }

    const result = Array.isArray(command)
      ? spawnSync(command[0], command.slice(1), {
          cwd: root,
          encoding: 'utf8',
          input: inputResult.input,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })
      : spawnSync('/bin/sh', ['-c', command], {
          cwd: root,
          encoding: 'utf8',
          input: inputResult.input,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });

    const stdout = redactCommandOutput(result.stdout || '', 'stdout', options.redactOutput);
    const stderr = redactCommandOutput(result.stderr || '', 'stderr', options.redactOutput);
    const commandResult = result.status === 0
      ? {
          status: 'completed',
          exitCode: 0,
          stdout,
          stderr,
          attempts: attempt,
          maxAttempts,
        }
      : {
          status: 'failed',
          exitCode: result.status,
          stdout,
          stderr,
          error: result.error?.message || `Command exited with ${result.status}`,
          attempts: attempt,
          maxAttempts,
        };

    if (!options.quiet) {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }

    if (commandResult.status === 'completed') return commandResult;
    lastResult = commandResult;

    if (attempt < maxAttempts && shouldRetryCommand(commandResult, options)) {
      if (!options.quiet) {
        console.log(
          `[retry] command failed with exit ${commandResult.exitCode ?? 'unknown'}; retrying ${attempt + 1}/${maxAttempts} in ${retryDelayMs}ms`
        );
      }
      sleepSync(retryDelayMs);
      continue;
    }

    break;
  }

  return lastResult || {
    status: 'failed',
    exitCode: undefined,
    stdout: '',
    stderr: '',
    error: 'Command failed before execution.',
    attempts: 0,
    maxAttempts,
  };
}

function normalizeMaxAttempts(value) {
  const attempts = Number(value);
  if (!Number.isFinite(attempts) || attempts < 1) return 1;
  return Math.min(60, Math.floor(attempts));
}

function normalizeRetryDelayMs(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0) return 0;
  return Math.min(300000, Math.floor(delay));
}

function shouldRetryCommand(result, options = {}) {
  if (normalizeMaxAttempts(options.maxAttempts) <= 1) return false;
  const retryExitCodes = options.retryExitCodes;
  if (!Array.isArray(retryExitCodes) || retryExitCodes.length === 0) return true;
  return retryExitCodes.map(Number).includes(Number(result.exitCode));
}

function sleepSync(delayMs) {
  if (delayMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function redactCommandOutput(value, stream, redactOutput) {
  if (!value) return '';
  if (!redactOutput) return value;
  return `[redacted ${stream}]\n`;
}
