import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { SCHEMA_SQL, DEFAULT_SETTINGS } from './schema.js';

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  // Ensure data directory exists
  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(config.db.path);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  // Initialize schema
  dbInstance.exec(SCHEMA_SQL);

  // Migrations for encryption columns (add if not exists)
  try {
    const userCols = dbInstance.prepare("PRAGMA table_info(users)").all();
    const hasEmailHash = userCols.some(c => c.name === 'email_hash');
    if (!hasEmailHash) {
      dbInstance.exec("ALTER TABLE users ADD COLUMN email_hash TEXT");
      dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash)");
    }
    const hasEncVersion = userCols.some(c => c.name === 'encryption_version');
    if (!hasEncVersion) dbInstance.exec("ALTER TABLE users ADD COLUMN encryption_version TEXT DEFAULT 'v1'");
    const hasAvatar = userCols.some(c => c.name === 'avatar_url');
    if (!hasAvatar) dbInstance.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT");
    const hasBio = userCols.some(c => c.name === 'bio');
    if (!hasBio) dbInstance.exec("ALTER TABLE users ADD COLUMN bio TEXT");
    const hasTheme = userCols.some(c => c.name === 'theme');
    if (!hasTheme) dbInstance.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'");
    const hasAuthVersion = userCols.some(c => c.name === 'auth_version');
    if (!hasAuthVersion) dbInstance.exec("ALTER TABLE users ADD COLUMN auth_version INTEGER DEFAULT 0");
    // Favourites default to private; this only stores the user's chosen
    // starting point for new ones. Added with ALTER as well as in SCHEMA_SQL
    // because existing databases were created before the column existed.
    const hasFavDefault = userCols.some(c => c.name === 'favorites_default_public');
    if (!hasFavDefault) dbInstance.exec("ALTER TABLE users ADD COLUMN favorites_default_public INTEGER NOT NULL DEFAULT 0");
    // Optional TOTP second factor (see services/totpService.js).
    if (!userCols.some(c => c.name === 'totp_secret')) dbInstance.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
    if (!userCols.some(c => c.name === 'totp_enabled')) dbInstance.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0");
    if (!userCols.some(c => c.name === 'totp_recovery')) dbInstance.exec("ALTER TABLE users ADD COLUMN totp_recovery TEXT");
    if (!userCols.some(c => c.name === 'totp_last_counter')) dbInstance.exec("ALTER TABLE users ADD COLUMN totp_last_counter INTEGER");

    // Email became optional (you can register without one). Databases created
    // before this had `email TEXT UNIQUE NOT NULL`, which rejects the NULL a
    // no-email registration now inserts. SQLite cannot drop a NOT NULL in
    // place, so rebuild the table once when the old constraint is still there.
    // Detect via PRAGMA: `notnull` is 1 on the legacy column, 0 after the fix.
    const emailCol = userCols.find(c => c.name === 'email');
    if (emailCol && emailCol.notnull === 1) {
      const rebuildUsers = dbInstance.transaction(() => {
        // Column set must match the current schema (order is not important, we
        // list columns explicitly on both sides of the copy).
        dbInstance.exec(`
          CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            email_hash TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'editor', 'viewer')),
            auth_version INTEGER DEFAULT 0,
            avatar_url TEXT,
            bio TEXT,
            theme TEXT DEFAULT 'dark' CHECK(theme IN ('dark', 'light', 'auto')),
            favorites_default_public INTEGER NOT NULL DEFAULT 0,
            totp_secret TEXT,
            totp_enabled INTEGER NOT NULL DEFAULT 0,
            totp_recovery TEXT,
            totp_last_counter INTEGER,
            encryption_version TEXT DEFAULT 'v1',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO users_new
            (id, username, email, email_hash, password_hash, role, auth_version,
             avatar_url, bio, theme, favorites_default_public,
             totp_secret, totp_enabled, totp_recovery, totp_last_counter, encryption_version,
             created_at, updated_at)
          SELECT
            id, username, email, email_hash, password_hash, role, auth_version,
            avatar_url, bio, theme, favorites_default_public,
            totp_secret, totp_enabled, totp_recovery, totp_last_counter, encryption_version,
            created_at, updated_at
          FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);
        `);
      });
      rebuildUsers();
      console.log('Migrated users table: email is now optional (nullable).');
    }

    const itemCols = dbInstance.prepare("PRAGMA table_info(items)").all();
    const hasItemEncVersion = itemCols.some(c => c.name === 'encryption_version');
    if (!hasItemEncVersion) {
      dbInstance.exec("ALTER TABLE items ADD COLUMN encryption_version TEXT DEFAULT 'v1'");
    }
    const hasImageUrl = itemCols.some(c => c.name === 'image_url');
    if (!hasImageUrl) {
      dbInstance.exec("ALTER TABLE items ADD COLUMN image_url TEXT");
    }
    // Catalogue additions. Both are nullable/defaulted so existing rows stay
    // valid, and the CHECK default satisfies itself, which SQLite requires.
    const hasBannerUrl = itemCols.some(c => c.name === 'banner_url');
    if (!hasBannerUrl) {
      dbInstance.exec("ALTER TABLE items ADD COLUMN banner_url TEXT");
    }
    const hasStatus = itemCols.some(c => c.name === 'status');
    if (!hasStatus) {
      dbInstance.exec(`ALTER TABLE items ADD COLUMN status TEXT DEFAULT 'current'
        CHECK(status IN ('current', 'legacy', 'deprecated', 'archived', 'unreleased'))`);
    }
    // Created here, not in SCHEMA_SQL: on a database that predates the column
    // the schema block runs before this ALTER, so indexing it there would fail
    // with "no such column: status".
    dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)");
    if (!itemCols.some(c => c.name === 'requirements')) {
      dbInstance.exec("ALTER TABLE items ADD COLUMN requirements TEXT");
    }
    const hasFolderId = itemCols.some(c => c.name === 'folder_id');
    const hookCols = dbInstance.prepare("PRAGMA table_info(webhooks)").all();
    if (hookCols.length && !hookCols.some(c => c.name === 'filter_mode')) {
      dbInstance.exec("ALTER TABLE webhooks ADD COLUMN filter_mode TEXT NOT NULL DEFAULT 'all' CHECK(filter_mode IN ('all', 'subscribed'))");
    }
    const importCols = dbInstance.prepare("PRAGMA table_info(catalog_imports)").all();
    if (importCols.length && !importCols.some(c => c.name === 'duplicate_count')) {
      dbInstance.exec("ALTER TABLE catalog_imports ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasFolderId) {
      dbInstance.exec("ALTER TABLE items ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL");
      dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_items_folder ON items(folder_id)");
    }

    // Ensure item_download_links table exists (for existing DBs)
    try {
      dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS item_download_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          storage_provider TEXT NOT NULL DEFAULT 'external' CHECK(storage_provider IN ('local', 'gdrive', 'onedrive', 'github', 'external')),
          storage_path TEXT,
          download_url TEXT,
          file_size INTEGER,
          is_primary INTEGER DEFAULT 0,
          is_down INTEGER DEFAULT 0,
          down_reason TEXT,
          status TEXT DEFAULT 'up' CHECK(status IN ('up', 'down', 'unknown', 'checking')),
          last_checked DATETIME,
          sort_order INTEGER DEFAULT 0,
          download_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_download_links_item ON item_download_links(item_id);
        CREATE INDEX IF NOT EXISTS idx_download_links_primary ON item_download_links(item_id, is_primary);
        CREATE INDEX IF NOT EXISTS idx_download_links_down ON item_download_links(is_down);
      `);

      // Migrations for new columns in existing table
      const linkCols = dbInstance.prepare("PRAGMA table_info(item_download_links)").all();
      const hasIsDown = linkCols.some(c => c.name === 'is_down');
      if (!hasIsDown) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN is_down INTEGER DEFAULT 0");
      const hasDownReason = linkCols.some(c => c.name === 'down_reason');
      if (!hasDownReason) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN down_reason TEXT");
      const hasStatus = linkCols.some(c => c.name === 'status');
      if (!hasStatus) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN status TEXT DEFAULT 'up'");
      // Serves the admin link-health filter ("does this item have a link in
      // state X"); item_id first so the EXISTS subquery can seek.
      dbInstance.exec("CREATE INDEX IF NOT EXISTS idx_download_links_item_status ON item_download_links(item_id, status)");
      const hasLastChecked = linkCols.some(c => c.name === 'last_checked');
      if (!hasLastChecked) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN last_checked DATETIME");
      const hasHttpStatus = linkCols.some(c => c.name === 'http_status');
      if (!hasHttpStatus) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN http_status INTEGER");
      const hasCheckError = linkCols.some(c => c.name === 'check_error');
      if (!hasCheckError) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN check_error TEXT");
      const hasCheckDuration = linkCols.some(c => c.name === 'check_duration_ms');
      if (!hasCheckDuration) dbInstance.exec("ALTER TABLE item_download_links ADD COLUMN check_duration_ms INTEGER");
    } catch (e) {
      console.warn('Download links table migration warning:', e.message);
    }
  } catch (e) {
    console.warn('Migration warning:', e.message);
  }

  // Backfill: items that only have the legacy single download_url/storage_path
  // and no rows in item_download_links. Without this those items show zero
  // mirrors in the editor and the download button has nothing to resolve.
  // Idempotent: only touches items that currently have no link rows.
  try {
    const orphans = dbInstance.prepare(`
      SELECT id, storage_provider, storage_path, download_url, file_size
      FROM items
      WHERE (download_url IS NOT NULL AND download_url != '')
         OR (storage_path IS NOT NULL AND storage_path != '')
    `).all();

    const linkCount = dbInstance.prepare('SELECT COUNT(*) c FROM item_download_links WHERE item_id = ?');
    const insertLink = dbInstance.prepare(`
      INSERT INTO item_download_links
        (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'up', 0)
    `);

    const backfill = dbInstance.transaction(() => {
      let created = 0;
      for (const item of orphans) {
        if (linkCount.get(item.id).c > 0) continue;
        insertLink.run(
          item.id,
          'Primary Mirror',
          item.storage_provider || 'external',
          item.storage_path || null,
          item.download_url || null,
          item.file_size ?? null,
        );
        created++;
      }
      return created;
    });

    const created = backfill();
    if (created) console.log(`Backfilled primary download links for ${created} item(s)`);
  } catch (e) {
    console.warn('Download link backfill warning:', e.message);
  }

  // Seed site settings (INSERT OR IGNORE = never clobbers an admin's edits)
  try {
    const stmt = dbInstance.prepare(`
      INSERT OR IGNORE INTO site_settings (key, value, type, group_name, label, description, public)
      VALUES (@key, @value, @type, @group_name, @label, @description, @public)
    `);
    // Fill in optional keys: better-sqlite3 rejects missing named parameters.
    const normalize = (s) => ({
      key: s.key,
      value: s.value ?? null,
      type: s.type || 'text',
      group_name: s.group_name || 'general',
      label: s.label || s.key,
      description: s.description ?? null,
      public: s.public === undefined ? 1 : s.public,
    });
    const seedAll = dbInstance.transaction((rows) => {
      for (const row of rows) stmt.run(normalize(row));
    });
    seedAll(DEFAULT_SETTINGS);
  } catch (e) {
    console.warn('Settings seed warning:', e.message);
  }

  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// Helper to get item with category name
export function getItemWithCategory(row) {
  if (!row) return null;
  const db = getDb();
  if (row.category_id) {
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(row.category_id);
    return { ...row, category: cat || null };
  }
  return { ...row, category: null };
}
