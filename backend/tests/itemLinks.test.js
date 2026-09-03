import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Saving a page from the admin editor.
 *
 * The mirrors of a page carry history: how often each one was downloaded, when
 * it was last reachability-checked, and what that check found. Saving the page
 * used to `DELETE FROM item_download_links WHERE item_id = ?` and re-insert
 * every row from the request, so each save zeroed the download counters and
 * threw the health-check results away - while reporting success. A mirror that
 * failed validation was skipped the same way, which deleted it outright.
 *
 * Saving must now edit mirrors in place.
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { generateToken } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let db;
let headers;

const SLUG = 'item-links-';

function makeItem(slug) {
  db.prepare(
    `INSERT OR IGNORE INTO items (name, slug, description, published, file_type, file_size,
                                  storage_provider, license_status)
     VALUES (?, ?, 'fixture', 1, 'iso', 1024, 'external', 'check-license')`
  ).run(`Item ${slug}`, slug);
  return db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
}

/** A mirror with history, written directly so the test owns its state. */
function makeLink(itemId, { label = 'Mirror', url = 'https://example.com/a.iso', count = 0 } = {}) {
  const row = db.prepare(`
    INSERT INTO item_download_links (item_id, label, storage_provider, download_url, file_size,
                                     is_primary, is_down, status, sort_order, download_count,
                                     last_checked, http_status, created_at)
    VALUES (?, ?, 'external', ?, 1024, 1, 0, 'up', 0, ?,
            '2026-01-01 00:00:00', 200, '2025-01-01 00:00:00')
  `).run(itemId, label, url, count);
  return Number(row.lastInsertRowid);
}

const linkRow = (id) => db.prepare('SELECT * FROM item_download_links WHERE id = ?').get(id);
const linksFor = (itemId) =>
  db.prepare('SELECT * FROM item_download_links WHERE item_id = ? ORDER BY sort_order, id').all(itemId);

/** What the admin editor sends: the whole page, mirrors included. */
function editorPayload(item, overrides = {}) {
  return {
    name: item.name,
    slug: item.slug,
    description: 'fixture',
    file_type: 'iso',
    file_size: 1024,
    storage_provider: 'external',
    license_status: 'check-license',
    published: 1,
    featured: 0,
    ...overrides,
  };
}

async function save(item, body) {
  return app.inject({
    method: 'PUT',
    url: `/api/items/${item.id}`,
    headers,
    payload: body,
  });
}

after(async () => {
  await app?.close();
});

