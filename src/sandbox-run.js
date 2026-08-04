import { resumeAdapterLaunchRun, startAdapterLaunchRun } from './adapter-launch-run.js';
import { operationError } from './errors.js';
import {
  createSandboxPreflight,
  showSandboxPreflight,
} from './sandbox-preflight.js';
import { createSecretRuntime } from './secret-store.js';
import { nowIso } from './utils.js';

export async function startSandboxRun(options) {
  assertSandboxExecutionOptions(options, 'apply');
  const authorization = await authorizeSandboxExecution(options, 'apply');
  const launch = await startAdapterLaunchRun({
    ...options,
    planId: options.planId,
    execute: true,
    yes: true,
    executionEnvironment: 'sandbox',
    allowSandboxNetwork: true,
    sandboxProfileId: options.profileId,
    sandboxPreflightEvidence: authorization.evidence,
    runtime: authorization.runtime,
  });
  return sandboxRunReport('apply', launch, authorization);
}

export async function resumeSandboxRun(options) {
  assertSandboxExecutionOptions(options, 'resume');
  const authorization = await authorizeSandboxExecution(options, 'resume');
  const launch = await resumeAdapterLaunchRun({
    ...options,
    execute: true,
    yes: true,
    executionEnvironment: 'sandbox',
    allowSandboxNetwork: true,
    sandboxProfileId: options.profileId,
    sandboxPreflightEvidence: authorization.evidence,
    runtime: authorization.runtime,
  });
  return sandboxRunReport('resume', launch, authorization);
}

async function authorizeSandboxExecution(options, operation) {
  const now = options.now || nowIso();
  const shown = showSandboxPreflight({
    home: options.home,
    projectId: options.projectId,
    graphId: options.graphId,
    planId: options.planId,
    profileId: options.profileId,
    evidenceId: options.preflightId,
    databaseRuntimeProfileId: options.databaseRuntimeProfileId,
    now,
  });
  if (shown.evidence.databaseRuntimeProfileId &&
      shown.evidence.databaseRuntimeProfileId !== options.databaseRuntimeProfileId) {
    throw operationError('CONFLICT', 'Sandbox Preflight is bound to a different Database Runtime Profile.');
  }
  if (shown.evidence.status !== 'ready' || (operation === 'apply' && shown.effectiveStatus !== 'ready')) {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED',
      `Sandbox execution requires current ready Preflight Evidence: ${shown.evidence.id}`
    );
  }
  const runtime = buildSandboxRuntime(options, shown.evidence);
  const runtimeCapabilities = sandboxRuntimeCapabilities(runtime);
  const current = await createSandboxPreflight({
    home: options.home,
    projectId: options.projectId,
    graphId: options.graphId,
    planId: options.planId,
    profileId: options.profileId,
    probeSecrets: true,
    env: options.env || process.env,
    secretRuntime: runtime.secretRuntime,
    runtimeCapabilities,
    databaseRuntimeProfileId: options.databaseRuntimeProfileId,
    psqlAvailable: options.psqlAvailable,
    now,
  });
  if (current.evidence.status !== 'ready') {
    throw operationError(
      'APPROVAL_REQUIRED',
      `Sandbox execution preflight is no longer ready: ${current.evidence.blockers.map((item) => item.code).join(', ')}`
    );
  }
  assertSameAuthorizationFacts(shown.evidence, current.evidence, operation);
  return {
    evidence: shown.evidence,
    evidenceFile: shown.evidenceFile,
    currentEvidence: current.evidence,
    currentEvidenceFile: current.evidenceFile,
    runtime,
    runtimeCapabilities,
  };
}

export function buildSandboxRuntime(options, evidence) {
  const source = options.runtime || {};
  if (source.adapters) throw operationError('VALIDATION_FAILED', 'Sandbox CLI execution does not allow injected Adapter instances.');
  const env = options.env || process.env;
  const secretRuntime = source.secretRuntime || createSecretRuntime({
    env,
    stores: options.secretStores || {},
    commandRunner: options.commandRunner,
  });
  const providerOptions = { ...(source.providerOptions || {}) };
  for (const provider of new Set(evidence.connectionChecks.map((item) => item.provider))) {
    const current = providerOptions[provider] || {};
    providerOptions[provider] = {
      ...current,
      env: current.env || env,
      ...(!current.secretSink && typeof secretRuntime.check === 'function' && typeof secretRuntime.store === 'function'
        ? { secretSink: secretRuntime }
        : {}),
      ...(!current.secretSource && typeof secretRuntime.read === 'function'
        ? { secretSource: secretRuntime }
        : {}),
    };
  }
  return {
    ...source,
    allowNetworkTransport: true,
    transportProvenance: options.nativeCliNetwork === true
      ? 'native-cli-fixed-host'
      : 'injected-test',
    providerOptions,
    secretRuntime,
  };
}

