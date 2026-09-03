/**
 * SSRF-hardened outbound HTTP.
 *
 * Anything the server fetches on behalf of a request (previews, remote
 * metadata) must not be able to reach the loopback interface, the LAN, or a
 * cloud metadata endpoint. URLs in this app come out of the database and are
 * set by admins or imported from third parties, so they are *not* trusted.
 *
 * Guarantees:
 *  - only http: / https:
 *  - no credentials in the URL (user:pass@host)
 *  - every resolved A/AAAA record must be a public unicast address
 *  - redirects are followed manually, re-validating each hop (max 3)
 *  - a hard byte ceiling while streaming the body
 *
 * Residual risk: DNS rebinding between our resolve() and fetch()'s own
 * lookup. Node's fetch has no lookup hook, so we accept that narrow window;
 * everything reachable through it is still gated behind an authenticated
 * route and a byte cap.
 */
import dns from 'dns/promises';
import net from 'net';

const MAX_REDIRECTS = 3;

// Ports that are never legitimate file hosting but are juicy internally.
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 587, 993, 995,
  1433, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

function ipv4ToLong(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',       // "this" network
  '10.0.0.0/8',      // private
  '100.64.0.0/10',   // CGNAT
  '127.0.0.0/8',     // loopback
  '169.254.0.0/16',  // link-local + cloud metadata (169.254.169.254)
  '172.16.0.0/12',   // private
  '192.0.0.0/24',    // IETF protocol assignments
  '192.0.2.0/24',    // TEST-NET-1
  '192.88.99.0/24',  // 6to4 relay anycast
  '192.168.0.0/16',  // private
  '198.18.0.0/15',   // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24',  // TEST-NET-3
  '224.0.0.0/4',     // multicast
  '240.0.0.0/4',     // reserved + broadcast
];

/** True when an IP literal must never be contacted by the server. */
export function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return BLOCKED_V4.some(cidr => inCidr(ip, cidr));
  if (version !== 6) return true; // not an IP at all -> refuse

  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4-mapped / -compatible: judge on the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || addr.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);

  if (addr === '::' || addr === '::1') return true;          // unspecified / loopback
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;          // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;          // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(addr)) return true;             // ff00::/8 multicast
  if (addr.startsWith('2002:')) return true;                 // 6to4
  if (addr.startsWith('64:ff9b:')) return true;              // NAT64
  return false;
}

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.statusCode = 400;
  }
}

/**
 * Addresses no endpoint can ever legitimately be, on any network: the "this"
 * network and link-local, which is where every cloud's metadata service lives.
 * Used as the floor below `allowPrivate` policies.
 */
export function isMetadataIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return inCidr(ip, '0.0.0.0/8') || inCidr(ip, '169.254.0.0/16');
  if (version !== 6) return true;

  const addr = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || addr.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isMetadataIp(mapped[1]);
  if (addr === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
  if (addr === 'fd00:ec2::254') return true;        // AWS instance metadata over IPv6
  return false;
}

/** Loopback is where a self-hosted model server lives, so it is judged apart. */
function isLoopbackIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return inCidr(ip, '127.0.0.0/8');
  if (version !== 6) return false;
  const addr = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '::1') return true;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || addr.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isLoopbackIp(mapped[1]) : false;
}

/** Shared body of the two policies below. */
async function validateTarget(rawUrl, { rejectAddress, allowInternalNames }) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UnsafeUrlError('Malformed URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Blocked URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Credentials in URL are not allowed');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (BLOCKED_PORTS.has(port)) throw new UnsafeUrlError(`Blocked port: ${port}`);

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Literal IP: check directly. Hostname: check every resolved record.
  if (net.isIP(host)) {
    if (rejectAddress(host)) throw new UnsafeUrlError('URL resolves to a non-public address');
    return url;
  }

  if (!allowInternalNames
    && (/^localhost$/i.test(host) || /\.(localhost|local|internal|home|lan)$/i.test(host))) {
    throw new UnsafeUrlError('URL resolves to a non-public address');
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('Could not resolve host');
  }
  if (!records.length) throw new UnsafeUrlError('Could not resolve host');
  for (const rec of records) {
    if (rejectAddress(rec.address)) throw new UnsafeUrlError('URL resolves to a non-public address');
  }
  return url;
}

/**
 * Parse + validate a URL, resolving DNS and rejecting anything internal.
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(rawUrl) {
  return validateTarget(rawUrl, { rejectAddress: isBlockedIp, allowInternalNames: false });
}

/**
 * Policy for an endpoint an operator configured on purpose: an AI base URL, a
 * self-hosted gateway. The tiers, widest first:
 *
 *   allowPrivate   anything but the metadata floor (the whole LAN is reachable)
 *   allowLoopback  loopback too, since "run Ollama on this box" is the single
 *                  most common request - but no further into the network
 *   neither        public addresses only, i.e. assertPublicUrl
 *
 * Default is loopback-only-widened: `http://127.0.0.1:11434/v1` works out of
 * the box, while `http://192.168.0.7:11434/v1` needs AI_ALLOW_PRIVATE_BASE_URL.
 * That split is not paranoia: the setting is admin-only today, but any way to
 * point the server at an arbitrary host is also a way to knock on doors inside
 * the network, and a response body gets pasted into a model prompt.
 *
 * Redirects stay the caller's problem, and both callers refuse them.
 *
 * @param {string} rawUrl
 * @param {{allowPrivate?: boolean, allowLoopback?: boolean}} [opts]
 * @returns {Promise<URL>}
 */
