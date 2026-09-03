import { getDb } from '../db/index.js';
import { buildFtsQuery } from './searchService.js';
import { serializeItem, getItemLinksForMany } from './itemSerializer.js';

/**
 * Admin catalogue queries: the filter/sort/search surface behind
 * Admin -> File pages, plus the statistics for the admin dashboard.
 *
 * Search goes through the same FTS5 index and the same query builder as the
 * public search (`buildFtsQuery` sanitises tokens because FTS5 has no bound
 * parameters inside a MATCH string). What this adds over `searchService` is the
 * admin-only filter set - status, version, release window, storage provider,
 * missing images and link health - and sorting on columns the public list does
 * not expose.
 */

const ITEM_STATUSES = ['current', 'legacy', 'deprecated', 'archived', 'unreleased'];
const LINK_HEALTH_VALUES = ['up', 'down', 'unknown', 'checking', 'missing'];
const STORAGE_PROVIDERS = ['local', 'gdrive', 'onedrive', 'github', 'external'];

/** Allow-listed so a `?sort=` value can never reach the ORDER BY clause. */
const SORT_COLUMNS = {
  name: 'items.name',
  slug: 'items.slug',
  created_at: 'items.created_at',
  updated_at: 'items.updated_at',
  release_date: 'items.release_date',
  file_size: 'items.file_size',
  download_count: 'items.download_count',
  view_count: 'items.view_count',
  status: 'items.status',
  version: 'items.version',
};

const one = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v, max = 200) => {
  const s = one(v);
  return s === undefined || s === null || s === '' ? null : String(s).slice(0, max);
};
/**
 * YYYY-MM-DD that is also a real date. A shape-only regex happily accepts
 * 2024-13-99, which then compares against release_date as a nonsense string.
 */
const isValidDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const bool = (v) => {
  const s = one(v);
  if (s === undefined || s === null || s === '') return null;
  return s === true || s === 'true' || s === '1' || s === 1;
};

/**
 * Build the WHERE clause for a catalogue query.
 *
 * @returns {{ conditions: string[], params: object, ftsQuery: string|null }}
 */