export function sandboxRuntimeCapabilities(runtime = {}) {
  const capabilities = new Set(['provider-http', 'env-secret-source']);
  for (const options of Object.values(runtime.providerOptions || {})) {
    if (options?.secretSink && typeof options.secretSink.check === 'function' && typeof options.secretSink.store === 'function') {
      capabilities.add('secret-sink');
    }
    if (options?.secretSource && typeof options.secretSource.read === 'function') capabilities.add('secret-source');
    if (options?.migrationExecutor &&
        typeof options.migrationExecutor.inspect === 'function' && typeof options.migrationExecutor.apply === 'function') {
      capabilities.add('migration-executor');
    }
  }
  return [...capabilities].sort();
}

function assertSameAuthorizationFacts(approved, current, operation) {
  const keys = operation === 'resume'
    ? ['connectionChecks', 'runtimeChecks', 'status']
    : ['connectionChecks', 'approvalChecks', 'runtimeChecks', 'mutationBudget', 'status'];
  const changed = keys.filter((key) => stableStringify(approved[key]) !== stableStringify(current[key]));
  if (operation === 'resume' && !resumeMutationBudgetIsMonotonic(approved.mutationBudget, current.mutationBudget)) {
    changed.push('mutationBudget');
  }
  if (changed.length > 0) {
    throw operationError(
      'CONFLICT',
      `Sandbox authorization facts changed after Preflight Evidence was approved: ${changed.join(', ')}`
    );
  }
}

function resumeMutationBudgetIsMonotonic(approved, current) {
  const approvedUsed = approved.used || 0;
  return approved.estimated === current.estimated && approved.maximum === current.maximum &&
    Number.isInteger(current.used) && current.used >= approvedUsed &&
    current.remaining <= approved.remaining && current.remaining >= current.required &&
    current.required <= (approved.required ?? approved.estimated) &&
    current.status === 'ready';
}

function assertSandboxExecutionOptions(options, operation) {
  if (!options.execute || !options.yes || !options.allowSandboxNetwork || !options.allowProviderMutations) {
    throw operationError(
      'APPROVAL_REQUIRED',
      `sandbox ${operation} requires --execute --yes --allow-sandbox-network --allow-provider-mutations.`
    );
  }
  if (!options.preflightId) throw operationError('VALIDATION_FAILED', `sandbox ${operation} requires --preflight.`);
  if (options.databaseRuntimeProfileId && options.allowDatabaseMigration !== true) {
    throw operationError(
      'APPROVAL_REQUIRED',
      `sandbox ${operation} with a Database Runtime Profile requires --allow-database-migration.`
    );
  }
  if (operation === 'resume' && !options.runId) throw operationError('VALIDATION_FAILED', 'sandbox resume requires --run.');
  if (operation === 'apply' && options.runId) throw operationError('VALIDATION_FAILED', 'sandbox apply does not accept --run.');
}

function sandboxRunReport(operation, launch, authorization) {
  return {
    ...launch,
    kind: 'sandbox-launch-run',
    operation,
    sandboxProfileId: launch.run.sandboxProfileId,
    sandboxProfileFingerprint: launch.run.sandboxProfileFingerprint,
    sandboxPreflightId: authorization.evidence.id,
    sandboxPreflightFingerprint: authorization.evidence.fingerprint,
    sandboxPreflightFile: authorization.evidenceFile,
    currentPreflightId: authorization.currentEvidence.id,
    currentPreflightFingerprint: authorization.currentEvidence.fingerprint,
    currentPreflightFile: authorization.currentEvidenceFile,
    runtimeCapabilities: authorization.runtimeCapabilities,
    transportProvenance: launch.run.transportProvenance,
    ...(launch.run.databaseRuntimeProfileId ? {
      databaseRuntimeProfileId: launch.run.databaseRuntimeProfileId,
      databaseRuntimeProfileFingerprint: launch.run.databaseRuntimeProfileFingerprint,
    } : {}),
    secretValuesExposed: false,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
