import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Bulk catalogue import/export.
 *
 * Runs against a private in-memory database: the catalogue creates items,
 * groups and relations, and none of that should land in the shared test DB.
 * DATABASE_PATH has to be set before the modules below are imported, because
 * config.js reads it at load time.
 */
// A private on-disk database: config.js resolves a relative DATABASE_PATH
// against the project root, so ':memory:' would create a file with that name.
const TEST_DB = path.join(os.tmpdir(), `catalog-test-${process.pid}.db`);
const TEST_BACKUPS = path.join(os.tmpdir(), `catalog-test-backups-${process.pid}`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
fs.rmSync(TEST_BACKUPS, { recursive: true, force: true });
process.env.DATABASE_PATH = TEST_DB;
process.env.BACKUP_DIR = TEST_BACKUPS;

const { getDb } = await import('../src/db/index.js');
const { zip, unzip } = await import('../src/lib/zip.js');
const {
  CATALOG_FORMAT, CATALOG_VERSION, CATALOG_FILENAME,
  readCatalogFromZip, runCatalogPlan, importCatalogArchive,
  buildCatalogZip, buildTemplateZip, listImports, getImport, CatalogError,
} = await import('../src/services/catalogService.js');

/** Wrap a catalogue document in the archive the endpoint expects. */
function archiveOf(catalog, extra = []) {
  return zip([{ name: CATALOG_FILENAME, data: JSON.stringify(catalog) }, ...extra]);
}

function catalogOf(items, extra = {}) {
  return { format: CATALOG_FORMAT, version: CATALOG_VERSION, items, ...extra };
}

/** A minimal valid entry, cloned so tests cannot leak state into each other. */
function entry(overrides = {}) {
  return {
    slug: 'catalog-test-ubuntu',
    name: 'Catalog Test Ubuntu',
    description: 'Fixture entry used by the catalogue import tests.',
    long_description: '## Overview\n\nFixture body.',
    category: 'catalog-test-category',
    tags: ['fixture', 'linux'],
    platform: 'linux',
    architecture: 'x64',
    status: 'current',
    version: '24.04',
    icon_url: 'https://example.com/icon.png',
    banner_url: 'https://example.com/banner.png',
    links: [{ label: 'Mirror 1', storage_provider: 'external', download_url: 'https://example.com/a.iso', is_primary: true }],
    ...overrides,
  };
}

const itemBySlug = (slug) => getDb().prepare('SELECT * FROM items WHERE slug = ?').get(slug);
const countItems = () => getDb().prepare("SELECT COUNT(*) c FROM items WHERE slug LIKE 'catalog-test-%'").get().c;
const wipe = () => {
  const db = getDb();
  db.prepare("DELETE FROM items WHERE slug LIKE 'catalog-test-%'").run();
  db.prepare("DELETE FROM categories WHERE slug LIKE 'catalog-test-%'").run();
  db.prepare("DELETE FROM folders WHERE slug LIKE 'catalog-test-%'").run();
  db.prepare('DELETE FROM catalog_imports').run();
};

describe('catalogue: archive validation', () => {
  after(wipe);

  it('finds catalog.json at the root and inside a single folder', () => {
    const root = readCatalogFromZip(archiveOf(catalogOf([entry()])));
    assert.equal(root.entryName, CATALOG_FILENAME);

    const nested = zip([{ name: `my-catalog/${CATALOG_FILENAME}`, data: JSON.stringify(catalogOf([entry()])) }]);
    assert.equal(readCatalogFromZip(nested).entryName, `my-catalog/${CATALOG_FILENAME}`);
  });

  it('rejects an archive with no catalog.json', () => {
    const archive = zip([{ name: 'readme.txt', data: 'nothing here' }]);
    assert.throws(() => readCatalogFromZip(archive), (e) => e.code === 'CATALOG_MISSING_JSON');
  });

  it('rejects malformed JSON with a clear message', () => {
    const archive = zip([{ name: CATALOG_FILENAME, data: '{"items": [' }]);
    assert.throws(() => readCatalogFromZip(archive), (e) => e.code === 'CATALOG_BAD_JSON');
  });

  it('rejects a wrong format marker', () => {
    const archive = archiveOf({ format: 'something-else', version: 1, items: [] });
    assert.throws(() => readCatalogFromZip(archive), (e) => e.code === 'CATALOG_SCHEMA');
  });

  it('reports a per-entry problem without rejecting the whole archive', async () => {
    const { catalog } = readCatalogFromZip(archiveOf(catalogOf([
      { slug: 'catalog-test-no-name' },              // missing name/description
      entry({ slug: 'catalog-test-sibling', name: 'Catalog Test Sibling' }),
    ])));

    const report = runCatalogPlan(catalog, { mode: 'upsert', apply: true });
    assert.equal(report.items.created, 1, 'the valid entry should still import');
    assert.equal(report.errorCount, 1, `expected exactly one error: ${JSON.stringify(report.errors)}`);
    assert.match(report.errors[0].error, /name/, 'the error does not name the offending field');
  });

  it('rejects duplicate slugs, which would make idempotency ambiguous', () => {
    const archive = archiveOf(catalogOf([entry(), entry({ name: 'Second copy' })]));
    assert.throws(() => readCatalogFromZip(archive), (e) => e.code === 'CATALOG_DUPLICATE_SLUG');
  });

  it('warns about unknown fields instead of silently dropping them', () => {
    const { warnings } = readCatalogFromZip(archiveOf(catalogOf([entry({ colour: 'red' })])));
    assert.ok(warnings.some((w) => w.includes('colour')), `no warning about the typo: ${warnings}`);
  });
});

describe('catalogue: import modes and idempotency', () => {
  before(wipe);
  after(wipe);

  it('dry run reports what it would do and writes nothing', () => {
    const report = runCatalogPlan(catalogOf([entry()]), { mode: 'upsert', apply: false });
    assert.equal(report.dryRun, true);
    assert.equal(report.items.created, 1);
    assert.equal(report.categories.created, 1, 'the referenced category should be reported as created');
    assert.equal(countItems(), 0, 'a dry run wrote to the database');
  });

  it('applies the same plan and creates the item, category and mirror', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry()])),
      filename: 'catalog.zip',
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.items.created, 1);
    assert.equal(report.errorCount, 0, `unexpected errors: ${JSON.stringify(report.errors)}`);

    const row = itemBySlug('catalog-test-ubuntu');
    assert.ok(row, 'item was not created');
    assert.equal(row.platform, 'linux');
    assert.equal(row.architecture, 'x64');
    assert.equal(row.status, 'current');
    assert.equal(row.banner_url, 'https://example.com/banner.png');
    assert.equal(row.icon_url, 'https://example.com/icon.png');
    assert.equal(JSON.parse(row.tags).length, 2);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM item_download_links WHERE item_id = ?').get(row.id).c, 1);
    assert.ok(getDb().prepare('SELECT id FROM categories WHERE slug = ?').get('catalog-test-category'), 'category not created');
  });

  it('re-importing the identical archive changes nothing (idempotent)', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry()])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.items.created, 0);
    assert.equal(report.items.updated, 0);
    assert.equal(report.items.unchanged, 1, `expected no change, got ${JSON.stringify(report.items)}`);
    assert.equal(countItems(), 1, 'a second import duplicated the item');
  });

  it('matches a slug that makeSlug would rewrite, instead of duplicating it', async () => {
    // makeSlug strips dots, so "catalog-test-7zip-18.06" normalises to
    // "catalog-test-7zip-1806". Matching only the normalised form created a
    // second row on every import.
    const archive = archiveOf(catalogOf([entry({
      slug: 'catalog-test-7zip-18.06',
      name: 'Catalog Test 7zip 18.06',
      version: '18.06',
    })]));

    const first = await importCatalogArchive({ buffer: archive, mode: 'upsert', apply: true });
    assert.equal(first.report.items.created, 1);

    const second = await importCatalogArchive({ buffer: archive, mode: 'upsert', apply: true });
    assert.equal(second.report.items.created, 0, 'a dotted slug was imported as a new item');
    assert.equal(second.report.items.unchanged, 1, JSON.stringify(second.report.items));
    assert.equal(
      getDb().prepare("SELECT COUNT(*) c FROM items WHERE slug LIKE 'catalog-test-7zip%'").get().c,
      1,
      'the dotted slug was duplicated'
    );

    // Later assertions in this suite count fixture rows; do not leave one behind.
    getDb().prepare("DELETE FROM items WHERE slug LIKE 'catalog-test-7zip%'").run();
  });

  it('updates only what actually differs', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({ version: '24.10', platform: 'linux' })])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.items.updated, 1);
    assert.equal(itemBySlug('catalog-test-ubuntu').version, '24.10');
    assert.equal(countItems(), 1);
  });

  it('add-only creates missing entries and leaves existing ones alone', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([
        entry({ version: '99.0' }),                                  // exists -> skip
        entry({ slug: 'catalog-test-new-only', name: 'Catalog Test New Only' }), // new -> create
      ])),
      mode: 'add-only',
      apply: true,
    });
    assert.equal(report.items.skipped, 1, 'add-only should skip the existing slug');
    assert.equal(report.items.created, 1);
    assert.equal(report.items.updated, 0);
    assert.equal(itemBySlug('catalog-test-ubuntu').version, '24.10', 'add-only overwrote an existing item');
  });

  it('update-only touches existing entries and never creates', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([
        entry({ version: '25.04' }),
        entry({ slug: 'catalog-test-never-created', name: 'Catalog Test Never Created' }),
      ])),
      mode: 'update-only',
      apply: true,
    });
    assert.equal(report.items.updated, 1);
    assert.equal(report.items.skipped, 1, 'update-only should skip the unknown slug');
    assert.equal(report.items.created, 0);
    assert.equal(itemBySlug('catalog-test-never-created'), undefined, 'update-only created an item');
    assert.equal(itemBySlug('catalog-test-ubuntu').version, '25.04');
  });

  it('rejects an unknown mode', () => {
    assert.throws(() => runCatalogPlan(catalogOf([entry()]), { mode: 'merge-everything' }), (e) => e.code === 'CATALOG_BAD_MODE');
  });
});

