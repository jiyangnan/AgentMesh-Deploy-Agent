import { canExecuteAction } from './action-executor.js';
import { spawnSync } from 'node:child_process';
import { inspectDeploymentLock } from './lock.js';
import { inspectManagedFile } from './renderers.js';
import {
  collectRequiredTools,
  defaultToolResolver,
  inspectGitIdentity,
  readGitTrackedFiles,
  sensitiveTrackedFiles,
} from './tooling.js';
import { inspectSshKeyMaterial } from './ssh-keys.js';

const SUPPORTED_ACTION_TYPES = new Set([
  'command',
  'cloudflare-domain-registration',
  'cloudflare-dns-record',
  'cloudflare-resource',
  'cloudflare-zone',
  'digitalocean-droplet',
  'digitalocean-ssh-key',
  'env-any-check',
  'env-check',
  'file',
  'github-repo',
  'github-secret',
  'git-commit-if-changed',
  'git-identity-check',
  'git-init-if-missing',
  'git-remote-ensure',
  'git-tracked-check',
  'http-check',
  'porkbun-domain-registration',
  'porkbun-nameservers',
  'provider-auth-check',
  'rsync-to-host',
  'ssh-command',
  'ssh-key-check',
  'tool-check',
]);

export function inspectPlanReadiness(plan, options = {}) {
  const manifestIssues = normalizeManifestIssues(options.manifestIssues);
  const manifestErrors = manifestIssues.filter((issue) => issue.severity === 'error');
  const missingEnv = new Set();
  const policyBlocked = [];
  const providerMutations = [];
  const costMutations = [];
  const providerDeletes = [];
  const unsupportedActions = [];
  const providerAuthChecks = [];
  const secretSources = [];
  const sshKeyIssues = [];
  const pendingSteps = (plan.steps || []).filter((step) => step.status !== 'skipped');
  const stateIssues = collectStateIssues(pendingSteps);
  const requiredTools = collectRequiredTools(pendingSteps);
  const missingTools = requiredTools.filter((tool) => !resolveTool(tool, options));
  const trackedSensitiveFiles = resolveTrackedSensitiveFiles(options);
  const missingGitIdentity = resolveMissingGitIdentity(pendingSteps, options);
  const deploymentLock = resolveDeploymentLock(options);
  const managedFiles = inspectManagedFiles(pendingSteps, options);
  const managedFileDrift = managedFiles.filter((file) => file.status !== 'current');
  let verifyTarget = '';

  for (const step of pendingSteps) {
    const actions = step.actions || [];
    if (actions.length === 0 && step.kind !== 'check') {
      unsupportedActions.push({
        stepId: step.id,
        stepTitle: step.title,
        effect: 'no executable action is available',
      });
      continue;
    }

    for (const action of actions) {
      if (action.type === 'env-check') {
        for (const key of action.keys || []) {
          if (!process.env[key]) missingEnv.add(key);
        }
      }

      if (action.type === 'env-any-check') {
        const keys = action.keys || [];
        if (keys.length > 0 && !keys.some((key) => process.env[key])) {
          missingEnv.add(keys.join(' or '));
        }
      }

      for (const key of action.envKeys || []) {
        if (!process.env[key]) missingEnv.add(key);
      }

      if (action.stdinFromEnv && !process.env[action.stdinFromEnv]) {
        missingEnv.add(action.stdinFromEnv);
      }

      if (isUnsupportedAction(action)) {
        unsupportedActions.push(describeAction(step, action));
        continue;
      }

      if (action.type === 'provider-auth-check') {
        providerAuthChecks.push(resolveProviderAuthCheck(step, action, options));
      }

      if (action.type === 'ssh-key-check') {
        for (const issue of inspectSshKeyMaterial(action, process.env)) {
          sshKeyIssues.push({
            stepId: step.id,
            stepTitle: step.title,
            ...issue,
          });
        }
      }

      if (action.sideEffect === 'provider-mutation') {
        const described = describeAction(step, action);
        providerMutations.push(described);
        if (action.requiresCostApproval) {
          costMutations.push(described);
        }
      }
      if (action.sideEffect === 'provider-delete') {
        providerDeletes.push(describeAction(step, action));
      }

      if (!canExecuteAction(action, options)) {
        policyBlocked.push(describeAction(step, action));
      }

      if (action.secret || action.stdinFromEnv || action.stdinFromManagedEnvFile) {
        secretSources.push(describeSecretSource(step, action));
      }

      if (action.type === 'http-check') {
        verifyTarget = action.url || (action.urlStatePath ? `state.${action.urlStatePath}` : '');
      }
    }
  }

  const status =
    missingEnv.size > 0 ||
    missingTools.length > 0 ||
    trackedSensitiveFiles.length > 0 ||
    missingGitIdentity.length > 0 ||
    sshKeyIssues.length > 0 ||
    deploymentLock?.status === 'active' ||
    manifestErrors.length > 0 ||
    providerAuthChecks.some((check) => check.status === 'failed') ||
    policyBlocked.length > 0 ||
    unsupportedActions.length > 0
      ? 'blocked'
      : 'ready';
  const missingEnvList = Array.from(missingEnv).sort();

  return {
    status,
    appId: plan.appId,
    target: plan.target,
    planFingerprint: plan.fingerprint || '',
    pendingSteps: pendingSteps.length,
    skippedSteps: plan.summary?.skipped || 0,
    requiredTools,
    missingTools,
    trackedSensitiveFiles,
    missingGitIdentity,
    sshKeyIssues,
    deploymentLock,
    providerAuthChecks,
    managedFiles,
    managedFileDrift,
    manifestIssues,
    stateIssues,
    missingEnv: missingEnvList,
    policyBlocked,
    unsupportedActions,
    secretSources,
    verifyTarget,
    nextActions: buildNextActions({
      status,
      missingTools,
      trackedSensitiveFiles,
      missingGitIdentity,
      sshKeyIssues,
      deploymentLock,
      providerAuthChecks,
      managedFileDrift,
      manifestIssues,
      stateIssues,
      missingEnv: missingEnvList,
      policyBlocked,
      unsupportedActions,
      providerMutations,
      costMutations,
      providerDeletes,
      planFingerprint: plan.fingerprint || '',
      options,
    }),
  };
}

