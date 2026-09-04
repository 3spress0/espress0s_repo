import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { emitEvent } from './eventBus.js';
import { config } from '../config.js';
import { unzip, zip, ZipError } from '../lib/zip.js';
import {
  itemSchema, downloadLinkSchema, externalImageUrlSchema, isExternalUrl, requirementsSchema,
} from '../utils/validation.js';
import {
  serializeItem, getItemLinksForMany, encryptItemFields, encryptLinkFields,
} from './itemSerializer.js';
import { makeSlug } from '../utils/slug.js';
import { loadExistingIndex } from './duplicateDetector.js';

/**
 * Bulk catalogue import / export.
 *
 * The archive is a ZIP holding one `catalog.json`. Everything here follows the
 * conventions `routes/backup.js` already established for the JSON export:
 * idempotent upsert keyed on `slug`, a dry run that reports what *would* happen,
 * `apply` to run the identical plan inside one transaction, and per-item
 * validation errors rather than a single opaque failure.
 *
 * What this adds over the backup format:
 *   - ZIP container, with the safety limits in lib/zip.js
 *   - import modes (add/update, add-only, update-only)
 *   - import history with downloadable validation errors
 *   - a pre-apply database snapshot
 *   - curated relations between related releases
 */

export const CATALOG_FORMAT = 'espress0-catalog';
export const CATALOG_VERSION = 1;
export const CATALOG_FILENAME = 'catalog.json';
export const IMPORT_MODES = ['upsert', 'add-only', 'update-only'];

/** How many errors the HTTP response inlines; the full list stays downloadable. */
export const MAX_INLINE_ERRORS = 50;
/** Hard cap on what is persisted, so a pathological archive cannot fill the disk. */
export const MAX_STORED_ERRORS = 5000;

export class CatalogError extends Error {
  constructor(message, code = 'CATALOG_INVALID') {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const groupSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(10).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  sort_order: z.number().int().optional(),
}).passthrough();

const relationSchema = z.object({
  slug: z.string().min(2).max(200),
  relation: z.enum(['related', 'supersedes', 'superseded-by', 'variant']).default('related'),
  note: z.string().max(500).optional().nullable(),
}).passthrough();

const catalogItemSchema = z.object({
  // The idempotency key. Two entries with the same slug in one archive is a
  // hard error: there is no deterministic way to pick a winner.
  slug: z.string().min(2).max(200),
  name: z.string().min(2).max(200),
  description: z.string().min(5).max(1000),
  long_description: z.string().max(200000).optional().nullable(),
  // Groups are referenced by slug and created on demand, so an archive stays
  // readable without needing the target's numeric ids.
  category: z.string().min(2).max(100).optional().nullable(),
  folder: z.string().min(2).max(100).optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  release_date: z.string().max(40).optional().nullable(),
  file_name: z.string().max(255).optional().nullable(),
  file_size: z.number().int().nonnegative().optional().nullable(),
  file_type: z.string().max(20).optional().nullable(),
  platform: z.string().max(50).optional().nullable(),
  architecture: z.string().max(50).optional().nullable(),
  sha256: z.string().max(128).optional().nullable(),
  md5: z.string().max(64).optional().nullable(),
  status: z.enum(['current', 'legacy', 'deprecated', 'archived', 'unreleased']).optional().nullable(),
  featured: z.boolean().optional(),
  published: z.boolean().optional(),
  license_status: z.enum(['public-domain', 'redistributable', 'proprietary', 'check-license', 'internal-only', 'abandonware']).optional(),
  license_notes: z.string().max(1000).optional().nullable(),
  tags: z.array(z.string().min(1).max(100)).max(100).optional().nullable(),
  // External URLs only: the archive must stay portable and the VM must never
  // become an image store. See externalImageUrlSchema.
  icon_url: externalImageUrlSchema,
  banner_url: externalImageUrlSchema,
  documentation_url: externalImageUrlSchema,
  external_url: externalImageUrlSchema,
  changelog: z.string().max(200000).optional().nullable(),
  requirements: requirementsSchema.optional(),
  links: z.array(downloadLinkSchema.partial()).max(50).optional(),
  related: z.array(relationSchema).max(100).optional(),
}).passthrough();

export const catalogSchema = z.object({
  format: z.literal(CATALOG_FORMAT),
  version: z.literal(CATALOG_VERSION),
  generated_at: z.string().optional(),
  categories: z.array(groupSchema).max(500).optional(),
  folders: z.array(groupSchema).max(500).optional(),
  // Deliberately loose. Validating items here would fail the entire archive
  // over one bad entry; instead each item is validated inside the plan, where
  // a problem becomes one row in the error report and the rest still import.
  items: z.array(z.record(z.string(), z.unknown())).max(20000),
}).passthrough();

// Item columns a catalogue entry may set. Ids, counters and timestamps belong
// to the local database and are deliberately absent.
const IMPORTABLE_ITEM_FIELDS = [
  'description', 'long_description', 'version', 'release_date', 'file_name',
  'file_size', 'file_type', 'platform', 'architecture', 'sha256', 'md5',
  'status', 'storage_provider', 'storage_path', 'download_url', 'external_url',
  'featured', 'published', 'license_status', 'license_notes', 'tags',
  'icon_url', 'banner_url', 'image_url', 'screenshots', 'documentation_url',
  'changelog', 'requirements',
];

