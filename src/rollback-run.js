import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createAdapterRegistry } from './adapter-registry.js';
import { showBackupEvidence } from './backup-evidence.js';
import { listConnections } from './connection-service.js';
import { withControlLockAsync } from './control-lock.js';
import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import {
  executeDatabaseRollback,
  planDatabaseRollback,
  reconcileDatabaseRollback,
} from './database-rollback-runtime.js';
import { authorizeDatabaseRollbackRuntimeProfile } from './database-runtime-profile.js';
import { operationError } from './errors.js';
import { loadCommittedMigrationBundle, showDatabaseMigrationPlan } from './migration-plan.js';
import { createPostgresRollbackRuntime } from './postgres-rollback-runtime.js';
import { createFixedHostFetch } from './provider-http.js';
import { assertPublicResolution } from './product-verification.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue, validateActionResult } from './provider-contract.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { requireActiveRollbackApproval, showRollbackApproval, validateRollbackApproval } from './rollback-approval.js';
import { assertRollbackPlanCurrent } from './rollback-plan.js';
import { createSecretRuntime, prepareAdapterRuntime } from './secret-store.js';
import { nowIso } from './utils.js';

const RUN_ID = /^rollback-run-[a-f0-9-]{36}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TERMINAL = new Set(['succeeded', 'not-required']);
const RUN_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'rollbackPlanId', 'rollbackPlanFingerprint', 'approvalId', 'approvalFingerprint', 'revision',
  'databaseRuntimeProfileId', 'databaseRuntimeProfileFingerprint',
  'status', 'stepStates', 'providerMutationsExecuted', 'databaseMutationsExecuted',
  'createdAt', 'updatedAt',
];
const LEGACY_RUN_KEYS = RUN_KEYS.filter((key) => ![
  'databaseRuntimeProfileId', 'databaseRuntimeProfileFingerprint',
].includes(key));
const STEP_KEYS = ['status', 'attempt', 'resultRef', 'lastError', 'updatedAt'];

export async function startRollbackRun(options) {
  assertRollbackExecutionFlags(options, 'apply');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'rollback-apply', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const now = options.now || nowIso();
    const initial = assertRollbackPlanCurrent({
      home, projectId: project.id, graphId: options.graphId,
      configurationId: options.configurationId, planId: options.planId,
    });
    if (requiredMutationSteps(initial.plan).includes('database.rollback') && !options.allowDatabaseRestore) {
      throw operationError('APPROVAL_REQUIRED', 'Rollback Plan includes database.rollback and requires --allow-database-restore.');
    }
    const authorization = requireActiveRollbackApproval({
      home, projectId: project.id, graphId: options.graphId, configurationId: options.configurationId,
      approvalId: options.approvalId, requiredStepIds: requiredMutationSteps(initial.plan), now,
    });
    if (authorization.plan.id !== initial.plan.id || authorization.plan.fingerprint !== initial.plan.fingerprint) {
      throw operationError('APPROVAL_REQUIRED', 'Rollback Approval does not bind the requested Rollback Plan.');
    }
    if (authorization.plan.dns.strategy !== 'restore-exact') {
      throw operationError('CONFLICT', 'Rollback apply requires a restore-exact DNS strategy.');
    }
    const databaseRuntimeProfile = authorizeRollbackDatabaseRuntime({
      ...options, home, project, now,
      graph: authorization.graph,
      configuration: authorization.configuration,
      rollbackPlan: authorization.plan,
    });
    authorization.databaseRuntimeProfile = databaseRuntimeProfile;
    const existing = findRollbackRunByPlan(home, project.id, authorization.plan.id);
    if (existing) throw operationError('ALREADY_EXISTS', `Rollback Plan already has a Run; resume it instead: ${existing.id}`);
    let run = createRollbackRun(
      authorization.plan,
      authorization.approval,
      now,
      authorization.databaseRuntimeProfile
    );
    let files = writeRollbackRunRevision(home, project.id, run);
    const execution = await executeRollback({
      ...options, home, project, authorization, run, now,
      writeRevision(next) { files = writeRollbackRunRevision(home, project.id, next); },
    });
    run = execution.run;
    persistRollbackFact(home, project.id, authorization.plan, run, now);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return rollbackRunReport('apply', home, project.id, authorization, run, files, execution, repositoryGuard);
  });
}

export async function resumeRollbackRun(options) {
  assertRollbackExecutionFlags(options, 'resume');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'rollback-resume', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const now = options.now || nowIso();
    let run = readRollbackRun(home, project.id, options.runId);
    const current = assertRollbackPlanCurrent({
      home, projectId: project.id, graphId: run.graphId,
      configurationId: options.configurationId, planId: run.rollbackPlanId,
    });
    const shownApproval = showRollbackApproval({
      home, projectId: project.id, graphId: run.graphId,
      configurationId: options.configurationId, approvalId: run.approvalId, now,
    });
    validateRollbackApproval(shownApproval.approval, { projectId: project.id, graph: current.graph, plan: current.plan });
    if (shownApproval.approval.fingerprint !== run.approvalFingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Rollback Run Approval binding changed.');
    }
    const pendingMutationSteps = requiredMutationSteps(current.plan)
      .filter((stepId) => run.stepStates[stepId].status !== 'succeeded');
    if (pendingMutationSteps.includes('database.rollback') && !options.allowDatabaseRestore) {
      throw operationError('APPROVAL_REQUIRED', 'Pending database.rollback requires --allow-database-restore.');
    }
    if (pendingMutationSteps.length > 0) {
      requireActiveRollbackApproval({
        home, projectId: project.id, graphId: run.graphId, configurationId: options.configurationId,
        approvalId: run.approvalId, requiredStepIds: pendingMutationSteps, now,
      });
    }
    let files = {
      runFile: rollbackRevisionPath(home, project.id, run.id, run.revision),
      currentRunFile: path.join(projectPath(home, project.id), 'rollback-runs', run.id, 'current.json'),
    };
    const authorization = { ...shownApproval, plan: current.plan, graph: current.graph, configuration: current.configuration };
    const databaseRuntimeProfile = authorizeRollbackDatabaseRuntime({
      ...options, home, project, now,
      graph: current.graph,
      configuration: current.configuration,
      rollbackPlan: current.plan,
    });
    authorization.databaseRuntimeProfile = databaseRuntimeProfile;
    const expectedProfileId = databaseRuntimeProfile?.id || '';
    const expectedProfileFingerprint = databaseRuntimeProfile?.fingerprint || '';
    if (String(run.databaseRuntimeProfileId || '') !== expectedProfileId ||
        String(run.databaseRuntimeProfileFingerprint || '') !== expectedProfileFingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Rollback Run Database Runtime Profile binding changed.');
    }
    const execution = await executeRollback({
      ...options, home, project, authorization, run, now,
      writeRevision(next) { files = writeRollbackRunRevision(home, project.id, next); },
    });
    run = execution.run;
    persistRollbackFact(home, project.id, current.plan, run, now);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return rollbackRunReport('resume', home, project.id, authorization, run, files, execution, repositoryGuard);
  });
}

