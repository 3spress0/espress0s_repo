import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb } from '../src/db/index.js';
import { searchService } from '../src/services/searchService.js';

// Regression tests for the shared filter builder. Both cases used to be
// reachable from a plain GET: a repeated query string parameter
// (?category=a&category=b) arrives as an array, which better-sqlite3 refuses
// to bind, and an unknown category slug silently dropped its own filter and
// returned the whole library.
describe('Search filters', () => {
  // An unseeded database has nothing to search, which would make every
  // assertion below vacuous - so put one row in when the table is empty.
  let canaryId = null;

  before(() => {
    const db = getDb();
    if (db.prepare('SELECT COUNT(*) c FROM items').get().c === 0) {
      canaryId = db.prepare(`
        INSERT INTO items (name, slug, description, tags, published)
        VALUES ('Ubuntu canary', 'ubuntu-canary', 'Fixture row for the search filter tests', '["linux"]', 1)
      `).run().lastInsertRowid;
    }
  });

  after(() => {
    if (canaryId) getDb().prepare('DELETE FROM items WHERE id = ?').run(canaryId);
  });

  it('binds a repeated filter parameter instead of throwing', () => {
    for (const key of ['platform', 'architecture', 'file_type', 'license_status', 'category', 'folder']) {
      const params = { q: 'ubuntu', published: 1, limit: 5, [key]: ['a', 'b'] };
      let result;
      assert.doesNotThrow(() => { result = searchService.search(params); }, `${key} as an array threw`);
      assert.ok(Array.isArray(result.results), `${key} as an array returned no result set`);
    }
  });

  it('an unknown category matches nothing rather than everything', () => {
    const unfiltered = searchService.search({ q: 'ubuntu', published: 1, limit: 5 });
    const bogus = searchService.search({ q: 'ubuntu', category: 'no-such-category', published: 1, limit: 5 });
    assert.ok(unfiltered.total > 0, 'expected at least one searchable item');
    assert.equal(bogus.total, 0, 'an unknown category must not return the whole library');
  });

  it('a known category never widens the result set', () => {
    const db = getDb();
    const cat = db.prepare('SELECT id, slug FROM categories ORDER BY id LIMIT 1').get();
    if (!cat) return; // no categories on a database that was migrated but never seeded
    const unfiltered = searchService.search({ q: 'ubuntu', published: 1, limit: 5 });
    const scoped = searchService.search({ q: 'ubuntu', category: cat.slug, published: 1, limit: 5 });
    assert.ok(scoped.total <= unfiltered.total, 'a category filter must never widen the result set');
    for (const item of scoped.results) {
      assert.equal(item.category_slug, cat.slug, 'every row must belong to the requested category');
    }
  });
});
