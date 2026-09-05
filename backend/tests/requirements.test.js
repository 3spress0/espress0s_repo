import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Dependency / system-requirement metadata on entries (#7).
 *
 * Stored as a JSON array in items.requirements, validated as structured rows,
 * round-tripped through the admin API, the catalogue archive, version
 * snapshots and the public API.
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { publicApiRoutes } = await import('../src/routes/publicApi.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { requirementsSchema } = await import('../src/utils/validation.js');
const { buildCatalog, importCatalogArchive } = await import('../src/services/catalogService.js');
const { zip } = await import('../src/lib/zip.js');
const rateLimit = (await import('@fastify/rate-limit')).default;
const cookie = (await import('@fastify/cookie')).default;

let app, db, headers, adminId;
const REQS = [
  { type: 'os', name: 'Windows', version: '>= 10' },
  { type: 'runtime', name: '.NET Framework', version: '4.8' },
  { type: 'hardware', name: 'RAM', version: '4 GB', optional: true, note: '8 GB recommended' },
];

before(async () => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('req_admin', 'req@example.com', 'pepper_v1:x', 'admin')`).run();
  const admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'req_admin'").get();
  adminId = admin.id;
  headers = { authorization: `Bearer ${generateToken(admin)}` };
  app = Fastify();
  await app.register(cookie, { secret: 'req-test-cookie-secret-0123456789abcdef' });
  await app.register(rateLimit, { global: false });
  await app.register(async (api) => { await api.register(itemsRoutes); await api.register(publicApiRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('requirements: validation', () => {
  it('accepts an array and a JSON string, rejects bad rows', () => {
    assert.deepEqual(requirementsSchema.parse(REQS)[0], { type: 'os', name: 'Windows', version: '>= 10' });
    assert.equal(requirementsSchema.parse(JSON.stringify(REQS)).length, 3);
    assert.equal(requirementsSchema.parse(''), null);
    assert.equal(requirementsSchema.safeParse([{ type: 'nope', name: 'x' }]).success, false);
    assert.equal(requirementsSchema.safeParse([{ type: 'os' }]).success, false);
    assert.equal(requirementsSchema.safeParse('not json').success, false);
  });
});

describe('requirements: admin API', () => {
  let id;
  it('saves on create and returns them parsed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/items', headers, payload: {
      name: 'Req Tool', slug: 'req-tool', description: 'needs stuff', file_type: 'exe', storage_provider: 'external',
      download_url: 'https://example.com/a.exe', published: true, requirements: REQS,
    } });
    assert.equal(res.statusCode, 201, res.body);
    id = res.json().id ?? db.prepare("SELECT id FROM items WHERE slug = 'req-tool'").get().id;
    const raw = db.prepare('SELECT requirements FROM items WHERE id = ?').get(id).requirements;
    assert.equal(JSON.parse(raw).length, 3);
    const get = await app.inject({ method: 'GET', url: '/api/items/req-tool' });
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(get.json().requirements.length, 3);
    assert.equal(get.json().requirements[2].note, '8 GB recommended');
  });

  it('updates and clears via PUT', async () => {
    let res = await app.inject({ method: 'PUT', url: `/api/items/${id}`, headers, payload: { requirements: [{ type: 'dependency', name: 'libfoo' }] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(db.prepare('SELECT requirements FROM items WHERE id = ?').get(id).requirements), [{ type: 'dependency', name: 'libfoo' }]);
    res = await app.inject({ method: 'PUT', url: `/api/items/${id}`, headers, payload: { requirements: [] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(db.prepare('SELECT requirements FROM items WHERE id = ?').get(id).requirements, null);
    const get = await app.inject({ method: 'GET', url: '/api/items/req-tool' });
    assert.deepEqual(get.json().requirements, []);
  });

  it('rejects malformed rows with 400', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/items/${id}`, headers, payload: { requirements: [{ type: 'os' }] } });
    assert.equal(res.statusCode, 400);
  });

  it('exposes them on the public API', async () => {
    await app.inject({ method: 'PUT', url: `/api/items/${id}`, headers, payload: { requirements: REQS } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/items/req-tool' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().item.requirements.length, 3);
  });
});

describe('requirements: catalogue round trip', () => {
  it('exports and imports the field', async () => {
    const json = JSON.parse(JSON.stringify(buildCatalog().catalog));
    const entry = json.items.find((i) => i.slug === 'req-tool');
    assert.ok(entry, 'exported entry present');
    assert.equal(entry.requirements.length, 3);

    entry.requirements = [{ type: 'runtime', name: 'Java', version: '17' }];
    const buffer = zip([{ name: 'catalog.json', data: JSON.stringify(json) }]);
    const { report } = await importCatalogArchive({ buffer, filename: 'catalog.zip', mode: 'upsert', apply: true, userId: adminId });
    assert.equal(report.errorCount, 0, JSON.stringify(report.errors));
    assert.ok(report.items.updated >= 1);
    const raw = db.prepare("SELECT requirements FROM items WHERE slug = 'req-tool'").get().requirements;
    assert.deepEqual(JSON.parse(raw), [{ type: 'runtime', name: 'Java', version: '17' }]);
  });
});