export function readRollbackRun(homeInput, projectId, runId) {
  const home = resolveDeployHome(homeInput);
  if (!RUN_ID.test(runId || '')) throw operationError('VALIDATION_FAILED', 'Rollback Run ID is invalid.');
  const directory = rollbackRevisionDirectory(home, projectId, runId);
  if (!fs.existsSync(directory)) throw operationError('NOT_FOUND', `Rollback Run not found: ${runId}`);
  const files = fs.readdirSync(directory).filter((name) => /^\d{6}\.json$/.test(name)).sort();
  if (files.length === 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Run has no immutable revisions: ${runId}`);
  const file = path.join(directory, files.at(-1));
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Run JSON is invalid: ${safeMessage(error.message)}`); }
  validateRollbackRun(run, { projectId });
  if (run.revision !== files.length || file !== rollbackRevisionPath(home, projectId, run.id, run.revision)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Run revision sequence is invalid: ${run.id}`);
  }
  return run;
}

export function validateRollbackRun(run, expected = {}) {
  const issues = [];
  exactOneOfKeys(run, [LEGACY_RUN_KEYS, RUN_KEYS], '$', issues);
  if (run?.schemaVersion !== 1 || run?.kind !== 'RollbackRun' || !RUN_ID.test(run?.id || '') || !SHA256.test(run?.fingerprint || '')) issues.push('kind|id|fingerprint');
  if (expected.projectId && run?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.plan && (
    run?.rollbackPlanId !== expected.plan.id || run?.rollbackPlanFingerprint !== expected.plan.fingerprint ||
    run?.graphId !== expected.plan.graphId || run?.graphFingerprint !== expected.plan.graphFingerprint
  )) issues.push('plan(binding)');
  if (expected.approval && (run?.approvalId !== expected.approval.id || run?.approvalFingerprint !== expected.approval.fingerprint)) issues.push('approval(binding)');
  const databaseRuntimeProfileId = String(run?.databaseRuntimeProfileId || '');
  const databaseRuntimeProfileFingerprint = String(run?.databaseRuntimeProfileFingerprint || '');
  if ((databaseRuntimeProfileId === '') !== (databaseRuntimeProfileFingerprint === '') ||
      (databaseRuntimeProfileId && !/^database-runtime-[a-f0-9]{24}$/.test(databaseRuntimeProfileId)) ||
      (databaseRuntimeProfileFingerprint && !SHA256.test(databaseRuntimeProfileFingerprint))) {
    issues.push('databaseRuntimeProfile');
  }
  if (!Number.isInteger(run?.revision) || run.revision < 1 || !isDate(run?.createdAt) || !isDate(run?.updatedAt)) issues.push('revision|time');
  if (!Number.isInteger(run?.providerMutationsExecuted) || run.providerMutationsExecuted < 0 || run.providerMutationsExecuted > 2 ||
    !Number.isInteger(run?.databaseMutationsExecuted) || run.databaseMutationsExecuted < 0 || run.databaseMutationsExecuted > 1) issues.push('mutationCounts');
  const ids = ['dns.restore', 'release.retain', 'database.rollback', 'verification.repeat'];
  exactKeys(run?.stepStates, ids, 'stepStates', issues);
  for (const id of ids) validateStepState(run?.stepStates?.[id], id, issues);
  const status = summarizeRollbackRun(run?.stepStates || {});
  if (run?.status !== status) issues.push('status(semantic)');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Rollback Run is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (run.fingerprint !== rollbackRunFingerprint(run)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Run fingerprint mismatch: ${run.id}`);
  }
  return run;
}

export function rollbackRunFingerprint(run) {
  const value = structuredClone(run);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

async function executeRollback(context) {
  let run = context.run;
  let networkRequestsExecuted = 0;
  let dnsState = run.stepStates['dns.restore'];

  if (dnsState.status === 'succeeded') {
    const completed = readDnsRollbackReceiptIfExists(
      context.home, context.project.id, run, dnsState.attempt, context.authorization
    );
    if (!completed || completed.file !== dnsState.resultRef || !completed.result.ok ||
      completed.result.status !== 'succeeded' || completed.mutationCount !== run.providerMutationsExecuted) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Succeeded DNS rollback is not backed by its exact immutable Receipt.');
    }
  }

  if (dnsState.status === 'running') {
    const recovered = readDnsRollbackReceiptIfExists(
      context.home, context.project.id, run, dnsState.attempt, context.authorization
    );
    if (recovered) {
      run = applyDnsReceipt(run, recovered, context);
      dnsState = run.stepStates['dns.restore'];
      if (dnsState.status !== 'succeeded') {
        return { run, networkRequestsExecuted, receiptFile: recovered.file };
      }
    }
  }

  if (dnsState.status !== 'succeeded') {
    if (['failed-terminal', 'blocked', 'not-required'].includes(dnsState.status)) {
      return { run, networkRequestsExecuted, receiptFile: dnsState.resultRef };
    }
    if (dnsState.attempt >= 3) {
      run = transitionStep(run, 'dns.restore', 'failed-terminal', {
        lastError: { code: 'RETRY_BUDGET_EXHAUSTED', retryable: false }, updatedAt: context.now,
      });
      context.writeRevision(run);
      return { run, networkRequestsExecuted, receiptFile: dnsState.resultRef };
    }
    if (run.providerMutationsExecuted >= context.authorization.approval.limits.maxProviderMutations) {
      run = transitionStep(run, 'dns.restore', 'failed-terminal', {
        lastError: { code: 'ROLLBACK_BUDGET_EXCEEDED', retryable: false }, updatedAt: context.now,
      });
      context.writeRevision(run);
      return { run, networkRequestsExecuted, receiptFile: dnsState.resultRef };
    }
    const prepared = await getPreparedRollbackRuntime(context);
    const adapter = prepared.registry.get(context.authorization.plan.dns.connectionId, 'cloudflare');
    run = ensureStepRunning(run, 'dns.restore', context.now);
    context.writeRevision(run);
    const sequence = run.stepStates['dns.restore'].attempt;
    const input = dnsRollbackInput(context.authorization, run.createdAt);
    const intent = writeDnsRollbackIntent(context.home, context.project.id, run, sequence, input, context.now);
    const planned = await adapter.planDnsRollback(input);
    validateActionResult(planned, { appId: context.authorization.graph.appId });
    if (!planned.ok || !planned.data?.planFingerprint) {
      const failed = writeDnsRollbackReceipt(
        context.home, context.project.id, run, sequence, intent, planned, context.now
      );
      run = applyDnsReceipt(run, failed, context);
      return { run, networkRequestsExecuted, receiptFile: failed.file };
    }
    let result = await adapter.executeDnsRollback({
      ...input,
      ...planned.data,
      execute: true,
      yes: true,
      allowProviderMutations: true,
      approvalFingerprint: context.authorization.approval.fingerprint.slice('sha256:'.length),
    });
    networkRequestsExecuted += resultNetworkRequestCount(result);
    validateActionResult(result, { appId: context.authorization.graph.appId });
    if (context.failAfterDnsMutation && resultMutationCount(result) > 0) {
      throw operationError('ROLLBACK_EXECUTION_INTERRUPTED', 'Injected interruption after DNS rollback mutation and before Receipt.');
    }
    result = accountForMissingReceiptRecovery(result, intent);
    const written = writeDnsRollbackReceipt(
      context.home, context.project.id, run, sequence, intent, result, context.now
    );
    if (context.failAfterDnsReceipt) {
      throw operationError('ROLLBACK_EXECUTION_INTERRUPTED', 'Injected interruption after DNS rollback Receipt.');
    }
    run = applyDnsReceipt(run, written, context);
  }
  if (run.stepStates['dns.restore'].status === 'succeeded') {
    const database = await executeDatabaseRollbackStep(context, run);
    run = database.run;
    networkRequestsExecuted += database.networkRequestsExecuted;
  }
  if (run.stepStates['dns.restore'].status === 'succeeded' &&
    TERMINAL.has(run.stepStates['database.rollback'].status)) {
    const verification = await executeRouteVerification(context, run);
    run = verification.run;
    networkRequestsExecuted += verification.networkRequestsExecuted;
    context.writeRevision(run);
  }
  return {
    run,
    networkRequestsExecuted,
    receiptFile: run.stepStates['dns.restore'].resultRef,
  };
}

