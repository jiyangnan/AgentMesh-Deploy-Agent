import { DEPLOY_MANIFEST_SCHEMA_ID } from './schema.js';

const SUPPORTED_VERSION = 1;
const SUPPORTED_RUNTIME_TYPES = new Set(['node', 'python']);
const SUPPORTED_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'pip', 'poetry']);
const SUPPORTED_TARGETS = new Map([
  ['cloudflare', new Set(['cloudflare-workers'])],
  ['digitalocean', new Set(['docker-compose-caddy'])],
]);
const SUPPORTED_RESOURCE_TYPES = new Set(['cloudflare.d1', 'cloudflare.r2', 'cloudflare.kv']);
const SUPPORTED_GITHUB_VISIBILITY = new Set(['private', 'public', 'internal']);
const SUPPORTED_DEPLOYMENT_KINDS = new Set(['docker-compose-caddy']);
const SUPPORTED_INFRASTRUCTURE_PROVIDERS = new Set(['digitalocean']);
const SUPPORTED_INFRASTRUCTURE_MODES = new Set(['adopt-existing', 'provision']);
const SUPPORTED_CADDY_MODES = new Set(['shared-container', 'managed-container', 'host']);
const SUPPORTED_DNS_PROVIDERS = new Set(['cloudflare', 'manual']);
const SUPPORTED_DNS_RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const SUPPORTED_DOMAIN_REGISTRATION_PROVIDERS = new Set(['manual', 'cloudflare', 'porkbun']);
const SUPPORTED_DOMAIN_REGISTRATION_MODES = new Set(['adopt-existing', 'register']);
const SUPPORTED_DOMAIN_ZONE_PROVIDERS = new Set(['cloudflare', 'manual']);

const APP_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const RESOURCE_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const CLOUD_RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function validateManifest(manifest) {
  const issues = [];
  const add = (severity, code, path, message) => {
    issues.push({ severity, code, path, message });
  };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add('error', 'manifest-not-object', '$', 'manifest must be a JSON object.');
    return validationResult(issues);
  }

  validateSchemaPointer(manifest, add);
  validateVersion(manifest, add);
  validateApp(manifest, add);
  validateRuntime(manifest, add);
  validateTarget(manifest, add);
  validateCommands(manifest, add);
  validateResources(manifest, add);
  validateEnv(manifest, add);
  validateDomain(manifest, add);
  validateDeployment(manifest, add);
  validateGithub(manifest, add);
  validateSafety(manifest, add);

  return validationResult(issues);
}

export function formatManifestIssues(issues) {
  return (issues || [])
    .map((issue) => `${issue.severity}: ${issue.path} ${issue.code} - ${issue.message}`)
    .join('\n');
}

export function manifestValidationError(validation) {
  return new Error(`Manifest validation failed:\n${formatManifestIssues(validation.issues)}`);
}

function validationResult(issues) {
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    status: errors > 0 ? 'invalid' : 'valid',
    errors,
    warnings,
    issues,
  };
}

function validateSchemaPointer(manifest, add) {
  if (manifest.schema === undefined) return;
  if (!isNonEmptyString(manifest.schema)) {
    add(
      'warning',
      'invalid-schema-pointer',
      'schema',
      'schema should be the AgentMesh Deploy manifest schema URL.'
    );
    return;
  }
  if (manifest.schema !== DEPLOY_MANIFEST_SCHEMA_ID) {
    add(
      'warning',
      'unknown-schema-pointer',
      'schema',
      `expected ${DEPLOY_MANIFEST_SCHEMA_ID}.`
    );
  }
}

function validateVersion(manifest, add) {
  if (manifest.version !== SUPPORTED_VERSION) {
    add('error', 'unsupported-version', 'version', 'version must be 1.');
  }
}

function validateApp(manifest, add) {
  if (!isObject(manifest.app)) {
    add('error', 'missing-app', 'app', 'app must be an object.');
    return;
  }

  requireString(manifest.app.id, 'app.id', add);
  requireString(manifest.app.name, 'app.name', add);
  requireString(manifest.app.root, 'app.root', add);

  if (isNonEmptyString(manifest.app.id) && !APP_ID_RE.test(manifest.app.id)) {
    add(
      'error',
      'invalid-app-id',
      'app.id',
      'app.id must be a lowercase slug using letters, numbers, and hyphens.'
    );
  }
  if (isNonEmptyString(manifest.app.root) && manifest.app.root !== '.') {
    add('warning', 'non-default-app-root', 'app.root', 'only "." is exercised in v0.x.');
  }
}

