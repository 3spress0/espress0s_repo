import { getDb } from '../db/index.js';
import { authenticate, requireAdmin, requireEditor } from '../middleware/auth.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService } from '../services/encryptionService.js';
import { monitoringService } from '../services/monitoringService.js';
import { getItemLinksForMany, serializeItem } from '../services/itemSerializer.js';
import { recordItemVersion, listVersions, getVersion, restoreItemVersion } from '../services/versionService.js';
import { makeSlug } from '../utils/slug.js';
import { isExternalUrl } from '../utils/validation.js';
import {
  searchCatalog, catalogFacets, catalogStats, ITEM_STATUSES,
} from '../services/catalogQueryService.js';
import { autofillFromUrl } from '../services/metadataAutofillService.js';
import { snapshotDatabase } from '../services/catalogService.js';
import { listSnapshots, restoreFromSnapshot } from '../services/restoreService.js';
import { UnsafeUrlError } from '../lib/safeFetch.js';
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

// backend/src/routes/admin.js -> ../../../ = repo root, matching where
// scripts/auto-update.sh drops its state file.
const AUTO_UPDATE_STATE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'data', '.auto-update-status');

/**
 * Query-string helpers. Values arrive as strings, or as arrays when a
 * parameter is repeated (?page=1&page=2) - both used to reach SQL as-is and
 * answer 500 (SQLITE_MISMATCH / "x.toLowerCase is not a function").
 */
const firstParam = (value) => (Array.isArray(value) ? value[0] : value);

