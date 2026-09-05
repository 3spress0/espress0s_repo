import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Scheduled import jobs reuse the catalogue import pipeline. The tests stub
 * the network (fetchSource) and check: GitHub releases map to valid catalogue
 * entries, a run leaves a catalog_imports history row and real items, dry
 * runs do not, failures are recorded without touching data, and scheduling
 * math holds. Admin-only routes.
 */
const { getDb } = await import('../src/db/index.js');
const { importJobRoutes } = await import('../src/routes/importJobs.js');
const { importJobService, releasesToCatalog, parseRepo, validateJobInput } = await import('../src/services/importJobService.js');
const { zip } = await import('../src/lib/zip.js');
const { generateToken } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;

let app, db, admin, editor;
const auth = (u) => ({ authorization: `Bearer ${generateToken(u)}` });

const RELEASES = [
  { id: 1, tag_name: 'v2.1.0', name: 'Big release', body: '## Notes\n- fast', html_url: 'https://github.com/acme/tool/releases/tag/v2.1.0', published_at: '2026-08-01T10:00:00Z', prerelease: false, draft: false,
    assets: [{ name: 'tool-2.1.0-linux-x64.tar.gz', size: 1234, browser_download_url: 'https://github.com/acme/tool/releases/download/v2.1.0/tool-2.1.0-linux-x64.tar.gz' },
             { name: 'tool-2.1.0-win-x64.zip', size: 2345, browser_download_url: 'https://github.com/acme/tool/releases/download/v2.1.0/tool-2.1.0-win-x64.zip' }] },
  { id: 2, tag_name: 'v2.2.0-rc1', name: 'v2.2.0-rc1', body: '', html_url: 'https://github.com/acme/tool/releases/tag/v2.2.0-rc1', published_at: '2026-08-20T10:00:00Z', prerelease: true, draft: false,
    assets: [{ name: 'tool-2.2.0-rc1-linux-x64.tar.gz', size: 999, browser_download_url: 'https://github.com/acme/tool/releases/download/v2.2.0-rc1/x.tar.gz' }] },
  { id: 3, tag_name: 'v0.1', name: 'draft', draft: true, prerelease: false, assets: [] },
];