before(async () => {
  db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (username, email, password_hash, role)
     VALUES ('links_admin', 'links_admin@example.com', 'pepper_v1:dummy', 'admin')`
  ).run();
  const admin = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('links_admin');
  headers = { authorization: `Bearer ${generateToken(admin)}` };

  app = Fastify();
  await app.register(cookie, { secret: 'item-links-test-cookie-secret-0123456789' });
  await app.register(async (api) => { await api.register(itemsRoutes); }, { prefix: '/api' });
  await app.ready();
});

describe('saving a page: mirrors keep their history', () => {
  it('edits a mirror in place instead of replacing the row', async () => {
    const item = makeItem(`${SLUG}keep`);
    const linkId = makeLink(item.id, { count: 42 });

    const res = await save(item, editorPayload(item, {
      download_links: [{
        id: linkId,
        label: 'Renamed mirror',
        storage_provider: 'external',
        download_url: 'https://example.com/b.iso',
        file_size: 2048,
        is_primary: true,
        sort_order: 0,
      }],
    }));

    assert.equal(res.statusCode, 200, res.payload);

    const after = linkRow(linkId);
    assert.ok(after, 'the original row must survive the save');
    assert.equal(after.label, 'Renamed mirror');
    assert.equal(Number(after.file_size), 2048);
    assert.equal(Number(after.download_count), 42, 'download_count must survive a save');
    assert.equal(after.status, 'up', 'the health check result must survive a save');
    assert.equal(after.http_status, 200);
    assert.ok(after.last_checked, 'last_checked must survive a save');
    assert.equal(after.created_at, '2025-01-01 00:00:00', 'created_at must survive a save');
    assert.equal(linksFor(item.id).length, 1, 'no duplicate mirror');
  });

  it('deletes only the mirrors the admin removed', async () => {
    const item = makeItem(`${SLUG}delete`);
    const keep = makeLink(item.id, { label: 'Keep me', count: 7 });
    const drop = makeLink(item.id, { label: 'Drop me' });

    const res = await save(item, editorPayload(item, {
      download_links: [{ id: keep, label: 'Keep me', storage_provider: 'external', download_url: 'https://example.com/k.iso' }],
    }));

    assert.equal(res.statusCode, 200, res.payload);
    const remaining = linksFor(item.id).map(l => Number(l.id));
    assert.deepEqual(remaining, [keep]);
    assert.equal(linkRow(drop), undefined);
    assert.equal(Number(linkRow(keep).download_count), 7);
  });

  it('inserts a mirror the client has no id for', async () => {
    const item = makeItem(`${SLUG}add`);

    const res = await save(item, editorPayload(item, {
      download_links: [
        { label: 'New mirror', storage_provider: 'external', download_url: 'https://example.com/new.iso' },
        { label: 'Second mirror', storage_provider: 'external', download_url: 'https://example.com/2.iso' },
      ],
    }));

    assert.equal(res.statusCode, 200, res.payload);
    const links = linksFor(item.id);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(l => l.label), ['New mirror', 'Second mirror']);
    assert.deepEqual(links.map(l => l.sort_order), [0, 1]);
  });

  it('leaves the mirrors alone when the request says nothing about them', async () => {
    const item = makeItem(`${SLUG}untouched`);
    const linkId = makeLink(item.id, { count: 5 });

    const res = await save(item, editorPayload(item, { description: 'edited description' }));

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(linksFor(item.id).length, 1);
    assert.equal(Number(linkRow(linkId).download_count), 5);
  });

  it('does not let a save reach for another page\'s mirror', async () => {
    const mine = makeItem(`${SLUG}mine`);
    const theirs = makeItem(`${SLUG}theirs`);
    const foreignId = makeLink(theirs.id, { label: 'Their mirror' });

    // The id is honoured only if it already belongs to this item; otherwise a
    // save could rename and repoint another page's mirror.
    const res = await save(mine, editorPayload(mine, {
      download_links: [{ id: foreignId, label: 'Stolen?', storage_provider: 'external', download_url: 'https://example.com/x.iso' }],
    }));

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(linkRow(foreignId).label, 'Their mirror', 'the other page keeps its mirror');
    assert.equal(linkRow(foreignId).item_id, theirs.id);
    const mineLinks = linksFor(mine.id);
    assert.equal(mineLinks.length, 1, 'a new row is created for this page instead');
    assert.equal(mineLinks[0].label, 'Stolen?');
  });
});

describe('saving a page: a bad mirror is refused, not dropped', () => {
  it('rejects the save and says which mirror is wrong', async () => {
    const item = makeItem(`${SLUG}invalid`);
    const good = makeLink(item.id, { label: 'Good mirror' });

    // A one-character label fails the schema. It used to be skipped silently,
    // so the save succeeded and the mirror was gone.
    const res = await save(item, editorPayload(item, {
      download_links: [
        { id: good, label: 'Good mirror', storage_provider: 'external', download_url: 'https://example.com/g.iso' },
        { label: 'x', storage_provider: 'external', download_url: 'https://example.com/bad.iso' },
      ],
    }));

    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assert.match(body.error, /download link/i);
    assert.equal(body.linkErrors.length, 1);
    assert.equal(body.linkErrors[0].index, 1);
    // Nothing was written: the good mirror is untouched.
    assert.equal(linksFor(item.id).length, 1);
    assert.equal(linkRow(good).label, 'Good mirror');
  });

  it('rejects a non-array mirror list', async () => {
    const item = makeItem(`${SLUG}notarray`);
    const res = await save(item, editorPayload(item, { download_links: 'https://example.com' }));
    assert.equal(res.statusCode, 400, res.payload);
  });

  it('refuses to create a page with an unusable mirror', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers,
      payload: {
        name: 'Page with a broken mirror',
        slug: `${SLUG}create-invalid`,
        description: 'fixture',
        storage_provider: 'external',
        license_status: 'check-license',
        download_links: [{ label: 'x', storage_provider: 'external', download_url: 'https://example.com/a.iso' }],
      },
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(
      db.prepare('SELECT id FROM items WHERE slug = ?').get(`${SLUG}create-invalid`),
      undefined,
      'nothing is created when a mirror is unusable',
    );
  });
});
