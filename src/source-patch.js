import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { containsSecretLikeValue } from './provider-contract.js';
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  writeFileAtomic,
  writeJsonAtomic,
} from './project-store.js';
import {
  assertControlHomeSeparated,
  captureSourceGuard,
  completeSourceGuard,
} from './repository.js';
import { sensitiveArtifactPaths } from './artifact.js';
import { nowIso } from './utils.js';

const MAX_PATCH_BYTES = 1024 * 1024;
const PATCH_ID = /^source-patch-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_PATCH_PATH = /^[A-Za-z0-9._@+\/-]+$/;
const RISK_FLAGS = new Set([
  'authentication-or-account',
  'database-or-migration',
  'dependency-or-lockfile',
  'deployment-workflow',
]);

export function createSourcePatchProposal(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'source-patch-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const reason = normalizeReason(options.reason);
    const parsed = readAndValidatePatch(options.patchFile);
    const base = {
      schemaVersion: 1,
      kind: 'SourcePatchProposal',
      projectId: project.id,
      sourceRef: {
        kind: project.source.kind,
        locator: project.source.locator,
        commit: project.source.commit,
      },
      reason,
      status: 'proposed',
      patch: {
        format: 'unified-diff',
        digest: `sha256:${parsed.digest}`,
        sizeBytes: parsed.sizeBytes,
        lineCount: parsed.lineCount,
        fileCount: parsed.touchedPaths.length,
        touchedPaths: parsed.touchedPaths,
        riskFlags: parsed.riskFlags,
        relativePath: 'source-patches/<content-addressed>.patch',
      },
      requiresRepositoryOwnerApproval: true,
      automaticApplyAllowed: false,
      createdAt: options.now || nowIso(),
    };
    const fingerprint = sourcePatchProposalFingerprint(base);
    const proposalId = `source-patch-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`;
    const proposal = {
      ...base,
      id: proposalId,
      fingerprint,
      patch: {
        ...base.patch,
        relativePath: path.posix.join('source-patches', `${proposalId}.patch`),
      },
    };
    validateSourcePatchProposal(proposal, { projectId: project.id });

    const directory = path.join(projectPath(home, project.id), 'source-patches');
    const proposalFile = path.join(directory, `${proposal.id}.json`);
    const patchFile = resolveProposalPatchFile(home, project.id, proposal.patch.relativePath);
    const currentFile = path.join(projectPath(home, project.id), 'source-patch.json');
    let result = proposal;
    let reused = false;
    if (fs.existsSync(proposalFile)) {
      result = readProposal(proposalFile, { projectId: project.id, home });
      if (result.fingerprint !== proposal.fingerprint) {
        throw operationError('CONFLICT', `Source Patch Proposal ID collision: ${proposal.id}`);
      }
      reused = true;
    } else {
      if (fs.existsSync(patchFile)) assertPatchFile(patchFile, proposal.patch);
      else {
        writeFileAtomic(patchFile, parsed.content);
        fs.chmodSync(patchFile, 0o400);
      }
      writeJsonAtomic(proposalFile, proposal);
    }
    assertPatchFile(patchFile, result.patch);
    writeJsonAtomic(currentFile, result);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'source-patch-proposal',
      operation: 'create',
      status: result.status,
      home,
      projectId: project.id,
      proposal: result,
      proposalFile,
      patchFile,
      currentFile,
      reused,
      repositoryGuard,
      networkRequestsExecuted: 0,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function showSourcePatchProposal(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  if (!PATCH_ID.test(options.proposalId || '')) {
    throw operationError('VALIDATION_FAILED', 'Source Patch Proposal ID is invalid.');
  }
  const proposalFile = path.join(
    projectPath(home, project.id), 'source-patches', `${options.proposalId}.json`
  );
  if (!fs.existsSync(proposalFile)) {
    throw operationError('NOT_FOUND', `Source Patch Proposal not found: ${options.proposalId}`);
  }
  const proposal = readProposal(proposalFile, { projectId: project.id, home });
  const patchFile = resolveProposalPatchFile(home, project.id, proposal.patch.relativePath);
  assertPatchFile(patchFile, proposal.patch);
  return {
    kind: 'source-patch-proposal',
    operation: 'read',
    status: proposal.status,
    home,
    projectId: project.id,
    sourceStatus: proposal.sourceRef.commit === project.source.commit ? 'current' : 'stale',
    proposal,
    proposalFile,
    patchFile,
    networkRequestsExecuted: 0,
    providerMutationsExecuted: 0,
    productRepositoryChanged: false,
  };
}

export function parseUnifiedPatch(value) {
  const content = String(value || '').replace(/\r\n/g, '\n');
  if (!content.trim()) throw operationError('VALIDATION_FAILED', 'Source patch is empty.');
  if (content.includes('\0')) throw operationError('VALIDATION_FAILED', 'Source patch must be UTF-8 text without NUL bytes.');
  if (Buffer.byteLength(content, 'utf8') > MAX_PATCH_BYTES) {
    throw operationError('VALIDATION_FAILED', 'Source patch exceeds 1 MiB.');
  }
  if (containsSecretLikeValue(content)) {
    throw operationError('SECRET_IN_INPUT', 'Source patch contains a secret-like value.');
  }
  if (/^(?:GIT binary patch|Binary files |Submodule |[+-]Subproject commit |(?:(?:old|new) mode|(?:new|deleted) file mode) (?:120000|160000)|index [a-f0-9]+\.\.[a-f0-9]+ 160000|rename (?:from|to) |copy (?:from|to) )/m.test(content)) {
    throw operationError('VALIDATION_FAILED', 'Source patch supports regular text changes only; binary, symlink, submodule, rename, and copy patches are rejected.');
  }

  const lines = content.split('\n');
  const firstContentLine = lines.find((line) => line.trim());
  if (!firstContentLine?.startsWith('diff --git ')) {
    throw operationError('VALIDATION_FAILED', 'Source patch must start with a diff --git block.');
  }
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current);
      const match = line.match(/^diff --git a\/([^\s]+) b\/([^\s]+)$/);
      if (!match) throw operationError('VALIDATION_FAILED', 'Source patch contains an unsupported or quoted path.');
      current = {
        headerOld: match[1], headerNew: match[2], oldPath: '', newPath: '',
        oldHeaderCount: 0, newHeaderCount: 0, hunkCount: 0,
      };
      continue;
    }
    if (!current) continue;
    if (current.hunkCount === 0 && line.startsWith('--- ')) {
      current.oldPath = normalizeHeaderPath(line.slice(4), 'a/');
      current.oldHeaderCount += 1;
    } else if (current.hunkCount === 0 && line.startsWith('+++ ')) {
      current.newPath = normalizeHeaderPath(line.slice(4), 'b/');
      current.newHeaderCount += 1;
    }
    else if (line.startsWith('@@ ')) current.hunkCount += 1;
  }
  if (current) blocks.push(current);
  if (blocks.length === 0) throw operationError('VALIDATION_FAILED', 'Source patch must contain at least one diff --git block.');

  const touchedPaths = [];
  for (const block of blocks) {
    if (!block.oldPath || !block.newPath || block.oldHeaderCount !== 1 ||
        block.newHeaderCount !== 1 || block.hunkCount === 0) {
      throw operationError('VALIDATION_FAILED', 'Every source patch block requires old/new headers and at least one hunk.');
    }
    const touched = block.newPath === '/dev/null' ? block.oldPath : block.newPath;
    if (block.headerOld !== touched && block.oldPath !== '/dev/null') {
      throw operationError('VALIDATION_FAILED', `Source patch old path does not match its diff header: ${block.headerOld}`);
    }
    if (block.headerNew !== touched && block.newPath !== '/dev/null') {
      throw operationError('VALIDATION_FAILED', `Source patch new path does not match its diff header: ${block.headerNew}`);
    }
    assertSafePatchPath(touched);
    touchedPaths.push(touched);
  }
  const uniquePaths = [...new Set(touchedPaths)].sort();
  if (uniquePaths.length !== touchedPaths.length) {
    throw operationError('VALIDATION_FAILED', 'Source patch contains duplicate file blocks.');
  }
  if (sensitiveArtifactPaths(uniquePaths).length > 0) {
    throw operationError('SECRET_IN_INPUT', 'Source patch targets a sensitive credential or control-state path.');
  }
  const normalizedContent = content.endsWith('\n') ? content : `${content}\n`;
  if (Buffer.byteLength(normalizedContent, 'utf8') > MAX_PATCH_BYTES) {
    throw operationError('VALIDATION_FAILED', 'Source patch exceeds 1 MiB after normalization.');
  }
  return {
    content: normalizedContent,
    digest: createHash('sha256').update(normalizedContent).digest('hex'),
    sizeBytes: Buffer.byteLength(normalizedContent, 'utf8'),
    lineCount: normalizedContent.split('\n').length - 1,
    touchedPaths: uniquePaths,
    riskFlags: deriveRiskFlags(uniquePaths),
  };
}

