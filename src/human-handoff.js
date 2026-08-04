import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { containsSecretLikeValue } from './provider-contract.js';
import { showProviderBootstrapPlan } from './provider-bootstrap-plan.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { readProductVerificationEvidence, showProductVerificationPlan } from './product-verification.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { showRecipe } from './recipe-service.js';
import { nowIso } from './utils.js';

const HANDOFF_ID = /^human-handoff-[a-f0-9]{24}$/;
const ATTESTATION_ID = /^human-attestation-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PHASES = new Set(['bootstrap', 'configuration', 'cutover']);
const RESULT_STATUSES = new Set(['completed', 'not-applicable', 'blocked']);
const BOOTSTRAP_EXCLUDED = new Set([
  'domain-purchase-confirmation', 'domain-claim', 'destructive-migration-approval',
]);
const LAUNCH_PROVIDER_ACTIONS = new Set(['domain-purchase-confirmation', 'domain-claim']);

const ACTION_DETAILS = Object.freeze({
  'account-signup': detail('identity', '完成供应商账号注册', '账号身份、邮箱验证和所有权必须由用户建立。'),
  mfa: detail('security', '完成多因素认证', 'MFA 设备和恢复方式不得由 Agent 持有。'),
  billing: detail('billing', '确认计费主体与支付方式', '费用归属和支付授权必须由产品所有者确认。'),
  terms: detail('legal', '审阅并接受服务条款', 'Agent 不能代表用户接受法律条款。'),
  'api-token-creation': detail('credential', '创建最小权限 API Token', 'Token 必须由用户在供应商控制台创建，值随后进入外部 Secret Store。'),
  'token-creation': detail('credential', '创建最小权限访问 Token', 'Token 值不得写入 Attestation、聊天或产品仓库。'),
  'pat-creation': detail('credential', '创建最小权限 Personal Access Token', 'PAT 继承用户权限，必须由用户确认 Scope。'),
  'initial-api-key-creation': detail('credential', '创建首次初始化 API Key', '首次 Key 必须由人创建，后续值通过安全 Capture 交给 Agent。'),
  'api-access-enable': detail('credential', '为账号或域名启用 API Access', '供应商控制台中的 API 开关需要账号所有者确认。'),
  'oauth-consent': detail('organization', '批准 OAuth 授权范围', '用户必须审阅实际 Scope 后完成 Consent。'),
  'app-installation': detail('organization', '安装并授权应用', '组织或仓库安装范围必须由有权限的人确认。'),
  'organization-policy': detail('organization', '确认组织策略允许接入', '组织策略、SSO 和安全限制不能由 Agent 绕过。'),
  'domain-purchase-confirmation': detail('domain', '确认域名购买', '域名、价格、联系人和条款必须由用户最终确认。'),
  'domain-claim': detail('domain', '确认发信域名归属', '发信域名所有权和合规用途必须由用户确认。'),
  'interactive-challenge-if-present': detail('interactive-challenge', '完成人机验证或 CAPTCHA（如出现）', 'Agent 遇到 CAPTCHA 或额外身份挑战时必须暂停并交还控制权。'),
  'production-cutover-approval': detail('production-risk', '批准生产流量切换', '候选验收全部通过后，生产 DNS 或流量切换仍需独立人工批准。'),
});