describe('catalogue: field handling', () => {
  before(wipe);
  after(wipe);

  it('stores a long Markdown body intact', async () => {
    const body = `## Overview\n\n${'Detailed prose. '.repeat(4000)}\n\n## Notes\n\n- verify checksums`;
    assert.ok(body.length > 60000, 'fixture should exceed the old 5 000 character cap');
    // Doubles as the regression test for the archive ratio limit: this body
    // compresses ~117:1, which a 100:1 default used to reject as a zip bomb.

    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({ long_description: body })])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.errorCount, 0, `long body rejected: ${JSON.stringify(report.errors)}`);
    assert.equal(itemBySlug('catalog-test-ubuntu').long_description, body);
  });

  it('stores tags, platform, architecture and status', async () => {
    await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({
        tags: ['alpha', 'beta', 'gamma'],
        platform: 'windows',
        architecture: 'arm64',
        status: 'deprecated',
      })])),
      mode: 'upsert',
      apply: true,
    });
    const row = itemBySlug('catalog-test-ubuntu');
    assert.deepEqual(JSON.parse(row.tags), ['alpha', 'beta', 'gamma']);
    assert.equal(row.platform, 'windows');
    assert.equal(row.architecture, 'arm64');
    assert.equal(row.status, 'deprecated');
  });

  it('rejects a status the schema does not allow', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({ slug: 'catalog-test-bad-status', name: 'Catalog Test Bad Status', status: 'vaporware' })])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.items.created, 0);
    assert.ok(report.errorCount > 0, 'an invalid status was accepted');
    assert.ok(report.errors[0].error.includes('status'), `error does not mention status: ${report.errors[0]}`);
  });

  it('refuses a locally stored image URL and says why', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({
        slug: 'catalog-test-local-image',
        name: 'Catalog Test Local Image',
        icon_url: '/api/uploads/abc123.png',
      })])),
      mode: 'upsert',
      apply: true,
    });
    const error = report.errors.find((e) => e.field === 'icon_url');
    assert.ok(error, `no icon_url error recorded: ${JSON.stringify(report.errors)}`);
    assert.match(error.error, /external http\(s\) URL/);
    assert.match(error.error, /never stored locally/);
  });

  it('creates relations between related releases, referenced by slug', async () => {
    wipe();
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([
        entry({ slug: 'catalog-test-ubuntu-2404', name: 'Catalog Test Ubuntu 2404', version: '24.04' }),
        entry({
          slug: 'catalog-test-ubuntu-2204',
          name: 'Catalog Test Ubuntu 2204',
          version: '22.04',
          status: 'legacy',
          related: [{ slug: 'catalog-test-ubuntu-2404', relation: 'superseded-by', note: 'Newer LTS' }],
        }),
      ])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.relations.created, 1, `relation not created: ${JSON.stringify(report)}`);

    const rel = getDb().prepare(`
      SELECT r.relation, r.note FROM item_relations r
      JOIN items a ON a.id = r.item_id
      JOIN items b ON b.id = r.related_item_id
      WHERE a.slug = 'catalog-test-ubuntu-2204' AND b.slug = 'catalog-test-ubuntu-2404'
    `).get();
    assert.ok(rel, 'relation row missing');
    assert.equal(rel.relation, 'superseded-by');
    assert.equal(rel.note, 'Newer LTS');
  });

  it('does not duplicate relations on re-import', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([
        entry({ slug: 'catalog-test-ubuntu-2404', name: 'Catalog Test Ubuntu 2404', version: '24.04' }),
        entry({
          slug: 'catalog-test-ubuntu-2204', name: 'Catalog Test Ubuntu 2204', version: '22.04', status: 'legacy',
          related: [{ slug: 'catalog-test-ubuntu-2404', relation: 'superseded-by', note: 'Newer LTS' }],
        }),
      ])),
      mode: 'upsert',
      apply: true,
    });
    assert.equal(report.relations.created, 0);
    assert.equal(report.relations.unchanged, 1);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM item_relations').get().c, 1);
  });

  it('records an error for a relation pointing at an unknown slug', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({
        slug: 'catalog-test-dangling', name: 'Catalog Test Dangling',
        related: [{ slug: 'catalog-test-does-not-exist' }],
      })])),
      mode: 'upsert',
      apply: true,
    });
    assert.ok(report.errors.some((e) => e.field === 'related'), `no relation error: ${JSON.stringify(report.errors)}`);
    assert.equal(report.relations.skipped, 1);
  });

  it('refuses an item related to itself', async () => {
    const { report } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({
        slug: 'catalog-test-narcissus', name: 'Catalog Test Narcissus',
        related: [{ slug: 'catalog-test-narcissus' }],
      })])),
      mode: 'upsert',
      apply: true,
    });
    assert.ok(report.errors.some((e) => /itself/.test(e.error)), `no self-relation error: ${JSON.stringify(report.errors)}`);
  });
});

