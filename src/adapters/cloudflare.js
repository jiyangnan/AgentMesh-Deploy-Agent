export function cloudflareActionsForStep(step, manifest) {
  if (step.id === 'cloudflare-auth') {
    if (manifest.target?.provider !== 'cloudflare') {
      const registration = manifest.domain?.registration || {};
      const zoneName =
        manifest.domain?.zone?.name ||
        manifest.deployment?.dns?.zone ||
        manifest.domain?.root ||
        zoneFromProductionDomain(manifest.domain?.production);
      const requireAccount = registration.provider === 'cloudflare';
      const accountIdEnv =
        registration.accountIdEnv || manifest.domain?.zone?.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID';
      const apiTokenEnv = registration.apiTokenEnv || 'CLOUDFLARE_API_TOKEN';
      return [
        {
          type: 'provider-auth-check',
          provider: 'cloudflare',
          command: [
            'node',
            '-e',
            cloudflareApiAuthProbeScript(),
            JSON.stringify({
              apiTokenEnv,
              accountIdEnv,
              requireAccount,
              zoneName: requireAccount ? '' : zoneName,
            }),
          ],
          displayCommand: [
            'cloudflare-auth-probe',
            `--api-token-env=${apiTokenEnv}`,
            ...(!requireAccount && zoneName ? [`--zone=${zoneName}`] : []),
            ...(requireAccount ? [`--account-id-env=${accountIdEnv}`] : []),
          ],
          envKeys: [...(requireAccount ? [accountIdEnv] : []), apiTokenEnv],
          effect: 'verify Cloudflare API token and required zone/account access',
          sideEffect: 'read-only',
        },
      ];
    }

    return [
      {
        type: 'provider-auth-check',
        provider: 'cloudflare',
        command: wranglerCommand(manifest, ['whoami']),
        failurePatterns: [
          'You are not authenticated',
          'Please run `wrangler login`',
          'Please run wrangler login',
        ],
        effect: 'verify Cloudflare token and account access',
        sideEffect: 'read-only',
      },
    ];
  }

  if (step.kind === 'resource' && step.provider === 'cloudflare') {
    return resourceActions(step.resource, manifest);
  }

  if (step.id === 'production-dns-zone' && step.provider === 'cloudflare') {
    return [
      {
        type: 'cloudflare-zone',
        zoneName: manifest.domain?.zone?.name || manifest.domain?.root || zoneFromProductionDomain(manifest.domain?.production),
        accountIdEnv: manifest.domain?.zone?.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID',
        effect: `ensure Cloudflare DNS zone ${manifest.domain?.zone?.name || manifest.domain?.root || '<zone>'}`,
        sideEffect: 'provider-mutation',
        envKeys: [
          manifest.domain?.zone?.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID',
          'CLOUDFLARE_API_TOKEN',
        ],
        captures: [
          {
            key: 'cloudflare_zone_id',
            statePath: 'domain.zoneId',
            required: true,
          },
          {
            key: 'cloudflare_nameservers',
            statePath: 'domain.nameservers',
            required: false,
          },
        ],
      },
    ];
  }

  if (step.id === 'write-cloudflare-config') {
    const actions = [
      {
        type: 'file',
        path: 'wrangler.jsonc',
        effect: 'upsert Worker name, D1, R2, KV, and optional custom-domain bindings',
        sideEffect: 'filesystem',
      },
      {
        type: 'file',
        path: '.env',
        effect: 'upsert local development env values from manifest and created resources',
        sideEffect: 'filesystem',
      },
      {
        type: 'file',
        path: '.env.production',
        effect: 'upsert production env values from manifest and created resources',
        sideEffect: 'filesystem',
      },
      {
        type: 'file',
        path: '.gitignore',
        effect: 'upsert deployment-safe ignore rules',
        sideEffect: 'filesystem',
      },
      {
        type: 'file',
        path: '.agentmesh-deploy/RUNBOOK.md',
        effect: 'upsert AI deployment handoff runbook',
        sideEffect: 'filesystem',
      },
    ];
    if (manifest.github?.enabled !== false) {
      actions.push({
        type: 'file',
        path: '.github/workflows/deploy.yml',
        effect: 'upsert GitHub Actions deployment workflow',
        sideEffect: 'filesystem',
      });
    }
    return actions;
  }

  if (step.kind === 'deploy' && step.provider === 'cloudflare') {
    return [
      {
        type: 'command',
        command: step.command,
        ...(typeof step.command === 'string' ? { commandTrust: 'product-manifest' } : {}),
        effect: 'build and deploy Cloudflare Worker',
        sideEffect: 'provider-mutation',
        captures: [
          {
            key: 'deployment_url',
            statePath: 'deploymentUrl',
            required: !manifest.domain?.production,
          },
        ],
      },
    ];
  }

  if (step.kind === 'secret' && step.provider === 'cloudflare') {
    if (step.command) {
      return [
        {
          type: 'command',
          command: step.command,
          ...(typeof step.command === 'string' ? { commandTrust: 'product-manifest' } : {}),
          effect: 'sync runtime secrets using project script',
          sideEffect: 'provider-mutation',
          redactOutput: true,
        },
      ];
    }

    return (step.secrets || []).map((secret) => secretAction(secret, manifest));
  }

  if (step.kind === 'destroy-resource' && step.provider === 'cloudflare') {
    return destroyResourceActions(step.resource, manifest);
  }

  return [];
}

