import crypto from 'crypto';
import { safeFetchBuffer, UnsafeUrlError } from '../lib/safeFetch.js';
import { detectImageType, svgRejectionReason } from '../lib/imageSafety.js';

/**
 * Cookieless, same-origin proxy for third-party-hosted cover art and avatars.
 *
 * Item `image_url` / `icon_url` values legitimately point at arbitrary hosts
 * (cdns, wikis, vendor sites) and the SPA used to load them straight from the
 * visitor's browser. Those third parties ride along on the request with their
 * own cookies - tracker blockers (Privacy Badger caught cdn.jsdelivr.net and
 * upload.wikimedia.org setting them) and the visitor's IP end up shared with
 * every host that ever appeared in the catalogue.
 *
 * With this route the browser only ever talks to us: the fetch happens
 * server-side via safeFetchBuffer, which carries no cookies and no browser
 * fingerprint, validates every redirect hop against the SSRF blocklists, and
 * caps the body size. Upstream response headers - Set-Cookie included - are
 * never echoed: the reply is built from scratch with only the bytes and a
 * validated image Content-Type.
 *
 * Response caching: a day at the browser, plus a small in-memory LRU so a
 * busy catalog page does not refetch the same cover per visitor.
 *
 * Deliberate trade-off: this is an open (but image-only, size-capped,
 * rate-limited) fetcher of public URLs - the same URLs any visitor could
 * already see in page source. What it cannot do: reach non-public addresses
 * (SSRF guard), serve non-image content, hand upstream cookies to anyone, or
 * execute active SVG markup.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per image
const FETCH_TIMEOUT_MS = 8000;
const MAX_URL_LENGTH = 2048;
const BROWSER_TTL_SECONDS = 86400; // 24h
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024; // total budget, not per entry

// Types we serve when the upstream declares them. Anything else must pass
// signature sniffing (some CDNs answer application/octet-stream for images).
const DECLARED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/bmp',
]);
const SNIFFABLE_TYPES = new Set([
  'application/octet-stream', 'binary/octet-stream', 'text/plain', '',
]);

/** In-memory LRU with a byte budget. */
const cache = new Map(); // url -> { buffer, contentType, etag, expiresAt, size }
let cacheBytes = 0;
const inflight = new Map(); // url -> Promise (protects slow upstreams from stampedes)

function cacheGet(url) {
  const entry = cache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(url);
    cacheBytes -= entry.size;
    return null;
  }
  // LRU touch
  cache.delete(url);
  cache.set(url, entry);
  return entry;
}

function cacheSet(url, entry) {
  if (entry.size > CACHE_MAX_BYTES) return; // a single image may not evict everything
  while (cacheBytes + entry.size > CACHE_MAX_BYTES && cache.size) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).size;
    cache.delete(oldest);
  }
  cache.set(url, entry);
  cacheBytes += entry.size;
}

/** Headers for bytes we fetched from a third party and echo back. Never trusted. */
function applyProxySecurityHeaders(reply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
}

function sendImage(reply, entry, ifNoneMatch) {
  applyProxySecurityHeaders(reply);
  reply.header('Cache-Control', `public, max-age=${BROWSER_TTL_SECONDS}`);
  reply.header('ETag', entry.etag);
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return reply.code(304).send();
  }
  reply.header('Content-Type', entry.contentType);
  return reply.send(entry.buffer);
}

function normalizeDeclaredType(headerValue) {
  return String(headerValue || '').split(';')[0].trim().toLowerCase();
}

/**
 * Decide the Content-Type we serve, or null to refuse. Declared image types
 * pass; sloppy CDNs (octet-stream etc.) pass only if the first bytes are a
 * known image signature. Active SVG is refused outright, wherever it came
 * from - the same rule uploads.js applies to stored files.
 */
export function resolveContentType(declared, buffer) {
  let type = normalizeDeclaredType(declared);
  if (!DECLARED_TYPES.has(type)) {
    if (!SNIFFABLE_TYPES.has(type)) return null;
    type = detectImageType(buffer)?.mime || null;
    if (!type) return null;
  }
  if (type === 'image/svg+xml') {
    const reason = svgRejectionReason(buffer);
    if (reason) return null;
  }
  return type;
}

async function fetchImageEntry(rawUrl, fetcher) {
  const { buffer, response } = await fetcher(rawUrl, {
    maxBytes: MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: {
      // No browser fingerprint to forward: a neutral UA and image accept only.
      'user-agent': 'Mozilla/5.0 (compatible; espress0-repo-imageproxy/1.0)',
      accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      'accept-encoding': 'identity',
    },
  });
  const contentType = resolveContentType(response?.headers?.get?.('content-type'), buffer);
  if (!contentType) {
    const err = new Error('Upstream did not return an image');
    err.statusCode = 415;
    throw err;
  }
  return {
    buffer,
    contentType,
    etag: `"${crypto.createHash('sha256').update(buffer).digest('hex')}"`,
    expiresAt: Date.now() + CACHE_TTL_MS,
    size: buffer.length,
  };
}

/**
 * Routes.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ fetcher?: Function }} [deps] Test seam: replace the upstream fetch
 *   (must return `{ buffer, response }` like safeFetchBuffer).
 */
export async function imageProxyRoutes(fastify, deps = {}) {
  const fetcher = deps.fetcher || safeFetchBuffer;

  fastify.get('/media/image', {
    config: {
      rateLimit: {
        // Images are page furniture: a catalogue view renders dozens at once,
        // far above the anonymous 100-per-15-minutes site bucket. Their own
        // bucket, still per-IP, still finite.
        max: 240,
        timeWindow: '1 minute',
        keyGenerator: (request) => `img-proxy:${request.ip}`,
      },
    },
  }, async (request, reply) => {
    const raw = request.query?.u;
    if (!raw || typeof raw !== 'string') {
      return reply.code(400).send({ error: 'Missing image URL parameter' });
    }
    if (raw.length > MAX_URL_LENGTH) {
      return reply.code(400).send({ error: 'Image URL too long' });
    }
    if (!/^https?:\/\//i.test(raw)) {
      return reply.code(400).send({ error: 'Only http(s) image URLs can be proxied' });
    }

    const cached = cacheGet(raw);
    if (cached) return sendImage(reply, cached, request.headers['if-none-match']);

    let entryPromise = inflight.get(raw);
    if (!entryPromise) {
      entryPromise = (async () => {
        const entry = await fetchImageEntry(raw, fetcher);
        cacheSet(raw, entry);
        return entry;
      })().finally(() => inflight.delete(raw));
      inflight.set(raw, entryPromise);
    }

    let entry;
    try {
      entry = await entryPromise;
    } catch (err) {
      if (err instanceof UnsafeUrlError || err?.name === 'UnsafeUrlError') {
        return reply.code(400).send({ error: err.message });
      }
      const status = Number(err?.statusCode) || 0;
      if (status >= 400 && status < 600) {
        return reply.code(status).send({ error: err.message });
      }
      if (err?.name === 'AbortError' || /timed? ?out/i.test(String(err?.message))) {
        return reply.code(504).send({ error: 'Image host took too long to answer' });
      }
      request.log.warn({ err: err?.message }, 'image proxy fetch failed');
      return reply.code(502).send({ error: 'Could not fetch image from upstream' });
    }

    return sendImage(reply, entry, request.headers['if-none-match']);
  });
}