function buildNextActions({
  status,
  missingTools,
  trackedSensitiveFiles,
  missingGitIdentity,
  sshKeyIssues,
  deploymentLock,
  providerAuthChecks,
  managedFileDrift,
  manifestIssues,
  stateIssues,
  missingEnv,
  policyBlocked,
  unsupportedActions,
  providerMutations,
  costMutations,
  providerDeletes,
  planFingerprint,
  options,
}) {
  const actions = [];

  const manifestErrors = (manifestIssues || []).filter((issue) => issue.severity === 'error');
  if (manifestErrors.length > 0) {
    actions.push({
      id: 'fix-manifest',
      kind: 'manifest',
      title: 'Fix manifest errors before planning or apply.',
      issues: manifestErrors,
    });
  }

  if (missingTools.length > 0) {
    actions.push({
      id: 'install-missing-tools',
      kind: 'local-tools',
      title: 'Install or expose missing local tools on PATH.',
      tools: missingTools,
    });
  }

  if (missingEnv.length > 0) {
    actions.push({
      id: 'set-missing-env',
      kind: 'environment',
      title: 'Set required deployment environment variables before apply.',
      env: missingEnv,
    });
  }

  if (trackedSensitiveFiles.length > 0) {
    actions.push({
      id: 'untrack-sensitive-files',
      kind: 'git',
      title: 'Remove sensitive local files from Git tracking without deleting local copies.',
      files: trackedSensitiveFiles,
    });
  }

  if (missingGitIdentity.length > 0) {
    actions.push({
      id: 'configure-git-identity',
      kind: 'git',
      title: 'Configure Git commit identity before baseline commit.',
      config: missingGitIdentity,
    });
  }

  if (sshKeyIssues.length > 0) {
    actions.push({
      id: 'fix-ssh-key-material',
      kind: 'environment',
      title: 'Provide valid SSH private/public key material before SSH, rsync, or host provisioning.',
      issues: sshKeyIssues,
    });
  }

  if (deploymentLock?.status === 'active') {
    actions.push({
      id: 'wait-for-deployment-lock',
      kind: 'concurrency',
      title: 'Wait for the current deployment writer to finish before apply.',
      lock: deploymentLock,
    });
  }

  const failedAuthChecks = (providerAuthChecks || []).filter((check) => check.status === 'failed');
  if (failedAuthChecks.length > 0) {
    actions.push({
      id: 'authenticate-provider',
      kind: 'provider-auth',
      title: 'Authenticate provider CLIs before apply.',
      providers: Array.from(new Set(failedAuthChecks.map((check) => check.provider))).sort(),
      checks: failedAuthChecks,
    });
  }

  if (managedFileDrift.length > 0) {
    actions.push({
      id: 'review-managed-files',
      kind: 'filesystem',
      title: 'Review managed file changes before apply writes them.',
      files: managedFileDrift,
      argv: ['agentmesh-deploy', 'diff', options.root || '.', '--json'],
    });
  }

  if (stateIssues.length > 0) {
    actions.push({
      id: 'recover-state',
      kind: 'state',
      title: 'Let apply re-run these recovery steps before trusting local state.',
      stepIds: uniqueStepIds(stateIssues),
      issues: stateIssues,
    });
  }

  const mutationSteps = options.allowProviderMutations
    ? []
    : uniqueStepIds(providerMutations);
  if (mutationSteps.length > 0) {
    actions.push({
      id: 'authorize-provider-mutations',
      kind: 'policy',
      title: 'Get explicit confirmation, then include --allow-provider-mutations.',
      flags: executionFlags(planFingerprint, { providerMutations: true }),
      stepIds: mutationSteps,
    });
  }

  const costSteps = options.allowCostMutations ? [] : uniqueStepIds(costMutations);
  if (costSteps.length > 0) {
    actions.push({
      id: 'authorize-cost-mutations',
      kind: 'policy',
      title: 'Get explicit cost approval, then include --allow-cost-mutations.',
      flags: executionFlags(planFingerprint, {
        providerMutations: true,
        costMutations: true,
      }),
      stepIds: costSteps,
    });
  }

  const deleteSteps = uniqueStepIds(
    policyBlocked.filter((action) => action.sideEffect === 'provider-delete')
  );
  if (deleteSteps.length > 0 || providerDeletes.length > 0) {
    actions.push({
      id: 'review-provider-deletes',
      kind: 'policy',
      title: 'Review provider delete plan manually; delete execution is intentionally disabled.',
      stepIds: uniqueStepIds([
        ...policyBlocked.filter((action) => action.sideEffect === 'provider-delete'),
        ...providerDeletes,
      ]),
    });
  }

  if (unsupportedActions.length > 0) {
    actions.push({
      id: 'implement-adapter-support',
      kind: 'adapter',
      title: 'Implement or adjust adapter support for unsupported planned actions.',
      stepIds: uniqueStepIds(unsupportedActions),
    });
  }

  if (status === 'ready') {
    const flags = executionFlags(planFingerprint, {
      providerMutations: providerMutations.length > 0,
      costMutations: costMutations.length > 0,
    });
    if (providerDeletes.length > 0) {
      flags.push('--allow-provider-deletes');
    }
    actions.push({
      id: 'run-apply',
      kind: 'execute',
      title: 'Ready for explicit apply execution.',
      flags,
    });
  }

  return actions;
}

