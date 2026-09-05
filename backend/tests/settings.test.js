import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

/**
 * Admin -> Site settings writes.
 *
 * The update path takes its key set straight from the request body, so the key
 * names are attacker-chosen. `rows['__proto__']` is Object.prototype - truthy -
 * which used to let `__proto__` slip past the unknown-key guard and be written
 * into both the settings table and the object handed back to the caller. These
 * tests pin the guard down: reserved keys are refused, ordinary typos still
 * are, and nothing on Object.prototype changes shape.
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { updateSettings, getSettings, getSetting, invalidateSettingsCache } =
  await import('../src/services/settingsService.js');

describe('settings updates', () => {
  before(() => {
    invalidateSettingsCache();
  });

  after(() => {
    invalidateSettingsCache();
  });

  it('writes a known setting and returns the coerced value', () => {
    const written = updateSettings({ require_captcha: true });
    assert.strictEqual(written.require_captcha, true);
    assert.strictEqual(getSetting('require_captcha'), true);
    // The result is serialised straight back to the browser.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(written)), { require_captcha: true });
  });

  it('still refuses an unknown key', () => {
    assert.throws(() => updateSettings({ not_a_real_setting: 'x' }), (err) => {
      assert.strictEqual(err.statusCode, 400);
      assert.deepStrictEqual(err.unknownKeys, ['not_a_real_setting']);
      return true;
    });
  });

  it('refuses __proto__ from a JSON-parsed body', () => {
    // JSON.parse gives __proto__ an own property, which is the shape a request
    // body actually arrives in.
    const patch = JSON.parse('{"__proto__": {"isAdmin": true}}');
    assert.deepStrictEqual(Object.keys(patch), ['__proto__']);

    assert.throws(() => updateSettings(patch), (err) => {
      assert.strictEqual(err.statusCode, 400);
      assert.match(err.message, /Reserved setting key/i);
      return true;
    });
  });

  it('refuses the other reserved keys', () => {
    for (const key of ['constructor', 'prototype']) {
      assert.throws(() => updateSettings({ [key]: 'x' }), /Reserved setting key/i, key);
    }
  });

  it('refuses reserved keys even when unknown keys are allowed', () => {
    // Object literals treat `__proto__:` as a prototype assignment, so the
    // reserved key has to arrive the way a request body does.
    const patch = JSON.parse('{"__proto__": "x"}');
    assert.throws(() => updateSettings(patch, { allowUnknownKeys: true }), /Reserved setting key/i);
  });

  it('never writes a reserved key into the settings table', () => {
    const db = getDb();
    const rows = db
      .prepare("SELECT key FROM site_settings WHERE key IN ('__proto__','constructor','prototype')")
      .all();
    assert.deepStrictEqual(rows, []);
  });

  it('leaves Object.prototype and the settings map alone', () => {
    assert.strictEqual({}.isAdmin, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty('isAdmin'), false);
    const all = getSettings();
    assert.strictEqual(Object.hasOwn(all, '__proto__'), false);
  });
});
