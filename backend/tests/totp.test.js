import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

/**
 * TOTP second factor.
 *
 * The maths is pinned to the RFC 6238 test vectors, then the whole flow is
 * exercised over HTTP: enrol -> confirm -> login becomes two-step -> a code
 * (or recovery code) completes it -> a used code is refused -> disable needs
 * password + code.
 */
const { getDb } = await import('../src/db/index.js');
const { authRoutes } = await import('../src/routes/auth.js');
const { encryptionService } = await import('../src/services/encryptionService.js');
const { generateToken } = await import('../src/middleware/auth.js');
const totpService = await import('../src/services/totpService.js');
const { updateSettings } = await import('../src/services/settingsService.js');
const cookie = (await import('@fastify/cookie')).default;

const { totp, hotp, verifyTotp, base32Encode, base32Decode, generateRecoveryCodes, consumeRecoveryCode } = totpService;

describe('totp: RFC vectors', () => {
  // RFC 4226 appendix D, secret "12345678901234567890"
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('HOTP matches RFC 4226 appendix D', () => {
    assert.deepEqual([0, 1, 2, 3, 9].map(c => hotp(secret, c)), ['755224', '287082', '359152', '969429', '520489']);
  });
  it('TOTP matches RFC 6238 appendix B (SHA1, 8 digits)', () => {
    assert.equal(totp(secret, { time: 59 * 1000, digits: 8 }), '94287082');
    assert.equal(totp(secret, { time: 1111111109 * 1000, digits: 8 }), '07081804');
    assert.equal(totp(secret, { time: 1234567890 * 1000, digits: 8 }), '89005924');
  });
  it('base32 round-trips', () => {
    const buf = Buffer.from('hello totp world!');
    assert.equal(base32Decode(base32Encode(buf)).toString(), buf.toString());
  });
  it('verify accepts one step of drift and refuses two', () => {
    const t = 1_700_000_000_000;
    assert.ok(verifyTotp(secret, totp(secret, { time: t - 30_000 }), { time: t }).ok);
    assert.ok(verifyTotp(secret, totp(secret, { time: t + 30_000 }), { time: t }).ok);
    assert.ok(!verifyTotp(secret, totp(secret, { time: t + 60_000 }), { time: t }).ok);
    assert.ok(!verifyTotp(secret, 'abcdef', { time: t }).ok);
    assert.ok(!verifyTotp(secret, '', { time: t }).ok);
  });
  it('recovery codes are single-use', () => {
    const { codes, hashes } = generateRecoveryCodes(3);
    let stored = JSON.stringify(hashes);
    const after1 = consumeRecoveryCode(stored, codes[1]);
    assert.equal(after1.length, 2);
    stored = JSON.stringify(after1);
    assert.equal(consumeRecoveryCode(stored, codes[1]), null, 'same code again must fail');
    assert.equal(consumeRecoveryCode(stored, codes[0].toUpperCase().replace('-', ' ')).length, 1, 'formatting is forgiven');
  });
});

let app;
let db;
const PASSWORD = 'Sup3r-secret-pass!';
let userId;

before(async () => {
  db = getDb();
  updateSettings({ require_captcha: false });
  process.env.CAPTCHA_TYPE = 'disabled';
  const hash = await encryptionService.hashPasswordWithPepper(PASSWORD);
  db.prepare("INSERT OR IGNORE INTO users (username, email, password_hash, role) VALUES ('totp_user', 'totp@example.com', ?, 'admin')").run(hash);
  db.prepare("UPDATE users SET password_hash = ?, totp_secret = NULL, totp_enabled = 0, totp_recovery = NULL WHERE username = 'totp_user'").run(hash);
  userId = db.prepare("SELECT id FROM users WHERE username = 'totp_user'").get().id;

  app = Fastify();
  await app.register(cookie, { secret: 'totp-test-cookie-secret-0123456789abcdef' });
  await app.register(async (api) => { await api.register(authRoutes); }, { prefix: '/api' });
  await app.ready();
});
after(async () => { await app?.close(); });

const bearer = () => ({ authorization: `Bearer ${generateToken(db.prepare('SELECT * FROM users WHERE id = ?').get(userId))}` });
const login = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'totp_user', password: PASSWORD } });
const currentSecret = () => encryptionService.decrypt(db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId).totp_secret);