function applyDnsReceipt(run, receipt, context) {
  const mutationCount = Math.max(run.providerMutationsExecuted, receipt.mutationCount);
  let next = run;
  if (mutationCount !== next.providerMutationsExecuted) {
    next = patchRollbackRun(next, { providerMutationsExecuted: mutationCount, updatedAt: context.now });
    context.writeRevision(next);
  }
  if (mutationCount > context.authorization.approval.limits.maxProviderMutations) {
    next = transitionStep(next, 'dns.restore', 'failed-terminal', {
      resultRef: receipt.file,
      lastError: { code: 'ROLLBACK_BUDGET_EXCEEDED', retryable: false },
      updatedAt: context.now,
    });
  } else if (receipt.result?.ok && receipt.result.status === 'succeeded') {
    next = transitionStep(next, 'dns.restore', 'succeeded', {
      resultRef: receipt.file, lastError: null, updatedAt: context.now,
    });
  } else {
    next = failDnsStep(next, receipt, context.now, mutationCount >= context.authorization.approval.limits.maxProviderMutations);
  }
  context.writeRevision(next);
  return next;
}

async function executeDatabaseRollbackStep(context, sourceRun) {
  let run = sourceRun;
  let state = run.stepStates['database.rollback'];
  if (state.status === 'not-required') return { run, networkRequestsExecuted: 0 };
  if (state.status === 'succeeded') {
    const completed = readDatabaseRollbackReceiptIfExists(
      context.home, context.project.id, run, state.attempt, context.authorization
    );
    if (!completed || completed.file !== state.resultRef || !completed.result.ok ||
      completed.result.status !== 'succeeded' || completed.databaseMutationCount !== run.databaseMutationsExecuted) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Succeeded database rollback is not backed by its exact immutable Receipt.');
    }
    return { run, networkRequestsExecuted: 0 };
  }
  if (state.status === 'running') {
    const recovered = readDatabaseRollbackReceiptIfExists(
      context.home, context.project.id, run, state.attempt, context.authorization
    );
    if (recovered) {
      run = applyDatabaseReceipt(run, recovered, context);
      state = run.stepStates['database.rollback'];
      if (state.status !== 'succeeded') return { run, networkRequestsExecuted: 0 };
      return { run, networkRequestsExecuted: 0 };
    }
  }
  if (['failed-terminal', 'not-required'].includes(state.status)) return { run, networkRequestsExecuted: 0 };
  if (state.attempt >= 3) {
    run = transitionStep(run, 'database.rollback', 'failed-terminal', {
      lastError: { code: 'RETRY_BUDGET_EXHAUSTED', retryable: false }, updatedAt: context.now,
    });
    context.writeRevision(run);
    return { run, networkRequestsExecuted: 0 };
  }
  if (run.databaseMutationsExecuted >= 1) {
    run = transitionStep(run, 'database.rollback', 'failed-terminal', {
      lastError: { code: 'ROLLBACK_BUDGET_EXCEEDED', retryable: false }, updatedAt: context.now,
    });
    context.writeRevision(run);
    return { run, networkRequestsExecuted: 0 };
  }
  const prepared = context.runtime?.databaseRollback
    ? null
    : await getPreparedRollbackRuntime(context);
  const runtime = context.runtime?.databaseRollback || prepared?.runtime.databaseRollback;
  const networkBefore = prepared?.networkCounter.value || 0;
  const method = context.authorization.plan.database.strategy === 'apply-down' ? 'applyDown' : 'restoreBackup';
  if (!runtime || typeof runtime.inspect !== 'function' || typeof runtime[method] !== 'function') {
    run = transitionStep(run, 'database.rollback', 'blocked', {
      lastError: { code: 'DATABASE_ROLLBACK_RUNTIME_REQUIRED', retryable: false }, updatedAt: context.now,
    });
    context.writeRevision(run);
    return { run, networkRequestsExecuted: 0 };
  }

  run = ensureStepRunning(run, 'database.rollback', context.now);
  context.writeRevision(run);
  const sequence = run.stepStates['database.rollback'].attempt;
  const input = databaseRollbackInput(context);
  const intent = writeDatabaseRollbackIntent(
    context.home, context.project.id, run, sequence, input, context.now
  );
  const planned = planDatabaseRollback(input);
  validateActionResult(planned, { appId: context.authorization.graph.appId });
  if (!planned.ok || !planned.data?.planFingerprint) {
    const failed = writeDatabaseRollbackReceipt(
      context.home, context.project.id, run, sequence, intent, planned, context.now
    );
    run = applyDatabaseReceipt(run, failed, context);
    return { run, networkRequestsExecuted: (prepared?.networkCounter.value || 0) - networkBefore };
  }
  const executionInput = {
    ...input,
    ...planned.data,
    execute: true,
    yes: true,
    allowDatabaseRestore: true,
    approvalFingerprint: context.authorization.approval.fingerprint.slice('sha256:'.length),
  };
  let result = intent.reused
    ? await reconcileDatabaseRollback(executionInput, runtime)
    : await executeDatabaseRollback(executionInput, runtime);
  validateActionResult(result, { appId: context.authorization.graph.appId });
  if (context.failAfterDatabaseMutation && resultDatabaseMutationCount(result) > 0) {
    throw operationError('ROLLBACK_EXECUTION_INTERRUPTED', 'Injected interruption after database rollback mutation and before Receipt.');
  }
  result = accountForMissingDatabaseReceiptRecovery(result, intent);
  const written = writeDatabaseRollbackReceipt(
    context.home, context.project.id, run, sequence, intent, result, context.now
  );
  if (context.failAfterDatabaseReceipt) {
    throw operationError('ROLLBACK_EXECUTION_INTERRUPTED', 'Injected interruption after database rollback Receipt.');
  }
  run = applyDatabaseReceipt(run, written, context);
  return { run, networkRequestsExecuted: (prepared?.networkCounter.value || 0) - networkBefore };
}

