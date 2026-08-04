import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_DIR } from './manifest.js';
import { ensureDir, nowIso, pathExists, readJson } from './utils.js';

export const LOCK_FILE = 'lock.json';
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export function lockPath(root) {
  return path.join(root, CONFIG_DIR, LOCK_FILE);
}

export function inspectDeploymentLock(root, options = {}) {
  const filePath = lockPath(root);
  if (!pathExists(filePath)) return null;
  const record = readLockRecord(filePath);
  const status = isStaleLock(record, options.now ?? Date.now(), options.staleMs ?? STALE_LOCK_MS)
    ? 'stale'
    : 'active';

  return {
    status,
    path: filePath,
    command: record?.command || 'unknown',
    pid: record?.pid || null,
    hostname: record?.hostname || '',
    createdAt: record?.createdAt || '',
  };
}

export async function withDeploymentLock(root, command, fn) {
  const lock = acquireDeploymentLock(root, command);
  try {
    return await fn(lock.record);
  } finally {
    lock.release();
  }
}

export function acquireDeploymentLock(root, command, options = {}) {
  const filePath = lockPath(root);
  ensureDir(path.dirname(filePath));

  const record = {
    version: 1,
    token: crypto.randomUUID(),
    command,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: nowIso(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(filePath, 'wx');
      try {
        fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      return {
        path: filePath,
        record,
        release: () => releaseDeploymentLock(filePath, record.token),
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLockRecord(filePath);
      if (!isStaleLock(existing, options.now ?? Date.now(), options.staleMs ?? STALE_LOCK_MS)) {
        throw activeLockError(filePath, existing);
      }
      unlinkLock(filePath);
    }
  }

  throw new Error(`Could not acquire deployment lock: ${filePath}`);
}

export function releaseDeploymentLock(filePath, token) {
  if (!pathExists(filePath)) return false;
  const existing = readLockRecord(filePath);
  if (existing?.token !== token) return false;
  unlinkLock(filePath);
  return true;
}

function unlinkLock(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function readLockRecord(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function isStaleLock(record, nowMs, staleMs) {
  if (!record || typeof record !== 'object') return true;
  if (record.hostname && record.hostname !== os.hostname()) {
    return lockAgeMs(record, nowMs) > staleMs;
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0) return true;
  return !isProcessAlive(record.pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockAgeMs(record, nowMs) {
  const createdAt = Date.parse(record.createdAt || '');
  if (!Number.isFinite(createdAt)) return Number.POSITIVE_INFINITY;
  return nowMs - createdAt;
}

function activeLockError(filePath, record = {}) {
  const command = record.command || 'unknown';
  const pid = record.pid || 'unknown';
  const hostname = record.hostname || 'unknown';
  const createdAt = record.createdAt || 'unknown';
  return new Error(
    [
      `Deployment lock is active: ${filePath}`,
      `Command: ${command}`,
      `Owner: pid ${pid} on ${hostname}`,
      `Created: ${createdAt}`,
    ].join('\n')
  );
}
