import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { listAdapterActionReceipts } from './adapter-graph-executor.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { readLaunchRun } from './launch-run.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue } from './provider-contract.js';
import { showProviderAcceptanceSuite } from './provider-acceptance-suite.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^cleanup-plan-[a-f0-9]{24}$/;
const ATTESTATION_ID = /^cleanup-attestation-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DISPOSITION_STATUSES = new Set(['deleted', 'restored', 'retained', 'paused', 'no-action-required']);

export function createAcceptanceCleanupPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const suite = showProviderAcceptanceSuite({
    home, projectId: project.id, suiteId: options.suiteId,
  }).suite;
  const inventory = deriveCleanupInventory(home, project, suite);
  const createdAt = options.now || nowIso();
  const cleanupDeadline = normalizeFutureDate(options.cleanupDeadline, createdAt, 'cleanup deadline');
  const cleanupOwner = normalizeActor(options.cleanupOwner, 'cleanup owner');
  const base = {
    schemaVersion: 1,
    kind: 'AcceptanceCleanupPlan',
    projectId: project.id,
    sourceCommit: project.source.commit,
    acceptanceSuiteId: suite.id,
    acceptanceSuiteFingerprint: suite.fingerprint,
    cleanupOwner,
    cleanupDeadline,
    resources: inventory.resources,
    unresolvedMutations: inventory.unresolvedMutations,
    providerMutationCount: inventory.providerMutationCount,
    status: inventory.resources.length + inventory.unresolvedMutations.length > 0
      ? 'pending-human'
      : 'no-cleanup-evidence',
    createdAt,
  };
  const fingerprint = cleanupFingerprint(base);
  let plan = {
    ...base,
    id: `cleanup-plan-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  validateAcceptanceCleanupPlan(plan, { project, suite, inventory });
  const result = withControlLock(home, `project:${project.id}`, 'acceptance-cleanup-plan-create', () => {
    const directory = cleanupDirectory(home, project.id, 'plans');
    const planFile = path.join(directory, `${plan.id}.json`);
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readCleanupPlan(planFile, { project, suite, inventory });
      if (existing.fingerprint !== plan.fingerprint) {
        throw operationError('CONFLICT', `Acceptance Cleanup Plan ID collision: ${plan.id}`);
      }
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    return { plan, planFile, reused };
  });
  return cleanupReport('create-plan', home, project, result, completeSourceGuard(project.source, before));
}

export function showAcceptanceCleanupPlan(options) {
  const context = loadPlanContext(options);
  return cleanupReport('show-plan', context.home, context.project, {
    plan: context.plan, planFile: context.planFile, reused: false,
  });
}

export function createAcceptanceCleanupAttestation(options) {
  if (options.yes !== true) {
    throw operationError('APPROVAL_REQUIRED', 'Acceptance cleanup attestation requires --yes.');
  }
  const context = loadPlanContext(options);
  const before = captureSourceGuard(context.project.source);
  const actor = normalizeActor(options.actor, 'attestation actor');
  const createdAt = options.now || nowIso();
  if (!isDate(createdAt) || Date.parse(createdAt) < Date.parse(context.plan.createdAt)) {
    throw operationError('VALIDATION_FAILED', 'Cleanup attestation creation time cannot precede its Plan.');
  }
  const dispositions = normalizeDispositions(options.dispositions, context.plan, createdAt);
  const base = {
    schemaVersion: 1,
    kind: 'AcceptanceCleanupAttestation',
    projectId: context.project.id,
    sourceCommit: context.project.source.commit,
    cleanupPlanId: context.plan.id,
    cleanupPlanFingerprint: context.plan.fingerprint,
    actor,
    verificationBasis: 'human-attestation',
    dispositions,
    status: 'completed',
    createdAt,
  };
  const fingerprint = cleanupFingerprint(base);
  let attestation = {
    ...base,
    id: `cleanup-attestation-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  validateAcceptanceCleanupAttestation(attestation, { project: context.project, plan: context.plan });
  const result = withControlLock(
    context.home, `project:${context.project.id}`, 'acceptance-cleanup-attestation-create', () => {
      const directory = cleanupDirectory(context.home, context.project.id, 'attestations');
      const attestationFile = path.join(directory, `${attestation.id}.json`);
      let reused = false;
      if (fs.existsSync(attestationFile)) {
        const existing = readAttestation(attestationFile, { project: context.project, plan: context.plan });
        if (existing.fingerprint !== attestation.fingerprint) {
          throw operationError('CONFLICT', `Acceptance Cleanup Attestation ID collision: ${attestation.id}`);
        }
        attestation = existing;
        reused = true;
      } else {
        writeJsonAtomic(attestationFile, attestation);
      }
      return { attestation, attestationFile, plan: context.plan, planFile: context.planFile, reused };
    }
  );
  return cleanupReport(
    'attest', context.home, context.project, result,
    completeSourceGuard(context.project.source, before)
  );
}