function validateRuntime(manifest, add) {
  if (!isObject(manifest.runtime)) {
    add('error', 'missing-runtime', 'runtime', 'runtime must be an object.');
    return;
  }

  requireString(manifest.runtime.type, 'runtime.type', add);
  requireString(manifest.runtime.packageManager, 'runtime.packageManager', add);

  if (
    isNonEmptyString(manifest.runtime.type) &&
    !SUPPORTED_RUNTIME_TYPES.has(manifest.runtime.type)
  ) {
    add('error', 'unsupported-runtime', 'runtime.type', 'runtime must be node or python.');
  }
  if (
    isNonEmptyString(manifest.runtime.packageManager) &&
    !SUPPORTED_PACKAGE_MANAGERS.has(manifest.runtime.packageManager)
  ) {
    add(
      'error',
      'unsupported-package-manager',
      'runtime.packageManager',
      'package manager must be npm, pnpm, yarn, bun, uv, pip, or poetry.'
    );
  }
  if (manifest.runtime.frameworks !== undefined && !Array.isArray(manifest.runtime.frameworks)) {
    add('error', 'invalid-frameworks', 'runtime.frameworks', 'frameworks must be an array.');
  }
}

function validateTarget(manifest, add) {
  if (!isObject(manifest.target)) {
    add('error', 'missing-target', 'target', 'target must be an object.');
    return;
  }

  requireString(manifest.target.provider, 'target.provider', add);
  requireString(manifest.target.type, 'target.type', add);

  const targetTypes = SUPPORTED_TARGETS.get(manifest.target.provider);
  if (!targetTypes) {
    add(
      'error',
      'unsupported-provider',
      'target.provider',
      `supported providers: ${Array.from(SUPPORTED_TARGETS.keys()).join(', ')}.`
    );
    return;
  }
  if (!targetTypes.has(manifest.target.type)) {
    add(
      'error',
      'unsupported-target-type',
      'target.type',
      `provider ${manifest.target.provider} supports: ${Array.from(targetTypes).join(', ')}.`
    );
  }
}

function validateCommands(manifest, add) {
  if (!isObject(manifest.commands)) {
    add('error', 'missing-commands', 'commands', 'commands must be an object.');
    return;
  }

  for (const [key, value] of Object.entries(manifest.commands)) {
    if (value !== undefined && value !== '' && typeof value !== 'string') {
      add('error', 'invalid-command', `commands.${key}`, 'command values must be strings.');
    }
  }

  if (!isNonEmptyString(manifest.commands.install)) {
    add('warning', 'missing-install-command', 'commands.install', 'install command is empty.');
  }
  if (!isNonEmptyString(manifest.commands.build) && !isNonEmptyString(manifest.commands.composeConfig)) {
    add('warning', 'missing-build-command', 'commands.build', 'build command is empty.');
  }
  if (manifest.target?.type === 'cloudflare-workers' && !isNonEmptyString(manifest.commands.deploy)) {
    add('error', 'missing-deploy-command', 'commands.deploy', 'Cloudflare Workers target requires a deploy command.');
  }
}

