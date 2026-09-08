import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

/**
 * The version stamp in the visitor-facing footer.
 *
 * Two moving parts, and the test covers the seam between them:
 *
 *   1. `footer_show_version`, a public boolean setting, default on, so a fresh
 *      install shows the number and an admin can switch it off from
 *      Admin -> Site settings -> Footer without a redeploy.
 *   2. The number itself, which the settings response carries as `app.version`
 *      rather than as a setting. A version somebody typed into a text box would
 *      be decoration at best and a lie at worst, so it comes from the running
 *      process instead - the same reason /api/health reports a commit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { settingsRoutes } = await import('../src/routes/settings.js');
const { healthRoutes } = await import('../src/routes/health.js');
const { updateSettings } = await import('../src/services/settingsService.js');

let app;

const publicPayload = async () => (await app.inject({ method: 'GET', url: '/api/settings' })).json();

before(async () => {
  getDb(); // runs the migrations that seed DEFAULT_SETTINGS
  app = Fastify({ logger: false });
  // Health is registered alongside so the two can be compared: they must agree,
  // and that is the whole point of resolving the version in one place.
  await app.register(healthRoutes);
  await app.register(async (api) => { await api.register(settingsRoutes); }, { prefix: '/api' });
  await app.ready();
});

after(async () => {
  await app?.close();
});

describe('footer version', () => {
  it('is on by default, so visitors see the number on a fresh install', async () => {
    const { settings } = await publicPayload();
    assert.equal(settings.footer_show_version, true, 'a boolean row, not the string "true"');
  });

  it('is a public boolean in the footer group, so the admin form renders a toggle', async () => {
    const { meta } = await publicPayload();
    const row = meta.find(m => m.key === 'footer_show_version');
    assert.ok(row, 'it must be in the public meta the settings form is generated from');
    assert.equal(row.type, 'boolean');
    assert.equal(row.group, 'footer');
    // A new key only reaches an existing database through the INSERT OR IGNORE
    // seed, which never overwrites an admin's edits - so the default has to be
    // written into the seed row itself.
    const { DEFAULT_SETTINGS } = await import('../src/db/schema.js');
    assert.equal(DEFAULT_SETTINGS.find(s => s.key === 'footer_show_version').value, 'true');
  });

  it('can be switched off without a redeploy', async () => {
    updateSettings({ footer_show_version: false });
    assert.equal((await publicPayload()).settings.footer_show_version, false);
    updateSettings({ footer_show_version: true });
    assert.equal((await publicPayload()).settings.footer_show_version, true);
  });

  it('reports the running version beside the settings, not inside them', async () => {
    const body = await publicPayload();
    assert.equal(body.app.version, pkgVersion);
    assert.ok(
      !('footer_show_version' in body.app),
      'app carries build facts only; editable values stay in settings'
    );
  });

  it('agrees with /api/health, which deployment tooling checks after an update', async () => {
    // Two endpoints, one number: the footer is the human-facing copy of what
    // the updater verifies, and a second hand-written version string is how
    // they used to disagree.
    const { app: appBlock } = await publicPayload();
    for (const url of ['/api/health', '/health']) {
      const health = (await app.inject({ method: 'GET', url })).json();
      assert.equal(appBlock.version, health.version, `${url} reports a different release`);
    }
    assert.equal(appBlock.version, pkgVersion);
  });

  it('coerces the toggle on write, so a raw string never reaches the footer', async () => {
    const written = updateSettings({ footer_show_version: 'false' });
    assert.equal(written.footer_show_version, false, 'stored as text, read back as a boolean');
    assert.equal((await publicPayload()).settings.footer_show_version, false);
    updateSettings({ footer_show_version: true });
  });
});