export async function assertConfiguredEndpoint(rawUrl, { allowPrivate = false, allowLoopback = true } = {}) {
  if (allowPrivate) {
    return validateTarget(rawUrl, { rejectAddress: isMetadataIp, allowInternalNames: true });
  }
  if (!allowLoopback) return assertPublicUrl(rawUrl);
  return validateTarget(rawUrl, {
    allowInternalNames: true,
    rejectAddress: (ip) => !isLoopbackIp(ip) && (isBlockedIp(ip) || isMetadataIp(ip)),
  });
}

/**
 * Lightweight liveness probe for the download-link health checker.
 *
 * Same SSRF guarantees as safeFetchBuffer (validated scheme/host/redirects),
 * but never downloads the body: HEAD first, falling back to a 1-byte ranged
 * GET for hosts that reject HEAD (some CDNs and share hosts do).
 *
 * Never throws - a probe that cannot reach anything is itself a finding:
 *
 * @param {string} rawUrl
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string|null, error: string|null, durationMs: number }>}
 */
export async function safeProbeUrl(rawUrl, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const fail = (error, status = 0, finalUrl = null) =>
    ({ ok: false, status, finalUrl, error: String(error), durationMs: Date.now() - started });

  let target;
  try {
    target = await assertPublicUrl(rawUrl);
  } catch (e) {
    return fail(e.message);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let method = 'HEAD';
    let response;
    let hops = 0;

    for (;;) {
      response = await fetch(target, {
        method,
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          // Some hosts 403 the default node fetch UA; look like a browser-ish bot.
          'user-agent': 'Mozilla/5.0 (compatible; espress0-repo-linkcheck/1.0)',
          ...(method === 'GET' ? { range: 'bytes=0-0' } : {}),
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        hops++;
        if (hops > MAX_REDIRECTS) return fail('Too many redirects', response.status, target.toString());
        const location = response.headers.get('location');
        if (!location) return fail('Redirect without Location', response.status, target.toString());
        // Drain before reusing the socket for the next hop.
        await response.arrayBuffer().catch(() => {});
        target = await assertPublicUrl(new URL(location, target).toString());
        continue;
      }

      // HEAD not supported? Retry the whole hop chain with a ranged GET.
      if (method === 'HEAD' && [405, 501].includes(response.status)) {
        await response.arrayBuffer().catch(() => {});
        method = 'GET';
        hops = 0;
        continue;
      }

      break;
    }

    try { response.body?.cancel(); } catch { /* already consumed */ }

    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      finalUrl: target.toString(),
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    let msg;
    if (e?.name === 'AbortError') {
      msg = `Timed out after ${timeoutMs}ms`;
    } else {
      // undici hides the useful bit (ENOTFOUND / ECONNREFUSED / TLS) in `cause`.
      const cause = e?.cause?.code || e?.cause?.message;
      msg = cause ? `${e.message} (${cause})` : (e?.message || 'Probe failed');
    }
    return fail(msg, e?.statusCode || 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch() that validates the target (and every redirect hop) and refuses to
 * buffer more than `maxBytes`.
 *
 * @param {string} rawUrl
 * @param {{ maxBytes?: number, timeoutMs?: number, headers?: object }} opts
 * @returns {Promise<{ buffer: Buffer, response: Response, url: string }>}
 */
export async function safeFetchBuffer(rawUrl, { maxBytes = 50 * 1024 * 1024, timeoutMs = 30000, headers = {} } = {}) {
  let target = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    for (let hop = 0; ; hop++) {
      response = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers,
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) break;

      if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError('Too many redirects');
      const location = response.headers.get('location');
      if (!location) throw new UnsafeUrlError('Redirect without Location');
      target = await assertPublicUrl(new URL(location, target).toString());
    }

    if (!response.ok) {
      const err = new Error(`Upstream responded ${response.status} ${response.statusText}`);
      err.statusCode = 502;
      throw err;
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      const err = new Error('Remote file is too large');
      err.statusCode = 413;
      throw err;
    }

    // Stream so a lying Content-Length cannot blow up memory.
    const chunks = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        const buf = Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          controller.abort();
          const err = new Error('Remote file is too large');
          err.statusCode = 413;
          throw err;
        }
        chunks.push(buf);
      }
    }

    return { buffer: Buffer.concat(chunks, total), response, url: target.toString() };
  } finally {
    clearTimeout(timer);
  }
}
