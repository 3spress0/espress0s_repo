import { z } from 'zod';
import { getDb } from '../db/index.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { itemSchema, downloadLinkSchema } from '../utils/validation.js';
import {
  serializeItem, getItemLinksForMany,
  encryptItemFields, encryptLinkFields,
} from '../services/itemSerializer.js';
import { makeSlug } from '../utils/slug.js';

/**
 * JSON backup / restore.
 *
 * Export produces a self-contained document: categories, folders, items (with
 * decrypted mirror URLs - the export IS the backup) and their download links,
 * FAQ entries and site settings. Users are deliberately never included: this
 * file must be safe to mail to a co-admin without leaking password hashes.
 *
 * Import defaults to a dry run: it walks the whole file and reports what it
 * *would* create/update, so a broken export is discovered before anything is
 * written. `?apply=1` (or { "apply": true }) runs the same plan inside one
 * transaction.
 */

export const EXPORT_FORMAT = 'espress0-repo-export';

const groupSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(10).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  sort_order: z.number().int().optional(),
});

const exportItemSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z.string().min(2).max(200),
  category_slug: z.string().optional().nullable(),
  folder_slug: z.string().optional().nullable(),
  links: z.array(downloadLinkSchema.partial()).max(50).optional(),
}).passthrough();

const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().min(1).max(1),
  exported_at: z.string().optional(),
  categories: z.array(groupSchema.passthrough()).max(500).optional(),
  folders: z.array(groupSchema.passthrough()).max(500).optional(),
  items: z.array(exportItemSchema).max(5000).optional(),
  faq_entries: z.array(z.object({ question: z.string().min(1).max(500), answer: z.string().max(5000), category: z.string().max(100).optional().nullable() }).passthrough()).max(1000).optional(),
  settings: z.record(z.string(), z.string().nullable()).optional(),
  apply: z.boolean().optional(),
});

// Item columns we accept from an export file. Counters, ids and timestamps
// are intentionally absent - those belong to the local database.
const IMPORTABLE_ITEM_FIELDS = [
  'description', 'long_description', 'version', 'release_date', 'file_name',
  'file_size', 'file_type', 'platform', 'architecture', 'sha256', 'md5',
  'storage_provider', 'storage_path', 'download_url', 'external_url',
  'featured', 'published', 'license_status', 'license_notes', 'tags',
  'icon_url', 'image_url', 'screenshots', 'documentation_url', 'changelog', 'requirements',
];

const eqJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Keep the keys itemSchema knows about (gets us type coercion + validation). */
function pickItemFields(raw) {
  const out = {};
  for (const key of ['name', 'slug', ...IMPORTABLE_ITEM_FIELDS]) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

export async function backupRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

  // GET /api/admin/export - download the whole archive as JSON
  fastify.get('/admin/export', async (request, reply) => {
    const db = getDb();

    const categories = db.prepare('SELECT name, slug, description, icon, color, sort_order FROM categories ORDER BY sort_order, name').all();
    const folders = db.prepare('SELECT name, slug, description, icon, color, sort_order FROM folders ORDER BY sort_order, name').all();
    const faqEntries = db.prepare('SELECT question, answer, category FROM faq_entries ORDER BY id').all();
    const settings = db.prepare('SELECT key, value FROM site_settings ORDER BY key').all();

    const itemsRaw = db.prepare(`
      SELECT items.*, categories.slug as category_slug, folders.slug as folder_slug
      FROM items
      LEFT JOIN categories ON categories.id = items.category_id
      LEFT JOIN folders ON folders.id = items.folder_id
      ORDER BY items.id
    `).all();
    const linksByItem = getItemLinksForMany(itemsRaw.map(i => i.id));

    const items = itemsRaw.map(raw => {
      const s = serializeItem(raw, linksByItem[raw.id] || []);
      return {
        slug: s.slug,
        name: s.name,
        category_slug: raw.category_slug || null,
        folder_slug: raw.folder_slug || null,
        ...Object.fromEntries(IMPORTABLE_ITEM_FIELDS.map(f => [f, s[f] ?? null])),
        links: (s.download_links || []).map(l => ({
          label: l.label,
          storage_provider: l.storage_provider,
          storage_path: l.storage_path,
          download_url: l.download_url,
          file_size: l.file_size,
          is_primary: !!l.is_primary,
          sort_order: l.sort_order ?? 0,
        })),
      };
    });

    const payload = {
      format: EXPORT_FORMAT,
      version: 1,
      exported_at: new Date().toISOString(),
      counts: { items: items.length, categories: categories.length, folders: folders.length },
      categories,
      folders,
      items,
      faq_entries: faqEntries,
      settings: Object.fromEntries(settings.map(s => [s.key, s.value])),
    };

    const date = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="espress0-repo-export-${date}.json"`);
    return payload;
  });

  // POST /api/admin/import - validate + plan (dry run) or apply a backup file
  fastify.post('/admin/import', {
    // Export files for a large archive can run into the megabytes; the global
    // 1 MB body cap would reject them.
    bodyLimit: 30 * 1024 * 1024,
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Not a valid export file',
        hint: `Expected { "format": "${EXPORT_FORMAT}", "version": 1, ... } produced by GET /api/admin/export`,
        details: parsed.error.errors.slice(0, 10),
      });
    }

    const data = parsed.data;
    const apply = data.apply === true || request.query.apply === '1' || request.query.apply === 'true';
    const db = getDb();

    const report = {
      dryRun: !apply,
      folders: { created: 0, updated: 0, unchanged: 0 },
      categories: { created: 0, updated: 0, unchanged: 0 },
      items: { created: 0, updated: 0, unchanged: 0, errors: [] },
      faq: { created: 0, skipped: 0 },
      settings: { updated: 0, unchanged: 0 },
    };
    const noteItemError = (slug, message) => {
      if (report.items.errors.length < 50) report.items.errors.push({ slug, error: message });
    };

    const plan = () => {
      // --- groups (folders + categories) upserted by slug ---
      for (const kind of ['folders', 'categories']) {
        const table = kind; // table name matches the array name
        for (const row of data[kind] || []) {
          const slug = makeSlug(row.slug || row.name);
          const existing = db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).get(slug);
          if (!existing) {
            report[kind].created++;
            if (apply) {
              db.prepare(`INSERT INTO ${table} (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(row.name, slug, row.description || null, row.icon || null, row.color || null, row.sort_order ?? 0);
            }
            continue;
          }
          const changed = !eqJson(existing.name, row.name)
            || !eqJson(existing.description ?? null, row.description ?? null)
            || !eqJson(existing.icon ?? null, row.icon ?? null)
            || !eqJson(existing.color ?? null, row.color ?? null);
          if (changed) {
            report[kind].updated++;
            if (apply) {
              // folders carries updated_at; categories does not.
              const sets = 'name = ?, description = ?, icon = ?, color = ?, sort_order = COALESCE(?, sort_order)'
                + (table === 'folders' ? ', updated_at = ?' : '');
              const args = [row.name, row.description ?? null, row.icon ?? null, row.color ?? null, row.sort_order ?? null];
              if (table === 'folders') args.push(new Date().toISOString());
              db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...args, existing.id);
            }
          } else {
            report[kind].unchanged++;
          }
        }
      }

      // Slug -> id lookups, refreshed after the upserts above (no-op in dry run:
      // newly listed groups simply resolve to null id and items report "created").
      const categoryIdBySlug = new Map(db.prepare('SELECT id, slug FROM categories').all().map(c => [c.slug, c.id]));
      const folderIdBySlug = new Map(db.prepare('SELECT id, slug FROM folders').all().map(f => [f.slug, f.id]));

      // --- items upserted by slug ---
      for (const rawItem of data.items || []) {
        try {
          const candidate = pickItemFields(rawItem);
          const itemParsed = itemSchema.partial().safeParse(candidate);
          if (!itemParsed.success) {
            noteItemError(rawItem.slug, itemParsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '));
            continue;
          }
          const item = itemParsed.data;
          item.name = rawItem.name;
          item.slug = rawItem.slug;

          if (rawItem.category_slug) {
            const id = categoryIdBySlug.get(makeSlug(rawItem.category_slug));
            if (id) item.category_id = id;
          }
          if (rawItem.folder_slug) {
            const id = folderIdBySlug.get(makeSlug(rawItem.folder_slug));
            if (id) item.folder_id = id;
          }

          const tagsJson = Array.isArray(item.tags) ? JSON.stringify(item.tags) : (typeof item.tags === 'string' ? item.tags : null);
          const shotsJson = Array.isArray(item.screenshots) ? JSON.stringify(item.screenshots) : (typeof item.screenshots === 'string' ? item.screenshots : null);
          const enc = encryptItemFields({
            storage_path: item.storage_path || null,
            download_url: item.download_url || null,
            external_url: item.external_url || null,
            license_notes: item.license_notes || null,
          });

          const existing = db.prepare('SELECT * FROM items WHERE slug = ?').get(item.slug);

          if (!existing) {
            report.items.created++;
            if (apply) {
              const now = new Date().toISOString();
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
                )`).run({
                name: item.name, slug: item.slug,
                description: item.description, long_description: item.long_description || null,
                category_id: item.category_id || null, folder_id: item.folder_id || null,
                version: item.version || null, release_date: item.release_date || null,
                file_name: item.file_name || null, file_size: item.file_size ?? null,
                file_type: item.file_type || null, platform: item.platform || null,
                architecture: item.architecture || null, sha256: item.sha256 || null, md5: item.md5 || null,
                storage_provider: item.storage_provider || 'external',
                storage_path: enc.storage_path, download_url: enc.download_url, external_url: enc.external_url,
                featured: item.featured ? 1 : 0, published: item.published === undefined ? 1 : (item.published ? 1 : 0),
                license_status: item.license_status || 'check-license', license_notes: enc.license_notes,
                tags: tagsJson, icon_url: item.icon_url || null, image_url: item.image_url || null,
                screenshots: shotsJson, documentation_url: item.documentation_url || null,
                changelog: item.changelog || null, requirements: item.requirements?.length ? JSON.stringify(item.requirements) : null,
                created_at: now, updated_at: now, encryption_version: 'v1',
              });
              insertLinks(result.lastInsertRowid, rawItem.links);
            }
            continue;
          }

          // Existing item: figure out whether anything actually differs.
          // Compare against the DECRYPTED row - the stored ciphertext carries
          // a random IV, so ciphertext equality is meaningless.
          const current = serializeItem(existing, []);
          const incoming = {
            name: item.name,
            description: item.description,
            long_description: item.long_description,
            category_id: item.category_id ?? (rawItem.category_slug ? null : undefined),
            folder_id: item.folder_id ?? (rawItem.folder_slug ? null : undefined),
            version: item.version,
            release_date: item.release_date,
            file_name: item.file_name,
            file_size: item.file_size,
            file_type: item.file_type,
            platform: item.platform,
            architecture: item.architecture,
            sha256: item.sha256,
            md5: item.md5,
            storage_provider: item.storage_provider,
            storage_path: item.storage_path,
            download_url: item.download_url,
            external_url: item.external_url,
            license_status: item.license_status,
            license_notes: item.license_notes,
            icon_url: item.icon_url,
            image_url: item.image_url,
            documentation_url: item.documentation_url,
            changelog: item.changelog,
            requirements: item.requirements === undefined ? undefined : (item.requirements || []),
            tags: tagsJson === null ? undefined : (Array.isArray(item.tags) ? item.tags : current.tags),
            screenshots: shotsJson === null ? undefined : (Array.isArray(item.screenshots) ? item.screenshots : current.screenshots),
            featured: item.featured === undefined ? undefined : (item.featured ? 1 : 0),
            published: item.published === undefined ? undefined : (item.published ? 1 : 0),
          };

          const changedSets = [];
          for (const [key, value] of Object.entries(incoming)) {
            if (value === undefined) continue;
            if (eqJson(current[key] ?? null, value ?? null)) continue;
            changedSets.push([key, value]);
          }

          const newLinks = Array.isArray(rawItem.links) ? rawItem.links : null;
          let linksChanged = false;
          if (newLinks) {
            const currentLinks = getItemLinksForMany([existing.id])[existing.id] || [];
            const norm = (l) => [l.label, l.storage_provider, l.storage_path || null, l.download_url || null, l.file_size ?? null, l.is_primary ? 1 : 0];
            const curNorm = currentLinks.map(norm);
            const newNorm = newLinks.map(l => norm({ ...l, file_size: l.file_size ?? null }));
            linksChanged = !eqJson(curNorm, newNorm);
          }

          if (changedSets.length === 0 && !linksChanged) {
            report.items.unchanged++;
            continue;
          }

          report.items.updated++;
          if (apply) {
            if (changedSets.length) {
              const params = { id: existing.id };
              const ENCRYPTED = new Set(['storage_path', 'download_url', 'external_url', 'license_notes']);
              const sqlSets = changedSets.map(([k]) => `${k} = @${k}`);
              for (const [k, v] of changedSets) {
                if (k === 'tags' || k === 'screenshots') params[k] = Array.isArray(v) ? JSON.stringify(v) : v;
                else if (k === 'requirements') params[k] = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
                else if (ENCRYPTED.has(k)) params[k] = v ? encryptItemFields({ [k]: v })[k] : null;
                else params[k] = v ?? null;
              }
              sqlSets.push('updated_at = @updated_at');
              params.updated_at = new Date().toISOString();
              db.prepare(`UPDATE items SET ${sqlSets.join(', ')} WHERE id = @id`).run(params);
            }
            if (newLinks && linksChanged) {
              db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(existing.id);
              insertLinks(existing.id, newLinks);
            }
          }
        } catch (e) {
          noteItemError(rawItem.slug || '(no slug)', e.message);
        }
      }

      // --- FAQ: additive only, matched by exact question ---
      for (const faq of data.faq_entries || []) {
        const exists = db.prepare('SELECT id FROM faq_entries WHERE question = ?').get(faq.question);
        if (exists) { report.faq.skipped++; continue; }
        report.faq.created++;
        if (apply) {
          db.prepare('INSERT INTO faq_entries (question, answer, category) VALUES (?, ?, ?)')
            .run(faq.question, faq.answer, faq.category || null);
        }
      }

      // --- settings: only keys that already exist locally, never on dry run ---
      if (data.settings) {
        const local = db.prepare('SELECT key, value FROM site_settings').all();
        const byKey = new Map(local.map(s => [s.key, s.value]));
        for (const [key, value] of Object.entries(data.settings)) {
          if (!byKey.has(key)) continue; // unknown keys belong to a different version
          if (eqJson(byKey.get(key), value)) { report.settings.unchanged++; continue; }
          report.settings.updated++;
          if (apply) {
            db.prepare('UPDATE site_settings SET value = ?, updated_at = ? WHERE key = ?')
              .run(value, new Date().toISOString(), key);
          }
        }
      }
    };

    function insertLinks(itemId, links) {
      if (!Array.isArray(links)) return;
      const stmt = db.prepare(`
        INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
        VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
      `);
      links.forEach((l, i) => {
        const lp = downloadLinkSchema.partial().safeParse(l);
        if (!lp.success || !lp.data.label) return;
        const d = lp.data;
        const enc = encryptLinkFields({ storage_path: d.storage_path || null, download_url: d.download_url || null, down_reason: d.down_reason || null });
        stmt.run({
          item_id: itemId, label: d.label, storage_provider: d.storage_provider || 'external',
          storage_path: enc.storage_path, download_url: enc.download_url,
          file_size: d.file_size ?? null, is_primary: d.is_primary ? 1 : 0,
          is_down: 0, down_reason: enc.down_reason, status: 'unknown', sort_order: d.sort_order ?? i,
        });
      });
    }

    if (apply) {
      try {
        db.transaction(plan)();
      } catch (e) {
        request.log.error(e, 'Import failed');
        return reply.code(500).send({ error: `Import failed, nothing was written: ${e.message}` });
      }
      request.log.info({ report }, 'Backup import applied');
    } else {
      plan();
    }

    return { success: true, ...report };
  });
}
