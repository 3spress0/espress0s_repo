import { getDb } from '../db/index.js';
import { serializeItem, encryptItemFields, encryptLinkFields } from './itemSerializer.js';

/**
 * Item page version history.
 *
 * After every create/edit/duplicate/restore we snapshot the full serialized
 * item (decrypted, download links included) into item_versions. Restoring
 * writes an old snapshot back, which itself records a new version - history
 * is append-only, nothing is ever rewritten.
 *
 * Snapshots hold plaintext (they must survive an encryption key change to be
 * restorable), so the table inherits the same "admin eyes only" status as the
 * API that reads it.
 */

const KEEP_PER_ITEM = 50;

// Scalar columns carried by a snapshot and restorable from one. Matches the
// items table minus timestamps/counters and the opaque encryption marker.
const RESTORABLE_FIELDS = [
  'name', 'slug', 'description', 'long_description', 'category_id', 'folder_id',
  'version', 'release_date', 'file_name', 'file_size', 'file_type', 'platform',
  'architecture', 'sha256', 'md5', 'storage_provider', 'storage_path',
  'download_url', 'external_url', 'featured', 'published', 'license_status',
  'license_notes', 'tags', 'icon_url', 'image_url', 'screenshots',
  'documentation_url', 'changelog',
];

/** Field list used for "what changed" summaries. */
const DIFF_FIELDS = [
  'name', 'slug', 'description', 'long_description', 'category_id', 'folder_id',
  'version', 'release_date', 'file_name', 'file_size', 'file_type', 'platform',
  'architecture', 'featured', 'published', 'license_status', 'tags',
  'icon_url', 'image_url', 'documentation_url', 'changelog',
];

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Human-readable summary of what differs between two snapshots. */
export function diffSnapshots(prev, next) {
  const changed = DIFF_FIELDS.filter(f => !eq(prev[f], next[f]));
  const prevLinks = (prev.download_links || []).map(l => [l.label, l.download_url, l.storage_path, l.storage_provider, !!l.is_primary, !!l.is_down]);
  const nextLinks = (next.download_links || []).map(l => [l.label, l.download_url, l.storage_path, l.storage_provider, !!l.is_primary, !!l.is_down]);
  if (JSON.stringify(prevLinks) !== JSON.stringify(nextLinks)) {
    const pn = prevLinks.length; const nn = nextLinks.length;
    changed.push(pn !== nn ? `download links (${pn} → ${nn})` : 'download links');
  }
  return changed;
}

/**
 * Snapshot the current state of an item. Call AFTER the write that changed it.
 *
 * @param {number} itemId
 * @param {number|null} userId  admin who made the change (null = system/import)
 * @param {string} [summary]  override the auto-computed "what changed" text
 * @returns {{ version_num: number } | null}
 */
export function recordItemVersion(itemId, userId = null, summary = null) {
  const db = getDb();
  const raw = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!raw) return null;

  const snapshot = serializeItem(raw); // decrypted + parsed + download_links

  const last = db.prepare(
    'SELECT version_num, snapshot FROM item_versions WHERE item_id = ? ORDER BY version_num DESC LIMIT 1'
  ).get(itemId);

  let changeSummary = summary;
  if (!changeSummary) {
    if (last) {
      try {
        const prev = JSON.parse(last.snapshot);
        const changed = diffSnapshots(prev, snapshot);
        changeSummary = changed.length ? changed.join(', ') : 'No field changes';
      } catch {
        changeSummary = 'Updated';
      }
    } else {
      changeSummary = 'Created';
    }
  }

  const nextNum = (last?.version_num || 0) + 1;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO item_versions (item_id, version_num, snapshot, changed_by, change_summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(itemId, nextNum, JSON.stringify(snapshot), userId, changeSummary);

    // Keep the table bounded: drop versions beyond the newest KEEP_PER_ITEM.
    db.prepare('DELETE FROM item_versions WHERE item_id = ? AND version_num <= ?')
      .run(itemId, nextNum - KEEP_PER_ITEM);
  })();

  return { version_num: nextNum };
}

/** Version list without snapshot payloads (they can be large). */
export function listVersions(itemId) {
  const db = getDb();
  return db.prepare(`
    SELECT v.id, v.item_id, v.version_num, v.change_summary, v.created_at, u.username as changed_by_username
    FROM item_versions v
    LEFT JOIN users u ON u.id = v.changed_by
    WHERE v.item_id = ?
    ORDER BY v.version_num DESC
  `).all(itemId);
}

/** Full snapshot of one version, parsed. */
export function getVersion(itemId, versionNum) {
  const db = getDb();
  const row = db.prepare(`
    SELECT v.*, u.username as changed_by_username
    FROM item_versions v
    LEFT JOIN users u ON u.id = v.changed_by
    WHERE v.item_id = ? AND v.version_num = ?
  `).get(itemId, versionNum);
  if (!row) return null;
  let snapshot = null;
  try { snapshot = JSON.parse(row.snapshot); } catch { /* corrupt row */ }
  const { snapshot: _raw, ...meta } = row;
  return { ...meta, snapshot };
}

/**
 * Write an old snapshot back onto the item (and its links) in one transaction,
 * then record that restore as a new version. Returns the restored item's fresh
 * serialized state, or null when the version does not exist.
 */
export function restoreItemVersion(itemId, versionNum, userId) {
  const db = getDb();
  const version = getVersion(itemId, versionNum);
  if (!version || !version.snapshot) return null;
  if (!db.prepare('SELECT id FROM items WHERE id = ?').get(itemId)) return null;

  const snap = version.snapshot;
  const enc = encryptItemFields({
    storage_path: snap.storage_path || null,
    download_url: snap.download_url || null,
    external_url: snap.external_url || null,
    license_notes: snap.license_notes || null,
  });

  db.transaction(() => {
    const sets = [];
    const params = { id: itemId };
    for (const field of RESTORABLE_FIELDS) {
      if (field in snap) {
        sets.push(`${field} = @${field}`);
        if (['storage_path', 'download_url', 'external_url', 'license_notes'].includes(field)) {
          params[field] = enc[field];
        } else if (field === 'tags' || field === 'screenshots') {
          params[field] = Array.isArray(snap[field]) ? JSON.stringify(snap[field]) : (snap[field] ?? null);
        } else if (field === 'featured' || field === 'published') {
          params[field] = snap[field] ? 1 : 0;
        } else {
          params[field] = snap[field] ?? null;
        }
      }
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run(params);

    // Replace mirrors wholesale with the snapshot's set.
    db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(itemId);
    const insertLink = db.prepare(`
      INSERT INTO item_download_links
        (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, down_reason, status, sort_order)
      VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @down_reason, @status, @sort_order)
    `);
    (snap.download_links || []).forEach((l, i) => {
      const encLink = encryptLinkFields({
        storage_path: l.storage_path || null,
        download_url: l.download_url || null,
        down_reason: l.down_reason || null,
      });
      insertLink.run({
        item_id: itemId,
        label: String(l.label || 'Mirror'),
        storage_provider: l.storage_provider || 'external',
        storage_path: encLink.storage_path,
        download_url: encLink.download_url,
        file_size: l.file_size ?? null,
        is_primary: l.is_primary ? 1 : 0,
        is_down: l.is_down ? 1 : 0,
        down_reason: encLink.down_reason,
        status: l.status || 'unknown',
        sort_order: l.sort_order ?? i,
      });
    });
  })();

  recordItemVersion(itemId, userId, `Restored from version ${versionNum}`);

  const raw = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  return serializeItem(raw);
}
