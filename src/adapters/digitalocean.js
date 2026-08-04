import {
  PRODUCTION_ENV_RSYNC_EXCLUDES,
  PRODUCTION_ENV_RSYNC_INCLUDES,
  STAGED_RUNTIME_ENV_PATH,
  productionEnvActivationCommand,
} from '../production-env.js';

export function digitaloceanActionsForStep(step, manifest) {
  if (step.id === 'digitalocean-auth') {
    return [
      {
        type: 'provider-auth-check',
        provider: 'digitalocean',
        command: ['doctl', 'account', 'get'],
        effect: 'verify DigitalOcean CLI authentication',
        sideEffect: 'read-only',
      },
    ];
  }

  if (step.id === 'write-docker-caddy-runbook') {
    return [
      {
        type: 'file',
        path: '.env',
        effect: 'upsert production Docker Compose env file from manifest and shell env',
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
      ...(manifest.github?.enabled === false
        ? []
        : [
            {
              type: 'file',
              path: '.github/workflows/deploy.yml',
              effect: 'upsert SSH-based GitHub Actions deployment workflow',
              sideEffect: 'filesystem',
            },
          ]),
    ];
  }

  if (step.id === 'docker-compose-config' && step.command) {
    return [
      {
        type: 'command',
        command: step.command,
        ...(typeof step.command === 'string' ? { commandTrust: 'product-manifest' } : {}),
        effect: 'validate Docker Compose production config',
        sideEffect: 'read-only',
      },
    ];
  }

  if (step.id === 'production-host') {
    return productionHostActions(manifest);
  }

  if (step.id === 'digitalocean-ssh-key') {
    return productionSshKeyActions(manifest);
  }

  if (step.id === 'production-dns') {
    return productionDnsActions(manifest);
  }

  if (step.id === 'production-host-bootstrap') {
    return productionHostBootstrapActions(manifest);
  }

  if (step.id === 'sync-production-files') {
    return syncProductionFilesActions(manifest);
  }

  if (step.id === 'remote-compose-deploy') {
    return remoteComposeDeployActions(manifest, step);
  }

  if (step.id === 'reload-production-caddy') {
    return reloadProductionCaddyActions(manifest);
  }

  return [];
}

function productionHostActions(manifest) {
  const infrastructure = deploymentInfrastructure(manifest);
  if (infrastructure.mode === 'adopt-existing' && infrastructure.sshHost) {
    return [
      {
        type: 'ssh-command',
        host: infrastructure.sshHost,
        user: infrastructure.sshUser,
        port: infrastructure.sshPort,
        remoteCommand: 'hostname && docker --version && docker compose version',
        effect: `verify existing production host ${infrastructure.dropletName || infrastructure.sshHost}`,
        sideEffect: 'read-only',
        ...sshIdentityFields(),
        ...sshRetryPolicy({ attempts: 3, delayMs: 5000 }),
        stateUpdates: {
          'infrastructure.provider': infrastructure.provider,
          'infrastructure.dropletName': infrastructure.dropletName,
          'infrastructure.sshHost': infrastructure.sshHost,
          'infrastructure.publicIp': infrastructure.sshHost,
        },
      },
    ];
  }

  return [
    {
      type: 'digitalocean-droplet',
      dropletName: infrastructure.dropletName,
      region: infrastructure.region,
      size: infrastructure.size,
      image: infrastructure.image,
      sshKeysEnv: 'DIGITALOCEAN_SSH_KEY_IDS',
      sshKeysStatePath: 'infrastructure.sshKeyIds',
      effect: `ensure DigitalOcean droplet ${infrastructure.dropletName}`,
      sideEffect: 'provider-mutation',
      requiresCostApproval: true,
      stateUpdates: {
        'infrastructure.provider': infrastructure.provider,
        'infrastructure.dropletName': infrastructure.dropletName,
        'infrastructure.region': infrastructure.region,
      },
      captures: [
        {
          key: 'droplet_id',
          statePath: 'infrastructure.hostId',
          required: true,
        },
        {
          key: 'droplet_ip',
          statePath: 'infrastructure.sshHost',
          required: true,
        },
        {
          key: 'droplet_ip',
          statePath: 'infrastructure.publicIp',
          required: true,
        },
      ],
    },
  ];
}

function productionSshKeyActions(manifest) {
  const infrastructure = deploymentInfrastructure(manifest);
  if (infrastructure.mode === 'adopt-existing') return [];
  return [
    {
      type: 'digitalocean-ssh-key',
      keyName: infrastructure.sshKeyName,
      sshKeysEnv: 'DIGITALOCEAN_SSH_KEY_IDS',
      publicKeyEnv: 'AGENTMESH_DEPLOY_SSH_PUBLIC_KEY',
      effect: `ensure DigitalOcean SSH key ${infrastructure.sshKeyName}`,
      sideEffect: 'provider-mutation',
      captures: [
        {
          key: 'digitalocean_ssh_key_ids',
          statePath: 'infrastructure.sshKeyIds',
          required: true,
        },
        {
          key: 'digitalocean_ssh_key_fingerprint',
          statePath: 'infrastructure.sshKeyFingerprint',
          required: false,
        },
      ],
    },
  ];
}

function productionDnsActions(manifest) {
  const dns = deploymentDns(manifest);
  const domain = manifest.domain?.production || manifest.deployment?.productionDomain || '';
  if (!domain || dns.provider === 'manual') {
    return [
      {
        type: 'manual',
        effect: `ensure ${dns.recordType || 'A'} record for ${domain || '<production-domain>'}`,
        sideEffect: 'provider-mutation',
      },
    ];
  }

  if (dns.provider !== 'cloudflare') return [];

  return [
    {
      type: 'cloudflare-dns-record',
      zone: dns.zone,
      zoneIdStatePath: 'domain.zoneId',
      recordType: dns.recordType || 'A',
      name: fqdnFromDnsName(dns.name, dns.zone, domain),
      value: dns.value || deploymentInfrastructure(manifest).sshHost || '',
      valueStatePath: 'infrastructure.publicIp',
      proxied: dns.proxied === true,
      ttl: dns.ttl || 300,
      envKeys: ['CLOUDFLARE_API_TOKEN'],
      effect: `ensure DNS record ${domain} points at production host`,
      sideEffect: 'provider-mutation',
      captures: [
        {
          key: 'dns_record_id',
          statePath: 'dns.production.recordId',
          required: true,
        },
        {
          key: 'dns_record_target',
          statePath: 'dns.production.target',
          required: true,
        },
      ],
      stateUpdates: {
        'dns.production.hostname': domain,
      },
    },
  ];
}

function productionHostBootstrapActions(manifest) {
  const infrastructure = deploymentInfrastructure(manifest);
  if (infrastructure.mode === 'adopt-existing') {
    return [
      sshAction(manifest, {
        remoteCommand: adoptedHostRuntimeValidationCommand(infrastructure),
        effect: `verify existing Docker runtime, network ${infrastructure.network}, and shared ingress dependencies`,
        sideEffect: 'read-only',
        ...sshRetryPolicy({ attempts: 3, delayMs: 5000 }),
      }),
    ];
  }

  const remoteCommand = [
    'set -e',
    dockerInstallCommand(),
    `mkdir -p ${shellQuote(infrastructure.appDir)}`,
    `docker network inspect ${shellQuote(infrastructure.network)} >/dev/null 2>&1 || docker network create ${shellQuote(infrastructure.network)}`,
    ...(infrastructure.caddyMode === 'shared-container' && infrastructure.caddyContainer
      ? [
          `docker network connect ${shellQuote(infrastructure.network)} ${shellQuote(infrastructure.caddyContainer)} >/dev/null 2>&1 || true`,
        ]
      : []),
  ].join('; ');

  return [
    sshAction(manifest, {
      remoteCommand,
      effect: `install Docker if missing, prepare ${infrastructure.appDir}, and ensure Docker network ${infrastructure.network}`,
      sideEffect: 'provider-mutation',
      ...sshRetryPolicy({ attempts: 18, delayMs: 10000 }),
    }),
  ];
}

function adoptedHostRuntimeValidationCommand(infrastructure) {
  const commands = [
    'set -e',
    'command -v docker >/dev/null 2>&1',
    'docker --version',
    'docker compose version',
    `docker network inspect ${shellQuote(infrastructure.network)} >/dev/null`,
  ];
  if (infrastructure.caddyMode === 'shared-container' && infrastructure.caddyContainer) {
    commands.push(
      `docker container inspect ${shellQuote(infrastructure.caddyContainer)} >/dev/null`,
      `docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' ${shellQuote(infrastructure.caddyContainer)} | grep -Fx ${shellQuote(infrastructure.network)} >/dev/null`
    );
  }
  return commands.join('; ');
}

function syncProductionFilesActions(manifest) {
  const infrastructure = deploymentInfrastructure(manifest);
  return [
    {
      type: 'rsync-to-host',
      source: './',
      destination: infrastructure.appDir,
      host: infrastructure.sshHost,
      hostStatePath: 'infrastructure.sshHost',
      user: infrastructure.sshUser,
      port: infrastructure.sshPort,
      ...sshIdentityFields(),
      includes: PRODUCTION_ENV_RSYNC_INCLUDES,
      excludes: [
        ...PRODUCTION_ENV_RSYNC_EXCLUDES,
        '.git/',
        '.venv/',
        'node_modules/',
        '__pycache__/',
        '.pytest_cache/',
        '.agentmesh-deploy/runs/',
        '.agentmesh-deploy/reviews/',
        '.agentmesh-deploy/diffs/',
        '.agentmesh-deploy/handoffs/',
        '.agentmesh-deploy/runtime.env',
        '.agentmesh-deploy/local.env',
        '.agentmesh-deploy/keys/',
        '.agentmesh-deploy/lock.json',
        'data/',
      ],
      effect: `sync repository files to ${infrastructure.appDir}`,
      sideEffect: 'provider-mutation',
      ...rsyncRetryPolicy({ attempts: 6, delayMs: 10000 }),
    },
    sshAction(manifest, {
      remoteCommand: `mkdir -p ${shellQuote(`${infrastructure.appDir}/.agentmesh-deploy`)}`,
      effect: 'prepare protected runtime environment staging directory',
      sideEffect: 'provider-mutation',
      ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
    }),
    {
      type: 'rsync-to-host',
      source: '.env',
      destination: `${infrastructure.appDir}/${STAGED_RUNTIME_ENV_PATH}`,
      destinationIsFile: true,
      delete: false,
      host: infrastructure.sshHost,
      hostStatePath: 'infrastructure.sshHost',
      user: infrastructure.sshUser,
      port: infrastructure.sshPort,
      ...sshIdentityFields(),
      effect: 'stage managed runtime environment without replacing production configuration',
      sideEffect: 'provider-mutation',
      ...rsyncRetryPolicy({ attempts: 6, delayMs: 10000 }),
    },
    sshAction(manifest, {
      remoteCommand: productionEnvActivationCommand(infrastructure.appDir),
      effect: 'back up, merge, and atomically activate production runtime environment',
      sideEffect: 'provider-mutation',
      ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
    }),
  ];
}

function remoteComposeDeployActions(manifest, step) {
  if (step.command) {
    return [
      sshAction(manifest, {
        remoteCommand: step.command,
        effect: 'run custom remote deployment command',
        sideEffect: 'provider-mutation',
        ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
      }),
    ];
  }

  const deployment = manifest.deployment || {};
  const infrastructure = deploymentInfrastructure(manifest);
  const service = deployment.serviceName || manifest.app?.id || 'app';
  const composeFile = deployment.composeFile || 'docker-compose.yml';
  return [
    sshAction(manifest, {
      remoteCommand: `set -e; cd ${shellQuote(infrastructure.appDir)}; docker compose -f ${shellQuote(composeFile)} up -d --build ${shellQuote(service)}`,
      effect: `run docker compose for ${service}`,
      sideEffect: 'provider-mutation',
      ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
    }),
  ];
}

function reloadProductionCaddyActions(manifest) {
  const deployment = manifest.deployment || {};
  const infrastructure = deploymentInfrastructure(manifest);
  const caddyFile = deployment.caddyFile || '';
  const caddyContainer = infrastructure.caddyContainer || '';

  if (!caddyFile) {
    if (infrastructure.caddyMode === 'shared-container' && caddyContainer) {
      return [
        sshAction(manifest, {
          remoteCommand: `docker exec ${shellQuote(caddyContainer)} caddy validate --config /etc/caddy/Caddyfile`,
          effect: `verify externally managed shared Caddy container ${caddyContainer}`,
          sideEffect: 'read-only',
          ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
        }),
      ];
    }
    return [
      {
        type: 'manual',
        effect: 'update production Caddy entrypoint; no caddyFile is configured in this repo',
        sideEffect: 'provider-mutation',
      },
    ];
  }

  if (infrastructure.caddyMode === 'host') {
    return [
      sshAction(manifest, {
        remoteCommand: `set -e; cd ${shellQuote(infrastructure.appDir)}; caddy validate --config ${shellQuote(caddyFile)}; caddy reload --config ${shellQuote(caddyFile)}`,
        effect: `validate and reload Caddy config ${caddyFile}`,
        sideEffect: 'provider-mutation',
        ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
      }),
    ];
  }

  if (infrastructure.caddyMode === 'managed-container') {
    const dataVolume = `${caddyContainer}-data`;
    const configVolume = `${caddyContainer}-config`;
    return [
      sshAction(manifest, {
        remoteCommand: [
          'set -e',
          `cd ${shellQuote(infrastructure.appDir)}`,
          `docker run --rm --network ${shellQuote(infrastructure.network)} -v "$PWD/${caddyFile}:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile`,
          `docker rm -f ${shellQuote(caddyContainer)} >/dev/null 2>&1 || true`,
          `docker volume create ${shellQuote(dataVolume)} >/dev/null`,
          `docker volume create ${shellQuote(configVolume)} >/dev/null`,
          `docker run -d --name ${shellQuote(caddyContainer)} --restart unless-stopped --network ${shellQuote(infrastructure.network)} -p 80:80 -p 443:443 -v "$PWD/${caddyFile}:/etc/caddy/Caddyfile:ro" -v ${shellQuote(dataVolume)}:/data -v ${shellQuote(configVolume)}:/config caddy:2`,
        ].join('; '),
        effect: `validate and run managed Caddy container ${caddyContainer}`,
        sideEffect: 'provider-mutation',
        ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
      }),
    ];
  }

  if (infrastructure.caddyMode === 'shared-container' && caddyContainer) {
    return [
      sshAction(manifest, {
        remoteCommand: sharedCaddyReloadCommand({
          appDir: infrastructure.appDir,
          caddyFile,
          caddyContainer,
        }),
        effect: `validate and reload shared Caddy container ${caddyContainer}`,
        sideEffect: 'provider-mutation',
        ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
      }),
    ];
  }

  return [
    sshAction(manifest, {
      remoteCommand: [
        'set -e',
        `cd ${shellQuote(infrastructure.appDir)}`,
        `docker cp ${shellQuote(caddyFile)} ${shellQuote(`${caddyContainer}:/etc/caddy/Caddyfile`)}`,
        `docker exec ${shellQuote(caddyContainer)} caddy validate --config /etc/caddy/Caddyfile`,
        `docker restart ${shellQuote(caddyContainer)}`,
      ].join('; '),
      effect: `validate and restart shared Caddy container ${caddyContainer}`,
      sideEffect: 'provider-mutation',
      ...sshRetryPolicy({ attempts: 3, delayMs: 10000 }),
    }),
  ];
}

function sharedCaddyReloadCommand({ appDir, caddyFile, caddyContainer }) {
  const mountSourceTemplate =
    '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}';
  return [
    'set -e',
    `cd ${shellQuote(appDir)}`,
    `host_caddy_file=$(docker inspect ${shellQuote(caddyContainer)} --format ${shellQuote(mountSourceTemplate)})`,
    'test -n "$host_caddy_file"',
    'backup_file="${host_caddy_file}.agentmesh-deploy.bak.$(date +%Y%m%d%H%M%S)"',
    'cp "$host_caddy_file" "$backup_file"',
    `cp ${shellQuote(caddyFile)} "$host_caddy_file"`,
    [
      `if docker exec ${shellQuote(caddyContainer)} caddy validate --config /etc/caddy/Caddyfile`,
      `then docker exec ${shellQuote(caddyContainer)} caddy reload --config /etc/caddy/Caddyfile || docker restart ${shellQuote(caddyContainer)}`,
      'rm -f "$backup_file"',
      'else cp "$backup_file" "$host_caddy_file"',
      'exit 1',
      'fi',
    ].join('; '),
  ].join('; ');
}

function sshAction(manifest, fields) {
  const infrastructure = deploymentInfrastructure(manifest);
  return {
    type: 'ssh-command',
    host: infrastructure.sshHost,
    hostStatePath: 'infrastructure.sshHost',
    user: infrastructure.sshUser,
    port: infrastructure.sshPort,
    ...sshIdentityFields(),
    ...fields,
  };
}

function sshIdentityFields() {
  return {
    identityFileEnv: 'AGENTMESH_DEPLOY_SSH_KEY_PATH',
    privateKeyEnv: 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY',
  };
}

function sshRetryPolicy({ attempts, delayMs }) {
  return {
    maxAttempts: attempts,
    retryDelayMs: delayMs,
    retryExitCodes: [255],
  };
}

function rsyncRetryPolicy({ attempts, delayMs }) {
  return {
    maxAttempts: attempts,
    retryDelayMs: delayMs,
    retryExitCodes: [12, 30, 35, 255],
  };
}

function deploymentInfrastructure(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  const caddyMode = infrastructure.caddyMode || (infrastructure.caddyContainer ? 'shared-container' : 'managed-container');
  return {
    provider: infrastructure.provider || 'digitalocean',
    mode: infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision'),
    dropletName: infrastructure.dropletName || `${manifest.app?.id || 'agentmesh-app'}-prod`,
    region: infrastructure.region || 'sgp1',
    size: infrastructure.size || 's-1vcpu-1gb',
    image: infrastructure.image || 'ubuntu-24-04-x64',
    sshUser: infrastructure.sshUser || 'root',
    sshPort: infrastructure.sshPort || 22,
    sshHost: infrastructure.sshHost || '',
    sshKeyName: infrastructure.sshKeyName || `${manifest.app?.id || 'agentmesh-app'}-deploy-key`,
    appDir: infrastructure.appDir || `/opt/${manifest.app?.id || 'agentmesh-app'}`,
    network: infrastructure.network || 'agentmesh-web',
    caddyMode,
    caddyContainer: infrastructure.caddyContainer || (caddyMode === 'managed-container' ? `${manifest.app?.id || 'agentmesh-app'}-caddy` : ''),
  };
}

function deploymentDns(manifest) {
  return {
    provider: manifest.deployment?.dns?.provider || 'manual',
    recordType: manifest.deployment?.dns?.recordType || 'A',
    name: manifest.deployment?.dns?.name || '',
    zone: manifest.deployment?.dns?.zone || '',
    value: manifest.deployment?.dns?.value || '',
    proxied: manifest.deployment?.dns?.proxied === true,
    ttl: manifest.deployment?.dns?.ttl || 300,
  };
}

function fqdnFromDnsName(name, zone, fallback) {
  if (!name || name === '@') return zone || fallback;
  if (zone && name.endsWith(`.${zone}`)) return name;
  return zone ? `${name}.${zone}` : fallback;
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

function dockerInstallCommand() {
  return [
    'if ! command -v docker >/dev/null 2>&1; then apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg',
    'install -m 0755 -d /etc/apt/keyrings',
    'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
    'chmod a+r /etc/apt/keyrings/docker.asc',
    '. /etc/os-release',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list',
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'fi',
    'docker --version',
    'docker compose version',
  ].join('; ');
}
