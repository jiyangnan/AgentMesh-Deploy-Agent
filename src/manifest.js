import fs from 'node:fs';
import path from 'node:path';

import { DEPLOY_MANIFEST_SCHEMA_ID } from './schema.js';
import { ensureDir, pathExists, readJson, slugify, writeJson } from './utils.js';

export const CONFIG_DIR = '.agentmesh-deploy';
export const MANIFEST_FILE = 'manifest.json';

export function manifestPath(root) {
  return path.join(root, CONFIG_DIR, MANIFEST_FILE);
}

export function loadManifest(root) {
  const filePath = manifestPath(root);
  if (!pathExists(filePath)) {
    throw new Error(`Manifest not found: ${filePath}. Run agentmesh-deploy init first.`);
  }
  return readJson(filePath);
}

export function writeManifest(root, manifest, { force = false } = {}) {
  const filePath = manifestPath(root);
  if (pathExists(filePath) && !force) {
    throw new Error(`Manifest already exists: ${filePath}. Use --force to overwrite.`);
  }
  ensureDir(path.dirname(filePath));
  writeJson(filePath, manifest);
  return filePath;
}

export function createManifest(root, detection, options = {}) {
  const appId = slugify(options.name || detection.appName);
  const targetType = options.targetExplicit ? options.target : defaultTargetFromDetection(detection);
  const provider = options.providerExplicit ? options.provider : providerFromTarget(targetType);
  const resources = buildResources(appId, detection, targetType, options.preset);
  const env = buildEnv(detection.envKeys);
  const commands = buildCommands(detection.commands, detection.packageManager, targetType, detection);
  const deployment = buildDeployment(detection, targetType);
  const productionDomain = options.domain || deployment.productionDomain || '';

  return {
    schema: DEPLOY_MANIFEST_SCHEMA_ID,
    version: 1,
    app: {
      id: appId,
      name: options.name || appId,
      root: '.',
    },
    runtime: buildRuntime(detection),
    target: {
      provider,
      type: targetType,
      environment: 'production',
    },
    commands,
    resources,
    env,
    domain: buildDomain(productionDomain, deployment),
    ...(deployment.enabled ? { deployment } : {}),
    github: {
      enabled: true,
      repo: options.repo || detection.github?.repo || appId,
      visibility: 'private',
      actionsSecrets: defaultGithubActionsSecrets(targetType, env, deployment),
    },
    safety: {
      defaultMode: 'dry-run',
      realExecutionRequires: ['--execute', '--yes'],
    },
  };
}

function buildRuntime(detection) {
  if (detection.runtimeType === 'python') {
    return {
      type: 'python',
      packageManager: detection.packageManager,
      python: detection.python || '>=3.11',
      frameworks: detection.frameworks,
    };
  }

  return {
    type: 'node',
    packageManager: detection.packageManager,
    node: '>=20.0.0',
    frameworks: detection.frameworks,
  };
}

function buildCommands(commands = {}, packageManager, targetType, detection = {}) {
  const next = {};
  for (const [key, value] of Object.entries(commands)) {
    if (typeof value === 'string' && value.trim()) {
      next[key] = value;
    }
  }
  if (targetType === 'cloudflare-workers' && !next.deploy) {
    next.deploy = defaultCloudflareDeployCommand(packageManager);
  }
  if (targetType === 'docker-compose-caddy' && !next.composeConfig && detection.deployment?.composeFile) {
    next.composeConfig = `docker compose -f ${detection.deployment.composeFile} config`;
  }
  return next;
}

function defaultCloudflareDeployCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm exec wrangler deploy';
  if (packageManager === 'bun') return 'bunx wrangler deploy';
  if (packageManager === 'yarn') return 'yarn wrangler deploy';
  return 'npx wrangler deploy';
}

function providerFromTarget(targetType) {
  if (targetType.startsWith('cloudflare')) return 'cloudflare';
  if (targetType.startsWith('docker-compose')) return 'digitalocean';
  if (targetType.startsWith('vercel')) return 'vercel';
  return 'local';
}

function defaultTargetFromDetection(detection) {
  if (hasDockerComposeCaddyEvidence(detection)) {
    return 'docker-compose-caddy';
  }
  return 'cloudflare-workers';
}

function hasDockerComposeCaddyEvidence(detection) {
  return Boolean(
    detection.deployment?.composeFile &&
      (detection.files?.caddyfile || detection.deployment?.productionDoc || detection.deployment?.productionDomain)
  );
}