export function buildCatalogFilters(query = {}) {
  const conditions = [];
  const params = {};

  const status = str(query.status, 40);
  if (status) {
    if (!ITEM_STATUSES.includes(status)) throw new Error(`status must be one of: ${ITEM_STATUSES.join(', ')}`);
    conditions.push('items.status = @status');
    params.status = status;
  }

  const platform = str(query.platform, 60);
  if (platform) { conditions.push('LOWER(items.platform) = LOWER(@platform)'); params.platform = platform; }

  const architecture = str(query.architecture, 60);
  if (architecture) { conditions.push('LOWER(items.architecture) = LOWER(@architecture)'); params.architecture = architecture; }

  const version = str(query.version, 100);
  if (version) { conditions.push('items.version = @version'); params.version = version; }

  const fileType = str(query.file_type, 30);
  if (fileType) { conditions.push('LOWER(items.file_type) = LOWER(@file_type)'); params.file_type = fileType; }

  const provider = str(query.storage_provider, 30);
  if (provider) {
    if (!STORAGE_PROVIDERS.includes(provider)) throw new Error(`storage_provider must be one of: ${STORAGE_PROVIDERS.join(', ')}`);
    conditions.push('items.storage_provider = @storage_provider');
    params.storage_provider = provider;
  }

  // Groups accept a slug or a numeric id, matching the public search behaviour.
  const category = str(query.category, 120);
  if (category) {
    if (/^\d+$/.test(category)) { conditions.push('items.category_id = @category_id'); params.category_id = Number(category); }
    else { conditions.push('categories.slug = @category_slug'); params.category_slug = category; }
  }

  const folder = str(query.folder, 120);
  if (folder === 'none') {
    conditions.push('items.folder_id IS NULL');
  } else if (folder) {
    if (/^\d+$/.test(folder)) { conditions.push('items.folder_id = @folder_id'); params.folder_id = Number(folder); }
    else { conditions.push('folders.slug = @folder_slug'); params.folder_slug = folder; }
  }

  // tags is stored as a JSON array in a TEXT column; match the quoted token so
  // "iso" does not also match "isometric".
  const tag = str(query.tag, 100);
  if (tag) {
    conditions.push(`items.tags LIKE @tag_pattern`);
    params.tag_pattern = `%"${tag.replace(/[%_"]/g, '')}"%`;
  }

  const releaseFrom = str(query.release_from, 20);
  if (releaseFrom) {
    if (!isValidDate(releaseFrom)) throw new Error('release_from must be a valid YYYY-MM-DD date');
    conditions.push('items.release_date IS NOT NULL AND items.release_date >= @release_from');
    params.release_from = releaseFrom;
  }
  const releaseTo = str(query.release_to, 20);
  if (releaseTo) {
    if (!isValidDate(releaseTo)) throw new Error('release_to must be a valid YYYY-MM-DD date');
    conditions.push('items.release_date IS NOT NULL AND items.release_date <= @release_to');
    params.release_to = releaseTo;
  }

  const published = bool(query.published);
  if (published !== null) { conditions.push('items.published = @published'); params.published = published ? 1 : 0; }

  const missingImages = bool(query.missing_images);
  if (missingImages) {
    // Either field counts: the admin wants the pages that need artwork.
    conditions.push(`(COALESCE(items.icon_url, '') = '' OR COALESCE(items.banner_url, '') = '')`);
  }
  const missingField = str(query.missing, 40);
  if (missingField) {
    const map = {
      icon: `COALESCE(items.icon_url, '') = ''`,
      banner: `COALESCE(items.banner_url, '') = ''`,
      checksum: `COALESCE(items.sha256, '') = ''`,
      description: `COALESCE(items.description, '') = ''`,
      version: `COALESCE(items.version, '') = ''`,
      release_date: `items.release_date IS NULL`,
      links: `NOT EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id)`,
    };
    if (!map[missingField]) throw new Error(`missing must be one of: ${Object.keys(map).join(', ')}`);
    conditions.push(map[missingField]);
  }

  const linkHealth = str(query.link_health, 20);
  if (linkHealth) {
    if (!LINK_HEALTH_VALUES.includes(linkHealth)) {
      throw new Error(`link_health must be one of: ${LINK_HEALTH_VALUES.join(', ')}`);
    }
    if (linkHealth === 'missing') {
      conditions.push('NOT EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id)');
    } else if (linkHealth === 'up') {
      conditions.push(`EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id)
        AND NOT EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id AND (l.is_down = 1 OR l.status != 'up'))`);
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id
        AND l.status = @link_health ${linkHealth === 'down' ? 'OR (l.item_id = items.id AND l.is_down = 1)' : ''})`);
      params.link_health = linkHealth;
    }
  }

  const q = str(query.q, 200);
  const ftsQuery = q ? buildFtsQuery(q) : null;

  return { conditions, params, ftsQuery, searchTerm: q };
}

/**
 * Run a catalogue query.
 *
 * @returns {{ items: object[], total: number, page: number, limit: number, totalPages: number }}
 */
export function searchCatalog(query = {}) {
  const db = getDb();
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const page = Math.min(Math.max(Number(query.page) || 1, 1), 100000);
  const offset = (page - 1) * limit;

  // Resolve the requested column once, with the fallback applied to the value
  // that actually reaches ORDER BY. (Writing the fallback only inside the
  // lookup guard made a missing ?sort= interpolate the string "undefined".)
  const requestedSort = String(one(query.sort) || 'updated_at');
  const sortKey = SORT_COLUMNS[requestedSort] ? requestedSort : 'updated_at';
  const direction = String(one(query.order) || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderClause = `ORDER BY ${SORT_COLUMNS[sortKey]} ${direction}, items.id DESC`;

  const { conditions, params, ftsQuery } = buildCatalogFilters(query);

  // Categories/folders are joined for filtering and to decorate the response.
  const joins = `
    LEFT JOIN categories ON items.category_id = categories.id
    LEFT JOIN folders ON items.folder_id = folders.id`;
  const ftsJoin = ftsQuery ? '\n    JOIN items_fts ON items.id = items_fts.rowid' : '';
  const matchCondition = ftsQuery ? 'items_fts MATCH @ftsQuery' : null;
  const all = matchCondition ? [...conditions, matchCondition] : conditions;
  const where = all.length ? `WHERE ${all.join(' AND ')}` : '';
  const bind = ftsQuery ? { ...params, ftsQuery } : params;

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM items${ftsJoin}${joins} ${where}
  `).get(bind).c;

  let rows;
  try {
    rows = db.prepare(`
      SELECT items.*, categories.slug AS category_slug, categories.name AS category_name,
             folders.slug AS folder_slug, folders.name AS folder_name${ftsQuery ? ', items_fts.rank AS fts_rank' : ''}
      FROM items${ftsJoin}${joins}
      ${where}
      ${ftsQuery ? 'ORDER BY items_fts.rank' : orderClause}
      LIMIT @limit OFFSET @offset
    `).all({ ...bind, limit, offset });
  } catch (e) {
    // A malformed MATCH expression throws; degrade to a LIKE search rather than
    // answering 500 on a stray quote in the search box.
    if (!ftsQuery) throw e;
    const like = `%${String(query.q).toLowerCase().slice(0, 200)}%`;
    const likeConditions = conditions.filter((c) => !c.includes('items_fts'));
    const likeWhere = likeConditions.length ? `WHERE ${likeConditions.join(' AND ')} AND (LOWER(items.name) LIKE @like OR LOWER(items.slug) LIKE @like)`
      : 'WHERE (LOWER(items.name) LIKE @like OR LOWER(items.slug) LIKE @like)';
    rows = db.prepare(`
      SELECT items.*, categories.slug AS category_slug, categories.name AS category_name,
             folders.slug AS folder_slug, folders.name AS folder_name
      FROM items${joins} ${likeWhere} ${orderClause} LIMIT @limit OFFSET @offset
    `).all({ ...params, like, limit, offset });
  }

  const linksByItem = getItemLinksForMany(rows.map((r) => r.id));
  const items = rows.map((row) => {
    const s = serializeItem(row, linksByItem[row.id] || []);
    const links = s.download_links || [];
    return {
      ...s,
      category_slug: row.category_slug || null,
      category_name: row.category_name || null,
      folder_slug: row.folder_slug || null,
      folder_name: row.folder_name || null,
      link_health: links.length === 0 ? 'missing'
        : links.some((l) => l.is_down || l.status === 'down') ? 'down'
          : links.every((l) => l.status === 'up') ? 'up'
            : links.some((l) => l.status === 'checking') ? 'checking' : 'unknown',
      missing_icon: !s.icon_url,
      missing_banner: !s.banner_url,
    };
  });

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}

