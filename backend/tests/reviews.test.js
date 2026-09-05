import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Ratings and reviews (#19): one review per user per published entry,
 * public aggregates, spam holds (links -> pending), moderation, auth.
 */
const { getDb } = await import('../src/db/index.js');
const { reviewRoutes } = await import('../src/routes/reviews.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { ratingSummary, REVIEW_MAX_PER_DAY } = await import('../src/services/reviewService.js');
const rateLimit = (await import('@fastify/rate-limit')).default;
const cookie = (await import('@fastify/cookie')).default;

let app, db, alice, bob, newbie, editor, item;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });
function makeUser(username, role, createdAt = '2020-01-01 00:00:00') {
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, 'pepper_v1:x', ?, ?)`).run(username, `${username}@example.com`, role, createdAt);
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}

before(async () => {
  db = getDb();
  alice = makeUser('rv_alice', 'viewer'); bob = makeUser('rv_bob', 'viewer'); editor = makeUser('rv_editor', 'editor');
  newbie = makeUser('rv_newbie', 'viewer', new Date().toISOString());
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type) VALUES ('Rated Thing', 'rv-thing', 'x', 1, 'zip')`).run();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type) VALUES ('Rated Draft', 'rv-draft', 'x', 0, 'zip')`).run();
  item = db.prepare("SELECT * FROM items WHERE slug = 'rv-thing'").get();
  db.prepare('DELETE FROM reviews').run();
  app = Fastify();
  await app.register(cookie, { secret: 'reviews-test-cookie-secret-0123456789abcdef' });
  await app.register(rateLimit, { global: false });
  await app.register(async (api) => { await api.register(reviewRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('reviews: write and read', () => {
  it('requires auth to write; anyone can read the (empty) summary', async () => {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', payload: { rating: 5 } })).statusCode, 401);
    const res = await app.inject({ method: 'GET', url: '/api/items/rv-thing/reviews' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().summary, { average: null, count: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    assert.equal(res.json().mine, null);
  });

  it('creates, then replaces (one per user), and aggregates', async () => {
    let res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(alice), payload: { rating: 4, comment: 'Solid.' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().review.status, 'visible');
    res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(alice), payload: { rating: 5 } });
    assert.equal(res.statusCode, 200);
    res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob), payload: { rating: 2, comment: 'Meh' } });
    assert.equal(res.statusCode, 201);
    const s = ratingSummary(item.id);
    assert.equal(s.count, 2); assert.equal(s.average, 3.5); assert.equal(s.histogram[5], 1);
    const list = (await app.inject({ method: 'GET', url: '/api/items/rv-thing/reviews', headers: auth(alice) })).json();
    assert.equal(list.reviews.length, 2);
    assert.equal(list.mine.rating, 5);
    assert.ok(list.reviews.every(r => r.user.username && !('email' in r.user)));
  });

  it('validates rating and refuses drafts / unknown items', async () => {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(alice), payload: { rating: 9 } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/items/rv-draft/reviews/mine', headers: auth(alice), payload: { rating: 3 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/items/rv-draft/reviews' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/items/rv-draft/reviews', headers: auth(editor) })).statusCode, 200);
  });

  it('withdraws own review', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().summary.count, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob) })).statusCode, 404);
  });
});

describe('reviews: spam protection and moderation', () => {
  it('holds comments with links as pending; they do not count publicly', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob), payload: { rating: 1, comment: 'Get it cheaper at https://spam.example.com' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().review.status, 'pending');
    assert.equal(ratingSummary(item.id).count, 1, 'pending review not counted');
    const anon = (await app.inject({ method: 'GET', url: '/api/items/rv-thing/reviews' })).json();
    assert.ok(!anon.reviews.some(r => r.user.username === 'rv_bob'));
    const own = (await app.inject({ method: 'GET', url: '/api/items/rv-thing/reviews', headers: auth(bob) })).json();
    assert.ok(own.reviews.some(r => r.user.username === 'rv_bob'), 'author sees own pending row');
  });

  it('rejects too many links and brand-new accounts', async () => {
    let res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob), payload: { rating: 1, comment: 'a http://a.example b http://b.example c http://c.example' } });
    assert.equal(res.statusCode, 400);
    res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(newbie), payload: { rating: 5 } });
    assert.equal(res.statusCode, 429);
    assert.ok(REVIEW_MAX_PER_DAY >= 1);
  });

  it('moderators approve/hide/delete; viewers cannot', async () => {
    const pending = (await app.inject({ method: 'GET', url: '/api/admin/reviews?status=pending', headers: auth(editor) })).json();
    assert.equal(pending.counts.pending, 1);
    const id = pending.reviews[0].id;
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/reviews/${id}`, headers: auth(alice), payload: { status: 'visible' } })).statusCode, 403);
    let res = await app.inject({ method: 'PATCH', url: `/api/admin/reviews/${id}`, headers: auth(editor), payload: { status: 'visible' } });
    assert.equal(res.statusCode, 200);
    assert.equal(ratingSummary(item.id).count, 2);
    res = await app.inject({ method: 'PATCH', url: `/api/admin/reviews/${id}`, headers: auth(editor), payload: { status: 'hidden' } });
    assert.equal(ratingSummary(item.id).count, 1);
    // A hidden review stays hidden if the author edits it.
    res = await app.inject({ method: 'PUT', url: '/api/items/rv-thing/reviews/mine', headers: auth(bob), payload: { rating: 3, comment: 'edited' } });
    assert.equal(res.json().review.status, 'hidden');
    res = await app.inject({ method: 'DELETE', url: `/api/admin/reviews/${id}`, headers: auth(editor) });
    assert.equal(res.statusCode, 200);
    assert.equal(ratingSummary(item.id).count, 1);
  });
});