function cloudflareApiAuthProbeScript() {
  return `
    const payload = JSON.parse(process.argv[1] || '{}');
    const apiTokenEnv = payload.apiTokenEnv || 'CLOUDFLARE_API_TOKEN';
      const token = process.env[apiTokenEnv];
      const accountIdEnv = payload.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID';
      const accountId = process.env[accountIdEnv];
      const zoneName = payload.zoneName;
    const base = 'https://api.cloudflare.com/client/v4';
    async function request(path) {
      const response = await fetch(base + path, {
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || 'Cloudflare returned a non-JSON response');
      }
      if (!response.ok || body.success === false) {
        const message = (body.errors || []).map((error) => error.message).filter(Boolean).join('; ');
        throw new Error(message || ('Cloudflare auth probe failed: ' + response.status));
      }
      return body;
    }
    async function main() {
      if (!token) throw new Error('Missing ' + apiTokenEnv);
      await request('/user/tokens/verify');
      if (payload.requireAccount) {
        if (!accountId) throw new Error('Missing ' + accountIdEnv);
        await request('/accounts/' + encodeURIComponent(accountId));
      } else if (zoneName) {
        const zones = await request('/zones?name=' + encodeURIComponent(zoneName));
        if (!zones.result || !zones.result[0]) throw new Error('Cloudflare zone not found: ' + zoneName);
      }
      console.log('cloudflare-auth-ok');
    }
    main().catch((error) => {
      console.error(error.message || String(error));
      process.exit(1);
    });
  `;
}

function zoneFromProductionDomain(hostname) {
  const labels = String(hostname || '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

function secretAction(secret, manifest) {
  const key = typeof secret === 'string' ? secret : secret.key;
  const action = {
    type: 'command',
    command: wranglerCommand(manifest, ['secret', 'put', key]),
    effect: `sync Worker secret ${key}`,
    sideEffect: 'provider-mutation',
    secret: key,
    redactOutput: true,
  };

  if (secret.source === 'managed-env') {
    return {
      ...action,
      stdinFromManagedEnvFile: {
        file: secret.file || '.env.production',
        key,
      },
    };
  }

  return {
    ...action,
    stdinFromEnv: key,
  };
}

export function wranglerCommand(manifest, args) {
  const packageManager = manifest.runtime?.packageManager || 'npm';
  if (packageManager === 'pnpm') return ['pnpm', 'exec', 'wrangler', ...args];
  if (packageManager === 'bun') return ['bunx', 'wrangler', ...args];
  if (packageManager === 'yarn') return ['yarn', 'wrangler', ...args];
  return ['npx', 'wrangler', ...args];
}

function resourceActions(resource, manifest) {
  if (resource.type === 'cloudflare.d1') {
    return [
      {
        type: 'cloudflare-resource',
        resource,
        listCommand: wranglerCommand(manifest, ['d1', 'list', '--json']),
        createCommand: wranglerCommand(manifest, ['d1', 'create', resource.name, '--update-config=false']),
        effect: `ensure D1 database ${resource.name}`,
        sideEffect: 'provider-mutation',
        captures: [
          {
            key: 'database_id',
            statePath: `resources.${resource.id}.providerId`,
            required: true,
          },
        ],
      },
    ];
  }

  if (resource.type === 'cloudflare.r2') {
    return [
      {
        type: 'cloudflare-resource',
        resource,
        listCommand: wranglerCommand(manifest, ['r2', 'bucket', 'list']),
        createCommand: wranglerCommand(manifest, ['r2', 'bucket', 'create', resource.name, '--update-config=false']),
        effect: `ensure R2 bucket ${resource.name}`,
        sideEffect: 'provider-mutation',
        captures: [
          {
            key: 'provider_id',
            statePath: `resources.${resource.id}.providerId`,
            required: true,
          },
        ],
      },
    ];
  }

  if (resource.type === 'cloudflare.kv') {
    return [
      {
        type: 'cloudflare-resource',
        resource,
        listCommand: wranglerCommand(manifest, ['kv', 'namespace', 'list']),
        createCommand: wranglerCommand(manifest, ['kv', 'namespace', 'create', resource.name, '--update-config=false']),
        effect: `ensure KV namespace ${resource.name}`,
        sideEffect: 'provider-mutation',
        captures: [
          {
            key: 'id',
            statePath: `resources.${resource.id}.providerId`,
            required: true,
          },
        ],
      },
    ];
  }

  return [
    {
      type: 'manual',
      effect: `no Cloudflare adapter is available for ${resource.type}`,
      sideEffect: 'unknown',
    },
  ];
}

function destroyResourceActions(resource, manifest) {
  if (resource.type === 'cloudflare.d1') {
    return [
      {
        type: 'command',
        command: wranglerCommand(manifest, ['d1', 'delete', resource.name, '--skip-confirmation']),
        effect: `delete D1 database ${resource.name}`,
        sideEffect: 'provider-delete',
      },
    ];
  }

  if (resource.type === 'cloudflare.r2') {
    return [
      {
        type: 'manual',
        effect: `empty R2 bucket ${resource.name} before deletion`,
        sideEffect: 'provider-delete',
      },
      {
        type: 'command',
        command: wranglerCommand(manifest, ['r2', 'bucket', 'delete', resource.name]),
        effect: `delete R2 bucket ${resource.name}`,
        sideEffect: 'provider-delete',
      },
    ];
  }

  if (resource.type === 'cloudflare.kv') {
    return [
      {
        type: 'command',
        command: wranglerCommand(manifest, [
          'kv',
          'namespace',
          'delete',
          '--namespace-id',
          resource.providerId || resource.name,
          '--skip-confirmation',
        ]),
        effect: `delete KV namespace ${resource.name || resource.providerId}`,
        sideEffect: 'provider-delete',
      },
    ];
  }

  return [];
}