function applyDatabaseReceipt(run, receipt, context) {
  const mutationCount = Math.max(run.databaseMutationsExecuted, receipt.databaseMutationCount);
  let next = run;
  if (mutationCount !== next.databaseMutationsExecuted) {
    next = patchRollbackRun(next, { databaseMutationsExecuted: mutationCount, updatedAt: context.now });
    context.writeRevision(next);
  }
  if (mutationCount > 1) {
    next = transitionStep(next, 'database.rollback', 'failed-terminal', {
      resultRef: receipt.file,
      lastError: { code: 'ROLLBACK_BUDGET_EXCEEDED', retryable: false }, updatedAt: context.now,
    });
  } else if (receipt.result?.ok && receipt.result.status === 'succeeded') {
    next = transitionStep(next, 'database.rollback', 'succeeded', {
      resultRef: receipt.file, lastError: null, updatedAt: context.now,
    });
  } else {
    const retryable = mutationCount === 0 && receipt.result?.error?.retryable === true;
    next = transitionStep(next, 'database.rollback', retryable ? 'failed-retryable' : 'failed-terminal', {
      resultRef: receipt.file,
      lastError: { code: receipt.result?.error?.code || 'DATABASE_ROLLBACK_FAILED', retryable },
      updatedAt: context.now,
    });
  }
  context.writeRevision(next);
  return next;
}

async function buildRollbackRuntime(context) {
  const source = context.runtime || {};
  if (source.adapters) throw operationError('VALIDATION_FAILED', 'Rollback execution does not accept injected Adapter instances.');
  const connections = listConnections({ home: context.home, projectId: context.project.id }).connections;
  const env = context.env || process.env;
  const providerOptions = { ...(source.providerOptions || {}) };
  const cloudflare = { ...(providerOptions.cloudflare || {}), env: providerOptions.cloudflare?.env || env };
  if (!cloudflare.transport) {
    const fetchImpl = createFixedHostFetch(['api.cloudflare.com'], source.fetchImpl || globalThis.fetch);
    cloudflare.httpOptions = { ...(cloudflare.httpOptions || {}), fetchImpl };
  }
  providerOptions.cloudflare = cloudflare;
  const neon = { ...(providerOptions.neon || {}), env: providerOptions.neon?.env || env };
  if (!neon.transport) {
    const fetchImpl = createFixedHostFetch(['console.neon.tech'], source.fetchImpl || globalThis.fetch);
    neon.httpOptions = { ...(neon.httpOptions || {}), fetchImpl };
  }
  providerOptions.neon = neon;
  let runtime = {
    ...source,
    allowNetworkTransport: true,
    providerOptions,
    secretRuntime: source.secretRuntime || createSecretRuntime({
      env, stores: context.secretStores || {}, commandRunner: context.commandRunner,
    }),
  };
  const connectionIds = [context.authorization.plan.dns.connectionId];
  if (context.authorization.databaseRuntimeProfile) {
    connectionIds.push(context.authorization.databaseRuntimeProfile.connectionId);
  }
  runtime = await prepareAdapterRuntime(connections, {
    actions: [...new Set(connectionIds)].map((connectionId) => ({ connectionId })),
  }, runtime);
  const registry = createAdapterRegistry(connections, runtime);
  const networkCounter = { value: 0 };
  if (context.authorization.databaseRuntimeProfile) {
    runtime = {
      ...runtime,
      databaseRollback: createNativeDatabaseRollbackRuntime(context, registry, runtime, networkCounter),
    };
  }
  return { connections, runtime, registry, networkCounter };
}

async function getPreparedRollbackRuntime(context) {
  if (!context.preparedRollbackRuntime) {
    context.preparedRollbackRuntime = await buildRollbackRuntime(context);
  }
  return context.preparedRollbackRuntime;
}

function authorizeRollbackDatabaseRuntime(options) {
  if (options.runtime?.databaseRollback) {
    if (options.databaseRuntimeProfileId) {
      throw operationError('VALIDATION_FAILED', 'Injected database rollback Runtime cannot be combined with a Database Runtime Profile.');
    }
    return null;
  }
  return authorizeDatabaseRollbackRuntimeProfile({
    home: options.home,
    project: options.project,
    graph: options.graph,
    configuration: options.configuration,
    rollbackPlan: options.rollbackPlan,
    profileId: options.databaseRuntimeProfileId,
    now: options.now,
  });
}

function createNativeDatabaseRollbackRuntime(context, registry, runtime, networkCounter) {
  const profile = context.authorization.databaseRuntimeProfile;
  const adapter = registry.get(profile.connectionId, 'neon');
  const schemaInspector = async (input) => {
    networkCounter.value += 2;
    const result = await adapter.inspectSchema({
      appId: context.authorization.graph.appId,
      logicalId: 'database.rollback.inspect',
      projectId: input.databaseProjectId,
      branchId: input.databaseBranchId,
      databaseName: input.databaseName,
    });
    if (!result?.ok || result.status !== 'succeeded' || !result.data?.schemaFingerprint) {
      throw operationError('DATABASE_INSPECTION_FAILED', 'Neon rollback Schema inspection failed.');
    }
    return { schemaFingerprint: result.data.schemaFingerprint };
  };
  const snapshotRestorer = async (input) => {
    const restoreInput = {
      appId: context.authorization.graph.appId,
      logicalId: 'database.rollback.snapshot-restore',
      projectId: input.databaseProjectId,
      snapshotId: input.backupProviderId,
      sourceBranchId: input.databaseBranchId,
      targetBranchId: input.databaseBranchId,
      name: `agentmesh-restore-${input.rollbackPlanId.slice(-24)}`,
      rollbackPlanId: input.rollbackPlanId,
      rollbackPlanFingerprint: input.rollbackPlanFingerprint,
      backupEvidenceId: input.backupEvidenceId,
      backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    };
    const planned = adapter.planSnapshotRestore(restoreInput);
    validateActionResult(planned, { appId: context.authorization.graph.appId });
    if (!planned.ok || !planned.data?.planFingerprint) {
      throw operationError(planned.error?.code || 'DATABASE_RESTORE_FAILED', 'Neon Snapshot Restore planning failed.');
    }
    networkCounter.value += 3;
    let result = await adapter.executeSnapshotRestore({
      ...restoreInput,
      planFingerprint: planned.data.planFingerprint,
      approvalFingerprint: context.authorization.approval.fingerprint.slice('sha256:'.length),
      execute: true,
      yes: true,
      allowProviderMutations: true,
      allowDatabaseRestore: true,
    });
    validateActionResult(result, { appId: context.authorization.graph.appId });
    if (!result.ok) {
      throw operationError(result.error?.code || 'DATABASE_RESTORE_FAILED', 'Neon Snapshot Restore failed or requires reconciliation.');
    }
    const operationIds = result.data?.operationIds || [];
    for (let attempt = 1; result.status === 'waiting-external' && attempt <= 60; attempt += 1) {
      await sleepFor(context.databasePollIntervalMs ?? 2000);
      networkCounter.value += operationIds.length;
      result = await adapter.pollOperation({
        appId: context.authorization.graph.appId,
        projectId: input.databaseProjectId,
        operationIds,
      });
      validateActionResult(result, { appId: context.authorization.graph.appId });
      if (!result.ok) {
        throw operationError(result.error?.code || 'DATABASE_RESTORE_FAILED', 'Neon Snapshot Restore operation failed.');
      }
    }
    if (result.status === 'waiting-external') {
      throw operationError('PROVIDER_OPERATION_TIMEOUT', 'Neon Snapshot Restore operation exceeded the bounded poll window.');
    }
    return { databaseMutationsExecuted: 1, snapshotId: input.backupProviderId };
  };
  return createPostgresRollbackRuntime({
    secretRuntime: runtime.secretRuntime,
    connectionSecretRef: profile.connectionSecretRef,
    allowedHosts: profile.allowedHosts,
    allowSqlExecution: profile.allowSqlExecution,
    commandRunner: context.databaseCommandRunner,
    schemaInspector,
    snapshotRestorer,
    bundleLoader: () => loadCommittedMigrationBundle({
      home: context.home,
      projectId: context.project.id,
      graphId: context.authorization.graph.id,
      configurationId: profile.configurationId,
      planId: profile.migrationPlanId,
      direction: 'down',
    }),
    sleep: (ms) => sleepFor(context.databasePollIntervalMs === 0 ? 0 : ms),
    verificationAttempts: context.databaseVerificationAttempts,
    verificationIntervalMs: context.databaseVerificationIntervalMs,
  });
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dnsRollbackInput(authorization, now) {
  const plan = authorization.plan;
  return {
    appId: authorization.graph.appId,
    logicalId: 'dns.restore',
    rollbackPlanId: plan.id,
    rollbackPlanFingerprint: plan.fingerprint,
    applyReceiptFingerprint: plan.dns.applyReceipt.fingerprint,
    zoneId: plan.dns.zoneId,
    appliedRecord: plan.dns.appliedRecord.record,
    restoreRecord: plan.dns.beforeRecords[0],
    now,
  };
}

function databaseRollbackInput(context) {
  const plan = context.authorization.plan;
  const database = plan.database;
  if (!['apply-down', 'restore-backup'].includes(database.strategy)) {
    throw operationError('CONFLICT', 'Rollback Plan does not contain an executable database strategy.');
  }
  const migration = showDatabaseMigrationPlan({
    home: context.home,
    projectId: context.project.id,
    graphId: context.authorization.graph.id,
    configurationId: context.authorization.configuration.id,
    planId: database.migrationPlanId,
  }).plan;
  const backup = showBackupEvidence({
    home: context.home,
    projectId: context.project.id,
    graphId: context.authorization.graph.id,
    evidenceId: database.backupEvidenceId,
  }).evidence;
  if (migration.fingerprint !== database.migrationPlanFingerprint ||
    backup.fingerprint !== database.backupEvidenceFingerprint ||
    backup.migrationPlanId !== migration.id) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database rollback Plan no longer matches Migration and Backup Evidence.');
  }
  return {
    appId: context.authorization.graph.appId,
    projectId: context.project.id,
    graphId: context.authorization.graph.id,
    strategy: database.strategy,
    rollbackPlanId: plan.id,
    rollbackPlanFingerprint: plan.fingerprint,
    migrationPlanId: migration.id,
    migrationPlanFingerprint: migration.fingerprint,
    backupEvidenceId: backup.id,
    backupEvidenceFingerprint: backup.fingerprint,
    backupProviderId: backup.backup.resource.providerId,
    databaseProjectId: backup.backup.resource.attributes.projectId,
    databaseBranchId: backup.backup.resource.attributes.sourceBranchId,
    provider: database.provider,
    databaseName: context.authorization.configuration.database.databaseName,
    expectedSchemaVersion: migration.expectedSchemaVersion,
    baselineSchemaFingerprint: backup.schemaInspection.schemaFingerprint,
  };
}

