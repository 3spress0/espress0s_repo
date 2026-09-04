/**
 * Application events.
 *
 * One small append-only log (`events`) plus in-process listeners. Anything
 * that wants to react to "a file page changed" or "a mirror went down" -
 * webhooks, per-user subscriptions, the RSS feed - reads from here instead of
 * being wired into every route that writes.
 *
 * Emitting is synchronous and cheap (one INSERT); listeners are invoked on
 * the next tick and their failures are logged, never propagated to the
 * request that caused the event.
 *
 * Event types (the `type` column):
 *   item.created        payload: { item }                      (public items)
 *   item.updated        payload: { item, changes: string[] }   (public items)
 *   item.published      payload: { item }
 *   item.unpublished    payload: { item }
 *   item.deleted        payload: { item: { id, slug, name } }
 *   link.down           payload: { item, link, previous_status }
 *   link.recovered      payload: { item, link }
 *   import.completed    payload: { import }
 */
import { getDb } from '../db/index.js';

export const EVENT_TYPES = [
  'item.created', 'item.updated', 'item.published', 'item.unpublished', 'item.deleted',
  'link.down', 'link.recovered', 'import.completed',
];

const listeners = new Set();
let logger = console;

export function setEventLogger(l) { logger = l || console; }

/** Register a listener: (event) => void|Promise. Returns an unsubscribe fn. */
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Small public shape of an item for payloads - no encrypted fields, no URLs. */
export function itemSummary(item) {
  if (!item) return null;
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    version: item.version ?? null,
    category_id: item.category_id ?? null,
    platform: item.platform ?? null,
    status: item.status ?? null,
    published: item.published === undefined ? undefined : !!item.published,
    updated_at: item.updated_at ?? null,
    url: `/file/${item.slug}`,
  };
}

/**
 * Record and dispatch an event. Returns the stored row (id, type, payload,
 * created_at). `actorId` is the user who caused it, when there is one.
 */
export function emitEvent(type, payload = {}, { actorId = null, itemId = null } = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  const db = getDb();
  const created_at = new Date().toISOString();
  const resolvedItemId = itemId ?? payload?.item?.id ?? null;
  const result = db.prepare(
    'INSERT INTO events (type, item_id, actor_id, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(type, resolvedItemId, actorId, JSON.stringify(payload), created_at);
  const event = { id: Number(result.lastInsertRowid), type, item_id: resolvedItemId, actor_id: actorId, payload, created_at };

  // Next tick: the caller's transaction/response is never held up or failed
  // by a listener.
  setImmediate(() => {
    for (const fn of listeners) {
      Promise.resolve().then(() => fn(event)).catch(err => {
        try { logger.error?.({ err, eventId: event.id, type }, 'Event listener failed'); } catch {}
      });
    }
  });
  return event;
}

/** Recent events, newest first. Used by the feed and the admin activity view. */
export function listEvents({ types = null, itemId = null, since = null, limit = 50 } = {}) {
  const db = getDb();
  const where = [];
  const params = {};
  if (types && types.length) {
    where.push(`type IN (${types.map((_, i) => `@t${i}`).join(', ')})`);
    types.forEach((t, i) => { params[`t${i}`] = t; });
  }
  if (itemId) { where.push('item_id = @itemId'); params.itemId = itemId; }
  if (since) { where.push('created_at > @since'); params.since = since; }
  params.limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const rows = db.prepare(
    `SELECT id, type, item_id, actor_id, payload, created_at FROM events
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT @limit`
  ).all(params);
  return rows.map(r => ({ ...r, payload: safeJson(r.payload) }));
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

/** Keep the log bounded. Called by the webhook worker's housekeeping tick. */
export function pruneEvents({ keepDays = 90 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  return db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes;
}
