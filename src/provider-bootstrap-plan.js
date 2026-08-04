import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { listConnections } from './connection-service.js';
import { operationError } from './errors.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { providerBootstrapGuide, providerById } from './provider-catalog.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { showRecipe } from './recipe-service.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^bootstrap-plan-[a-f0-9]{24}$/;
const SECRET_BACKENDS = new Set(['env', 'keychain']);
const ROLE_ORDER = ['registrar', 'dns', 'runtime', 'database', 'email', 'delivery'];

export function createProviderBootstrapPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'provider-bootstrap-plan-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const recipe = showRecipe({ home, projectId: project.id, recipeId: options.recipeId }).recipe;
    assertRecipeSource(project, recipe);
    const secretBackend = normalizeSecretBackend(options.secretBackend, options.platform);
    let plan = buildProviderBootstrapPlan({
      home,
      project,
      recipe,
      secretBackend,
      createdAt: options.now || nowIso(),
    });
    const planFile = providerBootstrapPlanPath(home, project.id, plan.id);
    let reused = false;
    if (fs.existsSync(planFile)) {
      plan = readProviderBootstrapPlanFile(planFile, { home, project, recipe });
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    const repositoryGuard = completeSourceGuard(project.source, before);
    return buildReport({ home, project, recipe, plan, planFile, reused, repositoryGuard, operation: 'create' });
  });
}

export function showProviderBootstrapPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const planFile = providerBootstrapPlanPath(home, project.id, options.bootstrapPlanId);
  if (!fs.existsSync(planFile)) throw operationError('NOT_FOUND', `Provider Bootstrap Plan not found: ${planFile}`);
  const raw = readJson(planFile, 'Provider Bootstrap Plan');
  const recipe = showRecipe({ home, projectId: project.id, recipeId: raw.recipeRef?.id }).recipe;
  const plan = readProviderBootstrapPlanFile(planFile, { home, project, recipe });
  const repositoryGuard = completeSourceGuard(project.source, before);
  return buildReport({ home, project, recipe, plan, planFile, reused: true, repositoryGuard, operation: 'show' });
}

export function buildProviderBootstrapPlan({ home, project, recipe, secretBackend, createdAt }) {
  const rolesByProvider = new Map();
  for (const role of ROLE_ORDER) {
    const providerId = recipe.providers?.[role];
    if (!providerId) continue;
    if (!rolesByProvider.has(providerId)) rolesByProvider.set(providerId, []);
    rolesByProvider.get(providerId).push(role);
  }
  const providers = [...rolesByProvider].map(([providerId, roles]) =>
    compileProvider({ home, projectId: project.id, providerId, roles, secretBackend })
  );
  if (providers.length === 0) throw operationError('VALIDATION_FAILED', 'Launch Recipe selects no providers.');
  const base = {
    schemaVersion: 1,
    kind: 'ProviderBootstrapPlan',
    projectId: project.id,
    sourceRef: structuredClone(recipe.sourceRef),
    recipeRef: { id: recipe.id, fingerprint: recipe.fingerprint },
    secretBackend,
    status: 'waiting-human',
    sequence: [
      'Agent 从本计划创建 bootstrap 阶段 HumanHandoff，固化人工任务、负责人和截止时间。',
      '用户完成账号注册、MFA、条款、计费归属和凭证创建。',
      '用户提交不含 Secret 的完整 HumanHandoff Attestation；存在 blocked 任务时 Agent 继续暂停。',
      '用户或 Agent 将凭证值写入计划指定的外部 Secret Ref；不得放入产品仓库或命令参数。',
      'Agent 执行本计划中的 connection add，只保存 Secret Ref 和 Scope 元数据。',
      'Agent 执行 connection check，确认 Ref 可用性；该步骤不访问供应商。',
      '用户明确允许只读认证探测后，Agent 执行 connection probe --probe-auth。',
      '全部 Connection 为 ready 后，才进入 Sandbox Profile、Preflight 和受控 Apply。',
    ],
    providers,
    safety: {
      providerMutationsAllowed: false,
      providerProbesAllowed: false,
      secretValuesAllowed: false,
      productRepositoryWritesAllowed: false,
    },
    createdAt,
  };
  const fingerprint = fingerprintProviderBootstrapPlan(base);
  return {
    ...base,
    id: `bootstrap-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    fingerprint,
  };
}

export function validateProviderBootstrapPlan(plan, expected = {}) {
  const issues = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) issues.push('$');
  if (plan?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (plan?.kind !== 'ProviderBootstrapPlan') issues.push('$.kind');
  if (!PLAN_ID.test(plan?.id || '')) issues.push('$.id');
  if (!/^sha256:[a-f0-9]{64}$/.test(plan?.fingerprint || '')) issues.push('$.fingerprint');
  if (expected.projectId && plan?.projectId !== expected.projectId) issues.push('$.projectId');
  if (!SECRET_BACKENDS.has(plan?.secretBackend)) issues.push('$.secretBackend');
  if (plan?.status !== 'waiting-human') issues.push('$.status');
  if (!Array.isArray(plan?.sequence) || plan.sequence.length < 5) issues.push('$.sequence');
  if (!Array.isArray(plan?.providers) || plan.providers.length === 0) issues.push('$.providers');
  if (plan?.safety?.providerMutationsAllowed !== false || plan?.safety?.providerProbesAllowed !== false ||
      plan?.safety?.secretValuesAllowed !== false || plan?.safety?.productRepositoryWritesAllowed !== false) {
    issues.push('$.safety');
  }
  for (const [index, provider] of (plan?.providers || []).entries()) {
    const prefix = `$.providers[${index}]`;
    if (!provider?.providerId || !provider?.connectionId) issues.push(prefix);
    if (!Array.isArray(provider?.roles) || provider.roles.length === 0) issues.push(`${prefix}.roles`);
    if (!['one', 'all'].includes(provider?.credentialMode)) issues.push(`${prefix}.credentialMode`);
    if (!Array.isArray(provider?.credentialOptions) || !provider.credentialOptions.some((item) => item.selected)) {
      issues.push(`${prefix}.credentialOptions`);
    }
    if (!Array.isArray(provider?.requiredSecretRefs) || provider.requiredSecretRefs.length === 0) {
      issues.push(`${prefix}.requiredSecretRefs`);
    }
    for (const item of provider?.requiredSecretRefs || []) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(item?.env || '') || !String(item?.ref || '').startsWith(`${plan.secretBackend}://`)) {
        issues.push(`${prefix}.requiredSecretRefs`);
      }
      const expectedMethod = plan.secretBackend === 'keychain' ? 'native-cli-stdin' : 'external-environment';
      if (item?.provisioningMethod !== expectedMethod || !Array.isArray(item?.captureArgv) ||
          item?.requiresStdin !== (plan.secretBackend === 'keychain')) {
        issues.push(`${prefix}.requiredSecretRefs.provisioning`);
      }
      if (plan.secretBackend === 'keychain' && stableStringify(item.captureArgv) !== stableStringify([
        'agentmesh-deploy', 'secret', 'capture', item.ref, '--stdin', '--yes',
      ])) issues.push(`${prefix}.requiredSecretRefs.captureArgv`);
      if (plan.secretBackend === 'env' && item.captureArgv.length !== 0) {
        issues.push(`${prefix}.requiredSecretRefs.captureArgv`);
      }
    }
    for (const command of ['add', 'check', 'probe']) {
      if (!Array.isArray(provider?.commands?.[command]?.argv) || provider.commands[command].providerMutationAllowed !== false) {
        issues.push(`${prefix}.commands.${command}`);
      }
    }
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Provider Bootstrap Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  return plan;
}

