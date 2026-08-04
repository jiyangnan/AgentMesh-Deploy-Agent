import { executeActions } from './action-executor.js';
import { markCompleted, writeState } from './state.js';
import { nowIso } from './utils.js';
import { printActions } from './output.js';

export function executePlan(root, plan, state, options = {}) {
  const dryRun = options.dryRun !== false;
  const quiet = options.quiet === true;
  let nextState = state;
  const results = [];

  for (const step of plan.steps) {
    if (step.status === 'skipped') {
      results.push({ stepId: step.id, status: 'skipped', reason: step.reason });
      continue;
    }

    if (dryRun) {
      if (!quiet) {
        console.log(`[dry-run] ${step.title}`);
        printActions(step.actions || [], '  ');
      }
      results.push({ stepId: step.id, status: 'dry-run' });
      continue;
    }

    let result;
    try {
      result = executeStep(root, step, nextState, options);
    } catch (error) {
      result = {
        stepId: step.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    if (result.status === 'failed') {
      break;
    }
    if (result.status === 'completed') {
      nextState = markCompleted(nextState, step.id);
      nextState = applyStateUpdates(nextState, result.stateUpdates || {});
      if (step.kind === 'resource') {
        nextState = {
          ...nextState,
          resources: {
            ...nextState.resources,
            [step.resource.id]: {
              type: step.resource.type,
              name: step.resource.name,
              provider: step.provider,
              providerId: result.providerId || '',
              createdAt: nowIso(),
            },
          },
        };
      }
      nextState = writeState(root, nextState);
    }
  }

  return {
    id: `apply-${Date.now()}`,
    command: 'apply',
    mode: dryRun ? 'dry-run' : 'execute',
    status: results.some((result) => result.status === 'failed') ? 'failed' : 'completed',
    createdAt: nowIso(),
    plan,
    results,
  };
}

function executeStep(root, step, state, options) {
  const result = executeActions(root, step, {
    root,
    manifest: options.manifest,
    state,
    allowProviderMutations: options.allowProviderMutations,
    allowCostMutations: options.allowCostMutations,
    allowProviderDeletes: options.allowProviderDeletes,
    toolResolver: options.toolResolver,
    gitIdentity: options.gitIdentity,
    httpCheck: options.httpCheck,
    quiet: options.quiet,
  });
  return {
    stepId: step.id,
    status: result.status,
    providerId: result.captures.providerId || '',
    captures: result.captures,
    stateUpdates: result.stateUpdates || {},
    outputs: result.outputs,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function applyStateUpdates(state, updates) {
  let next = state;
  for (const [path, value] of Object.entries(updates || {})) {
    next = setStatePath(next, path, value);
  }
  return next;
}

function setStatePath(state, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (parts.length === 0) return state;
  const next = structuredClone(state);
  let cursor = next;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return next;
}
