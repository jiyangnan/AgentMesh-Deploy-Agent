import crypto from 'node:crypto';

import { actionsForStep } from './adapters/index.js';
import { cloudflareApiEnvKeys } from './cloudflare-env.js';
import { githubRepoTargetMatches } from './tooling.js';
import { nowIso } from './utils.js';

export function buildPlan(manifest, state) {
  const steps = [];
  const commands = manifest.commands || {};
  const target = manifest.target || {};
  const enabledResources = (manifest.resources || []).filter((resource) => resource.enabled !== false);
  const runtimeSecrets = buildRuntimeSecrets(manifest);
  const githubSecrets = buildGithubSecrets(manifest);
  const add = (step) => steps.push(normalizeStep(withActions(step, manifest), state, manifest));
  add({
    id: 'preflight',
    title: 'Check local tools and credentials',
    kind: 'check',
    checks: buildPreflightChecks(manifest),
  });

  if (commands.install) {
    add({
      id: 'install',
      title: 'Install dependencies',
      kind: 'command',
      command: commands.install,
    });
  }

  if (target.type === 'docker-compose-caddy') {
    add({
      id: 'write-docker-caddy-runbook',
      title: 'Write Docker/Caddy deployment handoff files',
      kind: 'file',
      files: dockerCaddyManagedFiles(manifest),
    });
  }

  if (requiresCloudflareAuth(manifest)) {
    add({
      id: 'cloudflare-auth',
      title: 'Verify Cloudflare authentication',
      kind: 'check',
      provider: 'cloudflare',
      checks: cloudflareAuthChecks(manifest),
    });
  }

  if (requiresDigitalOceanAuth(manifest)) {
    add({
      id: 'digitalocean-auth',
      title: 'Verify DigitalOcean authentication',
      kind: 'check',
      provider: 'digitalocean',
      checks: ['doctl account get'],
    });
  }

  if (requiresPorkbunAuth(manifest)) {
    add({
      id: 'porkbun-auth',
      title: 'Verify Porkbun authentication',
      kind: 'check',
      provider: 'porkbun',
      checks: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY', 'Porkbun ping'],
    });
  }

  for (const resource of enabledResources) {
    add({
      id: `resource-${resource.id}`,
      title: `Ensure ${resource.type} resource ${resource.name}`,
      kind: 'resource',
      provider: target.provider,
      resource,
    });
  }

  if (target.type === 'cloudflare-workers') {
    add({
      id: 'write-cloudflare-config',
      title: 'Write Cloudflare deployment config',
      kind: 'file',
      files: cloudflareManagedFiles(manifest),
    });
  }

  if (commands.test) {
    add({
      id: 'test',
      title: 'Run tests',
      kind: 'command',
      command: commands.test,
    });
  }

  if (target.type === 'docker-compose-caddy' && commands.composeConfig) {
    add({
      id: 'docker-compose-config',
      title: 'Validate Docker Compose config',
      kind: 'command',
      command: commands.composeConfig,
    });
  }

  if (commands.migrateLocal) {
    add({
      id: 'migrate-local',
      title: 'Run local database migrations',
      kind: 'command',
      command: commands.migrateLocal,
    });
  }

  if (commands.migrateRemote) {
    add({
      id: 'migrate-remote',
      title: 'Run remote database migrations',
      kind: 'command',
      command: commands.migrateRemote,
    });
  }

  if (commands.build) {
    add({
      id: 'build',
      title: 'Build application',
      kind: 'command',
      command: commands.build,
    });
  }

  if (target.type !== 'docker-compose-caddy' && commands.deploy) {
    add({
      id: 'deploy',
      title: 'Deploy application',
      kind: 'deploy',
      provider: target.provider,
      command: commands.deploy,
    });
  }

  if (target.provider === 'cloudflare' && runtimeSecrets.length > 0) {
    add({
      id: 'sync-worker-secrets',
      title: 'Sync runtime secrets',
      kind: 'secret',
      provider: target.provider,
      secrets: runtimeSecrets,
    });
  }

  if (target.type === 'docker-compose-caddy') {
    addDockerProvisioningSteps(add, manifest, target);
  }

  if (manifest.github?.enabled !== false) {
    add({
      id: 'git-init',
      title: 'Initialize local Git repository',
      kind: 'vcs',
      provider: 'git',
    });

    add({
      id: 'github-auth',
      title: 'Verify GitHub authentication',
      kind: 'check',
      provider: 'github',
      checks: ['gh auth status'],
    });

    add({
      id: 'github-repo',
      title: 'Create or connect GitHub repository',
      kind: 'vcs',
      provider: 'github',
      repo: manifest.github?.repo || manifest.app.id,
      visibility: manifest.github?.visibility || 'private',
    });
  }

  if (manifest.github?.enabled !== false && githubSecrets.length > 0) {
    add({
      id: 'sync-github-secrets',
      title: 'Sync GitHub Actions secrets',
      kind: 'secret',
      provider: 'github',
      repo: manifest.github?.repo || manifest.app.id,
      secrets: githubSecrets,
    });
  }

  if (manifest.github?.enabled !== false) {
    add({
      id: 'commit-and-push',
      title: 'Commit and push deployment baseline',
      kind: 'vcs',
      provider: 'git',
      repo: manifest.github?.repo || manifest.app.id,
      command: 'git add . && git commit -m "chore: initialize AgentMesh deploy" && git push',
    });
  }

  if (target.type === 'docker-compose-caddy') {
    addDockerDeploySteps(add, manifest, target, commands);
  }

  add({
    id: 'verify',
    title: 'Verify deployed service',
    kind: 'verify',
    url: manifest.domain?.production ? `https://${manifest.domain.production}` : state.deploymentUrl || '',
  });

  return withFingerprint({
    version: 1,
    id: `plan-${Date.now()}`,
    createdAt: nowIso(),
    appId: manifest.app.id,
    target,
    steps,
    disabledResources: (manifest.resources || []).filter((resource) => resource.enabled === false),
    summary: summarizeSteps(steps),
  });
}

