import { getDb } from '../db/index.js';
import { makeSlug, formatBytes } from '../utils/slug.js';
import { itemSchema, downloadLinkSchema } from '../utils/validation.js';
import { parseRequirements } from '../utils/requirements.js';
import { authenticate, optionalAuthenticate, requireAdmin, requireEditor, roleAtLeast } from '../middleware/auth.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService, ENCRYPTED_ITEM_FIELDS } from '../services/encryptionService.js';
import { recordItemVersion } from '../services/versionService.js';
import { emitEvent, itemSummary } from '../services/eventBus.js';
import { getFavorite, countItemFavorites, getPublicFavoritedBy } from '../services/favoritesService.js';
import { createPreviewToken, verifyPreviewToken, DEFAULT_TTL_HOURS } from '../services/previewLinkService.js';
import { ratingSummary } from '../services/reviewService.js';

function decryptItem(item) {
  if (!item) return item;
  const decrypted = { ...item };
  for (const field of ENCRYPTED_ITEM_FIELDS) {
    if (decrypted[field]) {
      try {
        decrypted[field] = encryptionService.decrypt(decrypted[field]);
      } catch {}
    }
  }
  return decrypted;
}

/** Only admins may see unpublished (draft) items or their mirrors. */
function isAdmin(request) {
  // Staff (editor or admin) may see drafts; the name is kept for the call sites.
  return roleAtLeast(request.user?.role, 'editor');
}

/**
 * Validate the `download_links` array of a create or update body.
 *
 * Every link has to be usable. The old code skipped the ones that failed
 * validation, so one typo in one mirror's URL silently deleted that mirror
 * the next time the page was saved - the save reported success and the mirror
 * was simply gone.
 *
 * `{ links: null }` means "not part of this request", which is different from
 * `{ links: [] }`, meaning "this page should have no mirrors".
 */
function parseDownloadLinks(raw) {
  if (raw === undefined) return { links: null };
  if (!Array.isArray(raw)) {
    return { errors: [{ index: 0, message: 'download_links must be an array' }] };
  }
  const links = [];
  const errors = [];
  raw.forEach((entry, index) => {
    const parsed = downloadLinkSchema.safeParse(entry);
    if (parsed.success) {
      links.push(parsed.data);
      return;
    }
    errors.push({
      index,
      label: typeof entry?.label === 'string' ? entry.label : null,
      issues: parsed.error.issues.map(i => `${i.path?.join('.') || 'value'}: ${i.message}`),
    });
  });
  return errors.length ? { errors } : { links };
}

/** Bind parameters for one mirror row, encrypting the fields at rest. */
function linkRow(itemId, link, fallbackSort) {
  const enc = encryptLinkFields({
    storage_path: link.storage_path || null,
    download_url: link.download_url || null,
    down_reason: link.down_reason || null,
  });
  return {
    item_id: itemId,
    label: link.label,
    storage_provider: link.storage_provider,
    storage_path: enc.storage_path,
    download_url: enc.download_url,
    file_size: link.file_size || null,
    is_primary: link.is_primary ? 1 : 0,
    is_down: link.is_down ? 1 : 0,
    down_reason: enc.down_reason,
    status: link.status || (link.is_down ? 'down' : 'up'),
    sort_order: link.sort_order !== undefined ? link.sort_order : fallbackSort,
  };
}

const INSERT_LINK_SQL = `
  INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url,
                                   file_size, is_primary, is_down, down_reason, status, sort_order)
  VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url,
          @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
`;

// Everything a save is allowed to change. download_count, the health-check
// columns, created_at and the row id are deliberately absent: they are the
// mirror's history, not its definition.
const UPDATE_LINK_SQL = `
  UPDATE item_download_links
     SET label = @label, storage_provider = @storage_provider, storage_path = @storage_path,
         download_url = @download_url, file_size = @file_size, is_primary = @is_primary,
         is_down = @is_down, down_reason = @down_reason, status = @status,
         sort_order = @sort_order, updated_at = CURRENT_TIMESTAMP
   WHERE id = @id AND item_id = @item_id
`;

