import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * The admin "bulk edit" endpoint behind Admin -> File pages.
 *
 * It is the one place in the app where a single request rewrites hundreds of
 * rows, and it takes a snapshot first, so the contract that matters is:
 * whatever the endpoint claims it did, it did. This suite exists because it
 * once did not - "Set category" answered `{ affected: 1, category: null }`
 * and cleared the category of every selected page, while the UI read
 * `affected` and reported success.
 *
 * The root cause was a key mismatch: the route read `categoryId`, the UI sent
 * the value under the generic `value` key that every other field action uses.
 * The fallback is now in the route, and both spellings are asserted below.
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { generateToken } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let db;
let adminHeaders;

const SLUG = 'bulk-test-';

async function bulk(payload) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/items/bulk',
    headers: adminHeaders,
    payload,
  });
}

function makeItem(slug, overrides = {}) {
  const { categoryId = null, folderId = null, status = 'current', published = 1 } = overrides;
  db.prepare(
    `INSERT INTO items (name, slug, description, category_id, folder_id, status, published,
                        file_type, file_size, storage_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'iso', 1024, 'external')`
  ).run(`Item ${slug}`, slug, 'bulk fixture', categoryId, folderId, status, published);
  return db.prepare('SELECT id FROM items WHERE slug = ?').get(slug);
}

const categoryOf = (id) =>
  db.prepare('SELECT category_id FROM items WHERE id = ?').get(id).category_id;
const statusOf = (id) => db.prepare('SELECT status FROM items WHERE id = ?').get(id).status;

after(async () => {
  // Releases Fastify's internals so the test process can exit on its own
  // instead of waiting to be killed.
  await app?.close();
});

before(async () => {
  db = getDb();

  db.prepare(
    `INSERT OR IGNORE INTO users (username, email, password_hash, role)
     VALUES ('bulk_admin', 'bulk_admin@example.com', 'pepper_v1:dummy', 'admin')`
  ).run();
  const admin = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('bulk_admin');
  adminHeaders = { authorization: `Bearer ${generateToken(admin)}`, 'x-csrf-token': 'test' };

  app = Fastify();
  await app.register(cookie, { secret: 'admin-bulk-test-cookie-secret-0123456789' });
  await app.register(async (api) => {
    await api.register(adminRoutes);
  }, { prefix: '/api' });
  await app.ready();

  const alpha = db.prepare(
    "INSERT OR IGNORE INTO categories (name, slug) VALUES ('Bulk Alpha', ?)"
  ).run(`${SLUG}alpha`).lastInsertRowid;
  // The second category exists so the "filter by category" cases have
  // somewhere to be wrong; nothing needs its id.
  db.prepare(
    "INSERT OR IGNORE INTO categories (name, slug) VALUES ('Bulk Beta', ?)"
  ).run(`${SLUG}beta`);

  makeItem(`${SLUG}one`, { categoryId: alpha });
  makeItem(`${SLUG}two`, { categoryId: alpha });
  makeItem(`${SLUG}three`);
});

describe('admin bulk edit: authentication and validation', () => {
  it('refuses anonymous callers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/items/bulk',
      payload: { action: 'publish', ids: [1] },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects an unknown action instead of guessing', async () => {
    const res = await bulk({ action: 'nuke_everything', ids: [1] });
    assert.equal(res.statusCode, 400);
  });

  it('rejects an empty selection', async () => {
    const res = await bulk({ action: 'publish', ids: [] });
    assert.equal(res.statusCode, 400);
  });
});

describe('admin bulk edit: category', () => {
  it('applies the category when the value arrives under `value`', async () => {
    const item = makeItem(`${SLUG}value-key`, { categoryId: null });
    const target = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}beta`).id;

    const res = await bulk({ action: 'category', ids: [item.id], value: String(target) });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.affected, 1);
    assert.equal(body.category, 'Bulk Beta');
    assert.equal(categoryOf(item.id), target);
  });

  it('applies the category when the value arrives under `categoryId`', async () => {
    const item = makeItem(`${SLUG}categoryid-key`, { categoryId: null });
    const target = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}beta`).id;

    const res = await bulk({ action: 'category', ids: [item.id], categoryId: target });

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(categoryOf(item.id), target);
  });

  it('does not wipe the category when no value is supplied at all', async () => {
    const alpha = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}alpha`).id;
    const item = makeItem(`${SLUG}no-value`, { categoryId: alpha });

    const res = await bulk({ action: 'category', ids: [item.id] });

    // A request that names the action but carries no value is a client bug:
    // answering 200 with a silently NULLed column is what made this so hard to
    // spot in production.
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(categoryOf(item.id), alpha, 'category must survive a valueless request');
  });

  it('still clears the category when null is asked for explicitly', async () => {
    const alpha = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}alpha`).id;
    const item = makeItem(`${SLUG}explicit-null`, { categoryId: alpha });

    const res = await bulk({ action: 'category', ids: [item.id], categoryId: null });

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(categoryOf(item.id), null);
  });

  it('refuses a category that does not exist', async () => {
    const item = makeItem(`${SLUG}missing-category`);
    const res = await bulk({ action: 'category', ids: [item.id], categoryId: 999999 });
    assert.equal(res.statusCode, 404, res.payload);
  });

  it('reports how many rows changed', async () => {
    const one = makeItem(`${SLUG}count-one`);
    const two = makeItem(`${SLUG}count-two`);
    const target = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}beta`).id;

    const res = await bulk({ action: 'category', ids: [one.id, two.id], categoryId: target });

    // SQLite's `changes` counts matching rows, not rows whose value differed,
    // so this is "rows touched", and the assertion pins that wording.
    assert.equal(res.json().affected, 2);
    assert.equal(categoryOf(one.id), target);
    assert.equal(categoryOf(two.id), target);
  });
});

describe('admin bulk edit: other actions', () => {
  it('publishes and unpublishes the selection', async () => {
    const item = makeItem(`${SLUG}publish`, { published: 0 });

    const up = await bulk({ action: 'publish', ids: [item.id] });
    assert.equal(up.statusCode, 200, up.payload);
    assert.equal(db.prepare('SELECT published FROM items WHERE id = ?').get(item.id).published, 1);

    const down = await bulk({ action: 'unpublish', ids: [item.id] });
    assert.equal(down.statusCode, 200, down.payload);
    assert.equal(db.prepare('SELECT published FROM items WHERE id = ?').get(item.id).published, 0);
  });

  it('writes a plain field action through the generic `value` key', async () => {
    const item = makeItem(`${SLUG}status`);

    const res = await bulk({ action: 'status', ids: [item.id], value: 'deprecated' });

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(statusOf(item.id), 'deprecated');
  });

  it('rejects a value the column cannot hold', async () => {
    const item = makeItem(`${SLUG}bad-status`);

    const res = await bulk({ action: 'status', ids: [item.id], value: 'not-a-status' });

    assert.equal(res.statusCode, 400, res.payload);
    assert.notEqual(statusOf(item.id), 'not-a-status');
  });

  it('covers every selected id in one go', async () => {
    const target = db.prepare("SELECT id FROM categories WHERE slug = ?").get(`${SLUG}alpha`).id;
    const ids = [
      makeItem(`${SLUG}batch-1`).id,
      makeItem(`${SLUG}batch-2`).id,
      makeItem(`${SLUG}batch-3`).id,
    ];

    const res = await bulk({ action: 'category', ids, categoryId: target });

    assert.equal(res.json().affected, 3);
    for (const id of ids) assert.equal(categoryOf(id), target);
  });
});
