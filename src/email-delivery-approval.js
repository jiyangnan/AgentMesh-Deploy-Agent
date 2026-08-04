import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { assertEmailDeliveryPlanCurrent } from './email-delivery-plan.js';
import { operationError } from './errors.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const APPROVAL_ID = /^email-delivery-approval-[a-f0-9-]{36}$/;
const PLAN_ID = /^email-delivery-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const APPROVAL_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
  'emailDeliveryPlanId', 'emailDeliveryPlanFingerprint', 'decision', 'limits',
  'approvedBy', 'approvedAt', 'expiresAt',
];
const REVOCATION_KEYS = [
  'schemaVersion', 'kind', 'fingerprint', 'projectId', 'graphFingerprint',
  'emailDeliveryPlanId', 'emailDeliveryPlanFingerprint', 'approvalId', 'approvalFingerprint',
  'revokedBy', 'revokedAt',
];

export function createEmailDeliveryApproval(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Creating an Email Delivery Approval requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'email-delivery-approval-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const current = assertEmailDeliveryPlanCurrent({
      home, projectId: project.id, planId: options.planId,
    });
    const approvedAt = options.now || nowIso();
    const expiresAt = normalizeExpiration(options.expiresAt, approvedAt);
    const base = {
      schemaVersion: 1,
      kind: 'EmailDeliveryApproval',
      id: `email-delivery-approval-${randomUUID()}`,
      projectId: project.id,
      graphId: current.plan.graphId,
      graphFingerprint: current.plan.graphFingerprint,
      emailDeliveryPlanId: current.plan.id,
      emailDeliveryPlanFingerprint: current.plan.fingerprint,
      decision: 'approved',
      limits: { maxEmails: 1, maxRecipients: 1 },
      approvedBy: safeActor(options.approvedBy || 'user'),
      approvedAt,
      expiresAt,
    };
    const approval = { ...base, fingerprint: emailDeliveryApprovalFingerprint(base) };
    validateEmailDeliveryApproval(approval, { projectId: project.id, plan: current.plan });
    const approvalFile = emailDeliveryApprovalPath(home, project.id, approval.id);
    writeJsonAtomic(approvalFile, approval);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'email-delivery-approval', operation: 'create', status: 'succeeded', home,
      projectId: project.id, approval, approvalFile, repositoryGuard,
      networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function showEmailDeliveryApproval(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const approvalFile = emailDeliveryApprovalPath(home, project.id, options.approvalId);
  if (!fs.existsSync(approvalFile)) throw operationError('NOT_FOUND', `Email Delivery Approval not found: ${options.approvalId}`);
  const approval = readEmailDeliveryApprovalFile(approvalFile, { projectId: project.id });
  const plan = assertEmailDeliveryPlanCurrent({ home, projectId: project.id, planId: approval.emailDeliveryPlanId }).plan;
  validateEmailDeliveryApproval(approval, { projectId: project.id, plan });
  return {
    kind: 'email-delivery-approval', operation: 'read', status: 'succeeded', home,
    projectId: project.id, approval, approvalFile,
    effectiveStatus: emailDeliveryApprovalStatusAt(home, project.id, approval, options.now || nowIso()),
  };
}

