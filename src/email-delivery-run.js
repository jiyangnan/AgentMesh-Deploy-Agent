import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createResendV2AdapterFromConnection } from './adapters/resend-v2.js';
import { listConnections } from './connection-service.js';
import { withControlLockAsync } from './control-lock.js';
import { operationError } from './errors.js';
import { assertEmailDeliveryPlanCurrent } from './email-delivery-plan.js';
import { createFixedHostFetch } from './provider-http.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue, validateActionResult } from './provider-contract.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import {
  emailDeliveryApprovalStatusAt,
  requireActiveEmailDeliveryApproval,
  showEmailDeliveryApproval,
  validateEmailDeliveryApproval,
} from './email-delivery-approval.js';
import { createSecretRuntime, materializeProviderConnection } from './secret-store.js';
import { nowIso } from './utils.js';

const RUN_ID = /^email-delivery-run-[a-f0-9-]{36}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUN_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'emailDeliveryPlanId', 'emailDeliveryPlanFingerprint', 'approvalId', 'approvalFingerprint',
  'revision', 'status', 'send', 'delivery', 'providerMutationsExecuted', 'createdAt', 'updatedAt',
];
const SEND_KEYS = [
  'status', 'attempt', 'resultRef', 'lastError', 'emailId', 'adapterPlanFingerprint',
  'idempotencyKey', 'updatedAt',
];
const DELIVERY_KEYS = [
  'status', 'attempt', 'resultRef', 'lastError', 'lastEvent', 'nextPollAt', 'timeoutAt', 'updatedAt',
];
const STEP_STATUSES = new Set(['pending', 'running', 'waiting-external', 'succeeded', 'failed-retryable', 'failed-terminal']);
const RUN_STATUSES = new Set(['running', 'send-retryable', 'waiting-external', 'succeeded', 'failed-terminal']);

export async function startEmailDeliveryRun(options) {
  assertExecutionFlags(options, 'apply');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'email-delivery-apply', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const now = options.now || nowIso();
    const authorization = requireActiveEmailDeliveryApproval({
      home, projectId: project.id, approvalId: options.approvalId,
      planId: options.planId, now,
    });
    const existing = findRunForPlan(home, project.id, authorization.plan.id);
    if (existing) throw operationError('ALREADY_EXISTS', `Email Delivery Run already exists for this Plan; resume it: ${existing.id}`);
    let run = createInitialRun(project.id, authorization.plan, authorization.approval, now);
    let files = writeRunRevision(home, project.id, run);
    const execution = await executeEmailDelivery({
      ...options, home, project, authorization, run, now,
      writeRevision(next) { files = writeRunRevision(home, project.id, next); },
    });
    run = execution.run;
    const repositoryGuard = completeSourceGuard(project.source, before);
    return runReport('apply', home, project.id, authorization, run, files, execution, repositoryGuard);
  });
}

export async function resumeEmailDeliveryRun(options) {
  assertExecutionFlags(options, 'resume');
  const home = resolveDeployHome(options.home);
  return withControlLockAsync(home, `project:${options.projectId}`, 'email-delivery-resume', async () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const now = options.now || nowIso();
    let run = readEmailDeliveryRun(home, project.id, options.runId);
    const current = assertEmailDeliveryPlanCurrent({ home, projectId: project.id, planId: run.emailDeliveryPlanId });
    let shownApproval = showEmailDeliveryApproval({
      home, projectId: project.id, approvalId: run.approvalId, now,
    });
    validateEmailDeliveryApproval(shownApproval.approval, { projectId: project.id, plan: current.plan });
    if (shownApproval.approval.fingerprint !== run.approvalFingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Email Delivery Run Approval binding changed.');
    }
    validateEmailDeliveryRun(run, { projectId: project.id, plan: current.plan, approval: shownApproval.approval });
    if (run.status === 'succeeded' || run.status === 'failed-terminal') {
      const repositoryGuard = completeSourceGuard(project.source, before);
      return runReport('resume', home, project.id, { ...shownApproval, plan: current.plan }, run, runFiles(home, project.id, run), {
        networkRequestsExecuted: 0, providerMutationsExecuted: 0, reused: true,
      }, repositoryGuard);
    }
    let files = runFiles(home, project.id, run);
    if (options.approvalId && options.approvalId !== run.approvalId) {
      if (!canReauthorizePendingSend(run)) {
        throw operationError(
          'CONFLICT',
          'Email Delivery Run can only change Approval before the first send Intent is written.'
        );
      }
      const replacement = requireActiveEmailDeliveryApproval({
        home, projectId: project.id, approvalId: options.approvalId,
        planId: run.emailDeliveryPlanId, now,
      });
      run = reauthorizePendingRun(run, replacement.approval, now);
      files = writeRunRevision(home, project.id, run);
      shownApproval = replacement;
    }
    if (run.send.attempt === 0) {
      shownApproval = requireActiveEmailDeliveryApproval({
        home, projectId: project.id, approvalId: run.approvalId,
        planId: run.emailDeliveryPlanId, now,
      });
    }
    const authorization = { ...shownApproval, plan: current.plan };
    const execution = await executeEmailDelivery({
      ...options, home, project, authorization, run, now,
      writeRevision(next) { files = writeRunRevision(home, project.id, next); },
    });
    run = execution.run;
    const repositoryGuard = completeSourceGuard(project.source, before);
    return runReport('resume', home, project.id, authorization, run, files, execution, repositoryGuard);
  });
}

