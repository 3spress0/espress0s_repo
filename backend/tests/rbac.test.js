import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Role-based access control.
 *
 * Three roles: viewer < editor < admin. The suite pins down the boundary from
 * both sides for every route family that an editor may touch:
 *
 *   - editor passes the content routes (create/edit items, mirrors,
 *     categories, folders, uploads, the editor-safe /admin helpers)
 *   - editor is refused (403) on destructive and operational routes
 *   - admin still passes everywhere
 *   - viewer is refused (403) on every staff route
 *   - no session is 401 everywhere, never 403 (no role leak to strangers)
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { adminRoutes, EDITOR_ROUTES } = await import('../src/routes/admin.js');
const { categoriesRoutes } = await import('../src/routes/categories.js');
const { foldersRoutes } = await import('../src/routes/folders.js');
const { uploadsRoutes } = await import('../src/routes/uploads.js');
const { settingsRoutes } = await import('../src/routes/settings.js');
const { generateToken, requireRole, roleAtLeast, ROLES } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;
const multipart = (await import('@fastify/multipart')).default;

let app;
let db;
const users = {};
const registered = new Set();

function auth(role) {
  return role ? { authorization: `Bearer ${generateToken(users[role])}` } : {};
}

function makeUser(username, role) {
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(username, `${username}@example.com`, 'pepper_v1:dummy', role);
  db.prepare('UPDATE users SET role = ? WHERE username = ?').run(role, username);
  return db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
}

