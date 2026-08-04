import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { nowIso } from './utils.js';

export function createApproval(options) {
  if (!options.yes) {
    throw operationError('APPROVAL_REQUIRED', 'Creating an approval requires explicit --yes confirmation.');
  }
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'approval-create', () => {
    const project = readProjectRecord(home, options.projectId);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const nodeIds = resolveNodeIds(options.nodeIds, graph);
    const approvedAt = options.now || nowIso();
    const expiresAt = normalizeFutureDate(options.expiresAt, approvedAt);
    const approval = withApprovalFingerprint({
      schemaVersion: 1,
      kind: 'Approval',
      id: `approval-${randomUUID()}`,
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      nodeIds,
      decision: 'approved',
      limits: {},
      approvedBy: options.approvedBy || 'user',
      approvedAt,
      expiresAt,
    });
    validateApproval(approval, { projectId: project.id, graph });
    const approvalFile = approvalPath(home, project.id, approval.id);
    writeJsonAtomic(approvalFile, approval);
    return {
      kind: 'approval',
      operation: 'create',
      status: 'succeeded',
      home,
      projectId: project.id,
      approval,
      approvalFile,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function listApprovals(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const directory = path.join(projectPath(home, project.id), 'approvals');
  const approvals = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((name) => /^approval-[a-f0-9-]+\.json$/.test(name))
        .map((name) => readApprovalFile(path.join(directory, name), { projectId: project.id }))
        .map((approval) => summarizeApproval(home, project.id, approval, options.now || nowIso()))
        .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))
    : [];
  return { kind: 'approval-list', home, projectId: project.id, count: approvals.length, approvals };
}

export function showApproval(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const approvalFile = approvalPath(home, project.id, options.approvalId);
  if (!fs.existsSync(approvalFile)) throw operationError('NOT_FOUND', `Approval not found: ${options.approvalId}`);
  const approval = readApprovalFile(approvalFile, { projectId: project.id });
  return {
    kind: 'approval',
    operation: 'read',
    home,
    projectId: project.id,
    approval,
    approvalFile,
    effectiveStatus: approvalStatus(home, project.id, approval, options.now || nowIso()),
  };
}

export function revokeApproval(options) {
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Revoking an approval requires explicit --yes confirmation.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'approval-revoke', () => {
    const current = showApproval(options);
    const revokedAt = options.now || nowIso();
    const revocationFile = revocationPath(home, current.projectId, current.approval.id);
    const existing = readJsonIfExists(revocationFile);
    const revocation = existing || {
      schemaVersion: 1,
      kind: 'ApprovalRevocation',
      approvalId: current.approval.id,
      projectId: current.projectId,
      graphFingerprint: current.approval.graphFingerprint,
      revokedAt,
      revokedBy: options.approvedBy || 'user',
    };
    if (!existing) writeJsonAtomic(revocationFile, revocation);
    return {
      kind: 'approval',
      operation: 'revoke',
      status: 'succeeded',
      home,
      projectId: current.projectId,
      approval: current.approval,
      approvalFile: current.approvalFile,
      revocation,
      revocationFile,
      reused: Boolean(existing),
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function findActiveApprovals(home, projectId, graph, { now = nowIso() } = {}) {
  const report = listApprovals({ home, projectId, now });
  return report.approvals.filter((approval) =>
    approval.effectiveStatus === 'active' &&
    approval.graphId === graph.id &&
    approval.graphFingerprint === graph.fingerprint
  );
}

export function validateApproval(approval, expected = {}) {
  const issues = [];
  if (approval?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (approval?.kind !== 'Approval') issues.push('$.kind');
  if (!/^approval-[a-f0-9-]+$/.test(approval?.id || '')) issues.push('$.id');
  if (typeof approval?.projectId !== 'string' || !approval.projectId) issues.push('$.projectId');
  if (expected.projectId && approval?.projectId !== expected.projectId) issues.push('$.projectId');
  if (typeof approval?.graphId !== 'string' || !approval.graphId) issues.push('$.graphId');
  if (!/^sha256:[a-f0-9]{64}$/.test(approval?.graphFingerprint || '')) issues.push('$.graphFingerprint');
  if (!Array.isArray(approval?.nodeIds) || approval.nodeIds.length === 0 || new Set(approval.nodeIds).size !== approval.nodeIds.length) {
    issues.push('$.nodeIds');
  }
  if (approval?.decision !== 'approved') issues.push('$.decision');
  if (typeof approval?.approvedBy !== 'string' || !approval.approvedBy) issues.push('$.approvedBy');
  if (!isIsoDate(approval?.approvedAt)) issues.push('$.approvedAt');
  if (!isIsoDate(approval?.expiresAt)) issues.push('$.expiresAt');
  if (!/^sha256:[a-f0-9]{64}$/.test(approval?.fingerprint || '')) issues.push('$.fingerprint');
  if (expected.graph) {
    if (approval?.graphId !== expected.graph.id) issues.push('$.graphId');
    if (approval?.graphFingerprint !== expected.graph.fingerprint) issues.push('$.graphFingerprint');
    const graphNodeIds = new Set(expected.graph.nodes.map((node) => node.id));
    if ((approval?.nodeIds || []).some((id) => !graphNodeIds.has(id))) issues.push('$.nodeIds');
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Approval is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = approvalFingerprint(approval);
  if (approval.fingerprint !== actual) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Approval fingerprint mismatch: ${approval.id}`);
  }
  return approval;
}

function resolveNodeIds(requested, graph) {
  const approvable = graph.nodes.filter((node) => node.approval).map((node) => node.id);
  const values = requested === 'all'
    ? approvable
    : String(requested || '').split(',').map((value) => value.trim()).filter(Boolean);
  const unique = [...new Set(values)].sort();
  if (unique.length === 0) throw operationError('VALIDATION_FAILED', 'Approval requires at least one approvable node.');
  const allowed = new Set(approvable);
  const invalid = unique.filter((id) => !allowed.has(id));
  if (invalid.length > 0) {
    throw operationError('VALIDATION_FAILED', `Approval node scope contains non-approvable or unknown nodes: ${invalid.join(', ')}`);
  }
  return unique;
}

function normalizeFutureDate(value, approvedAt) {
  if (!isIsoDate(value)) throw operationError('VALIDATION_FAILED', '--expires-at must be a valid ISO-8601 timestamp.');
  const normalized = new Date(value).toISOString();
  if (Date.parse(normalized) <= Date.parse(approvedAt)) {
    throw operationError('VALIDATION_FAILED', 'Approval expiration must be later than approval time.');
  }
  return normalized;
}

function summarizeApproval(home, projectId, approval, now) {
  return { ...approval, effectiveStatus: approvalStatus(home, projectId, approval, now) };
}

function approvalStatus(home, projectId, approval, now) {
  if (fs.existsSync(revocationPath(home, projectId, approval.id))) return 'revoked';
  if (Date.parse(approval.expiresAt) <= Date.parse(now)) return 'expired';
  return 'active';
}

function readApprovalFile(file, expected) {
  let approval;
  try {
    approval = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `Approval JSON is invalid: ${error.message}`);
  }
  return validateApproval(approval, expected);
}

function approvalPath(home, projectId, approvalId) {
  if (!/^approval-[a-f0-9-]+$/.test(approvalId || '')) {
    throw operationError('VALIDATION_FAILED', 'Approval id is invalid.');
  }
  return path.join(projectPath(home, projectId), 'approvals', `${approvalId}.json`);
}

function revocationPath(home, projectId, approvalId) {
  return path.join(projectPath(home, projectId), 'approvals', 'revocations', `${approvalId}.json`);
}

function withApprovalFingerprint(approval) {
  return { ...approval, fingerprint: approvalFingerprint(approval) };
}

function approvalFingerprint(approval) {
  const value = structuredClone(approval);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