function canReauthorizePendingSend(run) {
  return run.send.status === 'pending' && run.send.attempt === 0 &&
    run.send.resultRef === '' && run.send.lastError === null && run.send.emailId === '' &&
    run.send.adapterPlanFingerprint === '' && run.send.idempotencyKey === '' &&
    run.providerMutationsExecuted === 0;
}

function reauthorizePendingRun(run, approval, now) {
  const base = {
    ...run,
    approvalId: approval.id,
    approvalFingerprint: approval.fingerprint,
    revision: run.revision + 1,
    updatedAt: now,
  };
  const next = { ...base, fingerprint: emailDeliveryRunFingerprint(base) };
  validateEmailDeliveryRun(next, { projectId: run.projectId, approval });
  return next;
}

export function showEmailDeliveryRun(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const run = readEmailDeliveryRun(home, project.id, options.runId);
  const current = assertEmailDeliveryPlanCurrent({ home, projectId: project.id, planId: run.emailDeliveryPlanId });
  const shownApproval = showEmailDeliveryApproval({
    home, projectId: project.id, approvalId: run.approvalId, now: options.now || nowIso(),
  });
  validateEmailDeliveryRun(run, { projectId: project.id, plan: current.plan, approval: shownApproval.approval });
  return {
    kind: 'email-delivery-run', operation: 'read', status: run.status, home,
    projectId: project.id, plan: current.plan, approval: shownApproval.approval,
    approvalStatus: shownApproval.effectiveStatus, run, ...runFiles(home, project.id, run),
    networkRequestsExecuted: 0, providerMutationsExecuted: 0,
    secretValuesExposed: false, productRepositoryChanged: false,
  };
}

export function readEmailDeliveryRun(homeInput, projectId, runId) {
  const home = resolveDeployHome(homeInput);
  if (!RUN_ID.test(runId || '')) throw operationError('VALIDATION_FAILED', 'Email Delivery Run ID is invalid.');
  const directory = revisionDirectory(home, projectId, runId);
  if (!fs.existsSync(directory)) throw operationError('NOT_FOUND', `Email Delivery Run not found: ${runId}`);
  const files = fs.readdirSync(directory).filter((name) => /^\d{6}\.json$/.test(name)).sort();
  if (files.length === 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Run has no immutable revisions: ${runId}`);
  const file = path.join(directory, files.at(-1));
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Run JSON is invalid: ${safeMessage(error.message)}`); }
  try { validateEmailDeliveryRun(run, { projectId }); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Run failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
  if (run.revision !== files.length || file !== revisionPath(home, projectId, run.id, run.revision)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Run revision sequence is invalid: ${run.id}`);
  }
  return run;
}

export function validateEmailDeliveryRun(run, expected = {}) {
  const issues = [];
  exactKeys(run, RUN_KEYS, '$', issues);
  if (run?.schemaVersion !== 1 || run?.kind !== 'EmailDeliveryRun' ||
    !RUN_ID.test(run?.id || '') || !SHA256.test(run?.fingerprint || '')) issues.push('kind|id|fingerprint');
  if (!RUN_STATUSES.has(run?.status) || !Number.isInteger(run?.revision) || run.revision < 1 ||
    !isDate(run?.createdAt) || !isDate(run?.updatedAt)) issues.push('status|revision|time');
  if (!Number.isInteger(run?.providerMutationsExecuted) || run.providerMutationsExecuted < 0 ||
    run.providerMutationsExecuted > 1) issues.push('providerMutationsExecuted');
  validateSendState(run?.send, issues);
  validateDeliveryState(run?.delivery, issues);
  if (run?.status !== summarizeRun(run)) issues.push('status(semantic)');
  if (expected.projectId && run?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.plan && (
    run?.emailDeliveryPlanId !== expected.plan.id ||
    run?.emailDeliveryPlanFingerprint !== expected.plan.fingerprint ||
    run?.graphId !== expected.plan.graphId || run?.graphFingerprint !== expected.plan.graphFingerprint
  )) issues.push('plan(binding)');
  if (expected.approval && (
    run?.approvalId !== expected.approval.id || run?.approvalFingerprint !== expected.approval.fingerprint
  )) issues.push('approval(binding)');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Email Delivery Run is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (run.fingerprint !== emailDeliveryRunFingerprint(run)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Run fingerprint mismatch: ${run.id}`);
  }
  return run;
}

