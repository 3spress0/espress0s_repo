import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Bulk import formats (#14): CSV and bare JSON are converted into the
 * catalogue archive shape and then go through the one import pipeline.
 */
const { getDb } = await import('../src/db/index.js');
const { parseCsv, csvToEntries, toCatalogArchive, csvTemplate } = await import('../src/services/bulkFormats.js');
const { catalogRoutes } = await import('../src/routes/catalog.js');
const { generateToken } = await import('../src/middleware/auth.js');
const { readCatalogFromZip } = await import('../src/services/catalogService.js');
const multipart = (await import('@fastify/multipart')).default;
const cookie = (await import('@fastify/cookie')).default;

let app, db, headers;

function multipartBody(filename, content, type = 'application/octet-stream') {
  const boundary = '----bulk' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('bulk_admin', 'bulk@example.com', 'pepper_v1:x', 'admin')`).run();
  const admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'bulk_admin'").get();
  headers = { authorization: `Bearer ${generateToken(admin)}` };
  app = Fastify();
  await app.register(cookie, { secret: 'bulk-test-cookie-secret-0123456789abcdef00' });
  await app.register(multipart);
  await app.register(async (api) => { await api.register(catalogRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

describe('bulk formats: csv parsing', () => {
  it('handles quotes, commas, CRLF and BOM', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\r\n');
    assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
  });

  it('maps columns to catalogue entries', () => {
    const csv = ['slug,name,description,tags,published,link_label,link_url,requirements,related,file_size',
      'bulk-a,Bulk A,"A thing, described",x|y,yes,Mirror,https://example.com/a.zip,runtime:Java 17 | hardware:RAM 2 GB,bulk-b:supersedes,1024'].join('\n');
    const [e] = csvToEntries(csv);
    assert.equal(e.slug, 'bulk-a');
    assert.deepEqual(e.tags, ['x', 'y']);
    assert.equal(e.published, true);
    assert.equal(e.file_size, 1024);
    assert.deepEqual(e.links, [{ label: 'Mirror', storage_provider: 'external', is_primary: true, sort_order: 0, download_url: 'https://example.com/a.zip' }]);
    assert.deepEqual(e.requirements, [{ type: 'runtime', name: 'Java', version: '17' }, { type: 'hardware', name: 'RAM 2 GB', version: null }]);
    assert.deepEqual(e.related, [{ slug: 'bulk-b', relation: 'supersedes' }]);
  });

  it('requires a header with name', () => {
    assert.throws(() => csvToEntries('slug\nfoo'), /"name" column/);
    assert.throws(() => csvToEntries('name'), /at least one entry/);
  });

  it('the template round-trips through the parser and the archive reader', () => {
    const [e] = csvToEntries(csvTemplate());
    assert.equal(e.slug, 'ubuntu-24-04-desktop');
    const { buffer } = toCatalogArchive(Buffer.from(csvTemplate()), 'x.csv');
    const { catalog, warnings } = readCatalogFromZip(buffer);
    assert.equal(catalog.items.length, 1);
    assert.deepEqual(warnings, [], 'no unknown-field warnings from the template');
  });
});

describe('bulk formats: conversion', () => {
  it('passes zips through, wraps arrays and catalogue objects', () => {
    const z = toCatalogArchive(Buffer.from('PK\u0003\u0004rest'), 'c.zip');
    assert.equal(z.converted, null);
    const arr = toCatalogArchive(Buffer.from(JSON.stringify([{ slug: 'j', name: 'J', description: 'json entry' }])), 'list.json');
    assert.equal(arr.converted, 'json'); assert.equal(arr.filename, 'list.zip');
    assert.equal(readCatalogFromZip(arr.buffer).catalog.items[0].slug, 'j');
    assert.throws(() => toCatalogArchive(Buffer.from('{"nope":1}'), 'bad.json'), /"items"/);
    assert.throws(() => toCatalogArchive(Buffer.from('x'), 'file.exe'), /Unsupported/);
  });
});

describe('bulk formats: upload route', () => {
  it('previews a CSV through the normal import endpoint', async () => {
    const csv = 'slug,name,description,link_url\nbulk-route-a,Bulk Route A,Imported from a spreadsheet,https://example.com/a.iso\n';
    const { body, headers: h } = multipartBody('entries.csv', csv, 'text/csv');
    const res = await app.inject({ method: 'POST', url: '/api/admin/catalog/import', headers: { ...headers, ...h }, payload: body });
    assert.equal(res.statusCode, 200, res.body);
    const j = res.json();
    assert.equal(j.dryRun, true);
    assert.equal(j.converted, 'csv');
    assert.equal(j.items.created, 1);
    assert.equal(j.errorCount, 0, JSON.stringify(j.errors));
  });

  it('rejects an unparseable JSON upload with 400', async () => {
    const { body, headers: h } = multipartBody('bad.json', '{not json', 'application/json');
    const res = await app.inject({ method: 'POST', url: '/api/admin/catalog/import', headers: { ...headers, ...h }, payload: body });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /JSON/);
  });

  it('serves the CSV template', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/catalog/template.csv', headers });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.body, /^slug,name,/);
  });
});
