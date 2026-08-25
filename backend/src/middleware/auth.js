import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

export async function authenticate(request, reply) {
  try {
    let token = null;

    // 1. Authorization header Bearer
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    // 2. Cookie (actual cookies - for downloads)
    if (!token && request.cookies && request.cookies.espress0_token) {
      token = request.cookies.espress0_token;
    }

    // 3. Query param ?token= for downloads
    if (!token && request.query && request.query.token) {
      token = request.query.token;
    }

    // 4. x-access-token header
    if (!token && request.headers['x-access-token']) {
      token = request.headers['x-access-token'];
    }

    if (!token) {
      return reply.code(401).send({ 
        error: 'Authentication required - login to download',
        loginRequired: true,
        loginUrl: '/login',
        message: 'You need to be logged in to download files'
      });
    }

    const decoded = jwt.verify(token, config.security.jwtSecret);
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id);
    
    if (!user) {
      return reply.code(401).send({ error: 'User not found' });
    }

    request.user = user;
  } catch (err) {
    return reply.code(401).send({ 
      error: 'Invalid or expired token - please login again',
      loginRequired: true,
      loginUrl: '/login'
    });
  }
}

export async function optionalAuthenticate(request, reply) {
  try {
    let token = null;
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
    if (!token && request.cookies && request.cookies.espress0_token) token = request.cookies.espress0_token;
    if (!token && request.query && request.query.token) token = request.query.token;
    if (!token) return;
    const decoded = jwt.verify(token, config.security.jwtSecret);
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(decoded.id);
    if (user) request.user = user;
  } catch {}
}

export async function requireAdmin(request, reply) {
  if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
  if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Admin access required' });
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.security.jwtSecret,
    { expiresIn: config.security.jwtExpiresIn }
  );
}
