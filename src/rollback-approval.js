import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { assertRollbackPlanCurrent, showRollbackPlan } from './rollback-plan.js';
import { nowIso } from './utils.js';

const APPROVAL_ID = /^rollback-approval-[a-f0-9-]{36}$/;
const PLAN_ID = /^rollback-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const APPROVAL_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'rollbackPlanId', 'rollbackPlanFingerprint', 'stepIds', 'decision', 'limits',
  'approvedBy', 'approvedAt', 'expiresAt',
];
const REVOCATION_KEYS = [
  'schemaVersion', 'kind', 'fingerprint', 'projectId', 'graphFingerprint', 'rollbackPlanId',
  'rollbackPlanFingerprint', 'approvalId', 'approvalFingerprint', 'revokedBy', 'revokedAt',
];

export function createRollbackApproval(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Creating a Rollback Approval requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'rollback-approval-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const current = assertRollbackPlanCurrent({
      home, projectId: project.id, graphId: options.graphId,
      configurationId: options.configurationId, planId: options.planId,
    });
    const stepIds = resolveStepIds(options.stepIds, current.plan);
    const approvedAt = options.now || nowIso();
    const expiresAt = normalizeExpiration(options.expiresAt, approvedAt);
    const base = {
      schemaVersion: 1,
      kind: 'RollbackApproval',
      id: `rollback-approval-${randomUUID()}`,
      projectId: project.id,
      graphId: current.plan.graphId,
      graphFingerprint: current.plan.graphFingerprint,
      rollbackPlanId: current.plan.id,
      rollbackPlanFingerprint: current.plan.fingerprint,
      stepIds,
      decision: 'approved',
      limits: {
        maxProviderMutations: stepIds.includes('dns.restore') ? 1 : 0,
        allowDatabaseRestore: stepIds.includes('database.rollback'),
      },
      approvedBy: safeActor(options.approvedBy || 'user'),
      approvedAt,
      expiresAt,
    };
    const approval = { ...base, fingerprint: rollbackApprovalFingerprint(base) };
    validateRollbackApproval(approval, { projectId: project.id, graph: current.graph, plan: current.plan });
    const approvalFile = rollbackApprovalPath(home, project.id, approval.id);
    writeJsonAtomic(approvalFile, approval);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'rollback-approval', operation: 'create', status: 'succeeded', home,
      projectId: project.id, approval, approvalFile, repositoryGuard,
      networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      databaseMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function listRollbackApprovals(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const directory = rollbackApprovalDirectory(home, project.id);
  const now = options.now || nowIso();
  const approvals = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((name) => /^rollback-approval-[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => readRollbackApprovalFile(path.join(directory, name), { projectId: project.id }))
        .map((approval) => ({ ...approval, effectiveStatus: rollbackApprovalStatus(home, project.id, approval, now) }))
        .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))
    : [];
  return { kind: 'rollback-approval-list', home, projectId: project.id, count: approvals.length, approvals };
}

export function showRollbackApproval(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const approvalFile = rollbackApprovalPath(home, project.id, options.approvalId);
  if (!fs.existsSync(approvalFile)) throw operationError('NOT_FOUND', `Rollback Approval not found: ${options.approvalId}`);
  const approval = readRollbackApprovalFile(approvalFile, { projectId: project.id });
  const plan = showRollbackPlan({
    home, projectId: project.id, graphId: approval.graphId,
    configurationId: options.configurationId, planId: approval.rollbackPlanId,
  }).plan;
  validateRollbackApproval(approval, { projectId: project.id, plan });
  return {
    kind: 'rollback-approval', operation: 'read', home, projectId: project.id,
    approval, approvalFile, effectiveStatus: rollbackApprovalStatus(home, project.id, approval, options.now || nowIso()),
  };
}