export function showAcceptanceCleanupAttestation(options) {
  const context = loadPlanContext(options);
  if (!ATTESTATION_ID.test(options.attestationId || '')) {
    throw operationError('VALIDATION_FAILED', 'Acceptance Cleanup Attestation ID is invalid.');
  }
  const attestationFile = path.join(
    cleanupDirectory(context.home, context.project.id, 'attestations'), `${options.attestationId}.json`
  );
  if (!fs.existsSync(attestationFile)) {
    throw operationError('NOT_FOUND', `Acceptance Cleanup Attestation not found: ${options.attestationId}`);
  }
  const attestation = readAttestation(attestationFile, { project: context.project, plan: context.plan });
  return cleanupReport('show-attestation', context.home, context.project, {
    plan: context.plan,
    planFile: context.planFile,
    attestation,
    attestationFile,
    reused: false,
  });
}

export function readCleanupDispositionSpecFile(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Cleanup disposition spec JSON is invalid: ${error.message}`); }
  exactKeysOrThrow(value, ['dispositions'], 'cleanup disposition spec');
  if (!Array.isArray(value.dispositions)) {
    throw operationError('VALIDATION_FAILED', 'Cleanup disposition spec requires a dispositions array.');
  }
  return value;
}

export function deriveCleanupInventory(home, project, suite) {
  const resources = new Map();
  const unresolved = [];
  for (const source of suite.sources) {
    const run = readLaunchRun(home, project.id, source.runId);
    const plan = showAdapterExecutionPlan({
      home, projectId: project.id, graphId: source.graphId, planId: source.adapterPlanId,
    }).plan;
    if (run.fingerprint !== source.runFingerprint || plan.fingerprint !== source.adapterPlanFingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Cleanup source drifted after acceptance: ${source.runId}`);
    }
    for (const receipt of listAdapterActionReceipts(home, project.id, run.id, plan)) {
      if (receipt.mutationCount < 1) continue;
      const candidates = extractReceiptResources(receipt);
      if (candidates.length === 0) {
        unresolved.push(normalizeUnresolvedMutation(receipt, receipt.mutationCount));
        continue;
      }
      const allocatedMutations = candidates.reduce((sum, candidate) => sum + candidate.mutationCount, 0);
      if (allocatedMutations > receipt.mutationCount) {
        throw operationError('PROVIDER_RESPONSE_INVALID', `Cleanup resource extraction exceeds Receipt mutation count: ${receipt.actionId}`);
      }
      for (const candidate of candidates) {
        const key = `${candidate.provider}:${candidate.providerId}:${candidate.type}`;
        const sourceReceipt = receiptSource(receipt, candidate.mutationCount);
        if (!resources.has(key)) {
          resources.set(key, normalizeCleanupResource(candidate, sourceReceipt));
        } else {
          const current = resources.get(key);
          current.sourceReceipts = uniqueReceiptSources([...current.sourceReceipts, sourceReceipt]);
          current.mutationCount = current.sourceReceipts.reduce((sum, item) => sum + item.mutationCount, 0);
          current.requiredDisposition = strongestDisposition(current.requiredDisposition, candidate.requiredDisposition);
          current.lifecycle = strongestLifecycle(current.lifecycle, candidate.lifecycle);
        }
      }
      if (allocatedMutations < receipt.mutationCount) {
        unresolved.push(normalizeUnresolvedMutation(receipt, receipt.mutationCount - allocatedMutations));
      }
    }
  }
  return {
    resources: [...resources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    unresolvedMutations: unresolved.sort((left, right) => left.id.localeCompare(right.id)),
    providerMutationCount: [...resources.values()].reduce((sum, item) => sum + item.mutationCount, 0) +
      unresolved.reduce((sum, item) => sum + item.mutationCount, 0),
  };
}

