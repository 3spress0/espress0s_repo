/**
 * Ratings and reviews (#19).
 *
 * Every signed-in user may leave one 1-5 star rating per published entry,
 * with an optional comment, and edit or withdraw it later. Aggregates
 * (average, count, histogram) are public.
 *
 * Spam protection, in layers, none of which needs a third party:
 *   - an account is required (already the site rule) and must be older than
 *     REVIEW_MIN_ACCOUNT_MINUTES (default 10)
 *   - route rate limit (10 writes / 15 min) plus REVIEW_MAX_PER_DAY per user
 *   - comment length cap; more than REVIEW_MAX_LINKS links, or the same
 *     comment text posted on several entries in a day, is rejected
 *   - any comment containing a URL is held as 'pending' until a moderator
 *     approves it; ratings still count immediately
 *   - moderators (editor+) can hide, approve or delete; hidden/pending
 *     reviews never appear publicly and never count in the average
 */
import { getDb } from '../db/index.js';
import { emitEvent, itemSummary } from './eventBus.js';

export const MAX_COMMENT = 2000;
export const REVIEW_MIN_ACCOUNT_MINUTES = Math.max(0, parseInt(process.env.REVIEW_MIN_ACCOUNT_MINUTES || '10', 10) || 0);
export const REVIEW_MAX_PER_DAY = Math.max(1, parseInt(process.env.REVIEW_MAX_PER_DAY || '20', 10) || 20);
export const REVIEW_MAX_LINKS = 2;
const URL_RE = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/gi;

export class ReviewError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function rowOut(r, { withUser = true } = {}) {
  return {
    id: r.id, item_id: r.item_id, rating: r.rating, comment: r.comment, status: r.status, hold_reason: r.hold_reason || null,
    created_at: r.created_at, updated_at: r.updated_at, edited: r.updated_at !== r.created_at,
    user: withUser ? { id: r.user_id, username: r.username, avatar_url: null } : undefined,
    item: r.item_slug ? { id: r.item_id, slug: r.item_slug, name: r.item_name } : undefined,
  };
}

const SELECT = `SELECT r.*, u.username, i.slug AS item_slug, i.name AS item_name
                FROM reviews r JOIN users u ON u.id = r.user_id JOIN items i ON i.id = r.item_id`;

/** Public aggregate for one item: visible reviews only. */
export function ratingSummary(itemId) {
  const db = getDb();
  const rows = db.prepare("SELECT rating, COUNT(*) AS n FROM reviews WHERE item_id = ? AND status = 'visible' GROUP BY rating").all(itemId);
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0; let sum = 0;
  for (const r of rows) { histogram[r.rating] = r.n; count += r.n; sum += r.rating * r.n; }
  return { average: count ? Math.round((sum / count) * 10) / 10 : null, count, histogram };
}

/** Aggregates for many items at once (list pages). */
export function ratingSummaries(itemIds) {
  if (!itemIds.length) return {};
  const db = getDb();
  const rows = db.prepare(`SELECT item_id, AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE status = 'visible' AND item_id IN (${itemIds.map(() => '?').join(',')}) GROUP BY item_id`).all(...itemIds);
  const out = {};
  for (const r of rows) out[r.item_id] = { average: Math.round(r.avg * 10) / 10, count: r.n };
  return out;
}