export function revokeRollbackApproval(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Revoking a Rollback Approval requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'rollback-approval-revoke', () => {
    const shown = showRollbackApproval(options);
    const revokedAt = options.now || nowIso();
    const revocationFile = rollbackRevocationPath(home, shown.projectId, shown.approval.id);
    let revocation;
    let reused = false;
    if (fs.existsSync(revocationFile)) {
      revocation = readRollbackRevocationFile(revocationFile, shown.approval);
      reused = true;
    } else {
      const base = {
        schemaVersion: 1,
        kind: 'RollbackApprovalRevocation',
        projectId: shown.projectId,
        graphFingerprint: shown.approval.graphFingerprint,
        rollbackPlanId: shown.approval.rollbackPlanId,
        rollbackPlanFingerprint: shown.approval.rollbackPlanFingerprint,
        approvalId: shown.approval.id,
        approvalFingerprint: shown.approval.fingerprint,
        revokedBy: safeActor(options.approvedBy || 'user'),
        revokedAt,
      };
      revocation = { ...base, fingerprint: rollbackRevocationFingerprint(base) };
      validateRollbackRevocation(revocation, shown.approval);
      writeJsonAtomic(revocationFile, revocation);
    }
    return {
      kind: 'rollback-approval', operation: 'revoke', status: 'succeeded', home,
      projectId: shown.projectId, approval: shown.approval, approvalFile: shown.approvalFile,
      revocation, revocationFile, reused, networkRequestsExecuted: 0,
      providerMutationsExecuted: 0, databaseMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function requireActiveRollbackApproval(options) {
  const shown = showRollbackApproval(options);
  if (shown.effectiveStatus === 'expired') throw operationError('APPROVAL_EXPIRED', `Rollback Approval expired: ${shown.approval.id}`);
  if (shown.effectiveStatus === 'revoked') throw operationError('APPROVAL_REQUIRED', `Rollback Approval was revoked: ${shown.approval.id}`);
  const current = assertRollbackPlanCurrent({
    home: shown.home, projectId: shown.projectId, graphId: shown.approval.graphId,
    configurationId: options.configurationId, planId: shown.approval.rollbackPlanId,
  });
  validateRollbackApproval(shown.approval, { projectId: shown.projectId, graph: current.graph, plan: current.plan });
  for (const stepId of options.requiredStepIds || []) {
    if (!shown.approval.stepIds.includes(stepId)) {
      throw operationError('APPROVAL_REQUIRED', `Rollback Approval does not cover required step: ${stepId}`);
    }
  }
  return { ...shown, plan: current.plan, graph: current.graph, configuration: current.configuration };
}

export function validateRollbackApproval(approval, expected = {}) {
  const issues = [];
  exactKeys(approval, APPROVAL_KEYS, '$', issues);
  if (approval?.schemaVersion !== 1 || approval?.kind !== 'RollbackApproval') issues.push('kind|schemaVersion');
  if (!APPROVAL_ID.test(approval?.id || '') || !SHA256.test(approval?.fingerprint || '')) issues.push('id|fingerprint');
  if (!PLAN_ID.test(approval?.rollbackPlanId || '') || !SHA256.test(approval?.rollbackPlanFingerprint || '')) issues.push('plan');
  if (!Array.isArray(approval?.stepIds) || approval.stepIds.length === 0 || approval.stepIds.length > 2 ||
    new Set(approval.stepIds).size !== approval.stepIds.length || approval.stepIds.some((id) => !['dns.restore', 'database.rollback'].includes(id))) issues.push('stepIds');
  if (approval?.decision !== 'approved' || !validActor(approval?.approvedBy) || !isDate(approval?.approvedAt) || !isDate(approval?.expiresAt) ||
    Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt) || Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt) > 24 * 60 * 60 * 1000) issues.push('decision|time');
  exactKeys(approval?.limits, ['maxProviderMutations', 'allowDatabaseRestore'], 'limits', issues);
  const expectedMutations = approval?.stepIds?.includes('dns.restore') ? 1 : 0;
  const expectedDatabase = approval?.stepIds?.includes('database.rollback') || false;
  if (approval?.limits?.maxProviderMutations !== expectedMutations || approval?.limits?.allowDatabaseRestore !== expectedDatabase) issues.push('limits(semantic)');
  if (expected.projectId && approval?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.graph && (approval?.graphId !== expected.graph.id || approval?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.plan) {
    if (approval?.rollbackPlanId !== expected.plan.id || approval?.rollbackPlanFingerprint !== expected.plan.fingerprint ||
      approval?.graphId !== expected.plan.graphId || approval?.graphFingerprint !== expected.plan.graphFingerprint) issues.push('plan(binding)');
    const ready = new Set(expected.plan.steps.filter((step) => step.status === 'ready' && step.approval).map((step) => step.id));
    if ((approval?.stepIds || []).some((id) => !ready.has(id))) issues.push('stepIds(plan)');
  }
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Rollback Approval is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (approval.fingerprint !== rollbackApprovalFingerprint(approval)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval fingerprint mismatch: ${approval.id}`);
  }
  return approval;
}

export function validateRollbackRevocation(revocation, approval) {
  const issues = [];
  exactKeys(revocation, REVOCATION_KEYS, '$', issues);
  if (revocation?.schemaVersion !== 1 || revocation?.kind !== 'RollbackApprovalRevocation' || !SHA256.test(revocation?.fingerprint || '')) issues.push('kind|schemaVersion|fingerprint');
  if (approval && (
    revocation?.projectId !== approval.projectId || revocation?.graphFingerprint !== approval.graphFingerprint ||
    revocation?.rollbackPlanId !== approval.rollbackPlanId || revocation?.rollbackPlanFingerprint !== approval.rollbackPlanFingerprint ||
    revocation?.approvalId !== approval.id || revocation?.approvalFingerprint !== approval.fingerprint
  )) issues.push('approval(binding)');
  if (!validActor(revocation?.revokedBy) || !isDate(revocation?.revokedAt) ||
    (approval && Date.parse(revocation.revokedAt) < Date.parse(approval.approvedAt))) issues.push('actor|time');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Rollback Approval Revocation is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (revocation.fingerprint !== rollbackRevocationFingerprint(revocation)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval Revocation fingerprint mismatch: ${revocation.approvalId}`);
  }
  return revocation;
}

export function rollbackApprovalFingerprint(approval) {
  return fingerprintWithout(approval, ['fingerprint']);
}

export function rollbackRevocationFingerprint(revocation) {
  return fingerprintWithout(revocation, ['fingerprint']);
}

function resolveStepIds(input, plan) {
  const requested = String(input || '').split(',').map((value) => value.trim()).filter(Boolean);
  const values = [...new Set(requested)].sort();
  if (values.length === 0) throw operationError('VALIDATION_FAILED', 'Rollback Approval requires at least one --steps value.');
  const ready = new Set(plan.steps.filter((step) => step.status === 'ready' && step.approval).map((step) => step.id));
  const invalid = values.filter((id) => !ready.has(id));
  if (invalid.length > 0) throw operationError('VALIDATION_FAILED', `Rollback Approval contains blocked, non-approvable, or unknown steps: ${invalid.join(', ')}`);
  return values;
}

function normalizeExpiration(value, approvedAt) {
  if (!isDate(value)) throw operationError('VALIDATION_FAILED', '--expires-at must be a valid ISO-8601 timestamp.');
  const expiresAt = new Date(value).toISOString();
  const duration = Date.parse(expiresAt) - Date.parse(approvedAt);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000) {
    throw operationError('VALIDATION_FAILED', 'Rollback Approval expiration must be later than approval and no more than 24 hours.');
  }
  return expiresAt;
}