/**
 * Distinct values for each filterable column, so the UI can build dropdowns
 * from real data instead of a hard-coded list.
 */
export function catalogFacets() {
  const db = getDb();
  const distinct = (column, limit = 60) => db.prepare(`
    SELECT ${column} AS value, COUNT(*) AS count
    FROM items WHERE COALESCE(${column}, '') != ''
    GROUP BY LOWER(${column}) ORDER BY count DESC, value ASC LIMIT ${limit}
  `).all();

  return {
    statuses: ITEM_STATUSES.map((status) => ({
      value: status,
      count: db.prepare('SELECT COUNT(*) c FROM items WHERE status = ?').get(status).c,
    })),
    platforms: distinct('items.platform'),
    architectures: distinct('items.architecture'),
    file_types: distinct('items.file_type'),
    versions: distinct('items.version', 200),
    storage_providers: STORAGE_PROVIDERS.map((value) => ({
      value,
      count: db.prepare('SELECT COUNT(*) c FROM items WHERE storage_provider = ?').get(value).c,
    })),
    categories: db.prepare(`
      SELECT c.slug AS value, c.name AS label, COUNT(i.id) AS count
      FROM categories c LEFT JOIN items i ON i.category_id = c.id
      GROUP BY c.id ORDER BY count DESC, c.name ASC
    `).all(),
    folders: db.prepare(`
      SELECT f.slug AS value, f.name AS label, COUNT(i.id) AS count
      FROM folders f LEFT JOIN items i ON i.folder_id = f.id
      GROUP BY f.id ORDER BY count DESC, f.name ASC
    `).all(),
    tags: db.prepare(`
      SELECT t.slug AS value, t.name AS label, COUNT(it.item_id) AS count
      FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id
      GROUP BY t.id ORDER BY count DESC, t.name ASC LIMIT 100
    `).all(),
  };
}

