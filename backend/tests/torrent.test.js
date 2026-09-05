import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Torrent / magnet mirrors (#22): validation, schema, storage provider,
 * download resolution, link-checker skip, and the CHECK-constraint rebuild.
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { downloadLinkSchema, isMagnetUri, normalizeLinkProvider } = await import('../src/utils/validation.js');
const { storageManager } = await import('../src/services/storage/index.js');
const { linkHealthService } = await import('../src/services/linkHealthService.js');
const cookie = (await import('@fastify/cookie')).default;
const rateLimit = (await import('@fastify/rate-limit')).default;

const MAGNET = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=ubuntu-24.04-desktop-amd64.iso&tr=https%3A%2F%2Ftorrent.ubuntu.com%2Fannounce';
let app, db, admin, item;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });

before(async () => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('tor_admin', 'tor_admin@example.com', 'pepper_v1:x', 'admin')`).run();
  admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'tor_admin'").get();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type) VALUES ('Torrented ISO', 'tor-iso', 'x', 1, 'iso')`).run();
  item = db.prepare("SELECT * FROM items WHERE slug = 'tor-iso'").get();
  db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(item.id);
  app = Fastify();
  await app.register(cookie, { secret: 'torrent-test-cookie-secret-0123456789abcdef' });
  await app.register(rateLimit, { global: false });
  await app.register(async (api) => { await api.register(itemsRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('torrent: validation', () => {
  it('recognises magnet URIs with a BitTorrent info-hash only', () => {
    assert.ok(isMagnetUri(MAGNET));
    assert.ok(isMagnetUri('magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A'));
    assert.ok(isMagnetUri('magnet:?dn=x&xt=urn:btmh:1220caf1e1c30e81cb361b9ee167c4aa64228a7fa4fa9f6105232b28ad099f3a302e'));
    assert.ok(!isMagnetUri('magnet:?dn=nohash'));
    assert.ok(!isMagnetUri('magnet:?xt=urn:btih:short'));
    assert.ok(!isMagnetUri('magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn="><script>'));
    assert.ok(!isMagnetUri('javascript:alert(1)'));
  });

  it('accepts magnet download_url on mirrors and coerces the provider', () => {
    const ok = downloadLinkSchema.safeParse({ label: 'Magnet', storage_provider: 'torrent', download_url: MAGNET });
    assert.ok(ok.success, JSON.stringify(ok.error?.errors));
    const coerced = normalizeLinkProvider(downloadLinkSchema.parse({ label: 'Magnet', download_url: MAGNET }));
    assert.equal(coerced.storage_provider, 'torrent');
    const torrentFile = downloadLinkSchema.safeParse({ label: 'Torrent file', storage_provider: 'torrent', download_url: 'https://example.com/x.torrent' });
    assert.ok(torrentFile.success);
    assert.ok(!downloadLinkSchema.safeParse({ label: 'Bad', storage_provider: 'torrent', download_url: 'magnet:?dn=nohash' }).success);
  });
});

describe('torrent: storage + schema', () => {
  it('lists the provider and resolves magnets', async () => {
    assert.ok(storageManager.listProviders().some((p) => p.id === 'torrent' && p.enabled));
    assert.equal(await storageManager.getDownloadUrl('torrent', null, { download_url: MAGNET }), MAGNET);
    await assert.rejects(() => storageManager.getDownloadUrl('torrent', null, {}), /magnet/);
  });

  it('the CHECK constraint accepts torrent rows (fresh DB and rebuilt DB)', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'item_download_links'").get().sql;
    assert.match(sql, /'torrent'/);
    db.prepare(`INSERT INTO item_download_links (item_id, label, storage_provider, download_url) VALUES (?, 'raw', 'torrent', 'x')`).run(item.id);
    db.prepare(`DELETE FROM item_download_links WHERE item_id = ? AND label = 'raw'`).run(item.id);
  });
});

describe('torrent: routes', () => {
  let linkId;
  it('admin adds a magnet mirror; the public page shows the provider but no URL', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/items/${item.id}/links`, headers: auth(admin), payload: { label: 'Magnet', storage_provider: 'external', download_url: MAGNET, is_primary: true } });
    assert.equal(res.statusCode, 201, res.body);
    linkId = res.json().link?.id ?? res.json().id;
    assert.ok(linkId, res.body);
    const page = await app.inject({ method: 'GET', url: '/api/items/tor-iso' });
    const link = page.json().download_links.find((l) => l.id === linkId);
    assert.equal(link.storage_provider, 'torrent', 'magnet coerced to torrent provider');
  });

  it('download resolution hands out the magnet link (JSON) for a torrent mirror', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/download/${item.id}/${linkId}?json=1`, headers: { ...auth(admin), accept: 'application/json' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().downloadUrl, MAGNET);
    assert.equal(res.json().provider, 'torrent');
  });

  it('link checker skips magnets instead of failing them', async () => {
    const row = db.prepare('SELECT * FROM item_download_links WHERE id = ?').get(linkId);
    const out = await linkHealthService.checkLink(row, { timeoutMs: 500 });
    assert.equal(out.skipped, true);
    assert.match(out.check_error, /magnet/i);
    assert.notEqual(out.status, 'down');
  });
});
