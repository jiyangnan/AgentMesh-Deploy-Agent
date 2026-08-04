import { cloudflareActionsForStep, wranglerCommand } from './cloudflare.js';
import { digitaloceanActionsForStep } from './digitalocean.js';
import { githubActionsForStep } from './github.js';
import { cloudflareApiEnvKeys } from '../cloudflare-env.js';

export function actionsForStep(step, manifest) {
  if (step.id === 'preflight') {
    const keys = [
      ...(manifest.env?.required || []),
      ...(manifest.target?.provider === 'cloudflare' ? cloudflareApiEnvKeys(manifest) : []),
      ...domainRegistrationEnvKeys(manifest),
      ...dockerDeploymentEnvKeys(manifest),
    ];
    const anyEnvGroups = dockerDeploymentEnvAnyGroups(manifest);
    return [
      {
        type: 'tool-check',
        tools: buildPreflightTools(manifest),
        effect: 'verify required local command-line tools are available',
        sideEffect: 'read-only',
      },
      {
        type: 'git-tracked-check',
        effect: 'verify sensitive local files are not already tracked by git',
        sideEffect: 'read-only',
      },
      ...(manifest.github?.enabled !== false
        ? [
            {
              type: 'git-identity-check',
              effect: 'verify Git commit identity is configured',
              sideEffect: 'read-only',
            },
          ]
        : []),
      ...(keys.length > 0
        ? [
            {
              type: 'env-check',
              keys: Array.from(new Set(keys)).sort(),
              effect: 'verify required deployment environment variables are present',
              sideEffect: 'read-only',
            },
          ]
        : []),
      ...anyEnvGroups.map((group) => ({
        type: 'env-any-check',
        keys: group.keys,
        effect: group.effect,
        sideEffect: 'read-only',
      })),
      ...sshKeyChecks(manifest),
    ];
  }

  if (step.id === 'production-domain-registration') {
    const registration = manifest.domain?.registration || {};
    if (registration.provider === 'porkbun') {
      return [
        {
          type: 'porkbun-domain-registration',
          root: registration.root || manifest.domain?.root || manifest.domain?.production,
          years: registration.years || 1,
          maxCostUsd: registration.maxCostUsd,
          agreeToTerms: registration.agreeToTerms === true,
          whoisPrivacy: registration.privacy !== false,
          apiKeyEnv: registration.apiKeyEnv || 'PORKBUN_API_KEY',
          secretApiKeyEnv: registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
          effect: `register domain ${registration.root || manifest.domain?.root || manifest.domain?.production} with Porkbun`,
          sideEffect: 'provider-mutation',
          requiresCostApproval: true,
          captures: [
            {
              key: 'domain_registered',
              statePath: 'domain.registration.domain',
              required: true,
            },
            {
              key: 'domain_cost_usd',
              statePath: 'domain.registration.costUsd',
              required: false,
            },
            {
              key: 'domain_order_id',
              statePath: 'domain.registration.orderId',
              required: false,
            },
          ],
          stateUpdates: {
            'domain.registration.provider': 'porkbun',
            'domain.registration.mode': 'register',
          },
        },
      ];
    }
    if (registration.provider === 'cloudflare') {
      const root = registration.root || manifest.domain?.root || manifest.domain?.production;
      const accountIdEnv = cloudflareRegistrarAccountIdEnv(registration, manifest);
      const apiTokenEnv = registration.apiTokenEnv || 'CLOUDFLARE_API_TOKEN';
      return [
        {
          type: 'cloudflare-domain-registration',
          root,
          years: registration.years || 1,
          maxCostUsd: registration.maxCostUsd,
          agreeToTerms: registration.agreeToTerms === true,
          privacyMode: registration.privacy === false ? 'off' : 'redaction',
          autoRenew: registration.autoRenew === true,
          accountIdEnv,
          apiTokenEnv,
          effect: `register domain ${root} with Cloudflare Registrar`,
          sideEffect: 'provider-mutation',
          requiresCostApproval: true,
          captures: [
            {
              key: 'domain_registered',
              statePath: 'domain.registration.domain',
              required: true,
            },
            {
              key: 'domain_cost_usd',
              statePath: 'domain.registration.costUsd',
              required: false,
            },
            {
              key: 'domain_registration_state',
              statePath: 'domain.registration.workflowState',
              required: false,
            },
            {
              key: 'domain_registration_status_url',
              statePath: 'domain.registration.statusUrl',
              required: false,
            },
          ],
          stateUpdates: {
            'domain.registration.provider': 'cloudflare',
            'domain.registration.mode': 'register',
          },
        },
      ];
    }
    return [
      {
        type: 'manual',
        effect: `register domain ${registration.root || manifest.domain?.root || manifest.domain?.production || '<domain>'} with ${registration.provider || 'manual'} registrar`,
        sideEffect: 'provider-mutation',
      },
    ];
  }

  if (step.id === 'porkbun-auth') {
    const registration = manifest.domain?.registration || {};
    return [
      {
        type: 'provider-auth-check',
        provider: 'porkbun',
        command: [
          'node',
          '-e',
          porkbunAuthProbeScript(),
          JSON.stringify({
            apiKeyEnv: registration.apiKeyEnv || 'PORKBUN_API_KEY',
            secretApiKeyEnv: registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
          }),
        ],
        displayCommand: [
          'porkbun-auth-probe',
          `--api-key-env=${registration.apiKeyEnv || 'PORKBUN_API_KEY'}`,
          `--secret-api-key-env=${registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY'}`,
        ],
        envKeys: [
          registration.apiKeyEnv || 'PORKBUN_API_KEY',
          registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
        ],
        effect: 'verify Porkbun API authentication',
        sideEffect: 'read-only',
      },
    ];
  }

  if (step.id === 'production-domain-nameservers') {
    const registration = manifest.domain?.registration || {};
    if (registration.provider === 'porkbun') {
      return [
        {
          type: 'porkbun-nameservers',
          root: registration.root || manifest.domain?.root || manifest.domain?.production,
          nameserversStatePath: 'domain.nameservers',
          apiKeyEnv: registration.apiKeyEnv || 'PORKBUN_API_KEY',
          secretApiKeyEnv: registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
          effect: `bind ${registration.root || manifest.domain?.root || manifest.domain?.production} nameservers to DNS zone`,
          sideEffect: 'provider-mutation',
          captures: [
            {
              key: 'nameservers_bound',
              statePath: 'domain.registration.nameserversBound',
              required: true,
            },
            {
              key: 'domain_nameservers',
              statePath: 'domain.registration.nameservers',
              required: true,
            },
          ],
        },
      ];
    }
    return [];
  }

  if (step.provider === 'cloudflare' || manifest.target?.provider === 'cloudflare') {
    const actions = cloudflareActionsForStep(step, manifest);
    if (actions.length > 0) return actions;
  }

  if (step.provider === 'digitalocean' || manifest.target?.provider === 'digitalocean') {
    const actions = digitaloceanActionsForStep(step, manifest);
    if (actions.length > 0) return actions;
  }

  if (step.provider === 'github' || step.provider === 'git') {
    const actions = githubActionsForStep(step, manifest);
    if (actions.length > 0) return actions;
  }

  if (step.kind === 'command' && step.command) {
    return [
      {
        type: 'command',
        command: step.command,
        ...(typeof step.command === 'string' ? { commandTrust: 'product-manifest' } : {}),
        effect: step.title,
        sideEffect: 'local',
      },
    ];
  }

  if (step.kind === 'verify') {
    return [
      {
        type: 'http-check',
        url: step.url,
        urlStatePath: 'deploymentUrl',
        timeoutMs: 10000,
        effect: 'verify deployed service responds',
        sideEffect: 'read-only',
      },
    ];
  }

  return [];
}

function porkbunAuthProbeScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const apiKeyEnv = payload.apiKeyEnv || 'PORKBUN_API_KEY';
    const secretApiKeyEnv = payload.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    const secretApiKey = process.env[secretApiKeyEnv];
    async function main() {
      if (!apiKey) throw new Error('Missing ' + apiKeyEnv);
      if (!secretApiKey) throw new Error('Missing ' + secretApiKeyEnv);
      const response = await fetch('https://api.porkbun.com/api/json/v3/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: apiKey, secretapikey: secretApiKey }),
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Porkbun returned a non-JSON response');
      }
      if (!response.ok || body.status === 'ERROR' || body.credentialsValid === false) {
        const code = body.code ? body.code + ': ' : '';
        throw new Error(code + (body.message || ('Porkbun auth probe failed: ' + response.status)));
      }
      console.log('porkbun-auth-ok');
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function domainRegistrationEnvKeys(manifest) {
  const registration = manifest.domain?.registration;
  if (registration?.provider === 'cloudflare') {
    return [
      cloudflareRegistrarAccountIdEnv(registration, manifest),
      registration.apiTokenEnv || 'CLOUDFLARE_API_TOKEN',
    ];
  }
  if (registration?.provider !== 'porkbun') return [];
  return [
    registration.apiKeyEnv || 'PORKBUN_API_KEY',
    registration.secretApiKeyEnv || 'PORKBUN_SECRET_API_KEY',
  ];
}

function buildPreflightTools(manifest) {
  const tools = [...runtimeTools(manifest), 'git'];
  if (manifest.github?.enabled !== false) tools.push('gh');
  if (manifest.target?.provider === 'cloudflare') {
    tools.push(wranglerCommand(manifest, ['whoami'])[0]);
  }
  if (domainRegistrationUsesNodeActions(manifest)) {
    tools.push('node');
  }
  if (manifest.target?.type === 'docker-compose-caddy') {
    tools.push(...dockerDeploymentTools(manifest));
    if (dockerDeploymentUsesNodeActions(manifest)) tools.push('node');
  }
  return Array.from(new Set(tools)).sort();
}

function domainRegistrationUsesNodeActions(manifest) {
  return ['cloudflare', 'porkbun'].includes(manifest.domain?.registration?.provider);
}

function dockerDeploymentUsesNodeActions(manifest) {
  return (
    manifest.deployment?.dns?.provider === 'cloudflare' ||
    manifest.domain?.zone?.provider === 'cloudflare' ||
    domainRegistrationUsesNodeActions(manifest)
  );
}

function cloudflareRegistrarAccountIdEnv(registration, manifest) {
  return registration.accountIdEnv || manifest.domain?.zone?.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID';
}

function dockerDeploymentTools(manifest) {
  const tools = ['docker', 'ssh', 'rsync'];
  if (dockerInfrastructureMode(manifest) !== 'adopt-existing') {
    tools.push('doctl');
  }
  return tools;
}

function dockerDeploymentEnvKeys(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return [];
  const keys = [];
  if (manifest.deployment?.dns?.provider === 'cloudflare') {
    keys.push('CLOUDFLARE_API_TOKEN');
  }
  if (manifest.domain?.zone?.provider === 'cloudflare') {
    keys.push(manifest.domain.zone.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID');
    keys.push('CLOUDFLARE_API_TOKEN');
  }
  if (manifest.github?.enabled !== false) {
    keys.push(...dockerGithubSecrets(manifest));
  }
  return keys;
}

function dockerDeploymentEnvAnyGroups(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return [];
  if (dockerInfrastructureMode(manifest) === 'adopt-existing') return [];
  return [
    {
      keys: ['DIGITALOCEAN_SSH_KEY_IDS', 'AGENTMESH_DEPLOY_SSH_PUBLIC_KEY'],
      effect: 'verify DigitalOcean SSH key ids or public key material is available',
    },
  ];
}

function sshKeyChecks(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return [];
  const check = {
    type: 'ssh-key-check',
    identityFileEnv: 'AGENTMESH_DEPLOY_SSH_KEY_PATH',
    privateKeyEnv: 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY',
    effect: 'verify SSH private key material is well-formed',
    sideEffect: 'read-only',
  };
  if (dockerInfrastructureMode(manifest) !== 'adopt-existing') {
    return [
      {
        ...check,
        sshKeysEnv: 'DIGITALOCEAN_SSH_KEY_IDS',
        publicKeyEnv: 'AGENTMESH_DEPLOY_SSH_PUBLIC_KEY',
        effect: 'verify SSH private key and DigitalOcean public key material are well-formed',
      },
    ];
  }
  return [check];
}

function dockerInfrastructureMode(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  return infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
}

function dockerGithubSecrets(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  const keys = ['AGENTMESH_DEPLOY_SSH_PRIVATE_KEY'];
  if (!infrastructure.sshHost && !shouldSourceSshHostFromState(manifest)) keys.push('AGENTMESH_DEPLOY_SSH_HOST');
  if (!infrastructure.sshUser) keys.push('AGENTMESH_DEPLOY_SSH_USER');
  if (!infrastructure.sshPort) keys.push('AGENTMESH_DEPLOY_SSH_PORT');
  if (!infrastructure.appDir) keys.push('AGENTMESH_DEPLOY_APP_DIR');
  return keys;
}

function shouldSourceSshHostFromState(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return false;
  const infrastructure = manifest.deployment?.infrastructure || {};
  const mode = infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
  return !infrastructure.sshHost && mode !== 'adopt-existing';
}

function runtimeTools(manifest) {
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