function makeItem(slug, published = 1) {
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, file_size)
              VALUES (?, ?, 'rbac fixture', ?, 'iso', 1024)`).run(`Item ${slug}`, slug, published);
  return db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
}

before(async () => {
  db = getDb();
  app = Fastify();
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) registered.add(`${m} ${r.url.replace(/^\/api/, '')}`);
  });
  await app.register(cookie, { secret: 'rbac-test-cookie-secret-0123456789abcdef' });
  await app.register(multipart);
  await app.register(async (api) => {
    await api.register(itemsRoutes);
    await api.register(adminRoutes);
    await api.register(categoriesRoutes);
    await api.register(foldersRoutes);
    await api.register(uploadsRoutes);
    await api.register(settingsRoutes);
  }, { prefix: '/api' });
  await app.ready();

  users.viewer = makeUser('rbac_viewer', 'viewer');
  users.editor = makeUser('rbac_editor', 'editor');
  users.admin = makeUser('rbac_admin', 'admin');
  makeItem('rbac-item');
  makeItem('rbac-draft', 0);
});

after(async () => { await app?.close(); });

/** Assert a status while making the failure message say which call it was. */
function expect(res, status, label) {
  assert.equal(res.statusCode, status, `${label}: expected ${status}, got ${res.statusCode} ${res.body.slice(0, 120)}`);
}

describe('rbac: role helpers', () => {
  it('orders the roles viewer < editor < admin', () => {
    assert.deepEqual(ROLES, ['viewer', 'editor', 'admin']);
    assert.ok(roleAtLeast('admin', 'editor'));
    assert.ok(roleAtLeast('editor', 'editor'));
    assert.ok(!roleAtLeast('viewer', 'editor'));
    assert.ok(!roleAtLeast(undefined, 'viewer'));
  });

  it('requireRole refuses unknown roles at construction time', () => {
    assert.throws(() => requireRole('superuser'), /Unknown role/);
  });

  it('names the gate so tooling can read it', () => {
    assert.equal(requireRole('editor').name, 'requireRole:editor,admin');
    assert.equal(requireRole('admin').name, 'requireRole:admin');
  });
});

/**
 * The routes an editor may use. Each entry is exercised with editor (2xx/4xx
 * validation but never 401/403), viewer (403), anonymous (401), admin (never
 * 401/403).
 */
const EDITOR_ALLOWED = [
  { m: 'GET', url: '/api/admin/items' },
  { m: 'GET', url: '/api/admin/slug-check?slug=rbac-item' },
  { m: 'POST', url: '/api/admin/slugify', body: { name: 'Hello World' } },
  { m: 'GET', url: () => `/api/admin/items/${item().id}/versions` },
  { m: 'GET', url: () => `/api/admin/items/${item().id}/related` },
  { m: 'GET', url: '/api/admin/catalog/search?q=rbac' },
  { m: 'GET', url: '/api/admin/catalog/facets' },
  { m: 'GET', url: '/api/admin/catalog/stats' },
  { m: 'GET', url: '/api/admin/folders' },
  { m: 'GET', url: '/api/admin/uploads' },
  { m: 'PUT', url: () => `/api/items/${item().id}`, body: { name: 'Item rbac-item', description: 'edited by role test' } },
  { m: 'POST', url: () => `/api/items/${item().id}/links`, body: { label: 'Mirror', storage_provider: 'external', download_url: 'https://example.com/x.iso' } },
  { m: 'POST', url: '/api/categories', body: { name: 'RBAC cat ' + Date.now() } },
  { m: 'POST', url: '/api/folders', body: { name: 'RBAC folder ' + Date.now() } },
];

/** Admin-only: editor must get 403, admin must not get 401/403. */
const ADMIN_ONLY = [
  { m: 'GET', url: '/api/admin/overview' },
  { m: 'GET', url: '/api/admin/users' },
  { m: 'POST', url: '/api/admin/users', body: { username: 'x', password: 'y' } },
  { m: 'GET', url: '/api/admin/storage' },
  { m: 'POST', url: '/api/admin/reindex' },
  { m: 'GET', url: '/api/admin/snapshots' },
  { m: 'GET', url: '/api/admin/backup-info' },
  { m: 'GET', url: '/api/admin/auto-update' },
  { m: 'POST', url: '/api/admin/items/bulk', body: { action: 'publish', ids: [] } },
  { m: 'GET', url: '/api/admin/settings' },
  { m: 'PUT', url: '/api/admin/settings', body: { site_name: 'x' } },
  { m: 'DELETE', url: () => `/api/items/${item().id}/links/999999` },
  { m: 'DELETE', url: '/api/categories/999999' },
  { m: 'DELETE', url: '/api/folders/999999' },
  { m: 'DELETE', url: '/api/admin/uploads/999999' },
  { m: 'DELETE', url: '/api/items/999999' },
];

function item() { return db.prepare("SELECT id FROM items WHERE slug = 'rbac-item'").get(); }
/** Test titles are built before `before()` runs, so show the template, not the id. */
function label(route) { return typeof route.url === 'function' ? route.url.toString().replace(/^.*?`|`.*$/gs, '').replace(/\$\{[^}]+\}/g, ':id') : route.url; }

async function call(route, role) {
  const url = typeof route.url === 'function' ? route.url() : route.url;
  return app.inject({ method: route.m, url, headers: auth(role), ...(route.body ? { payload: route.body } : {}) });
}

describe('rbac: unauthenticated callers get 401 on every staff route', () => {
  for (const route of [...EDITOR_ALLOWED, ...ADMIN_ONLY]) {
    it(`${route.m} ${label(route)}`, async () => {
      expect(await call(route, null), 401, 'anonymous');
    });
  }
});

describe('rbac: viewer is refused (403) on every staff route', () => {
  for (const route of [...EDITOR_ALLOWED, ...ADMIN_ONLY]) {
    it(`${route.m} ${label(route)}`, async () => {
      expect(await call(route, 'viewer'), 403, 'viewer');
    });
  }
});

describe('rbac: editor passes the content routes', () => {
  for (const route of EDITOR_ALLOWED) {
    it(`${route.m} ${label(route)}`, async () => {
      const res = await call(route, 'editor');
      assert.ok(res.statusCode !== 401 && res.statusCode !== 403,
        `editor blocked: ${res.statusCode} ${res.body.slice(0, 120)}`);
    });
  }

  it('can create a file page', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/items', headers: auth('editor'),
      payload: { name: 'Editor Created', description: 'made by editor', file_type: 'zip' },
    });
    assert.ok(res.statusCode < 300, res.body);
  });

  it('sees drafts like an admin does', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items/rbac-draft', headers: auth('editor') });
    expect(res, 200, 'editor draft view');
    const viewer = await app.inject({ method: 'GET', url: '/api/items/rbac-draft', headers: auth('viewer') });
    expect(viewer, 404, 'viewer draft view');
  });
});

describe('rbac: editor is refused (403) on admin-only routes', () => {
  for (const route of ADMIN_ONLY) {
    it(`${route.m} ${label(route)}`, async () => {
      expect(await call(route, 'editor'), 403, 'editor');
    });
  }
});

describe('rbac: admin still passes everywhere', () => {
  for (const route of [...EDITOR_ALLOWED, ...ADMIN_ONLY]) {
    it(`${route.m} ${label(route)}`, async () => {
      const res = await call(route, 'admin');
      assert.ok(res.statusCode !== 401 && res.statusCode !== 403,
        `admin blocked: ${res.statusCode} ${res.body.slice(0, 120)}`);
    });
  }
});

describe('rbac: the editor allow-list matches real routes', () => {
  it('every entry in EDITOR_ROUTES is a registered route', () => {
    for (const key of EDITOR_ROUTES) {
      assert.ok(registered.has(key), `EDITOR_ROUTES lists ${key} but no such route exists`);
    }
  });
});
