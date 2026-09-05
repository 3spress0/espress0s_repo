import { getDb } from '../db/index.js';
import { parseRequirements } from '../utils/requirements.js';
import { ratingSummaries } from '../services/reviewService.js';
import { FEED_TYPES, loadEntries, loadChanges, toFeedItems, renderRss, renderAtom, siteOrigin } from '../services/feedService.js';
import { decryptItem } from '../services/itemSerializer.js';
import { searchService, MAX_QUERY_LENGTH } from '../services/searchService.js';
import { listEvents } from '../services/eventBus.js';
import { config } from '../config.js';

/**
 * Public, read-only, versioned API for third-party tools: /api/v1/*.
 *
 * Differences from the SPA's own endpoints (/api/items etc.):
 *
 *   - stable, documented shape; fields are added, never renamed
 *   - published items only, always - no session is read, so there is no
 *     "admin sees drafts" branch to get wrong
 *   - no download URLs. The catalogue is metadata; downloads still go through
 *     /api/download/:id with a session, exactly as in the UI. What a client
 *     gets is `download_url_api` pointing there, plus mirror labels/health.
 *   - its own rate-limit bucket (PUBLIC_API_RATE_LIMIT, default 60/min/IP),
 *     separate from the SPA's, so a chatty integration cannot exhaust the
 *     budget of a browser session on the same IP and vice versa
 *   - CORS: GET from anywhere (the data is public by definition)
 *   - ETag / Cache-Control so polling clients are cheap
 */

const PUBLIC_API_MAX = Math.max(1, parseInt(process.env.PUBLIC_API_RATE_LIMIT || '60', 10) || 60);
const PUBLIC_API_WINDOW = process.env.PUBLIC_API_RATE_WINDOW || '1 minute';

const toInt = (value, fallback, min, max) => {
  const n = parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};
const str = (v, max = 64) => (v === undefined || v === null ? null : String(Array.isArray(v) ? v[0] : v).slice(0, max) || null);
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/** The public representation of one item. */
export function publicItem(raw, { links = [], category = null, folder = null, rating = null } = {}) {
  const item = decryptItem(raw);
  const mirrors = links.map(l => ({
    id: l.id,
    label: l.label,
    provider: l.storage_provider,
    primary: !!l.is_primary,
    status: l.is_down ? 'down' : (l.status || 'unknown'),
    file_size: l.file_size ?? null,
    last_checked: l.last_checked ?? null,
    download_url_api: `/api/download/${item.id}/${l.id}`,
  }));
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    description: item.description ?? null,
    long_description: item.long_description ?? null,
    version: item.version ?? null,
    release_date: item.release_date ?? null,
    file_name: item.file_name ?? null,
    file_size: item.file_size ?? null,
    file_type: item.file_type ?? null,
    platform: item.platform ?? null,
    architecture: item.architecture ?? null,
    license_status: item.license_status ?? null,
    status: item.status ?? null,
    featured: !!item.featured,
    tags: parseJson(item.tags, []),
    screenshots: parseJson(item.screenshots, []),
    icon_url: item.icon_url ?? null,
    image_url: item.image_url ?? null,
    banner_url: item.banner_url ?? null,
    documentation_url: item.documentation_url ?? null,
    changelog: item.changelog ?? null,
    requirements: parseRequirements(item.requirements),
    category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
    folder: folder ? { id: folder.id, name: folder.name, slug: folder.slug } : null,
    download_count: item.download_count ?? 0,
    rating: rating || { average: null, count: 0 },
    view_count: item.view_count ?? 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
    url: `/file/${item.slug}`,
    api_url: `/api/v1/items/${item.slug}`,
    download_url_api: `/api/download/${item.id}`,
    mirrors,
  };
}

function loadRefs(db, items) {
  const catIds = [...new Set(items.map(i => i.category_id).filter(Boolean))];
  const folderIds = [...new Set(items.map(i => i.folder_id).filter(Boolean))];
  const cats = catIds.length ? db.prepare(`SELECT id, name, slug FROM categories WHERE id IN (${catIds.map(() => '?').join(',')})`).all(...catIds) : [];
  const folders = folderIds.length ? db.prepare(`SELECT id, name, slug FROM folders WHERE id IN (${folderIds.map(() => '?').join(',')})`).all(...folderIds) : [];
  const ids = items.map(i => i.id);
  const links = ids.length ? db.prepare(`SELECT id, item_id, label, storage_provider, is_primary, is_down, status, file_size, last_checked FROM item_download_links WHERE item_id IN (${ids.map(() => '?').join(',')}) ORDER BY is_primary DESC, sort_order ASC, created_at ASC`).all(...ids) : [];
  const byItem = {};
  for (const l of links) (byItem[l.item_id] ||= []).push(l);
  return {
    cat: Object.fromEntries(cats.map(c => [c.id, c])),
    folder: Object.fromEntries(folders.map(f => [f.id, f])),
    links: byItem,
  };
}

