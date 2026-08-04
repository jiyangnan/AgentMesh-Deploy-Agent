export function parseCapture(output, capture) {
  if (!capture?.key) return '';
  if (capture.key === 'database_id') return parseD1DatabaseId(output);
  if (capture.key === 'id') return parseKvNamespaceId(output);
  if (capture.key === 'deployment_url') return parseDeploymentUrl(output);
  if (capture.key === 'github_repo_url') return parseGithubRepoUrl(output);
  return parseGenericValue(output, capture.key);
}

export function parseD1DatabaseId(output) {
  const match = output.match(/database_id["'\s:=]+([0-9a-f]{8}-[0-9a-f-]{27})/i);
  if (match) return match[1];
  return output.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0] || '';
}

export function parseKvNamespaceId(output) {
  const match = output.match(/\bid["'\s:=]+([0-9a-f]{32})\b/i);
  if (match) return match[1];
  return output.match(/\b[0-9a-f]{32}\b/i)?.[0] || '';
}

export function parseDeploymentUrl(output) {
  return output
    .match(/https:\/\/[^\s)]+/g)
    ?.find((url) => url.includes('.workers.dev') || !url.includes('github.com')) || '';
}

export function parseGithubRepoUrl(output) {
  return output.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i)?.[0] || '';
}

export function findCloudflareResource(output, resource) {
  const fromJson = findCloudflareResourceFromJson(output, resource);
  if (fromJson) return fromJson;
  return findCloudflareResourceFromText(output, resource);
}

function parseGenericValue(output, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escapedKey}["'\\s:=]+([^\\s"',]+)`, 'i'));
  return match?.[1] || '';
}

function findCloudflareResourceFromJson(output, resource) {
  try {
    const parsed = JSON.parse(String(output || '').trim());
    const candidates = collectObjects(parsed);
    for (const candidate of candidates) {
      const name = resourceName(candidate);
      if (name !== resource.name) continue;
      const id = resourceId(candidate, resource);
      if (id) return { name, id };
    }
  } catch {
    // Wrangler commands are not consistent about JSON output; text fallback handles tables.
  }
  return null;
}

function findCloudflareResourceFromText(output, resource) {
  const line = String(output || '')
    .split(/\r?\n/)
    .find((value) => value.includes(resource.name));
  if (!line) return null;

  if (resource.type === 'cloudflare.d1') {
    const id = parseD1DatabaseId(line);
    return id ? { name: resource.name, id } : null;
  }
  if (resource.type === 'cloudflare.kv') {
    const id = parseKvNamespaceId(line);
    return id ? { name: resource.name, id } : null;
  }
  if (resource.type === 'cloudflare.r2') {
    return { name: resource.name, id: resource.name };
  }
  return null;
}

function collectObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;

  output.push(value);
  for (const nested of Object.values(value)) {
    collectObjects(nested, output);
  }
  return output;
}

function resourceName(value) {
  return String(value.name || value.title || value.bucket || value.database_name || '').trim();
}

function resourceId(value, resource) {
  const id = String(value.id || value.uuid || value.database_id || '').trim();
  if (id) return id;
  return resource.type === 'cloudflare.r2' ? resourceName(value) : '';
}