before(async () => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('ij_admin', 'ij@example.com', 'pepper_v1:x', 'admin')`).run();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('ij_editor', 'ije@example.com', 'pepper_v1:x', 'editor')`).run();
  admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'ij_admin'").get();
  editor = db.prepare("SELECT id, username, role FROM users WHERE username = 'ij_editor'").get();
  app = Fastify();
  await app.register(cookie);
  await app.register(async (api) => { await api.register(importJobRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { importJobService.stop(); await app?.close(); });

describe('import jobs: github releases mapping', () => {
  it('parses repo identifiers', () => {
    assert.equal(parseRepo('acme/tool'), 'acme/tool');
    assert.equal(parseRepo('https://github.com/acme/tool'), 'acme/tool');
    assert.equal(parseRepo('https://github.com/acme/tool.git'), 'acme/tool');
    assert.equal(parseRepo('https://github.com/acme/tool/releases'), 'acme/tool');
    assert.equal(parseRepo('https://gitlab.com/acme/tool'), null);
  });

  it('maps releases to catalogue entries, skipping drafts and prereleases by default', () => {
    const cat = releasesToCatalog('acme/tool', RELEASES, { category: 'development', tags: ['cli'] });
    assert.equal(cat.format, 'espress0-catalog');
    assert.equal(cat.items.length, 1);
    const it = cat.items[0];
    assert.equal(it.slug, 'tool-v2-1-0');
    assert.equal(it.name, 'tool 2.1.0');
    assert.equal(it.version, '2.1.0');
    assert.equal(it.release_date, '2026-08-01');
    assert.equal(it.category, 'development');
    assert.deepEqual(it.tags, ['cli', 'github', 'acme']);
    assert.equal(it.links.length, 2);
    assert.equal(it.links[0].storage_provider, 'github');
    assert.equal(it.links[0].is_primary, true);
    assert.equal(it.file_name, 'tool-2.1.0-linux-x64.tar.gz');
    assert.equal(it.changelog, '## Notes\n- fast');
  });

  it('honours include_prereleases, asset_pattern, prefix and max_releases', () => {
    const cat = releasesToCatalog('acme/tool', RELEASES, { include_prereleases: true, asset_pattern: 'linux', prefix: 'acme-tool', max_releases: 5 });
    assert.equal(cat.items.length, 2);
    assert.ok(cat.items.every(i => i.slug.startsWith('acme-tool-')));
    assert.ok(cat.items.every(i => i.links.length === 1 && /linux/.test(i.links[0].label)));
    assert.equal(cat.items.find(i => i.version === '2.2.0-rc1').status, 'unreleased');
    assert.equal(releasesToCatalog('acme/tool', RELEASES, { include_prereleases: true, max_releases: 1 }).items.length, 1);
  });

  it('validates job input', () => {
    assert.throws(() => validateJobInput({ name: 'x', source_type: 'ftp', source_url: 'x', mode: 'upsert' }), /source_type/);
    assert.throws(() => validateJobInput({ name: 'x', source_type: 'catalog', source_url: 'file:///etc/passwd', mode: 'upsert' }), /http/);
    assert.throws(() => validateJobInput({ name: 'x', source_type: 'github-releases', source_url: 'nope', mode: 'upsert' }), /owner\/repo/);
    assert.throws(() => validateJobInput({ name: 'x', source_type: 'github-releases', source_url: 'a/b', mode: 'wipe' }), /mode/);
    assert.throws(() => validateJobInput({ name: 'x', source_type: 'github-releases', source_url: 'a/b', mode: 'upsert', options: { asset_pattern: '(' } }), /regular expression/);
    const ok = validateJobInput({ name: ' Job ', source_type: 'github-releases', source_url: 'https://github.com/a/b', mode: 'add-only', interval_minutes: 1 });
    assert.equal(ok.source_url, 'a/b');
    assert.equal(ok.interval_minutes, 15, 'interval floor');
  });
});

describe('import jobs: routes and runs', () => {
  let jobId;

  it('is admin-only', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/import-jobs' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/import-jobs', headers: auth(editor) })).statusCode, 403);
  });

  it('creates a job', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/import-jobs', headers: auth(admin), payload: {
      name: 'Acme tool', source_type: 'github-releases', source_url: 'https://github.com/acme/tool', mode: 'upsert', interval_minutes: 60, options: { category: 'development' },
    } });
    assert.equal(res.statusCode, 201, res.body);
    jobId = res.json().job.id;
    assert.equal(res.json().job.source_url, 'acme/tool');
    assert.equal(res.json().job.enabled, true);
    assert.ok(res.json().job.next_run_at);
    const bad = await app.inject({ method: 'POST', url: '/api/admin/import-jobs', headers: auth(admin), payload: { name: 'x', source_type: 'catalog', source_url: 'not a url', mode: 'upsert' } });
    assert.equal(bad.statusCode, 400);
  });

  it('a dry run reports without writing', async () => {
    importJobService.fetchSource = async () => zip([{ name: 'catalog.json', data: JSON.stringify(releasesToCatalog('acme/tool', RELEASES, { category: 'development' })) }]);
    const before = db.prepare('SELECT COUNT(*) c FROM items').get().c;
    const res = await app.inject({ method: 'POST', url: `/api/admin/import-jobs/${jobId}/run?apply=0`, headers: auth(admin) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().apply, false);
    assert.equal(res.json().report.items.created, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, before);
    assert.equal(res.json().job.run_count, 0, 'dry run does not count');
  });

  it('a real run imports through the pipeline and records history + schedule', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/admin/import-jobs/${jobId}/run`, headers: auth(admin) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().report.items.created, 1);
    const item = db.prepare("SELECT * FROM items WHERE slug = 'tool-v2-1-0'").get();
    assert.ok(item, 'item was created');
    assert.equal(item.version, '2.1.0');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM item_download_links WHERE item_id = ?').get(item.id).c, 2);
    assert.equal(db.prepare("SELECT storage_provider FROM item_download_links WHERE item_id = ? AND is_primary = 1").get(item.id).storage_provider, 'github');
    const hist = db.prepare('SELECT * FROM catalog_imports WHERE id = ?').get(res.json().history.id);
    assert.equal(hist.items_created, 1);
    assert.equal(hist.dry_run, 0);
    assert.equal(hist.imported_by, admin.id);
    const job = res.json().job;
    assert.equal(job.run_count, 1);
    assert.equal(job.last_status, 'ok');
    assert.equal(job.last_report.items.created, 1);
    assert.ok(new Date(job.next_run_at) > new Date(Date.now() + 50 * 60_000), 'next run ~60 min out');
  });

  it('a second run is idempotent (unchanged), and upsert picks up changes', async () => {
    const again = await app.inject({ method: 'POST', url: `/api/admin/import-jobs/${jobId}/run`, headers: auth(admin) });
    assert.equal(again.json().report.items.unchanged, 1);
    const changed = RELEASES.map(r => (r.id === 1 ? { ...r, body: 'Updated notes' } : r));
    importJobService.fetchSource = async () => zip([{ name: 'catalog.json', data: JSON.stringify(releasesToCatalog('acme/tool', changed, { category: 'development' })) }]);
    const upd = await app.inject({ method: 'POST', url: `/api/admin/import-jobs/${jobId}/run`, headers: auth(admin) });
    assert.equal(upd.json().report.items.updated, 1);
    assert.equal(db.prepare("SELECT changelog FROM items WHERE slug = 'tool-v2-1-0'").get().changelog, 'Updated notes');
  });

  it('records a failure without touching data', async () => {
    importJobService.fetchSource = async () => { throw new Error('GitHub is down'); };
    const before = db.prepare('SELECT COUNT(*) c FROM items').get().c;
    const res = await app.inject({ method: 'POST', url: `/api/admin/import-jobs/${jobId}/run`, headers: auth(admin) });
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /GitHub is down/);
    assert.equal(res.json().job.last_status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM items').get().c, before);
  });

  it('tick() runs only due, enabled jobs', async () => {
    let calls = 0;
    importJobService.fetchSource = async () => { calls++; return zip([{ name: 'catalog.json', data: JSON.stringify(releasesToCatalog('acme/tool', RELEASES, {})) }]); };
    await importJobService.tick(); // next_run_at is in the future after the last run
    assert.equal(calls, 0);
    db.prepare("UPDATE import_jobs SET next_run_at = ? WHERE id = ?").run(new Date(0).toISOString(), jobId);
    await importJobService.tick();
    assert.equal(calls, 1);
    await app.inject({ method: 'PUT', url: `/api/admin/import-jobs/${jobId}`, headers: auth(admin), payload: { enabled: false } });
    db.prepare("UPDATE import_jobs SET next_run_at = ? WHERE id = ?").run(new Date(0).toISOString(), jobId);
    await importJobService.tick();
    assert.equal(calls, 1, 'disabled job did not run');
  });

  it('updates and deletes', async () => {
    const upd = await app.inject({ method: 'PUT', url: `/api/admin/import-jobs/${jobId}`, headers: auth(admin), payload: { interval_minutes: 1440, options: { category: 'utilities' } } });
    assert.equal(upd.statusCode, 200, upd.body);
    assert.equal(upd.json().job.interval_minutes, 1440);
    assert.equal(upd.json().job.options.category, 'utilities');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/import-jobs/${jobId}`, headers: auth(admin) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/admin/import-jobs/${jobId}`, headers: auth(admin) })).statusCode, 404);
  });
});
