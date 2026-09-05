import { getDb } from '../db/index.js';
import { monitoringService } from './monitoringService.js';
import { catalogStats } from './catalogQueryService.js';

/**
 * Admin analytics (#20): one read-only aggregate over data the app already
 * records - items, users, download counters, the `events` table (item
 * writes, link transitions, imports, reviews), reviews, webhook deliveries,
 * import jobs and the in-process request metrics. Nothing new is tracked;
 * this only reads.
 *
 * Time series are per-day buckets over the last `days` days, filled with
 * zeros so the chart is a straight array.
 */
export const MAX_DAYS = 365;

function dayKeys(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function series(rows, keys, valueKey = 'n') {
  const map = Object.fromEntries(rows.map((r) => [r.day, r[valueKey]]));
  return keys.map((day) => ({ day, value: map[day] || 0 }));
}

export function getAnalytics({ days = 30 } = {}) {
  const db = getDb();
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), MAX_DAYS);
  const keys = dayKeys(n);
  const since = `${keys[0]} 00:00:00`;

  const perDay = (table, col = 'created_at', where = '') => db.prepare(
    `SELECT substr(${col}, 1, 10) AS day, COUNT(*) AS n FROM ${table} WHERE ${col} >= ? ${where} GROUP BY day`,
  ).all(since);

  const eventTypes = db.prepare(
    'SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type ORDER BY n DESC',
  ).all(since);

  const eventsPerDay = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day, type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY day, type`,
  ).all(since);
  const activity = {};
  for (const type of ['item.created', 'item.updated', 'link.down', 'link.recovered', 'review.created', 'import.completed']) {
    activity[type] = series(eventsPerDay.filter((r) => r.type === type), keys);
  }

  const downloads = {
    total: db.prepare('SELECT COALESCE(SUM(download_count), 0) AS s FROM items').get().s,
    top: db.prepare('SELECT id, name, slug, download_count FROM items WHERE download_count > 0 ORDER BY download_count DESC LIMIT 10').all(),
    byCategory: db.prepare(`
      SELECT c.name, c.slug, COALESCE(SUM(i.download_count), 0) AS downloads, COUNT(i.id) AS items
      FROM categories c LEFT JOIN items i ON i.category_id = c.id
      GROUP BY c.id HAVING items > 0 ORDER BY downloads DESC LIMIT 10`).all(),
    byPlatform: db.prepare(`
      SELECT COALESCE(platform, 'unknown') AS platform, COALESCE(SUM(download_count), 0) AS downloads, COUNT(*) AS items
      FROM items WHERE published = 1 GROUP BY platform ORDER BY downloads DESC`).all(),
    byProvider: db.prepare(`
      SELECT storage_provider AS provider, COALESCE(SUM(download_count), 0) AS downloads, COUNT(*) AS links
      FROM item_download_links GROUP BY storage_provider ORDER BY downloads DESC`).all(),
  };

  const reviews = {
    total: db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c,
    byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS c FROM reviews GROUP BY status').all().map((r) => [r.status, r.c])),
    averageRating: db.prepare("SELECT ROUND(AVG(rating), 2) AS a FROM reviews WHERE status = 'visible'").get().a,
    histogram: Object.fromEntries(db.prepare("SELECT rating, COUNT(*) AS c FROM reviews WHERE status = 'visible' GROUP BY rating").all().map((r) => [r.rating, r.c])),
    topRated: db.prepare(`
      SELECT i.id, i.name, i.slug, ROUND(AVG(r.rating), 2) AS average, COUNT(*) AS count
      FROM reviews r JOIN items i ON i.id = r.item_id WHERE r.status = 'visible'
      GROUP BY i.id HAVING count >= 1 ORDER BY average DESC, count DESC LIMIT 10`).all(),
    perDay: series(perDay('reviews'), keys),
  };

  const users = {
    total: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    byRole: Object.fromEntries(db.prepare('SELECT role, COUNT(*) AS c FROM users GROUP BY role').all().map((r) => [r.role, r.c])),
    signupsPerDay: series(perDay('users'), keys),
    favorites: db.prepare('SELECT COUNT(*) AS c FROM favorites').get().c,
    subscriptions: db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c,
  };

  const linkRows = db.prepare('SELECT status, COUNT(*) AS c FROM item_download_links GROUP BY status').all();
  const links = { byStatus: Object.fromEntries(linkRows.map((r) => [r.status, r.c])), total: linkRows.reduce((a, r) => a + r.c, 0) };

  const deliveries = db.prepare('SELECT status, COUNT(*) AS c FROM webhook_deliveries WHERE created_at >= ? GROUP BY status').all(since);
  const webhooks = {
    active: db.prepare('SELECT COUNT(*) AS c FROM webhooks WHERE active = 1').get().c,
    deliveries: Object.fromEntries(deliveries.map((r) => [r.status, r.c])),
    perDay: series(perDay('webhook_deliveries'), keys),
  };

  const imports = {
    catalog: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS c FROM catalog_imports WHERE started_at >= ? GROUP BY status').all(since).map((r) => [r.status, r.c])),
    scheduledJobs: db.prepare('SELECT COUNT(*) AS c FROM import_jobs').get().c,
    lastRuns: db.prepare('SELECT id, name, last_status, last_run_at FROM import_jobs ORDER BY last_run_at DESC LIMIT 5').all(),
  };

  return {
    range: { days: n, from: keys[0], to: keys[keys.length - 1] },
    catalog: {
      ...catalogStats(),
      itemsPerDay: series(perDay('items'), keys),
      updatesPerDay: series(perDay('items', 'updated_at', 'AND updated_at != created_at'), keys),
    },
    activity,
    eventTypes,
    downloads,
    reviews,
    users,
    links,
    webhooks,
    imports,
    requests: monitoringService.getRequestMetrics(),
    generatedAt: new Date().toISOString(),
  };
}
