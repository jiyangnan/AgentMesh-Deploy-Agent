export function cloudflareApiEnvKeys(manifest) {
  const keys = new Set(manifest.env?.provider || []);
  const registration = manifest.domain?.registration || {};

  if (registration.provider === 'cloudflare') {
    keys.add(registration.accountIdEnv || manifest.domain?.zone?.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID');
    keys.add(registration.apiTokenEnv || 'CLOUDFLARE_API_TOKEN');
  }

  if (manifest.domain?.zone?.provider === 'cloudflare') {
    keys.add(manifest.domain.zone.accountIdEnv || 'CLOUDFLARE_ACCOUNT_ID');
    keys.add('CLOUDFLARE_API_TOKEN');
  }

  if (manifest.deployment?.dns?.provider === 'cloudflare') {
    keys.add('CLOUDFLARE_API_TOKEN');
  }

  if (manifest.github?.enabled !== false && manifest.target?.provider === 'cloudflare') {
    keys.add('CLOUDFLARE_ACCOUNT_ID');
    keys.add('CLOUDFLARE_API_TOKEN');
  }

  return Array.from(keys).filter(Boolean);
}