export function rollbackApprovalStatusAt(home, projectId, approval, now) {
  const revocationFile = rollbackRevocationPath(home, projectId, approval.id);
  if (fs.existsSync(revocationFile)) {
    const revocation = readRollbackRevocationFile(revocationFile, approval);
    if (Date.parse(revocation.revokedAt) <= Date.parse(now)) return 'revoked';
  }
  if (Date.parse(approval.expiresAt) <= Date.parse(now)) return 'expired';
  return 'active';
}

function rollbackApprovalStatus(home, projectId, approval, now) {
  return rollbackApprovalStatusAt(home, projectId, approval, now);
}

function readRollbackApprovalFile(file, expected) {
  let approval;
  try { approval = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateRollbackApproval(approval, expected); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
}

function readRollbackRevocationFile(file, approval) {
  let revocation;
  try { revocation = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval Revocation JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateRollbackRevocation(revocation, approval); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Rollback Approval Revocation failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
}

function rollbackApprovalDirectory(home, projectId) {
  return path.join(projectPath(home, projectId), 'rollback-approvals');
}

function rollbackApprovalPath(home, projectId, approvalId) {
  if (!APPROVAL_ID.test(approvalId || '')) throw operationError('VALIDATION_FAILED', 'Rollback Approval ID is invalid.');
  return path.join(rollbackApprovalDirectory(home, projectId), `${approvalId}.json`);
}

function rollbackRevocationPath(home, projectId, approvalId) {
  return path.join(rollbackApprovalDirectory(home, projectId), 'revocations', `${approvalId}.json`);
}

function fingerprintWithout(value, excluded) {
  const copy = structuredClone(value);
  for (const key of excluded) delete copy[key];
  return `sha256:${createHash('sha256').update(stableStringify(copy)).digest('hex')}`;
}

function exactKeys(value, keys, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  if (stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) issues.push(`${label}(fields)`);
}

function safeActor(value) {
  const actor = String(value || '').replace(/[\r\n]/g, ' ').slice(0, 128);
  if (!validActor(actor)) throw operationError('VALIDATION_FAILED', 'Rollback Approval actor is invalid.');
  return actor;
}

function validActor(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'rollback approval error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