function requiresCloudflareAuth(manifest) {
  return (
    manifest.target?.provider === 'cloudflare' ||
    manifest.domain?.registration?.provider === 'cloudflare' ||
    manifest.domain?.zone?.provider === 'cloudflare' ||
    manifest.deployment?.dns?.provider === 'cloudflare'
  );
}

function cloudflareAuthChecks(manifest) {
  if (manifest.target?.provider === 'cloudflare') {
    return [...cloudflareApiEnvKeys(manifest), 'wrangler whoami'];
  }
  const accountIdEnv =
    manifest.domain?.registration?.accountIdEnv ||
    manifest.domain?.zone?.accountIdEnv ||
    'CLOUDFLARE_ACCOUNT_ID';
  return [
    ...(manifest.domain?.zone?.provider === 'cloudflare' ||
    manifest.domain?.registration?.provider === 'cloudflare'
      ? [accountIdEnv]
      : []),
    manifest.domain?.registration?.apiTokenEnv || 'CLOUDFLARE_API_TOKEN',
    'Cloudflare API token verify',
  ];
}

function requiresDigitalOceanAuth(manifest) {
  return (
    manifest.target?.type === 'docker-compose-caddy' &&
    (manifest.deployment?.infrastructure?.provider || 'digitalocean') === 'digitalocean' &&
    dockerInfrastructureMode(manifest) !== 'adopt-existing'
  );
}

function requiresPorkbunAuth(manifest) {
  return manifest.domain?.registration?.provider === 'porkbun';
}

export function buildDestroyPlan(manifest, state) {
  const resources = Object.entries(state.resources || {}).map(([id, value]) => ({ id, ...value }));
  const steps = resources
    .slice()
    .reverse()
    .map((resource) =>
      withActions(
        {
          id: `destroy-${resource.id}`,
          title: `Delete ${resource.type || resource.id} resource ${resource.name || resource.providerId || ''}`.trim(),
          kind: 'destroy-resource',
          provider: manifest.target?.provider || resource.provider,
          resource,
          status: 'pending',
        },
        manifest
      )
    );

  return withFingerprint({
    version: 1,
    id: `destroy-${Date.now()}`,
    createdAt: nowIso(),
    appId: manifest.app.id,
    target: manifest.target,
    steps,
    summary: summarizeSteps(steps),
  });
}

export function fingerprintPlan(plan) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(planFingerprintPayload(plan)))
    .digest('hex');
}

