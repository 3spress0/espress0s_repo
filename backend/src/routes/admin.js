import { getDb } from '../db/index.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService } from '../services/encryptionService.js';
import { monitoringService } from '../services/monitoringService.js';
import { getItemLinksForMany, serializeItem } from '../services/itemSerializer.js';
import { makeSlug } from '../utils/slug.js';

export async function adminRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

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
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '';
    const params = {};
    const conditions = [];

    if (q) {
      conditions.push('(LOWER(name) LIKE @q OR LOWER(slug) LIKE @q)');
      params.q = `%${q.toLowerCase()}%`;
    }

    if (published !== undefined) {
      conditions.push('published = @published');
      params.published = published === 'true' || published === '1' ? 1 : 0;
    }

    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as c FROM items ${where}`).get(params).c;
    const itemsRaw = db.prepare(`SELECT * FROM items ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({
      ...params,
      limit: parseInt(limit),
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
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
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

    const raw = db.prepare('SELECT * FROM items WHERE id = ?').get(copyId);
    return reply.code(201).send({ item: serializeItem(raw), message: `Duplicated as draft "${name}"` });
  });

  /**
   * POST /admin/items/bulk  { action, ids: [] }
   * Publish / unpublish / feature / unfeature / delete several pages at once.
   * One transaction, so a bad id can't leave the list half-changed.
   */
  fastify.post('/admin/items/bulk', async (request, reply) => {
    const { action, ids } = request.body || {};
    const allowed = ['publish', 'unpublish', 'feature', 'unfeature', 'delete'];
    if (!allowed.includes(action)) {
      return reply.code(400).send({ error: `action must be one of: ${allowed.join(', ')}` });
    }

    const cleanIds = Array.isArray(ids)
      ? [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    if (!cleanIds.length) return reply.code(400).send({ error: 'ids must be a non-empty array of item ids' });
    if (cleanIds.length > 200) return reply.code(400).send({ error: 'Too many items in one request (max 200)' });

    const db = getDb();
    const placeholders = cleanIds.map(() => '?').join(',');

    const statements = {
      publish: `UPDATE items SET published = 1, updated_at = ? WHERE id IN (${placeholders})`,
      unpublish: `UPDATE items SET published = 0, updated_at = ? WHERE id IN (${placeholders})`,
      feature: `UPDATE items SET featured = 1, updated_at = ? WHERE id IN (${placeholders})`,
      unfeature: `UPDATE items SET featured = 0, updated_at = ? WHERE id IN (${placeholders})`,
    };

    let affected = 0;
    if (action === 'delete') {
      affected = db.transaction(() =>
        db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...cleanIds).changes
      )();
    } else {
      const now = new Date().toISOString();
      affected = db.transaction(() =>
        db.prepare(statements[action]).run(now, ...cleanIds).changes
      )();
    }

    return { success: true, action, affected, ids: cleanIds };
  });

  /**
   * POST /admin/ai/describe
   * Drafts the page copy (summary + markdown body) from whatever metadata the
   * admin has filled in. Admin-only: it shells out to tgpt, so it must not be
   * reachable by visitors.
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
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '';
    const params = {};
    const conditions = [];

    if (q) {
      conditions.push('(LOWER(username) LIKE @q OR LOWER(email) LIKE @q)');
      params.q = `%${q.toLowerCase()}%`;
    }

    if (role) {
      conditions.push('role = @role');
      params.role = role;
    }

    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as c FROM users ${where}`).get(params).c;
    const usersRaw = db.prepare(`SELECT id, username, email, email_hash, role, encryption_version, created_at, updated_at FROM users ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({
      ...params,
      limit: parseInt(limit),
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
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      }
    };
  });

  fastify.get('/admin/users/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const userRaw = db.prepare('SELECT id, username, email, email_hash, role, encryption_version, created_at, updated_at FROM users WHERE id = ?').get(id);
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