describe('catalogue: history, export and template', () => {
  before(wipe);
  after(wipe);

  it('records dry runs and applies in the history, with downloadable errors', async () => {
    const preview = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry()])), filename: 'preview.zip', mode: 'upsert', apply: false,
    });
    assert.equal(preview.history.dry_run, 1);
    assert.equal(preview.history.status, 'ok');

    const applied = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({ banner_url: '/api/uploads/nope.png' })])),
      filename: 'apply.zip', mode: 'upsert', apply: true,
    });
    assert.equal(applied.history.dry_run, 0);
    assert.equal(applied.history.items_created, 1);
    assert.equal(applied.history.mode, 'upsert');
    assert.match(applied.history.sha256, /^[0-9a-f]{64}$/, 'archive checksum not recorded');

    const history = listImports();
    assert.ok(history.length >= 2, 'history is missing rows');
    assert.equal(history.some((h) => h.id === applied.history.id), true);
    assert.equal(history[0].errors_json, undefined, 'the list endpoint should not carry error payloads');

    const detail = getImport(applied.history.id);
    assert.ok(detail.errors.length > 0, 'stored errors are not retrievable');
    assert.equal(detail.errors[0].field, 'banner_url');
  });

  it('records a rejected archive in the history too', async () => {
    try {
      await importCatalogArchive({ buffer: archiveOf({ format: 'nope', version: 1, items: [] }), filename: 'bad.zip', apply: true });
      assert.fail('expected a rejection');
    } catch (e) {
      assert.ok(e.history, 'no history row attached to the rejection');
      assert.equal(e.history.status, 'rejected');
    }
  });

  it('takes a database snapshot before applying', async () => {
    const { history } = await importCatalogArchive({
      buffer: archiveOf(catalogOf([entry({ slug: 'catalog-test-snap', name: 'Catalog Test Snap' })])),
      filename: 'snapshot.zip', apply: true,
    });
    assert.ok(history.backup_path, 'no backup path recorded');
    assert.ok(fs.existsSync(history.backup_path), `backup file missing: ${history.backup_path}`);
    assert.ok(fs.statSync(history.backup_path).size > 0, 'backup file is empty');
    fs.rmSync(history.backup_path, { force: true });
  });

  it('exports a catalogue that imports back with nothing to change', async () => {
    const { buffer, warnings } = buildCatalogZip();
    assert.ok(Array.isArray(warnings));

    // The export must survive its own reader.
    const { catalog } = readCatalogFromZip(buffer);
    assert.equal(catalog.format, CATALOG_FORMAT);
    assert.equal(catalog.version, CATALOG_VERSION);
    assert.ok(catalog.items.some((i) => i.slug === 'catalog-test-ubuntu'), 'export is missing an imported item');

    // Round trip: importing our own export must be a no-op.
    const { report } = await importCatalogArchive({ buffer, filename: 'roundtrip.zip', mode: 'upsert', apply: true });
    assert.equal(report.items.created, 0, 're-importing the export created duplicates');
    assert.equal(report.errorCount, 0, `round trip produced errors: ${JSON.stringify(report.errors.slice(0, 5))}`);
    assert.ok(report.items.unchanged + report.items.updated > 0);
  });

  it('omits locally stored image references from the export', async () => {
    getDb().prepare('UPDATE items SET icon_url = ? WHERE slug = ?')
      .run('/api/uploads/local.png', 'catalog-test-ubuntu');
    const { catalog, warnings } = await import('../src/services/catalogService.js').then((m) => m.buildCatalog());
    const exported = catalog.items.find((i) => i.slug === 'catalog-test-ubuntu');
    assert.equal(exported.icon_url, null, 'a local upload path was exported');
    assert.ok(warnings.some((w) => /locally stored image/.test(w)), `no warning: ${warnings}`);
  });

  it('ships a template archive that is valid and importable', async () => {
    const buffer = buildTemplateZip();
    const { entries } = unzip(buffer);
    assert.ok(entries.some((e) => e.name === CATALOG_FILENAME), 'template has no catalog.json');
    assert.ok(entries.some((e) => e.name === 'README.md'), 'template has no README');

    const { catalog } = readCatalogFromZip(buffer);
    assert.ok(catalog.items.length >= 2, 'template should show a related pair');
    assert.ok(catalog.items.some((i) => i.related?.length), 'template should demonstrate related versions');

    const { report } = await importCatalogArchive({ buffer, filename: 'template.zip', apply: false });
    assert.equal(report.errorCount, 0, `the template does not validate: ${JSON.stringify(report.errors)}`);
    assert.ok(report.items.created >= 2);
  });
});

