import { getDb } from '../db/index.js';
import { encryptionService, ENCRYPTED_ITEM_FIELDS } from './encryptionService.js';

/**
 * Shared item (de)serialisation.
 *
 * Every route that returns an item must decrypt the encrypted columns and
 * parse the JSON columns. Previously items.js and admin.js each carried their
 * own copy, and the admin copy omitted `download_links` entirely - which is
 * why the admin editor could never load or preserve existing mirrors.
 */

const LINK_ENCRYPTED_FIELDS = ['storage_path', 'download_url', 'down_reason'];

export function decryptItem(item) {
  if (!item) return item;
  const decrypted = { ...item };
  for (const field of ENCRYPTED_ITEM_FIELDS) {
    if (decrypted[field]) {
      try {
        decrypted[field] = encryptionService.decrypt(decrypted[field]);
      } catch { /* leave the stored value rather than dropping the field */ }
    }
  }
  return decrypted;
}

export function encryptItemFields(data) {
  const encrypted = { ...data };
  for (const field of ENCRYPTED_ITEM_FIELDS) {
    if (encrypted[field]) {
      encrypted[field] = encryptionService.encrypt(encrypted[field]);
    }
  }
  return encrypted;
}

export function decryptLink(link) {
  if (!link) return link;
  const dec = { ...link };
  for (const field of LINK_ENCRYPTED_FIELDS) {
    if (dec[field]) {
      try { dec[field] = encryptionService.decrypt(dec[field]); } catch {}
    }
  }
  return dec;
}

export function encryptLinkFields(data) {
  const enc = { ...data };
  for (const field of LINK_ENCRYPTED_FIELDS) {
    if (enc[field]) enc[field] = encryptionService.encrypt(enc[field]);
  }
  return enc;
}

function parseJsonColumn(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Links for one item, primary first. */
export function getItemLinks(itemId) {
  const rows = getDb().prepare(
    `SELECT * FROM item_download_links WHERE item_id = ?
     ORDER BY is_primary DESC, sort_order ASC, created_at ASC`
  ).all(itemId);
  return rows.map(decryptLink);
}

/** Links for many items in a single query (avoids N+1 on list endpoints). */
export function getItemLinksForMany(itemIds) {
  if (!itemIds.length) return {};
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT * FROM item_download_links WHERE item_id IN (${placeholders})
     ORDER BY is_primary DESC, sort_order ASC, created_at ASC`
  ).all(...itemIds);

  const byItem = {};
  for (const row of rows) {
    const dec = decryptLink(row);
    (byItem[dec.item_id] ||= []).push(dec);
  }
  return byItem;
}

/**
 * Raw DB row -> the shape the frontend expects: decrypted strings, parsed JSON
 * arrays, attached download links.
 */
export function serializeItem(raw, links = null) {
  if (!raw) return raw;
  const dec = decryptItem(raw);
  return {
    ...dec,
    tags: parseJsonColumn(dec.tags, []),
    screenshots: parseJsonColumn(dec.screenshots, []),
    download_links: links ?? getItemLinks(dec.id),
  };
}
