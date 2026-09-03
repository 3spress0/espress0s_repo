import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Upgrading a database that predates the catalogue work.
 *
 * The schema block in SCHEMA_SQL runs before the ALTER guards in db/index.js,
 * so an index on a column that only the ALTER adds would fail with
 * "no such column" on every existing deployment. These tests build a genuine
 * pre-catalogue database and run the real init path against it.
 *
 * Private on-disk database: config.js resolves a relative DATABASE_PATH against
 * the project root, so ':memory:' would create a file with that name.
 */
const TEST_DB = path.join(os.tmpdir(), `migration-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
process.env.DATABASE_PATH = TEST_DB;

/**
 * The pre-catalogue shape of the two tables the migration touches. Taken from
 * the schema as it stood before `status` / `banner_url` / `item_relations` /
 * `catalog_imports` existed. Everything else is left to SCHEMA_SQL, which
 * creates missing tables with IF NOT EXISTS.
 */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  long_description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  version TEXT,
  release_date DATE,
  file_name TEXT,
  file_size INTEGER, -- bytes
  file_type TEXT, -- iso, exe, zip, pdf, etc
  platform TEXT, -- windows, linux, macos, cross-platform
  architecture TEXT, -- x86, x64, arm64, universal
  sha256 TEXT,
  md5 TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'local' CHECK(storage_provider IN ('local', 'gdrive', 'onedrive', 'github', 'external')),
  storage_path TEXT, -- encrypted: path or file ID in external storage
  download_url TEXT, -- encrypted: direct or constructed URL
  external_url TEXT, -- encrypted: original source URL if applicable
  featured INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  license_status TEXT DEFAULT 'check-license' CHECK(license_status IN ('public-domain', 'redistributable', 'proprietary', 'check-license', 'internal-only', 'abandonware')),
  license_notes TEXT, -- encrypted
  tags TEXT, -- JSON array for simplicity, plus junction table
  icon_url TEXT,
  image_url TEXT, -- cover image selected by admin, placeholder if none
  screenshots TEXT, -- JSON array of URLs
  documentation_url TEXT,
  changelog TEXT,
  download_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  encryption_version TEXT DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS item_download_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label TEXT NOT NULL, -- e.g., "Google Drive Mirror 1", "OneDrive EU", "Direct"
  storage_provider TEXT NOT NULL DEFAULT 'external' CHECK(storage_provider IN ('local', 'gdrive', 'onedrive', 'github', 'external')),
  storage_path TEXT, -- encrypted: file ID or path in external storage
  download_url TEXT, -- encrypted: direct URL
  file_size INTEGER, -- optional override per mirror
  is_primary INTEGER DEFAULT 0, -- primary mirror
  is_down INTEGER DEFAULT 0, -- marked as down by admin or checker
  down_reason TEXT, -- reason why down
  status TEXT DEFAULT 'up' CHECK(status IN ('up', 'down', 'unknown', 'checking')),
  last_checked DATETIME, -- last health check
  http_status INTEGER, -- last HTTP response code seen by the link checker
  check_error TEXT, -- last checker error/verdict message
  check_duration_ms INTEGER, -- how long the last probe took
  sort_order INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

describe('Migrating a pre-catalogue database', () => {
  let db;
  let getDb;
  const indexNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  const tableNames = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  before(async () => {
    // Build the legacy database and put real rows in it, so the tests can
    // prove the upgrade preserved them rather than merely that it did not throw.
    const raw = new Database(TEST_DB);
    raw.pragma('journal_mode = WAL');
    raw.exec(LEGACY_SCHEMA);
    raw.prepare(`INSERT INTO categories (name, slug) VALUES ('Legacy Category', 'legacy-category')`).run();
    raw.prepare(`
      INSERT INTO items (name, slug, description, platform, version, category_id, release_date)
      VALUES ('Legacy Row', 'legacy-row', 'pre-migration data', 'Linux', '1.0', 1, '2020-01-01')
    `).run();
    raw.prepare(`
      INSERT INTO item_download_links (item_id, label, download_url, is_primary)
      VALUES (1, 'Primary mirror', 'https://example.com/legacy.iso', 1)
    `).run();
    raw.close();

    // Sanity: confirm this really is the old shape before migrating it.
    const check = new Database(TEST_DB, { readonly: true });
    const itemCols = check.prepare('PRAGMA table_info(items)').all().map(c => c.name);
    assert.ok(!itemCols.includes('status'), 'fixture must not already have status');
    assert.ok(!itemCols.includes('banner_url'), 'fixture must not already have banner_url');
    check.close();

    // The real init path. DATABASE_PATH is set above and config.js reads it at
    // import time, so this must be a dynamic import.
    ({ getDb } = await import('../src/db/index.js'));
    db = getDb();
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
  });

  it('adds the catalogue columns with a usable default', () => {
    assert.ok(columns('items').includes('status'));
    assert.ok(columns('items').includes('banner_url'));
    const row = db.prepare("SELECT status, banner_url FROM items WHERE slug = 'legacy-row'").get();
    assert.equal(row.status, 'current', 'existing rows should default to current, not null');
    assert.equal(row.banner_url, null);
  });

  it('preserves existing rows and their data', () => {
    const row = db.prepare(`
      SELECT name, slug, description, platform, version, release_date, category_id
      FROM items WHERE slug = 'legacy-row'
    `).get();
    assert.equal(row.name, 'Legacy Row');
    assert.equal(row.description, 'pre-migration data');
    assert.equal(row.platform, 'Linux');
    assert.equal(row.version, '1.0');
    assert.equal(row.release_date, '2020-01-01');
    assert.equal(row.category_id, 1, 'the category link must survive');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, 1);
  });

  it('preserves existing download links', () => {
    const link = db.prepare('SELECT label, download_url, is_primary FROM item_download_links').get();
    assert.equal(link.label, 'Primary mirror');
    assert.equal(link.download_url, 'https://example.com/legacy.iso');
    assert.equal(link.is_primary, 1);
  });

  it('creates the catalogue tables', () => {
    assert.ok(tableNames().includes('item_relations'), 'item_relations should exist');
    assert.ok(tableNames().includes('catalog_imports'), 'catalog_imports should exist');
  });

  it('creates indexes on columns added by ALTER', () => {
    // These two index ALTER-added columns. If they were in SCHEMA_SQL the init
    // above would have thrown before reaching this test.
    assert.ok(indexNames().includes('idx_items_status'), 'idx_items_status');
    assert.ok(indexNames().includes('idx_download_links_item_status'), 'idx_download_links_item_status');
  });

  it('creates indexes for the admin filter and sort columns', () => {
    for (const name of ['idx_items_version', 'idx_items_release_date', 'idx_items_storage_provider', 'idx_items_updated']) {
      assert.ok(indexNames().includes(name), `${name} should exist`);
    }
  });

  it('is idempotent - a second init changes nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM items').get().c;
    const idxBefore = indexNames().length;
    // Re-running the guarded block must not duplicate indexes or rows.
    getDb();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, before);
    assert.equal(indexNames().length, idxBefore);
  });
});