async function executeRouteVerification(context, run) {
  if (run.stepStates['verification.repeat'].status === 'succeeded') {
    readRouteVerificationEvidence(
      context.home, context.project.id, run, context.authorization.plan,
      run.stepStates['verification.repeat'].attempt
    );
    return { run, networkRequestsExecuted: 0 };
  }
  if (run.stepStates['verification.repeat'].status === 'failed-retryable' &&
    run.stepStates['verification.repeat'].attempt >= 3) {
    return {
      run: transitionStep(run, 'verification.repeat', 'failed-terminal', {
        lastError: { code: 'RETRY_BUDGET_EXHAUSTED', retryable: false }, updatedAt: context.now,
      }),
      networkRequestsExecuted: 0,
    };
  }
  const configuredVerifier = context.runtime?.routeVerifier;
  const verifier = configuredVerifier === undefined
    ? async () => verifyRollbackRoute(context)
    : configuredVerifier;
  if (typeof verifier !== 'function') {
    return {
      run: transitionStep(run, 'verification.repeat', 'blocked', {
        lastError: { code: 'ROUTE_VERIFIER_REQUIRED', retryable: false }, updatedAt: context.now,
      }),
      networkRequestsExecuted: 0,
    };
  }
  let next = ensureStepRunning(run, 'verification.repeat', context.now);
  context.writeRevision(next);
  let raw;
  try {
    raw = await verifier({
      projectId: context.project.id,
      graphId: context.authorization.graph.id,
      rollbackPlanId: context.authorization.plan.id,
      targetUrl: context.authorization.plan.trigger.targetUrl,
      restoredRecord: structuredClone(context.authorization.plan.dns.beforeRecords[0]),
    });
  } catch {
    raw = { status: 'failed', reasonCode: 'ROUTE_VERIFICATION_FAILED' };
  }
  const networkRequestsExecuted = Number.isInteger(raw?.networkRequestsExecuted) &&
    raw.networkRequestsExecuted >= 0 && raw.networkRequestsExecuted <= 1
    ? raw.networkRequestsExecuted
    : 1;
  const safe = normalizeRouteVerification(raw);
  const evidenceFile = writeRouteVerificationEvidence(
    context.home, context.project.id, next, context.authorization.plan,
    next.stepStates['verification.repeat'].attempt, safe, context.now
  );
  next = transitionStep(next, 'verification.repeat', safe.status === 'passed' ? 'succeeded' : 'failed-retryable', {
    resultRef: evidenceFile,
    lastError: safe.status === 'passed' ? null : { code: safe.reasonCode, retryable: true },
    updatedAt: context.now,
  });
  return { run: next, networkRequestsExecuted };
}

async function verifyRollbackRoute(context) {
  let target;
  try { target = new URL(context.authorization.plan.trigger.targetUrl); }
  catch { return { status: 'failed', reasonCode: 'ROUTE_TARGET_INVALID', networkRequestsExecuted: 0 }; }
  if (target.protocol !== 'https:' || target.port || target.username || target.password ||
    target.pathname !== '/' || target.search || target.hash) {
    return { status: 'failed', reasonCode: 'ROUTE_TARGET_INVALID', networkRequestsExecuted: 0 };
  }
  try {
    await assertPublicResolution(target.hostname, context.resolveHost);
  } catch {
    return { status: 'failed', reasonCode: 'ROUTE_RESOLUTION_UNSAFE', networkRequestsExecuted: 0 };
  }
  const fetchImpl = context.routeFetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { status: 'failed', reasonCode: 'CAPABILITY_MISSING', networkRequestsExecuted: 0 };
  }
  const fixedFetch = createFixedHostFetch([target.hostname], fetchImpl);
  let response;
  try {
    response = await fixedFetch(target.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.1',
        'user-agent': 'AgentMesh-Deploy-Rollback-Verifier/1',
      },
      signal: typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(context.timeoutMs || 15000)
        : undefined,
    });
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) {
      return { status: 'failed', reasonCode: 'ROUTE_HTTP_STATUS_MISMATCH', networkRequestsExecuted: 1 };
    }
    return { status: 'passed', networkRequestsExecuted: 1 };
  } catch {
    return { status: 'failed', reasonCode: 'ROUTE_VERIFICATION_FAILED', networkRequestsExecuted: 1 };
  } finally {
    try { await response?.body?.cancel?.(); } catch {}
  }
}

