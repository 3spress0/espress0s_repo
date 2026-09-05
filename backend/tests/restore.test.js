import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Snapshots and rollback: the undo path behind "create a backup before bulk
 * changes and support transactional rollback".
 *
 * Private on-disk database and backup directory, so nothing here can touch the
 * shared test DB or the developer's real backups.
 */
// Private, unpredictable paths. `restore-test-${process.pid}` is guessable -
// pids are small and observable - so on a shared machine another local user
// could pre-create the file or the backup directory and have both this test
// and the restore it exercises follow it. mkdtempSync gives us a directory
// nobody else can pre-empt.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'espress0-restore-'));
const TEST_DB = path.join(TMP_ROOT, 'restore-test.db');
const TEST_BACKUPS = path.join(TMP_ROOT, 'backups');
fs.mkdirSync(TEST_BACKUPS, { recursive: true });
process.env.DATABASE_PATH = TEST_DB;
process.env.BACKUP_DIR = TEST_BACKUPS;

import Database from 'better-sqlite3';

const { getDb } = await import('../src/db/index.js');
const { snapshotDatabase } = await import('../src/services/catalogService.js');
const { listSnapshots, restoreFromSnapshot, CATALOGUE_TABLES } = await import('../src/services/restoreService.js');

const SLUG = 'restore-test-';

