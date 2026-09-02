/**
 * End-to-end exercise of the catalogue HTTP endpoints against a running
 * backend. The unit tests cover the service; this covers multipart upload,
 * auth, CSRF and the response shapes.
 */
import fs from 'node:fs';
import { zip } from '/home/user/espress0s_repo/backend/src/lib/zip.js';

const BASE = process.env.E2E_BASE || 'http://localhost:3200/api';
let cookie = '';
let csrf = '';
let failures = 0;

function check(label, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const CATALOG = {
  format: 'espress0-catalog',
  version: 1,
  items: [
    {
      slug: 'e2e-ubuntu-2404',
      name: 'E2E Ubuntu 24.04',
      description: 'End-to-end fixture entry for the catalogue endpoints.',
      long_description: '## Overview\n\nE2E body with **markdown**.',
      category: 'operating-systems',
      tags: ['e2e', 'linux'],
      platform: 'linux',
      architecture: 'x64',
      status: 'current',
      version: '24.04',
      icon_url: 'https://example.com/icon.png',
      banner_url: 'https://example.com/banner.png',
      links: [{ label: 'Mirror 1', storage_provider: 'external', download_url: 'https://example.com/a.iso', is_primary: true }],
    },
    {
      slug: 'e2e-ubuntu-2204',
      name: 'E2E Ubuntu 22.04',
      description: 'Second end-to-end fixture entry, related to the first.',
      category: 'operating-systems',
      tags: ['e2e', 'linux'],
      platform: 'linux',
      architecture: 'x64',
      status: 'legacy',
      version: '22.04',
      related: [{ slug: 'e2e-ubuntu-2404', relation: 'superseded-by', note: 'Newer LTS' }],
    },
  ],
};

const catalogZip = (doc) => zip([{ name: 'catalog.json', data: JSON.stringify(doc) }]);

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
    body,
  });
  const type = res.headers.get('content-type') || '';
  const payload = raw ? Buffer.from(await res.arrayBuffer())
    : type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, payload, headers: res.headers };
}

// --- login -----------------------------------------------------------------
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'E2eTest123!' }),
});
const loginBody = await login.json();
const setCookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
csrf = loginBody.csrfToken;
check('admin login', login.status === 200 && cookie.includes('espress0_token'), `status ${login.status}`);

// --- auth is enforced ------------------------------------------------------
const anon = await fetch(`${BASE}/admin/catalog/imports`);
check('unauthenticated request is refused', anon.status === 401, `status ${anon.status}`);

// --- template --------------------------------------------------------------
const tpl = await api('/admin/catalog/template', { raw: true });
check('template downloads as a zip', tpl.status === 200 && tpl.payload.subarray(0, 2).toString() === 'PK',
  `${tpl.status}, ${tpl.payload.length} bytes`);
check('template has a download filename', /catalog-template\.zip/.test(tpl.headers.get('content-disposition') || ''));

// --- preview (dry run) -----------------------------------------------------
const upload = (buf, query = '') => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), 'catalog.zip');
  return api(`/admin/catalog/import${query}`, { method: 'POST', body: form });
};

const preview = await upload(catalogZip(CATALOG));
check('preview reports creates and writes nothing', preview.status === 200
  && preview.payload.dryRun === true
  && preview.payload.items.created === 2, JSON.stringify(preview.payload.items));
check('preview tells the admin how to apply', /apply=1/.test(preview.payload.hint || ''), preview.payload.hint);
check('preview mentions the related pair', preview.payload.relations?.created === 1, JSON.stringify(preview.payload.relations));

// --- apply -----------------------------------------------------------------
const applied = await upload(catalogZip(CATALOG), '?apply=1');
check('apply imports both items', applied.status === 200 && applied.payload.items.created === 2,
  JSON.stringify(applied.payload.items));
check('apply took a database snapshot', !!applied.payload.backupPath, applied.payload.backupPath);
check('apply recorded an import id', typeof applied.payload.importId === 'number', String(applied.payload.importId));

// --- idempotency -----------------------------------------------------------
const again = await upload(catalogZip(CATALOG), '?apply=1');
check('re-applying the same archive changes nothing', again.payload.items.unchanged === 2
  && again.payload.items.created === 0 && again.payload.relations.unchanged === 1,
  JSON.stringify({ items: again.payload.items, relations: again.payload.relations }));

// --- modes -----------------------------------------------------------------
const addOnly = await upload(catalogZip({
  ...CATALOG,
  items: [...CATALOG.items, { ...CATALOG.items[0], slug: 'e2e-brand-new', name: 'E2E Brand New' }],
}), '?apply=1&mode=add-only');
check('add-only creates the new one and skips existing', addOnly.payload.items.created === 1
  && addOnly.payload.items.skipped === 2 && addOnly.payload.items.updated === 0,
  JSON.stringify(addOnly.payload.items));

