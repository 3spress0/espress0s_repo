import { describe, it, before } from 'node:test';
import assert from 'node:assert';

/**
 * Fuzzy duplicate detection during catalogue import (#8).
 *
 * Slug identity still decides create vs update. This layer only WARNS: when an
 * entry about to be created looks like an existing row (or an earlier entry in
 * the same archive) by name + version + slug, the preview lists it.
 */
const { getDb } = await import('../src/db/index.js');
const { compareEntries, normalizeName, normalizeVersion, DuplicateIndex } = await import('../src/services/duplicateDetector.js');
const { importCatalogArchive, CATALOG_FORMAT, CATALOG_VERSION } = await import('../src/services/catalogService.js');
const { zip } = await import('../src/lib/zip.js');

let db;
const archive = (items) => zip([{ name: 'catalog.json', data: JSON.stringify({ format: CATALOG_FORMAT, version: CATALOG_VERSION, items }) }]);
const entry = (o) => ({ description: 'fixture entry for duplicate tests', storage_provider: 'external', published: true, ...o });

before(() => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, version, file_type) VALUES ('7-Zip 23.01', 'dup-7zip-2301', 'x', 1, '23.01', 'exe')`).run();
  db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, version, file_type) VALUES ('VLC Media Player', 'dup-vlc', 'x', 1, '3.0.20', 'exe')`).run();
});

describe('duplicate detector: scoring', () => {
  it('normalises names and versions', () => {
    assert.equal(normalizeName('7-Zip 23.01 (x64 installer)').key, '7zip');
    assert.equal(normalizeName('VLC media player v3.0.20').key, 'mediaplayervlc');
    assert.equal(normalizeVersion('v1.2.0'), '1.2');
    assert.equal(normalizeVersion('1-2'), '1.2');
    assert.equal(normalizeVersion(null), null);
  });

  it('flags same name+version as likely, different version as not a duplicate', () => {
    assert.equal(compareEntries({ name: '7-Zip', slug: 'seven-zip', version: '23.01' }, { name: '7-zip 23.01', slug: 'dup-7zip-2301', version: '23.01' }).level, 'likely');
    assert.equal(compareEntries({ name: '7-Zip', slug: 'seven-zip-2401', version: '24.01' }, { name: '7-Zip', slug: 'seven-zip-2301', version: '23.01' }), null);
    assert.equal(compareEntries({ name: 'Blender', slug: 'blender' }, { name: 'Blender 4.2', slug: 'blender-42', version: '4.2' }).level, 'possible');
    assert.equal(compareEntries({ name: 'GIMP', slug: 'gimp' }, { name: 'Inkscape', slug: 'inkscape' }), null);
  });

  it('index finds candidates and honours exclude', () => {
    const idx = new DuplicateIndex([{ id: 1, slug: 'vlc-3-0-20', name: 'VLC Media Player', version: '3.0.20' }]);
    const hits = idx.find({ name: 'vlc media player', slug: 'vlc', version: '3.0.20' });
    assert.equal(hits.length, 1); assert.equal(hits[0].level, 'likely');
    assert.equal(idx.find({ name: 'vlc media player', slug: 'vlc' }, { exclude: (r) => r.id === 1 }).length, 0);
  });
});

describe('duplicate detector: import preview', () => {
  it('warns about an existing row under another slug, without blocking', async () => {
    const { report } = await importCatalogArchive({ buffer: archive([
      entry({ slug: 'seven-zip', name: '7-Zip', version: '23.01' }),
      entry({ slug: 'dup-unique-thing', name: 'Totally Unique Thing', version: '1.0' }),
    ]), apply: false, mode: 'upsert' });
    assert.equal(report.errorCount, 0, JSON.stringify(report.errors));
    assert.equal(report.items.created, 2);
    assert.equal(report.duplicateCount, 1);
    assert.equal(report.duplicates[0].slug, 'seven-zip');
    assert.equal(report.duplicates[0].matches[0].slug, 'dup-7zip-2301');
    assert.equal(report.duplicates[0].matches[0].existing, true);
    assert.equal(report.duplicates[0].matches[0].level, 'likely');
  });

  it('warns about two near-identical entries inside the same archive', async () => {
    const { report } = await importCatalogArchive({ buffer: archive([
      entry({ slug: 'dup-krita-5-2', name: 'Krita', version: '5.2' }),
      entry({ slug: 'dup-krita-52', name: 'Krita 5.2', version: '5.2' }),
    ]), apply: false, mode: 'upsert' });
    assert.equal(report.duplicateCount, 1);
    assert.equal(report.duplicates[0].slug, 'dup-krita-52');
    assert.equal(report.duplicates[0].matches[0].existing, false);
  });

  it('does not flag exact-slug updates, and records the count in history', async () => {
    const { report, history } = await importCatalogArchive({ buffer: archive([
      entry({ slug: 'dup-vlc', name: 'VLC Media Player', version: '3.0.20' }),
    ]), apply: false, mode: 'upsert' });
    assert.equal(report.duplicateCount, 0);
    assert.equal(history.duplicate_count, 0);
    const second = await importCatalogArchive({ buffer: archive([entry({ slug: 'vlc-player', name: 'VLC media player', version: '3.0.20' })]), apply: false, mode: 'upsert' });
    assert.equal(second.history.duplicate_count, 1);
  });
});
