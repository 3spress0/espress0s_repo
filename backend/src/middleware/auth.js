import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

// Only HS256 is ever issued here. Without this list jsonwebtoken would accept
// any algorithm named in the token header, which is how "alg" confusion bugs
// happen.
const JWT_ALGORITHMS = ['HS256'];

/**
 * Routes that may take the token from `?token=`.
 *
 * A token in the query string ends up in access logs, browser history and
 * Referer headers, and it turns any mutating endpoint into a one-click CSRF
 * gadget. Downloads and previews genuinely need it (they are opened as plain
 * navigations / <video src>), so those paths keep it and nothing else does.
 * A route can also opt in explicitly with `config: { allowQueryToken: true }`.
 */
const QUERY_TOKEN_PATHS = [/^\/api\/download(\/|$)/, /^\/api\/preview(\/|$)/];

function queryTokenAllowed(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.routeOptions?.config?.allowQueryToken) return true;
  const pathname = (request.raw?.url || request.url || '').split('?')[0];
  return QUERY_TOKEN_PATHS.some(re => re.test(pathname));
}

/** Pull a bearer token off the request, honouring the query-token policy. */
/**
 * The token for this request, wherever it travels: Bearer header, the httpOnly
 * session cookie, the legacy x-access-token header, or (download/preview only)
 * the query string. Exported because the rate limiter needs to tell a session
 * apart from a stranger before any route handler has run.
 */
export function extractToken(request) {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);
  if (request.cookies && request.cookies.espress0_token) return request.cookies.espress0_token;
  if (request.headers['x-access-token']) return request.headers['x-access-token'];
  if (request.query && request.query.token && queryTokenAllowed(request)) return request.query.token;
  return null;
}

/**
 * Short fingerprint of the stored password hash, carried in the token as
 * `pwv`. Changing a password changes the hash, which invalidates every token
 * minted before the change - otherwise a stolen 7-day token survives the
 * password reset that was meant to kill it.
 *
 * Tokens issued before this claim existed have no `pwv` and stay valid until
 * they expire, so rolling this out does not log everyone out.
 */
export function passwordVersion(passwordHash) {
  if (!passwordHash) return null;
  return crypto.createHash('sha256').update(String(passwordHash)).digest('base64url').slice(0, 16);
}

export function verifyToken(token) {
  return jwt.verify(token, config.security.jwtSecret, { algorithms: JWT_ALGORITHMS });
}

export async function authenticate(request, reply) {
  try {
    const token = extractToken(request);

    if (!token) {
      return reply.code(401).send({
        error: 'Authentication required - login to download',
        loginRequired: true,
        loginUrl: '/login',
        message: 'You need to be logged in to download files'
      });
    }

    const decoded = verifyToken(token);
    const db = getDb();
    const row = db.prepare('SELECT id, username, email, role, password_hash, auth_version FROM users WHERE id = ?').get(decoded.id);

    if (!row) {
      return reply.code(401).send({ error: 'User not found' });
    }
    if (decoded.pwv && decoded.pwv !== passwordVersion(row.password_hash)) {
      return reply.code(401).send({
        error: 'Session ended because the password changed - please login again',
        loginRequired: true,
        loginUrl: '/login',
      });
    }
    // "Log out all devices" bump: tokens minted before the bump die here.
    if (decoded.av !== undefined && Number(decoded.av) !== (row.auth_version || 0)) {
      return reply.code(401).send({
        error: 'Session ended - the account was signed out everywhere',
        loginRequired: true,
        loginUrl: '/login',
      });
    }

    const { password_hash, auth_version, ...user } = row;
    request.user = user;
  } catch (err) {
    return reply.code(401).send({
      error: 'Invalid or expired token - please login again',
      loginRequired: true,
      loginUrl: '/login'
    });
  }
}

export async function optionalAuthenticate(request) {
  try {
    const token = extractToken(request);
    if (!token) return;
    const decoded = verifyToken(token);
    const db = getDb();
    const row = db.prepare('SELECT id, username, email, role, password_hash, auth_version FROM users WHERE id = ?').get(decoded.id);
    if (!row) return;
    if (decoded.pwv && decoded.pwv !== passwordVersion(row.password_hash)) return;
    if (decoded.av !== undefined && Number(decoded.av) !== (row.auth_version || 0)) return;
    const { password_hash, auth_version, ...user } = row;
    request.user = user;
  } catch {}
}

export async function requireAdmin(request, reply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' });
}

export function generateToken(user, { passwordHash = user?.password_hash } = {}) {
  const pwv = passwordVersion(passwordHash);
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      ...(pwv ? { pwv } : {}),
      // auth_version lets "log out all devices" kill even unexpired tokens.
      av: user.auth_version || 0,
    },
    config.security.jwtSecret,
    { expiresIn: config.security.jwtExpiresIn, algorithm: 'HS256' }
  );
}
