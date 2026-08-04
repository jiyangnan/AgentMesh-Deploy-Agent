import { githubRepoSlugFromTarget } from '../tooling.js';

const GITHUB_SECRET_MAX_ATTEMPTS = 4;
const GITHUB_SECRET_RETRY_DELAY_MS = 5000;

export function githubActionsForStep(step, manifest) {
  if (step.id === 'github-auth') {
    const repo = step.repo || manifest.github?.repo || manifest.app.id;
    return [
      {
        type: 'provider-auth-check',
        provider: 'github',
        command: githubAuthProbeCommand({
          repo,
          checkSecrets: githubSecretsLikelyNeeded(manifest),
        }),
        displayCommand: githubAuthDisplayCommand({
          repo,
          checkSecrets: githubSecretsLikelyNeeded(manifest),
        }),
        effect: 'verify GitHub CLI authentication, API access, and repository secret visibility',
        sideEffect: 'read-only',
      },
    ];
  }

  if (step.id === 'git-init') {
    return [
      {
        type: 'git-init-if-missing',
        effect: 'initialize local Git repository when missing',
        sideEffect: 'filesystem',
      },
    ];
  }

  if (step.id === 'github-repo') {
    const repo = step.repo || manifest.github?.repo || manifest.app.id;
    const visibilityFlag = step.visibility === 'public' ? '--public' : '--private';
    return [
      {
        type: 'github-repo',
        repo,
        visibility: step.visibility || manifest.github?.visibility || 'private',
        commands: [
          ['gh', 'repo', 'view', repo, '--json', 'url', '--jq', '.url'],
          ['gh', 'repo', 'create', repo, visibilityFlag, '--source=.', '--remote=origin'],
        ],
        effect: `create or connect GitHub repository ${repo}`,
        sideEffect: 'provider-mutation',
        captures: [
          {
            key: 'github_repo_url',
            statePath: 'github.repoUrl',
            required: true,
          },
        ],
      },
    ];
  }

  if (step.id === 'sync-github-secrets') {
    if (step.command) {
      return [
        {
          type: 'command',
          command: step.command,
          ...(typeof step.command === 'string' ? { commandTrust: 'product-manifest' } : {}),
          effect: 'sync GitHub Actions secrets using project script',
          sideEffect: 'provider-mutation',
          redactOutput: true,
        },
      ];
    }

    return (step.secrets || []).map((secret) => secretAction(secret, step));
  }

  if (step.id === 'commit-and-push') {
    const repo = step.repo || manifest.github?.repo || manifest.app.id;
    return [
      {
        type: 'git-remote-ensure',
        remote: 'origin',
        repo,
        remoteUrlStatePath: 'github.repoUrl',
        effect: 'ensure git remote origin points at the GitHub repository',
        sideEffect: 'vcs-mutation',
      },
      {
        type: 'command',
        command: ['git', 'add', '--', ...deployBaselineStagePaths(manifest)],
        effect: 'stage deployment baseline',
        sideEffect: 'filesystem',
      },
      {
        type: 'git-commit-if-changed',
        command: ['git', 'commit', '-m', 'chore: initialize AgentMesh deploy'],
        effect: 'commit deployment baseline when there are changes',
        sideEffect: 'vcs-mutation',
      },
      {
        type: 'command',
        command: ['git', 'push', '-u', 'origin', 'HEAD:main'],
        effect: 'push deployment baseline',
        sideEffect: 'provider-mutation',
      },
    ];
  }

  return [];
}

function deployBaselineStagePaths(manifest) {
  return [
    '.gitignore',
    '.agentmesh-deploy/manifest.json',
    '.agentmesh-deploy/RUNBOOK.md',
    ...(manifest.github?.enabled === false ? [] : ['.github/workflows/deploy.yml']),
    ...(manifest.target?.provider === 'cloudflare' ? ['wrangler.jsonc'] : []),
  ];
}