function createRollbackRun(plan, approval, now, databaseRuntimeProfile = null) {
  const stepStates = Object.fromEntries(plan.steps.map((step) => [step.id, {
    status: step.status === 'ready' ? 'ready' : step.status,
    attempt: 0,
    resultRef: null,
    lastError: step.status === 'blocked' ? { code: 'PLAN_STEP_BLOCKED', retryable: false } : null,
    updatedAt: now,
  }]));
  const base = {
    schemaVersion: 1,
    kind: 'RollbackRun',
    id: `rollback-run-${randomUUID()}`,
    projectId: plan.projectId,
    graphId: plan.graphId,
    graphFingerprint: plan.graphFingerprint,
    rollbackPlanId: plan.id,
    rollbackPlanFingerprint: plan.fingerprint,
    approvalId: approval.id,
    approvalFingerprint: approval.fingerprint,
    revision: 1,
    databaseRuntimeProfileId: databaseRuntimeProfile?.id || '',
    databaseRuntimeProfileFingerprint: databaseRuntimeProfile?.fingerprint || '',
    status: summarizeRollbackRun(stepStates),
    stepStates,
    providerMutationsExecuted: 0,
    databaseMutationsExecuted: 0,
    createdAt: now,
    updatedAt: now,
  };
  const run = { ...base, fingerprint: rollbackRunFingerprint(base) };
  validateRollbackRun(run, { plan, approval });
  return run;
}

function ensureStepRunning(run, stepId, now) {
  const current = run.stepStates[stepId];
  if (current.status === 'running') return run;
  if (!['ready', 'planned', 'failed-retryable', 'blocked'].includes(current.status)) return run;
  return transitionStep(run, stepId, 'running', { lastError: null, updatedAt: now });
}

function transitionStep(run, stepId, status, patch = {}) {
  const current = run.stepStates[stepId];
  const attempt = status === 'running' && current.status !== 'running' ? current.attempt + 1 : current.attempt;
  const stepStates = {
    ...run.stepStates,
    [stepId]: { ...current, ...patch, status, attempt },
  };
  return withRollbackFingerprint({
    ...run,
    revision: run.revision + 1,
    status: summarizeRollbackRun(stepStates),
    stepStates,
    updatedAt: patch.updatedAt || run.updatedAt,
  });
}

function patchRollbackRun(run, patch) {
  const next = {
    ...run,
    ...patch,
    revision: run.revision + 1,
  };
  next.status = summarizeRollbackRun(next.stepStates);
  return withRollbackFingerprint(next);
}

function failDnsStep(run, receipt, now, forceTerminal = false) {
  const retryable = !forceTerminal && receipt.result?.error?.retryable === true;
  return transitionStep(run, 'dns.restore', retryable ? 'failed-retryable' : 'failed-terminal', {
    resultRef: receipt.file,
    lastError: { code: receipt.result?.error?.code || 'ROLLBACK_FAILED', retryable },
    updatedAt: now,
  });
}

function summarizeRollbackRun(states) {
  const dns = states['dns.restore'];
  if (!dns) return 'failed-terminal';
  if (dns.status === 'running') return 'running';
  if (dns.status === 'failed-retryable') return 'failed-retryable';
  if (dns.status === 'failed-terminal' || dns.status === 'blocked') return 'failed-terminal';
  if (dns.status === 'ready' || dns.status === 'planned') return 'ready';
  const verification = states['verification.repeat'];
  const database = states['database.rollback'];
  if (dns.status === 'succeeded' && verification?.status === 'succeeded' && TERMINAL.has(database?.status)) return 'succeeded';
  if (dns.status === 'succeeded') return 'partially-succeeded';
  return 'ready';
}

function validateStepState(value, id, issues) {
  exactKeys(value, STEP_KEYS, `stepStates.${id}`, issues);
  if (!['planned', 'ready', 'running', 'succeeded', 'blocked', 'not-required', 'failed-retryable', 'failed-terminal'].includes(value?.status) ||
    !Number.isInteger(value?.attempt) || value.attempt < 0 || value.attempt > 3 ||
    (value?.resultRef !== null && typeof value.resultRef !== 'string') || !isDate(value?.updatedAt)) issues.push(`stepStates.${id}`);
  if (value?.lastError !== null) {
    exactKeys(value?.lastError, ['code', 'retryable'], `stepStates.${id}.lastError`, issues);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value?.lastError?.code || '') || typeof value?.lastError?.retryable !== 'boolean') issues.push(`stepStates.${id}.lastError`);
  }
}

function writeRollbackRunRevision(home, projectId, run) {
  validateRollbackRun(run, { projectId });
  const file = rollbackRevisionPath(home, projectId, run.id, run.revision);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stableStringify(existing) !== stableStringify(run)) throw operationError('CONFLICT', `Rollback Run revision already exists with different content: ${file}`);
  } else {
    writeJsonAtomic(file, run);
  }
  const currentFile = path.join(projectPath(home, projectId), 'rollback-runs', run.id, 'current.json');
  writeJsonAtomic(currentFile, run);
  return { runFile: file, currentRunFile: currentFile };
}

function writeDnsRollbackIntent(home, projectId, run, sequence, input, now) {
  const file = rollbackJournalPath(home, projectId, run.id, 'dns.restore', sequence, 'intent');
  if (fs.existsSync(file)) {
    const existing = readJournalIntent(file, run);
    if (existing.inputFingerprint !== fingerprint(input)) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Rollback Intent input no longer matches the immutable Plan.');
    }
    return { ...existing, reused: true };
  }
  const base = {
    version: 1,
    kind: 'RollbackMutationIntent',
    projectId,
    runId: run.id,
    rollbackPlanId: run.rollbackPlanId,
    rollbackPlanFingerprint: run.rollbackPlanFingerprint,
    stepId: 'dns.restore',
    sequence,
    operation: 'cloudflare.dns.execute-rollback',
    inputFingerprint: fingerprint(input),
    createdAt: now,
  };
  const intent = withJournalFingerprint(base);
  writeJsonAtomic(file, intent);
  return { ...intent, file, reused: false };
}

function writeDnsRollbackReceipt(home, projectId, run, sequence, intent, result, now) {
  const file = rollbackJournalPath(home, projectId, run.id, 'dns.restore', sequence, 'receipt');
  if (fs.existsSync(file)) throw operationError('CONFLICT', `Rollback Receipt already exists: ${file}`);
  const base = {
    version: 1,
    kind: 'RollbackActionReceipt',
    projectId,
    runId: run.id,
    rollbackPlanId: run.rollbackPlanId,
    rollbackPlanFingerprint: run.rollbackPlanFingerprint,
    stepId: 'dns.restore',
    sequence,
    intentFingerprint: intent.fingerprint,
    mutationCount: resultMutationCount(result),
    result,
    createdAt: now,
  };
  const receipt = withJournalFingerprint(base);
  writeJsonAtomic(file, receipt);
  return { ...receipt, file };
}

