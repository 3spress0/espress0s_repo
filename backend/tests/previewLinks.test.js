import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Draft preview links (#18): an editor mints a signed, expiring link; anyone
 * holding it can read the draft page, without URLs, without counting a view;
 * a bad/expired token or another item's token is still a 404.
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { createPreviewToken, verifyPreviewToken } = await import('../src/services/previewLinkService.js');
const { encryptionService } = await import('../src/services/encryptionService.js');
const { hostsIn } = await import('./helpers/responseUrls.mjs');
const cookie = (await import('@fastify/cookie')).default;

let app, db, editor, viewer, draft, other;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });

before(async () => {
  db = getDb();
  for (const [u, r] of [['pv_editor', 'editor'], ['pv_viewer', 'viewer']]) {
    db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, 'pepper_v1:x', ?)`).run(u, `${u}@example.com`, r);
  }
  editor = db.prepare("SELECT id, username, role FROM users WHERE username = 'pv_editor'").get();
  viewer = db.prepare("SELECT id, username, role FROM users WHERE username = 'pv_viewer'").get();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, download_url, view_count) VALUES ('Preview Draft', 'pv-draft', 'secret draft', 0, 'zip', ?, 0)`).run(encryptionService.encrypt('https://secret.example.com/d.zip'));
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type) VALUES ('Preview Other', 'pv-other', 'other draft', 0, 'zip')`).run();
  draft = db.prepare("SELECT * FROM items WHERE slug = 'pv-draft'").get();
  other = db.prepare("SELECT * FROM items WHERE slug = 'pv-other'").get();
  db.prepare("INSERT INTO item_download_links (item_id, label, storage_provider, download_url, is_primary, status) VALUES (?, 'Mirror', 'external', ?, 1, 'up')").run(draft.id, encryptionService.encrypt('https://secret.example.com/m.zip'));
  app = Fastify();
  await app.register(cookie, { secret: 'preview-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => { await api.register(itemsRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('preview links: tokens', () => {
  it('verify accepts its own token, rejects tampering, expiry and other items', () => {
    const { token } = createPreviewToken(draft.id);
    assert.equal(verifyPreviewToken(draft.id, token), true);
    assert.equal(verifyPreviewToken(other.id, token), false);
    assert.equal(verifyPreviewToken(draft.id, token + 'x'), false);
    const [exp, sig] = token.split('.');
    assert.equal(verifyPreviewToken(draft.id, `${Number(exp) + 1}.${sig}`), false);
    const expired = `${Math.floor(Date.now() / 1000) - 10}.${sig}`;
    assert.equal(verifyPreviewToken(draft.id, expired), false);
    assert.equal(verifyPreviewToken(draft.id, ''), false);
  });

  it('clamps ttl to 1..720 hours', () => {
    const a = new Date(createPreviewToken(draft.id, { ttlHours: 99999 }).expires_at) - Date.now();
    assert.ok(a <= 720 * 3600e3 + 5000);
    const b = new Date(createPreviewToken(draft.id, { ttlHours: 0 }).expires_at) - Date.now();
    assert.ok(b >= 3600e3 - 5000 && b <= 24 * 7 * 3600e3 + 5000);
  });
});

describe('preview links: routes', () => {
  let path;
  it('editor mints a link; viewer cannot', async () => {
    let res = await app.inject({ method: 'POST', url: `/api/items/${draft.id}/preview-link`, headers: auth(viewer), payload: {} });
    assert.equal(res.statusCode, 403);
    res = await app.inject({ method: 'POST', url: `/api/items/${draft.id}/preview-link`, headers: auth(editor), payload: { ttl_hours: 2 } });
    assert.equal(res.statusCode, 200, res.body);
    path = res.json().path;
    assert.match(path, /^\/file\/pv-draft\?preview=\d+\.[A-Za-z0-9_-]+$/);
    assert.equal(res.json().published, false);
  });

  it('anonymous: 404 without token, page (minus URLs) with token, no view counted', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/items/pv-draft' });
    assert.equal(res.statusCode, 404);
    const token = new URL('http://x' + path).searchParams.get('preview');
    res = await app.inject({ method: 'GET', url: `/api/items/pv-draft?preview=${token}` });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    assert.equal(j.preview, true);
    assert.equal(j.name, 'Preview Draft');
    assert.equal(j.download_url, null);
    assert.ok(j.download_links.every(l => l.download_url === null && l.storage_path === null));
    assert.ok(!hostsIn(res.body).has('secret.example.com'), 'a secret URL leaked into the preview');
    assert.equal(db.prepare('SELECT view_count FROM items WHERE id = ?').get(draft.id).view_count, 0);
    // The token is bound to the item: not valid for another draft.
    res = await app.inject({ method: 'GET', url: `/api/items/pv-other?preview=${token}` });
    assert.equal(res.statusCode, 404);
    // Downloads still need a session.
    res = await app.inject({ method: 'GET', url: `/api/download/${draft.id}?preview=${token}` });
    assert.equal(res.statusCode, 401);
  });
});
