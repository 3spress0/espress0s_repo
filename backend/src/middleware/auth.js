import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { getSetting } from '../services/settingsService.js';

// Only HS256 is ever issued here. Without this list jsonwebtoken would accept
// any algorithm named in the token header, which is how "alg" confusion bugs
// happen.
const JWT_ALGORITHMS = ['HS256'];

/**
 * The path to test against MFA_ENROL_PATHS.
 *
 * That set decides whether the "you must enrol in 2FA first" gate applies, so
 * it is compared against the path the router will dispatch - percent-decoded,
 * query stripped, one trailing slash removed - and anything that cannot be
 * normalised yields null, which the caller refuses. Fail closed: an encoded
 * `%2e%2e` or a malformed escape never widens the allowlist, and a traversal
 * string like /api/auth/mfa/../../admin/items simply is not in the set.
 *
 * Exported for tests.
 */
export function requestPathname(request) {
  const raw = (request.raw?.url || request.url || '').split('?')[0];
  let pathname;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/** What an admin may still call while forced to enrol in 2FA. */
const MFA_ENROL_PATHS = new Set([
  '/api/auth/me', '/api/auth/profile', '/api/auth/mfa', '/api/auth/mfa/setup', '/api/auth/mfa/enable',
  '/api/auth/logout', '/api/auth/logout-all', '/api/auth/csrf', '/api/auth/encryption-status',
]);

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
  const pathname = requestPathname(request);
  if (!pathname) return false;
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
    const row = db.prepare('SELECT id, username, email, role, password_hash, auth_version, totp_enabled FROM users WHERE id = ?').get(decoded.id);

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

    const { password_hash, auth_version, totp_enabled, ...user } = row;
    request.user = user;

    // "Require two-factor auth for admins": an admin who has not enrolled may
    // only reach the routes needed to enrol (and to leave). Everything else
    // answers 403 with mfaSetupRequired so the SPA can send them to Account.
    if (user.role === 'admin' && !totp_enabled && getSetting('require_mfa_admins', false) === true) {
      const pathname = requestPathname(request);
      if (!pathname || !MFA_ENROL_PATHS.has(pathname)) {
        return reply.code(403).send({
          error: 'Two-factor authentication is required for admin accounts - turn it on in your Account page',
          mfaSetupRequired: true,
        });
      }
    }
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

/**
 * Roles, least to most privileged. See ROLE_CAPABILITIES for the meaning.
 *
 *   viewer  - a signed-in member: can download, favourite, edit own profile.
 *   editor  - a content role: can create and edit file pages, mirrors,
 *             categories, folders and uploads, and use the AI drafting tools.
 *             Cannot delete, publish site settings, manage users, run
 *             backups/imports, or touch anything operational.
 *   admin   - everything.
 */
export const ROLES = ['viewer', 'editor', 'admin'];

export const ROLE_CAPABILITIES = {
  viewer: ['download', 'favorites', 'profile'],
  editor: ['download', 'favorites', 'profile', 'content:read', 'content:write', 'uploads:write', 'ai:draft'],
  admin: ['*'],
};

export function roleAtLeast(role, minimum) {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}

/**
 * preHandler factory: `requireRole('editor')` lets editors AND admins through,
 * `requireRole('admin')` is the same as requireAdmin. 401 without a session,
 * 403 with one that is too weak.
 *
 * The returned function is named `requireRole:<roles>` so the OpenAPI
 * generator can print the requirement without executing anything.
 */
export function requireRole(minimum) {
  if (!ROLES.includes(minimum)) throw new Error(`Unknown role: ${minimum}`);
  const allowed = ROLES.slice(ROLES.indexOf(minimum));
  const fn = async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
    if (!roleAtLeast(request.user.role, minimum)) {
      return reply.code(403).send({ error: `${minimum === 'admin' ? 'Admin' : 'Editor'} access required`, requiredRole: minimum });
    }
  };
  Object.defineProperty(fn, 'name', { value: `requireRole:${allowed.join(',')}` });
  return fn;
}

export const requireEditor = requireRole('editor');

export async function requireAdmin(request, reply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required', requiredRole: 'admin' });
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
