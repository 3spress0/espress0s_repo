import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * Registration no longer requires an email.
 *
 * The property under test: an account can be created with no email at all, more
 * than one account can have "no email" at once (NULL is not caught by the
 * UNIQUE constraint), and a real email is still stored, still unique, and still
 * usable to log in. Adding an email stays optional, not forbidden.
 */

// CAPTCHA off for the suite so the tests exercise registration, not the puzzle.
process.env.CAPTCHA_TYPE = 'disabled';

const { getDb } = await import('../src/db/index.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { encryptionService } = await import('../src/services/encryptionService.js');
const cookie = (await import('@fastify/cookie')).default;

let app;
let db;

before(async () => {
  db = getDb();
  app = Fastify();
  await app.register(cookie, { secret: 'register-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => { await api.register(authRoutes); }, { prefix: '/api' });
  await app.ready();
});

after(async () => { await app?.close(); });

function register(payload) {
  return app.inject({ method: 'POST', url: '/api/auth/register', payload });
}

const PW = 'Password123';

describe('registration: email is optional', () => {
  it('creates an account with no email field at all', async () => {
    const res = await register({ username: 'noemail_one', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 201, res.payload);
    const body = res.json();
    assert.equal(body.user.username, 'noemail_one');
    assert.equal(body.user.email ?? null, null, 'no email should be returned');

    const row = db.prepare('SELECT email, email_hash FROM users WHERE username = ?').get('noemail_one');
    assert.equal(row.email, null, 'email column should be NULL');
    assert.equal(row.email_hash, null, 'email_hash should be NULL');
  });

  it('accepts an empty-string email the same as omitting it', async () => {
    const res = await register({ username: 'noemail_two', email: '', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 201, res.payload);
    const row = db.prepare('SELECT email FROM users WHERE username = ?').get('noemail_two');
    assert.equal(row.email, null);
  });

  it('lets many accounts share "no email" without a UNIQUE clash', async () => {
    // noemail_one and noemail_two above are both NULL; add a third to be sure.
    const res = await register({ username: 'noemail_three', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 201, res.payload);
    const nulls = db.prepare("SELECT COUNT(*) AS c FROM users WHERE email IS NULL").get().c;
    assert.ok(nulls >= 3, `expected at least 3 email-less accounts, got ${nulls}`);
  });

  it('still stores and encrypts an email when one is given', async () => {
    const res = await register({ username: 'withemail', email: 'me@example.com', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 201, res.payload);
    assert.equal(res.json().user.email, 'me@example.com');

    const row = db.prepare('SELECT email FROM users WHERE username = ?').get('withemail');
    assert.ok(row.email && row.email !== 'me@example.com', 'stored email must be encrypted, not plaintext');
    assert.equal(encryptionService.decrypt(row.email), 'me@example.com');
  });

  it('still rejects a duplicate email', async () => {
    const res = await register({ username: 'withemail_dup', email: 'me@example.com', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 409);
  });

  it('rejects a malformed email', async () => {
    const res = await register({ username: 'bademail', email: 'not-an-email', password: PW, confirmPassword: PW });
    assert.equal(res.statusCode, 400);
  });

  it('lets an email-less account log in by username', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'noemail_one', password: PW },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().user.username, 'noemail_one');
  });
});