function normalizeStep(step, state, manifest) {
  if (step.kind === 'resource' && state.resources?.[step.resource.id]) {
    const resourceStateIssue = describeResourceStateIssue(step.resource, state.resources[step.resource.id]);
    if (resourceStateIssue) {
      return {
        ...step,
        status: 'pending',
        reason: resourceStateIssue,
      };
    }
    return {
      ...step,
      status: 'skipped',
      reason: 'resource already recorded in state',
    };
  }

  const persistentState = describePersistentStepState(step, state, manifest);
  if (persistentState?.status === 'skipped') {
    return {
      ...step,
      status: 'skipped',
      reason: persistentState.reason,
    };
  }
  if (persistentState?.status === 'pending') {
    return {
      ...step,
      status: 'pending',
      reason: persistentState.reason,
    };
  }

  if (
    step.id === 'github-repo' &&
    state.github?.repoUrl
  ) {
    if (!githubRepoTargetMatches(state.github.repoUrl, step.repo || manifest.github?.repo || manifest.app.id)) {
      return {
        ...step,
        status: 'pending',
        reason: 'repository state differs from manifest; connect/create will run',
      };
    }
    return {
      ...step,
      status: 'skipped',
      reason: 'repository already recorded in state',
    };
  }

  return {
    ...step,
    status: 'pending',
  };
}

function describeResourceStateIssue(manifestResource, recordedResource) {
  if (!recordedResource || typeof recordedResource !== 'object') {
    return 'resource state is invalid; ensure/adopt will run';
  }
  if (!recordedResource.providerId) {
    return 'resource state is missing provider id; ensure/adopt will run';
  }
  if (recordedResource.type && recordedResource.type !== manifestResource.type) {
    return 'resource state type differs from manifest; ensure/adopt will run';
  }
  if (recordedResource.name && recordedResource.name !== manifestResource.name) {
    return 'resource state name differs from manifest; ensure/adopt will run';
  }
  return '';
}

function describePersistentStepState(step, state, manifest) {
  if (step.id === 'digitalocean-ssh-key') {
    return describeDigitalOceanSshKeyState(state);
  }
  if (step.id === 'production-host') {
    return describeProductionHostState(state, manifest);
  }
  if (step.id === 'production-domain-registration') {
    return describeDomainRegistrationState(state, manifest);
  }
  if (step.id === 'production-dns-zone') {
    return describeDnsZoneState(state, manifest);
  }
  if (step.id === 'production-domain-nameservers') {
    return describeDomainNameserverState(state);
  }
  if (step.id === 'production-dns') {
    return describeProductionDnsState(state, manifest);
  }
  return null;
}

function describeDigitalOceanSshKeyState(state) {
  const infrastructure = state.infrastructure || {};
  if (infrastructure.sshKeyIds) {
    return {
      status: 'skipped',
      reason: 'DigitalOcean SSH key already recorded in state',
    };
  }
  if (infrastructure.sshKeyFingerprint) {
    return {
      status: 'pending',
      reason: 'DigitalOcean SSH key state is missing sshKeyIds; ensure/import will run',
    };
  }
  return null;
}

function describeProductionHostState(state, manifest) {
  if (dockerInfrastructureMode(manifest) === 'adopt-existing') return null;
  const infrastructure = state.infrastructure || {};
  const hasAny = Boolean(infrastructure.hostId || infrastructure.sshHost || infrastructure.publicIp);
  if (!hasAny) return null;

  if (infrastructure.hostId && infrastructure.sshHost && infrastructure.publicIp) {
    return {
      status: 'skipped',
      reason: 'production host already recorded in state',
    };
  }

  return {
    status: 'pending',
    reason: 'production host state is incomplete; ensure/adopt will run',
  };
}

function describeDomainRegistrationState(state, manifest) {
  const expectedRoot = domainRegistrationRoot(manifest);
  const registration = state.domain?.registration || {};
  if (!registration.domain && !registration.orderId) return null;
  if (registration.domain && sameHostname(registration.domain, expectedRoot)) {
    return {
      status: 'skipped',
      reason: 'domain registration already recorded in state',
    };
  }
  if (registration.domain) {
    return {
      status: 'pending',
      reason: 'domain registration state differs from manifest; register/adopt will run',
    };
  }
  return {
    status: 'pending',
    reason: 'domain registration state is missing registered domain; register/adopt will run',
  };
}

function describeDnsZoneState(state, manifest) {
  const domain = state.domain || {};
  if (!domain.zoneId) {
    if (domain.nameservers) {
      return {
        status: 'pending',
        reason: 'DNS zone state is missing zoneId; ensure/adopt will run',
      };
    }
    return null;
  }

  if (requiresCapturedNameservers(manifest) && nameserverList(domain.nameservers).length < 2) {
    return {
      status: 'pending',
      reason: 'DNS zone state is missing nameservers; ensure/adopt will run',
    };
  }

  return {
    status: 'skipped',
    reason: 'DNS zone already recorded in state',
  };
}