describe('Snapshots and rollback', () => {
  let db;
  let seedId;
  let snapshotPath;

  before(async () => {
    db = getDb();
    seedId = db.prepare(`
      INSERT INTO items (name, slug, description, platform, version, published, status)
      VALUES ('Restore Test Item', ?, 'original', 'Linux', '1.0', 1, 'current')
    `).run(`${SLUG}item`).lastInsertRowid;
    db.prepare(`
      INSERT INTO item_download_links (item_id, label, download_url, is_primary)
      VALUES (?, 'Primary mirror', 'https://example.com/original.iso', 1)
    `).run(seedId);
  });

  after(() => {
    db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(seedId);
    db.prepare('DELETE FROM items WHERE slug LIKE ?').run(`${SLUG}%`);
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it('takes a snapshot that is a real SQLite file', async () => {
    snapshotPath = await snapshotDatabase('restore-test');
    assert.ok(snapshotPath, 'a snapshot path should come back');
    assert.ok(snapshotPath.startsWith(TEST_BACKUPS), `snapshot landed outside the backup dir: ${snapshotPath}`);
    const head = Buffer.alloc(16);
    const fd = fs.openSync(snapshotPath, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    assert.equal(head.toString('latin1', 0, 15), 'SQLite format 3', 'snapshot must be a SQLite database');
  });

  it('lists the snapshot with its size and timestamp', () => {
    const { snapshots } = listSnapshots();
    const found = snapshots.find(s => s.path === snapshotPath);
    assert.ok(found, 'the snapshot should be listed');
    assert.ok(found.sizeBytes > 0);
    assert.ok(found.createdAt);
    assert.ok(found.name.endsWith('.db'));
  });

  it('previews a rollback without writing anything', () => {
    // Change something, then preview: the change must survive the preview.
    db.prepare('UPDATE items SET description = ? WHERE id = ?').run('changed after snapshot', seedId);

    const preview = restoreFromSnapshot(snapshotPath, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.restored.items > 0, 'the preview should report the rows it would restore');
    assert.equal(
      db.prepare('SELECT description FROM items WHERE id = ?').get(seedId).description,
      'changed after snapshot',
      'a dry run must not touch the database'
    );
  });

  it('rolls back a destructive change', () => {
    // Simulate what a bulk delete would do.
    db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(seedId);
    db.prepare('DELETE FROM items WHERE id = ?').run(seedId);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM items WHERE id = ?').get(seedId).c, 0);

    const result = restoreFromSnapshot(snapshotPath, { scope: 'catalogue' });
    assert.equal(result.dryRun, false);
    assert.ok(result.restored.items > 0);

    const row = db.prepare('SELECT name, description, platform, version FROM items WHERE id = ?').get(seedId);
    assert.ok(row, 'the deleted row should be back');
    assert.equal(row.description, 'original', 'it should come back with its original data');
    assert.equal(row.platform, 'Linux');

    const link = db.prepare('SELECT label, download_url FROM item_download_links WHERE item_id = ?').get(seedId);
    assert.ok(link, 'the download link should be back too');
    assert.equal(link.download_url, 'https://example.com/original.iso');
  });

  it('rolls back a field rewrite across many rows', () => {
    db.prepare('UPDATE items SET platform = ?, status = ?').run('Windows', 'archived');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM items WHERE platform = 'Windows'").get().c,
      db.prepare('SELECT COUNT(*) c FROM items').get().c);

    restoreFromSnapshot(snapshotPath, { scope: 'catalogue' });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM items WHERE platform = 'Windows'").get().c, 0,
      'the rewrite should be gone');
    assert.equal(db.prepare('SELECT platform FROM items WHERE id = ?').get(seedId).platform, 'Linux');
  });

  it('restores only the catalogue tables in catalogue scope', () => {
    const usersBefore = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const settingsBefore = db.prepare('SELECT COUNT(*) c FROM site_settings').get().c;

    const result = restoreFromSnapshot(snapshotPath, { scope: 'catalogue' });
    assert.ok(!result.restored.users, 'users must not be in a catalogue-scope restore');
    assert.ok(!result.restored.site_settings, 'settings must not be in a catalogue-scope restore');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, usersBefore);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM site_settings').get().c, settingsBefore);
    assert.ok(CATALOGUE_TABLES.includes('items'));
  });

  it('leaves the search index matching the restored rows', () => {
    restoreFromSnapshot(snapshotPath, { scope: 'catalogue' });
    const hits = db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'original'"
    ).all();
    assert.ok(hits.some(h => h.rowid === seedId), 'the restored description should be searchable');
  });

  it('refuses a path outside the backup directory', () => {
    assert.throws(
      () => restoreFromSnapshot('/etc/passwd'),
      /backup directory|no longer exists/i
    );
    assert.throws(
      () => restoreFromSnapshot(path.join(TEST_BACKUPS, '..', 'evil.db')),
      /backup directory|no longer exists/i
    );
  });

  it('refuses a snapshot that no longer exists', () => {
    assert.throws(
      () => restoreFromSnapshot(path.join(TEST_BACKUPS, 'missing-123.db')),
      /no longer exists/i
    );
  });

  it('refuses a file that is not an espress0 snapshot', () => {
    const bogus = path.join(TEST_BACKUPS, 'bogus.db');
    // Valid SQLite, wrong application: no items table.
    const raw = new Database(bogus);
    raw.exec('CREATE TABLE something_else (id INTEGER)');
    raw.close();

    assert.throws(() => restoreFromSnapshot(bogus), /not an espress0 repo snapshot/i);
    fs.rmSync(bogus, { force: true });
  });

  it('refuses a non-.db file even inside the backup directory', () => {
    const wrong = path.join(TEST_BACKUPS, 'notes.txt');
    fs.writeFileSync(wrong, 'not a database');
    assert.throws(() => restoreFromSnapshot(wrong), /\.db/);
    fs.rmSync(wrong, { force: true });
  });

  it('refuses an empty file', () => {
    const empty = path.join(TEST_BACKUPS, 'empty.db');
    fs.writeFileSync(empty, '');
    assert.throws(() => restoreFromSnapshot(empty), /empty/i);
    fs.rmSync(empty, { force: true });
  });

  it('treats favourites as part of the database, not the catalogue', () => {
    // A favourite points at a user and an item, so it is only in scope for a
    // full rollback. That is deliberate: rolling the *catalogue* back after a
    // bad bulk edit should not cost everyone their stars.
    db.prepare(
      `INSERT OR IGNORE INTO users (username, email, password_hash, role)
       VALUES ('restore-test-user', 'restore-test@example.com', 'pepper_v1:x', 'viewer')`
    ).run();
    const userId = db.prepare("SELECT id FROM users WHERE username = 'restore-test-user'").get().id;
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO favorites (user_id, item_id, is_public) VALUES (?, ?, 1)').run(userId, seedId);

    restoreFromSnapshot(snapshotPath, { scope: 'catalogue' });
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?').get(userId).c, 1,
      'a catalogue rollback must leave favourites alone'
    );

    // The snapshot pre-dates the favourite, so a full rollback removes it -
    // which is exactly what restoring the whole database means.
    const result = restoreFromSnapshot(snapshotPath, { scope: 'all' });
    assert.ok('favorites' in result.restored, 'favourites should be part of an all-scope restore');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?').get(userId).c, 0,
      'a full rollback restores the database to the snapshot, favourites included'
    );

    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(userId);
    db.prepare("DELETE FROM users WHERE username = 'restore-test-user'").run();
  });

  it('keeps snapshots disabled when CATALOG_BACKUP=false', async () => {
    process.env.CATALOG_BACKUP = 'false';
    try {
      assert.equal(await snapshotDatabase('should-not-exist'), null);
    } finally {
      delete process.env.CATALOG_BACKUP;
    }
  });
});
