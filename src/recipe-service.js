import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readProjectAnalysis } from './analysis-contract.js';
import { withControlLock } from './control-lock.js';
import { listConnections } from './connection-service.js';
import { operationError } from './errors.js';
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  updateProjectRecord,
  writeJsonAtomic,
} from './project-store.js';
import { providerById } from './provider-catalog.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

export function planRecipe(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'recipe-plan', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const analysis = readProjectAnalysis(project);
    const connections = listConnections({ home, projectId: project.id }).connections;
    let recipe = buildLaunchRecipe(project, analysis, connections, { createdAt: nowIso() });
    const root = projectPath(home, project.id);
    const recipeFile = path.join(root, 'recipes', `${recipe.id}.json`);
    const currentFile = path.join(root, 'recipe.json');
    let reused = false;
    if (fs.existsSync(recipeFile)) {
      recipe = readRecipeFile(recipeFile, project.id);
      reused = true;
    } else {
      writeJsonAtomic(recipeFile, recipe);
    }
    writeJsonAtomic(currentFile, recipe);
    const repositoryGuard = completeSourceGuard(project.source, before);
    registerLatestRecipe(home, project, recipe, recipeFile, currentFile);
    return {
      kind: 'recipe-plan',
      status: 'succeeded',
      home,
      projectId: project.id,
      recipe,
      recipeFile,
      currentFile,
      reused,
      repositoryGuard,
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function listRecipes(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const directory = path.join(projectPath(home, project.id), 'recipes');
  const recipes = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((name) => /^recipe-[a-f0-9]{24}\.json$/.test(name))
        .map((name) => readRecipeFile(path.join(directory, name), project.id))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((recipe) => ({
          id: recipe.id,
          fingerprint: recipe.fingerprint,
          createdAt: recipe.createdAt,
          providers: recipe.providers,
          requirements: recipe.requirements,
        }))
    : [];
  return { kind: 'recipe-list', home, projectId: project.id, count: recipes.length, recipes };
}

export function showRecipe(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const file = options.recipeId
    ? recipePath(home, project.id, options.recipeId)
    : path.join(projectPath(home, project.id), 'recipe.json');
  if (!fs.existsSync(file)) throw operationError('NOT_FOUND', `Launch Recipe not found: ${file}`);
  return { kind: 'recipe', home, projectId: project.id, recipe: readRecipeFile(file, project.id), recipeFile: file };
}

export function buildLaunchRecipe(project, analysis, connections, { createdAt }) {
  const detection = analysis.detection;
  const requirements = inferRequirements(detection);
  const providers = chooseProviders(detection, requirements);
  for (const provider of Object.values(providers).filter(Boolean)) providerById(provider);
  const alternatives = buildProviderAlternatives(detection, requirements, providers);
  for (const alternative of alternatives) providerById(alternative.provider);
  const requiredProviderIds = [...new Set(Object.values(providers).filter(Boolean))];
  const requiredConnections = requiredProviderIds.map((provider) => {
    const matches = connections.filter((connection) => connection.provider === provider && connection.status !== 'archived');
    const ready = matches.find((connection) => connection.status === 'ready');
    return {
      provider,
      status: ready ? 'ready' : (matches.length > 0 ? 'needs-probe' : 'missing'),
      connectionId: ready?.id || matches[0]?.id || '',
    };
  });
  const base = {
    schemaVersion: 1,
    kind: 'LaunchRecipe',
    projectId: project.id,
    sourceRef: {
      kind: project.source.kind,
      locator: project.source.locator,
      commit: project.source.commit,
    },
    requirements,
    providers,
    alternatives,
    requiredConnections,
    rationale: rationaleFor(detection, requirements, providers),
    humanDecisions: humanDecisions(requirements, providers),
    cost: {
      status: 'requires-live-pricing-and-approval',
      selectionStatus: 'not-budget-qualified',
      basis: 'unknown-until-live-read-only-pricing',
      requiresConfigurationBudget: true,
      currency: 'USD',
      estimatedMonthly: null,
      estimatedOneTime: null,
    },
    createdAt,
  };
  const fingerprint = fingerprintRecipe(base);
  return {
    ...base,
    id: `recipe-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    fingerprint,
  };
}

function buildProviderAlternatives(detection, requirements, providers) {
  const frameworks = new Set(detection.frameworks || []);
  const alternatives = [
    {
      role: 'registrar',
      selectedProvider: providers.registrar,
      provider: 'porkbun',
      applicability: 'available-after-human-review',
      reason: '可将域名购买保留在 Porkbun，同时继续由 Cloudflare 托管 DNS。',
      tradeoffs: ['需要额外完成 Nameserver 交接与 Porkbun API Access 初始化。', '购买价格、Premium 状态和联系人仍需人工确认。'],
    },
  ];

  if (providers.runtime === 'vercel') {
    alternatives.push({
      role: 'runtime',
      selectedProvider: providers.runtime,
      provider: 'railway',
      applicability: 'requires-runtime-validation',
      reason: 'Railway 可承载常驻 Node.js 服务，并允许把运行时与数据库放在同一平台。',
      tradeoffs: ['必须验证生产 Start Command、监听端口和持久化需求。', '不能假定 Vercel Functions 行为与常驻进程完全一致。'],
    });
  } else if (providers.runtime === 'railway') {
    alternatives.push({
      role: 'runtime',
      selectedProvider: providers.runtime,
      provider: 'vercel',
      applicability: frameworks.has('nextjs') || frameworks.has('next')
        ? 'requires-runtime-validation'
        : 'requires-product-change',
      reason: 'Vercel 是无服务器与前端框架的备选运行时。',
      tradeoffs: ['通用常驻服务需要改造成 Vercel 支持的构建与请求模型。', '切换前必须重新验证后台任务、文件系统和连接生命周期。'],
    });
  } else if (providers.runtime === 'cloudflare') {
    alternatives.push({
      role: 'runtime',
      selectedProvider: providers.runtime,
      provider: 'railway',
      applicability: 'requires-product-change',
      reason: 'Railway 可作为不依赖 Workers Runtime 的 Node.js 运行时备选。',
      tradeoffs: ['Workers 绑定、边缘运行时 API 和 D1 接口不能直接迁移。', '需要独立的构建、启动和数据迁移方案。'],
    });
  }

  if (requirements.database && providers.database) {
    const provider = providers.database === 'neon' ? 'supabase' : 'neon';
    const nativeBackend = providers.database === 'supabase' || providers.database === 'cloudflare';
    alternatives.push({
      role: 'database',
      selectedProvider: providers.database,
      provider,
      applicability: nativeBackend ? 'requires-product-change' : 'requires-migration-validation',
      reason: provider === 'supabase'
        ? 'Supabase 可提供托管 PostgreSQL，并可按需组合 Auth 与 Storage。'
        : 'Neon 可提供隔离分支和标准 PostgreSQL 连接。',
      tradeoffs: nativeBackend
        ? ['检测到供应商原生 SDK、认证或数据库绑定，不能只替换连接串。', '必须重新设计迁移、回滚和产品级认证验收。']
        : ['必须重新核验区域、扩展、连接池、备份和迁移兼容性。', '实时价格与免费额度在配置阶段重新读取并由人批准。'],
    });
  }

  return alternatives;
}

function inferRequirements(detection) {
  const env = new Set(detection.envKeys || []);
  const frameworks = new Set(detection.frameworks || []);
  const database = [...env].some((key) => /DATABASE_URL|POSTGRES|SUPABASE|NEON|D1_DATABASE/i.test(key)) ||
    ['prisma', 'drizzle'].some((framework) => frameworks.has(framework));
  const email = [...env].some((key) => /RESEND|SMTP|EMAIL_FROM|MAIL_/i.test(key));
  const auth = [...env].some((key) => /AUTH|OAUTH|CLERK|SUPABASE/i.test(key)) || frameworks.has('next-auth');
  return {
    runtime: true,
    database,
    email,
    auth,
    domain: true,
    delivery: true,
    launchMode: 'first-launch',
  };
}

function chooseProviders(detection, requirements) {
  const frameworks = new Set(detection.frameworks || []);
  const env = new Set(detection.envKeys || []);
  const cloudflareNative = Boolean(detection.files?.wrangler || detection.files?.wranglerToml || detection.files?.wranglerJsonc);
  const supabaseNative = [...env].some((key) => /SUPABASE/i.test(key));
  const cloudflareD1Native = cloudflareNative && [...env].some((key) => /D1_DATABASE/i.test(key));
  const nextjs = frameworks.has('nextjs') || frameworks.has('next');
  const runtime = cloudflareNative ? 'cloudflare' : (nextjs ? 'vercel' : 'railway');
  const database = requirements.database
    ? (supabaseNative ? 'supabase' : (cloudflareD1Native ? 'cloudflare' : 'neon'))
    : '';
  return {
    registrar: 'cloudflare',
    dns: 'cloudflare',
    runtime,
    database,
    email: requirements.email ? 'resend' : '',
    delivery: 'github',
  };
}

function rationaleFor(detection, requirements, providers) {
  const reasons = [
    `运行时根据框架与现有配置选择 ${providers.runtime}，不要求修改产品仓库。`,
    '域名注册与 DNS 默认由 Cloudflare 统一，减少 Nameserver 交接步骤。',
    'GitHub 只负责交付元数据和受控 CI；产品仓库保持默认只读。',
  ];
  if (requirements.database) reasons.push(`检测到数据库信号，选择 ${providers.database}；迁移前必须生成备份与 Schema Evidence。`);
  if (requirements.email) reasons.push('检测到邮件环境键，选择 Resend，并使用独立发信子域名合并 DNS Intent。');
  if (requirements.auth) reasons.push('检测到认证信号，产品级验收必须包含真实登录流程，不以匿名 200 替代。');
  if (!(detection.frameworks || []).length) reasons.push('未识别到强框架约束，Railway 作为通用运行时候选，执行前仍需确认 Build/Start Command。');
  return reasons;
}

function humanDecisions(requirements, providers) {
  const decisions = [
    { id: 'confirm-domain', reason: '确认购买或接管的域名、联系人和价格上限。' },
    { id: 'confirm-region-and-budget', reason: `确认 ${providers.runtime} 区域、套餐和月度预算。` },
  ];
  if (requirements.database) decisions.push({ id: 'confirm-database', reason: `确认 ${providers.database} 区域、套餐、备份和迁移窗口。` });
  if (requirements.email) decisions.push({ id: 'confirm-sending-subdomain', reason: '确认 Resend 发信子域名与测试收件人。' });
  if (requirements.auth) decisions.push({ id: 'confirm-auth-verification', reason: '指定真实登录测试账号和人工回调步骤。' });
  return decisions;
}

function registerLatestRecipe(home, project, recipe, recipeFile, currentFile) {
  if (project.lastRecipe?.recipeId === recipe.id) return;
  withControlLock(home, 'registry', 'recipe-plan-register', () => {
    const latest = readProjectRecord(home, project.id, { includeArchived: true });
    if (latest.status !== 'active') throw operationError('CONFLICT', `Project was archived while recipe was planned: ${project.id}`);
    if (latest.source.commit !== project.source.commit || latest.source.locator !== project.source.locator) {
      throw operationError('CONFLICT', `Project source changed while recipe was planned: ${project.id}`);
    }
    updateProjectRecord(home, {
      ...latest,
      lastRecipe: {
        recipeId: recipe.id,
        fingerprint: recipe.fingerprint,
        createdAt: recipe.createdAt,
        recipeFile,
        currentFile,
      },
      updatedAt: recipe.createdAt,
    });
  });
}

function readRecipeFile(file, projectId) {
  let recipe;
  try { recipe = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Launch Recipe JSON is invalid: ${error.message}`); }
  if (recipe.projectId !== projectId || recipe.fingerprint !== fingerprintRecipe(recipe)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Launch Recipe ownership or fingerprint mismatch: ${file}`);
  }
  const expectedId = `recipe-${recipe.fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (recipe.id !== expectedId) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Launch Recipe id mismatch: ${file}`);
  return recipe;
}

function recipePath(home, projectId, recipeId) {
  if (!/^recipe-[a-f0-9]{24}$/.test(recipeId || '')) throw operationError('VALIDATION_FAILED', 'Recipe id is invalid.');
  return path.join(projectPath(home, projectId), 'recipes', `${recipeId}.json`);
}

function fingerprintRecipe(recipe) {
  const value = structuredClone(recipe);
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
