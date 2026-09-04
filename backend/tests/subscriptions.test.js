import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Per-entry / per-tag subscriptions tied to personal webhooks (#13).
 *
 * - follow/unfollow an item and a tag; status endpoint
 * - a personal hook with filter_mode 'subscribed' only gets events for
 *   followed items (directly or via tag); 'all' hooks are unchanged
 * - site-wide hooks cannot be limited to subscriptions
 */
const { getDb } = await import('../src/db/index.js');
const { subscriptionRoutes } = await import('../src/routes/subscriptions.js');
const { webhookRoutes } = await import('../src/routes/webhooks.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { emitEvent, itemSummary } = await import('../src/services/eventBus.js');
const { webhookService } = await import('../src/services/webhookService.js');
const cookie = (await import('@fastify/cookie')).default;

let app, db, user, other;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });
const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));

function makeUser(username, role) {
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, 'pepper_v1:dummy', ?)`).run(username, `${username}@example.com`, role);
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}
function makeItem(slug, tags) {
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, tags) VALUES (?, ?, 'x', 1, 'zip', ?)`).run(`Item ${slug}`, slug, JSON.stringify(tags));
  return db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
}

let followed, tagged, unrelated;
before(async () => {
  db = getDb();
  user = makeUser('sub_user', 'viewer');
  other = makeUser('sub_other', 'viewer');
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare("DELETE FROM webhooks WHERE name LIKE 'sub-%'").run();
  followed = makeItem('sub-followed', ['editor']);
  tagged = makeItem('sub-tagged', ['Retro', 'games']);
  unrelated = makeItem('sub-unrelated', ['misc']);
  webhookService.fetchImpl = async () => ({ status: 200, text: async () => 'ok' });
  webhookService.start({ info() {}, error() {} });
  app = Fastify();
  await app.register(cookie, { secret: 'subs-test-cookie-secret-0123456789abcdef00' });
  await app.register(async (api) => { await api.register(subscriptionRoutes); await api.register(webhookRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { webhookService.stop(); await app?.close(); });

describe('subscriptions: routes', () => {
  it('requires auth', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/subscriptions' })).statusCode, 401);
  });

  it('follows an item by slug and a tag, idempotently', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'item', item_slug: 'sub-followed' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().subscription.item.slug, 'sub-followed');
    res = await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'item', item_slug: 'sub-followed' } });
    assert.equal(res.statusCode, 201);
    res = await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'tag', tag: '  RETRO ' } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().subscription.tag, 'retro');
    const list = (await app.inject({ method: 'GET', url: '/api/subscriptions', headers: auth(user) })).json().subscriptions;
    assert.equal(list.length, 2);
  });

  it('rejects unknown items and bad kinds', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'item', item_slug: 'nope' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'x' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/subscriptions', headers: auth(user), payload: { kind: 'tag', tag: '' } })).statusCode, 400);
  });

  it('reports status per item, including via tag', async () => {
    let s = (await app.inject({ method: 'GET', url: '/api/subscriptions/status/sub-followed', headers: auth(user) })).json();
    assert.equal(s.subscribed, true); assert.ok(s.subscription_id);
    s = (await app.inject({ method: 'GET', url: '/api/subscriptions/status/sub-tagged', headers: auth(user) })).json();
    assert.equal(s.subscribed, false); assert.deepEqual(s.via_tags, ['retro']);
    s = (await app.inject({ method: 'GET', url: '/api/subscriptions/status/sub-unrelated', headers: auth(user) })).json();
    assert.equal(s.subscribed, false); assert.deepEqual(s.via_tags, []);
  });

  it('cannot delete another user\'s subscription', async () => {
    const mine = (await app.inject({ method: 'GET', url: '/api/subscriptions', headers: auth(user) })).json().subscriptions[0];
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${mine.id}`, headers: auth(other) })).statusCode, 404);
  });
});

describe('subscriptions: webhook filtering', () => {
  let subHook, allHook;
  it('creates a subscribed-only personal hook; site-wide refuses the mode', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(user), payload: { name: 'sub-only', url: 'https://example.com/hook', events: ['item.updated'], filter_mode: 'subscribed' } });
    assert.equal(res.statusCode, 201, res.body);
    subHook = res.json().webhook; assert.equal(subHook.filter_mode, 'subscribed');
    res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(user), payload: { name: 'sub-all', url: 'https://example.com/hook2', events: ['item.updated'] } });
    allHook = res.json().webhook; assert.equal(allHook.filter_mode, 'all');
    const admin = makeUser('sub_admin', 'admin');
    res = await app.inject({ method: 'POST', url: '/api/admin/webhooks', headers: auth(admin), payload: { name: 'sub-site', url: 'https://example.com/hook3', events: ['item.updated'], filter_mode: 'subscribed' } });
    assert.equal(res.statusCode, 400);
  });

  it('delivers only followed items (direct or via tag) to the subscribed hook', async () => {
    const deliveriesFor = (hookId) => db.prepare('SELECT event_type, payload FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id').all(hookId);
    const before = { sub: deliveriesFor(subHook.id).length, all: deliveriesFor(allHook.id).length };
    emitEvent('item.updated', { item: itemSummary(followed), changes: ['version'] });
    emitEvent('item.updated', { item: itemSummary(tagged), changes: ['version'] });
    emitEvent('item.updated', { item: itemSummary(unrelated), changes: ['version'] });
    await tick(); await tick();
    const sub = deliveriesFor(subHook.id).slice(before.sub).map(d => JSON.parse(d.payload).data.item.slug);
    const all = deliveriesFor(allHook.id).slice(before.all).map(d => JSON.parse(d.payload).data.item.slug);
    assert.deepEqual(sub.sort(), ['sub-followed', 'sub-tagged']);
    assert.deepEqual(all.sort(), ['sub-followed', 'sub-tagged', 'sub-unrelated']);
  });

  it('switching a hook back to all removes the filter', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/webhooks/${subHook.id}`, headers: auth(user), payload: { filter_mode: 'all' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().webhook.filter_mode, 'all');
  });
});
