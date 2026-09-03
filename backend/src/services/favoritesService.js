import { getDb } from '../db/index.js';
import { formatBytes } from '../utils/slug.js';
import { encryptionService } from './encryptionService.js';

/**
 * Personal favourites ("starred files").
 *
 * A favourite joins a user to a catalogue item and carries one extra bit:
 * `is_public`, which decides whether the file shows on the owner's public
 * profile. It defaults to 0 — private — so starring a file never publishes
 * anything by accident. Sharing is a deliberate second action, either per
 * favourite or as the profile default (`users.favorites_default_public`).
 *
 * Everything here returns a *card-shaped* item, never a full item row: the
 * public profile endpoint is unauthenticated, and a full row would drag the
 * decrypted `download_url` / `storage_path` columns along with it.
 */

/** Columns safe to hand to a browser. No encrypted fields, no mirror URLs. */
const CARD_COLUMNS = `
  items.id, items.name, items.slug, items.description, items.version,
  items.file_type, items.file_size, items.platform, items.architecture,
  items.icon_url, items.image_url, items.status, items.published,
  items.download_count, items.view_count, items.created_at, items.updated_at,
  categories.name AS category_name, categories.slug AS category_slug,
  folders.name AS folder_name, folders.slug AS folder_slug
`;

const FAVORITE_JOIN = `
  FROM favorites
  JOIN items ON items.id = favorites.item_id
  LEFT JOIN categories ON categories.id = items.category_id
  LEFT JOIN folders ON folders.id = items.folder_id
`;

/** Small int coercion: query strings arrive as strings and junk must not reach SQL. */
function toInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function toBoolInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'off'].includes(s)) return 0;
  return fallback;
}

/** DB row -> the shape the frontend renders. */
function serializeFavoriteRow(row) {
  const { is_public, created_at: favoritedAt, ...item } = row;
  return {
    ...item,
    file_size_formatted: formatBytes(item.file_size),
    is_public: Boolean(is_public),
    favorited_at: favoritedAt,
  };
}

/**
 * Resolve an item by id or slug.
 *
 * Returns null when the item does not exist — callers decide between 404 and
 * "not visible to you", which are deliberately the same answer for drafts.
 */
export function findItem(idOrSlug) {
  if (idOrSlug === undefined || idOrSlug === null || idOrSlug === '') return null;
  const db = getDb();
  return db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(idOrSlug, String(idOrSlug)) || null;
}

/**
 * Whether `user` is allowed to favourite this item at all.
 *
 * Drafts are invisible to everyone but admins (see routes/items.js), so a
 * favourite on one would let a viewer pin a file and then read its metadata
 * back through their own list. Refuse rather than leak.
 */
export function itemIsFavoriteable(item, user) {
  if (!item) return false;
  if (item.published) return true;
  return user?.role === 'admin';
}

/**
 * @param {number} userId
 * @param {{ page?: number, limit?: number, publicOnly?: boolean, includeUnpublished?: boolean }} options
 */
