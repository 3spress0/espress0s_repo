import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

/**
 * Snapshot listing and rollback.
 *
 * Snapshots are plain SQLite files written by `snapshotDatabase` (an online
 * backup, the same mechanism `scripts/backup.sh` uses). Restoring swaps the
 * live file out from under an open connection, which is unsafe while requests
 * are in flight, so a restore instead ATTACHes the snapshot and copies rows
 * back inside a single transaction: if anything fails the database is exactly
 * as it was.
 */

/**
 * Catalogue tables, parents before children. A bulk edit only touches these,
 * so rolling one back must not disturb users, settings or the upload registry.
 */
const CATALOGUE_TABLES = [
  'categories',
  'folders',
  'tags',
  'items',
  'item_download_links',
  'item_tags',
  'item_relations',
];

const ALL_TABLES = [
  ...CATALOGUE_TABLES,
  'faq_entries',
  'site_settings',
  'users',
  'uploads',
];

/** A snapshot path is only valid if it stays inside the backup directory. */
function assertSnapshotPath(filePath) {
  const requested = String(filePath || '');
  if (!requested) throw new Error('path is required');

  const baseDir = fs.realpathSync(config.backupDir);
  // Resolving through realpath collapses `..` and symlink hops, so a crafted
  // path cannot escape the backup directory.
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    throw new Error('That snapshot no longer exists');
  }
  if (resolved !== path.join(baseDir, path.basename(resolved))) {
    throw new Error('Only snapshots inside the backup directory can be restored');
  }
  if (!resolved.endsWith('.db')) throw new Error('Only .db snapshots can be restored');

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('That snapshot is not a file');
  if (stat.size === 0) throw new Error('That snapshot is empty');
  return resolved;
}

/** List snapshots, newest first. */
export function listSnapshots() {
  const dir = config.backupDir;
  if (!fs.existsSync(dir)) return { dir, snapshots: [] };
  const snapshots = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        path: full,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { dir, snapshots };
}

/** Columns both the live table and the snapshot have, in live-table order. */
function commonColumns(db, table, attachedName) {
  const live = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const backup = db.prepare(`PRAGMA ${attachedName}.table_info(${table})`).all().map((c) => c.name);
  const backupSet = new Set(backup);
  return live.filter((column) => backupSet.has(column));
}

/**
 * Roll the catalogue (or everything) back to a snapshot.
 *
 * @param {string} filePath  snapshot inside the backup directory
 * @param {{ scope?: 'catalogue'|'all', dryRun?: boolean }} [options]
 * @returns {{ restored: Record<string, number>, dryRun: boolean, scope: string, path: string }}
 */
export function restoreFromSnapshot(filePath, options = {}) {
  const scope = options.scope === 'all' ? 'all' : 'catalogue';
  const dryRun = !!options.dryRun;
  const resolved = assertSnapshotPath(filePath);

  const db = getDb();
  const tables = scope === 'all' ? ALL_TABLES : CATALOGUE_TABLES;
  const literal = `'${resolved.replace(/'/g, "''")}'`;

  db.exec(`ATTACH DATABASE ${literal} AS restore_src`);
  try {
    // Verify the snapshot is a database from this application before touching
    // anything, so a stray .db file cannot be attached and read.
    const marker = db.prepare(
      "SELECT name FROM restore_src.sqlite_master WHERE type = 'table' AND name = 'items'"
    ).get();
    if (!marker) throw new Error('That file is not an espress0 repo snapshot');

    const existing = new Set(
      db.prepare("SELECT name FROM restore_src.sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const usable = tables.filter((table) => {
      const live = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      return live && existing.has(table);
    });

    const plan = usable.map((table) => ({
      table,
      columns: commonColumns(db, table, 'restore_src'),
      rows: db.prepare(`SELECT COUNT(*) c FROM restore_src.${table}`).get().c,
    }));

    if (dryRun) {
      return {
        dryRun: true,
        scope,
        path: resolved,
        restored: Object.fromEntries(plan.map((p) => [p.table, p.rows])),
      };
    }

    const restored = {};
    // One transaction for the whole rollback: a failure partway through leaves
    // the database untouched rather than half-restored.
    db.transaction(() => {
      db.pragma('foreign_keys = OFF');
      try {
        // Children before parents on the way out...
        for (const { table } of [...plan].reverse()) {
          db.prepare(`DELETE FROM ${table}`).run();
        }
        // ...and parents before children on the way back in.
        for (const { table, columns } of plan) {
          if (!columns.length) continue;
          const list = columns.map((c) => `"${c}"`).join(', ');
          db.prepare(`INSERT INTO ${table} (${list}) SELECT ${list} FROM restore_src.${table}`).run();
          restored[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    })();

    // The FTS index is maintained by triggers on items; rebuild it so search
    // matches the restored rows rather than the ones just deleted.
    try {
      db.prepare("INSERT INTO items_fts (items_fts) VALUES ('rebuild')").run();
    } catch { /* index absent on a database that predates FTS */ }

    return { dryRun: false, scope, path: resolved, restored };
  } finally {
    db.exec('DETACH DATABASE restore_src');
  }
}

export { CATALOGUE_TABLES, ALL_TABLES };