export function githubAuthProbeCommand({ repo = '', checkSecrets = false, hostname = 'github.com' } = {}) {
  return [
    'node',
    '-e',
    githubAuthProbeScript(),
    JSON.stringify({
      hostname,
      repo: githubRepoSlugFromTarget(repo),
      checkSecrets: Boolean(checkSecrets),
    }),
  ];
}

function githubAuthDisplayCommand({ repo = '', checkSecrets = false, hostname = 'github.com' } = {}) {
  const normalizedRepo = githubRepoSlugFromTarget(repo);
  return [
    'github-auth-probe',
    `--hostname=${hostname}`,
    ...(normalizedRepo ? [`--repo=${normalizedRepo}`] : []),
    ...(checkSecrets ? ['--check-actions-secrets'] : []),
  ];
}

function githubSecretsLikelyNeeded(manifest) {
  const explicit = manifest.github?.actionsSecrets;
  if (Array.isArray(explicit)) return explicit.length > 0;
  return Boolean(
    (manifest.env?.required || []).length > 0 ||
      (manifest.env?.generated || []).length > 0 ||
      manifest.target?.provider === 'cloudflare' ||
      manifest.target?.type === 'docker-compose-caddy'
  );
}

function githubAuthProbeScript() {
  return `
    const { spawnSync } = require('node:child_process');
    const payload = JSON.parse(process.argv[1] || '{}');
    const hostname = payload.hostname || 'github.com';
    const repo = payload.repo || '';

    function runGh(args, options = {}) {
      const result = spawnSync('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      if (result.status === 0) return result.stdout || '';
      const output = compact(result.stderr || result.stdout || result.error?.message || '');
      throw new Error((options.label || ('gh ' + args.join(' '))) + ' failed' + (output ? ': ' + output : ''));
    }

    function tryGh(args) {
      return spawnSync('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    }

    function compact(value) {
      return String(value || '').replace(/\\s+/g, ' ').trim();
    }

    function hasUsableRepo(value) {
      return /^[^\\s/]+\\/[^\\s/]+$/.test(String(value || ''));
    }

    try {
      runGh(['auth', 'status', '--active', '--hostname', hostname], {
        label: 'GitHub CLI authentication',
      });
      const login = compact(runGh(['api', 'user', '--jq', '.login'], {
        label: 'GitHub API user probe',
      }));
      if (login) console.log('github_login = ' + login);
      console.log('github_api_access = ok');

      if (hasUsableRepo(repo)) {
        const viewed = tryGh(['repo', 'view', repo, '--json', 'nameWithOwner,url']);
        if (viewed.status === 0) {
          let body = {};
          try {
            body = JSON.parse(viewed.stdout || '{}');
          } catch {
            throw new Error('GitHub repo view returned non-JSON output for ' + repo);
          }
          console.log('github_repo = ' + (body.nameWithOwner || repo));
          if (payload.checkSecrets) {
            runGh(['secret', 'list', '--repo', repo, '--app', 'actions', '--json', 'name', '--jq', 'length'], {
              label: 'GitHub Actions secret list',
            });
            console.log('github_actions_secret_access = ok');
          }
        } else {
          console.log('github_repo_access = unverified');
        }
      }

      console.log('github-auth-ok');
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
  `;
}

function secretAction(secret, step) {
  const key = typeof secret === 'string' ? secret : secret.key;
  const action = {
    type: 'github-secret',
    key,
    repo: step.repo,
    repoUrlStatePath: 'github.repoUrl',
    effect: `sync GitHub Actions secret ${key}`,
    sideEffect: 'provider-mutation',
    secret: key,
    redactOutput: true,
    maxAttempts: GITHUB_SECRET_MAX_ATTEMPTS,
    retryDelayMs: GITHUB_SECRET_RETRY_DELAY_MS,
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

  if (secret.source === 'state') {
    return {
      ...action,
      stdinFromState: {
        path: secret.statePath,
      },
    };
  }

  return {
    ...action,
    stdinFromEnv: key,
  };
}