/** Statistics for the admin dashboard. */
export function catalogStats() {
  const db = getDb();
  const scalar = (sql, ...args) => {
    const row = db.prepare(sql).get(...args);
    return row ? Object.values(row)[0] : 0;
  };

  const byColumn = (column) => db.prepare(`
    SELECT COALESCE(NULLIF(${column}, ''), '(unset)') AS value, COUNT(*) AS count
    FROM items GROUP BY value ORDER BY count DESC LIMIT 12
  `).all();

  const linkHealth = {
    up: scalar(`SELECT COUNT(DISTINCT item_id) FROM item_download_links WHERE is_down = 0 AND status = 'up'`),
    down: scalar(`SELECT COUNT(DISTINCT item_id) FROM item_download_links WHERE is_down = 1 OR status = 'down'`),
    unknown: scalar(`SELECT COUNT(DISTINCT item_id) FROM item_download_links WHERE status = 'unknown'`),
    checking: scalar(`SELECT COUNT(DISTINCT item_id) FROM item_download_links WHERE status = 'checking'`),
    itemsWithoutLinks: scalar(`SELECT COUNT(*) FROM items WHERE NOT EXISTS (SELECT 1 FROM item_download_links l WHERE l.item_id = items.id)`),
    totalLinks: scalar(`SELECT COUNT(*) FROM item_download_links`),
  };

  let lastImport = null;
  try {
    lastImport = db.prepare(`
      SELECT id, filename, mode, status, dry_run, items_created, items_updated, error_count, started_at
      FROM catalog_imports ORDER BY id DESC LIMIT 1
    `).get() || null;
  } catch { /* table added by the catalogue migration; absent on very old DBs */ }

  return {
    totals: {
      items: scalar('SELECT COUNT(*) FROM items'),
      published: scalar('SELECT COUNT(*) FROM items WHERE published = 1'),
      drafts: scalar('SELECT COUNT(*) FROM items WHERE published = 0'),
      featured: scalar('SELECT COUNT(*) FROM items WHERE featured = 1'),
      archived: scalar(`SELECT COUNT(*) FROM items WHERE status = 'archived'`),
      totalSize: scalar('SELECT SUM(file_size) FROM items'),
      categories: scalar('SELECT COUNT(*) FROM categories'),
      folders: scalar('SELECT COUNT(*) FROM folders'),
      relations: scalar('SELECT COUNT(*) FROM item_relations'),
    },
    byStatus: ITEM_STATUSES.map((status) => ({
      value: status, count: scalar('SELECT COUNT(*) FROM items WHERE status = ?', status),
    })),
    byCategory: db.prepare(`
      SELECT c.name AS label, c.slug AS value, COUNT(i.id) AS count
      FROM categories c LEFT JOIN items i ON i.category_id = c.id
      GROUP BY c.id ORDER BY count DESC LIMIT 10
    `).all(),
    byPlatform: byColumn('platform'),
    byArchitecture: byColumn('architecture'),
    byFileType: byColumn('file_type'),
    quality: {
      missingIcon: scalar(`SELECT COUNT(*) FROM items WHERE COALESCE(icon_url, '') = ''`),
      missingBanner: scalar(`SELECT COUNT(*) FROM items WHERE COALESCE(banner_url, '') = ''`),
      missingChecksum: scalar(`SELECT COUNT(*) FROM items WHERE COALESCE(sha256, '') = ''`),
      missingDescription: scalar(`SELECT COUNT(*) FROM items WHERE COALESCE(description, '') = ''`),
      missingVersion: scalar(`SELECT COUNT(*) FROM items WHERE COALESCE(version, '') = ''`),
      missingReleaseDate: scalar('SELECT COUNT(*) FROM items WHERE release_date IS NULL'),
      missingLinks: linkHealth.itemsWithoutLinks,
      needsLicenseCheck: scalar(`SELECT COUNT(*) FROM items WHERE license_status = 'check-license'`),
    },
    linkHealth,
    recentUpdates: db.prepare('SELECT id, name, slug, status, updated_at FROM items ORDER BY updated_at DESC LIMIT 8').all(),
    topDownloads: db.prepare('SELECT id, name, slug, download_count FROM items ORDER BY download_count DESC LIMIT 8').all(),
    oldestUnupdated: db.prepare('SELECT id, name, slug, updated_at FROM items ORDER BY updated_at ASC LIMIT 5').all(),
    lastImport,
  };
}

export { ITEM_STATUSES, LINK_HEALTH_VALUES, STORAGE_PROVIDERS, SORT_COLUMNS };