function buildDeployment(detection, targetType) {
  if (targetType !== 'docker-compose-caddy') return { enabled: false };
  return {
    enabled: true,
    kind: 'docker-compose-caddy',
    composeFile: detection.deployment?.composeFile || '',
    caddyFile: detection.deployment?.caddyFile || '',
    productionDoc: detection.deployment?.productionDoc || '',
    productionDomain: detection.deployment?.productionDomain || '',
    serviceName: detection.deployment?.serviceName || '',
    infrastructure: {
      provider: detection.deployment?.infrastructure?.provider || 'digitalocean',
      mode: detection.deployment?.infrastructure?.mode || 'provision',
      dropletName: detection.deployment?.infrastructure?.dropletName || `${detection.appName}-prod`,
      region: detection.deployment?.infrastructure?.region || 'sgp1',
      size: detection.deployment?.infrastructure?.size || 's-1vcpu-1gb',
      image: detection.deployment?.infrastructure?.image || 'ubuntu-24-04-x64',
      sshUser: detection.deployment?.infrastructure?.sshUser || 'root',
      sshPort: detection.deployment?.infrastructure?.sshPort || 22,
      sshHost: detection.deployment?.infrastructure?.sshHost || '',
      appDir: detection.deployment?.infrastructure?.appDir || `/opt/${detection.appName}`,
      network: detection.deployment?.infrastructure?.network || 'agentmesh-web',
      caddyMode: detection.deployment?.infrastructure?.caddyMode || 'managed-container',
      caddyContainer: detection.deployment?.infrastructure?.caddyContainer || '',
    },
    dns: {
      provider: detection.deployment?.dns?.provider || 'manual',
      recordType: detection.deployment?.dns?.recordType || 'A',
      name: detection.deployment?.dns?.name || '',
      zone: detection.deployment?.dns?.zone || '',
      value: detection.deployment?.dns?.value || '',
      proxied: detection.deployment?.dns?.proxied === true,
      ttl: detection.deployment?.dns?.ttl || 300,
    },
  };
}

function buildDomain(productionDomain, deployment = {}) {
  const root = deployment.dns?.zone || inferDnsZone(productionDomain);
  return {
    production: productionDomain,
    ...(root
      ? {
          root,
          registration: {
            provider: 'manual',
            mode: 'adopt-existing',
            root,
            years: 1,
            privacy: true,
          },
          zone: {
            provider: deployment.dns?.provider === 'cloudflare' ? 'cloudflare' : 'manual',
            name: root,
            accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
          },
        }
      : {}),
  };
}

function inferDnsZone(hostname) {
  const labels = String(hostname || '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

function defaultGithubActionsSecrets(targetType, env, deployment) {
  if (targetType === 'cloudflare-workers') return env.required;
  if (targetType !== 'docker-compose-caddy') return [];

  const secrets = [
    ...dockerRuntimeEnvSecrets(env),
    'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY',
  ];
  const infrastructure = deployment.infrastructure || {};
  if (!infrastructure.sshHost && !shouldSourceSshHostFromState(deployment)) {
    secrets.push('AGENTMESH_DEPLOY_SSH_HOST');
  }
  if (!infrastructure.sshUser) secrets.push('AGENTMESH_DEPLOY_SSH_USER');
  if (!infrastructure.sshPort) secrets.push('AGENTMESH_DEPLOY_SSH_PORT');
  if (!infrastructure.appDir) secrets.push('AGENTMESH_DEPLOY_APP_DIR');
  return uniqueStrings(secrets);
}

function shouldSourceSshHostFromState(deployment = {}) {
  const infrastructure = deployment.infrastructure || {};
  const mode = infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
  return !infrastructure.sshHost && mode !== 'adopt-existing';
}

function dockerRuntimeEnvSecrets(env = {}) {
  return uniqueStrings([
    ...(env.required || []),
    ...(env.generated || []),
  ]);
}

function buildResources(appId, detection, targetType, preset) {
  if (targetType !== 'cloudflare-workers') return [];

  const wranglerConfig = readWranglerConfig(detection.root);
  const explicitSaasPreset = preset === 'saas';
  const hasD1 = explicitSaasPreset || hasArray(wranglerConfig, 'd1_databases') || detection.envKeys.includes('CLOUDFLARE_DATABASE_ID');
  const hasR2 = explicitSaasPreset || hasArray(wranglerConfig, 'r2_buckets');
  const hasKV = explicitSaasPreset || hasArray(wranglerConfig, 'kv_namespaces');

  return [
    {
      id: 'db',
      enabled: hasD1,
      type: 'cloudflare.d1',
      name: `${appId}-db`,
      binding: 'DB',
      reason: hasD1 ? 'detected or preset SaaS database' : 'enable when the app needs relational storage',
    },
    {
      id: 'bucket',
      enabled: hasR2,
      type: 'cloudflare.r2',
      name: `${appId}-bucket`,
      binding: 'BUCKET',
      reason: hasR2 ? 'detected or preset SaaS object storage' : 'enable when the app needs file/object storage',
    },
    {
      id: 'cache',
      enabled: hasKV,
      type: 'cloudflare.kv',
      name: `${appId}-cache`,
      binding: 'CACHE',
      reason: hasKV ? 'detected or preset SaaS cache namespace' : 'enable when the app needs key-value cache',
    },
  ];
}

function buildEnv(envKeys) {
  const generated = [];
  const provider = [];
  const required = [];
  for (const key of envKeys) {
    if (key === 'BETTER_AUTH_SECRET' || key.endsWith('_SECRET_GENERATED')) {
      generated.push(key);
    } else if (key.startsWith('CLOUDFLARE_')) {
      provider.push(key);
    } else {
      required.push(key);
    }
  }

  return {
    required,
    generated,
    provider,
    copyFromShell: required,
  };
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function readWranglerConfig(root) {
  const jsoncPath = path.join(root, 'wrangler.jsonc');
  if (!pathExists(jsoncPath)) return {};

  const content = fs.readFileSync(jsoncPath, 'utf8');
  try {
    return JSON.parse(stripJsonc(content));
  } catch {
    return {};
  }
}

function stripJsonc(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

function hasArray(value, key) {
  return Array.isArray(value?.[key]) && value[key].length > 0;
}
