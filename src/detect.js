import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { defaultToolResolver, githubRepoSlugFromUrl } from './tooling.js';
import { parseEnvKeys, pathExists, readJsonIfExists, readTextIfExists, slugify } from './utils.js';

export function detectProject(root) {
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = readJsonIfExists(packageJsonPath) || {};
  const pyprojectPath = path.join(root, 'pyproject.toml');
  const pyproject = readTextIfExists(pyprojectPath);
  const hasPackageJson = pathExists(packageJsonPath);
  const hasPyproject = pathExists(pyprojectPath);
  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };
  const dependencyCount = Object.keys(packageJson.dependencies || {}).length;
  const devDependencyCount = Object.keys(packageJson.devDependencies || {}).length;
  const scripts = packageJson.scripts || {};
  const projectName = packageJson.name || parsePyprojectString(pyproject, 'name') || path.basename(root);
  const runtimeType = detectRuntimeType({ hasPackageJson, hasPyproject });
  const packageManager = detectPackageManager(root, runtimeType, packageJson.packageManager);
  const envExample = readTextIfExists(path.join(root, '.env.example'));
  const envKeys = parseEnvKeys(envExample);
  const appName = slugify(projectName);
  const deployment = detectDeployment(root, appName);
  const github = detectGithub(root);

  return {
    root,
    appName,
    runtimeType,
    python: runtimeType === 'python' ? parsePyprojectString(pyproject, 'requires-python') : '',
    packageManager,
    dependencyCount,
    devDependencyCount,
    hasPackageJson,
    hasPyproject,
    scripts,
    commands: detectCommands(root, runtimeType, packageManager, scripts),
    frameworks: detectFrameworks(dependencies, root, { runtimeType, pyproject }),
    envKeys,
    github,
    deployment,
    files: {
      wrangler: pathExists(path.join(root, 'wrangler.jsonc')) || pathExists(path.join(root, 'wrangler.toml')),
      vercel: pathExists(path.join(root, 'vercel.json')),
      dockerfile: pathExists(path.join(root, 'Dockerfile')),
      dockerCompose: deployment.composeFile !== '',
      dockerComposeProd: deployment.composeFile.includes('prod'),
      caddyfile: deployment.caddyFile !== '',
      pyproject: hasPyproject,
      uvLock: pathExists(path.join(root, 'uv.lock')),
      packageLock: pathExists(path.join(root, 'package-lock.json')),
      pnpmLock: pathExists(path.join(root, 'pnpm-lock.yaml')),
      yarnLock: pathExists(path.join(root, 'yarn.lock')),
      bunLock: pathExists(path.join(root, 'bun.lock')) || pathExists(path.join(root, 'bun.lockb')),
      githubActions: pathExists(path.join(root, '.github', 'workflows')),
    },
  };
}

function detectGithub(root) {
  const origin = gitRemoteUrl(root, 'origin');
  const repo = githubRepoSlugFromUrl(origin);
  return {
    remote: origin,
    repo,
  };
}

