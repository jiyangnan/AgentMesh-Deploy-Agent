import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { operationError } from './errors.js';
import { projectPath, resolveDeployHome } from './project-store.js';
import { nowIso } from './utils.js';

export function withControlLock(home, scope, command, fn) {
  const release = acquireControlLock(home, scope, command);
  try {
    return fn();
  } finally {
    release();
  }
}

export async function withControlLockAsync(home, scope, command, fn) {
  const release = acquireControlLock(home, scope, command);
  try {
    return await fn();
  } finally {
    release();
  }
}

function acquireControlLock(home, scope, command) {
  const file = controlLockPath(home, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  recoverStaleLock(file);
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readLock(file);
    throw operationError(
      'LOCKED',
      `Control lock is active for ${scope}: ${owner?.command || 'unknown command'} pid ${owner?.pid || 'unknown'}.`
    );
  }

  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({
      version: 1,
      token,
      scope,
      command,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: nowIso(),
    }, null, 2)}\n`, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    const current = readLock(file);
    if (fs.existsSync(file) && (!current || current.token === token)) fs.unlinkSync(file);
    throw error;
  }

  let released = false;
  return function releaseControlLock() {
    if (released) return;
    released = true;
    const current = readLock(file);
    if (current?.token === token && fs.existsSync(file)) fs.unlinkSync(file);
  };
}

export function controlLockPath(home, scope) {
  const targetHome = resolveDeployHome(home);
  if (scope === 'registry') return path.join(targetHome, 'registry.lock.json');
  if (!scope.startsWith('project:')) throw operationError('VALIDATION_FAILED', `Unknown control lock scope: ${scope}`);
  return path.join(projectPath(targetHome, scope.slice('project:'.length)), 'lock.json');
}

function recoverStaleLock(file) {
  if (!fs.existsSync(file)) return;
  const owner = readLock(file);
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid)) return;
  if (isProcessAlive(owner.pid)) return;
  fs.unlinkSync(file);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
