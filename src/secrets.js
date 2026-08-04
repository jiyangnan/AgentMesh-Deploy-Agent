import fs from 'node:fs';
import path from 'node:path';

import { nowIso, pathExists, readTextIfExists } from './utils.js';

export function buildSecretsReport(root, manifest, plan, state = {}) {
  const secrets = [];
  const shellEnv = new Map();
  const managedEnv = new Map();
  const stateValues = new Map();

  for (const step of plan.steps || []) {
    for (const action of step.actions || []) {
      if (action.type === 'env-check') {
        for (const key of action.keys || []) {
          upsertShellEnv(shellEnv, key, {
            requiredBy: step.id,
            consumer: 'preflight',
          });
        }
        continue;
      }

      const secret = secretFromAction(root, step, action, state);
      if (!secret) continue;
      secrets.push(secret);
      if (secret.source === 'shell-env') {
        upsertShellEnv(shellEnv, secret.key, {
          requiredBy: step.id,
          consumer: secret.consumer,
        });
      }
      if (secret.source === 'managed-env') {
        upsertManagedEnv(managedEnv, secret);
      }
      if (secret.source === 'state') {
        upsertStateValue(stateValues, secret);
      }
    }
  }

  const shellEnvList = Array.from(shellEnv.values()).sort((a, b) => a.key.localeCompare(b.key));
  const managedEnvList = Array.from(managedEnv.values()).sort((a, b) =>
    `${a.file}:${a.key}`.localeCompare(`${b.file}:${b.key}`)
  );
  const stateList = Array.from(stateValues.values()).sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    generatedAt: nowIso(),
    appId: manifest.app?.id || '',
    target: manifest.target || {},
    shellEnv: shellEnvList,
    managedEnv: managedEnvList,
    state: stateList,
    secrets: secrets.sort((a, b) => `${a.consumer}:${a.key}`.localeCompare(`${b.consumer}:${b.key}`)),
    missingShellEnv: shellEnvList.filter((item) => !item.present).map((item) => item.key),
    missingManagedEnv: managedEnvList.filter((item) => !item.present),
    missingState: stateList.filter((item) => !item.present).map((item) => item.path),
  };
}

function secretFromAction(root, step, action, state) {
  const key =
    action.secret ||
    action.key ||
    action.stdinFromEnv ||
    action.stdinFromManagedEnvFile?.key ||
    action.stdinFromState?.key ||
    action.stdinFromState?.path ||
    '';
  if (!key) return null;

  if (action.stdinFromManagedEnvFile) {
    const file = action.stdinFromManagedEnvFile.file || '.env.production';
    return {
      key,
      consumer: consumerForStep(step, action),
      stepId: step.id,
      source: 'managed-env',
      file,
      present: managedEnvHasValue(root, file, key),
      generated: true,
      output: action.redactOutput ? 'redacted' : 'not-redacted',
    };
  }

  if (action.stdinFromState) {
    const statePath = action.stdinFromState.path || '';
    return {
      key,
      consumer: consumerForStep(step, action),
      stepId: step.id,
      source: 'state',
      path: statePath,
      present: Boolean(getStatePath(state, statePath)),
      generated: true,
      output: action.redactOutput ? 'redacted' : 'not-redacted',
    };
  }

  const envKey = action.stdinFromEnv || key;
  return {
    key: envKey,
    consumer: consumerForStep(step, action),
    stepId: step.id,
    source: 'shell-env',
    present: Boolean(process.env[envKey]),
    generated: false,
    output: action.redactOutput ? 'redacted' : 'not-redacted',
  };
}

function consumerForStep(step, action) {
  if (action.type === 'github-secret' || step.id === 'sync-github-secrets') return 'github-actions';
  if (step.id === 'sync-worker-secrets') return 'worker-runtime';
  return step.id || 'unknown';
}

function upsertShellEnv(shellEnv, key, metadata) {
  const current = shellEnv.get(key) || {
    key,
    present: Boolean(process.env[key]),
    requiredBy: [],
    consumers: [],
  };
  current.present = Boolean(process.env[key]);
  current.requiredBy = addUnique(current.requiredBy, metadata.requiredBy);
  current.consumers = addUnique(current.consumers, metadata.consumer);
  shellEnv.set(key, current);
}

function upsertManagedEnv(managedEnv, secret) {
  const id = `${secret.file}:${secret.key}`;
  const current = managedEnv.get(id) || {
    key: secret.key,
    file: secret.file,
    present: secret.present,
    generated: Boolean(secret.generated),
    requiredBy: [],
    consumers: [],
  };
  current.present = secret.present;
  current.generated = current.generated || Boolean(secret.generated);
  current.requiredBy = addUnique(current.requiredBy, secret.stepId);
  current.consumers = addUnique(current.consumers, secret.consumer);
  managedEnv.set(id, current);
}

function upsertStateValue(stateValues, secret) {
  const id = secret.path;
  const current = stateValues.get(id) || {
    path: secret.path,
    present: secret.present,
    requiredBy: [],
    consumers: [],
  };
  current.present = Boolean(current.present || secret.present);
  current.requiredBy = addUnique(current.requiredBy, secret.stepId);
  current.consumers = addUnique(current.consumers, secret.consumer);
  stateValues.set(id, current);
}

function getStatePath(state, pathValue) {
  if (!pathValue) return '';
  let cursor = state || {};
  for (const part of String(pathValue).split('.').filter(Boolean)) {
    cursor = cursor?.[part];
  }
  if (cursor === undefined || cursor === null) return '';
  return String(cursor);
}

function managedEnvHasValue(root, file, key) {
  const filePath = path.join(root, file);
  if (!pathExists(filePath) || fs.statSync(filePath).isDirectory()) return false;
  return envFileHasValue(readTextIfExists(filePath), key);
}

function envFileHasValue(content, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=\\s*(.*)$`);
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = match[1].trim();
    return value.length > 0;
  }
  return false;
}

function addUnique(values, value) {
  if (!value || values.includes(value)) return values;
  return [...values, value].sort();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