const toInt = (value, fallback, min, max) => {
  const n = parseInt(firstParam(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * Routes under /api/admin that an `editor` may call. Everything else in this
 * plugin is admin-only. The list is explicit on purpose: a new route is
 * admin-only until someone decides otherwise.
 */
export const EDITOR_ROUTES = new Set([
  'GET /admin/items',
  'GET /admin/slug-check',
  'POST /admin/slugify',
  'POST /admin/items/:id/duplicate',
  'GET /admin/items/:id/versions',
  'GET /admin/items/:id/versions/:num',
  'GET /admin/items/:id/related',
  'POST /admin/items/:id/related',
  'DELETE /admin/items/:id/related/:relationId',
  'GET /admin/catalog/search',
  'GET /admin/catalog/facets',
  'GET /admin/catalog/stats',
  'POST /admin/metadata-autofill',
  'POST /admin/ai/describe',
  'POST /admin/ai/fill-gaps',
]);

export async function adminRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  // Per-route gate instead of one blanket requireAdmin: the editor allow-list
  // above gets requireEditor, the rest keeps requireAdmin. Attached in onRoute
  // so the OpenAPI generator can see the requirement on each route as well.
  fastify.addHook('onRoute', (route) => {
    const key = `${route.method} ${route.url.replace(/^\/api/, '')}`;
    const gate = EDITOR_ROUTES.has(key) ? requireEditor : requireAdmin;
    const existing = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [gate, ...existing];
  });

  // Auto-update status: what scripts/auto-update.sh last wrote to its state
  // file, plus where the checkout currently sits. Read-only - enabling or
  // running the updater always happens on the host (tmux/systemd).
  fastify.get('/admin/auto-update', async () => {
    let state = null;
    try {
      if (existsSync(AUTO_UPDATE_STATE)) state = JSON.parse(readFileSync(AUTO_UPDATE_STATE, 'utf8'));
    } catch { /* unreadable/corrupt state file -> state stays null */ }
    let branch = null, commit = null;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path.dirname(AUTO_UPDATE_STATE), timeout: 5000 }).toString().trim();
      commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(AUTO_UPDATE_STATE), timeout: 5000 }).toString().trim();
    } catch { /* git absent or not a repo */ }
    return { state, branch, commit };
  });

  fastify.get('/admin/overview', async (request, reply) => {
    const db = getDb();
    
    const totalItems = db.prepare('SELECT COUNT(*) as c FROM items').get().c;
    const published = db.prepare('SELECT COUNT(*) as c FROM items WHERE published = 1').get().c;
    const unpublished = db.prepare('SELECT COUNT(*) as c FROM items WHERE published = 0').get().c;
    const featured = db.prepare('SELECT COUNT(*) as c FROM items WHERE featured = 1').get().c;
    const totalSize = db.prepare('SELECT SUM(file_size) as s FROM items').get().s || 0;
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const adminUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
    const recent = db.prepare('SELECT id, name, slug, created_at, published FROM items ORDER BY created_at DESC LIMIT 10').all();
    const topDownloads = db.prepare('SELECT id, name, slug, download_count FROM items ORDER BY download_count DESC LIMIT 10').all();

    return {
      counts: { totalItems, published, unpublished, featured, totalSize, totalUsers, adminUsers },
      // Catalogue statistics: status spread, completeness gaps and link health,
      // so the dashboard says what needs attention rather than just how big the
      // archive is. Computed here rather than in the browser so one request
      // covers the page.
      catalog: catalogStats(),
      recent,
      topDownloads,
      storageProviders: storageManager.listProviders(),
      monitoring: {
        uptime: monitoringService.getSystemMetrics().uptime,
        requests: monitoringService.getRequestMetrics(),
      }
    };
  });

  fastify.post('/admin/reindex', async (request, reply) => {
    const db = getDb();
    try {
      db.exec(`INSERT INTO items_fts(items_fts) VALUES('rebuild');`);
      return { success: true, message: 'Search index rebuilt' };
    } catch (e) {
      db.exec(`DELETE FROM items_fts; INSERT INTO items_fts(rowid, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags)
               SELECT id, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags FROM items;`);
      return { success: true, message: 'Search index rebuilt (fallback)' };
    }
  });

  fastify.get('/admin/storage', async (request, reply) => {
    return { providers: storageManager.listProviders() };
  });

  fastify.post('/admin/validate-storage', async (request, reply) => {
    const { provider, path } = request.body;
    if (!provider || !path) return reply.code(400).send({ error: 'provider and path required' });
    try {
      const prov = storageManager.getProvider(provider);
      const valid = await prov.validatePath(path);
      const url = valid ? await prov.getDownloadUrl(path, { download_url: null }) : null;
      return { valid, url, provider };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  });

  fastify.get('/admin/items', async (request, reply) => {
    const { page = 1, limit = 50, q = '', published } = request.query;
    const db = getDb();

    // Query-string junk must never reach SQL. A non-numeric ?page=abc bound NaN
    // and answered 500 (SQLITE_MISMATCH), a repeated ?q=a&q=b arrived as an
    // array and threw on toLowerCase(), and ?limit=100000 pulled the whole
    // table into memory - the public /items route already clamped all of this.
    const pageNum = toInt(page, 1, 1, 10000);
    const pageSize = toInt(limit, 50, 1, 200);
    const searchTerm = String(firstParam(q) ?? '').slice(0, 200);
    const offset = (pageNum - 1) * pageSize;

    let where = '';
    const params = {};
    const conditions = [];

    if (searchTerm) {
      conditions.push('(LOWER(name) LIKE @q OR LOWER(slug) LIKE @q)');
      params.q = `%${searchTerm.toLowerCase()}%`;
    }

    if (published !== undefined) {
      conditions.push('published = @published');
      params.published = firstParam(published) === 'true' || firstParam(published) === '1' ? 1 : 0;
    }

    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as c FROM items ${where}`).get(params).c;
    const itemsRaw = db.prepare(`SELECT * FROM items ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({
      ...params,
      limit: pageSize,
      offset,
    });

    // Decrypt + attach download links / parse JSON columns, identical to the
    // public item shape. Without `download_links` here the admin editor could
    // not load existing mirrors and silently wiped them on save.
    const linksByItem = getItemLinksForMany(itemsRaw.map(i => i.id));
    const items = itemsRaw.map(item => serializeItem(item, linksByItem[item.id] || []));

    return {
      items,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  });

  // === FILE PAGE AUTHORING HELPERS ===
  //
  // These exist so the admin UI can create, copy and retire file pages without
  // hand-editing every field or firing one request per row.

  /**
   * GET /admin/slug-check?slug=foo&excludeId=3
   * Live availability check for the editor's URL field, plus a normalised
   * suggestion so the admin sees the real URL before saving.
   */
  fastify.get('/admin/slug-check', async (request, reply) => {
    const { slug = '', excludeId } = request.query;
    const normalised = makeSlug(String(slug));
    if (!normalised || normalised.length < 2) {
      return { slug: normalised, valid: false, available: false, reason: 'Slug must be at least 2 characters' };
    }

    const db = getDb();
    const clash = excludeId
      ? db.prepare('SELECT id, name FROM items WHERE slug = ? AND id != ?').get(normalised, excludeId)
      : db.prepare('SELECT id, name FROM items WHERE slug = ?').get(normalised);

    return {
      slug: normalised,
      valid: true,
      available: !clash,
      takenBy: clash ? { id: clash.id, name: clash.name } : null,
      url: `/file/${normalised}`,
    };
  });

  /**
   * POST /admin/items/:id/duplicate
   * Copies a page (including every mirror) as an unpublished draft, so a new
   * release or a sibling edition starts from a filled-in page instead of a
   * blank form. The copy is never published and never featured.
   */
  fastify.post('/admin/items/:id/duplicate', async (request, reply) => {
    const db = getDb();
    const source = db.prepare('SELECT * FROM items WHERE id = ?').get(request.params.id);
    if (!source) return reply.code(404).send({ error: 'Item not found' });

    const baseName = `${source.name} (copy)`;
    let name = baseName;
    let slug = makeSlug(baseName);
    let n = 2;
    while (db.prepare('SELECT id FROM items WHERE slug = ?').get(slug)) {
      name = `${source.name} (copy ${n})`;
      slug = makeSlug(name);
      n += 1;
      if (n > 50) return reply.code(409).send({ error: 'Too many copies of this item' });
    }

    const now = new Date().toISOString();
    const columns = Object.keys(source).filter(
      c => !['id', 'slug', 'name', 'created_at', 'updated_at', 'download_count', 'view_count'].includes(c)
    );
    const values = {};
    for (const c of columns) values[c] = source[c];

    const insertSql = `
      INSERT INTO items (name, slug, created_at, updated_at, download_count, view_count, ${columns.join(', ')})
      VALUES (@name, @slug, @created_at, @updated_at, 0, 0, ${columns.map(c => `@${c}`).join(', ')})
    `;

    const copyId = db.transaction(() => {
      const res = db.prepare(insertSql).run({ ...values, name, slug, created_at: now, updated_at: now });
      const newId = res.lastInsertRowid;
      // Drafts start unpublished/unfeatured whatever the source was.
      db.prepare('UPDATE items SET published = 0, featured = 0 WHERE id = ?').run(newId);

      const links = db.prepare('SELECT * FROM item_download_links WHERE item_id = ?').all(source.id);
      const insertLink = db.prepare(`
        INSERT INTO item_download_links
          (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
        VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
      `);
      links.forEach((l, i) => {
        insertLink.run({
          item_id: newId,
          label: l.label,
          storage_provider: l.storage_provider,
          storage_path: l.storage_path,
          download_url: l.download_url,
          file_size: l.file_size,
          is_primary: l.is_primary,
          is_down: l.is_down,
          down_reason: l.down_reason,
          status: l.status,
          sort_order: l.sort_order ?? i,
        });
      });

      return newId;
    })();

    recordItemVersion(copyId, request.user?.id, `Duplicated from "${source.name}" (#${source.id})`);

    const raw = db.prepare('SELECT * FROM items WHERE id = ?').get(copyId);
    return reply.code(201).send({ item: serializeItem(raw), message: `Duplicated as draft "${name}"` });
  });

  // === VERSION HISTORY ===
  //
  // Every create/edit/duplicate/restore snapshots the full page. Admin-only:
  // snapshots contain decrypted mirror URLs.

  /** GET /admin/items/:id/versions — newest first, without payloads. */
  fastify.get('/admin/items/:id/versions', async (request, reply) => {
    const db = getDb();
    const item = db.prepare('SELECT id, name, slug FROM items WHERE id = ?').get(request.params.id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    return { item, versions: listVersions(item.id) };
  });

  /** GET /admin/items/:id/versions/:num — one full snapshot, for previewing. */
  fastify.get('/admin/items/:id/versions/:num', async (request, reply) => {
    const num = Number(request.params.num);
    if (!Number.isInteger(num) || num < 1) return reply.code(400).send({ error: 'Invalid version number' });
    const version = getVersion(Number(request.params.id), num);
    if (!version || !version.snapshot) return reply.code(404).send({ error: 'Version not found' });
    return version;
  });

  /** POST /admin/items/:id/versions/:num/restore — roll the page back. */
  fastify.post('/admin/items/:id/versions/:num/restore', async (request, reply) => {
    const num = Number(request.params.num);
    if (!Number.isInteger(num) || num < 1) return reply.code(400).send({ error: 'Invalid version number' });
    try {
      const restored = restoreItemVersion(Number(request.params.id), num, request.user?.id);
      if (!restored) return reply.code(404).send({ error: 'Version or item not found' });
      request.log.info({ itemId: restored.id, version: num }, 'Item restored from version');
      return { item: restored, message: `Restored from version ${num}` };
    } catch (e) {
      // FK violations land here when a snapshot references a since-deleted folder/category.
      request.log.error(e, 'Restore failed');
      return reply.code(409).send({ error: `Could not restore version ${num}: ${e.message}` });
    }
  });

  /**
   * POST /admin/items/bulk  { action, ids: [], <field>? }
   * Publish / unpublish / feature / unfeature / archive / delete several pages
   * at once, or set one field (status, platform, architecture, version, tags,
   * category, folder, icon_url, banner_url) across all of them.
   *
   * The new value may arrive either under a generic `value` key or under a key
   * named after the action (`{ action: 'tags', tags: 'a, b' }`), which is how
   * the admin UI sends it. One transaction, so a bad id can't leave the list
   * half-changed.
   */
  fastify.post('/admin/items/bulk', async (request, reply) => {
    const body = request.body || {};
    const { action, ids, folderId, categoryId } = body;
    const value = body.value !== undefined ? body.value : body[action];

    // Field-setting actions: one column, one validated value, many rows.
    const FIELD_ACTIONS = {
      status: { column: 'status', kind: 'enum', values: ITEM_STATUSES },
      platform: { column: 'platform', kind: 'text', max: 50 },
      architecture: { column: 'architecture', kind: 'text', max: 50 },
      version: { column: 'version', kind: 'text', max: 100 },
      icon_url: { column: 'icon_url', kind: 'externalUrl' },
      banner_url: { column: 'banner_url', kind: 'externalUrl' },
    };
    const allowed = [
      'publish', 'unpublish', 'feature', 'unfeature', 'delete', 'folder',
      'archive', 'category', 'tags', ...Object.keys(FIELD_ACTIONS),
    ];
    if (!allowed.includes(action)) {
      return reply.code(400).send({ error: `action must be one of: ${allowed.join(', ')}` });
    }

    const cleanIds = Array.isArray(ids)
      ? [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    if (!cleanIds.length) return reply.code(400).send({ error: 'ids must be a non-empty array of item ids' });
    if (cleanIds.length > 500) return reply.code(400).send({ error: 'Too many items in one request (max 500)' });

    const db = getDb();
    const placeholders = cleanIds.map(() => '?').join(',');
    const now = new Date().toISOString();

    // --- validate the value before touching anything ------------------------
    let sql = null;
    let args = [];
    let summary = null;

    if (action === 'delete') {
      // No value to validate; handled below inside its own transaction.
    } else if (action === 'folder') {
      // Same shape as `category` below: an explicit null means "take it out of
      // its folder", a missing key is a caller bug, not a request to clear.
      const rawFolder = folderId !== undefined ? folderId : value;
      if (rawFolder === undefined) {
        return reply.code(400).send({ error: 'folder needs folderId (or value); send null to remove the folder' });
      }
      const fid = rawFolder === null || rawFolder === '' ? null : Number(rawFolder);
      if (fid !== null && (!Number.isInteger(fid) || fid <= 0)) {
        return reply.code(400).send({ error: 'folderId must be a positive integer or null' });
      }
      let folderName = null;
      if (fid !== null) {
        const folder = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(fid);
        if (!folder) return reply.code(404).send({ error: 'Folder not found' });
        folderName = folder.name;
      }
      sql = `UPDATE items SET folder_id = ?, updated_at = ? WHERE id IN (${placeholders})`;
      args = [fid, now];
      summary = { folder: folderName };
    } else if (action === 'category') {
      // `value` is the generic key the admin UI sends for every field action;
      // `categoryId` is the explicit one. Accepting only categoryId meant a
      // request carrying `value` fell through to "null" and silently *cleared*
      // the category on every selected page while reporting success.
      const rawCategory = categoryId !== undefined ? categoryId : value;
      // Naming the action without a value used to fall through to NULL and
      // silently strip the category from every selected page while reporting
      // success. Clearing is a deliberate act: ask for it with null.
      if (rawCategory === undefined) {
        return reply.code(400).send({ error: 'category needs categoryId (or value); send null to clear the category' });
      }
      const cid = rawCategory === null || rawCategory === '' ? null : Number(rawCategory);
      if (cid !== null && (!Number.isInteger(cid) || cid <= 0)) {
        return reply.code(400).send({ error: 'categoryId must be a positive integer or null' });
      }
      let categoryName = null;
      if (cid !== null) {
        const category = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(cid);
        if (!category) return reply.code(404).send({ error: 'Category not found' });
        categoryName = category.name;
      }
      sql = `UPDATE items SET category_id = ?, updated_at = ? WHERE id IN (${placeholders})`;
      args = [cid, now];
      summary = { category: categoryName };
    } else if (action === 'tags') {
      if (value === undefined || value === null || value === '') {
        return reply.code(400).send({ error: 'tags is required (an array of strings or a comma-separated string)' });
      }
      const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : null);
      if (!list) return reply.code(400).send({ error: 'tags must be an array of strings or a comma-separated string' });
      const tags = [...new Set(list.map(t => String(t).trim()).filter(Boolean))].slice(0, 100);
      if (tags.some(t => t.length > 100)) return reply.code(400).send({ error: 'Each tag must be 100 characters or fewer' });
      sql = `UPDATE items SET tags = ?, updated_at = ? WHERE id IN (${placeholders})`;
      args = [JSON.stringify(tags), now];
      summary = { tags };
    } else if (action === 'archive') {
      sql = `UPDATE items SET status = 'archived', published = 0, updated_at = ? WHERE id IN (${placeholders})`;
      args = [now];
      summary = { status: 'archived', published: false };
    } else if (FIELD_ACTIONS[action]) {
      const spec = FIELD_ACTIONS[action];
      // Refuse a missing value outright. Treating it as null would blank the
      // column across every selected row while still reporting success.
      if (value === undefined || value === null || value === '') {
        return reply.code(400).send({ error: `${action} is required` });
      }
      const raw = value;

      if (spec.kind === 'enum') {
        if (raw === null || !spec.values.includes(raw)) {
          return reply.code(400).send({ error: `${action} must be one of: ${spec.values.join(', ')}` });
        }
      } else if (spec.kind === 'text') {
        if (raw !== null && (typeof raw !== 'string' || raw.length > spec.max)) {
          return reply.code(400).send({ error: `${action} must be a string of at most ${spec.max} characters` });
        }
      } else if (spec.kind === 'externalUrl') {
        // Catalogue rule: images are external URLs, never local uploads.
        if (raw !== null && !isExternalUrl(raw)) {
          return reply.code(400).send({ error: `${action} must be an external http(s) URL - images are never stored locally` });
        }
      }
      sql = `UPDATE items SET ${spec.column} = ?, updated_at = ? WHERE id IN (${placeholders})`;
      args = [raw, now];
      summary = { [action]: raw };
    } else {
      const flags = { publish: ['published', 1], unpublish: ['published', 0], feature: ['featured', 1], unfeature: ['featured', 0] };
      const [column, flagValue] = flags[action];
      sql = `UPDATE items SET ${column} = ?, updated_at = ? WHERE id IN (${placeholders})`;
      args = [flagValue, now];
      summary = { [column]: !!flagValue };
    }

    // --- snapshot first ----------------------------------------------------
    // Deleting or rewriting rows across many pages is not something an admin
    // can undo by hand, so take a database snapshot before touching anything
    // and hand the path back with the response. Publish/unpublish/feature are
    // one click to reverse, so they do not pay for a snapshot. `?backup=0`
    // opts out; CATALOG_BACKUP=false disables snapshots entirely.
    const DESTRUCTIVE = ['delete', 'archive'];
    const wantsBackup = String(request.query?.backup ?? '1') !== '0';
    const shouldBackup = wantsBackup && (DESTRUCTIVE.includes(action) || !!FIELD_ACTIONS[action] || action === 'tags' || action === 'category' || action === 'folder');
    let backupPath = null;
    if (shouldBackup) {
      try {
        backupPath = await snapshotDatabase(`pre-bulk-${action}`);
      } catch (e) {
        // A snapshot we cannot take is a change we should not make: without it
        // there is nothing to roll back to.
        request.log.error(e, 'Backup before bulk change failed');
        return reply.code(500).send({
          error: 'Could not take a backup before this change, so it was not applied',
          detail: e.message,
        });
      }
    }

    // --- apply in one transaction ------------------------------------------
    let affected = 0;
    try {
      affected = db.transaction(() => {
        if (action === 'delete') {
          return db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...cleanIds).changes;
        }
        const changed = db.prepare(sql).run(...args, ...cleanIds).changes;
        // Keep the tag junction in step with the JSON column, or the tag facets
        // and tag filters would drift away from what the rows actually say.
        if (action === 'tags') {
          const tags = summary.tags;
          const ensureTag = db.prepare('INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)');
          const tagId = db.prepare('SELECT id FROM tags WHERE slug = ?');
          const link = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)');
          const unlink = db.prepare('DELETE FROM item_tags WHERE item_id = ?');
          const idsOfTags = tags.map((name) => {
            ensureTag.run(name, makeSlug(name) || name.toLowerCase());
            return tagId.get(makeSlug(name) || name.toLowerCase())?.id;
          }).filter(Boolean);
          for (const itemId of cleanIds) {
            unlink.run(itemId);
            for (const tid of idsOfTags) link.run(itemId, tid);
          }
        }
        return changed;
      })();
    } catch (e) {
      request.log.error(e, 'Bulk action failed');
      return reply.code(500).send({ error: `Bulk action failed, nothing was changed: ${e.message}` });
    }

    // The snapshot path travels with the response so the UI can offer an undo
    // straight away, and so the admin can find the file if they close the tab.
    return { success: true, action, affected, ids: cleanIds, backupPath, ...(summary || {}) };
  });

  // --- snapshots and rollback ---------------------------------------------

  /** GET /admin/snapshots - database snapshots taken before risky changes. */
  fastify.get('/admin/snapshots', async () => listSnapshots());

  /**
   * POST /admin/snapshots/restore  { path, scope?, dryRun? }
   * Roll the catalogue (or everything) back to a snapshot. The copy runs in one
   * transaction, so a failure leaves the database untouched. Send dryRun to see
   * the row counts without writing.
   */
  fastify.post('/admin/snapshots/restore', async (request, reply) => {
    const { path: snapshotPath, scope = 'catalogue', dryRun = false } = request.body || {};
    if (scope !== 'catalogue' && scope !== 'all') {
      return reply.code(400).send({ error: "scope must be 'catalogue' or 'all'" });
    }
    try {
      const result = restoreFromSnapshot(snapshotPath, { scope, dryRun: !!dryRun });
      request.log.warn({ snapshot: result.path, scope, dryRun: result.dryRun, restored: result.restored },
        'Database rolled back to a snapshot');
      return result;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * GET /admin/catalog/search - FTS5 search plus the admin-only filter set.
   * Every filter is a bound parameter; sort is allow-listed in the service.
   */
  fastify.get('/admin/catalog/search', async (request, reply) => {
    try {
      return searchCatalog(request.query);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // GET /admin/catalog/facets - distinct values for the filter dropdowns
  fastify.get('/admin/catalog/facets', async () => {
    return catalogFacets();
  });

  // GET /admin/catalog/stats - dashboard numbers
  fastify.get('/admin/catalog/stats', async () => {
    return catalogStats();
  });

  /**
   * POST /admin/slugify - the same slug the server would generate, plus a
   * collision-free suggestion, so the editor can show the slug before save.
   */
  fastify.post('/admin/slugify', async (request, reply) => {
    const text = String(request.body?.text ?? '').slice(0, 300);
    if (!text.trim()) return reply.code(400).send({ error: 'text is required' });

    const db = getDb();
    const excludeId = Number(request.body?.excludeId) || null;
    const base = makeSlug(text);
    if (!base) return reply.code(400).send({ error: 'That text has no usable slug characters' });

    const taken = (slug) => db.prepare(
      excludeId ? 'SELECT id FROM items WHERE slug = ? AND id != ?' : 'SELECT id FROM items WHERE slug = ?'
    ).get(...(excludeId ? [slug, excludeId] : [slug]));

    let slug = base;
    let suffix = 2;
    while (taken(slug) && suffix <= 999) slug = `${base}-${suffix++}`;

    return { slug, base, available: slug === base && !taken(base), alternatives: slug !== base ? [slug] : [] };
  });

  /**
   * POST /admin/metadata-autofill - suggest fields from a public software URL.
   * Fetched through the SSRF-hardened client; nothing is written.
   */
  fastify.post('/admin/metadata-autofill', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const url = String(request.body?.url ?? '').slice(0, 2000);
    if (!url) return reply.code(400).send({ error: 'url is required' });
    try {
      const result = await autofillFromUrl(url);
      return result;
    } catch (e) {
      if (e instanceof UnsafeUrlError) return reply.code(400).send({ error: e.message, code: 'UNSAFE_URL' });
      request.log.warn({ err: e.message }, 'Metadata autofill failed');
      return reply.code(422).send({ error: `Could not read that URL: ${e.message}`.slice(0, 300) });
    }
  });

  // --- related versions / items --------------------------------------------
  fastify.get('/admin/items/:id/related', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid item id' });
    const db = getDb();
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Item not found' });
    const relations = db.prepare(`
      SELECT r.id, r.relation, r.note, r.created_at,
             i.id AS item_id, i.name, i.slug, i.version, i.status, i.platform, i.architecture
      FROM item_relations r JOIN items i ON i.id = r.related_item_id
      WHERE r.item_id = ? ORDER BY r.sort_order, r.id
    `).all(id);
    return { relations };
  });

  fastify.post('/admin/items/:id/related', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Invalid item id' });
    const { relatedSlug, relatedId, relation = 'related', note } = request.body || {};
    const db = getDb();
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Item not found' });

    let targetId = Number(relatedId) || null;
    if (!targetId && relatedSlug) {
      const row = db.prepare('SELECT id FROM items WHERE slug = ?').get(String(relatedSlug));
      if (!row) return reply.code(404).send({ error: `No item with slug "${relatedSlug}"` });
      targetId = row.id;
    }
    if (!targetId) return reply.code(400).send({ error: 'relatedId or relatedSlug is required' });
    if (targetId === id) return reply.code(400).send({ error: 'An item cannot be related to itself' });
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(targetId)) return reply.code(404).send({ error: 'Related item not found' });

    const allowedRelations = ['related', 'supersedes', 'superseded-by', 'variant'];
    if (!allowedRelations.includes(relation)) {
      return reply.code(400).send({ error: `relation must be one of: ${allowedRelations.join(', ')}` });
    }

    const result = db.prepare(`
      INSERT INTO item_relations (item_id, related_item_id, relation, note, sort_order)
      VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM item_relations WHERE item_id = ?), 0))
      ON CONFLICT(item_id, related_item_id) DO UPDATE SET relation = excluded.relation, note = excluded.note
    `).run(id, targetId, relation, note ? String(note).slice(0, 500) : null, id);

    // ON CONFLICT leaves lastInsertRowid at 0, so fall back to a lookup.
    const saved = db.prepare('SELECT * FROM item_relations WHERE id = ?').get(result.lastInsertRowid)
      || db.prepare('SELECT * FROM item_relations WHERE item_id = ? AND related_item_id = ?').get(id, targetId);
    return reply.code(201).send({ relation: saved });
  });

  fastify.delete('/admin/items/:id/related/:relationId', async (request, reply) => {
    const id = Number(request.params.id);
    const relationId = Number(request.params.relationId);
    const db = getDb();
    const result = db.prepare('DELETE FROM item_relations WHERE id = ? AND item_id = ?').run(relationId, id);
    if (!result.changes) return reply.code(404).send({ error: 'Relation not found' });
    return { success: true };
  });

  /**
   * POST /admin/ai/describe
   * Drafts the page copy (summary + markdown body) from whatever metadata the
   * admin has filled in. Admin-only: it spends the operator's API quota (and,
   * on the tgpt backend, spawns a subprocess), so it must not be reachable by
   * visitors.
   */
  fastify.post('/admin/ai/describe', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const body = request.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      return reply.code(400).send({ error: 'Enter a name first — the draft is generated from it' });
    }

    try {
      const { aiService } = await import('../services/aiService.js');
      const draft = await aiService.describeItem(body);
      return draft;
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'Could not generate a draft', message: e.message });
    }
  });

  /**
   * POST /admin/ai/fill-gaps
   * Look at the metadata the admin has entered so far and suggest values for
   * the fields that are still empty (version, platform, architecture, file
   * type, license, tags, and both description fields). Admin-only for the same
   * reason as /describe: it spends the operator's AI budget.
   *
   * The response is a map of field -> suggested value; the client applies only
   * the ones the admin keeps and never overwrites a field already filled in.
   */
  fastify.post('/admin/ai/fill-gaps', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const body = request.body || {};
    if (!body.name || String(body.name).trim().length < 2) {
      return reply.code(400).send({ error: 'Enter a name first — the suggestions are generated from it' });
    }

    const want = Array.isArray(body.fields) ? body.fields : null;

    try {
      const { aiService } = await import('../services/aiService.js');
      return await aiService.suggestFields(body, want);
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'Could not generate suggestions', message: e.message });
    }
  });

  fastify.get('/admin/backup-info', async (request, reply) => {
    const db = getDb();
    const info = {
      dbPath: db.name,
      itemCount: db.prepare('SELECT COUNT(*) as c FROM items').get().c,
      categoryCount: db.prepare('SELECT COUNT(*) as c FROM categories').get().c,
      faqCount: db.prepare('SELECT COUNT(*) as c FROM faq_entries').get().c,
      userCount: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      timestamp: new Date().toISOString(),
    };
    return info;
  });

  // === USER MANAGEMENT ===
  fastify.get('/admin/users', async (request, reply) => {
    const { page = 1, limit = 50, q = '', role } = request.query;
    const db = getDb();
    // Same coercion as /admin/items: junk in the query string must not reach SQL.
    const pageNum = toInt(page, 1, 1, 10000);
    const pageSize = toInt(limit, 50, 1, 200);
    const searchTerm = String(firstParam(q) ?? '').slice(0, 200);
    const offset = (pageNum - 1) * pageSize;

    let where = '';
    const params = {};
    const conditions = [];

    if (searchTerm) {
      conditions.push('(LOWER(username) LIKE @q OR LOWER(email) LIKE @q)');
      params.q = `%${searchTerm.toLowerCase()}%`;
    }

    if (role) {
      conditions.push('role = @role');
      params.role = String(firstParam(role)).slice(0, 30);
    }

    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(params).c;
    const usersRaw = db.prepare(`SELECT id, username, email, email_hash, role, totp_enabled AS mfa_enabled, encryption_version, created_at, updated_at FROM users ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({
      ...params,
      limit: pageSize,
      offset,
    });

    // Decrypt emails for admin
    const users = usersRaw.map(u => {
      let decryptedEmail = u.email;
      try {
        decryptedEmail = encryptionService.decrypt(u.email);
      } catch {}
      return {
        ...u,
        email: decryptedEmail,
        email_encrypted: u.email,
        isEncrypted: u.email && u.email.startsWith('enc_v1:'),
        isPeppered: u.email_hash ? true : false,
      };
    });

    return {
      users,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      }
    };
  });

  fastify.get('/admin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const userRaw = db.prepare('SELECT id, username, email, email_hash, role, totp_enabled AS mfa_enabled, encryption_version, created_at, updated_at FROM users WHERE id = ?').get(id);
    if (!userRaw) return reply.code(404).send({ error: 'User not found' });

    let decryptedEmail = userRaw.email;
    try { decryptedEmail = encryptionService.decrypt(userRaw.email); } catch {}

    return {
      ...userRaw,
      email: decryptedEmail,
      email_encrypted: userRaw.email,
      isEncrypted: userRaw.email && userRaw.email.startsWith('enc_v1:'),
    };
  });

  fastify.put('/admin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const { role, username, email } = request.body;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'User not found' });

    // Prevent self-demotion of last admin
    if (existing.id === request.user.id && role && role !== 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: 'Cannot demote last admin' });
      }
    }

    const updates = [];
    const params = { id };

    if (role) {
      if (!['admin', 'editor', 'viewer'].includes(role)) {
        return reply.code(400).send({ error: 'Invalid role' });
      }
      updates.push('role = @role');
      params.role = role;
    }

    if (username) {
      if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
        return reply.code(400).send({ error: 'Invalid username format' });
      }
      const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
      if (dup) return reply.code(409).send({ error: 'Username exists' });
      updates.push('username = @username');
      params.username = username;
    }

    if (email) {
      const emailHash = encryptionService.hashEmail(email);
      const dup = db.prepare('SELECT id FROM users WHERE email_hash = ? AND id != ?').get(emailHash, id);
      if (dup) return reply.code(409).send({ error: 'Email exists' });
      
      const encryptedEmail = encryptionService.encrypt(email);
      updates.push('email = @email');
      updates.push('email_hash = @email_hash');
      params.email = encryptedEmail;
      params.email_hash = emailHash;
    }

    if (updates.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    updates.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = @id`).run(params);

    const updatedRaw = db.prepare('SELECT id, username, email, role, encryption_version, created_at, updated_at FROM users WHERE id = ?').get(id);
    let decEmail = updatedRaw.email;
    try { decEmail = encryptionService.decrypt(updatedRaw.email); } catch {}

    return { ...updatedRaw, email: decEmail };
  });

  fastify.delete('/admin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'User not found' });

    if (existing.id === request.user.id) {
      return reply.code(400).send({ error: 'Cannot delete yourself' });
    }

    if (existing.role === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: 'Cannot delete last admin' });
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { success: true, message: 'User deleted' };
  });

  fastify.post('/admin/users', async (request, reply) => {
    const { username, email, password, role = 'viewer' } = request.body;

    if (!username || !email || !password) {
      return reply.code(400).send({ error: 'username, email, password required' });
    }

    if (!['admin', 'editor', 'viewer'].includes(role)) {
      return reply.code(400).send({ error: 'Invalid role' });
    }

    const db = getDb();

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return reply.code(409).send({ error: 'Username exists' });

    const emailHash = encryptionService.hashEmail(email);
    const existingEmail = db.prepare('SELECT id FROM users WHERE email_hash = ?').get(emailHash);
    if (existingEmail) return reply.code(409).send({ error: 'Email exists' });

    const encryptedEmail = encryptionService.encrypt(email);
    const hash = await encryptionService.hashPasswordWithPepper(password);

    const result = db.prepare(`
      INSERT INTO users (username, email, email_hash, password_hash, role, encryption_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, encryptedEmail, emailHash, hash, role, 'v1');

    const newUser = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);
    let decEmail = newUser.email;
    try { decEmail = encryptionService.decrypt(newUser.email); } catch {}

    return reply.code(201).send({ ...newUser, email: decEmail });
  });
}