function writeDatabaseRollbackIntent(home, projectId, run, sequence, input, now) {
  const file = rollbackJournalPath(home, projectId, run.id, 'database.rollback', sequence, 'intent');
  if (fs.existsSync(file)) {
    const existing = readDatabaseRollbackIntent(file, run, sequence, input.strategy);
    if (existing.inputFingerprint !== fingerprint(input)) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Rollback Intent input no longer matches the immutable Plan.');
    }
    return { ...existing, reused: true };
  }
  const base = {
    version: 1,
    kind: 'RollbackMutationIntent',
    projectId,
    runId: run.id,
    rollbackPlanId: run.rollbackPlanId,
    rollbackPlanFingerprint: run.rollbackPlanFingerprint,
    stepId: 'database.rollback',
    sequence,
    operation: `database.rollback.${input.strategy}`,
    inputFingerprint: fingerprint(input),
    createdAt: now,
  };
  const intent = withJournalFingerprint(base);
  writeJsonAtomic(file, intent);
  return { ...intent, file, reused: false };
}

function writeDatabaseRollbackReceipt(home, projectId, run, sequence, intent, result, now) {
  const file = rollbackJournalPath(home, projectId, run.id, 'database.rollback', sequence, 'receipt');
  if (fs.existsSync(file)) throw operationError('CONFLICT', `Database Rollback Receipt already exists: ${file}`);
  const base = {
    version: 1,
    kind: 'RollbackActionReceipt',
    projectId,
    runId: run.id,
    rollbackPlanId: run.rollbackPlanId,
    rollbackPlanFingerprint: run.rollbackPlanFingerprint,
    stepId: 'database.rollback',
    sequence,
    intentFingerprint: intent.fingerprint,
    databaseMutationCount: resultDatabaseMutationCount(result),
    result,
    createdAt: now,
  };
  const receipt = withJournalFingerprint(base);
  writeJsonAtomic(file, receipt);
  return { ...receipt, file };
}

function readDnsRollbackReceiptIfExists(home, projectId, run, sequence, authorization) {
  const file = rollbackJournalPath(home, projectId, run.id, 'dns.restore', sequence, 'receipt');
  if (!fs.existsSync(file)) return null;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Receipt JSON is invalid: ${safeMessage(error.message)}`); }
  const intentFile = rollbackJournalPath(home, projectId, run.id, 'dns.restore', sequence, 'intent');
  const intent = readJournalIntent(intentFile, run);
  const valid = receipt?.kind === 'RollbackActionReceipt' && receipt?.version === 1 &&
    receipt.projectId === projectId && receipt.runId === run.id && receipt.rollbackPlanId === authorization.plan.id &&
    receipt.rollbackPlanFingerprint === authorization.plan.fingerprint && receipt.stepId === 'dns.restore' &&
    receipt.sequence === sequence && receipt.intentFingerprint === intent.fingerprint &&
    receipt.fingerprint === fingerprintWithoutOwn(receipt) && Number.isInteger(receipt.mutationCount) &&
    receipt.mutationCount === resultMutationCount(receipt.result);
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Receipt integrity failed: ${file}`);
  validateActionResult(receipt.result, { appId: authorization.graph.appId });
  return { ...receipt, file };
}

function readDatabaseRollbackReceiptIfExists(home, projectId, run, sequence, authorization) {
  const file = rollbackJournalPath(home, projectId, run.id, 'database.rollback', sequence, 'receipt');
  if (!fs.existsSync(file)) return null;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Rollback Receipt JSON is invalid: ${safeMessage(error.message)}`); }
  const strategy = authorization.plan.database.strategy;
  const intentFile = rollbackJournalPath(home, projectId, run.id, 'database.rollback', sequence, 'intent');
  const intent = readDatabaseRollbackIntent(intentFile, run, sequence, strategy);
  const valid = receipt?.kind === 'RollbackActionReceipt' && receipt?.version === 1 &&
    receipt.projectId === projectId && receipt.runId === run.id &&
    receipt.rollbackPlanId === authorization.plan.id &&
    receipt.rollbackPlanFingerprint === authorization.plan.fingerprint &&
    receipt.stepId === 'database.rollback' && receipt.sequence === sequence &&
    receipt.intentFingerprint === intent.fingerprint && receipt.fingerprint === fingerprintWithoutOwn(receipt) &&
    Number.isInteger(receipt.databaseMutationCount) && receipt.databaseMutationCount >= 0 &&
    receipt.databaseMutationCount <= 1 &&
    receipt.databaseMutationCount === resultDatabaseMutationCount(receipt.result);
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Rollback Receipt integrity failed: ${file}`);
  validateActionResult(receipt.result, { appId: authorization.graph.appId });
  return { ...receipt, file };
}

function readJournalIntent(file, run) {
  let intent;
  try { intent = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Intent JSON is invalid: ${safeMessage(error.message)}`); }
  const valid = intent?.kind === 'RollbackMutationIntent' && intent?.version === 1 &&
    intent.projectId === run.projectId && intent.runId === run.id && intent.rollbackPlanId === run.rollbackPlanId &&
    intent.rollbackPlanFingerprint === run.rollbackPlanFingerprint && intent.stepId === 'dns.restore' &&
    intent.sequence === 1 && intent.fingerprint === fingerprintWithoutOwn(intent);
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Intent integrity failed: ${file}`);
  return { ...intent, file };
}

function readDatabaseRollbackIntent(file, run, sequence, strategy) {
  let intent;
  try { intent = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Rollback Intent JSON is invalid: ${safeMessage(error.message)}`); }
  const valid = intent?.kind === 'RollbackMutationIntent' && intent?.version === 1 &&
    intent.projectId === run.projectId && intent.runId === run.id &&
    intent.rollbackPlanId === run.rollbackPlanId &&
    intent.rollbackPlanFingerprint === run.rollbackPlanFingerprint &&
    intent.stepId === 'database.rollback' && intent.sequence === sequence &&
    intent.operation === `database.rollback.${strategy}` &&
    intent.fingerprint === fingerprintWithoutOwn(intent);
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Rollback Intent integrity failed: ${file}`);
  return { ...intent, file };
}

function writeRouteVerificationEvidence(home, projectId, run, plan, attempt, result, now) {
  const file = path.join(
    projectPath(home, projectId), 'rollback-runs', run.id, 'evidence',
    `verification.repeat-${String(attempt).padStart(6, '0')}.json`
  );
  const base = {
    version: 1,
    kind: 'RollbackRouteVerificationEvidence',
    projectId,
    runId: run.id,
    rollbackPlanId: plan.id,
    rollbackPlanFingerprint: plan.fingerprint,
    status: result.status,
    reasonCode: result.reasonCode,
    createdAt: now,
  };
  const evidence = withJournalFingerprint(base);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stableStringify(existing) !== stableStringify(evidence)) throw operationError('CONFLICT', 'Rollback route verification evidence already differs.');
  } else writeJsonAtomic(file, evidence);
  return file;
}

function readRouteVerificationEvidence(home, projectId, run, plan, attempt) {
  const file = path.join(
    projectPath(home, projectId), 'rollback-runs', run.id, 'evidence',
    `verification.repeat-${String(attempt).padStart(6, '0')}.json`
  );
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback route verification Evidence is unreadable: ${safeMessage(error.message)}`);
  }
  const valid = evidence?.version === 1 && evidence?.kind === 'RollbackRouteVerificationEvidence' &&
    evidence.projectId === projectId && evidence.runId === run.id && evidence.rollbackPlanId === plan.id &&
    evidence.rollbackPlanFingerprint === plan.fingerprint && evidence.status === 'passed' &&
    evidence.reasonCode === 'CHECK_PASSED' && evidence.fingerprint === fingerprintWithoutOwn(evidence) &&
    run.stepStates['verification.repeat'].resultRef === file;
  if (!valid) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback route verification Evidence integrity failed: ${file}`);
  return evidence;
}