export function validateSourcePatchProposal(proposal, expected = {}) {
  const issues = [];
  exactKeys(proposal, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceRef', 'reason', 'status',
    'patch', 'requiresRepositoryOwnerApproval', 'automaticApplyAllowed', 'createdAt',
  ], '$', issues);
  if (proposal?.schemaVersion !== 1 || proposal?.kind !== 'SourcePatchProposal') issues.push('kind|schemaVersion');
  if (!PATCH_ID.test(proposal?.id || '') || !SHA256.test(proposal?.fingerprint || '')) issues.push('id|fingerprint');
  if (expected.projectId && proposal?.projectId !== expected.projectId) issues.push('projectId');
  exactKeys(proposal?.sourceRef, ['kind', 'locator', 'commit'], '$.sourceRef', issues);
  if (!['local-git', 'remote-git'].includes(proposal?.sourceRef?.kind) ||
      typeof proposal?.sourceRef?.locator !== 'string' || !proposal.sourceRef.locator ||
      !/^[a-f0-9]{40,64}$/.test(proposal?.sourceRef?.commit || '')) issues.push('sourceRef');
  if (typeof proposal?.reason !== 'string' || !proposal.reason || proposal.reason.length > 1000 ||
      containsSecretLikeValue(proposal.reason)) issues.push('reason');
  if (proposal?.status !== 'proposed' || proposal?.requiresRepositoryOwnerApproval !== true ||
      proposal?.automaticApplyAllowed !== false) issues.push('policy');
  if (typeof proposal?.createdAt !== 'string' || !Number.isFinite(Date.parse(proposal.createdAt))) issues.push('createdAt');
  exactKeys(proposal?.patch, [
    'format', 'digest', 'sizeBytes', 'lineCount', 'fileCount', 'touchedPaths', 'riskFlags', 'relativePath',
  ], '$.patch', issues);
  if (proposal?.patch?.format !== 'unified-diff' || !SHA256.test(proposal?.patch?.digest || '') ||
      !Number.isInteger(proposal?.patch?.sizeBytes) || proposal.patch.sizeBytes < 1 || proposal.patch.sizeBytes > MAX_PATCH_BYTES ||
      !Number.isInteger(proposal?.patch?.lineCount) || proposal.patch.lineCount < 1 ||
      !Number.isInteger(proposal?.patch?.fileCount) || proposal.patch.fileCount < 1 ||
      !Array.isArray(proposal?.patch?.touchedPaths) || proposal.patch.touchedPaths.length !== proposal.patch.fileCount ||
      proposal.patch.touchedPaths.some((item) => typeof item !== 'string') ||
      !Array.isArray(proposal?.patch?.riskFlags) || proposal.patch.riskFlags.some((item) => !RISK_FLAGS.has(item)) ||
      proposal?.patch?.relativePath !== `source-patches/${proposal?.id}.patch`) issues.push('patch');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Source Patch Proposal is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const fingerprint = sourcePatchProposalFingerprint(proposal);
  if (proposal.fingerprint !== fingerprint || proposal.id !== `source-patch-${fingerprint.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source Patch Proposal fingerprint mismatch: ${proposal.id}`);
  }
  return proposal;
}

