import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { operationError } from './errors.js';

const SMALL_FILE_HASH_LIMIT = 4 * 1024 * 1024;

export function inspectRepositorySource(locator, { cwd = process.cwd() } = {}) {
  const normalized = normalizeRepositoryLocator(locator, cwd);
  if (normalized.kind === 'local-git') {
    const root = gitText(normalized.locator, ['rev-parse', '--show-toplevel']).trim();
    const canonicalRoot = fs.realpathSync(root);
    const commit = gitText(canonicalRoot, ['rev-parse', 'HEAD']).trim();
    const branchResult = runGit(canonicalRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    const remoteResult = runGit(canonicalRoot, ['remote', 'get-url', 'origin'], { allowFailure: true });
    return {
      kind: 'local-git',
      locator: canonicalRoot,
      commit,
      branch: branchResult.status === 0 ? branchResult.stdout.trim() : '',
      remote: remoteResult.status === 0 ? sanitizeRemote(remoteResult.stdout.trim()) : '',
    };
  }

  const result = runGit(process.cwd(), ['ls-remote', normalized.locator, 'HEAD']);
  const commit = result.stdout.trim().split(/\s+/)[0] || '';
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw operationError('SOURCE_UNAVAILABLE', `Unable to resolve remote HEAD for ${normalized.locator}`);
  }
  return {
    kind: 'remote-git',
    locator: normalized.locator,
    commit,
    branch: '',
    remote: normalized.locator,
  };
}

export function captureRepositoryFingerprint(root) {
  const canonicalRoot = fs.realpathSync(root);
  const git = {
    head: gitText(canonicalRoot, ['rev-parse', 'HEAD']),
    branch: runGit(canonicalRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }).stdout.trim(),
    index: hashText(gitText(canonicalRoot, ['ls-files', '-s', '-z'])),
    status: hashText(gitText(canonicalRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])),
    worktreeDiff: hashText(gitText(canonicalRoot, ['diff', '--binary', '--no-ext-diff'])),
    stagedDiff: hashText(gitText(canonicalRoot, ['diff', '--cached', '--binary', '--no-ext-diff'])),
    remotes: hashText(gitText(canonicalRoot, ['remote', '-v'])),
  };
  const files = fingerprintFileTree(canonicalRoot);
  const fingerprint = hashText(JSON.stringify({ git, files }));
  return {
    version: 1,
    root: canonicalRoot,
    fingerprint,
    git,
    files,
  };
}

export function captureSourceGuard(source) {
  if (source.kind !== 'local-git') return null;
  return captureRepositoryFingerprint(source.locator);
}

export function completeSourceGuard(source, before) {
  if (source.kind !== 'local-git') {
    return {
      status: 'not-applicable',
      reason: 'remote-source-is-cloned-without-writing-to-the-remote-repository',
      commit: source.commit,
    };
  }
  return assertRepositoryUnchanged(before, captureRepositoryFingerprint(source.locator));
}

export function assertRepositoryUnchanged(before, after) {
  if (before.fingerprint === after.fingerprint) {
    return {
      status: 'unchanged',
      fingerprint: before.fingerprint,
      before: before.fingerprint,
      after: after.fingerprint,
    };
  }
  const changed = [];
  for (const key of Object.keys(before.git || {})) {
    if (before.git[key] !== after.git?.[key]) changed.push(`git.${key}`);
  }
  if (before.files?.digest !== after.files?.digest || before.files?.count !== after.files?.count) {
    changed.push('files');
  }
  throw operationError(
    'REPOSITORY_CHANGED',
    `Product repository changed during a read-only operation (${changed.join(', ') || 'unknown fingerprint difference'}).`
  );
}

export function assertControlHomeSeparated(home, source) {
  if (source.kind !== 'local-git') return;
  const controlHome = canonicalPath(home);
  const repositoryRoot = canonicalPath(source.locator);
  if (isPathWithin(repositoryRoot, controlHome) || isPathWithin(controlHome, repositoryRoot)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'AGENTMESH_DEPLOY_HOME and the product repository must be physically separate paths.');
  }
}

function canonicalPath(target) {
  const absolute = path.resolve(target);
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const canonicalBase = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.join(canonicalBase, ...missing);
}

export function repositoryName(locator) {
  const value = String(locator || '').replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const segment = value.split(/[\\/:]/).filter(Boolean).at(-1);
  return segment || 'agentmesh-app';
}

export function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || '').trim();
    throw operationError('GIT_COMMAND_FAILED', `Git command failed: git ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function normalizeRepositoryLocator(locator, cwd) {
  const value = String(locator || '').trim();
  if (!value) throw operationError('VALIDATION_FAILED', '--repo is required.');
  if (value.startsWith('-')) throw operationError('VALIDATION_FAILED', 'Repository locator cannot start with a hyphen.');

  const filePath = value.startsWith('file://') ? fileURLToPath(value) : path.resolve(cwd, value);
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (!stat.isDirectory()) throw operationError('VALIDATION_FAILED', `Repository path is not a directory: ${filePath}`);
    return { kind: 'local-git', locator: fs.realpathSync(filePath) };
  }
  if (/^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@)[^\s]+$/i.test(value)) {
    assertSafeRemote(value);
    return { kind: 'remote-git', locator: value };
  }
  throw operationError('SOURCE_UNAVAILABLE', `Repository path does not exist or remote URL is unsupported: ${value}`);
}

function assertSafeRemote(value) {
  if (value.startsWith('git@')) return;
  let remote;
  try {
    remote = new URL(value);
  } catch {
    throw operationError('VALIDATION_FAILED', 'Remote Git URL is invalid.');
  }
  if (remote.password || (remote.protocol.startsWith('http') && remote.username) || remote.search || remote.hash) {
    throw operationError('SECRET_IN_INPUT', 'Remote Git URL must not contain embedded credentials, query parameters, or fragments.');
  }
}

function sanitizeRemote(value) {
  if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/)/i.test(value)) return value;
  try {
    const remote = new URL(value);
    remote.username = '';
    remote.password = '';
    remote.search = '';
    remote.hash = '';
    return remote.toString();
  } catch {
    return '';
  }
}

function gitText(cwd, args) {
  return runGit(cwd, args).stdout;
}

function fingerprintFileTree(root) {
  const hash = createHash('sha256');
  let count = 0;

  walk(root, '');
  return { count, digest: hash.digest('hex') };

  function walk(directory, relativeDirectory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      count += 1;
      hash.update(`${relative}\0${entryType(entry)}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0`);
      if (entry.isSymbolicLink()) {
        hash.update(`${fs.readlinkSync(absolute)}\0`);
      } else if (entry.isFile() && stat.size <= SMALL_FILE_HASH_LIMIT) {
        hash.update(fs.readFileSync(absolute));
        hash.update('\0');
      } else if (entry.isDirectory()) {
        walk(absolute, relative);
      }
    }
  }
}

function entryType(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isSocket()) return 'socket';
  if (entry.isFIFO()) return 'fifo';
  return 'other';
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
