import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_DIFF_ARTIFACT,
  DEFAULT_HANDOFF_ARTIFACT,
  DEFAULT_REVIEW_ARTIFACT,
} from './approval-constants.js';
import { cloudflareApiEnvKeys } from './cloudflare-env.js';
import {
  PRODUCTION_ENV_RSYNC_EXCLUDES,
  PRODUCTION_ENV_RSYNC_INCLUDES,
  STAGED_RUNTIME_ENV_PATH,
  productionEnvActivationCommand,
} from './production-env.js';
import { ensureDir, pathExists, readTextIfExists } from './utils.js';

export function renderManagedFile(root, action, manifest, state, context = {}) {
  if (action.path === 'wrangler.jsonc') {
    return renderWranglerConfig(manifest, state, root);
  }
  if (action.path === '.env') {
    return renderEnvFile(root, manifest, state, { production: false, context });
  }
  if (action.path === '.env.production') {
    return renderEnvFile(root, manifest, state, { production: true, context });
  }
  if (action.path === '.github/workflows/deploy.yml') {
    return renderGithubActionsWorkflow(manifest);
  }
  if (action.path === '.agentmesh-deploy/RUNBOOK.md') {
    return renderDeployRunbook(manifest);
  }
  if (action.path === '.gitignore') {
    return renderGitignoreFile(root);
  }
  throw new Error(`No renderer is registered for ${action.path}.`);
}

export function writeManagedFile(root, action, manifest, state, context = {}) {
  const content = renderManagedFile(root, action, manifest, state, context);
  const filePath = path.join(root, action.path);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    status: 'completed',
    stdout: '',
    stderr: '',
    path: action.path,
    bytes: Buffer.byteLength(content),
  };
}

export function inspectManagedFile(root, action, manifest, state, context = {}) {
  const filePath = path.join(root, action.path);
  const exists = pathExists(filePath);
  const expected = renderManagedFile(root, action, manifest, state, context);
  const current = exists ? readTextIfExists(filePath) : '';
  const status = !exists ? 'missing' : current === expected ? 'current' : 'stale';

  return {
    path: action.path,
    status,
    exists,
  };
}

export function previewManagedFile(root, action, manifest, state, context = {}, { revealSecrets = false } = {}) {
  const content = renderManagedFile(root, action, manifest, state, context);
  const redaction = redactManagedFileContent(action.path, content, { revealSecrets });
  return {
    path: action.path,
    content: redaction.content,
    sensitive: redaction.sensitive,
    redacted: redaction.redacted,
  };
}

export function redactManagedFileContent(filePath, content, { revealSecrets = false } = {}) {
  const sensitive = secretBearingManagedFile(filePath);
  const redacted = sensitive && !revealSecrets;
  return {
    content: redacted ? redactEnvPreviewContent(content) : content,
    sensitive,
    redacted,
  };
}