function compileProvider({ home, projectId, providerId, roles, secretBackend }) {
  const provider = providerById(providerId);
  const guide = providerBootstrapGuide(providerId);
  const options = provider.credentialContract.options;
  const selected = provider.credentialContract.mode === 'all' ? options : [options[0]];
  const selectedIds = new Set(selected.map((item) => item.id));
  const bootstrapContext = provider.credentialContract.bootstrapContext || [];
  const requiredContext = bootstrapContext.filter((item) => item.requirement === 'required');
  const deferredContext = bootstrapContext.filter((item) => item.requirement === 'deferred').map((item) => item.env);
  const requiredSecretRefs = [
    ...selected.map((item) => ({ env: item.env, purpose: 'credential', source: 'human-created-provider-credential' })),
    ...requiredContext.map((item) => ({ env: item.env, purpose: 'context', source: item.source })),
  ].map((item) => {
    const ref = secretRefFor(secretBackend, projectId, item.env);
    return {
      ...item,
      ref,
      provisioningMethod: secretBackend === 'keychain' ? 'native-cli-stdin' : 'external-environment',
      captureArgv: secretBackend === 'keychain'
        ? ['agentmesh-deploy', 'secret', 'capture', ref, '--stdin', '--yes']
        : [],
      requiresStdin: secretBackend === 'keychain',
    };
  });
  const connectionId = `${providerId}-main`;
  const scope = selected.map((item) => item.scope).join('+');
  const baseArgs = ['agentmesh-deploy', 'connection'];
  const homeArgs = ['--home', home];
  const addArgv = [
    ...baseArgs, 'add', projectId, connectionId, '--provider', providerId, '--scope', scope,
    ...requiredSecretRefs.flatMap((item) => ['--secret-ref', `${item.env}=${item.ref}`]),
    ...homeArgs,
  ];
  return {
    providerId,
    name: provider.name,
    roles,
    interfaces: provider.interfaces,
    connectionId,
    credentialMode: provider.credentialContract.mode === 'all' ? 'all' : 'one',
    credentialOptions: options.map((item) => ({
      id: item.id,
      env: item.env,
      scope: item.scope,
      selected: selectedIds.has(item.id),
      ...(item.useFor ? { useFor: item.useFor } : {}),
      ...(item.preferredForHosted !== undefined ? { preferredForHosted: item.preferredForHosted } : {}),
    })),
    requiredSecretRefs,
    deferredContext,
    bootstrapSteps: guide.steps,
    humanOnly: guide.automationBoundary.humanMust,
    docs: guide.docs,
    commands: {
      add: command(addArgv, false),
      check: command([...baseArgs, 'check', projectId, connectionId, ...homeArgs], false),
      probe: command([...baseArgs, 'probe', projectId, connectionId, '--probe-auth', ...homeArgs], true),
    },
  };
}