function validateResources(manifest, add) {
  if (manifest.resources === undefined) return;
  if (!Array.isArray(manifest.resources)) {
    add('error', 'invalid-resources', 'resources', 'resources must be an array.');
    return;
  }

  const ids = new Set();
  const enabledBindings = new Set();
  const enabledTypeNames = new Set();

  manifest.resources.forEach((resource, index) => {
    const base = `resources[${index}]`;
    if (!isObject(resource)) {
      add('error', 'invalid-resource', base, 'resource must be an object.');
      return;
    }

    validateResourceId(resource, base, ids, add);
    requireString(resource.type, `${base}.type`, add);
    requireString(resource.name, `${base}.name`, add);

    const enabled = resource.enabled !== false;
    if (isNonEmptyString(resource.type) && !SUPPORTED_RESOURCE_TYPES.has(resource.type)) {
      add(
        'error',
        'unsupported-resource-type',
        `${base}.type`,
        `supported resource types: ${Array.from(SUPPORTED_RESOURCE_TYPES).join(', ')}.`
      );
    }
    if (isNonEmptyString(resource.name) && !CLOUD_RESOURCE_NAME_RE.test(resource.name)) {
      add(
        'warning',
        'resource-name-not-portable',
        `${base}.name`,
        'resource names should use lowercase letters, numbers, and hyphens for Cloudflare portability.'
      );
    }

    if (enabled) {
      requireString(resource.binding, `${base}.binding`, add);
      if (isNonEmptyString(resource.binding) && !ENV_KEY_RE.test(resource.binding)) {
        add('error', 'invalid-binding', `${base}.binding`, 'binding must be an uppercase env-style key.');
      }
      if (isNonEmptyString(resource.binding)) {
        addDuplicate(resource.binding, enabledBindings, 'duplicate-binding', `${base}.binding`, add);
      }
      if (isNonEmptyString(resource.type) && isNonEmptyString(resource.name)) {
        addDuplicate(
          `${resource.type}:${resource.name}`,
          enabledTypeNames,
          'duplicate-resource-target',
          `${base}.name`,
          add
        );
      }
    }
  });
}

function validateResourceId(resource, base, ids, add) {
  requireString(resource.id, `${base}.id`, add);
  if (!isNonEmptyString(resource.id)) return;
  if (!RESOURCE_ID_RE.test(resource.id)) {
    add(
      'error',
      'invalid-resource-id',
      `${base}.id`,
      'resource id must be a state-safe identifier without dots or slashes.'
    );
  }
  addDuplicate(resource.id, ids, 'duplicate-resource-id', `${base}.id`, add);
}

function validateEnv(manifest, add) {
  if (manifest.env === undefined) return;
  if (!isObject(manifest.env)) {
    add('error', 'invalid-env', 'env', 'env must be an object.');
    return;
  }

  const groups = ['required', 'generated', 'provider', 'copyFromShell'];
  const keysByGroup = new Map();

  for (const group of groups) {
    const path = `env.${group}`;
    const keys = manifest.env[group] || [];
    if (!Array.isArray(keys)) {
      add('error', 'invalid-env-list', path, `${path} must be an array.`);
      keysByGroup.set(group, []);
      continue;
    }
    keysByGroup.set(group, keys);
    validateEnvKeyList(keys, path, add);
  }

  const sourceKeys = new Map();
  for (const group of ['required', 'generated', 'provider']) {
    for (const key of keysByGroup.get(group) || []) {
      if (!ENV_KEY_RE.test(key)) continue;
      const previous = sourceKeys.get(key);
      if (previous && previous !== group) {
        add(
          'error',
          'conflicting-env-source',
          `env.${group}`,
          `${key} is declared in both env.${previous} and env.${group}.`
        );
      }
      sourceKeys.set(key, group);
    }
  }

  for (const key of keysByGroup.get('copyFromShell') || []) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (!sourceKeys.has(key)) {
      add(
        'warning',
        'copy-source-not-declared',
        'env.copyFromShell',
        `${key} is copied from shell but is not declared as required/generated/provider.`
      );
    }
  }
}

function validateEnvKeyList(keys, path, add) {
  const seen = new Set();
  keys.forEach((key, index) => {
    const keyPath = `${path}[${index}]`;
    if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
      add('error', 'invalid-env-key', keyPath, 'env keys must match /^[A-Z_][A-Z0-9_]*$/.');
      return;
    }
    addDuplicate(key, seen, 'duplicate-env-key', keyPath, add, 'warning');
  });
}

function validateDomain(manifest, add) {
  if (manifest.domain === undefined) return;
  if (!isObject(manifest.domain)) {
    add('error', 'invalid-domain', 'domain', 'domain must be an object.');
    return;
  }
  if (manifest.domain.production === undefined || manifest.domain.production === '') return;
  if (typeof manifest.domain.production !== 'string') {
    add('error', 'invalid-production-domain', 'domain.production', 'production domain must be a string.');
    return;
  }
  if (
    /^https?:\/\//i.test(manifest.domain.production) ||
    manifest.domain.production.includes('/') ||
    /\s/.test(manifest.domain.production)
  ) {
    add(
      'error',
      'invalid-production-domain',
      'domain.production',
      'use a host name such as app.example.com, without protocol, path, or spaces.'
    );
  }
  validateDomainRegistration(manifest.domain.registration, add);
  validateDomainZone(manifest.domain.zone, add);
}