const updateOnly = await upload(catalogZip({
  format: 'espress0-catalog', version: 1,
  items: [{ ...CATALOG.items[0], version: '24.10' }, { slug: 'e2e-never-made', name: 'E2E Never Made', description: 'Should never be created by update-only.' }],
}), '?apply=1&mode=update-only');
check('update-only skips unknown slugs', updateOnly.payload.items.updated === 1
  && updateOnly.payload.items.skipped === 1 && updateOnly.payload.items.created === 0,
  JSON.stringify(updateOnly.payload.items));

const badMode = await upload(catalogZip(CATALOG), '?mode=merge');
check('unknown mode is rejected', badMode.status === 400, `status ${badMode.status}`);

// --- validation errors are reported and downloadable -----------------------
const withErrors = await upload(catalogZip({
  format: 'espress0-catalog', version: 1,
  items: [{
    slug: 'e2e-bad-image', name: 'E2E Bad Image',
    description: 'Entry pointing its icon at a locally uploaded file.',
    icon_url: '/api/uploads/secret.png',
  }],
}), '?apply=1');
check('local image URL is reported', withErrors.payload.errorCount >= 1
  && withErrors.payload.errors.some((e) => e.field === 'icon_url'),
  JSON.stringify(withErrors.payload.errors));

const errorsJson = await api(withErrors.payload.errorsUrl.replace('/api', ''), { raw: true });
check('validation errors download as JSON', errorsJson.status === 200
  && JSON.parse(errorsJson.payload.toString()).errors.length >= 1, `status ${errorsJson.status}`);
const errorsCsv = await api(`${withErrors.payload.errorsUrl.replace('/api', '')}?format=csv`, { raw: true });
check('validation errors download as CSV', errorsCsv.status === 200
  && /slug,field,error/.test(errorsCsv.payload.toString()), errorsCsv.payload.toString().split('\r\n')[0]);

// --- hostile archives ------------------------------------------------------
const traversal = zip([{ name: 'catalog.json', data: JSON.stringify(CATALOG) }]);
const cd = (() => { for (let i = traversal.length - 22; i >= 0; i--) if (traversal.readUInt32LE(i) === 0x06054b50) return traversal.readUInt32LE(i + 16); })();
const nameLen = traversal.readUInt16LE(cd + 28);
const evil = '../evil'.padEnd(nameLen, 'x');
Buffer.from(evil).copy(traversal, cd + 46);
Buffer.from(evil).copy(traversal, 30);
const hostile = await upload(traversal, '?apply=1');
check('path-traversal archive is refused', hostile.status === 400 && hostile.payload.code === 'ZIP_UNSAFE_NAME',
  `${hostile.status} ${hostile.payload.code}`);

const notAZip = await upload(Buffer.from('definitely not a zip archive at all'), '?apply=1');
check('non-zip upload is refused', notAZip.status === 400, `${notAZip.status} ${notAZip.payload.code}`);

// --- history ---------------------------------------------------------------
const history = await api('/admin/catalog/imports');
check('history lists the imports', history.status === 200 && history.payload.imports.length >= 6,
  `${history.payload.imports?.length} rows`);
check('history keeps the mode and checksum', history.payload.imports.every((h) => h.mode && /^[0-9a-f]{64}$/.test(h.sha256)));

// --- export round trip -----------------------------------------------------
const exported = await api('/admin/catalog/export', { raw: true });
check('export downloads as a zip', exported.status === 200 && exported.payload.subarray(0, 2).toString() === 'PK',
  `${exported.payload.length} bytes`);
const roundTrip = await upload(exported.payload, '?apply=1');
check('re-importing the export creates no duplicates', roundTrip.payload.items.created === 0,
  JSON.stringify(roundTrip.payload.items));
// The seeded catalogue has ~650 rows whose URL columns hold a stringified JS
// function instead of a URL (seed-modern.js:99 returns a function that is never
// called). Those rows are reported, not silently rewritten.
const badUrlErrors = (roundTrip.payload.errors || []).filter((e) => /http\(s\) URL/.test(e.error));
check('corrupt seeded URLs are reported rather than silently dropped',
  badUrlErrors.length > 0 && roundTrip.payload.items.updated === 0,
  `${badUrlErrors.length} reported, ${roundTrip.payload.items.updated} rows rewritten`);
check('the export warns about them', /are not valid URLs/.test(decodeURIComponent(exported.headers.get('x-catalog-warnings') || '')),
  decodeURIComponent(exported.headers.get('x-catalog-warnings') || '').slice(0, 120));

// --- what actually landed in the database ----------------------------------
const item = await api('/items/e2e-ubuntu-2204');
check('imported item is readable through the public API', item.status === 200
  && item.payload.status === 'legacy'
  && item.payload.banner_url === null, `status ${item.status}`);
const first = await api('/items/e2e-ubuntu-2404');
check('external icon and banner survived the round trip',
  first.payload.icon_url === 'https://example.com/icon.png'
  && first.payload.banner_url === 'https://example.com/banner.png',
  `${first.payload.icon_url} / ${first.payload.banner_url}`);
check('long markdown survived', /## Overview/.test(first.payload.long_description || ''));

console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