function executionFlags(planFingerprint, { providerMutations = false, costMutations = false } = {}) {
  const flags = ['--execute', '--yes'];
  if (providerMutations) flags.push('--allow-provider-mutations');
  if (costMutations) flags.push('--allow-cost-mutations');
  if (planFingerprint) flags.push('--expect-plan', planFingerprint);
  return flags;
}

function normalizeManifestIssues(issues) {
  return Array.isArray(issues) ? issues : [];
}

function collectStateIssues(pendingSteps) {
  return pendingSteps
    .filter((step) => step.reason)
    .map((step) => ({
      stepId: step.id,
      stepTitle: step.title,
      kind: step.kind,
      reason: step.reason,
    }));
}

function inspectManagedFiles(pendingSteps, options) {
  if (!options.root || !options.manifest || !options.state) return [];
  const renderContext = {};
  return pendingSteps
    .flatMap((step) =>
      (step.actions || [])
        .filter((action) => action.type === 'file')
        .map((action) => inspectManagedFile(
          options.root,
          action,
          options.manifest,
          options.state,
          renderContext
        ))
    );
}

function uniqueStepIds(actions) {
  return Array.from(new Set(actions.map((action) => action.stepId).filter(Boolean))).sort();
}

function resolveTool(tool, options) {
  if (typeof options.toolResolver === 'function') {
    return Boolean(options.toolResolver(tool));
  }
  return defaultToolResolver(tool);
}