export function listFavorites(userId, { page = 1, limit = 24, publicOnly = false, includeUnpublished = false } = {}) {
  const db = getDb();
  const pageSize = toInt(limit, 24, 1, 100);
  const pageNum = toInt(page, 1, 1, 10000);
  const offset = (pageNum - 1) * pageSize;

  const conditions = ['favorites.user_id = @userId'];
  const params = { userId, limit: pageSize, offset };
  if (publicOnly) conditions.push('favorites.is_public = 1');
  if (!includeUnpublished) conditions.push('items.published = 1');
  const where = `WHERE ${conditions.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS c ${FAVORITE_JOIN} ${where}`).get(params).c;
  const rows = db.prepare(`
    SELECT ${CARD_COLUMNS}, favorites.is_public, favorites.created_at
    ${FAVORITE_JOIN} ${where}
    ORDER BY favorites.created_at DESC, favorites.id DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  return {
    favorites: rows.map(serializeFavoriteRow),
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * Add (or re-add) a favourite.
 *
 * Idempotent: starring twice returns the existing row instead of throwing a
 * UNIQUE error, so a double click or a retried request is harmless.
 *
 * @returns {{ favorite: object, item: object, created: boolean } | null}
 */
export function addFavorite(userId, idOrSlug, { isPublic } = {}) {
  const db = getDb();
  const item = findItem(idOrSlug);
  if (!item) return null;

  const existing = db.prepare('SELECT * FROM favorites WHERE user_id = ? AND item_id = ?').get(userId, item.id);
  const visibility = isPublic === undefined
    ? (existing ? existing.is_public : userFavoritesDefaultPublic(userId))
    : toBoolInt(isPublic, existing ? existing.is_public : 0);

  if (existing) {
    // Re-starring a file you had already favourited keeps it, and only the
    // explicit `isPublic` argument can change who can see it.
    if (existing.is_public !== visibility) {
      db.prepare('UPDATE favorites SET is_public = ? WHERE id = ?').run(visibility, existing.id);
    }
    return { favorite: { ...existing, is_public: visibility }, item, created: false };
  }

  const result = db.prepare(
    'INSERT INTO favorites (user_id, item_id, is_public) VALUES (?, ?, ?)'
  ).run(userId, item.id, visibility);

  return {
    favorite: db.prepare('SELECT * FROM favorites WHERE id = ?').get(result.lastInsertRowid),
    item,
    created: true,
  };
}

export function removeFavorite(userId, idOrSlug) {
  const db = getDb();
  const item = findItem(idOrSlug);
  if (!item) return null;
  const result = db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?').run(userId, item.id);
  return { item, removed: result.changes > 0 };
}

/** Flip a single favourite between private and public. */
export function setFavoriteVisibility(userId, idOrSlug, isPublic) {
  const db = getDb();
  const item = findItem(idOrSlug);
  if (!item) return null;
  const visibility = toBoolInt(isPublic, 0);
  const result = db.prepare('UPDATE favorites SET is_public = ? WHERE user_id = ? AND item_id = ?')
    .run(visibility, userId, item.id);
  if (result.changes === 0) return null;
  return {
    favorite: db.prepare('SELECT * FROM favorites WHERE user_id = ? AND item_id = ?').get(userId, item.id),
    item,
  };
}

export function getFavorite(userId, idOrSlug) {
  const db = getDb();
  const item = findItem(idOrSlug);
  if (!item) return null;
  const row = db.prepare('SELECT * FROM favorites WHERE user_id = ? AND item_id = ?').get(userId, item.id);
  return row ? { favorite: row, item } : null;
}

/** Is this item starred by this user? Used to render the star's initial state. */
export function isFavorite(userId, itemId) {
  if (!userId || !itemId) return false;
  const row = getDb().prepare('SELECT 1 AS hit FROM favorites WHERE user_id = ? AND item_id = ?').get(userId, itemId);
  return Boolean(row);
}

/** The stored profile default for new favourites (0 = private). */
export function userFavoritesDefaultPublic(userId) {
  const row = getDb().prepare('SELECT favorites_default_public FROM users WHERE id = ?').get(userId);
  return row?.favorites_default_public ? 1 : 0;
}

export function setUserFavoritesDefaultPublic(userId, value) {
  getDb().prepare('UPDATE users SET favorites_default_public = ?, updated_at = ? WHERE id = ?')
    .run(toBoolInt(value, 0), new Date().toISOString(), userId);
  return userFavoritesDefaultPublic(userId);
}

/**
 * Accounts that shared this file publicly, for the "who starred this" row.
 *
 * Only is_public rows are included, which makes this the same fact those
 * accounts already publish on their own profile - it just lets a visitor find
 * the profile from the file instead of the other way round.
 */
export function getPublicFavoritedBy(itemId, limit = 12) {
  if (!itemId) return [];
  const rows = getDb().prepare(`
    SELECT users.id, users.username, users.avatar_url
    FROM favorites
    JOIN users ON users.id = favorites.user_id
    WHERE favorites.item_id = ? AND favorites.is_public = 1
    ORDER BY favorites.created_at DESC
    LIMIT ?
  `).all(itemId, toInt(limit, 12, 1, 24));

  return rows.map((row) => {
    let avatar = null;
    try { avatar = row.avatar_url ? encryptionService.decrypt(row.avatar_url) : null; } catch { avatar = row.avatar_url || null; }
    return { id: row.id, username: row.username, avatar_url: avatar };
  });
}

/** How many accounts starred this item. Shown on the file page. */
export function countItemFavorites(itemId) {
  if (!itemId) return 0;
  return getDb().prepare('SELECT COUNT(*) AS c FROM favorites WHERE item_id = ?').get(itemId).c;
}

/** Counts for a profile header: public shares are the only public number. */
export function countFavorites(userId, { publicOnly = false } = {}) {
  const db = getDb();
  const sql = publicOnly
    ? `SELECT COUNT(*) AS c ${FAVORITE_JOIN} WHERE favorites.user_id = ? AND favorites.is_public = 1 AND items.published = 1`
    : 'SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?';
  return db.prepare(sql).get(userId).c;
}

/**
 * Public profile of a user: whatever they chose to share, and nothing else.
 *
 * The email column is deliberately not selected — it is encrypted at rest and
 * a public profile must never be the way it gets out. `avatar_url` and `bio`
 * are encrypted too, but they are profile content, so they are decrypted here.
 */
export function getPublicProfile(username) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, role, avatar_url, bio, favorites_default_public, created_at
    FROM users WHERE username = ?
  `).get(String(username ?? '').trim());
  if (!row) return null;

  let avatar = null;
  try { avatar = row.avatar_url ? encryptionService.decrypt(row.avatar_url) : null; } catch { avatar = row.avatar_url || null; }
  let bio = null;
  try { bio = row.bio ? encryptionService.decrypt(row.bio) : null; } catch { bio = row.bio || null; }

  return {
    id: row.id,
    username: row.username,
    role: row.role,
    avatar_url: avatar,
    bio,
    created_at: row.created_at,
    favorites_default_public: Boolean(row.favorites_default_public),
    // Only shared favourites are countable by a stranger; the private total
    // would leak how much someone has starred even if not what.
    favorites_count: countFavorites(row.id, { publicOnly: true }),
  };
}

/** Same list as listFavorites(publicOnly), keyed off a username. */
export function listPublicFavorites(username, { page = 1, limit = 24 } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username ?? '').trim());
  if (!user) return null;
  return listFavorites(user.id, { page, limit, publicOnly: true, includeUnpublished: false });
}
