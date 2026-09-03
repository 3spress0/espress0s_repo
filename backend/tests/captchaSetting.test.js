import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * The "Require CAPTCHA on login" setting (Admin -> Site settings, auth group).
 *
 * Login used to read only `process.env.CAPTCHA_TYPE`, so the setting was
 * decoration: turning it off left the CAPTCHA in place, and turning it on
 * changed nothing because the env default already asked for one. The only way
 * to switch it off was to edit the deployment's environment and restart.
 *
 * Both switches now have to agree: `CAPTCHA_TYPE=disabled` turns it off for the
 * whole deployment, and the setting decides it from the admin UI.
 *
 * These tests never log in successfully - they only need to see whether the
 * request was stopped at the CAPTCHA gate (400 + captchaRequired) or carried
 * on to the credential check (401).
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { updateSettings } = await import('../src/services/settingsService.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let db;

const login = (payload = {}) => app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { username: 'nobody', password: 'not-a-real-password', ...payload },
});

// A registration that passes input validation, so the only thing that can stop
// it is the CAPTCHA gate.
const register = () => app.inject({
  method: 'POST',
  url: '/api/auth/register',
  payload: {
    username: 'captcha_probe',
    email: 'captcha_probe@example.com',
    password: 'Whatever123!',
    confirmPassword: 'Whatever123!',
  },
});

after(async () => {
  await app?.close();
});

before(async () => {
  db = getDb();
  app = Fastify();
  await app.register(cookie, { secret: 'captcha-setting-test-cookie-secret-0123456789' });
  await app.register(async (api) => { await api.register(authRoutes); }, { prefix: '/api' });
  await app.ready();
});

describe('login CAPTCHA gate', () => {
  it('demands a CAPTCHA when the setting is on', async () => {
    updateSettings({ require_captcha: true });
    const res = await login();
    assert.equal(res.statusCode, 400, res.payload);
    const body = res.json();
    assert.equal(body.captchaRequired, true);
    assert.ok(body.newCaptcha?.id, 'and hands out a fresh challenge');
  });

  it('lets the request through when the setting is off', async () => {
    updateSettings({ require_captcha: false });
    const res = await login();
    // Not 400: the CAPTCHA gate let it pass, and the credentials were wrong.
    assert.equal(res.statusCode, 401, res.payload);
    assert.equal(res.json().captchaRequired, undefined);
  });

  it('follows the setting in both directions, not just once', async () => {
    updateSettings({ require_captcha: true });
    assert.equal((await login()).statusCode, 400);
    updateSettings({ require_captcha: false });
    assert.equal((await login()).statusCode, 401);
    updateSettings({ require_captcha: true });
    assert.equal((await login()).statusCode, 400);
  });

  it('honours CAPTCHA_TYPE=disabled as a deployment-wide off switch', async () => {
    updateSettings({ require_captcha: true });
    const previous = process.env.CAPTCHA_TYPE;
    process.env.CAPTCHA_TYPE = 'disabled';
    try {
      assert.equal((await login()).statusCode, 401, 'env wins over the setting');
    } finally {
      if (previous === undefined) delete process.env.CAPTCHA_TYPE;
      else process.env.CAPTCHA_TYPE = previous;
    }
  });

  it('gates registration the same way', async () => {
    updateSettings({ require_captcha: true });
    const on = await register();
    assert.equal(on.statusCode, 400, on.payload);
    assert.equal(on.json().captchaRequired, true, 'a bad input would 400 too, so check why');

    updateSettings({ require_captcha: false });
    const off = await register();
    assert.notEqual(off.statusCode, 400, off.payload);
    assert.equal(off.json().captchaRequired, undefined);
    assert.equal(off.statusCode, 201, 'with the gate off, the sign-up goes through');

    // Leave no trace: the gate test is not meant to create accounts.
    db.prepare('DELETE FROM users WHERE username = ?').run('captcha_probe');
  });
});
