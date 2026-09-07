import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Item views: one per device, not one per request.
 *
 * `view_count` used to be bumped by GET /api/items/:slug itself, which made it
 * a count of reads: a refresh, a back-navigation, the double effect in
 * development, a link previewer's fetch and a scraper's probe were all "views".
 * The number now moves only on POST /api/items/:slug/view, which the app fires
 * when it has actually shown the page, and which is deduplicated:
 *
 *   - by account, in `item_views`, for anyone signed in - so an account can add
 *     one view per page however often it comes back;
 *   - by browser, in localStorage, for anonymous visitors (see
 *     frontend/src/lib/viewCounting.js). The server keeps no per-device record,
 *     which is the property recentlyViewed.js documents and the reason a
 *     scripted anonymous caller is bounded by the route's rate limit instead of
 *     by a marker it could simply not send.
 *
 * Drafts must stay out of it entirely: a preview link or a staff review of an
 * unpublished page is not public interest.
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { generateToken } = await import('../src/middleware/auth.js');
const rateLimit = (await import('@fastify/rate-limit')).default;
const cookie = (await import('@fastify/cookie')).default;

let app, db, alice, bob, published, doomed;

const views = (slug) => db.prepare('SELECT view_count FROM items WHERE slug = ?').get(slug).view_count;
const viewRows = (itemId) => db.prepare('SELECT COUNT(*) AS c FROM item_views WHERE item_id = ?').get(itemId).c;

function makeUser(username) {
  db.prepare(
    "INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, 'pepper_v1:x', 'viewer')",
  ).run(username, `${username}@example.com`);
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}

function makeItem(slug, isPublished = 1) {
  db.prepare(
    'INSERT OR IGNORE INTO items (name, slug, description, published, file_type, view_count) VALUES (?, ?, ?, ?, ?, 0)',
  ).run(slug, slug, 'x', isPublished, 'zip');
  return db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
}

const readItem = (slug) => app.inject({ method: 'GET', url: `/api/items/${slug}` });
const postView = (slug, user) => app.inject({
  method: 'POST',
  url: `/api/items/${slug}/view`,
  ...(user ? { headers: { authorization: `Bearer ${generateToken(user)}` } } : {}),
});

before(async () => {
  db = getDb();
  alice = makeUser('vc_alice');
  bob = makeUser('vc_bob');
  published = makeItem('vc-thing', 1);
  makeItem('vc-draft', 0); // the draft case below reads it by slug
  doomed = makeItem('vc-gone', 1);

  app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'view-counting-test-cookie-secret-0123' });
  await app.register(rateLimit, { global: false });
  await app.register(async (api) => { await api.register(itemsRoutes); }, { prefix: '/api' });
  await app.ready();
});

after(async () => {
  await app?.close();
  db.prepare('DELETE FROM item_views').run();
});

describe('reading an item is not a view', () => {
  it('leaves the counter alone, however often the page is fetched', async () => {
    const before = views('vc-thing');
    for (let i = 0; i < 4; i++) assert.equal((await readItem('vc-thing')).statusCode, 200);
    assert.equal(views('vc-thing'), before, 'the number tracks people, not requests');
  });

  it('stays out of reach of an idempotent read: no item_views row either', async () => {
    await readItem('vc-thing');
    assert.equal(viewRows(published.id), 0, 'a read must not consume an account\'s one view');
  });
});

describe('view beacon: signed-in accounts are deduplicated by the server', () => {
  it('counts the first view of a page and nothing after it', async () => {
    const start = views('vc-thing');

    const first = await postView('vc-thing', alice);
    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(first.json().counted, true);
    assert.equal(views('vc-thing'), start + 1);

    const again = await postView('vc-thing', alice);
    assert.equal(again.statusCode, 200, 'a repeat is a no-op, not an error');
    assert.equal(again.json().counted, false);
    assert.equal(views('vc-thing'), start + 1, 'a refresh or a re-login must not add a second view');
    assert.equal(viewRows(published.id), 1, 'and the account has exactly one row');
  });

  it('counts a second account separately', async () => {
    const start = views('vc-thing');
    assert.equal((await postView('vc-thing', bob)).json().counted, true);
    assert.equal(views('vc-thing'), start + 1);
    assert.equal(viewRows(published.id), 2);
  });

  it('is per item, so one account still reads as one view on every page', async () => {
    assert.equal((await postView('vc-gone', alice)).json().counted, true);
    assert.equal(views('vc-gone'), 1);
  });

  it('drops the rows with the item, so the table cannot outlive a page', async () => {
    assert.equal(viewRows(doomed.id), 1);
    db.prepare('DELETE FROM items WHERE id = ?').run(doomed.id);
    assert.equal(viewRows(doomed.id), 0, 'item_views is ON DELETE CASCADE');
  });
});

describe('view beacon: anonymous visitors', () => {
  it('counts what the browser reports', async () => {
    const start = views('vc-thing');
    assert.equal((await postView('vc-thing')).json().counted, true);
    assert.equal(views('vc-thing'), start + 1);
  });

  it('keeps no trace of the visitor that reported it', async () => {
    await postView('vc-thing');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM item_views WHERE user_id IS NULL').get().c,
      0,
      'anonymous views never enter the table - that is what makes this not tracking',
    );
  });

  it('relies on the browser for the repeat, so the request itself is what is bounded', async () => {
    // Documenting the boundary rather than pretending it away: without an
    // identifier the server cannot know two anonymous calls are one device.
    // The dedupe is frontend/src/lib/viewCounting.js; the bound is the route's
    // own rate limit. A tracking cookie would "fix" the first and undo the last.
    const start = views('vc-thing');
    await postView('vc-thing');
    await postView('vc-thing');
    assert.equal(views('vc-thing'), start + 2);
  });
});

describe('view beacon: what must never be counted', () => {
  it('404s a draft, so the beacon cannot confirm a hidden slug or move its number', async () => {
    const res = await postView('vc-draft');
    assert.equal(res.statusCode, 404, res.payload);
    assert.equal(res.json().error, 'Item not found');
    assert.equal(views('vc-draft'), 0);
    assert.equal((await postView('vc-draft', alice)).statusCode, 404);
    assert.equal(views('vc-draft'), 0, 'and a signed-in reviewer does not count either');
    assert.equal(views('vc-draft'), 0);
  });

  it('404s an unknown slug', async () => {
    assert.equal((await postView('vc-nope')).statusCode, 404);
  });

  it('does not need a body', async () => {
    // The SPA posts `{}` because of the shared Content-Type; the route must not
    // grow a schema that rejects an empty announcement.
    const res = await app.inject({ method: 'POST', url: '/api/items/vc-thing/view', payload: {} });
    assert.equal(res.statusCode, 200, res.payload);
  });
});