function validateDomainRegistration(registration, add) {
  if (registration === undefined) return;
  if (!isObject(registration)) {
    add('error', 'invalid-domain-registration', 'domain.registration', 'domain.registration must be an object.');
    return;
  }
  if (
    isNonEmptyString(registration.provider) &&
    !SUPPORTED_DOMAIN_REGISTRATION_PROVIDERS.has(registration.provider)
  ) {
    add(
      'error',
      'unsupported-domain-registration-provider',
      'domain.registration.provider',
      `supported domain registration providers: ${Array.from(SUPPORTED_DOMAIN_REGISTRATION_PROVIDERS).join(', ')}.`
    );
  }
  if (
    isNonEmptyString(registration.mode) &&
    !SUPPORTED_DOMAIN_REGISTRATION_MODES.has(registration.mode)
  ) {
    add(
      'error',
      'unsupported-domain-registration-mode',
      'domain.registration.mode',
      'mode must be adopt-existing or register.'
    );
  }
  if (registration.years !== undefined && (!Number.isInteger(registration.years) || registration.years < 1 || registration.years > 10)) {
    add('error', 'invalid-domain-registration-years', 'domain.registration.years', 'years must be an integer from 1 to 10.');
  }
  if (registration.provider === 'porkbun' || registration.provider === 'cloudflare') {
    if (registration.mode === 'register' && registration.agreeToTerms !== true) {
      add(
        'error',
        'missing-domain-registration-terms',
        'domain.registration.agreeToTerms',
        `${domainRegistrationProviderName(registration.provider)} registration requires agreeToTerms: true before a billable domain registration can execute.`
      );
    }
    if (
      registration.mode === 'register' &&
      (registration.maxCostUsd === undefined ||
        typeof registration.maxCostUsd !== 'number' ||
        !Number.isFinite(registration.maxCostUsd) ||
        registration.maxCostUsd <= 0)
    ) {
      add(
        'error',
        'missing-domain-registration-max-cost',
        'domain.registration.maxCostUsd',
        `${domainRegistrationProviderName(registration.provider)} registration requires a positive maxCostUsd cap.`
      );
    }
    const envKeys =
      registration.provider === 'cloudflare'
        ? ['accountIdEnv', 'apiTokenEnv']
        : ['apiKeyEnv', 'secretApiKeyEnv'];
    for (const key of envKeys) {
      if (registration[key] !== undefined && !ENV_KEY_RE.test(registration[key])) {
        add('error', 'invalid-domain-registration-env', `domain.registration.${key}`, `${key} must be an environment variable name.`);
      }
    }
    if (
      registration.provider === 'cloudflare' &&
      registration.autoRenew !== undefined &&
      typeof registration.autoRenew !== 'boolean'
    ) {
      add('error', 'invalid-domain-registration-auto-renew', 'domain.registration.autoRenew', 'autoRenew must be a boolean.');
    }
  }
}

function domainRegistrationProviderName(provider) {
  return provider === 'cloudflare' ? 'Cloudflare Registrar' : 'Porkbun';
}

function validateDomainZone(zone, add) {
  if (zone === undefined) return;
  if (!isObject(zone)) {
    add('error', 'invalid-domain-zone', 'domain.zone', 'domain.zone must be an object.');
    return;
  }
  if (isNonEmptyString(zone.provider) && !SUPPORTED_DOMAIN_ZONE_PROVIDERS.has(zone.provider)) {
    add(
      'error',
      'unsupported-domain-zone-provider',
      'domain.zone.provider',
      `supported domain zone providers: ${Array.from(SUPPORTED_DOMAIN_ZONE_PROVIDERS).join(', ')}.`
    );
  }
  if (zone.provider === 'cloudflare') {
    requireString(zone.name, 'domain.zone.name', add);
    requireString(zone.accountIdEnv, 'domain.zone.accountIdEnv', add);
    if (isNonEmptyString(zone.accountIdEnv) && !ENV_KEY_RE.test(zone.accountIdEnv)) {
      add('error', 'invalid-domain-zone-account-env', 'domain.zone.accountIdEnv', 'accountIdEnv must be an uppercase env-style key.');
    }
  }
}