function describeDomainNameserverState(state) {
  const registration = state.domain?.registration || {};
  if (truthyStateValue(registration.nameserversBound)) {
    return {
      status: 'skipped',
      reason: 'registrar nameservers already recorded in state',
    };
  }
  if (registration.nameservers) {
    return {
      status: 'pending',
      reason: 'registrar nameserver state is missing bound marker; bind/adopt will run',
    };
  }
  return null;
}

function describeProductionDnsState(state, manifest) {
  const dns = state.dns?.production || {};
  if (!dns.recordId && !dns.target && !dns.hostname) return null;

  const expectedHostname = productionDomain(manifest);
  const expectedTarget = productionDnsTarget(state, manifest);
  if (!dns.recordId) {
    return {
      status: 'pending',
      reason: 'production DNS state is missing recordId; upsert will run',
    };
  }
  if (expectedHostname && !dns.hostname) {
    return {
      status: 'pending',
      reason: 'production DNS state is missing hostname; upsert will run',
    };
  }
  if (expectedHostname && dns.hostname && !sameHostname(dns.hostname, expectedHostname)) {
    return {
      status: 'pending',
      reason: 'production DNS hostname differs from manifest; upsert will run',
    };
  }
  if (!dns.target) {
    return {
      status: 'pending',
      reason: 'production DNS state is missing target; upsert will run',
    };
  }
  if (expectedTarget && String(dns.target) !== String(expectedTarget)) {
    return {
      status: 'pending',
      reason: 'production DNS target differs from current host state; upsert will run',
    };
  }
  if (!expectedTarget) return null;

  return {
    status: 'skipped',
    reason: 'production DNS record already recorded in state',
  };
}

function withActions(step, manifest) {
  return {
    ...step,
    actions: actionsForStep(step, manifest),
  };
}

function cloudflareManagedFiles(manifest) {
  return [
    'wrangler.jsonc',
    '.env',
    '.env.production',
    '.gitignore',
    '.agentmesh-deploy/RUNBOOK.md',
    ...(manifest.github?.enabled === false ? [] : ['.github/workflows/deploy.yml']),
  ];
}

function dockerCaddyManagedFiles(manifest) {
  return [
    '.env',
    '.gitignore',
    '.agentmesh-deploy/RUNBOOK.md',
    ...(manifest.github?.enabled === false ? [] : ['.github/workflows/deploy.yml']),
  ];
}

function addDockerDomainSetupSteps(add, manifest) {
  if (manifest.domain?.production) {
    if (manifest.domain?.registration?.mode === 'register') {
      add({
        id: 'production-domain-registration',
        title: 'Register production root domain',
        kind: 'domain-registration',
        provider: manifest.domain.registration.provider || 'manual',
      });
    }

    if (manifest.domain?.zone?.provider === 'cloudflare') {
      add({
        id: 'production-dns-zone',
        title: 'Ensure Cloudflare DNS zone',
        kind: 'dns-zone',
        provider: 'cloudflare',
      });
    }

    if (
      manifest.domain?.registration?.provider === 'porkbun' &&
      manifest.domain?.zone?.provider === 'cloudflare'
    ) {
      add({
        id: 'production-domain-nameservers',
        title: 'Bind registrar nameservers to DNS zone',
        kind: 'domain-nameservers',
        provider: 'porkbun',
      });
    }
  }
}

function addDockerProvisioningSteps(add, manifest, target) {
  const domainBeforeHost = dockerInfrastructureMode(manifest) === 'provision';
  if (domainBeforeHost) {
    addDockerDomainSetupSteps(add, manifest);
  }

  if (requiresDigitalOceanSshKey(manifest)) {
    add({
      id: 'digitalocean-ssh-key',
      title: 'Ensure DigitalOcean SSH key',
      kind: 'infrastructure',
      provider: 'digitalocean',
    });
  }

  add({
    id: 'production-host',
    title: 'Ensure or adopt production host',
    kind: 'infrastructure',
    provider: target.provider,
  });

  if (!domainBeforeHost) {
    addDockerDomainSetupSteps(add, manifest);
  }

  if (manifest.domain?.production) {
    add({
      id: 'production-dns',
      title: 'Ensure production DNS record',
      kind: 'dns',
      provider: manifest.deployment?.dns?.provider || 'manual',
    });
  }
}

