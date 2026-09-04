/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), for the
 * optional second factor on accounts. Pure Node crypto - no dependency - so a
 * personal deployment does not pick up a transitive tree for 40 lines of maths.
 *
 * Storage (users table):
 *   totp_secret        base32 secret, encrypted at rest with encryptionService
 *   totp_enabled       0 while the user is still confirming the first code,
 *                      1 once a code has been verified
 *   totp_recovery      JSON array of sha256(recovery code) hex strings; each
 *                      is single-use and removed when spent
 *
 * Login flow (routes/auth.js):
 *   password ok, totp_enabled=0  -> full session, as before
 *   password ok, totp_enabled=1  -> { mfaRequired: true, mfaToken } (a short
 *                                   JWT that proves the password step only)
 *   POST /auth/mfa/verify with mfaToken + code (or recovery code) -> session
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32 (what authenticator apps expect). */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** HOTP(K, C) -> zero-padded `digits` string. */
export function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secretBase32, { time = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(secretBase32, Math.floor(time / 1000 / step), digits);
}

/**
 * Verify a code, allowing `window` steps of drift either side (one step = 30 s
 * on each side by default, which is what Google Authenticator's docs assume).
 * Constant-time comparison per candidate; returns the matched counter so the
 * caller can refuse a replay of the same code within its validity window.
 */
export function verifyTotp(secretBase32, code, { time = Date.now(), step = 30, digits = 6, window = 1 } = {}) {
  const wanted = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(wanted) || wanted.length !== digits) return { ok: false };
  const counter = Math.floor(time / 1000 / step);
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secretBase32, counter + i, digits);
    if (candidate.length === wanted.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(wanted))) {
      return { ok: true, counter: counter + i };
    }
  }
  return { ok: false };
}

/** otpauth:// URI for the QR code. `issuer` is the site name. */
export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten recovery codes as `xxxx-xxxx` plus their hashes for storage. */
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
}

/**
 * Consume a recovery code from the stored hash list. Returns the remaining
 * list on success, null when the code is not there.
 */
export function consumeRecoveryCode(storedHashesJson, code) {
  let hashes;
  try { hashes = JSON.parse(storedHashesJson || '[]'); } catch { hashes = []; }
  const h = hashRecoveryCode(code);
  const idx = hashes.findIndex(x => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (idx === -1) return null;
  hashes.splice(idx, 1);
  return hashes;
}
