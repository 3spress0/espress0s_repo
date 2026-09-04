import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import crypto from 'node:crypto';

/**
 * Events and webhooks.
 *
 * - writes to file pages produce events with public-safe payloads
 * - link checker transitions produce link.down / link.recovered once
 * - webhooks are queued for matching events only, signed, retried, logged
 * - personal hooks never receive draft-item events
 * - target URLs go through the SSRF policy
 * - route auth: personal vs admin
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { webhookRoutes } = await import('../src/routes/webhooks.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { emitEvent, onEvent, listEvents, EVENT_TYPES } = await import('../src/services/eventBus.js');
const { webhookService, signBody } = await import('../src/services/webhookService.js');
const { linkHealthService } = await import('../src/services/linkHealthService.js');
const cookie = (await import('@fastify/cookie')).default;

let app, db, admin, viewer;
const sent = []; // captured outgoing requests
let nextResponse = () => ({ status: 200, body: 'ok' });

function auth(u) { return { authorization: `Bearer ${generateToken(u)}` }; }
function makeUser(username, role) {
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, 'pepper_v1:dummy', ?)`).run(username, `${username}@example.com`, role);
  db.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, username);
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));

before(async () => {
  db = getDb();
  admin = makeUser('wh_admin', 'admin');
  viewer = makeUser('wh_viewer', 'viewer');
  db.prepare('DELETE FROM webhooks').run();
  db.prepare('DELETE FROM events').run();

  // Fake transport: records the request, answers what the test asked for.
  webhookService.fetchImpl = async (url, init) => {
    sent.push({ url, init });
    const r = nextResponse();
    return { status: r.status, text: async () => r.body };
  };
  webhookService.start({ info() {}, error() {} });

  app = Fastify();
  await app.register(cookie, { secret: 'webhooks-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => {
    await api.register(itemsRoutes);
    await api.register(webhookRoutes);
  }, { prefix: '/api' });
  await app.ready();
});
after(async () => { webhookService.stop(); await app?.close(); });

describe('events: item writes', () => {
  let itemId;
  it('create emits item.created (+ item.published) with a public-safe payload', async () => {
    const seen = [];
    const off = onEvent(e => seen.push(e));
    const res = await app.inject({ method: 'POST', url: '/api/items', headers: auth(admin), payload: { name: 'Hook Target', description: 'A webhook target item', file_type: 'zip', download_url: 'https://example.com/secret.zip' } });
    assert.ok(res.statusCode < 300, res.body);
    itemId = res.json().id;
    await tick();
    off();
    const types = seen.map(e => e.type);
    assert.ok(types.includes('item.created'), types.join());
    assert.ok(types.includes('item.published'));
    const created = seen.find(e => e.type === 'item.created');
    assert.equal(created.payload.item.name, 'Hook Target');
    assert.equal(created.payload.item.download_url, undefined, 'no URLs in payloads');
    assert.equal(created.actor_id, admin.id);
  });

  it('update emits item.updated with the changed field names', async () => {
    const seen = [];
    const off = onEvent(e => seen.push(e));
    const res = await app.inject({ method: 'PUT', url: `/api/items/${itemId}`, headers: auth(admin), payload: { version: '2.0' } });
    assert.equal(res.statusCode, 200, res.body);
    await tick(); off();
    const upd = seen.find(e => e.type === 'item.updated');
    assert.ok(upd);
    assert.deepEqual(upd.payload.changes, ['version']);
    assert.equal(upd.payload.item.version, '2.0');
  });

  it('unpublish / publish emit their own events', async () => {
    const seen = [];
    const off = onEvent(e => seen.push(e));
    await app.inject({ method: 'PUT', url: `/api/items/${itemId}`, headers: auth(admin), payload: { published: false } });
    await app.inject({ method: 'PUT', url: `/api/items/${itemId}`, headers: auth(admin), payload: { published: true } });
    await tick(); off();
    const types = seen.map(e => e.type);
    assert.deepEqual(types.filter(t => t.startsWith('item.')).slice(0, 4), ['item.unpublished', 'item.updated', 'item.published', 'item.updated']);
  });

  it('delete emits item.deleted', async () => {
    const seen = [];
    const off = onEvent(e => seen.push(e));
    await app.inject({ method: 'DELETE', url: `/api/items/${itemId}`, headers: auth(admin) });
    await tick(); off();
    const del = seen.find(e => e.type === 'item.deleted');
    assert.equal(del.payload.item.id, itemId);
    assert.equal(del.item_id, itemId);
  });

  it('listEvents filters by type and is newest first', () => {
    const all = listEvents({ limit: 100 });
    assert.ok(all.length >= 5);
    assert.ok(all[0].id > all[all.length - 1].id);
    assert.ok(listEvents({ types: ['item.deleted'] }).every(e => e.type === 'item.deleted'));
  });

  it('refuses unknown event types', () => {
    assert.throws(() => emitEvent('nope'), /Unknown event type/);
    assert.ok(EVENT_TYPES.includes('link.down'));
  });
});

describe('events: link checker transitions', () => {
  let linkId, itemId;
  before(() => {
    db.prepare("INSERT OR IGNORE INTO items (name, slug, published, file_type) VALUES ('Link Host', 'wh-link-host', 1, 'iso')").run();
    itemId = db.prepare("SELECT id FROM items WHERE slug = 'wh-link-host'").get().id;
    linkId = Number(db.prepare("INSERT INTO item_download_links (item_id, label, storage_provider, download_url, status) VALUES (?, 'Mirror', 'external', 'https://198.51.100.9/x.iso', 'up')").run(itemId).lastInsertRowid);
  });

  it('emits link.down once on up->down, nothing on down->down, link.recovered on down->up', async () => {
    // The probe target is TEST-NET-2: unroutable, so the checker cannot reach
    // it; we force outcomes by stubbing verdictFor.
    const original = linkHealthService.verdictFor;
    const force = (status) => { linkHealthService.verdictFor = () => ({ status, error: status === 'down' ? 'HTTP 404' : null }); };
    const seen = [];
    const off = onEvent(e => { if (e.type.startsWith('link.')) seen.push(e); });
    try {
      force('down'); await linkHealthService.checkById(linkId); await tick();
      force('down'); await linkHealthService.checkById(linkId); await tick();
      force('up'); await linkHealthService.checkById(linkId); await tick();
    } finally { linkHealthService.verdictFor = original; off(); }
    const types = seen.map(e => e.type);
    assert.deepEqual(types, ['link.down', 'link.recovered'], types.join());
    assert.equal(seen[0].payload.item.slug, 'wh-link-host');
    assert.equal(seen[0].payload.link.id, linkId);
    assert.equal(seen[0].payload.link.download_url, undefined);
  });
});

describe('webhooks: CRUD and auth', () => {
  it('anonymous gets 401, viewer cannot touch admin hooks', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/webhooks' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/webhooks', headers: auth(viewer) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/events', headers: auth(viewer) })).statusCode, 403);
  });

  it('validates input', async () => {
    const noEvents = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'x', url: 'https://example.com/h', events: [] } });
    assert.equal(noEvents.statusCode, 400);
    const badEvent = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'x', url: 'https://example.com/h', events: ['item.exploded'] } });
    assert.equal(badEvent.statusCode, 400);
    const ftp = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'x', url: 'ftp://example.com/h', events: ['item.updated'] } });
    assert.equal(ftp.statusCode, 400);
  });

  it('refuses internal targets (SSRF policy)', async () => {
    for (const url of ['http://127.0.0.1:3000/hook', 'http://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://localhost/x']) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'bad', url, events: ['item.updated'] } });
      assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
      assert.match(res.json().error, /Refused URL/);
    }
  });

  let hookId, secret;
  it('creates a site-wide hook and shows the secret once', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'Site hook', url: 'https://example.com/hook', events: ['item.updated', 'link.down'] } });
    assert.equal(res.statusCode, 201, res.body);
    hookId = res.json().webhook.id;
    secret = res.json().webhook.secret;
    assert.ok(secret && secret.length > 20);
    const list = await app.inject({ method: 'GET', url: '/api/admin/webhooks', headers: auth(admin) });
    const listed = list.json().webhooks.find(w => w.id === hookId);
    assert.equal(listed.secret, undefined, 'secret is never listed');
    assert.deepEqual(listed.events, ['item.updated', 'link.down']);
    assert.ok(Array.isArray(list.json().events));
  });

  it('admin hooks are invisible through the personal endpoint and vice versa', async () => {
    const personal = await app.inject({ method: 'GET', url: '/api/webhooks', headers: auth(admin) });
    assert.ok(!personal.json().webhooks.some(w => w.id === hookId));
    const mine = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(viewer), payload: { name: 'Mine', url: 'https://example.com/mine', events: ['item.published'] } });
    assert.equal(mine.statusCode, 201, mine.body);
    const asAdminSite = await app.inject({ method: 'GET', url: `/api/admin/webhooks/${mine.json().webhook.id}`, headers: auth(admin) });
    assert.equal(asAdminSite.statusCode, 404, 'personal hook is not a site hook');
    const other = await app.inject({ method: 'DELETE', url: `/api/webhooks/${mine.json().webhook.id}`, headers: auth(admin) });
    assert.equal(other.statusCode, 404, 'cannot delete someone else\'s personal hook');
  });

  it('updates, rotates the secret, and deletes', async () => {
    const upd = await app.inject({ method: 'PUT', url: `/api/admin/webhooks/${hookId}`, headers: auth(admin), payload: { events: ['item.updated'], rotateSecret: true } });
    assert.equal(upd.statusCode, 200, upd.body);
    assert.deepEqual(upd.json().webhook.events, ['item.updated']);
    assert.ok(upd.json().webhook.secret && upd.json().webhook.secret !== secret);
    const del = await app.inject({ method: 'DELETE', url: `/api/admin/webhooks/${hookId}`, headers: auth(admin) });
    assert.equal(del.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/admin/webhooks/${hookId}`, headers: auth(admin) })).statusCode, 404);
  });
});

describe('webhooks: delivery', () => {
  let hook, personalHook, itemId;
  before(async () => {
    hook = await webhookService.create({ name: 'Deliver', url: 'https://example.com/deliver', events: ['item.updated', 'link.down'] });
    personalHook = await webhookService.create({ userId: viewer.id, name: 'Personal', url: 'https://example.com/personal', events: ['item.updated'] });
    db.prepare("INSERT OR IGNORE INTO items (name, slug, published, file_type) VALUES ('Delivery Item', 'wh-delivery', 1, 'iso')").run();
    itemId = db.prepare("SELECT id FROM items WHERE slug = 'wh-delivery'").get().id;
  });

  it('delivers a matching event, signed, with the documented headers', async () => {
    sent.length = 0;
    nextResponse = () => ({ status: 200, body: 'ok' });
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    const ev = emitEvent('item.updated', { item: { id: item.id, slug: item.slug, name: item.name, published: true }, changes: ['name'] });
    await tick(); await webhookService.deliverPending(); await tick();
    const toSite = sent.find(s => s.url.startsWith('https://example.com/deliver'));
    assert.ok(toSite, 'site hook was called');
    assert.equal(toSite.init.method, 'POST');
    assert.equal(toSite.init.redirect, 'manual');
    assert.equal(toSite.init.headers['x-espress0-event'], 'item.updated');
    const body = JSON.parse(toSite.init.body);
    assert.equal(body.id, ev.id);
    assert.equal(body.data.item.slug, 'wh-delivery');
    const full = webhookService.get(hook.id, { withSecret: true });
    assert.equal(toSite.init.headers['x-espress0-signature'], signBody(full.secret, toSite.init.body));
    assert.equal(toSite.init.headers['x-espress0-signature'], 'sha256=' + crypto.createHmac('sha256', full.secret).update(toSite.init.body).digest('hex'));
    const toPersonal = sent.find(s => s.url.startsWith('https://example.com/personal'));
    assert.ok(toPersonal, 'personal hook gets public-item events');
    const rows = webhookService.deliveries(hook.id);
    assert.equal(rows[0].status, 'delivered');
    assert.equal(rows[0].response_status, 200);
  });

  it('does not deliver non-matching events', async () => {
    sent.length = 0;
    emitEvent('item.created', { item: { id: itemId, slug: 'wh-delivery', name: 'x', published: true } });
    await tick(); await webhookService.deliverPending(); await tick();
    assert.equal(sent.length, 0);
  });

  it('personal hooks never get draft-item events, site hooks do', async () => {
    sent.length = 0;
    emitEvent('item.updated', { item: { id: itemId, slug: 'wh-delivery', name: 'x', published: false }, changes: ['name'] });
    await tick(); await webhookService.deliverPending(); await tick();
    assert.ok(sent.some(s => s.url.startsWith('https://example.com/deliver')));
    assert.ok(!sent.some(s => s.url.startsWith('https://example.com/personal')));
  });

  it('schedules a retry on failure and records the error', async () => {
    sent.length = 0;
    nextResponse = () => ({ status: 500, body: 'boom' });
    emitEvent('link.down', { item: { id: itemId, slug: 'wh-delivery', name: 'x', published: true }, link: { id: 1 }, previous_status: 'up' });
    await tick(); await webhookService.deliverPending(); await tick();
    const rows = webhookService.deliveries(hook.id);
    const d = rows.find(r => r.event_type === 'link.down');
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.equal(d.error, 'HTTP 500');
    assert.ok(new Date(d.next_attempt_at) > new Date(), 'backoff in the future');
    assert.equal(webhookService.get(hook.id).last_status, 'error');
    assert.equal(webhookService.get(hook.id).failure_count, 1);

    // Not due yet: a sweep now does nothing.
    sent.length = 0;
    await webhookService.deliverPending();
    assert.equal(sent.length, 0);

    // Redeliver resets the clock; success clears the failure counter.
    nextResponse = () => ({ status: 204, body: '' });
    assert.ok(webhookService.redeliver(d.id));
    await tick(); await webhookService.deliverPending(); await tick();
    assert.equal(webhookService.deliveries(hook.id).find(r => r.id === d.id).status, 'delivered');
    assert.equal(webhookService.get(hook.id).failure_count, 0);
  });

  it('gives up after the last retry', async () => {
    nextResponse = () => ({ status: 503, body: 'nope' });
    const row = db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, NULL, 'item.updated', '{}', 'pending', 5, ?, ?)`).run(hook.id, new Date(0).toISOString(), new Date().toISOString());
    await webhookService.deliverPending();
    const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(row.lastInsertRowid);
    assert.equal(d.status, 'failed');
    assert.equal(d.attempts, 6);
  });

  it('inactive hooks get their queue cancelled instead of sent', async () => {
    await webhookService.update(hook.id, { active: false });
    sent.length = 0;
    emitEvent('item.updated', { item: { id: itemId, slug: 'wh-delivery', name: 'x', published: true }, changes: ['name'] });
    await tick(); await webhookService.deliverPending(); await tick();
    assert.ok(!sent.some(s => s.url.startsWith('https://example.com/deliver')));
    await webhookService.update(hook.id, { active: true });
  });

  it('test endpoint sends a ping synchronously', async () => {
    sent.length = 0;
    nextResponse = () => ({ status: 200, body: 'pong' });
    const res = await app.inject({ method: 'POST', url: `/api/admin/webhooks/${hook.id}/test`, headers: auth(admin) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ok, true);
    assert.equal(sent[0].init.headers['x-espress0-event'], 'ping');
  });

  it('admin event log lists what happened', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/events?type=link.down,item.updated&limit=5', headers: auth(admin) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().events.length > 0);
    assert.ok(res.json().events.every(e => ['link.down', 'item.updated'].includes(e.type)));
  });
});
