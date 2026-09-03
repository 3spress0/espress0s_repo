import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Personal favourites and public account profiles.
 *
 * The interesting property under test is the default: starring a file must be
 * a private act. Sharing is a second, deliberate step, and this suite exists
 * mainly to prove that the second step is required - including in the places
 * where it would be easy to get wrong (drafts, deleted items, profiles).
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { favoritesRoutes } = await import('../src/routes/favorites.js');
const { usersRoutes } = await import('../src/routes/users.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { generateToken } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let db;

function tokenFor(user) {
  return { authorization: `Bearer ${generateToken(user)}` };
}

function userRow(username) {
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}

function makeUser(username) {
  db.prepare(
    `INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'viewer')`
  ).run(username, `${username}@example.com`, 'pepper_v1:dummy');
  return userRow(username);
}

function makeItem(slug, overrides = {}) {
  const {
    name = `Item ${slug}`,
    published = 1,
    description = 'Fixture item for the favourites tests.',
  } = overrides;
  db.prepare(
    `INSERT OR IGNORE INTO items (name, slug, description, published, file_type, file_size)
     VALUES (?, ?, ?, ?, 'iso', 1024)`
  ).run(name, slug, description, published);
  return db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
}

after(async () => {
  // Releases Fastify's internals so the test process can exit on its own
  // instead of waiting to be killed.
  await app?.close();
});

before(async () => {
  db = getDb();

  app = Fastify();
  await app.register(cookie, { secret: 'favorites-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => {
    await api.register(favoritesRoutes);
    await api.register(usersRoutes);
    await api.register(itemsRoutes);
    await api.register(authRoutes);
  }, { prefix: '/api' });
  await app.ready();

  makeUser('fav_owner');
  makeUser('fav_other');
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'fav_other'").run();
  makeItem('fav-public-item');
  makeItem('fav-secret-item');
  makeItem('fav-draft-item', { published: 0 });
});

describe('favourites: authentication', () => {
  it('refuses to list or write favourites without a session', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/favorites' });
    assert.equal(list.statusCode, 401);

    const add = await app.inject({
      method: 'POST', url: '/api/favorites', payload: { slug: 'fav-public-item' },
    });
    assert.equal(add.statusCode, 401);

    const remove = await app.inject({ method: 'DELETE', url: '/api/favorites/fav-public-item' });
    assert.equal(remove.statusCode, 401);

    const patch = await app.inject({
      method: 'PATCH', url: '/api/favorites/fav-public-item', payload: { is_public: true },
    });
    assert.equal(patch.statusCode, 401);
  });
});

describe('favourites: private by default', () => {
  it('stars a file privately and keeps it off the public profile', async () => {
    const owner = userRow('fav_owner');

    const created = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: tokenFor(owner),
      payload: { slug: 'fav-public-item' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().favorite.is_public, false);

    // It is on the owner's own list...
    const mine = await app.inject({ method: 'GET', url: '/api/favorites', headers: tokenFor(owner) });
    assert.equal(mine.statusCode, 200);
    const slugs = mine.json().favorites.map(f => f.slug);
    assert.ok(slugs.includes('fav-public-item'));
    assert.equal(mine.json().counts.public, 0);

    // ...and nowhere public.
    const profile = await app.inject({ method: 'GET', url: '/api/users/fav_owner' });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().favorites_count, 0);

    const publicList = await app.inject({ method: 'GET', url: '/api/users/fav_owner/favorites' });
    assert.equal(publicList.statusCode, 200);
    assert.deepEqual(publicList.json().favorites, []);
  });

  it('starring twice is idempotent and does not duplicate the row', async () => {
    const owner = userRow('fav_owner');

    const second = await app.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: tokenFor(owner),
      payload: { slug: 'fav-public-item' },
    });
    assert.equal(second.statusCode, 200); // already existed
    assert.equal(second.json().created, false);

    const rows = db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ? AND item_id = ?')
      .get(owner.id, makeItem('fav-public-item').id);
    assert.equal(rows.c, 1);
  });

  it('never leaks the item row shape a full item would carry', async () => {
    const owner = userRow('fav_owner');
    const res = await app.inject({ method: 'GET', url: '/api/favorites', headers: tokenFor(owner) });
    const row = res.json().favorites[0];
    for (const leaked of ['download_url', 'storage_path', 'external_url', 'license_notes', 'download_links']) {
      assert.equal(row[leaked], undefined, `${leaked} should not be in a favourite card`);
    }
  });
});