export function emailDeliveryRunFingerprint(run) {
  const value = structuredClone(run);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

async function executeEmailDelivery(context) {
  let run = context.run;
  let networkRequestsExecuted = 0;
  let providerMutationsExecuted = 0;
  const runtimes = await buildRuntimes(context);

  if (run.send.status === 'running') {
    const recovered = readActionReceipt(context.home, context.project.id, run, 'send', run.send.attempt);
    if (recovered) run = applySendReceipt(run, recovered, context);
  }

  if (run.send.status !== 'succeeded') {
    if (run.send.status === 'failed-terminal' || run.send.attempt >= 3) {
      if (run.send.status !== 'failed-terminal') {
        run = transition(run, 'send', 'failed-terminal', {
          lastError: { code: 'RETRY_BUDGET_EXHAUSTED', retryable: false }, updatedAt: context.now,
        });
        context.writeRevision(run);
      }
      return { run, networkRequestsExecuted, providerMutationsExecuted };
    }
    const baseInput = adapterInput(context.authorization.plan);
    const planned = runtimes.sending.planTestEmail(baseInput);
    validateActionResult(planned, { appId: context.authorization.plan.projectId });
    if (!planned.ok || !planned.data?.planFingerprint || !planned.data?.idempotencyKey) {
      run = transition(run, 'send', 'failed-terminal', {
        lastError: actionError(planned), updatedAt: context.now,
      });
      context.writeRevision(run);
      return { run, networkRequestsExecuted, providerMutationsExecuted };
    }
    run = transition(run, 'send', 'running', {
      attempt: run.send.attempt + 1,
      adapterPlanFingerprint: planned.data.planFingerprint,
      idempotencyKey: planned.data.idempotencyKey,
      lastError: null,
      updatedAt: context.now,
    });
    context.writeRevision(run);
    const intent = writeActionIntent(context.home, context.project.id, run, 'send', run.send.attempt, {
      domainId: baseInput.domainId,
      domainName: baseInput.domainName,
      fromLocalPart: baseInput.fromLocalPart,
      recipientSecretRef: baseInput.recipientSecretRef,
      domainVerificationFingerprint: baseInput.domainVerificationFingerprint,
      adapterPlanFingerprint: planned.data.planFingerprint,
      idempotencyKey: planned.data.idempotencyKey,
    }, context.now);
    const result = await runtimes.sending.executeTestEmail({
      ...baseInput,
      execute: true,
      yes: true,
      allowProviderMutations: true,
      allowCostMutations: true,
      approvalFingerprint: context.authorization.approval.fingerprint.slice('sha256:'.length),
      planFingerprint: planned.data.planFingerprint,
    });
    networkRequestsExecuted += 1;
    providerMutationsExecuted = Math.max(providerMutationsExecuted, Number(result.data?.providerMutationsExecuted || 0));
    validateActionResult(result, { appId: context.authorization.plan.projectId });
    if (context.failAfterSendMutation) {
      throw operationError('EMAIL_DELIVERY_INTERRUPTED', 'Injected interruption after test email send and before Receipt.');
    }
    const receipt = writeActionReceipt(context.home, context.project.id, run, 'send', run.send.attempt, intent, result, context.now);
    if (context.failAfterSendReceipt) {
      throw operationError('EMAIL_DELIVERY_INTERRUPTED', 'Injected interruption after test email send Receipt.');
    }
    run = applySendReceipt(run, receipt, context);
    if (run.send.status !== 'succeeded') {
      return { run, networkRequestsExecuted, providerMutationsExecuted };
    }
  }

  if (run.delivery.status === 'running') {
    const recovered = readActionReceipt(context.home, context.project.id, run, 'delivery', run.delivery.attempt);
    if (recovered) run = applyDeliveryReceipt(run, recovered, context);
  }
  if (run.delivery.status === 'succeeded' || run.delivery.status === 'failed-terminal') {
    return { run, networkRequestsExecuted, providerMutationsExecuted };
  }
  if (Date.parse(context.now) >= Date.parse(run.delivery.timeoutAt)) {
    run = transition(run, 'delivery', 'failed-terminal', {
      lastError: { code: 'ASYNC_TIMEOUT', retryable: false }, updatedAt: context.now,
    });
    context.writeRevision(run);
    return { run, networkRequestsExecuted, providerMutationsExecuted };
  }
  if (run.delivery.nextPollAt && Date.parse(context.now) < Date.parse(run.delivery.nextPollAt)) {
    return { run, networkRequestsExecuted, providerMutationsExecuted, nextPollAt: run.delivery.nextPollAt };
  }
  run = transition(run, 'delivery', 'running', {
    attempt: run.delivery.attempt + 1,
    lastError: null,
    updatedAt: context.now,
  });
  context.writeRevision(run);
  const input = {
    ...adapterInput(context.authorization.plan),
    emailId: run.send.emailId,
    planFingerprint: run.send.adapterPlanFingerprint,
  };
  const intent = writeActionIntent(context.home, context.project.id, run, 'delivery', run.delivery.attempt, {
    emailId: input.emailId,
    adapterPlanFingerprint: input.planFingerprint,
    recipientSecretRef: input.recipientSecretRef,
  }, context.now);
  const result = await runtimes.provisioning.readTestEmail(input);
  networkRequestsExecuted += 1;
  validateActionResult(result, { appId: context.authorization.plan.projectId });
  const receipt = writeActionReceipt(context.home, context.project.id, run, 'delivery', run.delivery.attempt, intent, result, context.now);
  if (context.failAfterDeliveryReceipt) {
    throw operationError('EMAIL_DELIVERY_INTERRUPTED', 'Injected interruption after delivery query Receipt.');
  }
  run = applyDeliveryReceipt(run, receipt, context);
  return { run, networkRequestsExecuted, providerMutationsExecuted };
}

async function buildRuntimes(context) {
  const connections = listConnections({ home: context.home, projectId: context.project.id }).connections;
  const provisioning = connections.find((item) => item.id === context.authorization.plan.provisioningConnection.id);
  const sending = connections.find((item) => item.id === context.authorization.plan.sendingConnection.id);
  if (!provisioning || !sending) throw operationError('NOT_FOUND', 'Email Delivery Plan Connections are missing.');
  const secretRuntime = context.secretRuntime || createSecretRuntime({
    env: context.env,
    stores: context.secretStores,
    commandRunner: context.secretCommandRunner,
    keychainWritable: context.keychainWritable,
  });
  const [provisioningMaterialized, sendingMaterialized] = await Promise.all([
    materializeProviderConnection(provisioning, secretRuntime),
    materializeProviderConnection(sending, secretRuntime),
  ]);
  const fetchImpl = createFixedHostFetch(['api.resend.com'], context.fetchImpl || globalThis.fetch);
  const common = { secretSource: secretRuntime, httpOptions: { fetchImpl } };
  return {
    provisioning: createResendV2AdapterFromConnection(provisioningMaterialized.connection, {
      ...common, env: provisioningMaterialized.env,
      ...(context.provisioningTransport ? { transport: context.provisioningTransport } : {}),
    }),
    sending: createResendV2AdapterFromConnection(sendingMaterialized.connection, {
      ...common, env: sendingMaterialized.env,
      ...(context.sendingTransport ? { transport: context.sendingTransport } : {}),
    }),
  };
}

function createInitialRun(projectId, plan, approval, now) {
  const base = {
    schemaVersion: 1,
    kind: 'EmailDeliveryRun',
    id: `email-delivery-run-${randomUUID()}`,
    projectId,
    graphId: plan.graphId,
    graphFingerprint: plan.graphFingerprint,
    emailDeliveryPlanId: plan.id,
    emailDeliveryPlanFingerprint: plan.fingerprint,
    approvalId: approval.id,
    approvalFingerprint: approval.fingerprint,
    revision: 1,
    status: 'running',
    send: {
      status: 'pending', attempt: 0, resultRef: '', lastError: null, emailId: '',
      adapterPlanFingerprint: '', idempotencyKey: '', updatedAt: now,
    },
    delivery: {
      status: 'pending', attempt: 0, resultRef: '', lastError: null, lastEvent: '',
      nextPollAt: '', timeoutAt: addSeconds(now, plan.limits.timeoutSeconds), updatedAt: now,
    },
    providerMutationsExecuted: 0,
    createdAt: now,
    updatedAt: now,
  };
  const run = { ...base, status: summarizeRun(base) };
  return { ...run, fingerprint: emailDeliveryRunFingerprint(run) };
}

function adapterInput(plan) {
  return {
    appId: plan.projectId,
    domainId: plan.emailDomain.providerId,
    domainName: plan.emailDomain.name,
    fromLocalPart: plan.fromLocalPart,
    recipientSecretRef: plan.recipientSecretRef,
    domainVerificationFingerprint: plan.emailDomain.evidenceFingerprint.slice('sha256:'.length),
  };
}

function applySendReceipt(run, receipt, context) {
  const result = receipt.result;
  const mutations = Math.max(run.providerMutationsExecuted, Number(result.data?.providerMutationsExecuted || 0));
  if (result.ok && result.status === 'waiting-external' && result.data?.emailId) {
    return transition(run, 'send', 'succeeded', {
      resultRef: receipt.file,
      emailId: result.data.emailId,
      lastError: null,
      providerMutationsExecuted: mutations,
      updatedAt: context.now,
    }, context.writeRevision);
  }
  const status = result.status === 'failed-retryable' ? 'failed-retryable' : 'failed-terminal';
  return transition(run, 'send', status, {
    resultRef: receipt.file,
    lastError: actionError(result),
    providerMutationsExecuted: mutations,
    updatedAt: context.now,
  }, context.writeRevision);
}

function applyDeliveryReceipt(run, receipt, context) {
  const result = receipt.result;
  if (result.ok && result.status === 'succeeded') {
    return transition(run, 'delivery', 'succeeded', {
      resultRef: receipt.file, lastEvent: result.data?.lastEvent || '', lastError: null,
      nextPollAt: '', updatedAt: context.now,
    }, context.writeRevision);
  }
  if (result.ok && result.status === 'waiting-external') {
    return transition(run, 'delivery', 'waiting-external', {
      resultRef: receipt.file, lastEvent: result.data?.lastEvent || '', lastError: null,
      nextPollAt: addSeconds(context.now, context.authorization.plan.limits.minimumPollSeconds),
      updatedAt: context.now,
    }, context.writeRevision);
  }
  const retryable = result.status === 'failed-retryable' || result.error?.retryable === true;
  return transition(run, 'delivery', retryable ? 'failed-retryable' : 'failed-terminal', {
    resultRef: receipt.file, lastEvent: result.data?.lastEvent || '', lastError: actionError(result),
    nextPollAt: retryable ? addSeconds(context.now, context.authorization.plan.limits.minimumPollSeconds) : '',
    updatedAt: context.now,
  }, context.writeRevision);
}

function transition(run, step, status, changes, writeRevision) {
  const stepChanges = { ...changes };
  const providerMutationsExecuted = Object.hasOwn(stepChanges, 'providerMutationsExecuted')
    ? stepChanges.providerMutationsExecuted : run.providerMutationsExecuted;
  delete stepChanges.providerMutationsExecuted;
  const nextBase = {
    ...run,
    revision: run.revision + 1,
    [step]: { ...run[step], ...stepChanges, status },
    providerMutationsExecuted,
    updatedAt: stepChanges.updatedAt || run.updatedAt,
  };
  const next = { ...nextBase, status: summarizeRun(nextBase) };
  const withFingerprint = { ...next, fingerprint: emailDeliveryRunFingerprint(next) };
  validateEmailDeliveryRun(withFingerprint, { projectId: run.projectId });
  if (writeRevision) writeRevision(withFingerprint);
  return withFingerprint;
}

function summarizeRun(run) {
  if (run.send?.status === 'failed-terminal' || run.delivery?.status === 'failed-terminal') return 'failed-terminal';
  if (run.send?.status === 'failed-retryable') return 'send-retryable';
  if (run.delivery?.status === 'succeeded') return 'succeeded';
  if (run.send?.status === 'succeeded' && ['waiting-external', 'failed-retryable'].includes(run.delivery?.status)) return 'waiting-external';
  return 'running';
}

function validateSendState(value, issues) {
  exactKeys(value, SEND_KEYS, 'send', issues);
  if (!STEP_STATUSES.has(value?.status) || !Number.isInteger(value?.attempt) || value.attempt < 0 || value.attempt > 3 ||
    typeof value?.resultRef !== 'string' || !validError(value?.lastError) || typeof value?.emailId !== 'string' ||
    (value.adapterPlanFingerprint && !/^[a-f0-9]{64}$/.test(value.adapterPlanFingerprint)) ||
    typeof value?.idempotencyKey !== 'string' || !isDate(value?.updatedAt)) issues.push('send');
  if (value?.status === 'succeeded' && (!value.emailId || !value.resultRef || !value.adapterPlanFingerprint || !value.idempotencyKey)) issues.push('send(succeeded)');
}

function validateDeliveryState(value, issues) {
  exactKeys(value, DELIVERY_KEYS, 'delivery', issues);
  if (!STEP_STATUSES.has(value?.status) || !Number.isInteger(value?.attempt) || value.attempt < 0 || value.attempt > 100 ||
    typeof value?.resultRef !== 'string' || !validError(value?.lastError) || typeof value?.lastEvent !== 'string' ||
    typeof value?.nextPollAt !== 'string' || !isDate(value?.timeoutAt) || !isDate(value?.updatedAt) ||
    (value.nextPollAt && !isDate(value.nextPollAt))) issues.push('delivery');
  if (value?.status === 'succeeded' && (!value.resultRef || !value.lastEvent)) issues.push('delivery(succeeded)');
}

function validError(value) {
  return value === null || (value && typeof value === 'object' && typeof value.code === 'string' && typeof value.retryable === 'boolean');
}

function writeRunRevision(home, projectId, run) {
  validateEmailDeliveryRun(run, { projectId });
  const runFile = revisionPath(home, projectId, run.id, run.revision);
  if (fs.existsSync(runFile)) throw operationError('CONFLICT', `Email Delivery Run revision already exists: ${runFile}`);
  writeJsonAtomic(runFile, run);
  const currentRunFile = path.join(projectPath(home, projectId), 'email-delivery-runs', run.id, 'current.json');
  writeJsonAtomic(currentRunFile, run);
  return { runFile, currentRunFile };
}

function writeActionIntent(home, projectId, run, step, attempt, input, now) {
  if (containsSecretLikeValue(input)) throw operationError('SECRET_IN_INPUT', 'Email Delivery Intent contains a secret-like value.');
  const base = {
    schemaVersion: 1, kind: 'EmailDeliveryIntent', projectId, runId: run.id,
    runRevision: run.revision, step, attempt, emailDeliveryPlanId: run.emailDeliveryPlanId,
    emailDeliveryPlanFingerprint: run.emailDeliveryPlanFingerprint,
    approvalId: run.approvalId, approvalFingerprint: run.approvalFingerprint,
    input, createdAt: now,
  };
  const intent = { ...base, fingerprint: actionFingerprint(base) };
  const file = actionPath(home, projectId, run.id, step, attempt, 'intent');
  if (fs.existsSync(file)) {
    const existing = readActionFile(file, 'EmailDeliveryIntent');
    if (existing.fingerprint !== intent.fingerprint) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Intent changed: ${file}`);
    return { value: existing, file };
  }
  writeJsonAtomic(file, intent);
  return { value: intent, file };
}

function writeActionReceipt(home, projectId, run, step, attempt, intent, result, now) {
  validateActionResult(result, { appId: projectId });
  if (containsSecretLikeValue(result)) throw operationError('SECRET_IN_INPUT', 'Email Delivery Receipt contains a secret-like value.');
  const base = {
    schemaVersion: 1, kind: 'EmailDeliveryReceipt', projectId, runId: run.id,
    step, attempt, intentFingerprint: intent.value.fingerprint, result, createdAt: now,
  };
  const receipt = { ...base, fingerprint: actionFingerprint(base) };
  const file = actionPath(home, projectId, run.id, step, attempt, 'receipt');
  if (fs.existsSync(file)) {
    const existing = readActionFile(file, 'EmailDeliveryReceipt');
    if (existing.fingerprint !== receipt.fingerprint) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Receipt changed: ${file}`);
    return { value: existing, result: existing.result, file };
  }
  writeJsonAtomic(file, receipt);
  return { value: receipt, result, file };
}

