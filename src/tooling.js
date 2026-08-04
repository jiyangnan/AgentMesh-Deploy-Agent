import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export function defaultToolResolver(tool) {
  if (!tool) return true;
  if (path.isAbsolute(tool) || tool.includes('/')) return isExecutable(tool);

  const pathValue = process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (isExecutable(path.join(directory, `${tool}${extension}`))) return true;
    }
  }
  return false;
}

export function collectRequiredTools(steps) {
  const tools = new Set();
  for (const step of steps) {
    for (const action of step.actions || []) {
      for (const tool of actionToolNames(action)) {
        tools.add(tool);
      }
    }
  }
  return Array.from(tools).sort();
}

export function actionToolNames(action) {
  if (action.type === 'tool-check') {
    return action.tools || [];
  }

  if (action.type === 'git-tracked-check') {
    return ['git'];
  }

  if (action.type === 'command') {
    const tool = toolNameFromCommand(action.command);
    return tool ? [tool] : [];
  }

  if (action.type === 'provider-auth-check') {
    const tool = toolNameFromCommand(action.command);
    return tool ? [tool] : [];
  }

  if (action.type === 'cloudflare-resource') {
    return Array.from(new Set([
      toolNameFromCommand(action.listCommand),
      toolNameFromCommand(action.createCommand),
    ].filter(Boolean)));
  }

  if (action.type === 'digitalocean-droplet' || action.type === 'digitalocean-ssh-key') {
    return ['doctl'];
  }

  if (action.type === 'cloudflare-domain-registration') {
    return ['node'];
  }

  if (action.type === 'cloudflare-dns-record') {
    return ['node'];
  }

  if (action.type === 'cloudflare-zone') {
    return ['node'];
  }

  if (action.type === 'porkbun-domain-registration' || action.type === 'porkbun-nameservers') {
    return ['node'];
  }

  if (action.type === 'ssh-command') {
    return ['ssh'];
  }

  if (action.type === 'rsync-to-host') {
    return ['rsync', 'ssh'];
  }

  if (action.type === 'github-repo') {
    return (action.commands || [])
      .map((command) => toolNameFromCommand(command))
      .filter(Boolean);
  }

  if (action.type === 'github-secret') {
    return ['gh'];
  }

  if (action.type === 'git-commit-if-changed') {
    return Array.from(new Set(['git', toolNameFromCommand(action.command)].filter(Boolean)));
  }

  if (
    action.type === 'git-identity-check' ||
    action.type === 'git-init-if-missing' ||
    action.type === 'git-remote-ensure'
  ) {
    return ['git'];
  }

  return [];
}

export function toolNameFromCommand(command) {
  const words = Array.isArray(command) ? command : shellWords(String(command || ''));
  for (const word of words) {
    if (!word || isEnvAssignment(word) || word === 'env') continue;
    return path.basename(word);
  }
  return '';
}

export function readGitTrackedFiles(root) {
  const result = spawnSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.error || result.status !== 0) {
    const message =
      result.error?.message ||
      (result.stderr || result.stdout || '').trim() ||
      `git ls-files exited with ${result.status}`;
    return {
      status: 'skipped',
      files: [],
      error: message,
    };
  }

  return {
    status: 'completed',
    files: result.stdout.split(/\r?\n/).map(normalizeGitPath).filter(Boolean),
  };
}

export function inspectGitIdentity(root, env = process.env) {
  const hasName = Boolean(
    env.GIT_AUTHOR_NAME ||
      env.GIT_COMMITTER_NAME ||
      readGitConfig(root, 'user.name')
  );
  const hasEmail = Boolean(
    env.GIT_AUTHOR_EMAIL ||
      env.GIT_COMMITTER_EMAIL ||
      readGitConfig(root, 'user.email')
  );
  const missing = [];
  if (!hasName) missing.push('user.name');
  if (!hasEmail) missing.push('user.email');
  return {
    missing,
    present: {
      name: hasName,
      email: hasEmail,
    },
  };
}

export function sensitiveTrackedFiles(files) {
  return Array.from(new Set((files || []).map(normalizeGitPath).filter(isSensitiveTrackedFile)))
    .sort();
}

export function isSensitiveTrackedFile(file) {
  const normalized = normalizeGitPath(file);
  return (
    normalized === '.env' ||
    (normalized.startsWith('.env.') && normalized !== '.env.example') ||
    normalized === '.agentmesh-deploy/state.json' ||
    normalized.startsWith('.agentmesh-deploy/runs/') ||
    normalized.startsWith('.agentmesh-deploy/reviews/') ||
    normalized.startsWith('.agentmesh-deploy/diffs/') ||
    normalized.startsWith('.agentmesh-deploy/handoffs/')
  );
}

export function githubRepoUrlFromRepo(repo) {
  const normalized = normalizeGitRepoTarget(repo);
  return normalized.includes('/') ? `https://github.com/${normalized}.git` : '';
}

export function githubRepoSlugFromUrl(url) {
  return githubRepoIdentity(url);
}

export function githubRepoSlugFromTarget(repo) {
  const normalized = normalizeGitRepoTarget(repo);
  return normalized.includes('/') ? normalized : '';
}

export function githubRepoTargetMatches(url, repo) {
  const normalizedRepo = normalizeGitRepoTarget(repo);
  if (!url || !normalizedRepo) return false;
  const identity = githubRepoIdentity(url);
  if (!identity) return false;
  if (normalizedRepo.includes('/')) return identity === normalizedRepo.toLowerCase();
  return identity.split('/').at(-1) === normalizedRepo.toLowerCase();
}

export function githubRemoteUrlsMatch(current, expected) {
  const currentIdentity = githubRepoIdentity(current);
  const expectedIdentity = githubRepoIdentity(expected);
  if (currentIdentity && expectedIdentity) return currentIdentity === expectedIdentity;
  return stripGitRemoteSuffix(current) === stripGitRemoteSuffix(expected);
}

function shellWords(command) {
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function isEnvAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function normalizeGitPath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function normalizeGitRepoTarget(repo) {
  return String(repo || '')
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
}

function githubRepoIdentity(url) {
  const value = stripGitRemoteSuffix(url);
  const httpsMatch = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`.toLowerCase();
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();
  const sshUrlMatch = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrlMatch) return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`.toLowerCase();
  return '';
}

function stripGitRemoteSuffix(url) {
  return String(url || '').trim().replace(/\/$/, '').replace(/\.git$/, '');
}

function readGitConfig(root, key) {
  const result = spawnSync('git', ['config', '--get', key], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