describe('catalogue: transactional safety', () => {
  after(() => {
    // Restore the table this test drops, then clean up.
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS item_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        related_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related' CHECK(relation IN ('related', 'supersedes', 'superseded-by', 'variant')),
        note TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_id, related_item_id)
      );
    `);
    wipe();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
    fs.rmSync(TEST_BACKUPS, { recursive: true, force: true });
  });

  it('writes nothing at all when the import fails part way through', async () => {
    wipe();
    // Break the relations phase so the failure happens after items are written.
    getDb().exec('DROP TABLE item_relations');

    const buffer = archiveOf(catalogOf([
      entry({ slug: 'catalog-test-tx-a', name: 'Catalog Test Tx A' }),
      entry({
        slug: 'catalog-test-tx-b', name: 'Catalog Test Tx B',
        related: [{ slug: 'catalog-test-tx-a' }],
      }),
    ]));

    let history;
    await assert.rejects(
      () => importCatalogArchive({ buffer, filename: 'broken.zip', apply: true }),
      (e) => { history = e.history; return true; }
    );

    assert.equal(countItems(), 0, 'a failed import left items behind - it was not transactional');
    assert.equal(history?.status, 'failed', `history status was ${history?.status}`);
    assert.equal(getDb().prepare("SELECT COUNT(*) c FROM categories WHERE slug = 'catalog-test-category'").get().c, 0,
      'a failed import left the category behind');
  });
});