function readActionReceipt(home, projectId, run, step, attempt) {
  if (attempt < 1) return null;
  const intentFile = actionPath(home, projectId, run.id, step, attempt, 'intent');
  const receiptFile = actionPath(home, projectId, run.id, step, attempt, 'receipt');
  if (!fs.existsSync(receiptFile)) return null;
  if (!fs.existsSync(intentFile)) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Receipt has no Intent: ${receiptFile}`);
  const intent = readActionFile(intentFile, 'EmailDeliveryIntent');
  const receipt = readActionFile(receiptFile, 'EmailDeliveryReceipt');
  if (receipt.intentFingerprint !== intent.fingerprint || receipt.runId !== run.id || receipt.step !== step || receipt.attempt !== attempt) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Receipt binding is invalid: ${receiptFile}`);
  }
  validateActionResult(receipt.result, { appId: projectId });
  return { value: receipt, result: receipt.result, file: receiptFile };
}

function readActionFile(file, kind) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `${kind} JSON is invalid: ${safeMessage(error.message)}`); }
  const fingerprint = value.fingerprint;
  const copy = structuredClone(value);
  delete copy.fingerprint;
  if (value.kind !== kind || fingerprint !== actionFingerprint(copy) || containsSecretLikeValue(value)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `${kind} failed integrity validation: ${file}`);
  }
  return value;
}