function validateDeployment(manifest, add) {
  if (manifest.deployment === undefined) return;
  if (!isObject(manifest.deployment)) {
    add('error', 'invalid-deployment', 'deployment', 'deployment must be an object.');
    return;
  }

  if (manifest.deployment.kind !== undefined) {
    requireString(manifest.deployment.kind, 'deployment.kind', add);
    if (
      isNonEmptyString(manifest.deployment.kind) &&
      !SUPPORTED_DEPLOYMENT_KINDS.has(manifest.deployment.kind)
    ) {
      add(
        'error',
        'unsupported-deployment-kind',
        'deployment.kind',
        `supported deployment kinds: ${Array.from(SUPPORTED_DEPLOYMENT_KINDS).join(', ')}.`
      );
    }
  }

  validateDeploymentInfrastructure(manifest.deployment.infrastructure, add);
  validateDeploymentDns(manifest.deployment.dns, add);
}

function validateDeploymentInfrastructure(infrastructure, add) {
  if (infrastructure === undefined) return;
  if (!isObject(infrastructure)) {
    add('error', 'invalid-infrastructure', 'deployment.infrastructure', 'infrastructure must be an object.');
    return;
  }

  if (
    isNonEmptyString(infrastructure.provider) &&
    !SUPPORTED_INFRASTRUCTURE_PROVIDERS.has(infrastructure.provider)
  ) {
    add(
      'error',
      'unsupported-infrastructure-provider',
      'deployment.infrastructure.provider',
      `supported infrastructure providers: ${Array.from(SUPPORTED_INFRASTRUCTURE_PROVIDERS).join(', ')}.`
    );
  }
  if (
    isNonEmptyString(infrastructure.mode) &&
    !SUPPORTED_INFRASTRUCTURE_MODES.has(infrastructure.mode)
  ) {
    add(
      'error',
      'unsupported-infrastructure-mode',
      'deployment.infrastructure.mode',
      'mode must be adopt-existing or provision.'
    );
  }
  if (infrastructure.sshHost && invalidHost(infrastructure.sshHost)) {
    add(
      'error',
      'invalid-ssh-host',
      'deployment.infrastructure.sshHost',
      'sshHost must be a host or IP without protocol, path, or spaces.'
    );
  }
  if (infrastructure.sshPort !== undefined && !validPort(infrastructure.sshPort)) {
    add('error', 'invalid-ssh-port', 'deployment.infrastructure.sshPort', 'sshPort must be an integer from 1 to 65535.');
  }
  if (infrastructure.appDir !== undefined && !absoluteUnixPath(infrastructure.appDir)) {
    add('error', 'invalid-app-dir', 'deployment.infrastructure.appDir', 'appDir must be an absolute Unix path.');
  }
  if (
    isNonEmptyString(infrastructure.caddyMode) &&
    !SUPPORTED_CADDY_MODES.has(infrastructure.caddyMode)
  ) {
    add(
      'error',
      'unsupported-caddy-mode',
      'deployment.infrastructure.caddyMode',
      `caddyMode must be ${Array.from(SUPPORTED_CADDY_MODES).join(', ')}.`
    );
  }
}

function validateDeploymentDns(dns, add) {
  if (dns === undefined) return;
  if (!isObject(dns)) {
    add('error', 'invalid-dns', 'deployment.dns', 'dns must be an object.');
    return;
  }
  if (isNonEmptyString(dns.provider) && !SUPPORTED_DNS_PROVIDERS.has(dns.provider)) {
    add(
      'error',
      'unsupported-dns-provider',
      'deployment.dns.provider',
      `supported DNS providers: ${Array.from(SUPPORTED_DNS_PROVIDERS).join(', ')}.`
    );
  }
  if (isNonEmptyString(dns.recordType) && !SUPPORTED_DNS_RECORD_TYPES.has(dns.recordType)) {
    add(
      'error',
      'unsupported-dns-record-type',
      'deployment.dns.recordType',
      `supported DNS record types: ${Array.from(SUPPORTED_DNS_RECORD_TYPES).join(', ')}.`
    );
  }
  if (dns.provider === 'cloudflare') {
    requireString(dns.zone, 'deployment.dns.zone', add);
    requireString(dns.name, 'deployment.dns.name', add);
  }
}

