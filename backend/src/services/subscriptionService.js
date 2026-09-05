/**
 * Per-user subscriptions to entries and tags (#13).
 *
 * A subscription on its own does nothing; it is a filter for the user's
 * personal webhooks. A hook created with filter_mode = 'subscribed' receives
 * only the events whose item the user follows - directly, or through one of
 * its tags. Hooks with filter_mode = 'all' behave as before.
 *
 * Only public items ever reach personal hooks (webhookService enforces that),
 * so subscribing to a draft is allowed but silent until it is published.
 */
import { getDb } from '../db/index.js';

export const MAX_SUBSCRIPTIONS = 500;

export class SubscriptionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const normalizeTag = (t) => String(t || '').trim().toLowerCase().slice(0, 64);

function rowOut(r) {
  return { id: r.id, kind: r.kind, item_id: r.item_id, tag: r.tag, created_at: r.created_at,
    item: r.item_slug ? { id: r.item_id, slug: r.item_slug, name: r.item_name, published: !!r.item_published } : null };
}

const SELECT = `SELECT s.*, i.slug AS item_slug, i.name AS item_name, i.published AS item_published
                FROM subscriptions s LEFT JOIN items i ON i.id = s.item_id`;

export function listSubscriptions(userId) {
  return getDb().prepare(`${SELECT} WHERE s.user_id = ? ORDER BY s.created_at DESC, s.id DESC`).all(userId).map(rowOut);
}

export function subscribe(userId, { kind, item_id, item_slug, tag }) {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = ?').get(userId).c;
  if (count >= MAX_SUBSCRIPTIONS) throw new SubscriptionError(`At most ${MAX_SUBSCRIPTIONS} subscriptions per account`);
  if (kind === 'item') {
    const item = item_id
      ? db.prepare('SELECT id FROM items WHERE id = ?').get(item_id)
      : db.prepare('SELECT id FROM items WHERE slug = ?').get(String(item_slug || ''));
    if (!item) throw new SubscriptionError('Item not found', 404);
    // SQLite treats NULLs as distinct in UNIQUE, so check explicitly.
    if (!db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'item' AND item_id = ?").get(userId, item.id)) {
      db.prepare("INSERT INTO subscriptions (user_id, kind, item_id, tag) VALUES (?, 'item', ?, NULL)").run(userId, item.id);
    }
    return rowOut(db.prepare(`${SELECT} WHERE s.user_id = ? AND s.kind = 'item' AND s.item_id = ?`).get(userId, item.id));
  }
  if (kind === 'tag') {
    const clean = normalizeTag(tag);
    if (!clean) throw new SubscriptionError('tag is required');
    if (!db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'tag' AND tag = ?").get(userId, clean)) {
      db.prepare("INSERT INTO subscriptions (user_id, kind, item_id, tag) VALUES (?, 'tag', NULL, ?)").run(userId, clean);
    }
    return rowOut(db.prepare(`${SELECT} WHERE s.user_id = ? AND s.kind = 'tag' AND s.tag = ?`).get(userId, clean));
  }
  throw new SubscriptionError("kind must be 'item' or 'tag'");
}

export function unsubscribe(userId, id) {
  return getDb().prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** What the signed-in user follows for one item: direct + via tags. */
export function subscriptionStatus(userId, itemId, itemTags = []) {
  const db = getDb();
  const direct = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND kind = 'item' AND item_id = ?").get(userId, itemId);
  const tags = itemTags.map(normalizeTag).filter(Boolean);
  const viaTags = tags.length
    ? db.prepare(`SELECT tag FROM subscriptions WHERE user_id = ? AND kind = 'tag' AND tag IN (${tags.map(() => '?').join(',')})`).all(userId, ...tags).map(r => r.tag)
    : [];
  return { subscribed: !!direct, subscription_id: direct?.id ?? null, via_tags: viaTags };
}

/**
 * Does `userId` follow the item in this event payload? Used by the webhook
 * matcher for 'subscribed' hooks. Events without an item never match.
 */
export function userFollowsEvent(userId, event) {
  const item = event?.payload?.item;
  if (!item?.id) return false;
  const db = getDb();
  if (db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'item' AND item_id = ?").get(userId, item.id)) return true;
  const tags = (Array.isArray(item.tags) ? item.tags : []).map(normalizeTag).filter(Boolean);
  if (!tags.length) return false;
  return !!db.prepare(`SELECT 1 FROM subscriptions WHERE user_id = ? AND kind = 'tag' AND tag IN (${tags.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...tags);
}
