import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * The global rate limiter's bucket choice.
 *
 * The limiter is global, so the interesting question is *which* bucket a
 * request lands in. One bucket per IP for everything meant the admin area
 * started returning 429 a few minutes into a session - Monitoring polls every
 * 5 seconds - and a broken-looking admin panel is indistinguishable from a
 * broken one. Verified sessions now get their own, larger bucket.
 *
 * The property that matters most is the negative one: the larger allowance
 * cannot be bought with a header. Anything that is not a valid session - no
 * token, a forged token, an expired token - must land back in the IP bucket.
 */

// setup.mjs (loaded by `npm test`) has already pointed DATABASE_PATH at a
// throwaway database, so importing the modules below is safe.
const { getDb } = await import('../src/db/index.js');
const { rateLimitKey, rateLimitMax } = await import('../src/middleware/rateLimit.js');
const { generateToken } = await import('../src/middleware/auth.js');
const cookie = (await import('@fastify/cookie')).default;
const rateLimit = (await import('@fastify/rate-limit')).default;

const IP = '203.0.113.7';

let app;
let db;
let user;
let token;

/** The smallest thing rateLimitKey() touches. */
function request(overrides = {}) {
  return { ip: IP, headers: {}, query: {}, cookies: {}, ...overrides };
}

after(async () => {
  await app?.close();
});

before(async () => {
  db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (username, email, password_hash, role)
     VALUES ('ratelimit_user', 'ratelimit_user@example.com', 'pepper_v1:dummy', 'admin')`
  ).run();
  user = db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?')
    .get('ratelimit_user');
  token = generateToken(user);

  // A real server, so the key generator runs inside an actual request: the
  // point of these tests is the wiring, not the pure function.
  app = Fastify();
  await app.register(cookie, { secret: 'rate-limit-test-cookie-secret-0123456789' });
  await app.register(rateLimit, {
    global: true,
    timeWindow: '15 minutes',
    keyGenerator: rateLimitKey,
    max: (req, key) => rateLimitMax(key),
  });
  app.get('/probe', async () => ({ ok: true }));
  await app.ready();
});

describe('rate limit buckets: key choice', () => {
  it('buckets anonymous traffic by IP', () => {
    assert.equal(rateLimitKey(request()), IP);
  });

  it('gives a verified session its own bucket', () => {
    const key = rateLimitKey(request({ headers: { authorization: `Bearer ${token}` } }));
    assert.equal(key, `session:${user.id}`);
  });

  it('reads the session cookie as well as the header', () => {
    // The frontend is cookie-only: without this branch the fix would have
    // done nothing for the panels it was written for.
    const key = rateLimitKey(request({ cookies: { espress0_token: token } }));
    assert.equal(key, `session:${user.id}`);
  });

  it('sends a forged token back to the IP bucket', () => {
    const key = rateLimitKey(request({ headers: { authorization: 'Bearer not-a-token' } }));
    assert.equal(key, IP);
  });

  it('sends an expired token back to the IP bucket', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('../src/config.js');
    const expired = jwt.sign({ id: user.id, username: user.username }, config.security.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    assert.equal(
      rateLimitKey(request({ headers: { authorization: `Bearer ${expired}` } })),
      IP,
    );
  });

  it('gives sessions the larger allowance and strangers the strict one', () => {
    assert.ok(rateLimitMax(`session:${user.id}`) > rateLimitMax(IP));
    assert.equal(rateLimitMax(IP), Number(process.env.RATE_LIMIT_MAX || 100));
  });
});

describe('rate limit buckets: through a real request', () => {
  it('does not count a session against the IP bucket', async () => {
    // Session requests and anonymous requests hit the same IP but must not
    // consume each other's allowance.
    const anon = await app.inject({ method: 'GET', url: '/probe', remoteAddress: IP });
    assert.equal(anon.statusCode, 200, anon.payload);

    const session = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: IP,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(session.statusCode, 200, session.payload);
    assert.notEqual(
      session.headers['x-ratelimit-limit'],
      anon.headers['x-ratelimit-limit'],
      'the two buckets advertise different limits',
    );
  });
});