function buildReport({ home, project, recipe, plan, planFile, reused, repositoryGuard, operation }) {
  const connections = listConnections({ home, projectId: project.id }).connections;
  const readiness = plan.providers.map((item) => effectiveProviderReadiness(item, connections));
  const effectiveStatus = readiness.every((item) => item.status === 'ready')
    ? 'ready'
    : readiness.some((item) => item.status === 'blocked')
      ? 'blocked'
      : readiness.some((item) => item.status === 'missing')
        ? 'waiting-human'
        : 'needs-probe';
  return {
    kind: 'provider-bootstrap-plan',
    operation,
    status: 'succeeded',
    home,
    projectId: project.id,
    recipeId: recipe.id,
    plan,
    planFile,
    reused,
    effectiveStatus,
    readiness,
    repositoryGuard,
    providerMutationsExecuted: 0,
    providerProbesExecuted: 0,
    secretValuesRead: false,
    productRepositoryChanged: false,
  };
}

function effectiveProviderReadiness(planProvider, connections) {
  const matches = connections.filter((item) => item.provider === planProvider.providerId && item.status !== 'archived');
  const exact = matches.find((item) => item.id === planProvider.connectionId);
  const connection = matches.find((item) => item.status === 'ready') || exact || matches[0];
  return {
    providerId: planProvider.providerId,
    connectionId: connection?.id || planProvider.connectionId,
    expectedConnectionId: planProvider.connectionId,
    status: connection?.status === 'ready'
      ? 'ready'
      : connection?.status === 'blocked'
        ? 'blocked'
        : connection ? 'needs-probe' : 'missing',
    connectionVersion: connection?.version || 0,
  };
}

function readProviderBootstrapPlanFile(file, { home, project, recipe }) {
  const plan = readJson(file, 'Provider Bootstrap Plan');
  validateProviderBootstrapPlan(plan, { projectId: project.id });
  if (plan.fingerprint !== fingerprintProviderBootstrapPlan(plan)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Bootstrap Plan fingerprint mismatch: ${file}`);
  }
  const expectedId = `bootstrap-plan-${plan.fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (plan.id !== expectedId) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Bootstrap Plan id mismatch: ${file}`);
  if (plan.recipeRef.id !== recipe.id || plan.recipeRef.fingerprint !== recipe.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Bootstrap Plan Recipe binding mismatch: ${file}`);
  }
  assertRecipeSource(project, recipe);
  if (!sameSource(plan.sourceRef, recipe.sourceRef)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Provider Bootstrap Plan source binding mismatch: ${file}`);
  }
  const current = buildProviderBootstrapPlan({
    home,
    project,
    recipe,
    secretBackend: plan.secretBackend,
    createdAt: plan.createdAt,
  });
  if (plan.fingerprint !== current.fingerprint) {
    throw operationError(
      'CONFLICT',
      `Provider Bootstrap Plan is stale because provider guidance changed: ${plan.id}. Create a new plan and First Launch Session.`
    );
  }
  return plan;
}

function normalizeSecretBackend(value, platform = process.platform) {
  const backend = value || (platform === 'darwin' ? 'keychain' : 'env');
  if (!SECRET_BACKENDS.has(backend)) throw operationError('VALIDATION_FAILED', 'Secret backend must be env or keychain.');
  if (backend === 'keychain' && platform !== 'darwin') {
    throw operationError('CAPABILITY_MISSING', 'The native keychain Secret backend is available only on macOS. Use --secret-backend env.');
  }
  return backend;
}

function secretRefFor(backend, projectId, envName) {
  if (backend === 'env') return `env://${envName}`;
  return `keychain://agentmesh-deploy/${projectId}-${envName.toLowerCase().replaceAll('_', '-')}`;
}

function command(argv, networkAllowed) {
  return { argv, networkAllowed, providerMutationAllowed: false };
}

function providerBootstrapPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Provider Bootstrap Plan id is invalid.');
  return path.join(projectPath(home, projectId), 'provider-bootstrap-plans', `${planId}.json`);
}

function assertRecipeSource(project, recipe) {
  if (!sameSource(project.source, recipe.sourceRef)) {
    throw operationError('CONFLICT', `Launch Recipe source is stale for project ${project.id}. Run analyze and recipe plan again.`);
  }
}

function sameSource(left, right) {
  return left?.kind === right?.kind && left?.locator === right?.locator && left?.commit === right?.commit;
}

function fingerprintProviderBootstrapPlan(plan) {
  const value = structuredClone(plan);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `${label} JSON is invalid: ${error.message}`); }
}