export function renderWranglerConfig(manifest, state = {}, root = '') {
  const existing = root ? readExistingWranglerJsonc(root) : {};
  const config = {
    name: manifest.app?.id || 'agentmesh-app',
    ...(existing.main ? { main: existing.main } : {}),
    ...(existing.assets ? { assets: existing.assets } : {}),
    compatibility_date: existing.compatibility_date || '2026-07-05',
    d1_databases: d1Bindings(manifest, state),
    r2_buckets: r2Bindings(manifest),
    kv_namespaces: kvBindings(manifest, state),
  };

  if (!config.main && !config.assets) {
    config.main = 'src/worker.js';
  }

  if (manifest.domain?.production) {
    config.routes = [
      {
        pattern: manifest.domain.production,
        custom_domain: true,
      },
    ];
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

function readExistingWranglerJsonc(root) {
  const content = readTextIfExists(path.join(root, 'wrangler.jsonc'));
  if (!content) return {};
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

export function renderEnvFile(root, manifest, state = {}, { production, context = {} }) {
  const targetPath = path.join(root, production ? '.env.production' : '.env');
  const examplePath = path.join(root, '.env.example');
  const base = pathExists(targetPath)
    ? readTextIfExists(targetPath)
    : readTextIfExists(examplePath);
  const existing = parseEnvContent(base);
  const values = envValues(manifest, state, { production, existing, context });
  return upsertEnvContent(base, values);
}

export function renderGithubActionsWorkflow(manifest) {
  if (manifest.target?.type === 'docker-compose-caddy') {
    return renderDockerComposeCaddyWorkflow(manifest);
  }

  const commands = manifest.commands || {};
  const packageManager = manifest.runtime?.packageManager || 'npm';
  const lines = [
    '# Managed by AgentMesh Deploy. Manual edits may be overwritten.',
    'name: Deploy',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    ...githubDeployPathLines(manifest),
    '  workflow_dispatch:',
    '',
    'concurrency:',
    "  group: deploy-${{ github.ref }}",
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
  ];

  const env = githubWorkflowEnv(manifest);
  if (env.length > 0) {
    lines.push('    env:');
    for (const key of env) {
      lines.push(`      ${key}: \${{ secrets.${key} }}`);
    }
  }

  lines.push(
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v4'
  );

  if (packageManager === 'bun') {
    lines.push(
      '      - name: Setup Bun',
      '        uses: oven-sh/setup-bun@v2',
      '        with:',
      '          bun-version: latest'
    );
  } else {
    lines.push(
      '      - name: Setup Node',
      '        uses: actions/setup-node@v4',
      '        with:',
      '          node-version: "20"',
      `          cache: ${nodeCache(packageManager)}`
    );
    if (packageManager === 'pnpm' || packageManager === 'yarn') {
      lines.push(
        '      - name: Enable Corepack',
        '        run: corepack enable'
      );
    }
  }

  lines.push(
    '      - name: Install dependencies',
    `        run: ${commands.install || defaultInstallCommand(packageManager)}`
  );

  if (commands.build) {
    lines.push(
      '      - name: Build',
      `        run: ${commands.build}`
    );
  }

  if (commands.deploy) {
    lines.push(
      '      - name: Deploy',
      `        run: ${commands.deploy}`
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderDockerComposeCaddyWorkflow(manifest) {
  const infrastructure = dockerInfrastructure(manifest);
  const deployment = manifest.deployment || {};
  const composeFile = deployment.composeFile || 'docker-compose.yml';
  const caddyFile = deployment.caddyFile || '';
  const service = deployment.serviceName || manifest.app?.id || 'app';
  const runtimeEnvKeys = dockerRuntimeEnvKeys(manifest);
  const verifyUrl = dockerVerifyUrl(manifest);
  const host = infrastructure.sshHost || '${{ secrets.AGENTMESH_DEPLOY_SSH_HOST }}';
  const user = infrastructure.sshUser || '${{ secrets.AGENTMESH_DEPLOY_SSH_USER }}';
  const port = String(infrastructure.sshPort || 22);
  const appDir = infrastructure.appDir || '${{ secrets.AGENTMESH_DEPLOY_APP_DIR }}';
  const network = infrastructure.network || 'agentmesh-web';
  const keyPath = '~/.ssh/agentmesh_deploy_key';
  const remote = '"$DEPLOY_USER@$DEPLOY_HOST"';
  const sshOptions = `-i ${keyPath} -p "$DEPLOY_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ConnectionAttempts=1`;
  const sshBase = `ssh ${sshOptions} ${remote}`;
  const rsyncSsh = `ssh -i ${keyPath} -p $DEPLOY_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ConnectionAttempts=1`;
  const remotePrepare =
    infrastructure.mode === 'adopt-existing'
      ? adoptedDockerRuntimeValidationCommand(infrastructure)
      : [
          'set -e',
          dockerInstallCommand(),
          `mkdir -p ${shellQuote(appDir)}`,
          `docker network inspect ${shellQuote(network)} >/dev/null 2>&1 || docker network create ${shellQuote(network)}`,
          ...(infrastructure.caddyMode === 'shared-container' && infrastructure.caddyContainer
            ? [
                `docker network connect ${shellQuote(network)} ${shellQuote(infrastructure.caddyContainer)} >/dev/null 2>&1 || true`,
              ]
            : []),
        ].join('; ');
  const remoteDeploy =
    manifest.commands?.deploy ||
    `set -e; cd ${shellQuote(appDir)}; docker compose -f ${shellQuote(composeFile)} up -d --build ${shellQuote(service)}`;
  const remoteCaddy = dockerCaddyRemoteCommand(infrastructure, {
    caddyFile,
    network,
    deployPath: appDir,
  });

  const lines = [
    '# Managed by AgentMesh Deploy. Manual edits may be overwritten.',
    'name: Deploy',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    ...githubDeployPathLines(manifest),
    '  workflow_dispatch:',
    '',
    'concurrency:',
    "  group: deploy-${{ github.ref }}",
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    env:',
    `      DEPLOY_HOST: ${JSON.stringify(host)}`,
    `      DEPLOY_USER: ${JSON.stringify(user)}`,
    `      DEPLOY_PORT: ${JSON.stringify(port)}`,
    `      DEPLOY_PATH: ${JSON.stringify(appDir)}`,
    ...(verifyUrl ? [`      VERIFY_URL: ${JSON.stringify(verifyUrl)}`] : []),
    '      AGENTMESH_DEPLOY_SSH_PRIVATE_KEY: ${{ secrets.AGENTMESH_DEPLOY_SSH_PRIVATE_KEY }}',
    ...runtimeEnvKeys.map((key) => `      ${key}: \${{ secrets.${key} }}`),
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v4',
    '',
    '      - name: Configure SSH',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          mkdir -p ~/.ssh',
    '          printf "%s\\n" "$AGENTMESH_DEPLOY_SSH_PRIVATE_KEY" > ~/.ssh/agentmesh_deploy_key',
    '          chmod 600 ~/.ssh/agentmesh_deploy_key',
    '          ssh-keyscan -p "$DEPLOY_PORT" "$DEPLOY_HOST" >> ~/.ssh/known_hosts',
    '',
    ...dockerRuntimeEnvWorkflowStep(runtimeEnvKeys),
    '      - name: Sync repository',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    ...workflowRetryFunctionLines(),
    `          retry 6 10 ${sshBase} "mkdir -p \\"$DEPLOY_PATH\\""`,
    '          retry 6 10 rsync -az --delete \\',
    ...PRODUCTION_ENV_RSYNC_INCLUDES.map(
      (pattern) => `            --include ${shellQuote(pattern)} \\`
    ),
    ...PRODUCTION_ENV_RSYNC_EXCLUDES.map(
      (pattern) => `            --exclude ${shellQuote(pattern)} \\`
    ),
    '            --exclude .git/ \\',
    '            --exclude .venv/ \\',
    '            --exclude node_modules/ \\',
    '            --exclude __pycache__/ \\',
    '            --exclude .pytest_cache/ \\',
    '            --exclude .agentmesh-deploy/runs/ \\',
    '            --exclude .agentmesh-deploy/reviews/ \\',
    '            --exclude .agentmesh-deploy/diffs/ \\',
    '            --exclude .agentmesh-deploy/handoffs/ \\',
    '            --exclude .agentmesh-deploy/runtime.env \\',
    '            --exclude .agentmesh-deploy/local.env \\',
    '            --exclude .agentmesh-deploy/keys/ \\',
    '            --exclude .agentmesh-deploy/lock.json \\',
    '            --exclude data/ \\',
    `            -e "${rsyncSsh}" ./ "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/"`,
    '',
    ...dockerRuntimeEnvUploadStep(runtimeEnvKeys, keyPath, appDir, sshBase),
    '      - name: Deploy service',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    ...workflowRetryFunctionLines(),
    `          retry 3 10 ${sshBase} ${workflowRemoteArg(remotePrepare)}`,
    `          retry 3 10 ${sshBase} ${workflowRemoteArg(remoteDeploy)}`,
    `          retry 3 10 ${sshBase} ${workflowRemoteArg(remoteCaddy)}`,
    ...dockerWorkflowVerifyStep(verifyUrl),
  ];

  return `${lines.join('\n')}\n`;
}

function dockerVerifyUrl(manifest) {
  const domain = manifest.domain?.production || manifest.deployment?.productionDomain || '';
  return domain ? `https://${domain}` : '';
}

function workflowRetryFunctionLines() {
  return [
    '          retry() {',
    '            local max_attempts="$1"; shift',
    '            local delay_seconds="$1"; shift',
    '            local attempt=1',
    '            until "$@"; do',
    '              local exit_code="$?"',
    '              if [ "$attempt" -ge "$max_attempts" ]; then',
    '                return "$exit_code"',
    '              fi',
    '              echo "Attempt $attempt/$max_attempts failed with exit $exit_code; retrying in ${delay_seconds}s"',
    '              sleep "$delay_seconds"',
    '              attempt=$((attempt + 1))',
    '            done',
    '          }',
  ];
}

function dockerRuntimeEnvWorkflowStep(keys) {
  if (!keys.length) return [];
  return [
    '      - name: Render runtime environment',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          install -d .agentmesh-deploy',
    '          : > .agentmesh-deploy/runtime.env',
    ...keys.flatMap((key) => [
      `          if [ -z "\${${key}:-}" ]; then`,
      `            echo "::error::Missing GitHub secret ${key}"`,
      '            exit 1',
      '          fi',
      `          printf '%s=%s\\n' '${key}' "$${key}" >> .agentmesh-deploy/runtime.env`,
    ]),
    '          chmod 600 .agentmesh-deploy/runtime.env',
    '',
  ];
}

function dockerRuntimeEnvUploadStep(keys, keyPath, appDir, sshBase) {
  if (!keys.length) return [];
  const stageDirectory = `${appDir}/.agentmesh-deploy`;
  return [
    '      - name: Sync runtime environment',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    ...workflowRetryFunctionLines(),
    `          retry 6 10 ${sshBase} ${workflowRemoteArg(`mkdir -p ${shellQuote(stageDirectory)}`)}`,
    `          retry 6 10 scp -i ${keyPath} -P "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ConnectionAttempts=1 .agentmesh-deploy/runtime.env "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/${STAGED_RUNTIME_ENV_PATH}"`,
    `          retry 6 10 ${sshBase} ${workflowRemoteArg(productionEnvActivationCommand(appDir))}`,
    '',
  ];
}

function dockerWorkflowVerifyStep(verifyUrl) {
  if (!verifyUrl) return [];
  return [
    '',
    '      - name: Verify deployment',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    ...workflowRetryFunctionLines(),
    '          retry 18 10 curl --fail --silent --show-error --location --max-time 15 "$VERIFY_URL" >/dev/null',
    '          echo "Verified $VERIFY_URL"',
  ];
}

function workflowRemoteArg(command) {
  return `"${String(command)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}

export function renderDeployRunbook(manifest) {
  const appId = manifest.app?.id || 'agentmesh-app';
  const targetProvider = manifest.target?.provider || 'local';
  const targetType = manifest.target?.type || 'unknown';
  const envKeys = requiredDeploymentEnv(manifest);
  const resources = (manifest.resources || []).filter((resource) => resource.enabled !== false);
  const reviewArtifact = DEFAULT_REVIEW_ARTIFACT;
  const diffArtifact = DEFAULT_DIFF_ARTIFACT;
  const handoffArtifact = DEFAULT_HANDOFF_ARTIFACT;
  const dockerTarget = targetType === 'docker-compose-caddy';
  const infrastructure = manifest.deployment?.infrastructure || {};
  const infrastructureMode =
    infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
  const caddyMode =
    infrastructure.caddyMode ||
    (infrastructure.caddyContainer ? 'shared-container' : 'managed-container');
  const caddyFile = manifest.deployment?.caddyFile || '';
  const githubEnabled = manifest.github?.enabled !== false;
  const dockerRunbookRules = !dockerTarget
    ? []
    : [
        infrastructureMode === 'adopt-existing'
          ? `- Infrastructure mode is \`adopt-existing\`: this contract reuses ${infrastructure.dropletName || infrastructure.sshHost || 'the declared production host'} and must not create a Droplet.`
          : '- Infrastructure mode is `provision`: creating a new DigitalOcean host requires explicit provider and cost approval.',
        ...(infrastructureMode === 'adopt-existing'
          ? [
              '- Adopt-existing runtime preparation is read-only: it verifies Docker, Compose, the declared network, and shared ingress attachment; it does not install Docker, create a network, or attach containers.',
            ]
          : []),
        ...(infrastructureMode === 'provision'
          ? [
              '- For a new DigitalOcean host, set `DIGITALOCEAN_SSH_KEY_IDS` to reuse existing keys, or set `AGENTMESH_DEPLOY_SSH_PUBLIC_KEY` so the plan can import a deploy key before creating the Droplet.',
            ]
          : []),
        '- Local SSH/rsync actions use `AGENTMESH_DEPLOY_SSH_KEY_PATH` when set, or write `AGENTMESH_DEPLOY_SSH_PRIVATE_KEY` into a temporary 0600 identity file that is removed after each command.',
        '- SSH and rsync production-host actions use finite retry policies for transient host readiness or network failures; repeated command/config failures still stop apply and are recorded in the run artifact.',
        '- Repository rsync excludes `.env` and `.env.*`; runtime values use a separate staged upload that backs up an existing `.env` to `.env.previous` with mode 0600, preserves unmanaged keys, and atomically activates the managed overlay before `docker compose` runs.',
        ...(caddyMode === 'shared-container' && !caddyFile
          ? [
              `- Shared Caddy is externally managed: this manifest has no \`deployment.caddyFile\`, so the product plan only validates ${infrastructure.caddyContainer || 'the declared shared container'} and never copies or replaces its Caddyfile.`,
            ]
          : caddyMode === 'shared-container'
            ? [
                '- For `shared-container` Caddy mode, the managed workflow validates the copied config and restarts the shared Caddy container so newly added site blocks are loaded.',
              ]
            : [
                `- Caddy mode is \`${caddyMode}\`; inspect the generated plan for the exact entrypoint action before execution.`,
              ]),
        ...(githubEnabled
          ? [
              '- The managed GitHub Actions workflow requires `AGENTMESH_DEPLOY_SSH_PRIVATE_KEY` plus every app runtime env key as GitHub secrets and fails before upload when a declared secret is missing.',
              ...(infrastructureMode === 'provision'
                ? [
                    '- When the production host is provisioned by this plan, `sync-github-secrets` reads `state.infrastructure.sshHost` and writes `AGENTMESH_DEPLOY_SSH_HOST` after the Droplet IP is captured.',
                  ]
                : []),
            ]
          : [
              '- GitHub integration is disabled: this manifest does not generate a deployment workflow or synchronize GitHub secrets.',
            ]),
      ];
  const commands = [
    'agentmesh-deploy schema',
    'agentmesh-deploy onboard . --json',
    'agentmesh-deploy validate . --json',
    'agentmesh-deploy plan .',
    'agentmesh-deploy status . --json',
    'agentmesh-deploy prepare . --json',
    'agentmesh-deploy review . --json',
    `agentmesh-deploy review . --json --out ${reviewArtifact}`,
    'agentmesh-deploy diff . --json',
    `agentmesh-deploy diff . --json --out ${diffArtifact}`,
    'agentmesh-deploy secrets . --json',
    'agentmesh-deploy runs . --json',
    'agentmesh-deploy doctor . --json',
    'agentmesh-deploy doctor . --json --probe-auth',
    'agentmesh-deploy handoff . --json',
    `agentmesh-deploy handoff . --out ${handoffArtifact}`,
    `agentmesh-deploy apply . --json --require-review ${reviewArtifact} --require-diff ${diffArtifact} --expect-plan <planFingerprint>`,
  ];

  return `${[
    '# AgentMesh Deploy Runbook',
    '',
    'This file is managed by AgentMesh Deploy. It is safe to commit because it contains only commands, policy, and deployment metadata. It must not contain secrets.',
    '',
    '## Deployment Target',
    '',
    `- App: ${appId}`,
    `- Provider: ${targetProvider}`,
    `- Target: ${targetType}`,
    `- Environment: ${manifest.target?.environment || 'production'}`,
    `- GitHub: ${manifest.github?.enabled === false ? 'disabled' : manifest.github?.repo || appId}`,
    `- Production domain: ${manifest.domain?.production || '(captured from deploy output)'}`,
    ...(manifest.target?.type === 'docker-compose-caddy'
      ? [
          `- Production host: ${manifest.deployment?.infrastructure?.sshHost || 'state.infrastructure.sshHost'}`,
          `- App directory: ${manifest.deployment?.infrastructure?.appDir || '/opt/<app>'}`,
          `- Shared Docker network: ${manifest.deployment?.infrastructure?.network || 'agentmesh-web'}`,
          `- Caddy mode: ${manifest.deployment?.infrastructure?.caddyMode || 'managed-container'}`,
          `- DNS provider: ${manifest.deployment?.dns?.provider || 'manual'}`,
          `- DNS zone: ${manifest.domain?.zone?.name || manifest.domain?.root || '(not configured)'}`,
        ]
      : []),
    '',
    '## Agent Checklist',
    '',
    ...commands.map((command, index) => `${index + 1}. \`${command}\``),
    '',
    '## Execution Rules',
    '',
    '- `apply` and `destroy` default to dry-run.',
    '- Real local command execution requires `--execute --yes`.',
    '- Provider mutations such as Cloudflare, GitHub, or DigitalOcean changes additionally require `--allow-provider-mutations`.',
    '- Cost-incurring provider mutations such as domain registration or Droplet creation additionally require `--allow-cost-mutations`.',
    '- Use `agentmesh-deploy help onboard`, `agentmesh-deploy help status`, `agentmesh-deploy help prepare`, `agentmesh-deploy help review`, `agentmesh-deploy help diff`, or `agentmesh-deploy help apply` for command-specific guidance before changing flags; append `--json` when a receiving agent needs a machine-readable command contract.',
    '- For an ordinary product repo handoff, start from `onboard --json`; it reuses this sidecar, validates the manifest, and refreshes default handoff evidence without provider mutations.',
    '- Use `status --json` after onboarding or configuration changes; inspect `approvalArtifacts` and `nextActions` before apply.',
    `- Use \`prepare --json\` to refresh the default \`${reviewArtifact}\`, \`${diffArtifact}\`, and \`${handoffArtifact}\` handoff evidence in one local command.`,
    '- If `status.nextActions` includes `refresh-approval-artifacts`, run every listed refresh command before apply.',
    `- Use \`review --json --out ${reviewArtifact}\` to save an explicit pre-apply approval packet.`,
    `- Use \`diff --json --out ${diffArtifact}\` to save a redacted managed-file change packet before apply.`,
    `- Re-run \`status --json\` after refreshing artifacts; both \`${reviewArtifact}\` and \`${diffArtifact}\` should be \`current\`.`,
    '- Use `secrets --json` to inspect required keys, source locations, and present/missing booleans without printing values.',
    '- Use `runs --json --latest` to inspect the latest saved run artifact after a failed plan/apply.',
    `- Use \`apply --require-review ${reviewArtifact}\` to bind apply to the saved review artifact.`,
    `- Use \`apply --require-diff ${diffArtifact}\` to bind apply to the saved managed-file diff artifact.`,
    '- Use the current `planFingerprint` from `status`, `review`, `doctor`, or `handoff` with `--expect-plan` before apply.',
    '- Status, review, and handoff suggested apply commands already include the review, diff, and fingerprint gates.',
    `- The default \`${reviewArtifact}\` packet omits its own self-refresh reminder; any remaining artifact refresh action must still be handled.`,
    '- If `status.nextActions` includes `fix-manifest`, `wait-for-deployment-lock`, or `authenticate-provider`, handle that before execution.',
    ...dockerRunbookRules,
    '- Do not commit `.env`, `.env.*`, `.agentmesh-deploy/state.json`, `.agentmesh-deploy/runs/`, `.agentmesh-deploy/reviews/`, `.agentmesh-deploy/diffs/`, `.agentmesh-deploy/handoffs/`, `.agentmesh-deploy/runtime.env`, `.agentmesh-deploy/local.env`, `.agentmesh-deploy/keys/`, or `.agentmesh-deploy/lock.json`.',
    '',
    '## Required Environment',
    '',
    ...(envKeys.length ? envKeys.map((key) => `- ${key}`) : ['- (none detected)']),
    '',
    '## Managed Resources',
    '',
    ...(resources.length
      ? resources.map(
          (resource) =>
            `- ${resource.id}: ${resource.type} ${resource.name || ''} (${resource.binding || 'no binding'})`.trim()
        )
      : ['- (none enabled)']),
    '',
  ].join('\n')}`;
}

export function renderGitignoreFile(root) {
  const targetPath = path.join(root, '.gitignore');
  const base = readTextIfExists(targetPath);
  return upsertManagedBlock(base, 'AgentMesh Deploy', [
    '.env',
    '.env.*',
    '!.env.example',
    '.agentmesh-deploy/state.json',
    '.agentmesh-deploy/runs/',
    '.agentmesh-deploy/reviews/',
    '.agentmesh-deploy/diffs/',
    '.agentmesh-deploy/handoffs/',
    '.agentmesh-deploy/runtime.env',
    '.agentmesh-deploy/local.env',
    '.agentmesh-deploy/keys/',
    '.agentmesh-deploy/lock.json',
  ]);
}

function requiredDeploymentEnv(manifest) {
  const keys = new Set([
    ...(manifest.env?.required || []),
    ...(manifest.env?.provider || []),
    ...(manifest.env?.copyFromShell || []),
    ...(manifest.github?.actionsSecrets || []),
  ]);
  if (manifest.target?.provider === 'cloudflare') {
    cloudflareApiEnvKeys(manifest).forEach((key) => keys.add(key));
  }
  if (manifest.target?.type === 'docker-compose-caddy') {
    if (manifest.deployment?.dns?.provider === 'cloudflare') keys.add('CLOUDFLARE_API_TOKEN');
    if (manifest.domain?.zone?.provider === 'cloudflare') {
      keys.add(manifest.domain.zone.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID');
      keys.add('CLOUDFLARE_API_TOKEN');
    }
    if (dockerInfrastructureMode(manifest) !== 'adopt-existing') {
      keys.add('DIGITALOCEAN_SSH_KEY_IDS or AGENTMESH_DEPLOY_SSH_PUBLIC_KEY');
    }
    if (manifest.github?.enabled !== false) {
      dockerGithubSecrets(manifest).forEach((key) => keys.add(key));
    }
  }
  for (const key of stateSourcedGithubSecretKeys(manifest)) {
    keys.delete(key);
  }
  return Array.from(keys).filter(Boolean).sort();
}

function dockerInfrastructure(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  const caddyMode = infrastructure.caddyMode || (infrastructure.caddyContainer ? 'shared-container' : 'managed-container');
  return {
    mode: infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision'),
    sshHost: infrastructure.sshHost || '',
    sshUser: infrastructure.sshUser || 'root',
    sshPort: infrastructure.sshPort || 22,
    appDir: infrastructure.appDir || `/opt/${manifest.app?.id || 'agentmesh-app'}`,
    network: infrastructure.network || 'agentmesh-web',
    caddyMode,
    caddyContainer: infrastructure.caddyContainer || (caddyMode === 'managed-container' ? `${manifest.app?.id || 'agentmesh-app'}-caddy` : ''),
  };
}

function dockerInfrastructureMode(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  return infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
}

function dockerCaddyRemoteCommand(infrastructure, { caddyFile, network, deployPath }) {
  if (!caddyFile) {
    if (infrastructure.caddyMode === 'shared-container' && infrastructure.caddyContainer) {
      return `docker exec ${shellQuote(infrastructure.caddyContainer)} caddy validate --config /etc/caddy/Caddyfile`;
    }
    return 'echo "AgentMesh Deploy: no caddyFile configured; update production Caddy entrypoint outside this workflow"';
  }

  if (infrastructure.caddyMode === 'host') {
    return `set -e; cd ${shellQuote(deployPath)}; caddy validate --config ${shellQuote(caddyFile)}; caddy reload --config ${shellQuote(caddyFile)}`;
  }

  if (infrastructure.caddyMode === 'managed-container') {
    const container = infrastructure.caddyContainer;
    const dataVolume = `${container}-data`;
    const configVolume = `${container}-config`;
    return [
      'set -e',
      `cd ${shellQuote(deployPath)}`,
      `docker run --rm --network ${shellQuote(network)} -v "$PWD/${caddyFile}:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile`,
      `docker rm -f ${shellQuote(container)} >/dev/null 2>&1 || true`,
      `docker volume create ${shellQuote(dataVolume)} >/dev/null`,
      `docker volume create ${shellQuote(configVolume)} >/dev/null`,
      `docker run -d --name ${shellQuote(container)} --restart unless-stopped --network ${shellQuote(network)} -p 80:80 -p 443:443 -v "$PWD/${caddyFile}:/etc/caddy/Caddyfile:ro" -v ${shellQuote(dataVolume)}:/data -v ${shellQuote(configVolume)}:/config caddy:2`,
    ].join('; ');
  }

  if (infrastructure.caddyMode === 'shared-container' && infrastructure.caddyContainer) {
    return sharedCaddyReloadCommand({
      appDir: deployPath,
      caddyFile,
      caddyContainer: infrastructure.caddyContainer,
    });
  }

  return [
    'set -e',
    `cd ${shellQuote(deployPath)}`,
    `docker cp ${shellQuote(caddyFile)} ${shellQuote(`${infrastructure.caddyContainer}:/etc/caddy/Caddyfile`)}`,
    `docker exec ${shellQuote(infrastructure.caddyContainer)} caddy validate --config /etc/caddy/Caddyfile`,
    `docker restart ${shellQuote(infrastructure.caddyContainer)}`,
  ].join('; ');
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

function dockerGithubSecrets(manifest) {
  const infrastructure = manifest.deployment?.infrastructure || {};
  const keys = ['AGENTMESH_DEPLOY_SSH_PRIVATE_KEY'];
  if (!infrastructure.sshHost && !shouldSourceSshHostFromState(manifest)) keys.push('AGENTMESH_DEPLOY_SSH_HOST');
  if (!infrastructure.sshUser) keys.push('AGENTMESH_DEPLOY_SSH_USER');
  if (!infrastructure.sshPort) keys.push('AGENTMESH_DEPLOY_SSH_PORT');
  if (!infrastructure.appDir) keys.push('AGENTMESH_DEPLOY_APP_DIR');
  return keys;
}

function stateSourcedGithubSecretKeys(manifest) {
  return shouldSourceSshHostFromState(manifest) ? ['AGENTMESH_DEPLOY_SSH_HOST'] : [];
}

function shouldSourceSshHostFromState(manifest) {
  if (manifest.target?.type !== 'docker-compose-caddy') return false;
  const infrastructure = manifest.deployment?.infrastructure || {};
  const mode = infrastructure.mode || (infrastructure.sshHost ? 'adopt-existing' : 'provision');
  return !infrastructure.sshHost && mode !== 'adopt-existing';
}

function dockerRuntimeEnvKeys(manifest) {
  const seen = new Set();
  return [
    ...(manifest.env?.required || []),
    ...(manifest.env?.generated || []),
  ]
    .filter((key) => {
      if (!key || key.startsWith('AGENTMESH_DEPLOY_') || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort();
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

function adoptedDockerRuntimeValidationCommand(infrastructure) {
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

function secretBearingManagedFile(filePath) {
  return filePath === '.env' || filePath === '.env.production';
}

function redactEnvPreviewContent(content) {
  const source = String(content || '').replace(/\n+$/, '');
  if (!source) return '';
  return `${source
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim() || line.trimStart().startsWith('#')) return line;
      const match = line.match(/^(\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)=.*$/);
      if (match) return `${match[1]}${match[2]}=<redacted>`;
      return '<redacted line>';
    })
    .join('\n')}\n`;
}

export function upsertEnvContent(content, values) {
  const seen = new Set();
  const lines = String(content || '')
    .replace(/\n+$/, '')
    .split(/\r?\n/)
    .filter((line, index, all) => line !== '' || index < all.length - 1)
    .map((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (!match) return line;
      const key = match[1];
      if (!(key in values)) return line;
      seen.add(key);
      return `${key}=${formatEnvValue(values[key])}`;
    });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function upsertManagedBlock(content, label, lines) {
  const start = `# >>> ${label}`;
  const end = `# <<< ${label}`;
  const block = [start, ...lines, end].join('\n');
  const source = String(content || '').replace(/\n+$/, '');
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm');

  if (pattern.test(source)) {
    return `${source.replace(pattern, block)}\n`;
  }
  if (!source) return `${block}\n`;
  return `${source}\n\n${block}\n`;
}

export function envValues(manifest, state = {}, { production, existing = {}, context = {} }) {
  const values = {
    VITE_BASE_URL: production ? productionBaseUrl(manifest, state) : 'http://localhost:3000',
  };

  for (const key of manifest.env?.provider || []) {
    if (key === 'CLOUDFLARE_ACCOUNT_ID') {
      values[key] = '${CLOUDFLARE_ACCOUNT_ID}';
    } else if (key === 'CLOUDFLARE_API_TOKEN') {
      values[key] = '${CLOUDFLARE_API_TOKEN}';
    }
  }

  const d1 = resourceByType(manifest, 'cloudflare.d1');
  if (d1) {
    values.CLOUDFLARE_DATABASE_ID = state.resources?.[d1.id]?.providerId || '';
  }

  for (const key of manifest.env?.generated || []) {
    values[key] = existing[key] || generatedSecretPlaceholder(key, context);
  }

  for (const key of manifest.env?.copyFromShell || []) {
    values[key] = process.env[key] || existing[key] || '';
  }

  return values;
}

export function parseEnvContent(content) {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function d1Bindings(manifest, state) {
  return resourcesOfType(manifest, 'cloudflare.d1').map((resource) => ({
    binding: resource.binding || 'DB',
    database_name: resource.name,
    database_id: state.resources?.[resource.id]?.providerId || '',
    migrations_dir: resource.migrationsDir || './src/db/migrations',
  }));
}

function r2Bindings(manifest) {
  return resourcesOfType(manifest, 'cloudflare.r2').map((resource) => ({
    binding: resource.binding || 'BUCKET',
    bucket_name: resource.name,
  }));
}

function kvBindings(manifest, state) {
  return resourcesOfType(manifest, 'cloudflare.kv').map((resource) => ({
    binding: resource.binding || 'CACHE',
    id: state.resources?.[resource.id]?.providerId || '',
  }));
}

function resourcesOfType(manifest, type) {
  return (manifest.resources || []).filter((resource) => resource.enabled !== false && resource.type === type);
}

function resourceByType(manifest, type) {
  return resourcesOfType(manifest, type)[0];
}

function productionBaseUrl(manifest, state) {
  if (manifest.domain?.production) return `https://${manifest.domain.production}`;
  return state.deploymentUrl || '';
}

function githubWorkflowEnv(manifest) {
  const generated = manifest.env?.generated || [];
  const required = manifest.github?.actionsSecrets?.length
    ? manifest.github.actionsSecrets
    : manifest.env?.required || [];
  const provider = manifest.target?.provider === 'cloudflare'
    ? ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']
    : manifest.env?.provider || [];
  const seen = new Set();
  return [...required, ...provider, ...generated]
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort();
}

function githubDeployPathLines(manifest) {
  const paths = manifest.github?.deployPaths;
  if (!Array.isArray(paths) || paths.length === 0) return [];
  return [
    '    paths:',
    ...paths.map((deployPath) => `      - ${JSON.stringify(deployPath)}`),
  ];
}

function defaultInstallCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm install';
  if (packageManager === 'bun') return 'bun install';
  if (packageManager === 'yarn') return 'yarn install';
  return 'npm install';
}

function nodeCache(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm';
  if (packageManager === 'yarn') return 'yarn';
  return 'npm';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatedSecretPlaceholder(key, context) {
  if (process.env[key]) return process.env[key];
  context.generatedEnv ||= {};
  if (context.generatedEnv[key]) return context.generatedEnv[key];
  context.generatedEnv[key] =
    key === 'BETTER_AUTH_SECRET' ? crypto.randomBytes(32).toString('base64url') : '';
  return context.generatedEnv[key];
}

function formatEnvValue(value) {
  return `'${String(value ?? '').replace(/'/g, "\\'")}'`;
}