function actionPath(home, projectId, runId, step, attempt, type) {
  return path.join(projectPath(home, projectId), 'email-delivery-runs', runId, 'actions', step, `${String(attempt).padStart(6, '0')}-${type}.json`);
}

function actionFingerprint(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function findRunForPlan(home, projectId, planId) {
  const root = path.join(projectPath(home, projectId), 'email-delivery-runs');
  if (!fs.existsSync(root)) return null;
  for (const name of fs.readdirSync(root).sort()) {
    if (!RUN_ID.test(name)) continue;
    const run = readEmailDeliveryRun(home, projectId, name);
    if (run.emailDeliveryPlanId === planId) return run;
  }
  return null;
}

function revisionDirectory(home, projectId, runId) {
  return path.join(projectPath(home, projectId), 'email-delivery-runs', runId, 'revisions');
}

function revisionPath(home, projectId, runId, revision) {
  return path.join(revisionDirectory(home, projectId, runId), `${String(revision).padStart(6, '0')}.json`);
}

function runFiles(home, projectId, run) {
  return {
    runFile: revisionPath(home, projectId, run.id, run.revision),
    currentRunFile: path.join(projectPath(home, projectId), 'email-delivery-runs', run.id, 'current.json'),
  };
}

function runReport(operation, home, projectId, authorization, run, files, execution, repositoryGuard) {
  return {
    kind: 'email-delivery-run', operation, status: run.status, home, projectId,
    plan: authorization.plan, approval: authorization.approval,
    approvalStatus: authorization.effectiveStatus ||
      emailDeliveryApprovalStatusAt(home, projectId, authorization.approval, run.updatedAt),
    run, ...files, repositoryGuard,
    networkRequestsExecuted: execution.networkRequestsExecuted || 0,
    providerMutationsExecuted: execution.providerMutationsExecuted || 0,
    secretValuesExposed: false, productRepositoryChanged: false,
    reused: execution.reused === true,
    ...(execution.nextPollAt ? { nextPollAt: execution.nextPollAt } : {}),
  };
}

function assertExecutionFlags(options, action) {
  if (!options.execute || !options.yes || !options.allowNetwork ||
    !options.allowProviderMutations || !options.allowCostMutations) {
    throw operationError('APPROVAL_REQUIRED', `Email Delivery ${action} requires execute, yes, network, provider-mutation, and cost-mutation authorization.`);
  }
}

function actionError(result) {
  return {
    code: String(result?.error?.code || 'EMAIL_DELIVERY_FAILED'),
    retryable: result?.error?.retryable === true,
  };
}

function addSeconds(value, seconds) {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function exactKeys(value, keys, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  if (stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) issues.push(`${label}(fields)`);
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'email delivery run error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