export function listForItem(itemId, { limit = 50, offset = 0, viewerId = null, moderator = false } = {}) {
  const db = getDb();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  // Visible to all; the viewer also sees their own pending/hidden row; moderators see everything.
  const where = moderator ? 'r.item_id = ?' : "r.item_id = ? AND (r.status = 'visible' OR r.user_id = ?)";
  const args = moderator ? [itemId] : [itemId, viewerId ?? -1];
  const rows = db.prepare(`${SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
  return rows.map((r) => rowOut(r));
}

export function getOwn(itemId, userId) {
  const r = getDb().prepare(`${SELECT} WHERE r.item_id = ? AND r.user_id = ?`).get(itemId, userId);
  return r ? rowOut(r) : null;
}

function spamCheck(db, user, itemId, comment) {
  if (REVIEW_MIN_ACCOUNT_MINUTES > 0) {
    const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(user.id);
    const ageMin = (Date.now() - new Date(row?.created_at || 0).getTime()) / 60000;
    if (ageMin < REVIEW_MIN_ACCOUNT_MINUTES && user.role === 'viewer') {
      throw new ReviewError(`New accounts can review after ${REVIEW_MIN_ACCOUNT_MINUTES} minutes`, 429);
    }
  }
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const today = db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE user_id = ? AND created_at > ? AND item_id != ?').get(user.id, dayAgo, itemId).c;
  if (today >= REVIEW_MAX_PER_DAY) throw new ReviewError(`At most ${REVIEW_MAX_PER_DAY} reviews per day`, 429);
  if (comment) {
    const links = (comment.match(URL_RE) || []).length;
    if (links > REVIEW_MAX_LINKS) throw new ReviewError(`At most ${REVIEW_MAX_LINKS} links in a review`);
    const dup = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND item_id != ? AND comment = ? AND created_at > ?').get(user.id, itemId, comment, dayAgo);
    if (dup) throw new ReviewError('You posted the same text on another entry recently');
    if (links > 0) return { status: 'pending', hold_reason: 'contains links' };
  }
  return { status: 'visible', hold_reason: null };
}

/** Create or replace the caller's review. Returns { review, created }. */
export function upsertReview(user, itemId, { rating, comment }) {
  const db = getDb();
  const r = parseInt(rating, 10);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new ReviewError('rating must be 1-5');
  const text = comment === undefined || comment === null ? null : String(comment).trim().slice(0, MAX_COMMENT) || null;
  const item = db.prepare('SELECT id, slug, name, published FROM items WHERE id = ?').get(itemId);
  if (!item || !item.published) throw new ReviewError('Item not found', 404);
  const existing = db.prepare('SELECT * FROM reviews WHERE item_id = ? AND user_id = ?').get(itemId, user.id);
  // Staff reviews are never auto-held; moderators do not moderate themselves.
  const moderation = user.role === 'viewer' ? spamCheck(db, user, itemId, text) : { status: 'visible', hold_reason: null };
  // A moderator's 'hidden' decision sticks through edits.
  const status = existing?.status === 'hidden' ? 'hidden' : moderation.status;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE reviews SET rating = ?, comment = ?, status = ?, hold_reason = ?, updated_at = ? WHERE id = ?')
      .run(r, text, status, moderation.hold_reason, now, existing.id);
  } else {
    db.prepare('INSERT INTO reviews (item_id, user_id, rating, comment, status, hold_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(itemId, user.id, r, text, status, moderation.hold_reason, now, now);
  }
  const review = getOwn(itemId, user.id);
  if (!existing) emitEvent('review.created', { item: itemSummary(item), review: { id: review.id, rating: r, status, has_comment: !!text } }, { actorId: user.id, itemId });
  return { review, created: !existing };
}

export function deleteReview(id, { userId = null } = {}) {
  const db = getDb();
  const where = userId === null ? 'id = ?' : 'id = ? AND user_id = ?';
  const args = userId === null ? [id] : [id, userId];
  return db.prepare(`DELETE FROM reviews WHERE ${where}`).run(...args).changes > 0;
}

/** Moderation: set status. */
export function setReviewStatus(id, status) {
  if (!['visible', 'pending', 'hidden'].includes(status)) throw new ReviewError('bad status');
  const db = getDb();
  const changed = db.prepare("UPDATE reviews SET status = ?, hold_reason = CASE WHEN ? = 'visible' THEN NULL ELSE hold_reason END, updated_at = updated_at WHERE id = ?").run(status, status, id).changes > 0;
  if (!changed) return null;
  const r = db.prepare(`${SELECT} WHERE r.id = ?`).get(id);
  return rowOut(r);
}

/** Moderation queue / listing. */
export function listAll({ status = null, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = status ? 'WHERE r.status = ?' : '';
  const args = status ? [status] : [];
  const rows = db.prepare(`${SELECT} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reviews GROUP BY status').all().map((r) => [r.status, r.n]));
  return { reviews: rows.map((r) => rowOut(r)), counts: { visible: 0, pending: 0, hidden: 0, ...counts } };
}