export function sourcePatchProposalFingerprint(value) {
  const proposal = structuredClone(value);
  delete proposal.id;
  delete proposal.fingerprint;
  delete proposal.createdAt;
  if (proposal.patch) proposal.patch.relativePath = 'source-patches/<content-addressed>.patch';
  return `sha256:${createHash('sha256').update(stableStringify(proposal)).digest('hex')}`;
}

function readAndValidatePatch(file) {
  const resolved = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw operationError('NOT_FOUND', `Source patch file not found: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operationError('VALIDATION_FAILED', 'Source patch input must be a regular non-symlink file.');
  }
  if (stat.size > MAX_PATCH_BYTES) throw operationError('VALIDATION_FAILED', 'Source patch exceeds 1 MiB.');
  const bytes = fs.readFileSync(resolved);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw operationError('VALIDATION_FAILED', 'Source patch must be valid UTF-8 text.'); }
  return parseUnifiedPatch(content);
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 1000 || containsSecretLikeValue(reason)) {
    throw operationError('VALIDATION_FAILED', 'Source patch requires a non-secret reason of at most 1000 characters.');
  }
  return reason;
}

function normalizeHeaderPath(value, prefix) {
  const text = value.split('\t', 1)[0];
  if (text === '/dev/null') return text;
  if (!text.startsWith(prefix)) throw operationError('VALIDATION_FAILED', `Source patch path must use ${prefix} headers.`);
  return text.slice(prefix.length);
}

function assertSafePatchPath(value) {
  if (!SAFE_PATCH_PATH.test(value) || value.startsWith('/') || value.includes('\\')) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `Source patch path is unsafe: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized !== value || normalized.startsWith('../') ||
      normalized === '.git' || normalized.startsWith('.git/') ||
      normalized === '.agentmesh-deploy' || normalized.startsWith('.agentmesh-deploy/')) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `Source patch path escapes or targets protected control state: ${value}`);
  }
}

