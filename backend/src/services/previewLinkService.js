/**
 * Draft preview links (#18).
 *
 * A draft (published = 0) is invisible to everyone below editor. To let an
 * editor show it to someone without an account, they mint a signed,
 * expiring link. The token is an HMAC over item id + expiry + the item's
 * updated_at-independent id, keyed by the JWT secret, so nothing is stored
 * and revocation is by expiry (default 7 days, max 30) or by publishing.
 *
 * A preview shows the page content only: download URLs, storage paths and
 * license notes are stripped from the response, and the download endpoints
 * still require a session. Preview views do not count.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

export const DEFAULT_TTL_HOURS = 24 * 7;
export const MAX_TTL_HOURS = 24 * 30;

function sign(itemId, exp) {
  return crypto.createHmac('sha256', `${config.security.jwtSecret}:preview`).update(`${itemId}.${exp}`).digest('base64url');
}

/** Mint a token for one item. Returns { token, expires_at }. */
export function createPreviewToken(itemId, { ttlHours = DEFAULT_TTL_HOURS } = {}) {
  const hours = Math.min(Math.max(Number(ttlHours) || DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS);
  const exp = Math.floor(Date.now() / 1000) + hours * 3600;
  return { token: `${exp}.${sign(itemId, exp)}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** True when `token` is a valid, unexpired preview token for `itemId`. */
export function verifyPreviewToken(itemId, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return false;
  const [expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  if (!Number.isInteger(exp) || !sig) return false;
  if (exp * 1000 < Date.now()) return false;
  const expected = sign(itemId, exp);
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