const ENCRYPTED_ITEM_COLUMNS = new Set(['storage_path', 'download_url', 'external_url', 'license_notes']);
const eqJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

/** Pick `catalog.json`, preferring the archive root over any nested folder. */
function pickCatalogEntry(entries) {
  const exact = entries.find((e) => e.name === CATALOG_FILENAME);
  if (exact) return exact;
  const nested = entries
    .filter((e) => e.name.endsWith(`/${CATALOG_FILENAME}`))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  return nested[0] || null;
}

/**
 * Unpack and validate a catalogue archive.
 *
 * @param {Buffer} buffer  the uploaded ZIP
 * @param {object} [limits]  overrides for lib/zip.js DEFAULT_LIMITS
 * @returns {{ catalog: object, entryName: string, warnings: string[] }}
 * @throws {CatalogError|ZipError}
 */
export function readCatalogFromZip(buffer, limits = {}) {
  let unzipped;
  try {
    unzipped = unzip(buffer, limits);
  } catch (e) {
    if (e instanceof ZipError) throw new CatalogError(e.message, e.code);
    throw e;
  }

  const entry = pickCatalogEntry(unzipped.entries);
  if (!entry) {
    throw new CatalogError(
      `No ${CATALOG_FILENAME} in the archive (found: ${unzipped.entries.map((e) => e.name).slice(0, 10).join(', ') || 'nothing'})`,
      'CATALOG_MISSING_JSON'
    );
  }

  let raw;
  try {
    raw = JSON.parse(entry.data.toString('utf8'));
  } catch (e) {
    throw new CatalogError(`${CATALOG_FILENAME} is not valid JSON: ${e.message}`, 'CATALOG_BAD_JSON');
  }

  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.errors.slice(0, MAX_INLINE_ERRORS)
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`);
    const err = new CatalogError(
      `Catalogue failed validation (${parsed.error.errors.length} problem${parsed.error.errors.length === 1 ? '' : 's'}): ${details.slice(0, 5).join('; ')}`,
      'CATALOG_SCHEMA'
    );
    err.details = details;
    throw err;
  }

  const catalog = parsed.data;
  const warnings = [...unzipped.warnings];

  // Duplicate slugs make "idempotent by slug" meaningless, so refuse up front
  // instead of silently letting the last entry win.
  const seen = new Map();
  for (const [i, item] of catalog.items.entries()) {
    const key = makeSlug(item.slug);
    if (!key) throw new CatalogError(`items[${i}] has a slug that normalises to nothing ("${item.slug}")`, 'CATALOG_BAD_SLUG');
    if (seen.has(key)) {
      throw new CatalogError(`Duplicate slug "${key}" at items[${seen.get(key)}] and items[${i}]`, 'CATALOG_DUPLICATE_SLUG');
    }
    seen.set(key, i);
  }

  // Flag keys we do not know about: almost always a typo, and silently ignoring
  // one means the admin's data quietly does not arrive.
  const known = new Set(Object.keys(catalogItemSchema.shape));
  const unknown = new Set();
  for (const item of catalog.items) {
    for (const key of Object.keys(item)) if (!known.has(key)) unknown.add(key);
  }
  if (unknown.size) warnings.push(`unknown field(s) ignored: ${[...unknown].slice(0, 10).join(', ')}`);

  return { catalog, entryName: entry.name, warnings };
}

// ---------------------------------------------------------------------------
// Pre-apply snapshot
// ---------------------------------------------------------------------------

/**
 * Copy the live database before applying an import.
 *
 * better-sqlite3's online backup is the same mechanism `scripts/backup.sh`
 * uses via `sqlite3 .backup`; `VACUUM INTO` is the fallback for builds without
 * it. Returns the absolute path, or null if snapshots are disabled.
 *
 * @returns {Promise<string|null>}
 */
export async function snapshotDatabase(label) {
  if (process.env.CATALOG_BACKUP === 'false') return null;
  const dir = config.backupDir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${label}-${stamp}.db`);
  const db = getDb();
  try {
    await db.backup(target);
  } catch (e) {
    db.pragma(`wal_checkpoint(FULL)`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function newReport(mode, dryRun) {
  return {
    dryRun,
    mode,
    categories: { created: 0, updated: 0, unchanged: 0 },
    folders: { created: 0, updated: 0, unchanged: 0 },
    items: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
    relations: { created: 0, unchanged: 0, skipped: 0 },
    errors: [],
    errorCount: 0,
    // Possible duplicates among entries that would be CREATED: an existing
    // row or an earlier archive entry with a near-identical name/slug/version.
    duplicates: [],
    duplicateCount: 0,
  };
}

export const MAX_STORED_DUPLICATES = 500;

/**
 * Walk a catalogue and either report or write it.
 *
 * @param {object} catalog  validated catalogue
 * @param {{ mode: string, apply: boolean }} options
 * @returns {object} report
 */
export function runCatalogPlan(catalog, { mode = 'upsert', apply = false, detectDuplicates = true } = {}) {
  if (!IMPORT_MODES.includes(mode)) throw new CatalogError(`Unknown import mode "${mode}"`, 'CATALOG_BAD_MODE');

  const db = getDb();
  const report = newReport(mode, !apply);

  // Fuzzy duplicate check for entries about to be created. Slug identity
  // stays the rule for what gets written; this only warns, it never blocks.
  const dupIndex = detectDuplicates && mode !== 'update-only' ? loadExistingIndex(db) : null;
  const noteDuplicates = (entry, slug) => {
    if (!dupIndex) return;
    const matches = dupIndex.find({ name: entry.name, slug, version: entry.version ?? null }, { exclude: (r) => r.slug === slug });
    if (matches.length) {
      report.duplicateCount++;
      if (report.duplicates.length < MAX_STORED_DUPLICATES) {
        report.duplicates.push({
          slug, name: entry.name, version: entry.version ?? null,
          matches: matches.map((m) => ({ slug: m.slug, name: m.name, version: m.version, level: m.level, reason: m.reason, existing: m.id !== null })),
        });
      }
    }
    // Later entries in the same archive are compared against this one too.
    dupIndex.add({ id: null, slug, name: entry.name, version: entry.version ?? null });
  };

  const noteError = (slug, message, field) => {
    report.errorCount++;
    if (report.errors.length < MAX_STORED_ERRORS) {
      report.errors.push({ slug: slug || '(no slug)', field: field || null, error: String(message).slice(0, 500) });
    }
  };

  /** Create a category/folder on demand and return its id. */
  function ensureGroup(table, counter, nameOrSlug) {
    const slug = makeSlug(nameOrSlug);
    if (!slug) return null;
    const existing = db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).get(slug);
    if (existing) return existing.id;
    if (!apply) {
      report[counter].created++;
      return null; // no id yet; the caller treats the item as new
    }
    const name = String(nameOrSlug).slice(0, 100);
    const result = db.prepare(`INSERT INTO ${table} (name, slug, description, sort_order) VALUES (?, ?, ?, 0)`)
      .run(name, slug, null);
    report[counter].created++;
    return Number(result.lastInsertRowid);
  }

  /** Upsert one group row from the archive's optional categories/folders list. */
  function upsertGroup(table, counter, row) {
    const slug = makeSlug(row.slug || row.name);
    if (!slug) return;
    const existing = db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).get(slug);
    if (!existing) {
      report[counter].created++;
      if (apply) {
        db.prepare(`INSERT INTO ${table} (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(row.name, slug, row.description || null, row.icon || null, row.color || null, row.sort_order ?? 0);
      }
      return;
    }
    const changed = !eqJson(existing.name, row.name)
      || (row.description !== undefined && !eqJson(existing.description ?? null, row.description ?? null))
      || (row.icon !== undefined && !eqJson(existing.icon ?? null, row.icon ?? null))
      || (row.color !== undefined && !eqJson(existing.color ?? null, row.color ?? null));
    if (!changed) { report[counter].unchanged++; return; }
    report[counter].updated++;
    if (apply) {
      const sets = 'name = ?, description = ?, icon = ?, color = ?, sort_order = COALESCE(?, sort_order)'
        + (table === 'folders' ? ', updated_at = ?' : '');
      const args = [row.name, row.description ?? null, row.icon ?? null, row.color ?? null, row.sort_order ?? null];
      if (table === 'folders') args.push(new Date().toISOString());
      db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...args, existing.id);
    }
  }

  function insertLinks(itemId, links) {
    if (!Array.isArray(links) || !links.length) return;
    const stmt = db.prepare(`
      INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, status, sort_order)
      VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, 0, 'unknown', @sort_order)
    `);
    links.forEach((l, i) => {
      const parsed = downloadLinkSchema.partial().safeParse(l);
      if (!parsed.success || !parsed.data.label) {
        noteError(null, `link ${i} is not valid: ${parsed.success ? 'missing label' : parsed.error.errors[0]?.message}`, 'links');
        return;
      }
      const d = parsed.data;
      const enc = encryptLinkFields({
        storage_path: d.storage_path || null,
        download_url: d.download_url || null,
      });
      stmt.run({
        item_id: itemId,
        label: d.label,
        storage_provider: d.storage_provider || 'external',
        storage_path: enc.storage_path,
        download_url: enc.download_url,
        file_size: d.file_size ?? null,
        is_primary: d.is_primary ? 1 : 0,
        sort_order: d.sort_order ?? i,
      });
    });
  }

  const plan = () => {
    for (const row of catalog.categories || []) upsertGroup('categories', 'categories', row);
    for (const row of catalog.folders || []) upsertGroup('folders', 'folders', row);

    // Slug -> id, refreshed after the group upserts above.
    const categoryIdBySlug = new Map(db.prepare('SELECT id, slug FROM categories').all().map((c) => [c.slug, c.id]));
    const folderIdBySlug = new Map(db.prepare('SELECT id, slug FROM folders').all().map((f) => [f.slug, f.id]));

    for (const [index, entry] of (catalog.items || []).entries()) {
      const rawSlug = entry.slug;
      const slug = makeSlug(rawSlug);
      // Errors quote the slug as the admin wrote it, so it can be found in
      // their file even when makeSlug would rewrite it.
      const errorSlug = rawSlug || slug;
      try {
        // Match the exact slug first, then the normalised one. makeSlug() is
        // not idempotent - it strips dots, so "7zip-18.06" normalises to
        // "7zip-1806" - and looking up only the normalised form would miss the
        // existing row and create a duplicate on every import.
        let existing = db.prepare('SELECT * FROM items WHERE slug = ?').get(rawSlug);
        if (!existing && slug !== rawSlug) {
          existing = db.prepare('SELECT * FROM items WHERE slug = ?').get(slug);
        }

        // --- mode gate -----------------------------------------------------
        if (existing && mode === 'add-only') { report.items.skipped++; continue; }
        if (!existing && mode === 'update-only') { report.items.skipped++; continue; }

        // Images must be external. Report it, drop the value and carry on: one
        // bad icon should not lose the whole entry, and a local path must never
        // reach the database.
        const entryClean = { ...entry };
        for (const field of ['icon_url', 'banner_url']) {
          const value = entryClean[field];
          if (value && !isExternalUrl(value)) {
            noteError(errorSlug, `${field} must be an external http(s) URL (got "${String(value).slice(0, 80)}") - images are never stored locally`, field);
            entryClean[field] = null;
          }
        }

        // Per-entry catalogue validation. A failure here is one row in the
        // error report, not a rejected archive.
        const entryParsed = catalogItemSchema.safeParse(entryClean);
        if (!entryParsed.success) {
          noteError(errorSlug, entryParsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '));
          continue;
        }
        const valid = entryParsed.data;

        // Then through itemSchema, so coercion and limits match the admin
        // editor exactly and an archive cannot store what the UI could not.
        const candidate = {};
        for (const key of ['name', 'slug', ...IMPORTABLE_ITEM_FIELDS]) {
          if (valid[key] !== undefined) candidate[key] = valid[key];
        }
        candidate.slug = slug;
        candidate.tags = valid.tags ?? undefined;
        candidate.status = valid.status ?? undefined;
        candidate.banner_url = valid.banner_url ?? undefined;
        candidate.icon_url = valid.icon_url ?? undefined;

        const parsed = itemSchema.partial().safeParse(candidate);
        if (!parsed.success) {
          noteError(errorSlug, parsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '));
          continue;
        }
        const item = parsed.data;
        item.name = entry.name;
        item.slug = slug;

        // Groups referenced by slug; created on demand so an archive from
        // another install imports cleanly.
        let groupWillBeCreated = false;
        if (valid.category) {
          const key = makeSlug(valid.category);
          const id = categoryIdBySlug.get(key) ?? ensureGroup('categories', 'categories', valid.category);
          if (id) { item.category_id = id; categoryIdBySlug.set(key, id); }
          else groupWillBeCreated = true; // dry run: created when applied
        }
        if (valid.folder) {
          const key = makeSlug(valid.folder);
          const id = folderIdBySlug.get(key) ?? ensureGroup('folders', 'folders', valid.folder);
          if (id) { item.folder_id = id; folderIdBySlug.set(key, id); }
          else groupWillBeCreated = true;
        }

        const tagsJson = Array.isArray(item.tags) ? JSON.stringify(item.tags) : null;
        const enc = encryptItemFields({
          storage_path: item.storage_path || null,
          download_url: item.download_url || null,
          external_url: item.external_url || null,
          license_notes: item.license_notes || null,
        });

        // --- create --------------------------------------------------------
        if (!existing) {
          noteDuplicates(item, slug);
          report.items.created++;
          if (apply) {
            const now = new Date().toISOString();
            const result = db.prepare(`
              INSERT INTO items (
                name, slug, description, long_description, category_id, folder_id, version, release_date,
                file_name, file_size, file_type, platform, architecture, sha256, md5, status,
                storage_provider, storage_path, download_url, external_url,
                featured, published, license_status, license_notes, tags, icon_url, banner_url, image_url, screenshots,
                documentation_url, changelog, requirements, created_at, updated_at, encryption_version
              ) VALUES (
                @name, @slug, @description, @long_description, @category_id, @folder_id, @version, @release_date,
                @file_name, @file_size, @file_type, @platform, @architecture, @sha256, @md5, @status,
                @storage_provider, @storage_path, @download_url, @external_url,
                @featured, @published, @license_status, @license_notes, @tags, @icon_url, @banner_url, @image_url, @screenshots,
                @documentation_url, @changelog, @requirements, @created_at, @updated_at, @encryption_version
              )`).run({
              name: item.name, slug: item.slug,
              description: item.description, long_description: item.long_description || null,
              category_id: item.category_id ?? null, folder_id: item.folder_id ?? null,
              version: item.version || null, release_date: item.release_date || null,
              file_name: item.file_name || null, file_size: item.file_size ?? null,
              file_type: item.file_type || null, platform: item.platform || null,
              architecture: item.architecture || null, sha256: item.sha256 || null, md5: item.md5 || null,
              status: item.status || 'current',
              storage_provider: item.storage_provider || 'external',
              storage_path: enc.storage_path, download_url: enc.download_url, external_url: enc.external_url,
              featured: item.featured ? 1 : 0,
              published: item.published === undefined ? 1 : (item.published ? 1 : 0),
              license_status: item.license_status || 'check-license', license_notes: enc.license_notes,
              tags: tagsJson, icon_url: item.icon_url || null, banner_url: item.banner_url || null,
              image_url: item.image_url || null, screenshots: item.screenshots ? JSON.stringify(item.screenshots) : null,
              documentation_url: item.documentation_url || null, changelog: item.changelog || null,
              requirements: item.requirements?.length ? JSON.stringify(item.requirements) : null,
              created_at: now, updated_at: now, encryption_version: 'v1',
            });
            insertLinks(Number(result.lastInsertRowid), valid.links);
          }
          continue;
        }

        // --- update --------------------------------------------------------
        // Compare against the DECRYPTED row: stored ciphertext carries a random
        // IV, so ciphertext equality proves nothing.
        const current = serializeItem(existing, []);
        const incoming = {
          name: item.name,
          description: item.description,
          long_description: item.long_description ?? undefined,
          version: item.version ?? undefined,
          release_date: item.release_date ?? undefined,
          file_name: item.file_name ?? undefined,
          file_size: item.file_size ?? undefined,
          file_type: item.file_type ?? undefined,
          platform: item.platform ?? undefined,
          architecture: item.architecture ?? undefined,
          sha256: item.sha256 ?? undefined,
          md5: item.md5 ?? undefined,
          status: item.status ?? undefined,
          storage_provider: item.storage_provider ?? undefined,
          storage_path: item.storage_path ?? undefined,
          download_url: item.download_url ?? undefined,
          external_url: item.external_url ?? undefined,
          license_status: item.license_status ?? undefined,
          license_notes: item.license_notes ?? undefined,
          icon_url: item.icon_url ?? undefined,
          banner_url: item.banner_url ?? undefined,
          image_url: item.image_url ?? undefined,
          documentation_url: item.documentation_url ?? undefined,
          changelog: item.changelog ?? undefined,
          requirements: item.requirements === undefined ? undefined : (item.requirements || []),
          featured: item.featured === undefined ? undefined : (item.featured ? 1 : 0),
          published: item.published === undefined ? undefined : (item.published ? 1 : 0),
          tags: tagsJson === null ? undefined : item.tags,
        };
        if (item.category_id !== undefined) incoming.category_id = item.category_id;
        if (item.folder_id !== undefined) incoming.folder_id = item.folder_id;

        const changedSets = [];
        for (const [key, value] of Object.entries(incoming)) {
          if (value === undefined) continue;
          if (eqJson(current[key] ?? null, value ?? null)) continue;
          changedSets.push([key, value]);
        }

        const newLinks = Array.isArray(valid.links) ? valid.links : null;
        let linksChanged = false;
        if (newLinks) {
          const currentLinks = getItemLinksForMany([existing.id])[existing.id] || [];
          const norm = (l) => [l.label, l.storage_provider, l.storage_path || null, l.download_url || null, l.file_size ?? null, l.is_primary ? 1 : 0];
          linksChanged = !eqJson(currentLinks.map(norm), newLinks.map((l) => norm({ ...l, file_size: l.file_size ?? null })));
        }

        // A group this archive will create has no id yet in a dry run, so the
        // field comparison above cannot see the change it would cause.
        if (!changedSets.length && !linksChanged && !groupWillBeCreated) {
          report.items.unchanged++;
        } else {
          report.items.updated++;
          if (apply) {
            if (changedSets.length) {
              const params = { id: existing.id };
              const sqlSets = changedSets.map(([k]) => `${k} = @${k}`);
              for (const [k, v] of changedSets) {
                if (k === 'tags') params[k] = Array.isArray(v) ? JSON.stringify(v) : v;
                else if (k === 'requirements') params[k] = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
                else if (ENCRYPTED_ITEM_COLUMNS.has(k)) params[k] = v ? encryptItemFields({ [k]: v })[k] : null;
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
        }
      } catch (e) {
        noteError(slug || rawSlug || `items[${index}]`, e.message);
      }
    }

    // --- relations, resolved after every item exists so forward references work
    const idBySlug = new Map(db.prepare('SELECT id, slug FROM items').all().map((i) => [i.slug, i.id]));
    // Slugs this archive defines, so a dry run can tell "the target does not
    // exist" from "the target is created earlier in this same archive".
    const catalogSlugs = new Set((catalog.items || []).map((i) => makeSlug(i.slug)));
    for (const entry of catalog.items || []) {
      if (!Array.isArray(entry.related) || !entry.related.length) continue;
      const slug = makeSlug(entry.slug);
      const fromId = idBySlug.get(slug);
      // In a dry run neither end of a relation exists yet when this archive is
      // what creates them, so "will exist" has to be reasoned about, not read.
      const willExist = (id, s) => !!id || (!apply && mode !== 'update-only' && catalogSlugs.has(s));

      if (!willExist(fromId, slug)) { report.relations.skipped += entry.related.length; continue; }

      for (const rel of entry.related) {
        const toSlug = makeSlug(rel.slug);
        const toId = idBySlug.get(toSlug);
        if (!willExist(toId, toSlug)) {
          noteError(entry.slug, `related slug "${rel.slug}" does not exist and was not created by this archive`, 'related');
          report.relations.skipped++;
          continue;
        }
        if (toSlug === slug) {
          noteError(entry.slug, 'an item cannot be related to itself', 'related');
          report.relations.skipped++;
          continue;
        }
        if (!apply || !fromId || !toId) { report.relations.created++; continue; }
        const existingRel = db.prepare('SELECT * FROM item_relations WHERE item_id = ? AND related_item_id = ?').get(fromId, toId);
        if (existingRel) { report.relations.unchanged++; continue; }
        report.relations.created++;
        db.prepare(`INSERT INTO item_relations (item_id, related_item_id, relation, note, sort_order)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(fromId, toId, rel.relation || 'related', rel.note || null, 0);
      }
    }
  };

  plan();
  return report;
}