/**
 * Apply a wanted set of mirrors to an item, in place.
 *
 * Deleting every row and re-inserting them - what this used to do - reset each
 * mirror's `download_count` to 0 and threw away `status`, `last_checked`,
 * `http_status` and `check_error`, so saving a page from the admin editor
 * quietly destroyed its link-health history and its download numbers. Rows the
 * client knows about are updated; the rest are inserted; the ones missing from
 * the payload were removed by the admin and are deleted.
 */
function syncDownloadLinks(db, itemId, wanted) {
  const existingIds = db
    .prepare('SELECT id FROM item_download_links WHERE item_id = ? ORDER BY sort_order, id')
    .all(itemId)
    .map(r => Number(r.id));

  const insert = db.prepare(INSERT_LINK_SQL);
  const update = db.prepare(UPDATE_LINK_SQL);
  const kept = new Set();

  wanted.forEach((link, index) => {
    const row = linkRow(itemId, link, index);
    const linkId = Number(link.id);
    if (linkId && existingIds.includes(linkId)) {
      update.run({ ...row, id: linkId });
      kept.add(linkId);
    } else {
      kept.add(Number(insert.run(row).lastInsertRowid));
    }
  });

  const stale = existingIds.filter(rid => !kept.has(rid));
  if (stale.length) {
    db.prepare(
      `DELETE FROM item_download_links WHERE item_id = ? AND id IN (${stale.map(() => '?').join(',')})`
    ).run(itemId, ...stale);
  }
}

/**
 * Outbound download URLs come from the database. Refuse to hand a
 * `javascript:`/`data:` URL back to the browser or put one in a Location
 * header, whatever an admin (or an imported feed) may have stored.
 */
function isSafeRedirectUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/')) return !url.startsWith('//');
  return /^https?:\/\//i.test(url);
}

function encryptItemFields(data) {
  const encrypted = { ...data };
  for (const field of ENCRYPTED_ITEM_FIELDS) {
    if (encrypted[field]) {
      encrypted[field] = encryptionService.encrypt(encrypted[field]);
    }
  }
  return encrypted;
}

function decryptLink(link) {
  if (!link) return link;
  const dec = { ...link };
  try { if (dec.storage_path) dec.storage_path = encryptionService.decrypt(dec.storage_path); } catch {}
  try { if (dec.download_url) dec.download_url = encryptionService.decrypt(dec.download_url); } catch {}
  try { if (dec.down_reason) dec.down_reason = encryptionService.decrypt(dec.down_reason); } catch {}
  return dec;
}

function encryptLinkFields(data) {
  const enc = { ...data };
  if (enc.storage_path) enc.storage_path = encryptionService.encrypt(enc.storage_path);
  if (enc.download_url) enc.download_url = encryptionService.encrypt(enc.download_url);
  if (enc.down_reason) enc.down_reason = encryptionService.encrypt(enc.down_reason);
  return enc;
}

function getItemLinks(itemId, includeDown = false) {
  const db = getDb();
  let query = `
    SELECT * FROM item_download_links 
    WHERE item_id = ? 
  `;
  if (!includeDown) {
    // For public, we still return down links but marked, so frontend can show status
    // For download, we will block down links
  }
  query += ` ORDER BY is_primary DESC, sort_order ASC, created_at ASC`;
  const linksRaw = db.prepare(query).all(itemId);
  return linksRaw.map(decryptLink);
}

function getAvailableLinks(itemId) {
  const db = getDb();
  const linksRaw = db.prepare(`
    SELECT * FROM item_download_links 
    WHERE item_id = ? AND is_down = 0 AND status != 'down'
    ORDER BY is_primary DESC, sort_order ASC, created_at ASC
  `).all(itemId);
  return linksRaw.map(decryptLink);
}