export async function publicApiRoutes(fastify) {
  // Own bucket, keyed by IP only (no session promotion). Set per route via
  // `config` (a scoped onRoute hook would run after @fastify/rate-limit's own
  // onRoute and be ignored). Permissive CORS for reads.
  const LIMIT = { rateLimit: { max: PUBLIC_API_MAX, timeWindow: PUBLIC_API_WINDOW, keyGenerator: (req) => `public:${req.ip}` } };
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('x-api-version', '1');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'public, max-age=60');
    return payload;
  });

  fastify.get('/v1', { config: LIMIT, schema: { tags: ['Public API'], summary: 'API root: version, limits and links' } }, async () => ({
    name: "espress0's repo public API",
    version: 1,
    docs: '/api/docs',
    openapi: '/api/docs/json',
    rate_limit: { max: PUBLIC_API_MAX, window: PUBLIC_API_WINDOW, scope: 'per IP' },
    endpoints: ['/api/v1/items', '/api/v1/items/{slug}', '/api/v1/categories', '/api/v1/folders', '/api/v1/tags', '/api/v1/search', '/api/v1/changes', '/api/v1/stats', '/api/v1/feed.rss', '/api/v1/feed.atom', '/api/v1/feed/changes.rss'],
    note: 'Read-only. Published catalogue entries only. Downloads require a session via /api/download/{id}.',
  }));

  /**
   * List / filter items. Same filter names as the UI. `updated_since` (ISO
   * date) is the cheap way for a sync client to fetch only what changed.
   */
  fastify.get('/v1/items', { config: LIMIT, schema: { tags: ['Public API'], summary: 'List published items', querystring: {
    type: 'object', properties: {
      q: { type: 'string' }, category: { type: 'string' }, folder: { type: 'string' }, tag: { type: 'string' },
      platform: { type: 'string' }, architecture: { type: 'string' }, file_type: { type: 'string' }, license_status: { type: 'string' },
      featured: { type: 'string' }, updated_since: { type: 'string', format: 'date-time' },
      sort: { type: 'string', enum: ['date', 'name', 'downloads', 'views', 'size', 'relevance', 'updated'] }, order: { type: 'string', enum: ['asc', 'desc'] },
      page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    } } } }, async (request) => {
    const q = request.query || {};
    const db = getDb();
    const result = searchService.search({
      q: String(q.q ?? '').slice(0, MAX_QUERY_LENGTH),
      category: str(q.category), folder: str(q.folder), tag: str(q.tag),
      license_status: str(q.license_status), file_type: str(q.file_type),
      platform: str(q.platform), architecture: str(q.architecture),
      sort: q.sort === 'updated' ? 'date' : (q.sort || 'date'), order: q.order || 'desc',
      page: toInt(q.page, 1, 1, 10000), limit: toInt(q.limit, 20, 1, 100),
      featured: q.featured !== undefined ? (q.featured === 'true' || q.featured === '1' ? 1 : 0) : null,
      published: 1,
    });
    let rows = result.results;
    if (q.updated_since) {
      const since = new Date(q.updated_since);
      if (!Number.isNaN(since.getTime())) rows = rows.filter(r => new Date(r.updated_at) >= since);
    }
    const refs = loadRefs(db, rows);
    const ratings = ratingSummaries(rows.map(r => r.id));
    return {
      items: rows.map(r => publicItem(r, { links: refs.links[r.id] || [], category: refs.cat[r.category_id], folder: refs.folder[r.folder_id], rating: ratings[r.id] })),
      pagination: { page: result.page, limit: result.limit, total: result.total, total_pages: result.totalPages },
    };
  });

  fastify.get('/v1/items/:slug', { config: LIMIT, schema: { tags: ['Public API'], summary: 'One published item by slug or id' } }, async (request, reply) => {
    const db = getDb();
    const key = String(request.params.slug).slice(0, 200);
    const raw = db.prepare('SELECT * FROM items WHERE (slug = ? OR id = ?) AND published = 1').get(key, /^\d+$/.test(key) ? Number(key) : -1);
    if (!raw) return reply.code(404).send({ error: 'Not found' });
    const refs = loadRefs(db, [raw]);
    const related = db.prepare('SELECT r.relation, i.slug, i.name FROM item_relations r JOIN items i ON i.id = r.related_item_id WHERE r.item_id = ? AND i.published = 1 ORDER BY r.sort_order').all(raw.id);
    const etag = `W/"${raw.id}-${new Date(raw.updated_at).getTime()}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('etag', etag);
    return { item: { ...publicItem(raw, { links: refs.links[raw.id] || [], category: refs.cat[raw.category_id], folder: refs.folder[raw.folder_id], rating: ratingSummaries([raw.id])[raw.id] }), related } };
  });

  fastify.get('/v1/categories', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Categories with published item counts' } }, async () => {
    const db = getDb();
    return { categories: db.prepare(`
      SELECT c.id, c.name, c.slug, c.description, c.icon, c.color, c.sort_order,
             (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.published = 1) AS item_count
      FROM categories c ORDER BY c.sort_order, c.name`).all() };
  });

  fastify.get('/v1/folders', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Folders with published item counts' } }, async () => {
    const db = getDb();
    return { folders: db.prepare(`
      SELECT f.id, f.name, f.slug, f.description, f.icon, f.color, f.sort_order,
             (SELECT COUNT(*) FROM items i WHERE i.folder_id = f.id AND i.published = 1) AS item_count
      FROM folders f ORDER BY f.sort_order, f.name`).all() };
  });

  fastify.get('/v1/tags', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Tags in use on published items' } }, async () => {
    const db = getDb();
    return { tags: db.prepare(`
      SELECT t.name, t.slug, COUNT(it.item_id) AS item_count
      FROM tags t JOIN item_tags it ON it.tag_id = t.id JOIN items i ON i.id = it.item_id AND i.published = 1
      GROUP BY t.id HAVING item_count > 0 ORDER BY item_count DESC, t.name`).all() };
  });

  fastify.get('/v1/search', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Full-text search (alias of /v1/items?q=)' } }, async (request, reply) => {
    const q = String(request.query?.q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'q is required' });
    return reply.redirect(`/api/v1/items?${new URLSearchParams({ ...request.query, q }).toString()}`, 307);
  });

  /** Public change feed - the event log minus anything about drafts. */
  fastify.get('/v1/changes', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Recent changes (created / updated / published / link status)' } }, async (request, reply) => {
    reply.header('cache-control', 'public, max-age=15'); // pollers
    const q = request.query || {};
    const events = listEvents({
      types: ['item.created', 'item.updated', 'item.published', 'item.unpublished', 'item.deleted', 'link.down', 'link.recovered'],
      since: q.since ? String(q.since) : null,
      limit: toInt(q.limit, 50, 1, 200),
    }).filter(e => e.payload?.item?.published !== false || e.type === 'item.unpublished' || e.type === 'item.deleted');
    return { changes: events.map(e => ({ id: e.id, type: e.type, at: e.created_at, item: e.payload?.item ?? null, changes: e.payload?.changes ?? undefined, link: e.payload?.link ?? undefined })) };
  });

  /**
   * RSS / Atom. Same rate-limit bucket and published-only rule as the JSON
   * API. `/feed.rss` and `/feed.atom` are the newest entries; add
   * `/changes` for the change log. Filters: category, folder, tag, limit.
   */
  const feed = (format) => async (request, reply) => {
    const type = FEED_TYPES.includes(request.params.type) ? request.params.type : 'entries';
    const q = request.query || {};
    const origin = siteOrigin(request);
    const rows = type === 'changes'
      ? loadChanges({ limit: q.limit })
      : loadEntries({ category: q.category ? String(q.category).slice(0, 100) : null, folder: q.folder ? String(q.folder).slice(0, 100) : null, tag: q.tag ? String(q.tag).slice(0, 64) : null, limit: q.limit });
    const items = toFeedItems(type, rows, origin);
    const selfUrl = `${origin}${request.raw.url}`;
    const xml = format === 'atom' ? renderAtom({ type, items, origin, selfUrl }) : renderRss({ type, items, origin, selfUrl });
    reply.header('content-type', format === 'atom' ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(xml);
  };
  for (const format of ['rss', 'atom']) {
    fastify.get(`/v1/feed.${format}`, { config: LIMIT, schema: { tags: ['Public API'], summary: `${format.toUpperCase()} feed of new entries` } }, feed(format));
    fastify.get(`/v1/feed/:type.${format}`, { config: LIMIT, schema: { tags: ['Public API'], summary: `${format.toUpperCase()} feed: entries or changes` } }, feed(format));
  }

  fastify.get('/v1/stats', { config: LIMIT, schema: { tags: ['Public API'], summary: 'Catalogue totals' } }, async () => {
    const db = getDb();
    const items = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(file_size), 0) AS bytes, COALESCE(SUM(download_count), 0) AS downloads FROM items WHERE published = 1').get();
    return {
      items: items.c, total_bytes: items.bytes, downloads: items.downloads,
      categories: db.prepare('SELECT COUNT(*) AS c FROM categories').get().c,
      folders: db.prepare('SELECT COUNT(*) AS c FROM folders').get().c,
      generated_at: new Date().toISOString(),
      instance: config.isProd ? undefined : 'dev',
    };
  });

}