export function createHumanHandoff(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const bootstrap = showProviderBootstrapPlan({
    home, projectId: project.id, bootstrapPlanId: options.bootstrapPlanId,
  }).plan;
  const recipe = showRecipe({ home, projectId: project.id, recipeId: bootstrap.recipeRef.id }).recipe;
  const phase = normalizePhase(options.handoffPhase);
  const candidateEvidence = phase === 'cutover'
    ? loadPassedCandidateEvidence(home, project, options.candidateEvidenceId)
    : null;
  const createdAt = options.now || nowIso();
  const owner = normalizeActor(options.handoffOwner, 'handoff owner');
  const deadline = normalizeFutureDate(options.handoffDeadline, createdAt, 'handoff deadline');
  const tasks = deriveHumanTasks(bootstrap, recipe, phase);
  const base = {
    schemaVersion: 1,
    kind: 'HumanHandoff',
    projectId: project.id,
    sourceRef: structuredClone(bootstrap.sourceRef),
    bootstrapPlanRef: {
      id: bootstrap.id,
      fingerprint: bootstrap.fingerprint,
      recipeId: recipe.id,
      recipeFingerprint: recipe.fingerprint,
    },
    candidateEvidenceRef: candidateEvidence ? objectRef(candidateEvidence) : null,
    phase,
    owner,
    deadline,
    tasks,
    resume: {
      condition: 'all-required-tasks-attested-without-blockers',
      bootstrapPlanId: bootstrap.id,
      next: nextStepForPhase(phase),
    },
    status: 'pending-human',
    safety: {
      browserActionsExecuted: 0,
      providerMutationsExecuted: 0,
      secretValuesAllowed: false,
      productRepositoryWritesAllowed: false,
    },
    createdAt,
  };
  const fingerprint = handoffFingerprint(base, { excludeCreatedAt: true });
  let handoff = {
    ...base,
    id: `human-handoff-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  validateHumanHandoff(handoff, { project, bootstrap, recipe, candidateEvidence, tasks });
  const result = withControlLock(home, `project:${project.id}`, 'human-handoff-create', () => {
    const handoffFile = path.join(handoffDirectory(home, project.id, 'plans'), `${handoff.id}.json`);
    let reused = false;
    if (fs.existsSync(handoffFile)) {
      handoff = readHandoff(handoffFile, { project, bootstrap, recipe, candidateEvidence, tasks });
      reused = true;
    } else {
      writeJsonAtomic(handoffFile, handoff);
    }
    return { handoff, handoffFile, reused };
  });
  return handoffReport('create', home, project, result, completeSourceGuard(project.source, before));
}

export function showHumanHandoff(options) {
  const context = loadHandoffContext(options);
  if (!options.handoffAttestationId) {
    return handoffReport('show', context.home, context.project, {
      handoff: context.handoff, handoffFile: context.handoffFile, reused: false,
    });
  }
  if (!ATTESTATION_ID.test(options.handoffAttestationId)) {
    throw operationError('VALIDATION_FAILED', 'Human Handoff Attestation id is invalid.');
  }
  const attestationFile = path.join(
    handoffDirectory(context.home, context.project.id, 'attestations'), `${options.handoffAttestationId}.json`
  );
  if (!fs.existsSync(attestationFile)) {
    throw operationError('NOT_FOUND', `Human Handoff Attestation not found: ${options.handoffAttestationId}`);
  }
  const attestation = readAttestation(attestationFile, { project: context.project, handoff: context.handoff });
  return handoffReport('show-attestation', context.home, context.project, {
    handoff: context.handoff,
    handoffFile: context.handoffFile,
    attestation,
    attestationFile,
    reused: false,
  });
}

export function listHumanHandoffAttestations(options) {
  const context = loadHandoffContext(options);
  const directory = handoffDirectory(context.home, context.project.id, 'attestations');
  const attestations = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((name) => /^human-attestation-[a-f0-9]{24}\.json$/.test(name))
        .map((name) => readJson(path.join(directory, name), 'Human Handoff Attestation'))
        .filter((item) => item.handoffId === context.handoff.id)
        .map((item) => validateHumanHandoffAttestation(item, {
          project: context.project,
          handoff: context.handoff,
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    : [];
  return {
    kind: 'human-handoff-attestation-list',
    home: context.home,
    projectId: context.project.id,
    handoffId: context.handoff.id,
    count: attestations.length,
    attestations,
    browserActionsExecuted: 0,
    networkRequestsExecuted: 0,
    providerMutationsExecuted: 0,
    secretValuesExposed: false,
    productRepositoryChanged: false,
  };
}

export function createHumanHandoffAttestation(options) {
  if (options.yes !== true) throw operationError('APPROVAL_REQUIRED', 'Human Handoff Attestation requires --yes.');
  const context = loadHandoffContext(options);
  const before = captureSourceGuard(context.project.source);
  const actor = normalizeActor(options.actor, 'attestation actor');
  const createdAt = options.now || nowIso();
  if (!isDate(createdAt) || Date.parse(createdAt) < Date.parse(context.handoff.createdAt)) {
    throw operationError('VALIDATION_FAILED', 'Human Handoff Attestation cannot precede its Handoff.');
  }
  if (Date.parse(createdAt) > Date.parse(context.handoff.deadline)) {
    throw operationError('APPROVAL_REQUIRED', 'Human Handoff expired before Attestation; create a new Handoff with a reviewed deadline.');
  }
  const results = normalizeResults(options.results, context.handoff, createdAt);
  const status = results.some((item) => item.status === 'blocked') ? 'blocked' : 'completed';
  const base = {
    schemaVersion: 1,
    kind: 'HumanHandoffAttestation',
    projectId: context.project.id,
    sourceCommit: context.project.source.commit,
    handoffId: context.handoff.id,
    handoffFingerprint: context.handoff.fingerprint,
    actor,
    verificationBasis: 'human-attestation',
    results,
    status,
    createdAt,
  };
  const fingerprint = handoffFingerprint(base);
  let attestation = {
    ...base,
    id: `human-attestation-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  validateHumanHandoffAttestation(attestation, { project: context.project, handoff: context.handoff });
  const result = withControlLock(
    context.home, `project:${context.project.id}`, 'human-handoff-attest', () => {
      const attestationFile = path.join(
        handoffDirectory(context.home, context.project.id, 'attestations'), `${attestation.id}.json`
      );
      let reused = false;
      if (fs.existsSync(attestationFile)) {
        attestation = readAttestation(attestationFile, { project: context.project, handoff: context.handoff });
        reused = true;
      } else {
        writeJsonAtomic(attestationFile, attestation);
      }
      return {
        handoff: context.handoff,
        handoffFile: context.handoffFile,
        attestation,
        attestationFile,
        reused,
      };
    }
  );
  return handoffReport(
    'attest', context.home, context.project, result,
    completeSourceGuard(context.project.source, before)
  );
}

export function readHumanHandoffResultSpecFile(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Human Handoff result spec JSON is invalid: ${error.message}`); }
  exactKeysOrThrow(value, ['results'], 'Human Handoff result spec');
  if (!Array.isArray(value.results)) throw operationError('VALIDATION_FAILED', 'Human Handoff result spec requires a results array.');
  return value;
}

export function deriveHumanTasks(bootstrap, recipe, phase) {
  phase = normalizePhase(phase);
  const tasks = [];
  if (phase === 'bootstrap') {
    for (const provider of bootstrap.providers) {
      for (const action of provider.humanOnly.filter((item) =>
        !BOOTSTRAP_EXCLUDED.has(item) && selectedCredentialRequiresAction(provider, item)
      )) {
        tasks.push(buildTask({ phase, scope: 'provider', providerId: provider.providerId, action, docs: provider.docs }));
      }
    }
    tasks.push(buildTask({ phase, scope: 'project', providerId: '', action: 'interactive-challenge-if-present', docs: [] }));
  } else if (phase === 'configuration') {
    for (const provider of bootstrap.providers) {
      for (const action of provider.humanOnly.filter((item) =>
        LAUNCH_PROVIDER_ACTIONS.has(item) && launchRoleRequiresAction(provider, item)
      )) {
        tasks.push(buildTask({ phase, scope: 'provider', providerId: provider.providerId, action, docs: provider.docs }));
      }
    }
    for (const decision of recipe.humanDecisions || []) {
      tasks.push(buildTask({
        phase,
        scope: 'project',
        providerId: '',
        action: decision.id,
        docs: [],
        title: `确认产品决策：${decision.id}`,
        reason: decision.reason,
        category: 'product-decision',
      }));
    }
  } else {
    tasks.push(buildTask({ phase, scope: 'project', providerId: '', action: 'production-cutover-approval', docs: [] }));
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return [...byId.values()];
}

export function validateHumanHandoff(handoff, expected = {}) {
  const issues = [];
  exactKeys(handoff, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceRef', 'bootstrapPlanRef',
    'candidateEvidenceRef', 'phase', 'owner', 'deadline', 'tasks', 'resume', 'status', 'safety', 'createdAt',
  ], '$', issues);
  if (handoff?.schemaVersion !== 1 || handoff?.kind !== 'HumanHandoff' || !HANDOFF_ID.test(handoff?.id || '') ||
      !SHA256.test(handoff?.fingerprint || '') || !PHASES.has(handoff?.phase) || !isActor(handoff?.owner) ||
      !isDate(handoff?.deadline) || !isDate(handoff?.createdAt) || Date.parse(handoff.deadline) <= Date.parse(handoff.createdAt) ||
      handoff?.status !== 'pending-human' || !Array.isArray(handoff?.tasks) || handoff.tasks.length === 0) issues.push('root');
  validateSourceRef(handoff?.sourceRef, 'sourceRef', issues);
  validateBootstrapRef(handoff?.bootstrapPlanRef, issues);
  if (handoff?.phase === 'cutover') {
    if (!handoff?.candidateEvidenceRef || !/^product-verification-[a-f0-9]{24}$/.test(handoff.candidateEvidenceRef.id || '') ||
        !SHA256.test(handoff.candidateEvidenceRef.fingerprint || '')) issues.push('candidateEvidenceRef');
  } else if (handoff?.candidateEvidenceRef !== null) issues.push('candidateEvidenceRef');
  (handoff?.tasks || []).forEach((task, index) => validateTask(task, `tasks[${index}]`, issues));
  if (new Set((handoff?.tasks || []).map((task) => task.id)).size !== (handoff?.tasks || []).length) issues.push('tasks.duplicate');
  const expectedNext = nextStepForPhase(handoff?.phase);
  if (handoff?.resume?.condition !== 'all-required-tasks-attested-without-blockers' ||
      handoff?.resume?.bootstrapPlanId !== handoff?.bootstrapPlanRef?.id || handoff?.resume?.next !== expectedNext) issues.push('resume');
  if (handoff?.safety?.browserActionsExecuted !== 0 || handoff?.safety?.providerMutationsExecuted !== 0 ||
      handoff?.safety?.secretValuesAllowed !== false || handoff?.safety?.productRepositoryWritesAllowed !== false) issues.push('safety');
  if (expected.project && (!sameSource(expected.project.source, handoff?.sourceRef) || handoff?.projectId !== expected.project.id)) issues.push('project');
  if (expected.bootstrap && (
    handoff?.bootstrapPlanRef?.id !== expected.bootstrap.id ||
    handoff?.bootstrapPlanRef?.fingerprint !== expected.bootstrap.fingerprint
  )) issues.push('bootstrap');
  if (expected.recipe && (
    handoff?.bootstrapPlanRef?.recipeId !== expected.recipe.id ||
    handoff?.bootstrapPlanRef?.recipeFingerprint !== expected.recipe.fingerprint
  )) issues.push('recipe');
  if (expected.candidateEvidence && (
    handoff?.candidateEvidenceRef?.id !== expected.candidateEvidence.id ||
    handoff?.candidateEvidenceRef?.fingerprint !== expected.candidateEvidence.fingerprint
  )) issues.push('candidateEvidence');
  if (expected.tasks && stableStringify(handoff?.tasks) !== stableStringify(expected.tasks)) issues.push('tasks.derived');
  if (containsSecretLikeValue(handoff || {})) issues.push('secret');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Human Handoff is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = handoffFingerprint(handoff, { excludeCreatedAt: true });
  if (handoff.fingerprint !== actual || handoff.id !== `human-handoff-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Human Handoff fingerprint mismatch: ${handoff.id}`);
  }
  return handoff;
}

export function validateHumanHandoffAttestation(attestation, expected = {}) {
  const issues = [];
  exactKeys(attestation, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceCommit', 'handoffId',
    'handoffFingerprint', 'actor', 'verificationBasis', 'results', 'status', 'createdAt',
  ], '$', issues);
  if (attestation?.schemaVersion !== 1 || attestation?.kind !== 'HumanHandoffAttestation' ||
      !ATTESTATION_ID.test(attestation?.id || '') || !SHA256.test(attestation?.fingerprint || '') ||
      !isActor(attestation?.actor) || attestation?.verificationBasis !== 'human-attestation' ||
      !['completed', 'blocked'].includes(attestation?.status) || !isDate(attestation?.createdAt) ||
      !Array.isArray(attestation?.results)) issues.push('root');
  (attestation?.results || []).forEach((result, index) => validateResult(result, `results[${index}]`, issues));
  if (expected.project && (attestation?.projectId !== expected.project.id || attestation?.sourceCommit !== expected.project.source.commit)) issues.push('project');
  if (expected.handoff && (
    attestation?.handoffId !== expected.handoff.id || attestation?.handoffFingerprint !== expected.handoff.fingerprint
  )) issues.push('handoff');
  if (expected.handoff && Date.parse(attestation?.createdAt || 0) < Date.parse(expected.handoff.createdAt)) issues.push('createdAt');
  if (expected.handoff && Date.parse(attestation?.createdAt || 0) > Date.parse(expected.handoff.deadline)) issues.push('deadline');
  if (expected.handoff) {
    try {
      const normalized = normalizeResults(attestation?.results, expected.handoff, attestation?.createdAt);
      if (stableStringify(normalized) !== stableStringify(attestation.results)) issues.push('results.derived');
      const expectedStatus = normalized.some((item) => item.status === 'blocked') ? 'blocked' : 'completed';
      if (attestation.status !== expectedStatus) issues.push('status.derived');
    } catch { issues.push('results.coverage'); }
  }
  if (containsSecretLikeValue(attestation?.results || [])) issues.push('results.secret');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Human Handoff Attestation is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = handoffFingerprint(attestation);
  if (attestation.fingerprint !== actual || attestation.id !== `human-attestation-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Human Handoff Attestation fingerprint mismatch: ${attestation.id}`);
  }
  return attestation;
}

function loadHandoffContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  if (!HANDOFF_ID.test(options.handoffId || '')) throw operationError('VALIDATION_FAILED', 'Human Handoff id is invalid.');
  const handoffFile = path.join(handoffDirectory(home, project.id, 'plans'), `${options.handoffId}.json`);
  if (!fs.existsSync(handoffFile)) throw operationError('NOT_FOUND', `Human Handoff not found: ${options.handoffId}`);
  const shell = readJson(handoffFile, 'Human Handoff');
  const bootstrap = showProviderBootstrapPlan({
    home, projectId: project.id, bootstrapPlanId: shell.bootstrapPlanRef?.id,
  }).plan;
  const recipe = showRecipe({ home, projectId: project.id, recipeId: bootstrap.recipeRef.id }).recipe;
  const candidateEvidence = shell.phase === 'cutover'
    ? loadPassedCandidateEvidence(home, project, shell.candidateEvidenceRef?.id)
    : null;
  const tasks = deriveHumanTasks(bootstrap, recipe, shell.phase);
  const handoff = validateHumanHandoff(shell, { project, bootstrap, recipe, candidateEvidence, tasks });
  return { home, project, bootstrap, recipe, candidateEvidence, tasks, handoff, handoffFile };
}

function readHandoff(file, expected) {
  return validateHumanHandoff(readJson(file, 'Human Handoff'), expected);
}

function readAttestation(file, expected) {
  return validateHumanHandoffAttestation(readJson(file, 'Human Handoff Attestation'), expected);
}

function normalizeResults(values, handoff, createdAt) {
  if (!Array.isArray(values)) throw operationError('VALIDATION_FAILED', 'Human Handoff results must be an array.');
  const requiredIds = handoff.tasks.map((task) => task.id).sort();
  const byId = new Map();
  for (const raw of values) {
    exactKeysOrThrow(raw, ['taskId', 'status', 'reason', 'verifiedAt'], 'Human Handoff result');
    const taskId = String(raw.taskId || '');
    if (!requiredIds.includes(taskId) || byId.has(taskId)) {
      throw operationError('VALIDATION_FAILED', `Human Handoff result task is duplicate or unknown: ${taskId}`);
    }
    const status = String(raw.status || '');
    if (!RESULT_STATUSES.has(status)) throw operationError('VALIDATION_FAILED', `Human Handoff result status is invalid: ${taskId}`);
    const task = handoff.tasks.find((item) => item.id === taskId);
    if (status === 'not-applicable' && task?.allowNotApplicable !== true) {
      throw operationError('VALIDATION_FAILED', `Human Handoff task cannot be marked not-applicable: ${taskId}`);
    }
    const reason = normalizeReason(raw.reason);
    const verifiedAt = normalizePastOrPresentDate(raw.verifiedAt, createdAt, 'verifiedAt');
    if (Date.parse(verifiedAt) < Date.parse(handoff.createdAt)) {
      throw operationError('VALIDATION_FAILED', `Human Handoff result cannot precede its Handoff: ${taskId}`);
    }
    byId.set(taskId, { taskId, status, reason, verifiedAt });
  }
  if (byId.size !== requiredIds.length) {
    throw operationError('VALIDATION_FAILED', `Human Handoff results do not cover every task: ${requiredIds.filter((id) => !byId.has(id)).join(', ')}`);
  }
  const normalized = [...byId.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (containsSecretLikeValue(normalized)) throw operationError('VALIDATION_FAILED', 'Human Handoff results contain a secret-like value.');
  return normalized;
}

function buildTask({ phase, scope, providerId, action, docs, title, reason, category }) {
  const details = ACTION_DETAILS[action] || detail(
    category || 'product-decision',
    title || `完成人工步骤：${action}`,
    reason || '该步骤需要产品所有者确认，Agent 不能自行完成。'
  );
  const identity = `${phase}:${scope}:${providerId}:${action}`;
  return {
    id: `human-task-${hash(identity).slice(0, 24)}`,
    scope,
    providerId,
    category: category || details.category,
    action,
    title: title || details.title,
    reason: reason || details.reason,
    docs: [...new Set(docs || [])].sort(),
    allowNotApplicable: category ? category !== 'product-decision' : !['product-decision', 'production-risk'].includes(details.category),
    completionPolicy: 'human-attestation-without-secret-values',
  };
}

function selectedCredentialRequiresAction(provider, action) {
  const selected = new Set(provider.credentialOptions.filter((item) => item.selected).map((item) => item.id));
  if (action === 'app-installation') return selected.has('github-app');
  if (action === 'oauth-consent') return selected.has('oauth');
  if (action === 'pat-creation') return selected.has('personal-access-token') || selected.has('cli-token');
  return true;
}

function launchRoleRequiresAction(provider, action) {
  if (action === 'domain-purchase-confirmation') return provider.roles.includes('registrar');
  if (action === 'domain-claim') return provider.roles.includes('email');
  return false;
}

function validateTask(task, label, issues) {
  exactKeys(task, ['id', 'scope', 'providerId', 'category', 'action', 'title', 'reason', 'docs', 'allowNotApplicable', 'completionPolicy'], label, issues);
  if (!/^human-task-[a-f0-9]{24}$/.test(task?.id || '') || !['provider', 'project'].includes(task?.scope) ||
      (task?.scope === 'provider' ? !isLabel(task?.providerId) : task?.providerId !== '') ||
      !['identity', 'security', 'legal', 'billing', 'credential', 'organization', 'domain', 'product-decision', 'production-risk', 'interactive-challenge'].includes(task?.category) ||
      !isLabel(task?.action, 128) || !isLabel(task?.title, 200) || !isLabel(task?.reason, 500) ||
      !Array.isArray(task?.docs) || task?.docs.some((url) => typeof url !== 'string' || !url.startsWith('https://')) ||
      typeof task?.allowNotApplicable !== 'boolean' ||
      task?.completionPolicy !== 'human-attestation-without-secret-values') issues.push(label);
}

function validateResult(result, label, issues) {
  exactKeys(result, ['taskId', 'status', 'reason', 'verifiedAt'], label, issues);
  if (!/^human-task-[a-f0-9]{24}$/.test(result?.taskId || '') || !RESULT_STATUSES.has(result?.status) ||
      !isLabel(result?.reason, 300) || !isDate(result?.verifiedAt)) issues.push(label);
}

function validateSourceRef(ref, label, issues) {
  if (!ref || !['local-git', 'remote-git'].includes(ref.kind) || !isLabel(ref.locator) ||
      !/^[a-fA-F0-9]{40,64}$/.test(ref.commit || '')) issues.push(label);
}

function validateBootstrapRef(ref, issues) {
  if (!ref || !/^bootstrap-plan-[a-f0-9]{24}$/.test(ref.id || '') || !SHA256.test(ref.fingerprint || '') ||
      !/^recipe-[a-f0-9]{24}$/.test(ref.recipeId || '') || !SHA256.test(ref.recipeFingerprint || '')) issues.push('bootstrapPlanRef');
}

function handoffReport(operation, home, project, result, repositoryGuard = undefined) {
  return {
    kind: 'human-handoff',
    operation,
    status: result.attestation?.status || result.handoff.status,
    home,
    projectId: project.id,
    ...result,
    ...(repositoryGuard ? { repositoryGuard } : {}),
    browserActionsExecuted: 0,
    networkRequestsExecuted: 0,
    providerMutationsExecuted: 0,
    secretValuesExposed: false,
    productRepositoryChanged: false,
  };
}

function handoffDirectory(home, projectId, child) {
  return path.join(projectPath(home, projectId), 'human-handoffs', child);
}

function handoffFingerprint(value, { excludeCreatedAt = false } = {}) {
  const copy = structuredClone(value);
  delete copy.id;
  delete copy.fingerprint;
  if (excludeCreatedAt) delete copy.createdAt;
  return `sha256:${hash(stableStringify(copy))}`;
}

function normalizePhase(value) {
  const phase = String(value || '');
  if (!PHASES.has(phase)) {
    throw operationError('VALIDATION_FAILED', 'Human Handoff phase must be bootstrap, configuration, or cutover.');
  }
  return phase;
}

function nextStepForPhase(phase) {
  return {
    bootstrap: 'capture-secrets-and-probe-connections',
    configuration: 'create-launch-configuration-and-review',
    cutover: 'apply-approved-production-cutover',
  }[phase] || '';
}

function loadPassedCandidateEvidence(home, project, evidenceId) {
  if (!/^product-verification-[a-f0-9]{24}$/.test(evidenceId || '')) {
    throw operationError('APPROVAL_REQUIRED', 'Cutover Human Handoff requires a passed Candidate Product Verification Evidence id.');
  }
  const file = path.join(projectPath(home, project.id), 'evidence', 'product-verification', `${evidenceId}.json`);
  if (!fs.existsSync(file)) throw operationError('NOT_FOUND', `Candidate Product Verification Evidence not found: ${evidenceId}`);
  const shell = readProductVerificationEvidence(file);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: shell.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: shell.configurationId,
  }).configuration;
  const plan = showProductVerificationPlan({
    home,
    projectId: project.id,
    graphId: graph.id,
    configurationId: configuration.id,
    planId: shell.planId,
  }).plan;
  const evidence = readProductVerificationEvidence(file, { project, graph, configuration, plan });
  if (evidence.phase !== 'candidate' || evidence.status !== 'passed') {
    throw operationError('APPROVAL_REQUIRED', 'Cutover Human Handoff requires passed candidate verification evidence.');
  }
  return evidence;
}

function normalizeActor(value, label) {
  const actor = String(value || '').trim();
  if (!isActor(actor)) throw operationError('VALIDATION_FAILED', `${label} is invalid.`);
  return actor;
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  if (!isLabel(reason, 300)) throw operationError('VALIDATION_FAILED', 'Human Handoff result reason is required and must be at most 300 characters.');
  return reason;
}

function normalizeFutureDate(value, now, label) {
  if (!isDate(value) || Date.parse(value) <= Date.parse(now)) throw operationError('VALIDATION_FAILED', `${label} must be after creation time.`);
  return new Date(Date.parse(value)).toISOString();
}

function normalizePastOrPresentDate(value, now, label) {
  if (!isDate(value) || Date.parse(value) > Date.parse(now)) throw operationError('VALIDATION_FAILED', `${label} must be no later than attestation creation.`);
  return new Date(Date.parse(value)).toISOString();
}

function detail(category, title, reason) { return Object.freeze({ category, title, reason }); }
function objectRef(value) { return { id: value.id, fingerprint: value.fingerprint }; }
function sameSource(left, right) { return left?.kind === right?.kind && left?.locator === right?.locator && left?.commit === right?.commit; }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isActor(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value); }
function isLabel(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

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

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `${label} JSON is invalid: ${error.message}`); }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