describe('favourites: sharing is opt-in', () => {
  it('appears on the public profile only after the owner shares it', async () => {
    const owner = userRow('fav_owner');
    const item = makeItem('fav-secret-item');

    await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(owner),
      payload: { item_id: item.id },
    });

    const shared = await app.inject({
      method: 'PATCH', url: `/api/favorites/${item.id}`, headers: tokenFor(owner),
      payload: { is_public: true },
    });
    assert.equal(shared.statusCode, 200);
    assert.equal(shared.json().favorite.is_public, true);

    const publicList = await app.inject({ method: 'GET', url: '/api/users/fav_owner/favorites' });
    assert.equal(publicList.statusCode, 200);
    const slugs = publicList.json().favorites.map(f => f.slug);
    assert.ok(slugs.includes('fav-secret-item'));
    assert.ok(!slugs.includes('fav-public-item'), 'the still-private favourite must not appear');

    const profile = await app.inject({ method: 'GET', url: '/api/users/fav_owner' });
    assert.equal(profile.json().favorites_count, 1);

    // Unsharing removes it again.
    await app.inject({
      method: 'PATCH', url: `/api/favorites/${item.id}`, headers: tokenFor(owner),
      payload: { is_public: false },
    });
    const after = await app.inject({ method: 'GET', url: '/api/users/fav_owner/favorites' });
    assert.deepEqual(after.json().favorites.map(f => f.slug), []);
  });

  it('accepts "true"/"1" strings from a form without rejecting them', async () => {
    const owner = userRow('fav_owner');
    const item = makeItem('fav-secret-item');

    const res = await app.inject({
      method: 'PATCH', url: `/api/favorites/${item.id}`, headers: tokenFor(owner),
      payload: { is_public: 'true' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().favorite.is_public, true);

    await app.inject({
      method: 'PATCH', url: `/api/favorites/${item.id}`, headers: tokenFor(owner),
      payload: { is_public: '0' },
    });
    const row = db.prepare('SELECT is_public FROM favorites WHERE user_id = ? AND item_id = ?')
      .get(owner.id, item.id);
    assert.equal(row.is_public, 0);
  });

  it('refuses to set visibility for a file that was never starred', async () => {
    const owner = userRow('fav_owner');
    makeItem('fav-never-starred');
    const res = await app.inject({
      method: 'PATCH', url: '/api/favorites/fav-never-starred', headers: tokenFor(owner),
      payload: { is_public: true },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('favourites: profile default', () => {
  it('makes new favourites public once the user opts in, without touching old ones', async () => {
    const owner = userRow('fav_owner');
    makeItem('fav-default-item');

    const before = await app.inject({ method: 'GET', url: '/api/auth/profile', headers: tokenFor(owner) });
    assert.equal(before.json().favorites_default_public, false);

    await app.inject({
      method: 'PUT', url: '/api/auth/profile', headers: tokenFor(owner),
      payload: { favorites_default_public: true },
    });

    const after = await app.inject({ method: 'GET', url: '/api/auth/profile', headers: tokenFor(owner) });
    assert.equal(after.json().favorites_default_public, true);

    const created = await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(owner),
      payload: { slug: 'fav-default-item' },
    });
    assert.equal(created.json().favorite.is_public, true);

    // The profile switch is a starting point, not a bulk edit: the private
    // favourite from earlier stays private.
    const stillPrivate = db.prepare(`
      SELECT favorites.is_public FROM favorites
      JOIN items ON items.id = favorites.item_id
      WHERE favorites.user_id = ? AND items.slug = 'fav-public-item'
    `).get(owner.id);
    assert.equal(stillPrivate.is_public, 0);

    // Put the account back the way the suite found it.
    await app.inject({
      method: 'PUT', url: '/api/auth/profile', headers: tokenFor(owner),
      payload: { favorites_default_public: false },
    });
  });
});

describe('favourites: drafts are not reachable through a favourite', () => {
  it('answers 404 when a normal account tries to star an unpublished item', async () => {
    const owner = userRow('fav_owner');
    const res = await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(owner),
      payload: { slug: 'fav-draft-item' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'Item not found');
  });

  it('lets an admin star a draft but never shows it on a public profile', async () => {
    const admin = userRow('fav_other');
    const draft = makeItem('fav-draft-item');

    const created = await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(admin),
      payload: { slug: 'fav-draft-item', is_public: true },
    });
    assert.equal(created.statusCode, 201);

    // Visible to its owner in their own list...
    const mine = await app.inject({ method: 'GET', url: '/api/favorites', headers: tokenFor(admin) });
    assert.ok(mine.json().favorites.some(f => f.slug === 'fav-draft-item'));

    // ...but a shared favourite is not a back door into an unpublished file.
    const publicList = await app.inject({ method: 'GET', url: '/api/users/fav_other/favorites' });
    assert.deepEqual(publicList.json().favorites.map(f => f.slug), []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/users/fav_other' })).json().favorites_count, 0);

    db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').run(admin.id, draft.id);
  });
});

describe('favourites: item page state', () => {
  it('reports is_favorite for the owner and not for anyone else', async () => {
    const owner = userRow('fav_owner');
    const other = userRow('fav_other');

    const asOwner = await app.inject({
      method: 'GET', url: '/api/items/fav-public-item', headers: tokenFor(owner),
    });
    assert.equal(asOwner.json().is_favorite, true);
    assert.ok(asOwner.json().favorites_count >= 1);

    const asOther = await app.inject({
      method: 'GET', url: '/api/items/fav-public-item', headers: tokenFor(other),
    });
    assert.equal(asOther.json().is_favorite, false);

    const anon = await app.inject({ method: 'GET', url: '/api/items/fav-public-item' });
    assert.equal(anon.json().is_favorite, false);
  });
});

describe('favourites: removal', () => {
  it('unstars a file and returns 200 even when it was not starred', async () => {
    const owner = userRow('fav_owner');

    const removed = await app.inject({
      method: 'DELETE', url: '/api/favorites/fav-public-item', headers: tokenFor(owner),
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().removed, true);

    const gone = db.prepare(`
      SELECT COUNT(*) AS c FROM favorites
      JOIN items ON items.id = favorites.item_id
      WHERE favorites.user_id = ? AND items.slug = 'fav-public-item'
    `).get(owner.id);
    assert.equal(gone.c, 0);

    const again = await app.inject({
      method: 'DELETE', url: '/api/favorites/fav-public-item', headers: tokenFor(owner),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().removed, false);
  });

  it('drops favourites when the item itself is deleted', async () => {
    const owner = userRow('fav_owner');
    makeItem('fav-doomed-item');
    const item = db.prepare('SELECT * FROM items WHERE slug = ?').get('fav-doomed-item');

    await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(owner),
      payload: { item_id: item.id },
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE item_id = ?').get(item.id).c, 1);

    db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE item_id = ?').get(item.id).c, 0);
  });

  it('rejects a malformed item reference instead of passing it to SQL', async () => {
    const owner = userRow('fav_owner');
    const res = await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(owner),
      payload: { item_id: -1 },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('public profiles', () => {
  it('returns a profile without the email address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/fav_owner' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.username, 'fav_owner');
    assert.equal(body.email, undefined);
    assert.equal(JSON.stringify(body).includes('@example.com'), false);
  });

  it('404s for a user who does not exist, on both endpoints', async () => {
    const profile = await app.inject({ method: 'GET', url: '/api/users/no-such-account' });
    assert.equal(profile.statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/api/users/no-such-account/favorites' });
    assert.equal(list.statusCode, 404);
  });

  it('shows one account only its own shared favourites', async () => {
    const other = userRow('fav_other');
    makeItem('fav-other-item');
    const item = db.prepare('SELECT * FROM items WHERE slug = ?').get('fav-other-item');

    await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(other),
      payload: { item_id: item.id, is_public: true },
    });

    const list = await app.inject({ method: 'GET', url: '/api/users/fav_other/favorites' });
    assert.deepEqual(list.json().favorites.map(f => f.slug), ['fav-other-item']);
    assert.equal(list.json().pagination.total, 1);

    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(other.id);
  });
});

describe('people directory', () => {
  it('lists accounts without leaking any email address', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.users));
    assert.ok(body.users.length >= 1);
    // Directory is public, so it must never carry an email in any shape.
    assert.equal(JSON.stringify(body).includes('@example.com'), false);
    for (const u of body.users) {
      assert.equal(u.email, undefined);
      assert.equal(typeof u.username, 'string');
      assert.equal(typeof u.favorites_count, 'number');
    }
  });

  it('finds an account by a username substring, case-insensitively', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users?q=OWNER' });
    assert.equal(res.statusCode, 200);
    const names = res.json().users.map(u => u.username);
    assert.ok(names.includes('fav_owner'));
    assert.ok(names.every(n => n.toLowerCase().includes('owner')));
  });

  it('returns an empty page rather than everyone for a no-match search', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users?q=definitely-not-a-user-xyz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().users.length, 0);
    assert.equal(res.json().pagination.total, 0);
  });

  it('counts only shared, published favourites per account', async () => {
    makeUser('dir_counter');
    const counter = userRow('dir_counter');
    makeItem('dir-public-item');
    makeItem('dir-private-item');
    const pub = db.prepare('SELECT * FROM items WHERE slug = ?').get('dir-public-item');
    const priv = db.prepare('SELECT * FROM items WHERE slug = ?').get('dir-private-item');

    await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(counter),
      payload: { item_id: pub.id, is_public: true },
    });
    await app.inject({
      method: 'POST', url: '/api/favorites', headers: tokenFor(counter),
      payload: { item_id: priv.id, is_public: false },
    });

    const res = await app.inject({ method: 'GET', url: '/api/users?q=dir_counter' });
    const row = res.json().users.find(u => u.username === 'dir_counter');
    assert.ok(row);
    assert.equal(row.favorites_count, 1);

    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(counter.id);
  });
});
