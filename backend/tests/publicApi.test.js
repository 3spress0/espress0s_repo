import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Public read-only API (/api/v1).
 *
 * What matters: drafts never leak (not even with an admin token), no download
 * URLs or encrypted fields appear, the shape is stable, and the rate-limit
 * bucket is its own (keyed public:<ip>, separate from the SPA's).
 */
const { getDb } = await import('../src/db/index.js');
const { publicApiRoutes } = await import('../src/routes/publicApi.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { encryptionService } = await import('../src/services/encryptionService.js');
const { emitEvent } = await import('../src/services/eventBus.js');
const rateLimit = (await import('@fastify/rate-limit')).default;
const cookie = (await import('@fastify/cookie')).default;
const { urlsIn, hostsIn } = await import('./helpers/responseUrls.mjs');

let app, db, admin;
const seenKeys = [];

before(async () => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('pub_admin', 'pub@example.com', 'pepper_v1:x', 'admin')`).run();
  admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'pub_admin'").get();
  const cat = db.prepare("INSERT OR IGNORE INTO categories (name, slug) VALUES ('Pub Cat', 'pub-cat')").run();
  const catId = db.prepare("SELECT id FROM categories WHERE slug = 'pub-cat'").get().id;
  void cat;
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, file_size, category_id, tags, download_url, version)
              VALUES ('Public Thing', 'pub-thing', 'A public thing', 1, 'iso', 2048, ?, '["alpha","beta"]', ?, '1.0')`).run(catId, encryptionService.encrypt('https://secret.example.com/file.iso'));
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type) VALUES ('Draft Thing', 'pub-draft', 'hidden', 0, 'iso')`).run();
  const pubId = db.prepare("SELECT id FROM items WHERE slug = 'pub-thing'").get().id;
  db.prepare(`INSERT INTO item_download_links (item_id, label, storage_provider, download_url, is_primary, status) VALUES (?, 'Mirror A', 'external', ?, 1, 'up')`).run(pubId, encryptionService.encrypt('https://secret.example.com/mirror.iso'));

  app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => { const k = `spa:${req.ip}`; seenKeys.push(k); return k; },
  });
  // Route-level config.rateLimit.keyGenerator overrides the global one; we
  // capture what the plugin actually used through the header path below.
  await app.register(async (api) => { await api.register(publicApiRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('public api: shape and safety', () => {
  it('root describes itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().version, 1);
    assert.equal(res.headers['x-api-version'], '1');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  it('lists published items only, without URLs or encrypted fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/items?limit=50' });
    assert.equal(res.statusCode, 200, res.body);
    const { items, pagination } = res.json();
    assert.ok(items.some(i => i.slug === 'pub-thing'));
    assert.ok(!items.some(i => i.slug === 'pub-draft'), 'draft leaked');
    const it = items.find(i => i.slug === 'pub-thing');
    assert.equal(it.download_url, undefined);
    assert.equal(it.storage_path, undefined);
    assert.equal(it.encryption_version, undefined);
    assert.deepEqual(it.tags, ['alpha', 'beta']);
    assert.equal(it.category.slug, 'pub-cat');
    assert.equal(it.download_url_api, `/api/download/${it.id}`);
    assert.equal(it.mirrors.length, 1);
    assert.equal(it.mirrors[0].label, 'Mirror A');
    assert.equal(it.mirrors[0].download_url, undefined);
    assert.equal(it.mirrors[0].download_url_api, `/api/download/${it.id}/${it.mirrors[0].id}`);
    assert.ok(!hostsIn(JSON.stringify(res.json())).has('secret.example.com'), 'a secret URL leaked somewhere');
    assert.equal(typeof pagination.total_pages, 'number');
  });

  it('does not show drafts even to an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/items/pub-draft', headers: { authorization: `Bearer ${generateToken(admin)}` } });
    assert.equal(res.statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/api/v1/items?limit=100', headers: { authorization: `Bearer ${generateToken(admin)}` } });
    assert.ok(!list.json().items.some(i => i.slug === 'pub-draft'));
  });

  it('fetches one item by slug or id with an ETag', async () => {
    const bySlug = await app.inject({ method: 'GET', url: '/api/v1/items/pub-thing' });
    assert.equal(bySlug.statusCode, 200);
    const item = bySlug.json().item;
    assert.equal(item.name, 'Public Thing');
    assert.ok(Array.isArray(item.related));
    const etag = bySlug.headers.etag;
    assert.ok(etag);
    const byId = await app.inject({ method: 'GET', url: `/api/v1/items/${item.id}` });
    assert.equal(byId.json().item.slug, 'pub-thing');
    const cached = await app.inject({ method: 'GET', url: '/api/v1/items/pub-thing', headers: { 'if-none-match': etag } });
    assert.equal(cached.statusCode, 304);
  });

  it('filters by category, tag and search', async () => {
    const cat = await app.inject({ method: 'GET', url: '/api/v1/items?category=pub-cat' });
    assert.ok(cat.json().items.every(i => i.category?.slug === 'pub-cat'));
    const q = await app.inject({ method: 'GET', url: '/api/v1/items?q=public+thing' });
    assert.ok(q.json().items.some(i => i.slug === 'pub-thing'));
    const search = await app.inject({ method: 'GET', url: '/api/v1/search?q=thing' });
    assert.equal(search.statusCode, 307);
    assert.match(search.headers.location, /^\/api\/v1\/items\?/);
    const noQ = await app.inject({ method: 'GET', url: '/api/v1/search' });
    assert.equal(noQ.statusCode, 400);
  });

  it('rejects an out-of-range limit at validation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/items?limit=5000' });
    assert.equal(res.statusCode, 400);
  });

  it('categories, folders, tags, stats', async () => {
    const cats = await app.inject({ method: 'GET', url: '/api/v1/categories' });
    assert.ok(cats.json().categories.find(c => c.slug === 'pub-cat').item_count >= 1);
    const tags = await app.inject({ method: 'GET', url: '/api/v1/tags' });
    assert.equal(tags.statusCode, 200);
    assert.ok(Array.isArray(tags.json().tags));
    const folders = await app.inject({ method: 'GET', url: '/api/v1/folders' });
    assert.ok(Array.isArray(folders.json().folders));
    const stats = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    assert.ok(stats.json().items >= 1);
    assert.equal(stats.json().downloads !== undefined, true);
  });

  it('changes feed hides events about drafts', async () => {
    emitEvent('item.updated', { item: { id: 1, slug: 'pub-thing', name: 'x', published: true }, changes: ['version'] });
    emitEvent('item.updated', { item: { id: 2, slug: 'pub-draft', name: 'y', published: false }, changes: ['name'] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/changes?limit=10' });
    assert.equal(res.statusCode, 200);
    const slugs = res.json().changes.map(c => c.item?.slug);
    assert.ok(slugs.includes('pub-thing'));
    assert.ok(!slugs.includes('pub-draft'));
    assert.match(res.headers['cache-control'], /max-age=15/);
  });
});

describe('public api: rate limiting is its own bucket', () => {
  it('uses a public:<ip> key, never the SPA/session key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats', headers: { authorization: `Bearer ${generateToken(admin)}` } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['x-ratelimit-limit'], 'rate limit headers present');
    assert.equal(Number(res.headers['x-ratelimit-limit']), Number(process.env.PUBLIC_API_RATE_LIMIT || 60));
    // The global keyGenerator (SPA bucket) was not consulted for /v1 routes.
    assert.ok(!seenKeys.length, `SPA key generator was used: ${seenKeys.join(',')}`);
  });

  it('answers 429 once the public budget is spent', async () => {
    const limit = Number(process.env.PUBLIC_API_RATE_LIMIT || 60);
    let last;
    for (let i = 0; i < limit + 5; i++) {
      last = await app.inject({ method: 'GET', url: '/api/v1/stats', remoteAddress: '203.0.113.77' });
      if (last.statusCode === 429) break;
    }
    assert.equal(last.statusCode, 429);
  });
});

describe('public api: rss / atom feeds', () => {
  it('serves RSS of published entries only, escaped', async () => {
    db.prepare("UPDATE items SET name = 'Public <Thing> & Co' WHERE slug = 'pub-thing'").run();
    const res = await app.inject({ method: 'GET', url: '/api/v1/feed.rss', headers: { host: 'repo.example.com' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.headers['content-type'], /application\/rss\+xml/);
    assert.match(res.body, /<rss version="2.0"/);
    assert.match(res.body, /Public &lt;Thing&gt; &amp; Co/);
    assert.ok(
      urlsIn(res.body).some(u => u.host === 'repo.example.com' && u.pathname === '/file/pub-thing'),
      'feed links to the public page on the request host',
    );
    assert.doesNotMatch(res.body, /pub-draft/);
    assert.ok(!hostsIn(res.body).has('secret.example.com'), 'a secret URL leaked into the feed');
    db.prepare("UPDATE items SET name = 'Public Thing' WHERE slug = 'pub-thing'").run();
  });

  it('serves Atom, honours the tag filter, and has a changes variant', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/v1/feed.atom?tag=alpha' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/atom\+xml/);
    assert.match(res.body, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
    assert.match(res.body, /pub-thing/);
    res = await app.inject({ method: 'GET', url: '/api/v1/feed.atom?tag=nomatch' });
    assert.doesNotMatch(res.body, /<entry>/);
    res = await app.inject({ method: 'GET', url: '/api/v1/feed/changes.rss' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /changes<\/title>/);
    assert.match(res.body, /<item>/);
  });
});
