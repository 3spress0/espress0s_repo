import { getDb } from '../db/index.js';
import { makeSlug, formatBytes } from '../utils/slug.js';
import { itemSchema, downloadLinkSchema } from '../utils/validation.js';
import { authenticate, optionalAuthenticate, requireAdmin } from '../middleware/auth.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService, ENCRYPTED_ITEM_FIELDS } from '../services/encryptionService.js';

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
  return request.user?.role === 'admin';
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
      q, category, file_type, platform, architecture,
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
      category: category || null, file_type: file_type || null,
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
      SELECT items.*, categories.name as category_name, categories.slug as category_slug, categories.color as category_color
      FROM items LEFT JOIN categories ON items.category_id = categories.id
      WHERE items.slug = ? OR items.id = ?
    `).get(slug, slug);

    if (!item) return reply.code(404).send({ error: 'Item not found' });

    // Drafts are invisible to everyone but admins - 404, not 403, so the
    // endpoint does not confirm that a hidden slug exists.
    if (!item.published && !isAdmin(request)) {
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
    const links = getItemLinks(item.id);
    const availableLinks = links.filter(l => !l.is_down && l.status !== 'down');

    return {
      ...decrypted,
      file_size_formatted: formatBytes(decrypted.file_size),
      tags: decrypted.tags ? JSON.parse(decrypted.tags || '[]') : [],
      screenshots: decrypted.screenshots ? JSON.parse(decrypted.screenshots || '[]') : [],
      related: related.map(r => decryptItem(r)),
      download_links: links,
      available_links: availableLinks,
      download_links_count: links.length,
      available_links_count: availableLinks.length,
      has_multiple_mirrors: links.length > 1,
      has_down_mirrors: links.some(l => l.is_down),
      primary_download: availableLinks.find(l => l.is_primary) || availableLinks[0] || links.find(l => l.is_primary) || links[0] || null,
      encryption: { atRest: 'storage_path, download_url, external_url, license_notes encrypted', version: item.encryption_version || 'v1' }
    };
  });

  // POST /api/items - create (admin)
  fastify.post('/items', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
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
        name, slug, description, long_description, category_id, version, release_date,
        file_name, file_size, file_type, platform, architecture, sha256, md5,
        storage_provider, storage_path, download_url, external_url,
        featured, published, license_status, license_notes, tags, icon_url, image_url, screenshots,
        documentation_url, changelog, created_at, updated_at, encryption_version
      ) VALUES (
        @name, @slug, @description, @long_description, @category_id, @version, @release_date,
        @file_name, @file_size, @file_type, @platform, @architecture, @sha256, @md5,
        @storage_provider, @storage_path, @download_url, @external_url,
        @featured, @published, @license_status, @license_notes, @tags, @icon_url, @image_url, @screenshots,
        @documentation_url, @changelog, @created_at, @updated_at, @encryption_version
      )
    `).run({
      name: data.name, slug, description: data.description,
      long_description: data.long_description || null,
      category_id: data.category_id || null, version: data.version || null,
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
      changelog: data.changelog || null, created_at: now, updated_at: now, encryption_version: 'v1',
    });

    const links = request.body.download_links || [];
    if (Array.isArray(links) && links.length > 0) {
      const insertLink = db.prepare(`
        INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
        VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
      `);
      for (let i = 0; i < links.length; i++) {
        const linkParsed = downloadLinkSchema.safeParse(links[i]);
        if (linkParsed.success) {
          const ld = linkParsed.data;
          const encLink = encryptLinkFields({ storage_path: ld.storage_path || null, download_url: ld.download_url || null, down_reason: ld.down_reason || null });
          insertLink.run({
            item_id: result.lastInsertRowid, label: ld.label, storage_provider: ld.storage_provider,
            storage_path: encLink.storage_path, download_url: encLink.download_url,
            file_size: ld.file_size || null, is_primary: ld.is_primary ? 1 : 0,
            is_down: ld.is_down ? 1 : 0, down_reason: encLink.down_reason,
            status: ld.status || (ld.is_down ? 'down' : 'up'), sort_order: ld.sort_order !== undefined ? ld.sort_order : i,
          });
        }
      }
    }

    const newItemRaw = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
    const newItem = decryptItem(newItemRaw);
    const newLinks = getItemLinks(newItem.id);
    return reply.code(201).send({ ...newItem, download_links: newLinks, download_links_count: newLinks.length });
  });

  // PUT /api/items/:id - update (admin)
  fastify.put('/items/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'Item not found' });

    const parsed = itemSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    const updates = [];
    const params = { id };

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        let finalValue = value;
        if (ENCRYPTED_ITEM_FIELDS.includes(key) && value) finalValue = encryptionService.encrypt(value);
        if (key === 'tags' && Array.isArray(value)) { updates.push(`${key} = @${key}`); params[key] = JSON.stringify(value); }
        else if (key === 'screenshots' && Array.isArray(value)) { updates.push(`${key} = @${key}`); params[key] = JSON.stringify(value); }
        else if (key === 'featured' || key === 'published') { updates.push(`${key} = @${key}`); params[key] = value ? 1 : 0; }
        else { updates.push(`${key} = @${key}`); params[key] = finalValue; }
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = @updated_at'); updates.push('encryption_version = @encryption_version');
      params.updated_at = new Date().toISOString(); params.encryption_version = 'v1';
      db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = @id`).run(params);
    }

    if (request.body.download_links !== undefined) {
      const links = request.body.download_links;
      if (Array.isArray(links)) {
        db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(id);
        const insertLink = db.prepare(`
          INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
          VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
        `);
        for (let i = 0; i < links.length; i++) {
          const linkParsed = downloadLinkSchema.safeParse(links[i]);
          if (linkParsed.success) {
            const ld = linkParsed.data;
            const encLink = encryptLinkFields({ storage_path: ld.storage_path || null, download_url: ld.download_url || null, down_reason: ld.down_reason || null });
            insertLink.run({
              item_id: id, label: ld.label, storage_provider: ld.storage_provider,
              storage_path: encLink.storage_path, download_url: encLink.download_url,
              file_size: ld.file_size || null, is_primary: ld.is_primary ? 1 : 0,
              is_down: ld.is_down ? 1 : 0, down_reason: encLink.down_reason,
              status: ld.status || (ld.is_down ? 'down' : 'up'), sort_order: ld.sort_order !== undefined ? ld.sort_order : i,
            });
          }
        }
      }
    }

    const updatedRaw = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    const decrypted = decryptItem(updatedRaw);
    const links = getItemLinks(id);
    return { ...decrypted, download_links: links, download_links_count: links.length };
  });

  fastify.delete('/items/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    if (!db.prepare('SELECT id FROM items WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Item not found' });
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
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
  fastify.post('/items/:id/links', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
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
  fastify.put('/items/:id/links/:linkId', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
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
        db.prepare('UPDATE item_download_links SET download_count = download_count + 1 WHERE id = ?').run(link.id);
        downloadUrl = await storageManager.getDownloadUrl(link.storage_provider, link.storage_path, link);
        usedLink = link;
      } else {
        const availableLinks = getAvailableLinks(item.id);
        if (availableLinks.length > 0) {
          const primary = availableLinks.find(l => l.is_primary) || availableLinks[0];
          db.prepare('UPDATE item_download_links SET download_count = download_count + 1 WHERE id = ?').run(primary.id);
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

      // Counted only once we actually have something to hand out.
      db.prepare('UPDATE items SET download_count = download_count + 1 WHERE id = ?').run(item.id);

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

    db.prepare('UPDATE items SET download_count = download_count + 1 WHERE id = ?').run(item.id);
    db.prepare('UPDATE item_download_links SET download_count = download_count + 1 WHERE id = ?').run(link.id);

    try {
      const downloadUrl = await storageManager.getDownloadUrl(link.storage_provider, link.storage_path, link);
      if (downloadUrl.startsWith('/api/files/')) return reply.code(501).send({ error: 'Local file serving not configured' });
      if (!isSafeRedirectUrl(downloadUrl)) {
        request.log.error({ itemId: item.id, linkId: link.id }, 'Refusing to serve unsafe download URL');
        return reply.code(502).send({ error: 'Stored download URL is not a valid http(s) link' });
      }

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