describe('totp: enrolment and login flow', () => {
  let secret;
  let recoveryCodes;

  it('logs straight in while MFA is off', async () => {
    const res = await login();
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().token);
    assert.equal(res.json().user.mfa_enabled, false);
  });

  it('reports MFA off', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/mfa', headers: bearer() });
    assert.deepEqual(res.json(), { enabled: false, recoveryCodesLeft: 0 });
  });

  it('setup returns a secret and otpauth URI but enforces nothing yet', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: bearer() });
    assert.equal(res.statusCode, 200, res.body);
    secret = res.json().secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(res.json().otpauth, /^otpauth:\/\/totp\/.+totp_user\?secret=/);
    assert.equal(currentSecret(), secret, 'secret stored encrypted, decrypts to the same');
    const still = await login();
    assert.ok(still.json().token, 'login is still single-step before confirmation');
  });

  it('enable refuses a wrong code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/mfa/enable', headers: bearer(), payload: { code: '000000' } });
    assert.equal(res.statusCode, 400);
  });

  it('enable accepts a live code and hands out recovery codes once', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/mfa/enable', headers: bearer(), payload: { code: totp(secret) } });
    assert.equal(res.statusCode, 200, res.body);
    recoveryCodes = res.json().recoveryCodes;
    assert.equal(recoveryCodes.length, 10);
    assert.match(recoveryCodes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
    const state = await app.inject({ method: 'GET', url: '/api/auth/mfa', headers: bearer() });
    assert.deepEqual(state.json(), { enabled: true, recoveryCodesLeft: 10 });
    const again = await app.inject({ method: 'POST', url: '/api/auth/mfa/setup', headers: bearer() });
    assert.equal(again.statusCode, 409, 'cannot re-enrol while on');
  });

  it('login now stops after the password and issues no session', async () => {
    const res = await login();
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.mfaRequired, true);
    assert.ok(body.mfaToken);
    assert.equal(body.token, undefined);
    assert.ok(!(res.headers['set-cookie'] || '').toString().includes('espress0_token='), 'no session cookie yet');
  });

  it('verify refuses a wrong code, then accepts the right one with a session', async () => {
    const { mfaToken } = (await login()).json();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code: '123456' } });
    assert.equal(bad.statusCode, 401);
    // The enable step consumed the current step; move one step ahead so the
    // replay guard does not (correctly) refuse the same code.
    const code = totp(secret, { time: Date.now() + 30_000 });
    const ok = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().token);
    assert.equal(ok.json().user.mfa_enabled, true);
    assert.ok(ok.headers['set-cookie'].toString().includes('espress0_token='));

    const replay = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code } });
    assert.equal(replay.statusCode, 401, 'the same code must not work twice');
  });

  it('verify refuses a session token used as an MFA token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken: generateToken({ id: userId, role: 'admin' }), code: '000000' } });
    assert.equal(res.statusCode, 401);
  });

  it('a recovery code completes login and is then spent', async () => {
    const { mfaToken } = (await login()).json();
    const res = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code: recoveryCodes[0] } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().recoveryCodesLeft, 9);
    const { mfaToken: t2 } = (await login()).json();
    const again = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken: t2, code: recoveryCodes[0] } });
    assert.equal(again.statusCode, 401);
  });

  it('/auth/me reports the flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer() });
    assert.equal(res.json().user.mfa_enabled, true);
  });

  it('disable needs password and a valid code', async () => {
    const noPw = await app.inject({ method: 'POST', url: '/api/auth/mfa/disable', headers: bearer(), payload: { password: 'wrong', code: totp(secret, { time: Date.now() + 60_000 }) } });
    assert.equal(noPw.statusCode, 401);
    const badCode = await app.inject({ method: 'POST', url: '/api/auth/mfa/disable', headers: bearer(), payload: { password: PASSWORD, code: '000000' } });
    assert.equal(badCode.statusCode, 401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/mfa/disable', headers: bearer(), payload: { password: PASSWORD, code: recoveryCodes[1] } });
    assert.equal(ok.statusCode, 200, ok.body);
    const back = await login();
    assert.ok(back.json().token, 'single-step login again');
    const row = db.prepare('SELECT totp_secret, totp_recovery FROM users WHERE id = ?').get(userId);
    assert.equal(row.totp_secret, null);
    assert.equal(row.totp_recovery, null);
  });
});

const { authenticate } = await import('../src/middleware/auth.js');

describe('totp: "require two-factor auth for admins" setting', () => {
  let gated;
  before(async () => {
    gated = Fastify();
    gated.get('/api/items', { preHandler: [authenticate] }, async () => ({ ok: true }));
    gated.get('/api/auth/mfa', { preHandler: [authenticate] }, async () => ({ ok: true }));
    await gated.ready();
  });
  after(async () => { updateSettings({ require_mfa_admins: false }); await gated.close(); });

  it('leaves un-enrolled admins alone while the setting is off', async () => {
    updateSettings({ require_mfa_admins: false });
    const res = await gated.inject({ method: 'GET', url: '/api/items', headers: bearer() });
    assert.equal(res.statusCode, 200);
  });

  it('locks an un-enrolled admin down to the enrolment routes when on', async () => {
    updateSettings({ require_mfa_admins: true });
    const blocked = await gated.inject({ method: 'GET', url: '/api/items', headers: bearer() });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().mfaSetupRequired, true);
    const allowed = await gated.inject({ method: 'GET', url: '/api/auth/mfa', headers: bearer() });
    assert.equal(allowed.statusCode, 200);
  });

  it('does not affect viewers, and lifts once the admin enrols', async () => {
    db.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(userId);
    const viewer = await gated.inject({ method: 'GET', url: '/api/items', headers: bearer() });
    assert.equal(viewer.statusCode, 200);
    db.prepare("UPDATE users SET role = 'admin', totp_enabled = 1 WHERE id = ?").run(userId);
    const enrolled = await gated.inject({ method: 'GET', url: '/api/items', headers: bearer() });
    assert.equal(enrolled.statusCode, 200);
    db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(userId);
  });
});
