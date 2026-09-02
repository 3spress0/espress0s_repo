import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Version-history + folders tests. They use a throwaway SQLite database in a
 * temp directory, so they run anywhere `npm install` succeeded - no server
 * needed:
 *   node --test tests/versioning.test.js
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-test-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.db');

const { getDb, closeDb } = await import('../src/db/index.js');
const { recordItemVersion, diffSnapshots, listVersions, restoreItemVersion } = await import('../src/services/versionService.js');

after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function insertItem(db, fields = {}) {
  const res = db.prepare(`
    INSERT INTO items (name, slug, description, folder_id, storage_provider, storage_path, download_url, published)
    VALUES (@name, @slug, @description, @folder_id, 'external', NULL, NULL, 1)
  `).run({
    name: fields.name || 'Test Item',
    slug: fields.slug || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: fields.description || 'A test item description',
    folder_id: fields.folder_id ?? null,
  });
  return res.lastInsertRowid;
}

describe('folders schema', () => {
  it('has a folders table and folder_id on items', () => {
    const db = getDb();
    const folderCols = db.prepare('PRAGMA table_info(folders)').all().map(c => c.name);
    const itemCols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
    assert.ok(folderCols.includes('slug'), 'folders.slug exists');
    assert.ok(itemCols.includes('folder_id'), 'items.folder_id exists');
  });

  it('unfiles items when their folder is deleted (SET NULL)', () => {
    const db = getDb();
    db.prepare("INSERT INTO folders (name, slug) VALUES ('Temp Folder', 'temp-folder')").run();
    const folderId = db.prepare("SELECT id FROM folders WHERE slug = 'temp-folder'").get().id;
    const itemId = insertItem(db, { name: 'FolderItem', folder_id: folderId });
    assert.equal(db.prepare('SELECT folder_id FROM items WHERE id = ?').get(itemId).folder_id, folderId);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    assert.equal(db.prepare('SELECT folder_id FROM items WHERE id = ?').get(itemId).folder_id, null);
  });
});

describe('item version history', () => {
  it('records a Created version on first snapshot', () => {
    const db = getDb();
    const itemId = insertItem(db, { name: 'Versioned One' });
    const v = recordItemVersion(itemId, null);
    assert.equal(v.version_num, 1);
    const versions = listVersions(itemId);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].change_summary, 'Created');
  });

  it('summarises changed fields on later snapshots', () => {
    const db = getDb();
    const itemId = insertItem(db, { name: 'Versioned Two' });
    recordItemVersion(itemId, null);
    db.prepare('UPDATE items SET description = ?, version = ? WHERE id = ?')
      .run('A changed description text', '2.0', itemId);
    recordItemVersion(itemId, null);
    const versions = listVersions(itemId);
    assert.equal(versions.length, 2);
    assert.ok(versions[0].change_summary.includes('description'));
    assert.ok(versions[0].change_summary.includes('version'));
  });

  it('restores an older snapshot including download links', () => {
    const db = getDb();
    const itemId = insertItem(db, { name: 'Restorable' });
    db.prepare(`
      INSERT INTO item_download_links (item_id, label, storage_provider, download_url, is_primary, status)
      VALUES (?, 'Original mirror', 'external', 'https://example.com/a.zip', 1, 'up')
    `).run(itemId);
    recordItemVersion(itemId, null); // v1 with 1 link

    db.prepare("UPDATE items SET name = 'Restorable (edited)' WHERE id = ?").run(itemId);
    db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(itemId);
    recordItemVersion(itemId, null); // v2 without links

    const restored = restoreItemVersion(itemId, 1, null);
    assert.equal(restored.name, 'Restorable');
    assert.equal(restored.download_links.length, 1);
    assert.equal(restored.download_links[0].label, 'Original mirror');

    const versions = listVersions(itemId);
    assert.equal(versions[0].change_summary, 'Restored from version 1');
  });

  it('diffSnapshots flags download-link count changes', () => {
    const prev = { name: 'A', download_links: [{ label: 'x', download_url: 'https://a.b/c' }] };
    const next = { name: 'A', download_links: [] };
    const diff = diffSnapshots(prev, next);
    assert.ok(diff.some(d => d.includes('download links')));
  });
});