export function revokeEmailDeliveryApproval(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Revoking an Email Delivery Approval requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'email-delivery-approval-revoke', () => {
    const shown = showEmailDeliveryApproval(options);
    const revokedAt = options.now || nowIso();
    const revocationFile = emailDeliveryRevocationPath(home, shown.projectId, shown.approval.id);
    let revocation;
    let reused = false;
    if (fs.existsSync(revocationFile)) {
      revocation = readEmailDeliveryRevocationFile(revocationFile, shown.approval);
      reused = true;
    } else {
      const base = {
        schemaVersion: 1,
        kind: 'EmailDeliveryApprovalRevocation',
        projectId: shown.projectId,
        graphFingerprint: shown.approval.graphFingerprint,
        emailDeliveryPlanId: shown.approval.emailDeliveryPlanId,
        emailDeliveryPlanFingerprint: shown.approval.emailDeliveryPlanFingerprint,
        approvalId: shown.approval.id,
        approvalFingerprint: shown.approval.fingerprint,
        revokedBy: safeActor(options.approvedBy || 'user'),
        revokedAt,
      };
      revocation = { ...base, fingerprint: emailDeliveryRevocationFingerprint(base) };
      validateEmailDeliveryRevocation(revocation, shown.approval);
      writeJsonAtomic(revocationFile, revocation);
    }
    return {
      kind: 'email-delivery-approval', operation: 'revoke', status: 'succeeded', home,
      projectId: shown.projectId, approval: shown.approval, approvalFile: shown.approvalFile,
      revocation, revocationFile, reused, networkRequestsExecuted: 0,
      providerMutationsExecuted: 0, secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function requireActiveEmailDeliveryApproval(options) {
  const shown = showEmailDeliveryApproval(options);
  if (shown.effectiveStatus === 'expired') throw operationError('APPROVAL_EXPIRED', `Email Delivery Approval expired: ${shown.approval.id}`);
  if (shown.effectiveStatus === 'revoked') throw operationError('APPROVAL_REQUIRED', `Email Delivery Approval was revoked: ${shown.approval.id}`);
  if (options.planId && shown.approval.emailDeliveryPlanId !== options.planId) {
    throw operationError('APPROVAL_REQUIRED', 'Email Delivery Approval does not cover the requested Plan.');
  }
  const current = assertEmailDeliveryPlanCurrent({
    home: shown.home, projectId: shown.projectId, planId: shown.approval.emailDeliveryPlanId,
  });
  validateEmailDeliveryApproval(shown.approval, { projectId: shown.projectId, plan: current.plan });
  return { ...shown, plan: current.plan };
}

export function validateEmailDeliveryApproval(approval, expected = {}) {
  const issues = [];
  exactKeys(approval, APPROVAL_KEYS, '$', issues);
  if (approval?.schemaVersion !== 1 || approval?.kind !== 'EmailDeliveryApproval' ||
    !APPROVAL_ID.test(approval?.id || '') || !SHA256.test(approval?.fingerprint || '')) issues.push('kind|id|fingerprint');
  if (!PLAN_ID.test(approval?.emailDeliveryPlanId || '') || !SHA256.test(approval?.emailDeliveryPlanFingerprint || '')) issues.push('plan');
  if (approval?.decision !== 'approved' || !validActor(approval?.approvedBy) ||
    !isDate(approval?.approvedAt) || !isDate(approval?.expiresAt) ||
    Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt) ||
    Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt) > 24 * 60 * 60 * 1000) issues.push('decision|time');
  exactKeys(approval?.limits, ['maxEmails', 'maxRecipients'], 'limits', issues);
  if (approval?.limits?.maxEmails !== 1 || approval?.limits?.maxRecipients !== 1) issues.push('limits(semantic)');
  if (expected.projectId && approval?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.plan && (
    approval?.emailDeliveryPlanId !== expected.plan.id ||
    approval?.emailDeliveryPlanFingerprint !== expected.plan.fingerprint ||
    approval?.graphId !== expected.plan.graphId || approval?.graphFingerprint !== expected.plan.graphFingerprint
  )) issues.push('plan(binding)');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Email Delivery Approval is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (approval.fingerprint !== emailDeliveryApprovalFingerprint(approval)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval fingerprint mismatch: ${approval.id}`);
  }
  return approval;
}

export function validateEmailDeliveryRevocation(revocation, approval) {
  const issues = [];
  exactKeys(revocation, REVOCATION_KEYS, '$', issues);
  if (revocation?.schemaVersion !== 1 || revocation?.kind !== 'EmailDeliveryApprovalRevocation' ||
    !SHA256.test(revocation?.fingerprint || '')) issues.push('kind|fingerprint');
  if (approval && (
    revocation?.projectId !== approval.projectId || revocation?.graphFingerprint !== approval.graphFingerprint ||
    revocation?.emailDeliveryPlanId !== approval.emailDeliveryPlanId ||
    revocation?.emailDeliveryPlanFingerprint !== approval.emailDeliveryPlanFingerprint ||
    revocation?.approvalId !== approval.id || revocation?.approvalFingerprint !== approval.fingerprint
  )) issues.push('approval(binding)');
  if (!validActor(revocation?.revokedBy) || !isDate(revocation?.revokedAt) ||
    (approval && Date.parse(revocation.revokedAt) < Date.parse(approval.approvedAt))) issues.push('actor|time');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Email Delivery Approval Revocation is invalid at: ${[...new Set(issues)].join(', ')}`);
  if (revocation.fingerprint !== emailDeliveryRevocationFingerprint(revocation)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval Revocation fingerprint mismatch: ${revocation.approvalId}`);
  }
  return revocation;
}

export function emailDeliveryApprovalStatusAt(home, projectId, approval, now) {
  const revocationFile = emailDeliveryRevocationPath(home, projectId, approval.id);
  if (fs.existsSync(revocationFile)) {
    const revocation = readEmailDeliveryRevocationFile(revocationFile, approval);
    if (Date.parse(revocation.revokedAt) <= Date.parse(now)) return 'revoked';
  }
  if (Date.parse(approval.expiresAt) <= Date.parse(now)) return 'expired';
  return 'active';
}

export function emailDeliveryApprovalFingerprint(approval) {
  return fingerprintWithout(approval, ['fingerprint']);
}

export function emailDeliveryRevocationFingerprint(revocation) {
  return fingerprintWithout(revocation, ['fingerprint']);
}

function readEmailDeliveryApprovalFile(file, expected) {
  let approval;
  try { approval = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateEmailDeliveryApproval(approval, expected); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
}

function readEmailDeliveryRevocationFile(file, approval) {
  let revocation;
  try { revocation = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval Revocation JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateEmailDeliveryRevocation(revocation, approval); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Approval Revocation failed integrity validation: ${safeMessage(error.message)}`);
    throw error;
  }
}

function emailDeliveryApprovalPath(home, projectId, approvalId) {
  if (!APPROVAL_ID.test(approvalId || '')) throw operationError('VALIDATION_FAILED', 'Email Delivery Approval ID is invalid.');
  return path.join(projectPath(home, projectId), 'email-delivery-approvals', `${approvalId}.json`);
}

function emailDeliveryRevocationPath(home, projectId, approvalId) {
  return path.join(projectPath(home, projectId), 'email-delivery-approvals', 'revocations', `${approvalId}.json`);
}

function normalizeExpiration(value, approvedAt) {
  if (!isDate(value)) throw operationError('VALIDATION_FAILED', '--expires-at must be a valid ISO-8601 timestamp.');
  const expiresAt = new Date(value).toISOString();
  const duration = Date.parse(expiresAt) - Date.parse(approvedAt);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000) {
    throw operationError('VALIDATION_FAILED', 'Email Delivery Approval expiration must be later than approval and no more than 24 hours.');
  }
  return expiresAt;
}

function safeActor(value) {
  const actor = String(value || '').replace(/[\r\n]/g, ' ').slice(0, 128);
  if (!validActor(actor)) throw operationError('VALIDATION_FAILED', 'Email Delivery Approval actor is invalid.');
  return actor;
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

function validActor(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'email delivery approval error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
