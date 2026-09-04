import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate, LOCALES, DEFAULT_LOCALE, registerLocale } from '../src/i18n/translate.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/locales');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) registerLocale(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

test('translate: lookup, interpolation, plural, fallback', () => {
  assert.equal(translate('en', 'nav.browse'), 'Browse');
  assert.equal(translate('nl', 'nav.browse'), 'Bladeren');
  assert.equal(translate('en', 'common.auto', { name: 'English' }), 'Automatic (English)');
  assert.equal(translate('en', 'item.downloads', { count: 1 }), '1 download');
  assert.equal(translate('en', 'item.downloads', { count: 3 }), '3 downloads');
  assert.equal(translate('xx', 'nav.browse'), 'Browse', 'unknown locale falls back to English');
  assert.equal(translate('nl', 'does.not.exist'), 'does.not.exist', 'unknown key returns the key');
});

test('every locale has the same keys as English', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const base = new Set(flat(LOCALES[DEFAULT_LOCALE]));
  for (const [code, table] of Object.entries(LOCALES)) {
    const keys = new Set(flat(table));
    const missing = [...base].filter((k) => !keys.has(k) && !k.startsWith('_meta'));
    const extra = [...keys].filter((k) => !base.has(k) && !k.startsWith('_meta'));
    assert.deepEqual(missing, [], `${code} is missing keys`);
    assert.deepEqual(extra, [], `${code} has keys English lacks`);
  }
});