function gitRemoteUrl(root, remote) {
  const result = spawnSync('git', ['remote', 'get-url', remote], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function detectRuntimeType({ hasPackageJson, hasPyproject }) {
  if (hasPyproject && !hasPackageJson) return 'python';
  return 'node';
}

function detectPackageManager(root, runtimeType, packageManagerField) {
  if (runtimeType === 'python') return detectPythonPackageManager(root);
  if (pathExists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (pathExists(path.join(root, 'bun.lock')) || pathExists(path.join(root, 'bun.lockb'))) return 'bun';
  if (pathExists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (pathExists(path.join(root, 'package-lock.json'))) return 'npm';
  if (typeof packageManagerField === 'string') {
    const match = packageManagerField.match(/^(pnpm|npm|yarn|bun)@/);
    if (match) return match[1];
  }
  return 'npm';
}

function detectPythonPackageManager(root) {
  if (pathExists(path.join(root, 'uv.lock'))) return 'uv';
  if (pathExists(path.join(root, 'poetry.lock'))) return 'poetry';
  return 'pip';
}

function detectCommands(root, runtimeType, packageManager, scripts) {
  if (runtimeType === 'python') return detectPythonCommands(root, packageManager);
  return {
    install: installCommand(packageManager),
    dev: scripts.dev ? runScript(packageManager, 'dev') : '',
    build: scripts.build ? runScript(packageManager, 'build') : '',
    test: scripts.test ? runScript(packageManager, 'test') : '',
    deploy: scripts.deploy ? runScript(packageManager, 'deploy') : '',
    migrateLocal: scripts['db:migrate:local'] ? runScript(packageManager, 'db:migrate:local') : '',
    migrateRemote: scripts['db:migrate:remote'] ? runScript(packageManager, 'db:migrate:remote') : '',
    syncWorkerSecrets: scripts['sync-worker-secrets'] ? runScript(packageManager, 'sync-worker-secrets') : '',
    syncGithubSecrets: scripts['sync-github-secrets'] ? runScript(packageManager, 'sync-github-secrets') : '',
  };
}

function detectPythonCommands(root, packageManager) {
  const hasPytest = pathExists(path.join(root, 'tests'));
  const python = detectPythonEntrypoint();
  if (packageManager === 'uv') {
    return {
      install: 'uv sync',
      test: hasPytest ? 'uv run pytest' : '',
      build: '',
      deploy: '',
    };
  }
  if (packageManager === 'poetry') {
    return {
      install: 'poetry install',
      test: hasPytest ? 'poetry run pytest' : '',
      build: '',
      deploy: '',
    };
  }
  return {
    install: pathExists(path.join(root, 'requirements.txt'))
      ? `${python} -m pip install -r requirements.txt`
      : `${python} -m pip install -e .`,
    test: hasPytest ? `${python} -m pytest` : '',
    build: '',
    deploy: '',
  };
}

function detectPythonEntrypoint() {
  return defaultToolResolver('python3') ? 'python3' : 'python';
}

function installCommand(packageManager) {
  if (packageManager === 'yarn') return 'yarn install';
  if (packageManager === 'bun') return 'bun install';
  if (packageManager === 'pnpm') return 'pnpm install';
  return 'npm install';
}

function runScript(packageManager, scriptName) {
  if (packageManager === 'yarn') return `yarn ${scriptName}`;
  if (packageManager === 'bun') return `bun run ${scriptName}`;
  if (packageManager === 'pnpm') return `pnpm run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function detectFrameworks(dependencies, root, { runtimeType = 'node', pyproject = '' } = {}) {
  const frameworks = [];
  const has = (name) => Object.prototype.hasOwnProperty.call(dependencies, name);

  if (runtimeType === 'python') {
    frameworks.push('python');
    if (/"fastapi[<>=~!,\s"]/.test(pyproject) || /'fastapi[<>=~!,\s']/.test(pyproject)) {
      frameworks.push('fastapi');
    }
    if (/"django[<>=~!,\s"]/.test(pyproject) || /'django[<>=~!,\s']/.test(pyproject)) {
      frameworks.push('django');
    }
  }

  if (has('next')) frameworks.push('next');
  if (has('@tanstack/react-start') || has('@tanstack/start')) frameworks.push('tanstack-start');
  if (has('vite')) frameworks.push('vite');
  if (has('hono')) frameworks.push('hono');
  if (has('wrangler') || pathExists(path.join(root, 'wrangler.jsonc')) || pathExists(path.join(root, 'wrangler.toml'))) {
    frameworks.push('cloudflare-workers');
  }
  if (frameworks.length === 0 && pathExists(path.join(root, 'package.json'))) {
    frameworks.push('node');
  }
  if (pathExists(path.join(root, 'Dockerfile'))) frameworks.push('docker');
  if (detectComposeFile(root)) frameworks.push('docker-compose');
  if (detectCaddyFile(root)) frameworks.push('caddy');

  return frameworks;
}

function detectDeployment(root, appName) {
  const composeFile = detectComposeFile(root);
  const serviceName = detectComposeService(root, composeFile);
  const composeTargets = detectComposeTargets(root, composeFile);
  const caddyFile = detectCaddyFile(root);
  const productionDoc = detectProductionDoc(root);
  const productionText = productionDoc ? readTextIfExists(path.join(root, productionDoc)) : '';
  const productionDomain = caddyFile
    ? detectCaddyDomain(root, caddyFile, appName, [serviceName, ...composeTargets])
    : detectProductionDomain(productionText, appName, [serviceName, ...composeTargets]);
  const infrastructure = detectInfrastructure(productionText, {
    appName,
    serviceName,
  });
  return {
    composeFile,
    caddyFile,
    productionDoc,
    productionDomain,
    serviceName,
    infrastructure,
    dns: detectDns(productionDomain, infrastructure),
  };
}

function detectComposeFile(root) {
  const candidates = [
    'deploy/docker-compose.prod.yml',
    'deploy/docker-compose.prod.example.yml',
    'docker-compose.prod.yml',
    'docker-compose.yml',
    'compose.yml',
  ];
  return candidates.find((file) => pathExists(path.join(root, file))) || '';
}

function detectCaddyFile(root) {
  const candidates = [
    'deploy/agentmesh-prod.Caddyfile',
    'deploy/Caddyfile',
    'Caddyfile',
  ];
  return candidates.find((file) => pathExists(path.join(root, file))) || '';
}

function detectProductionDoc(root) {
  const candidates = [
    'deploy/PRODUCTION.md',
    'deploy/production.md',
    'deploy/digitalocean.md',
    'deploy/DIGITALOCEAN.md',
    'DEPLOYMENT.md',
    'docs/DEPLOYMENT.md',
    'docs/deployment.md',
  ];
  return candidates.find((file) => pathExists(path.join(root, file))) || '';
}

function detectCaddyDomain(root, caddyFile, appName, targets = []) {
  const content = readTextIfExists(path.join(root, caddyFile));
  const serviceTargets = serviceTargetHints(appName, targets);
  const servicePattern = new RegExp(
    `reverse_proxy\\s+(?:${serviceTargets.map(escapeRegExp).join('|')})(?::|\\b)`,
    'i'
  );
  const blocks = content.matchAll(/(^|\n)([A-Za-z0-9.-]+)\s*\{([\s\S]*?)\n\}/g);
  for (const match of blocks) {
    const domain = match[2];
    const body = match[3] || '';
    if (servicePattern.test(body)) return domain;
  }
  return '';
}

function detectProductionDomain(productionText, appName, targets = []) {
  const domains = uniqueStrings(
    [...String(productionText || '').matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi)]
      .map((match) => match[0].toLowerCase())
      .filter((domain) => !ignoredDetectedDomain(domain))
  );
  if (domains.length === 0) return '';

  const productTokens = productDomainTokens(appName, targets);
  const scored = domains
    .map((domain, index) => ({
      domain,
      score: domainScore(domain, productTokens) - index * 0.01,
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.domain || '';
}

function detectComposeService(root, composeFile) {
  if (!composeFile) return '';
  const content = readTextIfExists(path.join(root, composeFile));
  const match = content.match(/\n\s{2}([A-Za-z0-9_-]+):\n\s{4}/);
  return match ? match[1] : '';
}

function detectComposeTargets(root, composeFile) {
  if (!composeFile) return [];
  const content = readTextIfExists(path.join(root, composeFile));
  return uniqueStrings([
    ...[...content.matchAll(/\n\s{2}([A-Za-z0-9_-]+):\n\s{4}/g)].map((match) => match[1]),
    ...[...content.matchAll(/^\s*container_name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/gm)].map((match) => match[1]),
  ]);
}

function detectInfrastructure(productionText, { appName, serviceName }) {
  const hostName = matchMarkdownValue(productionText, 'Hostname');
  const sshHost = matchMarkdownValue(productionText, 'IP');
  const regionText = matchMarkdownValue(productionText, 'Region');
  const caddyContainer = detectCaddyContainer(productionText);
  const caddyMode = caddyContainer || mentionsSharedCaddy(productionText) ? 'shared-container' : 'managed-container';
  const network = matchBacktickedAfter(productionText, 'network') || 'agentmesh-web';
  const appDir = detectAppDir(productionText, appName) || detectAppDir(productionText, serviceName) || `/opt/${appName}`;
  const region = normalizeDigitalOceanRegion(regionText);

  return {
    provider: 'digitalocean',
    mode: sshHost ? 'adopt-existing' : 'provision',
    dropletName: hostName || `${appName}-prod`,
    region,
    size: 's-1vcpu-1gb',
    image: 'ubuntu-24-04-x64',
    sshUser: 'root',
    sshPort: 22,
    sshHost,
    appDir,
    network,
    caddyMode,
    caddyContainer: caddyContainer || `${appName}-caddy`,
  };
}

function detectCaddyContainer(productionText) {
  const explicit = matchMarkdownValue(productionText, 'Existing Caddy container');
  if (explicit) return explicit;
  const candidates = [...String(productionText || '').matchAll(/`([A-Za-z0-9_.-]*caddy[A-Za-z0-9_.-]*)`/gi)]
    .map((match) => match[1])
    .filter((name) => !/caddyfile$/i.test(name) && !/^caddy$/i.test(name));
  return candidates[0] || '';
}

function mentionsSharedCaddy(productionText) {
  const text = String(productionText || '');
  return (
    /\bshared\s+Caddy\b/i.test(text) ||
    /\bsingle\s+(?:shared\s+)?Caddy\b/i.test(text) ||
    /\bexisting\s+Caddy\s+container\b/i.test(text) ||
    /do not start (?:a )?second .*Caddy/i.test(text)
  );
}

function detectDns(productionDomain, infrastructure) {
  if (!productionDomain) return { provider: 'manual' };
  const zone = inferDnsZone(productionDomain);
  return {
    provider: 'cloudflare',
    recordType: 'A',
    name: relativeDnsName(productionDomain, zone),
    zone,
    value: infrastructure.sshHost || '',
    proxied: false,
    ttl: 300,
  };
}

function matchMarkdownValue(content, label) {
  const escaped = escapeRegExp(label);
  const match = String(content || '').match(new RegExp(`^-\\s+${escaped}:\\s+(.+)$`, 'im'));
  return match ? stripMarkdownInline(match[1]) : '';
}

function matchBacktickedAfter(content, label) {
  const escaped = escapeRegExp(label);
  const match = String(content || '').match(new RegExp(`${escaped}[^\\n]*\`([A-Za-z0-9_.-]+)\``, 'i'));
  return match?.[1] || '';
}

function stripMarkdownInline(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').replace(/\.$/, '').trim();
}

function detectAppDir(content, name) {
  if (!name) return '';
  const escaped = escapeRegExp(name);
  const match = String(content || '').match(new RegExp(`\`(/opt/${escaped})(?:/data|/work)?\``, 'i'));
  return match?.[1] || '';
}

function normalizeDigitalOceanRegion(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('sgp1') || text.includes('singapore')) return 'sgp1';
  if (text.includes('nyc3') || text.includes('new york')) return 'nyc3';
  if (text.includes('sfo3') || text.includes('san francisco')) return 'sfo3';
  if (text.includes('ams3') || text.includes('amsterdam')) return 'ams3';
  if (text.includes('fra1') || text.includes('frankfurt')) return 'fra1';
  return 'sgp1';
}

function inferDnsZone(hostname) {
  const labels = String(hostname || '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

function relativeDnsName(hostname, zone) {
  if (!hostname || !zone) return hostname || '';
  const suffix = `.${zone}`;
  if (hostname === zone) return '@';
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

function serviceTargetHints(appName, targets = []) {
  return uniqueStrings([
    appName,
    ...targets,
    ...productDomainTokens(appName, targets).map((token) => `${token}-api`),
  ])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function productDomainTokens(appName, targets = []) {
  const generic = new Set(['api', 'app', 'server', 'service', 'worker', 'web']);
  const values = [appName, ...targets].filter(Boolean);
  const tokens = [];
  for (const value of values) {
    const normalized = String(value).toLowerCase().replace(/_/g, '-');
    tokens.push(normalized);
    tokens.push(normalized.replace(/-(server|service|api|worker|web)$/, ''));
    tokens.push(normalized.replace(/-/g, ''));
    for (const part of normalized.split('-')) {
      if (part.length > 2 && !generic.has(part)) tokens.push(part);
    }
  }
  return uniqueStrings(tokens)
    .filter((token) => token.length > 2 && !generic.has(token))
    .sort((a, b) => b.length - a.length);
}

function domainScore(domain, productTokens) {
  const domainKey = domain.replace(/-/g, '');
  let score = 0;
  for (const token of productTokens) {
    const tokenKey = token.replace(/-/g, '');
    if (!tokenKey || tokenKey.length < 3) continue;
    if (domainKey.includes(tokenKey)) score += 40 + Math.min(tokenKey.length, 20);
    if (domain.startsWith(`api.${token}.`) || domain.startsWith(`api.${tokenKey}.`)) score += 25;
  }
  if (domain.startsWith('api.')) score += 12;
  if (domain.startsWith('files.')) score -= 8;
  if (domain.startsWith('cdn.')) score -= 4;
  return score;
}

function ignoredDetectedDomain(domain) {
  return (
    domain === 'example.com' ||
    domain.endsWith('.example.com') ||
    domain === 'github.com' ||
    domain.endsWith('.github.com') ||
    domain === 'localhost.localdomain'
  );
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function parsePyprojectString(content, key) {
  const escaped = escapeRegExp(key);
  const match = String(content || '').match(new RegExp(`^${escaped}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match ? match[1] : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