function resolveTrackedSensitiveFiles(options) {
  if (Array.isArray(options.trackedFiles)) {
    return sensitiveTrackedFiles(options.trackedFiles);
  }
  if (!options.root) return [];
  const tracked = readGitTrackedFiles(options.root);
  return tracked.status === 'completed' ? sensitiveTrackedFiles(tracked.files) : [];
}

function resolveMissingGitIdentity(pendingSteps, options) {
  const needsIdentity = pendingSteps.some((step) =>
    (step.actions || []).some((action) => action.type === 'git-identity-check')
  );
  if (!needsIdentity) return [];
  if (options.gitIdentity?.missing) return [...options.gitIdentity.missing].sort();
  if (!options.root) return [];
  return inspectGitIdentity(options.root).missing;
}

function resolveDeploymentLock(options) {
  if (options.deploymentLock !== undefined) return options.deploymentLock;
  if (!options.root) return null;
  const lock = inspectDeploymentLock(options.root);
  return lock?.status === 'active' ? lock : null;
}

function resolveProviderAuthCheck(step, action, options) {
  const base = {
    stepId: step.id,
    stepTitle: step.title,
    provider: action.provider || step.provider || 'unknown',
    effect: action.effect || '',
    command: formatAuthCommand(action),
    status: 'not-run',
  };

  if (!options.probeAuth) return base;

  const runner = options.authProbeRunner || runAuthProbe;
  const result = runner(action, options);
  if (result?.status === 'completed') {
    return {
      ...base,
      status: 'completed',
    };
  }

  return {
    ...base,
    status: 'failed',
    exitCode: result?.exitCode ?? null,
    error: compactAuthError(result?.stderr || result?.stdout || result?.error),
  };
}

function runAuthProbe(action, options) {
  const command = Array.isArray(action.command) ? action.command : String(action.command || '').split(/\s+/);
  const [tool, ...args] = command.filter(Boolean);
  if (!tool) {
    return {
      status: 'failed',
      error: 'auth check command is empty',
    };
  }

  const result = spawnSync(tool, args, {
    cwd: options.root || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: options.authProbeTimeoutMs || 15000,
  });

  if (result.status === 0) {
    return {
      status: 'completed',
      exitCode: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  return {
    status: 'failed',
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || `auth check exited with ${result.status}`,
  };
}

function formatAuthCommand(action) {
  const command = action?.displayCommand || action?.command || action;
  if (Array.isArray(command)) return command.join(' ');
  return String(command || '');
}

function compactAuthError(error) {
  const value = String(error || 'provider authentication check failed').replace(/\s+/g, ' ').trim();
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function isUnsupportedAction(action) {
  return (
    action.type === 'manual' ||
    action.sideEffect === 'unknown' ||
    !SUPPORTED_ACTION_TYPES.has(action.type)
  );
}

function describeAction(step, action) {
  return {
    stepId: step.id,
    stepTitle: step.title,
    type: action.type,
    sideEffect: action.sideEffect || 'unknown',
    requiresCostApproval: Boolean(action.requiresCostApproval),
    effect: action.effect || '',
  };
}

function describeSecretSource(step, action) {
  return {
    stepId: step.id,
    secret: action.secret || action.stdinFromEnv || action.stdinFromManagedEnvFile?.key || '',
    source: action.stdinFromEnv
      ? `env:${action.stdinFromEnv}`
      : `${action.stdinFromManagedEnvFile?.file}:${action.stdinFromManagedEnvFile?.key}`,
    output: action.redactOutput ? 'redacted' : 'not-redacted',
  };
}