function addDockerDeploySteps(add, manifest, target, commands) {
  const adoptExisting = dockerInfrastructureMode(manifest) === 'adopt-existing';
  add({
    id: 'production-host-bootstrap',
    title: adoptExisting
      ? 'Verify existing production host runtime'
      : 'Bootstrap production host runtime',
    kind: 'deploy',
    provider: target.provider,
  });

  add({
    id: 'sync-production-files',
    title: 'Sync product files to production host',
    kind: 'deploy',
    provider: target.provider,
  });

  add({
    id: 'remote-compose-deploy',
    title: 'Deploy Docker Compose service on production host',
    kind: 'deploy',
    provider: target.provider,
    command: commands.deploy || '',
  });

  add({
    id: 'reload-production-caddy',
    title: 'Update production Caddy entrypoint',
    kind: 'deploy',
    provider: target.provider,
  });
}

function buildPreflightChecks(manifest) {
  const checks = [...runtimeChecks(manifest), 'git'];
  if (manifest.github?.enabled !== false) checks.push('gh');
  if (manifest.target?.provider === 'cloudflare') {
    checks.push(wranglerEntrypoint(manifest), ...cloudflareApiEnvKeys(manifest));
  }
  if (manifest.target?.type === 'docker-compose-caddy') {
    checks.push(...dockerDeploymentTools(manifest));
    if (manifest.domain?.zone?.provider === 'cloudflare') {
      checks.push(manifest.domain.zone.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN');
    } else if (manifest.deployment?.dns?.provider === 'cloudflare') {
      checks.push('CLOUDFLARE_API_TOKEN');
    }
    if (dockerInfrastructureMode(manifest) !== 'adopt-existing') {
      checks.push('DIGITALOCEAN_SSH_KEY_IDS or AGENTMESH_DEPLOY_SSH_PUBLIC_KEY');
    }
  }
  return Array.from(new Set(checks)).sort();
}

function requiresDigitalOceanSshKey(manifest) {
  return (
    manifest.target?.type === 'docker-compose-caddy' &&
    (manifest.deployment?.infrastructure?.provider || 'digitalocean') === 'digitalocean' &&
    dockerInfrastructureMode(manifest) !== 'adopt-existing'
  );
}

function dockerDeploymentTools(manifest) {
  const tools = ['docker', 'ssh', 'rsync'];
  if (dockerInfrastructureMode(manifest) !== 'adopt-existing') {
    tools.push('doctl');
  }
  return tools;
}

function dockerInfrastructureMode(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  return infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
}

function productionDomain(manifest) {
  return manifest.domain?.production || manifest.deployment?.productionDomain || '';
}

function domainRegistrationRoot(manifest) {
  return (
    manifest.domain?.registration?.root ||
    manifest.domain?.root ||
    rootDomainFromHostname(productionDomain(manifest))
  );
}

function productionDnsTarget(state, manifest) {
  const dns = manifest.deployment?.dns || {};
  const infrastructure = manifest.deployment?.infrastructure || {};
  return state.infrastructure?.publicIp || state.infrastructure?.sshHost || dns.value || infrastructure.sshHost || '';
}

function requiresCapturedNameservers(manifest) {
  return (
    manifest.domain?.registration?.provider === 'porkbun' &&
    manifest.domain?.zone?.provider === 'cloudflare'
  );
}

function nameserverList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function truthyStateValue(value) {
  return value === true || ['true', 'yes', '1', 'ok'].includes(String(value || '').toLowerCase());
}

function sameHostname(left, right) {
  return normalizeHostname(left) === normalizeHostname(right);
}

function normalizeHostname(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase();
}

function rootDomainFromHostname(hostname) {
  const labels = normalizeHostname(hostname).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

function runtimeChecks(manifest) {
  const packageManager = manifest.runtime?.packageManager || 'npm';
  if (manifest.runtime?.type === 'python') {
    if (packageManager === 'pip') return [pythonRuntimeTool(manifest)];
    return [packageManager].filter(Boolean);
  }
  return ['node', packageManager];
}

function pythonRuntimeTool(manifest) {
  const commands = [
    manifest.commands?.install,
    manifest.commands?.test,
    manifest.commands?.build,
    manifest.commands?.deploy,
  ];
  for (const command of commands) {
    const match = String(command || '').match(/^(python3|python)\b/);
    if (match) return match[1];
  }
  return 'python3';
}

function wranglerEntrypoint(manifest) {
  const packageManager = manifest.runtime?.packageManager || 'npm';
  if (packageManager === 'pnpm') return 'pnpm';
  if (packageManager === 'bun') return 'bunx';
  if (packageManager === 'yarn') return 'yarn';
  return 'npx';
}

function buildRuntimeSecrets(manifest) {
  return [
    ...(manifest.env?.required || []).map((key) => ({ key, source: 'env' })),
    ...(manifest.env?.generated || []).map((key) => ({
      key,
      source: 'managed-env',
      file: '.env.production',
    })),
  ];
}

function buildGithubSecrets(manifest) {
  const explicit = Array.isArray(manifest.github?.actionsSecrets)
    ? manifest.github.actionsSecrets
    : null;
  const provider = manifest.target?.provider === 'cloudflare'
    ? ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
    : [];
  const generated = manifest.env?.generated || [];
  const required = explicit !== null ? explicit : manifest.env?.required || [];
  const secrets = [];
  for (const key of required) {
    upsertGithubSecret(secrets, githubSecretForKey(manifest, key, generated));
  }
  for (const key of provider) {
    upsertGithubSecret(secrets, { key, source: 'env' });
  }
  for (const secret of dockerGithubSecrets(manifest)) {
    upsertGithubSecret(secrets, secret);
  }
  for (const key of generated) {
    upsertGithubSecret(secrets, { key, source: 'managed-env', file: '.env.production' });
  }
  return secrets;
}

function dockerGithubSecrets(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return [];
  if (manifest.github?.enabled === false) return [];
  const infrastructure = manifest.deployment?.infrastructure || {};
  const secrets = [{ key: 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY', source: 'env' }];
  if (!infrastructure.sshHost) {
    secrets.push(dynamicSshHostSecret(manifest));
  }
  if (!infrastructure.sshUser) secrets.push({ key: 'AGENTMESH_DEPLOY_SSH_USER', source: 'env' });
  if (!infrastructure.sshPort) secrets.push({ key: 'AGENTMESH_DEPLOY_SSH_PORT', source: 'env' });
  if (!infrastructure.appDir) secrets.push({ key: 'AGENTMESH_DEPLOY_APP_DIR', source: 'env' });
  return secrets;
}

function githubSecretForKey(manifest, key, generated) {
  if (generated.includes(key)) {
    return { key, source: 'managed-env', file: '.env.production' };
  }
  if (key === 'AGENTMESH_DEPLOY_SSH_HOST' && shouldSourceSshHostFromState(manifest)) {
    return dynamicSshHostSecret(manifest);
  }
  return { key, source: 'env' };
}

function dynamicSshHostSecret(manifest) {
  return shouldSourceSshHostFromState(manifest)
    ? { key: 'AGENTMESH_DEPLOY_SSH_HOST', source: 'state', statePath: 'infrastructure.sshHost' }
    : { key: 'AGENTMESH_DEPLOY_SSH_HOST', source: 'env' };
}

function shouldSourceSshHostFromState(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return false;
  const infrastructure = manifest.deployment?.infrastructure || {};
  const mode = infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
  return !infrastructure.sshHost && mode !== 'adopt-existing';
}

function upsertGithubSecret(secrets, secret) {
  if (!secret?.key) return;
  const existingIndex = secrets.findIndex((item) => item.key === secret.key);
  if (existingIndex === -1) {
    secrets.push(secret);
    return;
  }
  if (githubSecretSourceRank(secret) > githubSecretSourceRank(secrets[existingIndex])) {
    secrets[existingIndex] = secret;
  }
}

function githubSecretSourceRank(secret) {
  if (secret.source === 'state') return 3;
  if (secret.source === 'managed-env') return 2;
  return 1;
}

function summarizeSteps(steps) {
  const pending = steps.filter((step) => step.status === 'pending').length;
  const skipped = steps.filter((step) => step.status === 'skipped').length;
  return {
    total: steps.length,
    pending,
    skipped,
  };
}

function withFingerprint(plan) {
  return {
    ...plan,
    fingerprint: fingerprintPlan(plan),
  };
}

function planFingerprintPayload(plan) {
  return stripVolatilePlanFields(plan, []);
}

function stripVolatilePlanFields(value, path) {
  if (Array.isArray(value)) {
    return value.map((child, index) => stripVolatilePlanFields(child, [...path, String(index)]));
  }
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'fingerprint') continue;
    if (path.length === 0 && (key === 'id' || key === 'createdAt')) continue;
    next[key] = stripVolatilePlanFields(child, [...path, key]);
  }
  return next;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
