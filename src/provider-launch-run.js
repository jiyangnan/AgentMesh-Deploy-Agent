import { operationError } from './errors.js';
import { readLaunchRun, resumeLaunchRun, startLaunchRun } from './launch-run.js';
import { resolveDeployHome } from './project-store.js';
import { resumeSandboxRun, startSandboxRun } from './sandbox-run.js';

export async function startProviderLaunchRun(options) {
  if (options.providerMode !== 'real') return startLaunchRun(options);
  assertRealProviderExecutionOptions(options, 'apply');
  return realProviderLaunchReport(await startSandboxRun(toSandboxOptions(options, 'apply')));
}

export async function resumeProviderLaunchRun(options) {
  if (options.providerMode !== 'real') return resumeLaunchRun(options);
  assertRealProviderExecutionOptions(options, 'resume');
  const current = readLaunchRun(resolveDeployHome(options.home), options.projectId, options.runId);
  return realProviderLaunchReport(await resumeSandboxRun({
    ...toSandboxOptions(options, 'resume'),
    graphId: current.graphId,
  }));
}

function toSandboxOptions(options, operation) {
  return {
    ...options,
    planId: options.adapterPlanId,
    profileId: options.sandboxProfileId,
    preflightId: options.sandboxPreflightId,
    allowSandboxNetwork: options.allowProviderNetwork,
    nativeCliNetwork: options.nativeCliNetwork === true,
    ...(operation === 'apply' ? { runId: '' } : {}),
  };
}

function assertRealProviderExecutionOptions(options, operation) {
  if (!options.execute || !options.yes || !options.allowProviderNetwork || !options.allowProviderMutations) {
    throw operationError(
      'APPROVAL_REQUIRED',
      `launch ${operation} real-provider execution requires --execute --yes --allow-provider-network --allow-provider-mutations.`
    );
  }
  if (!options.adapterPlanId || !options.sandboxProfileId || !options.sandboxPreflightId) {
    throw operationError(
      'VALIDATION_FAILED',
      `launch ${operation} real-provider execution requires --adapter-plan, --sandbox-profile, and --preflight.`
    );
  }
  if (operation === 'apply' && !options.graphId) {
    throw operationError('VALIDATION_FAILED', 'launch apply real-provider execution requires an explicit graph id.');
  }
  if (operation === 'resume' && !options.runId) {
    throw operationError('VALIDATION_FAILED', 'launch resume real-provider execution requires a run id.');
  }
  if (options.allowProviderDeletes) {
    throw operationError('UNSUPPORTED', 'launch real-provider execution never authorizes provider deletes.');
  }
  if (Boolean(options.databaseRuntimeProfileId) !== Boolean(options.allowDatabaseMigration)) {
    throw operationError(
      'VALIDATION_FAILED',
      `launch ${operation} real-provider execution requires --database-runtime-profile and --allow-database-migration together.`
    );
  }
}

function realProviderLaunchReport(report) {
  return {
    ...report,
    kind: 'launch-run',
    entrypoint: 'launch-real-provider',
    authorizationBoundary: 'sandbox',
  };
}
