import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * The OpenAPI document is generated from the live route table, so the test
 * boots a real (small) app and checks that the document reflects it:
 * every registered /api route appears, auth gates are visible, tags come from
 * the URL prefix, and the viewer is served without inline script (CSP).
 */
const { openapiPlugin } = await import('../src/docs/openapi.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { authRoutes } = await import('../src/routes/auth.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let doc;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(openapiPlugin);
  await app.register(async (api) => {
    await api.register(itemsRoutes);
    await api.register(adminRoutes);
    await api.register(authRoutes);
  }, { prefix: '/api' });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/docs/json' });
  assert.strictEqual(res.statusCode, 200);
  doc = res.json();
});

after(async () => { await app?.close(); });

describe('openapi document', () => {
  it('is an OpenAPI 3 document with security schemes', () => {
    assert.match(doc.openapi, /^3\./);
    assert.ok(doc.components.securitySchemes.bearerAuth);
    assert.ok(doc.components.securitySchemes.cookieAuth);
  });

  it('lists public and admin routes with tags from the URL prefix', () => {
    assert.ok(doc.paths['/api/items'], 'public items route missing');
    assert.deepStrictEqual(doc.paths['/api/items'].get.tags, ['Items']);
    assert.ok(doc.paths['/api/admin/users'], 'admin users route missing');
    assert.deepStrictEqual(doc.paths['/api/admin/users'].get.tags, ['Admin']);
    assert.deepStrictEqual(doc.paths['/api/auth/login'].post.tags, ['Auth']);
  });

  it('marks admin routes as requiring auth and names the role', () => {
    const op = doc.paths['/api/admin/users'].get;
    assert.ok(Array.isArray(op.security) && op.security.length > 0);
    assert.match(op.description, /admin/);
  });

  it('leaves public routes without a security requirement', () => {
    assert.strictEqual(doc.paths['/api/items'].get.security, undefined);
  });

  it('converts :param segments into path parameters', () => {
    const p = doc.paths['/api/items/{slug}'];
    assert.ok(p, 'expected /api/items/{slug}');
    assert.ok(p.get.parameters.some(x => x.in === 'path' && x.name === 'slug'));
  });

  it('serves YAML too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs/yaml' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /yaml/);
    assert.match(res.body, /^openapi: 3/m);
  });

  it('serves a viewer page with no inline script (CSP-compatible)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/docs' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(res.body), 'inline script found');
    const js = await app.inject({ method: 'GET', url: '/api/docs/viewer.js' });
    assert.strictEqual(js.statusCode, 200);
    // The helper script itself is not part of the API surface.
    assert.strictEqual(doc.paths['/api/docs/viewer.js'], undefined);
  });
});