export function validateAcceptanceCleanupPlan(plan, expected = {}) {
  const issues = [];
  exactKeys(plan, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceCommit',
    'acceptanceSuiteId', 'acceptanceSuiteFingerprint', 'cleanupOwner', 'cleanupDeadline',
    'resources', 'unresolvedMutations', 'providerMutationCount', 'status', 'createdAt',
  ], '$', issues);
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'AcceptanceCleanupPlan') issues.push('kind|schemaVersion');
  if (!PLAN_ID.test(plan?.id || '') || !SHA256.test(plan?.fingerprint || '')) issues.push('id|fingerprint');
  if (!/^acceptance-suite-[a-f0-9]{24}$/.test(plan?.acceptanceSuiteId || '') ||
      !SHA256.test(plan?.acceptanceSuiteFingerprint || '') ||
      !/^[a-f0-9]{40,64}$/.test(plan?.sourceCommit || '') || !isLabel(plan?.projectId)) issues.push('bindings');
  if (!Array.isArray(plan?.resources) || !Array.isArray(plan?.unresolvedMutations)) issues.push('inventory');
  (plan?.resources || []).forEach((item, index) => validateResource(item, `resources[${index}]`, issues));
  (plan?.unresolvedMutations || []).forEach((item, index) => validateUnresolved(item, `unresolvedMutations[${index}]`, issues));
  const derivedMutationCount = (plan?.resources || []).reduce((sum, item) => sum + (item.mutationCount || 0), 0) +
    (plan?.unresolvedMutations || []).reduce((sum, item) => sum + (item.mutationCount || 0), 0);
  if (!Number.isInteger(plan?.providerMutationCount) || plan.providerMutationCount < 0 ||
      plan.providerMutationCount !== derivedMutationCount) issues.push('providerMutationCount');
  if (!['pending-human', 'no-cleanup-evidence'].includes(plan?.status) || !isDate(plan?.createdAt) ||
      !isDate(plan?.cleanupDeadline) || Date.parse(plan.cleanupDeadline) <= Date.parse(plan.createdAt) ||
      !isActor(plan?.cleanupOwner)) issues.push('status|dates|owner');
  const expectedStatus = (plan?.resources?.length || 0) + (plan?.unresolvedMutations?.length || 0) > 0
    ? 'pending-human' : 'no-cleanup-evidence';
  if (plan?.status !== expectedStatus) issues.push('status.derived');
  if (expected.project && (plan?.projectId !== expected.project.id || plan?.sourceCommit !== expected.project.source.commit)) {
    issues.push('project');
  }
  if (expected.suite && (
    plan?.acceptanceSuiteId !== expected.suite.id || plan?.acceptanceSuiteFingerprint !== expected.suite.fingerprint
  )) issues.push('suite');
  if (expected.inventory && (
    stableStringify(plan?.resources) !== stableStringify(expected.inventory.resources) ||
    stableStringify(plan?.unresolvedMutations) !== stableStringify(expected.inventory.unresolvedMutations) ||
    plan?.providerMutationCount !== expected.inventory.providerMutationCount
  )) issues.push('inventory.derived');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Acceptance Cleanup Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = cleanupFingerprint(plan);
  if (plan.fingerprint !== actual || plan.id !== `cleanup-plan-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Acceptance Cleanup Plan fingerprint mismatch: ${plan.id}`);
  }
  return plan;
}

