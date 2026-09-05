import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/** Admin analytics (#20): aggregate shape, time-series fill, auth. */
const { getDb } = await import('../src/db/index.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { getAnalytics } = await import('../src/services/analyticsService.js');
const cookie = (await import('@fastify/cookie')).default;

let app, db, admin, editor;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });

before(async () => {
  db = getDb();
  for (const [name, role] of [['an_admin', 'admin'], ['an_editor', 'editor']]) {
    db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, 'pepper_v1:x', ?)`).run(name, `${name}@example.com`, role);
  }
  admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'an_admin'").get();
  editor = db.prepare("SELECT id, username, role FROM users WHERE username = 'an_editor'").get();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, download_count) VALUES ('Analytics Hit', 'an-hit', 'x', 1, 'zip', 42)`).run();
  const item = db.prepare("SELECT id FROM items WHERE slug = 'an-hit'").get();
  db.prepare(`INSERT INTO events (type, item_id, payload) VALUES ('item.created', ?, '{}')`).run(item.id);
  db.prepare(`INSERT OR IGNORE INTO reviews (item_id, user_id, rating, status) VALUES (?, ?, 4, 'visible')`).run(item.id, editor.id);
  app = Fastify();
  await app.register(cookie, { secret: 'analytics-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => { await api.register(adminRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('analytics: service', () => {
  it('returns zero-filled day buckets over the requested window', () => {
    const a = getAnalytics({ days: 7 });
    assert.equal(a.range.days, 7);
    assert.equal(a.catalog.itemsPerDay.length, 7);
    assert.equal(a.activity['item.created'].length, 7);
    assert.ok(a.activity['item.created'].some((d) => d.value >= 1), 'today has the seeded event');
    assert.ok(a.catalog.itemsPerDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  });

  it('aggregates downloads, reviews and users from existing tables', () => {
    const a = getAnalytics({ days: 30 });
    assert.ok(a.downloads.total >= 42);
    assert.ok(a.downloads.top.some((t) => t.slug === 'an-hit'));
    assert.ok(a.reviews.total >= 1);
    assert.ok(a.reviews.topRated.some((t) => t.slug === 'an-hit'));
    assert.ok(a.users.total >= 2);
    assert.ok('admin' in a.users.byRole);
    assert.ok(typeof a.links.total === 'number');
    assert.ok(typeof a.requests.totalRequests === 'number');
  });

  it('clamps the window', () => {
    assert.equal(getAnalytics({ days: 99999 }).range.days, 365);
    assert.equal(getAnalytics({ days: -3 }).range.days, 1);
    assert.equal(getAnalytics({ days: 'abc' }).range.days, 30);
  });
});

describe('analytics: route', () => {
  it('is admin-only', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/analytics' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/analytics', headers: auth(editor) })).statusCode, 403);
    const res = await app.inject({ method: 'GET', url: '/api/admin/analytics?days=14', headers: auth(admin) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().range.days, 14);
    assert.equal(res.json().reviews.perDay.length, 14);
  });
});
