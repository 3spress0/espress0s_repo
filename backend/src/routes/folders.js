import { getDb } from '../db/index.js';
import { makeSlug } from '../utils/slug.js';
import { folderSchema } from '../utils/validation.js';
import { authenticate, optionalAuthenticate, requireAdmin, requireEditor, roleAtLeast } from '../middleware/auth.js';
import { serializeItem, getItemLinksForMany } from '../services/itemSerializer.js';

/**
 * Folders: a free-form, admin-managed grouping for items. Categories describe
 * what an item *is* (OS, ISO, App...); folders describe how the admin *files*
 * it ("Linux ISOs 2026", "Recommended tools", ...). An item belongs to at most
 * one folder; visitors can filter Browse and search by it.
 */
export async function foldersRoutes(fastify) {
  // GET /api/folders - list with published item counts (public)
  fastify.get('/folders', async () => {
    const db = getDb();
    const folders = db.prepare(`
      SELECT f.*, COUNT(i.id) as item_count
      FROM folders f
      LEFT JOIN items i ON i.folder_id = f.id AND i.published = 1
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.name ASC
    `).all();
    return { folders };
  });

  // GET /api/folders/:slug - folder + its published items (public)
  // Admins additionally see drafts inside the folder so they can curate them.
  fastify.get('/folders/:slug', { preHandler: [optionalAuthenticate] }, async (request, reply) => {
    const { slug } = request.params;
    const db = getDb();

    const folder = db.prepare('SELECT * FROM folders WHERE slug = ? OR id = ?').get(slug, slug);
    if (!folder) return reply.code(404).send({ error: 'Folder not found' });

    const isAdmin = roleAtLeast(request.user?.role, 'editor');
    const itemsRaw = db.prepare(`
      SELECT * FROM items
      WHERE folder_id = ? ${isAdmin ? '' : 'AND published = 1'}
      ORDER BY created_at DESC
      LIMIT 200
    `).all(folder.id);

    const linksByItem = getItemLinksForMany(itemsRaw.map(i => i.id));
    const items = itemsRaw.map(item => {
      const s = serializeItem(item, linksByItem[item.id] || []);
      // The folder page only needs card-level data, not every mirror's URL.
      const { download_links, ...rest } = s;
      return { ...rest, download_links_count: download_links.length };
    });

    return { ...folder, item_count: items.length, items };
  });

  // GET /api/admin/folders - same list but with counts including drafts
  fastify.get('/admin/folders', { preHandler: [authenticate, requireEditor] }, async () => {
    const db = getDb();
    const folders = db.prepare(`
      SELECT f.*,
        COUNT(i.id) as item_count,
        SUM(CASE WHEN i.published = 0 THEN 1 ELSE 0 END) as draft_count
      FROM folders f
      LEFT JOIN items i ON i.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.sort_order ASC, f.name ASC
    `).all();
    return { folders };
  });

  // POST /api/folders - create (admin)
  fastify.post('/folders', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const parsed = folderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    const slug = data.slug || makeSlug(data.name);
    const db = getDb();

    if (db.prepare('SELECT id FROM folders WHERE slug = ? OR name = ?').get(slug, data.name)) {
      return reply.code(409).send({ error: 'A folder with that name or slug already exists', slug });
    }

    const result = db.prepare(`
      INSERT INTO folders (name, slug, description, icon, color, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(data.name, slug, data.description || null, data.icon || null, data.color || null, data.sort_order ?? 0);

    return reply.code(201).send(db.prepare('SELECT * FROM folders WHERE id = ?').get(result.lastInsertRowid));
  });

  // PUT /api/folders/:id - update (admin)
  fastify.put('/folders/:id', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'Folder not found' });

    const parsed = folderSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    if (data.slug && data.slug !== existing.slug) {
      const clash = db.prepare('SELECT id FROM folders WHERE slug = ? AND id != ?').get(data.slug, id);
      if (clash) return reply.code(409).send({ error: 'Folder slug already in use', slug: data.slug });
    }
    if (data.name && data.name !== existing.name) {
      const clash = db.prepare('SELECT id FROM folders WHERE name = ? AND id != ?').get(data.name, id);
      if (clash) return reply.code(409).send({ error: 'Folder name already in use' });
    }

    const updates = [];
    const params = { id };
    for (const key of ['name', 'slug', 'description', 'icon', 'color', 'sort_order']) {
      if (data[key] !== undefined) { updates.push(`${key} = @${key}`); params[key] = data[key]; }
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    updates.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();
    db.prepare(`UPDATE folders SET ${updates.join(', ')} WHERE id = @id`).run(params);
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  });

  // DELETE /api/folders/:id - remove folder, items stay (folder_id -> NULL)
  fastify.delete('/folders/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'Folder not found' });

    const itemCount = db.prepare('SELECT COUNT(*) as c FROM items WHERE folder_id = ?').get(id).c;
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return { success: true, message: `Folder deleted; ${itemCount} item${itemCount === 1 ? '' : 's'} unfiled`, unfiled: itemCount };
  });
}