export function validateAcceptanceCleanupAttestation(attestation, expected = {}) {
  const issues = [];
  exactKeys(attestation, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceCommit',
    'cleanupPlanId', 'cleanupPlanFingerprint', 'actor', 'verificationBasis',
    'dispositions', 'status', 'createdAt',
  ], '$', issues);
  if (attestation?.schemaVersion !== 1 || attestation?.kind !== 'AcceptanceCleanupAttestation') issues.push('kind|schemaVersion');
  if (!ATTESTATION_ID.test(attestation?.id || '') || !SHA256.test(attestation?.fingerprint || '')) issues.push('id|fingerprint');
  if (!isActor(attestation?.actor) || attestation?.verificationBasis !== 'human-attestation' ||
      attestation?.status !== 'completed' || !isDate(attestation?.createdAt)) issues.push('attestation');
  if (!Array.isArray(attestation?.dispositions)) issues.push('dispositions');
  (attestation?.dispositions || []).forEach((item, index) => validateDisposition(item, `dispositions[${index}]`, issues));
  if (expected.project && (
    attestation?.projectId !== expected.project.id || attestation?.sourceCommit !== expected.project.source.commit
  )) issues.push('project');
  if (expected.plan && (
    attestation?.cleanupPlanId !== expected.plan.id || attestation?.cleanupPlanFingerprint !== expected.plan.fingerprint
  )) issues.push('plan');
  if (expected.plan) {
    try {
      const normalized = normalizeDispositions(attestation?.dispositions, expected.plan, attestation?.createdAt);
      if (stableStringify(normalized) !== stableStringify(attestation.dispositions)) issues.push('dispositions.derived');
    } catch { issues.push('dispositions.coverage'); }
  }
  if (containsSecretLikeValue(attestation?.dispositions || [])) issues.push('dispositions.secret');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Acceptance Cleanup Attestation is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = cleanupFingerprint(attestation);
  if (attestation.fingerprint !== actual || attestation.id !== `cleanup-attestation-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Acceptance Cleanup Attestation fingerprint mismatch: ${attestation.id}`);
  }
  return attestation;
}

function loadPlanContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  if (!PLAN_ID.test(options.planId || '')) {
    throw operationError('VALIDATION_FAILED', 'Acceptance Cleanup Plan ID is invalid.');
  }
  const planFile = path.join(cleanupDirectory(home, project.id, 'plans'), `${options.planId}.json`);
  if (!fs.existsSync(planFile)) throw operationError('NOT_FOUND', `Acceptance Cleanup Plan not found: ${options.planId}`);
  let shell;
  try { shell = JSON.parse(fs.readFileSync(planFile, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Acceptance Cleanup Plan JSON is invalid: ${error.message}`); }
  const suite = showProviderAcceptanceSuite({ home, projectId: project.id, suiteId: shell.acceptanceSuiteId }).suite;
  const inventory = deriveCleanupInventory(home, project, suite);
  const plan = validateAcceptanceCleanupPlan(shell, { project, suite, inventory });
  return { home, project, suite, inventory, plan, planFile };
}

function readCleanupPlan(file, expected) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Acceptance Cleanup Plan JSON is invalid: ${error.message}`); }
  return validateAcceptanceCleanupPlan(value, expected);
}

