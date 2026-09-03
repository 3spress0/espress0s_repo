import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Catalogue management: the admin filter/sort query builder, facets, stats and
 * the bulk-edit field set.
 *
 * Runs against a private on-disk database (config.js resolves a relative
 * DATABASE_PATH against the project root, so ':memory:' would create a file
 * with that name) so the fixtures cannot disturb the shared test DB.
 */
const TEST_DB = path.join(os.tmpdir(), `catalog-admin-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
process.env.DATABASE_PATH = TEST_DB;

const { getDb } = await import('../src/db/index.js');
const {
  buildCatalogFilters, searchCatalog, catalogFacets, catalogStats,
  ITEM_STATUSES, SORT_COLUMNS,
} = await import('../src/services/catalogQueryService.js');

const SLUG = 'admin-test-';

describe('Catalogue admin queries', () => {
  let db;
  const made = [];

  before(() => {
    db = getDb();

    const category = db.prepare(
      'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)'
    ).run('Admin Test Category', `${SLUG}category`, 'fixture').lastInsertRowid;

    const insert = db.prepare(`
      INSERT INTO items (name, slug, description, category_id, platform, architecture,
                         file_type, version, status, published, icon_url, banner_url,
                         sha256, release_date, external_url, storage_provider, updated_at)
      VALUES (@name, @slug, @description, @category_id, @platform, @architecture,
              @file_type, @version, @status, @published, @icon_url, @banner_url,
              @sha256, @release_date, @external_url, @storage_provider, @updated_at)
    `);

    const rows = [
      {
        name: 'Admin Test Current', slug: `${SLUG}current`,
        platform: 'Linux', architecture: 'amd64', file_type: 'iso', version: '24.04',
        status: 'current', published: 1, icon_url: 'https://example.com/i.png',
        banner_url: 'https://example.com/b.png', sha256: 'a'.repeat(64),
        release_date: '2024-04-25', storage_provider: 'external', updated_at: '2024-05-01',
        external_url: 'https://example.com/download',
      },
      {
        name: 'Admin Test Deprecated', slug: `${SLUG}deprecated`,
        platform: 'Windows', architecture: 'x86', file_type: 'exe', version: '9.0',
        status: 'deprecated', published: 1, icon_url: null, banner_url: null,
        sha256: null, release_date: null, storage_provider: 'external',
        updated_at: '2023-01-01', external_url: null,
      },
      {
        name: 'Admin Test Draft', slug: `${SLUG}draft`,
        platform: 'Linux', architecture: 'arm64', file_type: 'iso', version: '24.10',
        status: 'unreleased', published: 0, icon_url: null, banner_url: null,
        sha256: null, release_date: '2024-10-10', storage_provider: 'local',
        updated_at: '2024-09-01', external_url: null,
      },
    ];

    for (const row of rows) {
      const id = insert.run({ ...row, category_id: category, description: 'fixture page' }).lastInsertRowid;
      made.push(id);
    }

    // One item gets a live mirror, one gets a dead one, so the link-health
    // filter has something to distinguish.
    const link = db.prepare(`
      INSERT INTO item_download_links (item_id, label, download_url, is_primary, is_down, status, last_checked)
      VALUES (?, ?, ?, 1, 0, 'up', '2024-05-01')
    `);
    link.run(made[0], 'Primary mirror', 'https://example.com/a.iso');
    link.run(made[2], 'Primary mirror', 'https://example.com/c.iso');
    db.prepare(`
      UPDATE item_download_links SET is_down = 1, status = 'down' WHERE item_id = ?
    `).run(made[2]);

    // The FTS index is maintained by triggers on items; touch the rows so the
    // search tests see them even if the trigger set is minimal.
    db.prepare('INSERT INTO items_fts (items_fts) VALUES (?)').run('rebuild');
  });

  after(() => {
    for (const id of made) {
      db.prepare('DELETE FROM item_download_links WHERE item_id = ?').run(id);
      db.prepare('DELETE FROM items WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM categories WHERE slug = ?').run(`${SLUG}category`);
  });

  describe('buildCatalogFilters', () => {
    it('emits a bound parameter for every filter value', () => {
      const f = buildCatalogFilters({
        status: 'deprecated',
        platform: 'Windows',
        architecture: 'x86',
        file_type: 'exe',
        version: '9.0',
        category: `${SLUG}category`,
        release_from: '2023-01-01',
        release_to: '2023-12-31',
      });
      // Nothing from the caller is spliced into SQL text.
      for (const sql of f.conditions) {
        assert.ok(!/deprecated|Windows|x86|9\.0/.test(sql), `value leaked into SQL: ${sql}`);
      }
      assert.ok(f.conditions.length >= 7, `expected >=7 conditions, got ${f.conditions.length}`);
      assert.equal(f.params.status, 'deprecated');
      assert.equal(f.params.platform, 'Windows');
    });

    it('rejects an invalid status rather than querying with it', () => {
      assert.throws(() => buildCatalogFilters({ status: 'nope' }), /status/);
    });

    it('rejects an invalid release date', () => {
      assert.throws(() => buildCatalogFilters({ release_from: 'yesterday' }), /release_from/);
      assert.throws(() => buildCatalogFilters({ release_to: '2024-13-99' }), /release_to/);
    });

    it('accepts a valid date and binds it', () => {
      const f = buildCatalogFilters({ release_from: '2024-01-01', release_to: '2024-12-31' });
      assert.equal(f.params.release_from, '2024-01-01');
      assert.equal(f.params.release_to, '2024-12-31');
    });

    it('treats folder=all as "no folder filter", not as a slug', () => {
      // "all" is the admin UI's sentinel for "every folder". Matching it as a
      // slug returned an empty catalogue, which made Admin -> File pages look
      // empty on first load.
      const f = buildCatalogFilters({ folder: 'all' });
      assert.deepEqual(f.conditions, []);
      assert.deepEqual(f.params, {});
    });

    it('still treats folder=none as "unfiled"', () => {
      const f = buildCatalogFilters({ folder: 'none' });
      assert.deepEqual(f.conditions, ['items.folder_id IS NULL']);
    });

    it('ignores a blank filter set entirely', () => {
      const f = buildCatalogFilters({});
      assert.deepEqual(f.conditions, []);
      assert.deepEqual(f.params, {});
      assert.equal(f.ftsQuery, null);
    });
  });

  describe('searchCatalog', () => {
    it('finds fixtures by free text', () => {
      const res = searchCatalog({ q: 'Admin Test Current' });
      assert.ok(res.items.some(i => i.slug === `${SLUG}current`), 'FTS should match the fixture');
      assert.ok(typeof res.total === 'number' && res.total >= 1);
    });

    it('filters by status', () => {
      const res = searchCatalog({ status: 'deprecated', q: 'Admin Test' });
      const slugs = res.items.map(i => i.slug);
      assert.ok(slugs.includes(`${SLUG}deprecated`));
      assert.ok(!slugs.includes(`${SLUG}current`), 'current must be excluded');
    });

    it('filters by platform and architecture together', () => {
      const res = searchCatalog({ platform: 'Linux', architecture: 'arm64' });
      const slugs = res.items.map(i => i.slug);
      assert.ok(slugs.includes(`${SLUG}draft`));
      assert.ok(!slugs.includes(`${SLUG}current`), 'amd64 must be excluded');
    });

    it('filters by published state', () => {
      const published = searchCatalog({ published: 'true', q: 'Admin Test' });
      assert.ok(published.items.every(i => !!i.published));
      const drafts = searchCatalog({ published: 'false', q: 'Admin Test' });
      assert.ok(drafts.items.every(i => !i.published));
      assert.ok(drafts.items.some(i => i.slug === `${SLUG}draft`));
    });

    it('filters by release-date range', () => {
      const res = searchCatalog({ release_from: '2024-10-01', release_to: '2024-10-31' });
      const slugs = res.items.map(i => i.slug);
      assert.ok(slugs.includes(`${SLUG}draft`));
      assert.ok(!slugs.includes(`${SLUG}current`), 'April release is outside the range');
    });

    it('filters by missing data', () => {
      const noIcon = searchCatalog({ missing: 'icon' });
      assert.ok(noIcon.items.every(i => !i.icon_url));
      const noBanner = searchCatalog({ missing: 'banner' });
      assert.ok(noBanner.items.every(i => !i.banner_url));
      const noLinks = searchCatalog({ missing: 'links' });
      assert.ok(noLinks.items.every(i => (i.download_links || []).length === 0));
    });

    it('filters by link health', () => {
      const down = searchCatalog({ link_health: 'down' });
      assert.ok(down.items.some(i => i.slug === `${SLUG}draft`), 'the dead-mirror fixture');
      assert.ok(down.items.every(i => i.link_health !== 'up'));

      const up = searchCatalog({ link_health: 'up' });
      assert.ok(up.items.some(i => i.slug === `${SLUG}current`));

      const missing = searchCatalog({ link_health: 'missing' });
      assert.ok(missing.items.some(i => i.slug === `${SLUG}deprecated`));
    });

    it('filters by category slug', () => {
      const res = searchCatalog({ category: `${SLUG}category` });
      const slugs = res.items.map(i => i.slug);
      for (const suffix of ['current', 'deprecated', 'draft']) {
        assert.ok(slugs.includes(`${SLUG}${suffix}`), `expected ${suffix} in the category`);
      }
    });

    it('sorts by name ascending', () => {
      const res = searchCatalog({ category: `${SLUG}category`, sort: 'name', order: 'asc' });
      const names = res.items.map(i => i.name);
      const sorted = [...names].sort();
      assert.deepEqual(names, sorted);
    });

    it('annotates each row with link health and missing-media flags', () => {
      const res = searchCatalog({ category: `${SLUG}category` });
      for (const row of res.items) {
        assert.ok(['up', 'down', 'unknown', 'checking', 'missing'].includes(row.link_health),
          `unexpected link_health: ${row.link_health}`);
        assert.equal(typeof row.missing_icon, 'boolean');
        assert.equal(typeof row.missing_banner, 'boolean');
      }
    });

    it('paginates', () => {
      const res = searchCatalog({ category: `${SLUG}category`, limit: 1, page: 1 });
      assert.equal(res.items.length, 1);
      assert.equal(res.limit, 1);
      assert.equal(res.total, 3);
      assert.equal(res.totalPages, 3);
      const second = searchCatalog({ category: `${SLUG}category`, limit: 1, page: 2 });
      assert.notEqual(second.items[0].id, res.items[0].id);
    });

    it('falls back to the default sort for an unknown column instead of running it', () => {
      // sort is interpolated into ORDER BY, so an unknown value must never be
      // spliced in - it falls back to updated_at.
      const res = searchCatalog({ category: `${SLUG}category`, sort: 'name; DROP TABLE items' });
      assert.ok(res.items.length > 0);
      assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'items'),
        'items table must survive the injection attempt');
    });

    it('treats a malformed FTS term as a literal search rather than failing', () => {
      // An unbalanced quote is invalid FTS5 syntax; the service falls back to
      // LIKE so the admin still gets results.
      const res = searchCatalog({ q: '"unclosed' });
      assert.ok(Array.isArray(res.items));
    });
  });

  describe('catalogFacets', () => {
    it('lists values that actually exist, with counts', () => {
      const facets = catalogFacets();
      assert.ok(Array.isArray(facets.platforms));
      assert.ok(facets.platforms.some(p => p.value === 'Linux' && p.count >= 2));
      assert.ok(facets.platforms.some(p => p.value === 'Windows'));
      assert.ok(Array.isArray(facets.architectures));
      assert.ok(facets.architectures.some(a => a.value === 'arm64'));
      assert.ok(Array.isArray(facets.categories));
      assert.ok(facets.categories.some(c => c.value === `${SLUG}category`));
      assert.equal(facets.statuses.length, ITEM_STATUSES.length);
    });
  });

  describe('catalogStats', () => {
    it('reports totals, status spread and quality gaps', () => {
      const stats = catalogStats();
      assert.ok(stats.totals.items >= 3);
      assert.equal(stats.byStatus.length, ITEM_STATUSES.length);
      const current = stats.byStatus.find(s => s.value === 'current');
      assert.ok(current.count >= 1);
      assert.ok(stats.quality.missingIcon >= 2, 'two fixtures have no icon');
      assert.ok(stats.quality.missingLinks >= 1);
      assert.ok(stats.linkHealth.down >= 1);
      assert.ok(stats.linkHealth.up >= 1);
      assert.ok(Array.isArray(stats.byPlatform));
      assert.ok(SORT_COLUMNS.name);
    });
  });
});
