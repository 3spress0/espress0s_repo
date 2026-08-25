import { getDb } from '../db/index.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService } from '../services/encryptionService.js';
import { monitoringService } from '../services/monitoringService.js';
import { getItemLinksForMany, serializeItem } from '../services/itemSerializer.js';

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
