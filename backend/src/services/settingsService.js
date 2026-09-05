import { getDb } from '../db/index.js';

/**
 * Site settings live in the DB so admins can change site copy, branding,
 * links and behaviour flags without touching code or redeploying.
 *
 * Values are stored as TEXT; `coerce` turns them back into the type declared
 * on the row so the frontend never has to guess.
 */

let cache = null;

/**
 * Keys that must never reach the settings table. `rows['__proto__']` is
 * Object.prototype - truthy - so the unknown-key guard below would wave it
 * through, and `written['__proto__'] = …` would then replace the result
 * object's prototype instead of adding a property.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function coerce(raw, type) {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'json':
      try { return JSON.parse(raw); } catch { return null; }
    default:
      return raw;
  }
}

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Full setting rows, keyed by key. Cached until invalidated. */
export function getSettingsRows() {
  if (cache) return cache;
  const db = getDb();
  const rows = db.prepare('SELECT * FROM site_settings ORDER BY group_name, key').all();
  cache = Object.fromEntries(rows.map(r => [r.key, r]));
  return cache;
}

/**
 * Flat key -> coerced value map.
 * @param {object} opts
 * @param {boolean} opts.publicOnly - strip rows flagged admin-only
 */
export function getSettings({ publicOnly = false } = {}) {
  const rows = getSettingsRows();
  const out = Object.create(null);
  for (const [key, row] of Object.entries(rows)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (publicOnly && !row.public) continue;
    out[key] = coerce(row.value, row.type);
  }
  return out;
}

export function getSetting(key, fallback = null) {
  const rows = getSettingsRows();
  const row = Object.hasOwn(rows, key) ? rows[key] : undefined;
  if (!row) return fallback;
  const v = coerce(row.value, row.type);
  return v === null || v === undefined || v === '' ? fallback : v;
}

/**
 * Update settings. Unknown keys are rejected so a typo can't silently create
 * an orphaned setting. Returns the coerced values that were written.
 */
export function updateSettings(patch, { allowUnknownKeys = false } = {}) {
  const db = getDb();
  const rows = getSettingsRows();
  const reserved = Object.keys(patch).filter(k => RESERVED_KEYS.has(k));
  if (reserved.length) {
    const err = new Error(`Reserved setting key(s): ${reserved.join(', ')}`);
    err.statusCode = 400;
    err.unknownKeys = reserved;
    throw err;
  }
  const unknown = Object.keys(patch).filter(k => !Object.hasOwn(rows, k));
  if (unknown.length && !allowUnknownKeys) {
    const err = new Error(`Unknown setting key(s): ${unknown.join(', ')}`);
    err.statusCode = 400;
    err.unknownKeys = unknown;
    throw err;
  }

  const stmt = db.prepare(`
    INSERT INTO site_settings (key, value, type, group_name, label, description, public, updated_at)
    VALUES (@key, @value, @type, @group_name, @label, @description, @public, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = CURRENT_TIMESTAMP
  `);

  const written = Object.create(null);
  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      const existing = Object.hasOwn(rows, key) ? rows[key] : undefined;
      const type = existing?.type || 'text';
      const serial = serialize(value);
      stmt.run({
        key,
        value: serial,
        type,
        group_name: existing?.group_name || 'general',
        label: existing?.label || key,
        description: existing?.description || null,
        public: existing?.public ?? 1,
      });
      written[key] = coerce(serial, type);
    }
  });
  run();
  cache = null;
  return written;
}

/** Metadata about each setting, for rendering the admin form dynamically. */
export function getSettingsMeta({ publicOnly = false } = {}) {
  return Object.values(getSettingsRows())
    .filter(r => (publicOnly ? !!r.public : true))
    .map(r => ({
      key: r.key,
      type: r.type,
      group: r.group_name,
      label: r.label || r.key,
      description: r.description || '',
      public: !!r.public,
    }));
}

export function invalidateSettingsCache() {
  cache = null;
}

export const settingsService = {
  getSettings,
  getSetting,
  getSettingsMeta,
  updateSettings,
  invalidateSettingsCache,
};
