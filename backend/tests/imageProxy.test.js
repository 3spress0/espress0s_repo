import { describe, it } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { imageProxyRoutes, resolveContentType } from '../src/routes/imageProxy.js';
import { safeFetchBuffer } from '../src/lib/safeFetch.js';

/**
 * The cookieless image proxy, exercised through fastify.inject with a stubbed
 * upstream. No database, no network: the one real-network path (the SSRF
 * guard) is tested with a literal loopback URL, which assertPublicUrl rejects
 * before any DNS or socket work happens.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const SVG_CLEAN = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
const SVG_ACTIVE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function fakeResponse(contentType) {
  return { headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) } };
}

async function buildApp(fetcher) {
  const app = Fastify({ logger: false });
  await app.register(imageProxyRoutes, { fetcher });
  return app;
}

describe('GET /media/image - input validation', () => {
  it('rejects a missing URL', async () => {
    const app = await buildApp(async () => { throw new Error('must not be called'); });
    const res = await app.inject({ method: 'GET', url: '/media/image' });
    assert.equal(res.statusCode, 400);
  });

  it('rejects non-http(s) schemes before fetching anything', async () => {
    let called = 0;
    const app = await buildApp(async () => { called++; throw new Error('must not be called'); });
    for (const bad of ['ftp://x/a.png', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent(bad) });
      assert.equal(res.statusCode, 400, bad);
    }
    assert.equal(called, 0);
  });

  it('rejects absurdly long URLs', async () => {
    const app = await buildApp(async () => { throw new Error('must not be called'); });
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://x/' + 'a'.repeat(3000)) });
    assert.equal(res.statusCode, 400);
  });

  it('rejects loopback targets via the real SSRF guard (no network involved)', async () => {
    const app = await buildApp(safeFetchBuffer);
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('http://127.0.0.1:3000/admin') });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /non-public/i);
  });
});

describe('GET /media/image - successful fetches', () => {
  it('serves upstream bytes with a validated content type and lockdown headers', async () => {
    const app = await buildApp(async () => ({ buffer: PNG, response: fakeResponse('image/png') }));
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://cdn.example.com/a.png') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.deepEqual(res.rawPayload, PNG);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /sandbox/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(res.headers.etag, 'an ETag is computed from the body');
    assert.match(res.headers['cache-control'], /max-age=\d+/);
  });

  it('never forwards upstream cookies - the browser never sees the third party', async () => {
    const upstreamSetCookie = 'tracking=abc; Domain=.jsdelivr.net';
    const fetcher = async () => ({
      buffer: PNG,
      response: {
        headers: {
          get: (name) => ({
            'content-type': 'image/png',
            'set-cookie': upstreamSetCookie,
          })[String(name).toLowerCase()] ?? null,
        },
      },
    });
    const app = await buildApp(fetcher);
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://cdn.jsdelivr.net/icon.png') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['set-cookie'], undefined, 'upstream Set-Cookie must not be echoed');
    assert.ok(!JSON.stringify(res.headers).includes(upstreamSetCookie));
  });

  it('sniffs the real type when the CDN declares octet-stream', async () => {
    const app = await buildApp(async () => ({ buffer: PNG, response: fakeResponse('application/octet-stream') }));
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://cdn.example.com/a') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
  });

  it('serves clean SVG with the sandbox headers', async () => {
    const app = await buildApp(async () => ({ buffer: SVG_CLEAN, response: fakeResponse('image/svg+xml') }));
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://cdn.example.com/a.svg') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    assert.match(res.headers['content-security-policy'], /sandbox/);
  });

  it('caches by URL: one upstream fetch serves many clients and honors If-None-Match', async () => {
    let calls = 0;
    const app = await buildApp(async () => { calls++; return { buffer: PNG, response: fakeResponse('image/png') }; });
    const url = '/media/image?u=' + encodeURIComponent('https://cdn.example.com/cached.png');
    const first = await app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({ method: 'GET', url });
    assert.equal(second.statusCode, 200);
    assert.equal(calls, 1, 'second hit served from the memory cache');

    const third = await app.inject({ method: 'GET', url, headers: { 'if-none-match': first.headers.etag } });
    assert.equal(third.statusCode, 304);
    assert.equal(third.rawPayload.length, 0);
    assert.equal(calls, 1, '304 came from cache too');
  });
});

describe('GET /media/image - refusal cases', () => {
  it('refuses HTML payloads even when the URL ends in an image name', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><body>not an image</body></html>');
    const app = await buildApp(async () => ({ buffer: html, response: fakeResponse('text/html') }));
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://evil.example.com/cover.png') });
    assert.equal(res.statusCode, 415);
  });

  it('refuses SVG with active markup (script, onload, external use)', async () => {
    const app = await buildApp(async () => ({ buffer: SVG_ACTIVE, response: fakeResponse('image/svg+xml') }));
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://evil.example.com/x.svg') });
    assert.equal(res.statusCode, 415);
  });

  it('maps a size-cap breach to 413 and a timeout to 504', async () => {
    const tooBig = Object.assign(new Error('Remote file is too large'), { statusCode: 413 });
    const timeout = Object.assign(new Error('The operation timed out'), {});
    const app413 = await buildApp(async () => { throw tooBig; });
    const app504 = await buildApp(async () => { throw timeout; });
    const u = encodeURIComponent('https://cdn.example.com/huge.png');
    assert.equal((await app413.inject({ method: 'GET', url: '/media/image?u=' + u })).statusCode, 413);
    assert.equal((await app504.inject({ method: 'GET', url: '/media/image?u=' + u + '&s=1' })).statusCode, 504);
  });

  it('maps an upstream failure to 502 without leaking internals', async () => {
    const app = await buildApp(async () => { throw new Error('socket hangup ECONNRESET'); });
    const res = await app.inject({ method: 'GET', url: '/media/image?u=' + encodeURIComponent('https://cdn.example.com/x.png') });
    assert.equal(res.statusCode, 502);
    assert.ok(!JSON.stringify(res.json()).includes('ECONNRESET'), 'socket details stay in the log');
  });
});

describe('resolveContentType (pure)', () => {
  it('accepts declared image types', () => {
    assert.equal(resolveContentType('image/webp', PNG), 'image/webp');
    assert.equal(resolveContentType('image/jpeg; charset=binary', PNG), 'image/jpeg');
  });
  it('falls back to magic bytes only for sloppy declarations', () => {
    assert.equal(resolveContentType('application/octet-stream', PNG), 'image/png');
    assert.equal(resolveContentType('', PNG), 'image/png');
  });
  it('rejects non-image declarations and active SVG', () => {
    assert.equal(resolveContentType('text/html', PNG), null);
    assert.equal(resolveContentType('image/svg+xml', SVG_ACTIVE), null);
    assert.equal(resolveContentType('image/svg+xml', SVG_CLEAN), 'image/svg+xml');
  });
});