export async function itemsRoutes(fastify) {
  // GET /api/items - list with filters (public, but shows down status)
  fastify.get('/items', { preHandler: [optionalAuthenticate] }, async (request, reply) => {
    const {
      q, category, folder, tag, license_status, file_type, platform, architecture,
      sort = 'date', order = 'desc', page = 1, limit = 20, featured, published = 1,
    } = request.query;

    const db = getDb();
    const { searchService, MAX_QUERY_LENGTH } = await import('../services/searchService.js');

    // `?published=0` used to expose every draft - decrypted download URLs
    // included - to anonymous callers. Only admins may ask for anything other
    // than the published set.
    const requestedPublished = published !== undefined
      ? (published === 'true' || published === '1' || published === 1 ? 1 : 0)
      : 1;
    const effectivePublished = isAdmin(request) ? requestedPublished : 1;

    const toInt = (value, fallback, min, max) => {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    };

    const result = searchService.search({
      q: String(q ?? '').slice(0, MAX_QUERY_LENGTH),
      category: category || null, folder: folder || null,
      tag: tag ? String(tag).slice(0, 64) : null, license_status: license_status || null,
      file_type: file_type || null,
      platform: platform || null, architecture: architecture || null,
      sort, order,
      page: toInt(page, 1, 1, 10000),
      limit: toInt(limit, 20, 1, 100),
      featured: featured !== undefined ? (featured === 'true' || featured === '1' ? 1 : 0) : null,
      published: effectivePublished,
    });

    return {
      items: result.results.map(item => {
        const dec = decryptItem(item);
        const links = getItemLinks(dec.id);
        const availableLinks = links.filter(l => !l.is_down && l.status !== 'down');
        return {
          ...dec,
          file_size_formatted: formatBytes(dec.file_size),
          tags: dec.tags ? JSON.parse(dec.tags || '[]') : [],
          screenshots: dec.screenshots ? JSON.parse(dec.screenshots || '[]') : [],
          requirements: parseRequirements(dec.requirements),
          download_links: links,
          available_links: availableLinks,
          download_links_count: links.length,
          available_links_count: availableLinks.length,
          has_multiple_mirrors: links.length > 1,
          has_down_mirrors: links.some(l => l.is_down),
        };
      }),
      pagination: {
        page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages,
      }
    };
  });

  // GET /api/items/:slug - single item with unlimited links
  fastify.get('/items/:slug', { preHandler: [optionalAuthenticate] }, async (request, reply) => {
    const { slug } = request.params;
    const db = getDb();

    const item = db.prepare(`
      SELECT items.*, categories.name as category_name, categories.slug as category_slug, categories.color as category_color,
             folders.name as folder_name, folders.slug as folder_slug, folders.color as folder_color, folders.icon as folder_icon
      FROM items
      LEFT JOIN categories ON items.category_id = categories.id
      LEFT JOIN folders ON items.folder_id = folders.id
      WHERE items.slug = ? OR items.id = ?
    `).get(slug, slug);

    if (!item) return reply.code(404).send({ error: 'Item not found' });

    // Drafts are invisible to everyone but admins - 404, not 403, so the
    // endpoint does not confirm that a hidden slug exists. A signed preview
    // token (see previewLinkService) opens one draft to whoever holds it.
    const previewing = !item.published && !isAdmin(request) && verifyPreviewToken(item.id, request.query?.preview);
    if (!item.published && !isAdmin(request) && !previewing) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    // Admin previews of a draft should not inflate public view counts.
    if (item.published) {
      db.prepare('UPDATE items SET view_count = view_count + 1 WHERE id = ?').run(item.id);
    }

    const related = db.prepare(`
      SELECT id, name, slug, description, version, file_type, platform, architecture, icon_url, image_url
      FROM items WHERE category_id = ? AND id != ? AND published = 1
      ORDER BY created_at DESC LIMIT 6
    `).all(item.category_id, item.id);

    const decrypted = decryptItem(item);
    let links = getItemLinks(item.id);
    if (previewing) {
      // Content review only: no URLs or paths leave the server on a preview.
      for (const f of ['storage_path', 'download_url', 'external_url', 'license_notes']) decrypted[f] = null;
      links = links.map(l => ({ ...l, storage_path: null, download_url: null }));
    }
    const availableLinks = links.filter(l => !l.is_down && l.status !== 'down');

    // Favourite state for the signed-in viewer. Anonymous visitors get false
    // rather than an error, so the star can render as "not starred" instead of
    // the page having to branch on auth before it knows what to draw.
    const ownFavorite = request.user ? getFavorite(request.user.id, item.id) : null;

    return {
      ...decrypted,
      file_size_formatted: formatBytes(decrypted.file_size),
      tags: decrypted.tags ? JSON.parse(decrypted.tags || '[]') : [],
      screenshots: decrypted.screenshots ? JSON.parse(decrypted.screenshots || '[]') : [],
      requirements: parseRequirements(decrypted.requirements),
      related: related.map(r => decryptItem(r)),
      download_links: links,
      available_links: availableLinks,
      download_links_count: links.length,
      available_links_count: availableLinks.length,
      has_multiple_mirrors: links.length > 1,
      has_down_mirrors: links.some(l => l.is_down),
      // How many accounts starred this file, and whether this visitor is one
      // of them. The count is public; `favorite_is_public` is the viewer's own
      // row, so it only ever describes their own choice.
      favorites_count: countItemFavorites(item.id),
      // Only the accounts that made their star public, so this row is a set of
      // links to profiles people chose to publish - not a list of everyone.
      shared_by: getPublicFavoritedBy(item.id),
      is_favorite: Boolean(ownFavorite),
      favorite_is_public: Boolean(ownFavorite?.favorite?.is_public),
      // Star rating aggregate over visible reviews (see routes/reviews.js).
      rating: ratingSummary(item.id),
      preview: previewing || undefined,
      primary_download: availableLinks.find(l => l.is_primary) || availableLinks[0] || links.find(l => l.is_primary) || links[0] || null,
      encryption: { atRest: 'storage_path, download_url, external_url, license_notes encrypted', version: item.encryption_version || 'v1' }
    };
  });

  // POST /api/items - create (admin)
  fastify.post('/items', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const links = parseDownloadLinks(request.body.download_links);
    if (links.errors) {
      // Refuse rather than drop: a page saved without the mirror it was
      // supposed to have is worse than a save that fails.
      return reply.code(400).send({ error: 'Invalid download link(s)', linkErrors: links.errors });
    }
    const parsed = itemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    const db = getDb();
    const slug = data.slug || makeSlug(data.name);
    
    if (db.prepare('SELECT id FROM items WHERE slug = ?').get(slug)) {
      return reply.code(409).send({ error: 'Slug already exists', slug });
    }

    try {
      const provider = storageManager.getProvider(data.storage_provider);
      if (data.storage_path) await provider.validatePath(data.storage_path);
    } catch (e) {
      return reply.code(400).send({ error: `Storage provider error: ${e.message}` });
    }

    // FK constraints would turn a bad id into a 500; answer 400 instead.
    if (data.folder_id && !db.prepare('SELECT id FROM folders WHERE id = ?').get(data.folder_id)) {
      return reply.code(400).send({ error: 'Folder not found' });
    }
    if (data.category_id && !db.prepare('SELECT id FROM categories WHERE id = ?').get(data.category_id)) {
      return reply.code(400).send({ error: 'Category not found' });
    }

    const now = new Date().toISOString();
    let tagsJson = null;
    if (data.tags) {
      if (Array.isArray(data.tags)) tagsJson = JSON.stringify(data.tags);
      else { try { JSON.parse(data.tags); tagsJson = data.tags; } catch { tagsJson = JSON.stringify(data.tags.split(',').map(t => t.trim()).filter(Boolean)); } }
    }
    let screenshotsJson = null;
    if (data.screenshots) {
      if (Array.isArray(data.screenshots)) screenshotsJson = JSON.stringify(data.screenshots);
      else screenshotsJson = data.screenshots;
    }

    const encryptedData = encryptItemFields({
      storage_path: data.storage_path || null,
      download_url: data.download_url || null,
      external_url: data.external_url || null,
      license_notes: data.license_notes || null,
    });

    const result = db.prepare(`
      INSERT INTO items (
        name, slug, description, long_description, category_id, folder_id, version, release_date,
        file_name, file_size, file_type, platform, architecture, sha256, md5,
        storage_provider, storage_path, download_url, external_url,
        featured, published, license_status, license_notes, tags, icon_url, image_url, screenshots,
        documentation_url, changelog, requirements, created_at, updated_at, encryption_version
      ) VALUES (
        @name, @slug, @description, @long_description, @category_id, @folder_id, @version, @release_date,
        @file_name, @file_size, @file_type, @platform, @architecture, @sha256, @md5,
        @storage_provider, @storage_path, @download_url, @external_url,
        @featured, @published, @license_status, @license_notes, @tags, @icon_url, @image_url, @screenshots,
        @documentation_url, @changelog, @requirements, @created_at, @updated_at, @encryption_version
      )
    `).run({
      name: data.name, slug, description: data.description,
      long_description: data.long_description || null,
      category_id: data.category_id || null, folder_id: data.folder_id || null,
      version: data.version || null,
      release_date: data.release_date || null, file_name: data.file_name || null,
      file_size: data.file_size || null, file_type: data.file_type || null,
      platform: data.platform || null, architecture: data.architecture || null,
      sha256: data.sha256 || null, md5: data.md5 || null,
      storage_provider: data.storage_provider,
      storage_path: encryptedData.storage_path,
      download_url: encryptedData.download_url,
      external_url: encryptedData.external_url,
      featured: data.featured ? 1 : 0,
      published: data.published !== undefined ? (data.published ? 1 : 0) : 1,
      license_status: data.license_status,
      license_notes: encryptedData.license_notes,
      tags: tagsJson, icon_url: data.icon_url || null, image_url: data.image_url || null,
      screenshots: screenshotsJson, documentation_url: data.documentation_url || null,
      changelog: data.changelog || null,
      requirements: data.requirements?.length ? JSON.stringify(data.requirements) : null,
      created_at: now, updated_at: now, encryption_version: 'v1',
    });

    const insertLink = db.prepare(INSERT_LINK_SQL);
    (links.links || []).forEach((ld, i) => insertLink.run(linkRow(result.lastInsertRowid, ld, i)));

    recordItemVersion(result.lastInsertRowid, request.user?.id, 'Created');
    {
      const created = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
      emitEvent('item.created', { item: itemSummary(created) }, { actorId: request.user?.id });
      if (created.published) emitEvent('item.published', { item: itemSummary(created) }, { actorId: request.user?.id });
    }

    const newItemRaw = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
    const newItem = decryptItem(newItemRaw);
    const newLinks = getItemLinks(newItem.id);
    return reply.code(201).send({ ...newItem, download_links: newLinks, download_links_count: newLinks.length });
  });

  // PUT /api/items/:id - update (admin)
  fastify.put('/items/:id', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'Item not found' });

    const wantedLinks = parseDownloadLinks(request.body.download_links);
    if (wantedLinks.errors) {
      return reply.code(400).send({ error: 'Invalid download link(s)', linkErrors: wantedLinks.errors });
    }

    const parsed = itemSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;

    // FK constraints would turn a bad id into a 500; answer 400 instead.
    if (data.folder_id && !db.prepare('SELECT id FROM folders WHERE id = ?').get(data.folder_id)) {
      return reply.code(400).send({ error: 'Folder not found' });
    }
    if (data.category_id && !db.prepare('SELECT id FROM categories WHERE id = ?').get(data.category_id)) {
      return reply.code(400).send({ error: 'Category not found' });
    }

    const updates = [];
    const params = { id };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        let finalValue = value;
        if (ENCRYPTED_ITEM_FIELDS.includes(key) && value) finalValue = encryptionService.encrypt(value);
        if (key === 'tags' && Array.isArray(value)) { updates.push(`${key} = @${key}`); params[key] = JSON.stringify(value); }
        else if (key === 'screenshots' && Array.isArray(value)) { updates.push(`${key} = @${key}`); params[key] = JSON.stringify(value); }
        else if (key === 'requirements') { updates.push(`${key} = @${key}`); params[key] = Array.isArray(value) && value.length ? JSON.stringify(value) : null; }
        else if (key === 'featured' || key === 'published') { updates.push(`${key} = @${key}`); params[key] = value ? 1 : 0; }
        else { updates.push(`${key} = @${key}`); params[key] = finalValue; }
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = @updated_at'); updates.push('encryption_version = @encryption_version');
      params.updated_at = new Date().toISOString(); params.encryption_version = 'v1';
      db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = @id`).run(params);
    }

    // `null` means the request said nothing about mirrors, so leave them alone.
    if (wantedLinks.links !== null) syncDownloadLinks(db, Number(id), wantedLinks.links);

    recordItemVersion(Number(id), request.user?.id);

    const updatedRaw = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    {
      // Which public fields changed, for subscribers ("version: 1.2 -> 1.3").
      const changed = Object.keys(data).filter(k => k !== 'download_links' && String(existing[k] ?? '') !== String(updatedRaw[k] ?? ''));
      if (wantedLinks.links !== null) changed.push('download_links');
      const summary = itemSummary(updatedRaw);
      const actor = { actorId: request.user?.id };
      if (!existing.published && updatedRaw.published) emitEvent('item.published', { item: summary }, actor);
      else if (existing.published && !updatedRaw.published) emitEvent('item.unpublished', { item: summary }, actor);
      if (changed.length) emitEvent('item.updated', { item: summary, changes: changed }, actor);
    }
    const decrypted = decryptItem(updatedRaw);
    const links = getItemLinks(id);
    return { ...decrypted, download_links: links, download_links_count: links.length };
  });

  // POST /api/items/:id/preview-link - signed, expiring link to a draft.
  fastify.post('/items/:id/preview-link', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const db = getDb();
    const item = db.prepare('SELECT id, slug, published FROM items WHERE id = ?').get(request.params.id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    const ttlHours = request.body?.ttl_hours ?? DEFAULT_TTL_HOURS;
    const { token, expires_at } = createPreviewToken(item.id, { ttlHours });
    return {
      path: `/file/${item.slug}?preview=${token}`,
      expires_at,
      published: !!item.published,
      note: item.published ? 'This entry is already public; the link works but is not needed.' : 'Anyone with this link can read the draft (no downloads) until it expires or the entry is published.',
    };
  });

  fastify.delete('/items/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const doomed = db.prepare('SELECT id, slug, name, published FROM items WHERE id = ?').get(id);
    if (!doomed) return reply.code(404).send({ error: 'Item not found' });
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    emitEvent('item.deleted', { item: { id: doomed.id, slug: doomed.slug, name: doomed.name, published: !!doomed.published } }, { actorId: request.user?.id, itemId: doomed.id });
    return { success: true, message: 'Item deleted' };
  });

  // GET /api/items/:id/links
  fastify.get('/items/:id/links', { preHandler: [optionalAuthenticate] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const item = db.prepare('SELECT id, published FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    if (!item.published && !isAdmin(request)) return reply.code(404).send({ error: 'Item not found' });
    const links = getItemLinks(item.id);
    return { links, count: links.length, available: links.filter(l => !l.is_down).length, down: links.filter(l => l.is_down).length };
  });

  // POST /api/items/:id/links
  fastify.post('/items/:id/links', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const item = db.prepare('SELECT id FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });

    const parsed = downloadLinkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const ld = parsed.data;
    const encLink = encryptLinkFields({ storage_path: ld.storage_path || null, download_url: ld.download_url || null, down_reason: ld.down_reason || null });

    if (ld.is_primary) db.prepare('UPDATE item_download_links SET is_primary = 0 WHERE item_id = ?').run(item.id);

    const result = db.prepare(`
      INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
      VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
    `).run({
      item_id: item.id, label: ld.label, storage_provider: ld.storage_provider,
      storage_path: encLink.storage_path, download_url: encLink.download_url,
      file_size: ld.file_size || null, is_primary: ld.is_primary ? 1 : 0,
      is_down: ld.is_down ? 1 : 0, down_reason: encLink.down_reason,
      status: ld.status || (ld.is_down ? 'down' : 'up'), sort_order: ld.sort_order !== undefined ? ld.sort_order : 0,
    });

    return reply.code(201).send(decryptLink(db.prepare('SELECT * FROM item_download_links WHERE id = ?').get(result.lastInsertRowid)));
  });

  // PUT /api/items/:id/links/:linkId
  fastify.put('/items/:id/links/:linkId', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const { id, linkId } = request.params;
    const db = getDb();
    const item = db.prepare('SELECT id FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });

    const existingLink = db.prepare('SELECT * FROM item_download_links WHERE id = ? AND item_id = ?').get(linkId, item.id);
    if (!existingLink) return reply.code(404).send({ error: 'Link not found' });

    const parsed = downloadLinkSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    if (data.is_primary) db.prepare('UPDATE item_download_links SET is_primary = 0 WHERE item_id = ?').run(item.id);

    const updates = [];
    const params = { id: linkId };
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        let finalValue = value;
        if ((key === 'storage_path' || key === 'download_url' || key === 'down_reason') && value) finalValue = encryptionService.encrypt(value);
        if (key === 'is_primary' || key === 'is_down') { updates.push(`${key} = @${key}`); params[key] = value ? 1 : 0; }
        else { updates.push(`${key} = @${key}`); params[key] = finalValue; }
      }
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'No fields to update' });
    updates.push('updated_at = @updated_at'); params.updated_at = new Date().toISOString();
    db.prepare(`UPDATE item_download_links SET ${updates.join(', ')} WHERE id = @id`).run(params);
    return decryptLink(db.prepare('SELECT * FROM item_download_links WHERE id = ?').get(linkId));
  });

  fastify.delete('/items/:id/links/:linkId', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id, linkId } = request.params;
    const db = getDb();
    const item = db.prepare('SELECT id FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    if (!db.prepare('SELECT * FROM item_download_links WHERE id = ? AND item_id = ?').get(linkId, item.id)) return reply.code(404).send({ error: 'Link not found' });
    db.prepare('DELETE FROM item_download_links WHERE id = ?').run(linkId);
    return { success: true, message: 'Link deleted' };
  });

  // GET /api/download/:id - NOW REQUIRES LOGIN, blocks down mirrors
  fastify.get('/download/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const { mirror } = request.query;

    if (!id || typeof id !== 'string' || id.length > 200) return reply.code(400).send({ error: 'Invalid download ID' });
    if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('%2e') || id.includes('%2f')) {
      return reply.code(400).send({ error: 'Invalid download ID - path traversal detected' });
    }

    const db = getDb();
    const itemRaw = db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!itemRaw) return reply.code(404).send({ error: 'Item not found' });
    const item = decryptItem(itemRaw);
    if (!item.published) return reply.code(403).send({ error: 'Item not published' });

    try {
      let downloadUrl = null;
      let usedLink = null;

      if (mirror) {
        const linkRaw = db.prepare('SELECT * FROM item_download_links WHERE id = ? AND item_id = ?').get(mirror, item.id);
        if (!linkRaw) return reply.code(404).send({ error: 'Mirror not found' });
        const link = decryptLink(linkRaw);
        if (link.is_down || link.status === 'down') {
          return reply.code(503).send({ error: 'This mirror is marked as down', reason: link.down_reason || 'Marked as down by admin', link });
        }
        downloadUrl = await storageManager.getDownloadUrl(link.storage_provider, link.storage_path, link);
        usedLink = link;
      } else {
        const availableLinks = getAvailableLinks(item.id);
        if (availableLinks.length > 0) {
          const primary = availableLinks.find(l => l.is_primary) || availableLinks[0];
          downloadUrl = await storageManager.getDownloadUrl(primary.storage_provider, primary.storage_path, primary);
          usedLink = primary;
        } else {
          const allLinks = getItemLinks(item.id);
          if (allLinks.length > 0 && availableLinks.length === 0) {
            return reply.code(503).send({ 
              error: 'All mirrors are currently marked as down',
              downMirrors: allLinks.filter(l => l.is_down),
              message: 'Please try again later or contact admin'
            });
          }
          downloadUrl = await storageManager.getDownloadUrl(item.storage_provider, item.storage_path, item);
        }
      }

      if (!downloadUrl) return reply.code(404).send({ error: 'No download URL configured' });
      if (downloadUrl.startsWith('/api/files/')) return reply.code(501).send({ error: 'Local file serving not configured' });
      if (!isSafeRedirectUrl(downloadUrl)) {
        request.log.error({ itemId: item.id }, 'Refusing to serve unsafe download URL');
        return reply.code(502).send({ error: 'Stored download URL is not a valid http(s) link' });
      }

      // Counted only once we actually have something to hand out - a 404/501/502
      // above means the visitor left empty-handed, so the mirror's counter moves
      // here too instead of before the URL is resolved.
      db.prepare('UPDATE items SET download_count = download_count + 1 WHERE id = ?').run(item.id);
      if (usedLink) {
        db.prepare('UPDATE item_download_links SET download_count = download_count + 1 WHERE id = ?').run(usedLink.id);
      }

      // If client wants JSON (frontend fetch), return JSON with URL, else redirect
      const wantsJson = request.headers.accept && request.headers.accept.includes('application/json');
      const isFetch = request.headers['x-requested-with'] === 'fetch' || request.query.json === '1' || wantsJson;
      
      if (isFetch) {
        return {
          downloadUrl,
          fileName: item.file_name || `${item.slug}.${item.file_type || 'bin'}`,
          fileSize: usedLink?.file_size || item.file_size,
          provider: usedLink?.storage_provider || item.storage_provider,
          label: usedLink?.label || 'Primary',
        };
      }

      return reply.redirect(downloadUrl, 302);
    } catch (e) {
      request.log.error({ err: e }, 'Failed to resolve download URL');
      return reply.code(502).send({ error: 'Failed to get download URL from the storage provider' });
    }
  });

  // GET /api/download/:id/:linkId - specific mirror, requires login, blocks down
  fastify.get('/download/:id/:linkId', { preHandler: [authenticate] }, async (request, reply) => {
    const { id, linkId } = request.params;
    const db = getDb();
    const itemRaw = db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!itemRaw) return reply.code(404).send({ error: 'Item not found' });
    const item = decryptItem(itemRaw);
    if (!item.published) return reply.code(403).send({ error: 'Item not published' });

    const linkRaw = db.prepare('SELECT * FROM item_download_links WHERE id = ? AND item_id = ?').get(linkId, itemRaw.id);
    if (!linkRaw) return reply.code(404).send({ error: 'Mirror not found' });
    const link = decryptLink(linkRaw);
    
    if (link.is_down || link.status === 'down') {
      return reply.code(503).send({ error: 'This mirror is marked as down', reason: link.down_reason || 'Marked as down', link });
    }

    try {
      const downloadUrl = await storageManager.getDownloadUrl(link.storage_provider, link.storage_path, link);
      if (!downloadUrl) return reply.code(404).send({ error: 'No download URL configured' });
      if (downloadUrl.startsWith('/api/files/')) return reply.code(501).send({ error: 'Local file serving not configured' });
      if (!isSafeRedirectUrl(downloadUrl)) {
        request.log.error({ itemId: item.id, linkId: link.id }, 'Refusing to serve unsafe download URL');
        return reply.code(502).send({ error: 'Stored download URL is not a valid http(s) link' });
      }

      // Same rule as GET /download/:id: only count a download that was actually
      // handed out, so a broken mirror cannot inflate the popularity counters.
      db.prepare('UPDATE items SET download_count = download_count + 1 WHERE id = ?').run(item.id);
      db.prepare('UPDATE item_download_links SET download_count = download_count + 1 WHERE id = ?').run(link.id);

      const wantsJson = request.headers.accept && request.headers.accept.includes('application/json');
      const isFetch = request.headers['x-requested-with'] === 'fetch' || request.query.json === '1' || wantsJson;
      if (isFetch) {
        return {
          downloadUrl,
          fileName: item.file_name || `${item.slug}.${item.file_type || 'bin'}`,
          fileSize: link.file_size || item.file_size,
          provider: link.storage_provider,
          label: link.label,
        };
      }

      return reply.redirect(downloadUrl, 302);
    } catch (e) {
      request.log.error({ err: e }, 'Failed to resolve download URL');
      return reply.code(502).send({ error: 'Failed to get download URL from the storage provider' });
    }
  });
}