function readAttestation(file, expected) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Acceptance Cleanup Attestation JSON is invalid: ${error.message}`); }
  return validateAcceptanceCleanupAttestation(value, expected);
}

export function extractReceiptResources(receipt) {
  const data = receipt.result?.data || {};
  const output = [];
  if (isResource(data.resource)) {
    output.push(resourceCandidate(receipt, data.resource, {
      created: data.created === true,
      adopted: data.adopted === true,
    }));
  }
  if (data.deployment && safeId(data.deployment.id || data.deployment.uid)) {
    output.push(resourceCandidate(receipt, {
      providerId: String(data.deployment.id || data.deployment.uid),
      type: 'candidate.deployment',
      name: String(data.deployment.name || data.deployment.url || data.deployment.id || ''),
      lifecycle: data.created === false ? 'adopted' : 'managed',
    }, { created: data.created !== false, adopted: data.created === false }));
  }
  if (data.apiKey && safeId(data.apiKey.id)) {
    output.push(resourceCandidate(receipt, {
      providerId: String(data.apiKey.id), type: 'email.api-key',
      name: String(data.apiKey.name || data.apiKey.id), lifecycle: data.created === false ? 'adopted' : 'managed',
    }, { created: data.created !== false, adopted: data.created === false }));
  }
  for (const applied of Array.isArray(data.applied) ? data.applied : []) {
    if (!safeId(applied?.record?.id)) continue;
    output.push(resourceCandidate(receipt, {
      providerId: String(applied.record.id), type: 'dns.record',
      name: String(applied.record.name || applied.desiredId || applied.record.id),
      lifecycle: applied.mode === 'create' ? 'managed' : 'adopted',
    }, {
      created: applied.mode === 'create', adopted: applied.mode !== 'create',
      requiredDisposition: applied.mode === 'create' ? 'delete-or-retain' : 'restore-or-retain',
      mutationCount: 1,
    }));
  }
  return output.filter((item, index, all) =>
    all.findIndex((candidate) => `${candidate.provider}:${candidate.providerId}:${candidate.type}` ===
      `${item.provider}:${item.providerId}:${item.type}`) === index
  );
}

function resourceCandidate(receipt, resource, flags = {}) {
  const lifecycle = flags.created || resource.lifecycle === 'managed'
    ? 'managed'
    : flags.adopted || resource.lifecycle === 'adopted' || resource.lifecycle === 'external'
      ? 'adopted'
      : 'unknown';
  return {
    provider: receipt.provider,
    providerId: String(resource.providerId || resource.id || ''),
    type: normalizeLabel(resource.type || `${receipt.provider}.resource`, 'resource type'),
    name: normalizeLabel(resource.name || resource.providerId || resource.id, 'resource name'),
    lifecycle,
    requiredDisposition: flags.requiredDisposition || (lifecycle === 'managed' ? 'delete-or-retain' : 'review-only'),
    costClass: potentialRecurringCost(receipt.provider, resource.type) ? 'potential-recurring' : 'unknown',
    mutationCount: flags.mutationCount || receipt.mutationCount,
  };
}

function normalizeCleanupResource(candidate, sourceReceipt) {
  const identity = `${candidate.provider}:${candidate.providerId}:${candidate.type}`;
  return {
    id: `cleanup-item-${hash(identity).slice(0, 24)}`,
    provider: candidate.provider,
    providerId: candidate.providerId,
    type: candidate.type,
    name: candidate.name,
    lifecycle: candidate.lifecycle,
    requiredDisposition: candidate.requiredDisposition,
    costClass: candidate.costClass,
    mutationCount: sourceReceipt.mutationCount,
    sourceReceipts: [sourceReceipt],
  };
}

function normalizeUnresolvedMutation(receipt, mutationCount) {
  return {
    id: `cleanup-unresolved-${hash(`${receipt.runId}:${receipt.actionId}:${receipt.sequence}:${mutationCount}`).slice(0, 24)}`,
    provider: receipt.provider,
    actionId: receipt.actionId,
    method: receipt.method,
    mutationCount,
    receiptFingerprint: receipt.fingerprint,
    reason: 'provider-mutation-without-normalized-resource',
  };
}

function receiptSource(receipt, mutationCount = receipt.mutationCount) {
  return {
    runId: receipt.runId,
    actionId: receipt.actionId,
    method: receipt.method,
    receiptFingerprint: receipt.fingerprint,
    mutationCount,
  };
}

function normalizeDispositions(values, plan, createdAt) {
  if (!Array.isArray(values)) throw operationError('VALIDATION_FAILED', 'Cleanup dispositions must be an array.');
  const requiredIds = [...plan.resources, ...plan.unresolvedMutations].map((item) => item.id).sort();
  const byId = new Map();
  for (const raw of values) {
    exactKeysOrThrow(raw, ['itemId', 'status', 'reason', 'verifiedAt', 'costStoppedAt'], 'cleanup disposition');
    const itemId = String(raw.itemId || '');
    if (byId.has(itemId) || !requiredIds.includes(itemId)) {
      throw operationError('VALIDATION_FAILED', `Cleanup disposition item is duplicate or unknown: ${itemId}`);
    }
    const status = String(raw.status || '');
    if (!DISPOSITION_STATUSES.has(status)) throw operationError('VALIDATION_FAILED', `Cleanup disposition status is invalid: ${itemId}`);
    const reason = normalizeReason(raw.reason);
    const verifiedAt = normalizePastOrPresentDate(raw.verifiedAt, createdAt, 'verifiedAt');
    const costStoppedAt = raw.costStoppedAt
      ? normalizePastOrPresentDate(raw.costStoppedAt, createdAt, 'costStoppedAt')
      : '';
    if (Date.parse(verifiedAt) < Date.parse(plan.createdAt) ||
        (costStoppedAt && Date.parse(costStoppedAt) < Date.parse(plan.createdAt))) {
      throw operationError('VALIDATION_FAILED', `Cleanup disposition time cannot precede its Plan: ${itemId}`);
    }
    const resource = plan.resources.find((item) => item.id === itemId);
    if (resource?.costClass === 'potential-recurring' && ['deleted', 'restored', 'paused'].includes(status) && !costStoppedAt) {
      throw operationError('VALIDATION_FAILED', `Cleanup disposition requires costStoppedAt: ${itemId}`);
    }
    byId.set(itemId, { itemId, status, reason, verifiedAt, costStoppedAt });
  }
  if (byId.size !== requiredIds.length) {
    const missing = requiredIds.filter((itemId) => !byId.has(itemId));
    throw operationError('VALIDATION_FAILED', `Cleanup dispositions do not cover every item: ${missing.join(', ')}`);
  }
  const normalized = [...byId.values()].sort((left, right) => left.itemId.localeCompare(right.itemId));
  if (containsSecretLikeValue(normalized)) throw operationError('VALIDATION_FAILED', 'Cleanup dispositions contain a secret-like value.');
  return normalized;
}

function validateResource(item, label, issues) {
  exactKeys(item, [
    'id', 'provider', 'providerId', 'type', 'name', 'lifecycle', 'requiredDisposition',
    'costClass', 'mutationCount', 'sourceReceipts',
  ], label, issues);
  if (!/^cleanup-item-[a-f0-9]{24}$/.test(item?.id || '') || !safeId(item?.providerId) ||
      !isLabel(item?.provider) || !isLabel(item?.type) || !isLabel(item?.name) ||
      !['managed', 'adopted', 'unknown'].includes(item?.lifecycle) ||
      !['delete-or-retain', 'restore-or-retain', 'review-only'].includes(item?.requiredDisposition) ||
      !['potential-recurring', 'unknown'].includes(item?.costClass) ||
      !Number.isInteger(item?.mutationCount) || item.mutationCount < 1 || !Array.isArray(item?.sourceReceipts)) {
    issues.push(label);
  }
  (item?.sourceReceipts || []).forEach((source, index) => validateReceiptSource(source, `${label}.sourceReceipts[${index}]`, issues));
  const identity = `${item?.provider}:${item?.providerId}:${item?.type}`;
  if (item?.id !== `cleanup-item-${hash(identity).slice(0, 24)}`) issues.push(`${label}.id`);
  if ((item?.sourceReceipts || []).reduce((sum, source) => sum + source.mutationCount, 0) !== item?.mutationCount) {
    issues.push(`${label}.mutationCount`);
  }
}

function validateUnresolved(item, label, issues) {
  exactKeys(item, ['id', 'provider', 'actionId', 'method', 'mutationCount', 'receiptFingerprint', 'reason'], label, issues);
  if (!/^cleanup-unresolved-[a-f0-9]{24}$/.test(item?.id || '') || !isLabel(item?.provider) ||
      !isLabel(item?.actionId) || !isLabel(item?.method) || !Number.isInteger(item?.mutationCount) ||
      item.mutationCount < 1 || !SHA256.test(item?.receiptFingerprint || '') ||
      item?.reason !== 'provider-mutation-without-normalized-resource') issues.push(label);
}

function validateReceiptSource(item, label, issues) {
  exactKeys(item, ['runId', 'actionId', 'method', 'receiptFingerprint', 'mutationCount'], label, issues);
  if (!isLabel(item?.runId) || !isLabel(item?.actionId) || !isLabel(item?.method) ||
      !SHA256.test(item?.receiptFingerprint || '') || !Number.isInteger(item?.mutationCount) || item.mutationCount < 1) issues.push(label);
}

function validateDisposition(item, label, issues) {
  exactKeys(item, ['itemId', 'status', 'reason', 'verifiedAt', 'costStoppedAt'], label, issues);
  if (!/^(?:cleanup-item|cleanup-unresolved)-[a-f0-9]{24}$/.test(item?.itemId || '') ||
      !DISPOSITION_STATUSES.has(item?.status) || !isReason(item?.reason) || !isDate(item?.verifiedAt) ||
      !(item?.costStoppedAt === '' || isDate(item?.costStoppedAt))) issues.push(label);
}

function cleanupReport(operation, home, project, result, repositoryGuard = undefined) {
  return {
    kind: 'acceptance-cleanup', operation,
    status: result.attestation?.status || result.plan.status,
    home, projectId: project.id, ...result,
    ...(repositoryGuard ? { repositoryGuard } : {}),
    networkRequestsExecuted: 0,
    providerMutationsExecuted: 0,
    providerDeletesExecuted: 0,
    secretValuesExposed: false,
    productRepositoryChanged: false,
  };
}

function cleanupDirectory(home, projectId, child) {
  return path.join(projectPath(home, projectId), 'acceptance-cleanup', child);
}

function cleanupFingerprint(value) {
  const copy = structuredClone(value);
  delete copy.id;
  delete copy.fingerprint;
  return `sha256:${hash(stableStringify(copy))}`;
}

function potentialRecurringCost(provider, type) {
  return ['neon', 'railway', 'supabase', 'vercel'].includes(provider) &&
    /(?:project|service|environment|deployment|backup|database|runtime)/i.test(String(type || ''));
}

function strongestDisposition(left, right) {
  const rank = { 'review-only': 0, 'restore-or-retain': 1, 'delete-or-retain': 2 };
  return rank[right] > rank[left] ? right : left;
}

function strongestLifecycle(left, right) {
  const rank = { unknown: 0, adopted: 1, managed: 2 };
  return rank[right] > rank[left] ? right : left;
}

function uniqueReceiptSources(values) {
  const byFingerprint = new Map(values.map((item) => [item.receiptFingerprint, item]));
  return [...byFingerprint.values()].sort((left, right) => left.receiptFingerprint.localeCompare(right.receiptFingerprint));
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issues.push(label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${label}.unsupported(${key})`);
  for (const key of allowed) if (!(key in value)) issues.push(`${label}.missing(${key})`);
}

