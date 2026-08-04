export function createProviderHttpTransport(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 10000;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  return {
    async request(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: serializeBody(request.body),
          redirect: 'manual',
          signal: controller.signal,
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
        return {
          ok: response.ok,
          status: response.status,
          retryAfter: response.headers?.get?.('retry-after') || '',
          message: data?.error?.message || data?.message || `HTTP ${response.status}`,
          data,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createFixedHostFetch(allowedHosts, fetchImpl = globalThis.fetch) {
  const hosts = new Set((allowedHosts || []).map((value) => String(value).toLowerCase()));
  if (hosts.size === 0 || typeof fetchImpl !== 'function') throw new Error('Fixed-host fetch requires allowed hosts and fetch.');
  return async function fixedHostFetch(input, init = {}) {
    let url;
    try { url = new URL(String(input)); }
    catch { throw new Error('Provider URL is invalid.'); }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname.toLowerCase())) {
      throw new Error('Provider URL is outside the approved fixed HTTPS hosts.');
    }
    const response = await fetchImpl(url.toString(), { ...init, redirect: 'manual' });
    if (response?.url) {
      const observed = new URL(response.url);
      if (observed.protocol !== 'https:' || observed.port || !hosts.has(observed.hostname.toLowerCase())) {
        try { await response.body?.cancel?.(); } catch {}
        throw new Error('Provider response escaped the approved fixed HTTPS hosts.');
      }
    }
    return response;
  };
}

function serializeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}