/**
 * Full import: validate, snapshot, apply in one transaction, record history.
 *
 * @returns {Promise<{ report: object, history: object }>}
 */
export async function importCatalogArchive({ buffer, filename = 'catalog.zip', mode = 'upsert', apply = false, userId = null }) {
  const db = getDb();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const startedAt = new Date().toISOString();

  const historyId = Number(db.prepare(`
    INSERT INTO catalog_imports (filename, sha256, size_bytes, mode, status, dry_run, imported_by, started_at)
    VALUES (?, ?, ?, ?, 'ok', ?, ?, ?)
  `).run(filename, sha256, buffer.length, mode, apply ? 0 : 1, userId, startedAt).lastInsertRowid);

  const finish = (status, report, backupPath = null) => {
    db.prepare(`
      UPDATE catalog_imports SET
        status = ?, items_created = ?, items_updated = ?, items_unchanged = ?, items_skipped = ?,
        relations_created = ?, error_count = ?, errors_json = ?, backup_path = ?, duplicate_count = ?,
        catalog_format = ?, catalog_version = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      report?.items.created ?? 0, report?.items.updated ?? 0, report?.items.unchanged ?? 0, report?.items.skipped ?? 0,
      report?.relations.created ?? 0, report?.errorCount ?? 0,
      report ? JSON.stringify(report.errors) : null, backupPath, report?.duplicateCount ?? 0,
      CATALOG_FORMAT, CATALOG_VERSION, new Date().toISOString(), historyId,
    );
    const row = db.prepare('SELECT * FROM catalog_imports WHERE id = ?').get(historyId);
    // Applied imports are announced; previews and rejections are not.
    if (apply && status === 'ok' && report) {
      const { errors_json, backup_path, ...publicRow } = row;
      emitEvent('import.completed', { import: publicRow }, { actorId: userId });
    }
    return row;
  };

  let catalog;
  let warnings = [];
  try {
    ({ catalog, warnings } = readCatalogFromZip(buffer));
  } catch (e) {
    const report = newReport(mode, !apply);
    report.errors.push({ slug: null, field: null, error: e.message });
    report.errorCount = 1;
    const history = finish(e instanceof CatalogError || e instanceof ZipError ? 'rejected' : 'failed', report);
    const err = e instanceof CatalogError || e instanceof ZipError
      ? new CatalogError(e.message, e.code || 'CATALOG_INVALID')
      : e;
    err.details = e.details;
    err.history = history;
    throw err;
  }

  db.prepare('UPDATE catalog_imports SET catalog_format = ?, catalog_version = ? WHERE id = ?')
    .run(CATALOG_FORMAT, CATALOG_VERSION, historyId);

  // Snapshot before touching anything, so a bad archive is recoverable without
  // waiting for the nightly cron.
  let backupPath = null;
  if (apply) {
    try {
      backupPath = await snapshotDatabase(`pre-catalog-import-${historyId}`);
    } catch (e) {
      const report = newReport(mode, false);
      report.errors.push({ slug: null, field: null, error: `Could not create the pre-import database backup: ${e.message}` });
      report.errorCount = 1;
      finish('failed', report);
      throw new CatalogError(`Refusing to import without a database backup: ${e.message}`, 'CATALOG_BACKUP_FAILED');
    }
  }

  let report;
  try {
    if (apply) {
      // The plan writes as it walks, so the whole walk has to sit inside one
      // transaction: a failure halfway through a 2 000-item archive must leave
      // the database exactly as it was rather than half-imported.
      report = db.transaction(() => runCatalogPlan(catalog, { mode, apply: true }))();
    } else {
      report = runCatalogPlan(catalog, { mode, apply: false });
    }
  } catch (e) {
    // Attach the history row so the caller (and the HTTP response) can point at
    // the recorded failure and its error file.
    e.history = finish('failed', newReport(mode, !apply), backupPath);
    throw e;
  }

  const history = finish('ok', report, backupPath);
  return { report: { ...report, warnings }, history };
}

// ---------------------------------------------------------------------------
// Export + template
// ---------------------------------------------------------------------------

/**
 * True when a value can legally appear in a catalogue URL field.
 *
 * App-relative paths are allowed because downloadLinkSchema accepts them; the
 * point is to keep out values that are not URLs at all.
 */
function isCatalogSafeUrl(value) {
  if (typeof value !== 'string' || !value) return true;
  return isExternalUrl(value) || /^\/[A-Za-z0-9._~/-]*$/.test(value);
}

/** Shape one DB row as a catalogue entry. */
function toCatalogEntry(row, links) {
  const s = serializeItem(row, links);
  const entry = {
    slug: s.slug,
    name: s.name,
    description: s.description || '',
    long_description: s.long_description || null,
    category: row.category_slug || null,
    folder: row.folder_slug || null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    platform: s.platform || null,
    architecture: s.architecture || null,
    status: s.status || 'current',
    version: s.version || null,
    release_date: s.release_date || null,
    file_name: s.file_name || null,
    file_size: s.file_size ?? null,
    file_type: s.file_type || null,
    sha256: s.sha256 || null,
    md5: s.md5 || null,
    featured: !!s.featured,
    published: !!s.published,
    license_status: s.license_status || 'check-license',
    license_notes: s.license_notes || null,
    storage_provider: s.storage_provider || 'external',
    storage_path: s.storage_path || null,
    download_url: s.download_url || null,
    external_url: s.external_url || null,
    documentation_url: s.documentation_url || null,
    changelog: s.changelog || null,
    requirements: Array.isArray(s.requirements) ? s.requirements : [],
    icon_url: s.icon_url || null,
    banner_url: s.banner_url || null,
    links: (s.download_links || []).map((l) => ({
      label: l.label,
      storage_provider: l.storage_provider,
      storage_path: l.storage_path || null,
      download_url: l.download_url || null,
      file_size: l.file_size ?? null,
      is_primary: !!l.is_primary,
      sort_order: l.sort_order ?? 0,
    })),
  };
  return entry;
}

/**
 * Build the catalogue document from the live database.
 *
 * @returns {{ catalog: object, warnings: string[] }}
 */
export function buildCatalog() {
  const db = getDb();
  const warnings = [];

  const categories = db.prepare('SELECT name, slug, description, icon, color, sort_order FROM categories ORDER BY sort_order, name').all();
  const folders = db.prepare('SELECT name, slug, description, icon, color, sort_order FROM folders ORDER BY sort_order, name').all();

  const rows = db.prepare(`
    SELECT items.*, categories.slug AS category_slug, folders.slug AS folder_slug
    FROM items
    LEFT JOIN categories ON categories.id = items.category_id
    LEFT JOIN folders ON folders.id = items.folder_id
    ORDER BY items.id
  `).all();
  const linksByItem = getItemLinksForMany(rows.map((r) => r.id));

  // Relations, expressed as slugs so the archive is id-independent.
  const relRows = db.prepare(`
    SELECT a.slug AS from_slug, b.slug AS to_slug, r.relation, r.note
    FROM item_relations r
    JOIN items a ON a.id = r.item_id
    JOIN items b ON b.id = r.related_item_id
  `).all();
  const relBySlug = new Map();
  for (const r of relRows) {
    if (!relBySlug.has(r.from_slug)) relBySlug.set(r.from_slug, []);
    relBySlug.get(r.from_slug).push({ slug: r.to_slug, relation: r.relation, note: r.note });
  }

  let droppedImages = 0;
  const droppedUrls = new Map();
  const items = rows.map((row) => {
    const entry = toCatalogEntry(row, linksByItem[row.id] || []);
    // A locally uploaded icon would not resolve on another install, and the
    // importer rejects it, so leave it out rather than produce an archive that
    // cannot be re-imported.
    for (const field of ['icon_url', 'banner_url']) {
      if (entry[field] && !isExternalUrl(entry[field])) { entry[field] = null; droppedImages++; }
    }
    // URL fields holding something that is not a URL at all (the seed data has
    // stored stringified functions in these) are left exactly as they are:
    // dropping them would silently rewrite the database on the next import.
    // They are counted and reported so the admin can fix the rows, and the
    // importer will refuse those entries until they do.
    for (const field of ['external_url', 'documentation_url', 'download_url']) {
      if (!isCatalogSafeUrl(entry[field])) {
        droppedUrls.set(field, (droppedUrls.get(field) || 0) + 1);
      }
    }
    for (const link of entry.links) {
      if (!isCatalogSafeUrl(link.download_url)) {
        droppedUrls.set('links.download_url', (droppedUrls.get('links.download_url') || 0) + 1);
      }
    }
    const related = relBySlug.get(entry.slug);
    if (related) entry.related = related;
    return entry;
  });
  if (droppedImages) {
    warnings.push(`${droppedImages} locally stored image reference(s) omitted - catalogues only carry external http(s) URLs`);
  }
  for (const [field, count] of droppedUrls) {
    warnings.push(`${count} ${field} value(s) are not valid URLs and will be rejected on import - fix those rows in the admin editor`);
  }

  return {
    catalog: {
      format: CATALOG_FORMAT,
      version: CATALOG_VERSION,
      generated_at: new Date().toISOString(),
      counts: { items: items.length, categories: categories.length, folders: folders.length },
      categories,
      folders,
      items,
    },
    warnings,
  };
}

/**
 * @returns {{ buffer: Buffer, warnings: string[] }} a `catalog.zip`
 */
export function buildCatalogZip() {
  const { catalog, warnings } = buildCatalog();
  const buffer = zip([
    { name: CATALOG_FILENAME, data: JSON.stringify(catalog, null, 2) },
    { name: 'README.md', data: TEMPLATE_README },
  ]);
  return { buffer, warnings };
}

const TEMPLATE_README = `# espress0's repo - catalogue archive

Unzip and edit \`catalog.json\`, then re-zip and upload it under
Admin -> Catalogue.

* \`slug\` is the identity of an entry. Importing the same slug twice updates
  the existing item instead of creating a second one, so re-running an import
  is safe.
* Import runs as a preview first: nothing is written until you confirm.
* \`icon_url\` and \`banner_url\` must be external http(s) URLs. Images are
  never copied into the archive or stored on the server.
* \`long_description\` accepts Markdown and may be long.
* \`related\` links one entry to another by slug, e.g. to mark that 24.04
  supersedes 22.04.
* Get a filled-in starting point from Admin -> Catalogue -> Download template,
  or export your current catalogue and edit that.
`;

const TEMPLATE_ITEM = {
  slug: 'ubuntu-24-04-lts-desktop',
  name: 'Ubuntu 24.04 LTS Desktop',
  description: 'Long-term-support Ubuntu desktop installer image.',
  long_description: [
    '## Overview',
    '',
    'Ubuntu 24.04 LTS desktop installer, amd64.',
    '',
    '## What you get',
    '',
    '- Bootable ISO image',
    '- SHA-256 checksum for verification',
    '',
    '## Requirements',
    '',
    '- 64-bit x86 processor',
    '- 4 GB RAM minimum',
    '',
    '## Notes',
    '',
    'Verify the checksum before writing the image.',
  ].join('\n'),
  category: 'operating-systems',
  folder: null,
  tags: ['linux', 'ubuntu', 'lts'],
  platform: 'linux',
  architecture: 'x64',
  status: 'current',
  version: '24.04.1',
  release_date: '2024-08-29',
  file_name: 'ubuntu-24.04.1-desktop-amd64.iso',
  file_size: 5905580032,
  file_type: 'iso',
  sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  md5: null,
  featured: false,
  published: true,
  license_status: 'redistributable',
  icon_url: 'https://assets.ubuntu.com/v1/49a1a858-favicon-32x32.png',
  banner_url: null,
  documentation_url: 'https://ubuntu.com/tutorials',
  external_url: 'https://releases.ubuntu.com/24.04/',
  links: [
    {
      label: 'Ubuntu releases',
      storage_provider: 'external',
      download_url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04.1-desktop-amd64.iso',
      is_primary: true,
      sort_order: 0,
    },
  ],
  related: [{ slug: 'ubuntu-22-04-lts-desktop', relation: 'supersedes', note: 'Previous LTS' }],
};

/**
 * A starter archive: one fully-populated example entry plus notes, so an admin
 * has a valid file to edit rather than an empty schema to guess at.
 *
 * @returns {Buffer} a `catalog-template.zip`
 */
export function buildTemplateZip() {
  const catalog = {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    counts: { items: 2, categories: 1, folders: 0 },
    categories: [{ name: 'Operating Systems', slug: 'operating-systems', description: 'OS distributions, installers, and recovery media' }],
    folders: [],
    items: [
      TEMPLATE_ITEM,
      {
        ...TEMPLATE_ITEM,
        slug: 'ubuntu-22-04-lts-desktop',
        name: 'Ubuntu 22.04 LTS Desktop',
        description: 'Previous long-term-support Ubuntu desktop installer image.',
        version: '22.04.5',
        release_date: '2024-09-12',
        status: 'legacy',
        file_name: 'ubuntu-22.04.5-desktop-amd64.iso',
        related: [{ slug: 'ubuntu-24-04-lts-desktop', relation: 'superseded-by' }],
      },
    ],
  };
  return zip([
    { name: CATALOG_FILENAME, data: JSON.stringify(catalog, null, 2) },
    { name: 'README.md', data: TEMPLATE_README },
  ]);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Recent imports, newest first, without the bulky error payloads. */
export function listImports(limit = 50) {
  const db = getDb();
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  // Join the admin who ran it: the history is meant to answer "who imported
  // what, when", and a bare user id answers none of that.
  return db.prepare(`
    SELECT i.id, i.filename, i.sha256, i.size_bytes, i.mode, i.status, i.dry_run,
           i.items_created, i.items_updated, i.items_unchanged, i.items_skipped,
           i.relations_created, i.error_count, i.backup_path, i.catalog_format, i.catalog_version,
           i.imported_by, i.started_at, i.finished_at,
           u.username AS imported_by_name
    FROM catalog_imports i LEFT JOIN users u ON u.id = i.imported_by
    ORDER BY i.id DESC LIMIT ?
  `).all(capped);
}

/** One import including its stored errors. */
export function getImport(id) {
  const db = getDb();
  const row = db.prepare(`
    SELECT i.*, u.username AS imported_by_name
    FROM catalog_imports i LEFT JOIN users u ON u.id = i.imported_by
    WHERE i.id = ?
  `).get(Number(id));
  if (!row) return null;
  let errors = [];
  try { errors = row.errors_json ? JSON.parse(row.errors_json) : []; } catch { errors = []; }
  return { ...row, errors };
}