function exactKeysOrThrow(value, allowed, label) {
  const issues = [];
  exactKeys(value, allowed, label, issues);
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `${label} is invalid at: ${issues.join(', ')}`);
}

function normalizeActor(value, label) {
  const actor = String(value || '').trim();
  if (!isActor(actor)) throw operationError('VALIDATION_FAILED', `${label} is invalid.`);
  return actor;
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  if (!isReason(reason)) throw operationError('VALIDATION_FAILED', 'Cleanup disposition reason is required and must be at most 300 characters.');
  return reason;
}

function normalizeLabel(value, label) {
  const output = String(value || '').trim();
  if (!isLabel(output)) throw operationError('PROVIDER_RESPONSE_INVALID', `Cleanup ${label} is invalid.`);
  return output;
}

function normalizeFutureDate(value, now, label) {
  if (!isDate(value) || Date.parse(value) <= Date.parse(now)) {
    throw operationError('VALIDATION_FAILED', `${label} must be after the creation time.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizePastOrPresentDate(value, now, label) {
  if (!isDate(value) || Date.parse(value) > Date.parse(now)) {
    throw operationError('VALIDATION_FAILED', `${label} must be a valid time no later than attestation creation.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isActor(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value); }
function isLabel(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value); }
function isReason(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value); }
function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:@/-]+$/.test(value); }
function isResource(value) { return value && typeof value === 'object' && safeId(String(value.providerId || value.id || '')); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
