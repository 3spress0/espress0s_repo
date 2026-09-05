import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Similar software (#21): deterministic scoring from tags / category /
 * relations / text, AI rerank that can only reorder the pool, and the
 * public route.
 */
const { getDb } = await import('../src/db/index.js');
const { itemsRoutes } = await import('../src/routes/items.js');
const { scoreSimilar, similarItems, clearSimilarCache } = await import('../src/services/similarService.js');
const cookie = (await import('@fastify/cookie')).default;
const rateLimit = (await import('@fastify/rate-limit')).default;

let app, db, ids = {};
const seed = [
  ['sim-editor-a', 'Textor Editor', 'A fast text editor with syntax highlighting', 'windows', '["editor","text","code"]'],
  ['sim-editor-b', 'CodePad', 'Lightweight code editor with syntax highlighting and plugins', 'windows', '["editor","code"]'],
  ['sim-editor-c', 'NoteMark', 'Markdown note editor', 'linux', '["editor","markdown"]'],
  ['sim-game', 'Asteroid Blaster', 'Retro arcade shooter game', 'windows', '["game","arcade"]'],
  ['sim-draft', 'Secret Editor', 'Unpublished editor', 'windows', '["editor"]'],
];

before(async () => {
  db = getDb();
  db.prepare("INSERT OR IGNORE INTO categories (name, slug) VALUES ('Sim Tools', 'sim-tools')").run();
  const cat = db.prepare("SELECT id FROM categories WHERE slug = 'sim-tools'").get().id;
  for (const [slug, name, desc, platform, tags] of seed) {
    db.prepare(`INSERT OR IGNORE INTO items (name, slug, description, published, file_type, platform, tags, category_id)
                VALUES (?, ?, ?, ?, 'zip', ?, ?, ?)`).run(name, slug, desc, slug === 'sim-draft' ? 0 : 1, platform, tags, slug === 'sim-game' ? null : cat);
    ids[slug] = db.prepare('SELECT id FROM items WHERE slug = ?').get(slug).id;
  }
  clearSimilarCache();
  app = Fastify();
  await app.register(cookie, { secret: 'similar-test-cookie-secret-0123456789abcdef' });
  await app.register(rateLimit, { global: false });
  await app.register(async (api) => { await api.register(itemsRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('similar: deterministic scoring', () => {
  it('ranks by shared tags, category and text, and skips drafts', () => {
    const out = scoreSimilar(ids['sim-editor-a']);
    const slugs = out.map((o) => o.slug);
    assert.equal(slugs[0], 'sim-editor-b', JSON.stringify(out.map((o) => [o.slug, o.score, o.why])));
    assert.ok(slugs.indexOf('sim-editor-c') < slugs.indexOf('sim-game') || !slugs.includes('sim-game'));
    assert.ok(!slugs.includes('sim-draft'));
    assert.ok(!slugs.includes('sim-editor-a'));
    assert.ok(out[0].why.includes('shares'));
  });

  it('curator relations outrank everything', () => {
    db.prepare('INSERT OR IGNORE INTO item_relations (item_id, related_item_id, relation) VALUES (?, ?, ?)').run(ids['sim-editor-a'], ids['sim-game'], 'related');
    const out = scoreSimilar(ids['sim-editor-a']);
    assert.equal(out[0].slug, 'sim-game');
    assert.ok(out[0].why.includes('curator'));
    db.prepare('DELETE FROM item_relations WHERE item_id = ?').run(ids['sim-editor-a']);
  });

  it('returns [] for unknown items', () => {
    assert.deepEqual(scoreSimilar(999999), []);
  });
});

describe('similar: AI rerank', () => {
  const fakeAi = (cfg) => ({ aiConfig: async () => cfg });

  it('falls back to deterministic order when no provider is configured', async () => {
    clearSimilarCache();
    const res = await similarItems(ids['sim-editor-a'], { aiService: fakeAi({ enabled: false, provider: 'none' }) });
    assert.equal(res.usedAI, false);
    assert.equal(res.items[0].slug, 'sim-editor-b');
  });

  it('falls back (with aiError) when the provider throws', async () => {
    clearSimilarCache();
    const broken = { aiConfig: async () => { throw new Error('boom'); } };
    const res = await similarItems(ids['sim-editor-a'], { aiService: broken });
    assert.equal(res.usedAI, false);
    assert.match(res.aiError, /boom/);
    assert.equal(res.items[0].slug, 'sim-editor-b');
  });

  it('accepts a model reorder but drops ids outside the pool', async () => {
    clearSimilarCache();
    const { generate } = await import('../src/services/aiProviders.js');
    // Route the "openai" transport at a local stub that returns a reorder
    // naming a hallucinated id first.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ranked: [{ id: 424242, why: 'made up' }, { id: ids['sim-editor-c'], why: 'also an editor' }, { id: ids['sim-editor-b'], why: 'code' }] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const cfg = { enabled: true, provider: 'openai', format: 'openai', apiKey: 'sk-test', model: 'm', baseUrl: 'https://api.openai.com/v1', baseUrlIsDefault: true, timeoutMs: 5000, draftTimeoutMs: 5000, maxTokens: 500 };
      const res = await similarItems(ids['sim-editor-a'], { aiService: fakeAi(cfg) });
      assert.equal(res.usedAI, true, JSON.stringify(res));
      assert.equal(res.items[0].slug, 'sim-editor-c');
      assert.equal(res.items[0].why, 'also an editor');
      assert.ok(!res.items.some((i) => i.id === 424242));
    } finally {
      globalThis.fetch = realFetch;
      void generate;
    }
  });
});

describe('similar: route', () => {
  it('serves published items only and honours ?ai=0', async () => {
    clearSimilarCache();
    const res = await app.inject({ method: 'GET', url: '/api/items/sim-editor-a/similar?ai=0' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().usedAI, false);
    assert.equal(res.json().items[0].slug, 'sim-editor-b');
    assert.ok(!('download_url' in res.json().items[0]) || res.json().items[0].download_url == null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/items/sim-draft/similar' })).statusCode, 404);
  });
});