function validateGithub(manifest, add) {
  if (manifest.github === undefined || manifest.github?.enabled === false) return;
  if (!isObject(manifest.github)) {
    add('error', 'invalid-github', 'github', 'github must be an object.');
    return;
  }

  requireString(manifest.github.repo, 'github.repo', add);
  if (isNonEmptyString(manifest.github.repo) && !isValidGithubRepoTarget(manifest.github.repo)) {
    add(
      'error',
      'invalid-github-repo',
      'github.repo',
      'github.repo must be a repo name or owner/repo slug.'
    );
  }

  const visibility = manifest.github.visibility || 'private';
  if (!SUPPORTED_GITHUB_VISIBILITY.has(visibility)) {
    add(
      'error',
      'invalid-github-visibility',
      'github.visibility',
      'visibility must be private, public, or internal.'
    );
  }

  if (manifest.github.actionsSecrets !== undefined) {
    if (!Array.isArray(manifest.github.actionsSecrets)) {
      add(
        'error',
        'invalid-github-actions-secrets',
        'github.actionsSecrets',
        'actionsSecrets must be an array.'
      );
    } else {
      validateEnvKeyList(manifest.github.actionsSecrets, 'github.actionsSecrets', add);
    }
  }

  if (manifest.github.deployPaths !== undefined) {
    if (!Array.isArray(manifest.github.deployPaths) || manifest.github.deployPaths.length === 0) {
      add(
        'error',
        'invalid-github-deploy-paths',
        'github.deployPaths',
        'deployPaths must be a non-empty array of repository-relative GitHub path patterns.'
      );
    } else {
      manifest.github.deployPaths.forEach((deployPath, index) => {
        if (
          !isNonEmptyString(deployPath) ||
          deployPath.startsWith('/') ||
          deployPath.includes('\\') ||
          /[\r\n]/.test(deployPath)
        ) {
          add(
            'error',
            'invalid-github-deploy-path',
            `github.deployPaths[${index}]`,
            'deploy path patterns must be non-empty, repository-relative, slash-separated strings.'
          );
        }
      });
    }
  }
}

function validateSafety(manifest, add) {
  if (manifest.safety === undefined) return;
  if (!isObject(manifest.safety)) {
    add('error', 'invalid-safety', 'safety', 'safety must be an object.');
    return;
  }
  if (manifest.safety.defaultMode && manifest.safety.defaultMode !== 'dry-run') {
    add('warning', 'non-dry-run-default', 'safety.defaultMode', 'dry-run is the expected default mode.');
  }
  const required = manifest.safety.realExecutionRequires || [];
  if (
    Array.isArray(required) &&
    (!required.includes('--execute') || !required.includes('--yes'))
  ) {
    add(
      'warning',
      'missing-execution-confirmation-flags',
      'safety.realExecutionRequires',
      'real execution should require --execute and --yes.'
    );
  }
}

function addDuplicate(value, seen, code, path, add, severity = 'error') {
  if (seen.has(value)) {
    add(severity, code, path, `${value} is duplicated.`);
  }
  seen.add(value);
}

function requireString(value, path, add) {
  if (!isNonEmptyString(value)) {
    add('error', 'missing-required-string', path, `${path} must be a non-empty string.`);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidGithubRepoTarget(value) {
  const parts = value.split('/');
  if (parts.length === 1) return GITHUB_NAME_RE.test(parts[0]);
  if (parts.length !== 2) return false;
  return GITHUB_OWNER_RE.test(parts[0]) && GITHUB_NAME_RE.test(parts[1]);
}

function invalidHost(value) {
  return (
    typeof value !== 'string' ||
    /^https?:\/\//i.test(value) ||
    value.includes('/') ||
    /\s/.test(value)
  );
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function absoluteUnixPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !/\0/.test(value);
}