function deriveRiskFlags(paths) {
  const flags = new Set();
  for (const value of paths) {
    const lower = value.toLowerCase();
    if (/(^|\/)(?:auth|account|accounts|permission|permissions|rbac|session|sessions)(?:\/|[._-]|$)/.test(lower)) {
      flags.add('authentication-or-account');
    }
    if (lower.startsWith('.github/workflows/')) flags.add('deployment-workflow');
    if (/(^|\/)(?:migrations?|schema)(?:\/|[._-]|$)/.test(lower) || lower.endsWith('.sql')) {
      flags.add('database-or-migration');
    }
    if (/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package\.json)$/.test(lower)) {
      flags.add('dependency-or-lockfile');
    }
  }
  return [...flags].sort();
}

function resolveProposalPatchFile(home, projectId, relativePath) {
  const root = projectPath(home, projectId);
  const file = path.resolve(root, relativePath || '');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) ||
      !/^source-patches[/\\]source-patch-[a-f0-9]{24}\.patch$/.test(relative)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Source Patch Proposal file path escapes its project control directory.');
  }
  return file;
}

function assertPatchFile(file, metadata) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source patch content is missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source patch content is not a regular file: ${file}`);
  }
  if ((stat.mode & 0o777) !== 0o400) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source patch content permissions are not immutable: ${file}`);
  }
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source patch content is missing: ${file}`); }
  const parsed = parseUnifiedPatch(content);
  if (`sha256:${parsed.digest}` !== metadata.digest || parsed.sizeBytes !== metadata.sizeBytes ||
      parsed.lineCount !== metadata.lineCount || parsed.touchedPaths.length !== metadata.fileCount ||
      stableStringify(parsed.touchedPaths) !== stableStringify(metadata.touchedPaths) ||
      stableStringify(parsed.riskFlags) !== stableStringify(metadata.riskFlags)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source patch content does not match immutable metadata: ${file}`);
  }
}

function readProposal(file, expected) {
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Source Patch Proposal JSON is invalid: ${error.message}`); }
  validateSourcePatchProposal(proposal, expected);
  const patchFile = resolveProposalPatchFile(expected.home, expected.projectId, proposal.patch.relativePath);
  assertPatchFile(patchFile, proposal.patch);
  return proposal;
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(label);
    return;
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0) issues.push(`${label}.unsupported(${extras.sort().join('|')})`);
  if (missing.length > 0) issues.push(`${label}.missing(${missing.sort().join('|')})`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
