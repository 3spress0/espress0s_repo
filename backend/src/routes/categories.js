import { getDb } from '../db/index.js';
import { makeSlug } from '../utils/slug.js';
import { categorySchema } from '../utils/validation.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

export async function categoriesRoutes(fastify) {
  fastify.get('/categories', async (request, reply) => {
    const db = getDb();
    const categories = db.prepare(`
      SELECT c.*, COUNT(i.id) as item_count
      FROM categories c
      LEFT JOIN items i ON i.category_id = c.id AND i.published = 1
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name ASC
    `).all();

    return { categories };
  });

  fastify.get('/categories/:slug', async (request, reply) => {
    const { slug } = request.params;
    const db = getDb();

    const category = db.prepare(`
      SELECT c.*, COUNT(i.id) as item_count
      FROM categories c
      LEFT JOIN items i ON i.category_id = c.id AND i.published = 1
      WHERE c.slug = ? OR c.id = ?
      GROUP BY c.id
    `).get(slug, slug);

    if (!category) {
      return reply.code(404).send({ error: 'Category not found' });
    }

    const items = db.prepare(`
      SELECT id, name, slug, description, version, file_type, platform, architecture, file_size, featured, created_at, icon_url
      FROM items
      WHERE category_id = ? AND published = 1
      ORDER BY created_at DESC LIMIT 20
    `).all(category.id);

    return { ...category, items };
  });

  fastify.post('/categories', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const parsed = categorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });
    }

    const data = parsed.data;
    const slug = data.slug || makeSlug(data.name);
    const db = getDb();

    const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (existing) {
      return reply.code(409).send({ error: 'Category slug exists' });
    }

    const result = db.prepare(`
      INSERT INTO categories (name, slug, description, icon, color)
      VALUES (@name, @slug, @description, @icon, @color)
    `).run({
      name: data.name,
      slug,
      description: data.description || null,
      icon: data.icon || null,
      color: data.color || null,
    });

    const newCat = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send(newCat);
  });

  fastify.put('/categories/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const parsed = categorySchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const data = parsed.data;
    const updates = [];
    const params = { id };

    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        updates.push(`${k} = @${k}`);
        params[k] = v;
      }
    }

    if (updates.length === 0) return reply.code(400).send({ error: 'No fields' });

    db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = @id`).run(params);
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  });

  fastify.delete('/categories/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return { success: true };
  });
}