function accountForMissingReceiptRecovery(result, intent) {
  if (!intent.reused || !result?.ok || result.status !== 'succeeded' || !result.data?.adopted || resultMutationCount(result) !== 0) {
    return result;
  }
  const recovered = {
    ...result,
    data: {
      ...result.data,
      recoveredAfterMissingReceipt: true,
      duplicateMutationPrevented: true,
      providerMutationsExecuted: 1,
    },
  };
  validateActionResult(recovered, { appId: result.appId });
  return recovered;
}

function accountForMissingDatabaseReceiptRecovery(result, intent) {
  if (!intent.reused || !result?.ok || result.status !== 'succeeded' || !result.data?.adopted ||
    resultDatabaseMutationCount(result) !== 0) {
    return result;
  }
  const recovered = {
    ...result,
    data: {
      ...result.data,
      recoveredAfterMissingReceipt: true,
      duplicateMutationPrevented: true,
      databaseMutationsExecuted: 1,
    },
  };
  validateActionResult(recovered, { appId: result.appId });
  return recovered;
}

function normalizeRouteVerification(value) {
  if (!value || typeof value !== 'object' || containsSecretLikeValue(value)) return { status: 'failed', reasonCode: 'UNSAFE_VERIFICATION_RESULT' };
  if (value.status === 'passed') return { status: 'passed', reasonCode: 'CHECK_PASSED' };
  return {
    status: 'failed',
    reasonCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(value.reasonCode || '') ? value.reasonCode : 'ROUTE_VERIFICATION_FAILED',
  };
}

function persistRollbackFact(home, projectId, plan, run, now) {
  const deployment = readExternalDeployment(home, projectId);
  const state = deployment.state;
  const next = {
    ...state,
    revision: state.revision + 1,
    updatedAt: now,
    facts: {
      ...state.facts,
      rollback: {
        observed: {
          planId: plan.id,
          planFingerprint: plan.fingerprint,
          runId: run.id,
          runRevision: run.revision,
          status: run.status,
          dnsRestored: run.stepStates['dns.restore'].status === 'succeeded',
          databaseStrategy: plan.database.strategy,
          databaseRolledBack: run.stepStates['database.rollback'].status === 'succeeded' ||
            run.stepStates['database.rollback'].status === 'not-required',
          routeVerified: run.stepStates['verification.repeat'].status === 'succeeded',
        },
        observedAt: now,
      },
    },
  };
  validateDeploymentStateV2(next, projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, next);
}

function findRollbackRunByPlan(home, projectId, planId) {
  const root = path.join(projectPath(home, projectId), 'rollback-runs');
  if (!fs.existsSync(root)) return null;
  for (const id of fs.readdirSync(root).filter((name) => RUN_ID.test(name)).sort().reverse()) {
    const run = readRollbackRun(home, projectId, id);
    if (run.rollbackPlanId === planId) return run;
  }
  return null;
}

function rollbackRunReport(operation, home, projectId, authorization, run, files, execution, repositoryGuard) {
  const failedStep = Object.entries(run.stepStates)
    .find(([, state]) => state.status === 'failed-terminal');
  const humanIntervention = failedStep
    ? {
        required: true,
        originalFailureEvidenceId: authorization.plan.trigger.evidenceId,
        originalFailureEvidenceFingerprint: authorization.plan.trigger.evidenceFingerprint,
        rollbackStepId: failedStep[0],
        rollbackErrorCode: failedStep[1].lastError?.code || 'ROLLBACK_FAILED',
        rollbackResultRef: failedStep[1].resultRef,
        instruction: '停止自动重放，保留原始生产失败与回滚失败证据，并由人工确认恢复路径。',
      }
    : null;
  return {
    kind: 'rollback-run', operation, status: run.status, home, projectId,
    plan: authorization.plan, approval: authorization.approval, run, ...files,
    humanIntervention,
    nextActions: humanIntervention ? [{
      id: 'escalate-rollback-failure',
      title: '人工接管回滚失败',
      evidenceIds: [humanIntervention.originalFailureEvidenceId],
      resultRefs: [humanIntervention.rollbackResultRef].filter(Boolean),
    }] : [],
    repositoryGuard,
    networkRequestsExecuted: execution.networkRequestsExecuted,
    providerMutationsExecuted: run.providerMutationsExecuted,
    databaseMutationsExecuted: run.databaseMutationsExecuted,
    productRepositoryChanged: false,
  };
}

function assertRollbackExecutionFlags(options, operation) {
  if (!options.execute || !options.yes || !options.allowRollbackNetwork || !options.allowProviderMutations) {
    throw operationError('APPROVAL_REQUIRED', `rollback ${operation} requires --execute --yes --allow-rollback-network --allow-provider-mutations.`);
  }
  if (operation === 'apply' && (!options.planId || !options.approvalId || options.runId)) {
    throw operationError('VALIDATION_FAILED', 'rollback apply requires a Plan and Approval and does not accept a Run ID.');
  }
  if (operation === 'resume' && !options.runId) throw operationError('VALIDATION_FAILED', 'rollback resume requires a Run ID.');
}

function resultMutationCount(result) {
  const value = result?.data?.providerMutationsExecuted;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
function resultDatabaseMutationCount(result) {
  const value = result?.data?.databaseMutationsExecuted;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
function resultNetworkRequestCount(result) {
  const value = result?.data?.networkRequestsExecuted;
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

function requiredMutationSteps(plan) {
  const steps = ['dns.restore'];
  if (['apply-down', 'restore-backup'].includes(plan.database.strategy)) steps.push('database.rollback');
  return steps;
}

function rollbackRevisionDirectory(home, projectId, runId) {
  return path.join(projectPath(home, projectId), 'rollback-runs', runId, 'revisions');
}
function rollbackRevisionPath(home, projectId, runId, revision) {
  return path.join(rollbackRevisionDirectory(home, projectId, runId), `${String(revision).padStart(6, '0')}.json`);
}
function rollbackJournalPath(home, projectId, runId, stepId, sequence, kind) {
  return path.join(projectPath(home, projectId), 'rollback-runs', runId, 'actions', stepId, `${String(sequence).padStart(6, '0')}-${kind}.json`);
}

function withRollbackFingerprint(run) {
  const value = { ...run };
  delete value.fingerprint;
  return { ...value, fingerprint: rollbackRunFingerprint(value) };
}
function withJournalFingerprint(value) { return { ...value, fingerprint: fingerprintWithoutOwn(value) }; }
function fingerprint(value) { return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`; }
function fingerprintWithoutOwn(value) {
  const copy = structuredClone(value);
  delete copy.fingerprint;
  return fingerprint(copy);
}

function exactKeys(value, keys, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  if (stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) issues.push(`${label}(fields)`);
}
function exactOneOfKeys(value, alternatives, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  const actual = stableStringify(Object.keys(value).sort());
  if (!alternatives.some((keys) => actual === stableStringify([...keys].sort()))) {
    issues.push(`${label}(fields)`);
  }
}
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'rollback run error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
