import { getDb } from '../db/index.js';
import { loginSchema, registerSchema } from '../utils/validation.js';
import { generateToken, authenticate } from '../middleware/auth.js';
import { config } from '../config.js';
import { encryptionService } from '../services/encryptionService.js';
import { captchaService } from '../services/captchaService.js';
import crypto from 'crypto';
import { z } from 'zod';

/**
 * Session cookie options. `secure` follows the environment (see
 * config.security.cookieSecure) instead of being pinned to false, which used
 * to send the session token in clear text on every production request.
 */
function sessionCookieOptions(extra = {}) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    ...extra,
  };
}

/**
 * Mint (and set) the CSRF double-submit cookie. Deliberately NOT httpOnly:
 * the SPA must read it to echo it back as X-CSRF-Token. It holds no session
 * power by itself - it only proves the page could read our cookies.
 */
function issueCsrfCookie(reply) {
  const token = crypto.randomBytes(24).toString('base64url');
  reply.setCookie('espress0_csrf', token, sessionCookieOptions({ httpOnly: false }));
  return token;
}

const profileSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid username').optional(),
  email: z.string().email().max(100).optional(),
  currentPassword: z.string().min(4).max(200).optional().nullable(),
  newPassword: z.string().min(8).max(128).regex(/[a-z]/, 'Need lowercase').regex(/[A-Z]/, 'Need uppercase').regex(/[0-9]/, 'Need number').optional().nullable(),
  confirmNewPassword: z.string().optional().nullable(),
  // z.string().url() happily accepts javascript: and data: URLs; restrict the
  // schemes since this value is rendered back into the page.
  avatar_url: z.string().url()
    .refine(v => /^https?:\/\//i.test(v), 'Avatar URL must start with http:// or https://')
    .or(z.string().regex(/^\/api\/uploads\/[a-zA-Z0-9._-]+$/, 'Invalid upload path'))
    .or(z.literal(''))
    .optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  theme: z.enum(['dark', 'light', 'auto']).optional(),
}).refine(data => {
  if (data.newPassword && data.newPassword !== data.confirmNewPassword) return false;
  return true;
}, { message: "New passwords don't match", path: ["confirmNewPassword"] });

export async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.errors });

    const { username, password, captchaId, captchaAnswer, captchaToken } = request.body;
    const captchaType = process.env.CAPTCHA_TYPE || 'math';
    if (captchaType !== 'disabled') {
      const captchaResult = await captchaService.verifyWithType({ id: captchaId, answer: captchaAnswer, token: captchaToken }, request.ip);
      if (!captchaResult.success) {
        return reply.code(400).send({ error: 'CAPTCHA verification failed', details: captchaResult.message, captchaRequired: true, newCaptcha: captchaService.generate() });
      }
    }
    const db = getDb();
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user && username.includes('@')) {
      const emailHash = encryptionService.hashEmail(username);
      user = db.prepare('SELECT * FROM users WHERE email_hash = ?').get(emailHash);
      if (!user) {
        const allUsers = db.prepare('SELECT * FROM users').all();
        for (const u of allUsers) {
          try {
            const decryptedEmail = encryptionService.decrypt(u.email);
            if (decryptedEmail.toLowerCase() === username.toLowerCase()) { user = u; break; }
          } catch { if (u.email.toLowerCase() === username.toLowerCase()) { user = u; break; } }
        }
      }
    }
    if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(username);
    if (!user) {
      await encryptionService.verifyPasswordWithPepper(password, '$2b$12$dummyhashdummyhashdummyhashdummyhashdummyha');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    const valid = await encryptionService.verifyPasswordWithPepper(password, user.password_hash);
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' });
    if (!user.password_hash.startsWith('pepper_v1:')) {
      const newHash = await encryptionService.hashPasswordWithPepper(password);
      db.prepare('UPDATE users SET password_hash = ?, encryption_version = ? WHERE id = ?').run(newHash, 'v1', user.id);
      user = { ...user, password_hash: newHash };
    }
    let decryptedEmail = user.email;
    try { decryptedEmail = encryptionService.decrypt(user.email); } catch {}
    let decAvatar = null; try { decAvatar = user.avatar_url ? encryptionService.decrypt(user.avatar_url) : null; } catch {}
    let decBio = null; try { decBio = user.bio ? encryptionService.decrypt(user.bio) : null; } catch {}
    const token = generateToken({ ...user, email: decryptedEmail });

    // Set cookies - actual cookies for downloads
    reply.setCookie('espress0_token', token, sessionCookieOptions());
    reply.setCookie('espress0_auth', '1', sessionCookieOptions({ httpOnly: false }));
    const csrfToken = issueCsrfCookie(reply);

    request.log.info({ userId: user.id, username: user.username }, 'User logged in with cookies');
    return { token, csrfToken, user: { id: user.id, username: user.username, email: decryptedEmail, role: user.role, avatar_url: decAvatar, bio: decBio, theme: user.theme || 'dark' } };
  });

  fastify.post('/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } }
  }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    // Checked before any lookup: with registration closed the endpoint must
    // not double as a username/email oracle.
    if (!config.security.allowRegistration) {
      return reply.code(403).send({ error: 'Registration is disabled. Contact admin.' });
    }

    const { username, email, password, captchaId, captchaAnswer, captchaToken } = request.body;
    const captchaType = process.env.CAPTCHA_TYPE || 'math';
    if (captchaType !== 'disabled') {
      const captchaResult = await captchaService.verifyWithType({ id: captchaId, answer: captchaAnswer, token: captchaToken }, request.ip);
      if (!captchaResult.success) {
        return reply.code(400).send({ error: 'CAPTCHA verification failed', details: captchaResult.message, captchaRequired: true, newCaptcha: captchaService.generate() });
      }
    }
    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return reply.code(409).send({ error: 'Username already exists' });
    const emailHash = encryptionService.hashEmail(email);
    if (db.prepare('SELECT id FROM users WHERE email_hash = ?').get(emailHash)) return reply.code(409).send({ error: 'Email already exists' });
    const allUsers = db.prepare('SELECT id, email FROM users').all();
    for (const u of allUsers) {
      try { const dec = encryptionService.decrypt(u.email); if (dec.toLowerCase() === email.toLowerCase()) return reply.code(409).send({ error: 'Email already exists' }); } catch { if (u.email.toLowerCase() === email.toLowerCase()) return reply.code(409).send({ error: 'Email already exists' }); }
    }
    const encryptedEmail = encryptionService.encrypt(email);
    const hash = await encryptionService.hashPasswordWithPepper(password);
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const role = userCount === 0 ? 'admin' : 'viewer';
    try {
      const result = db.prepare(`INSERT INTO users (username, email, email_hash, password_hash, role, encryption_version) VALUES (?, ?, ?, ?, ?, ?)`).run(username, encryptedEmail, emailHash, hash, role, 'v1');
      const newUser = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(result.lastInsertRowid);
      let decEmail = newUser.email; try { decEmail = encryptionService.decrypt(newUser.email); } catch {}
      const token = generateToken({ ...newUser, email: decEmail }, { passwordHash: hash });

      reply.setCookie('espress0_token', token, sessionCookieOptions());
      reply.setCookie('espress0_auth', '1', sessionCookieOptions({ httpOnly: false }));
      const csrfToken = issueCsrfCookie(reply);

      request.log.info({ userId: newUser.id, username: newUser.username, role }, 'New user registered with cookies');
      return reply.code(201).send({
        token,
        csrfToken,
        user: { id: newUser.id, username: newUser.username, email: decEmail, role: newUser.role },
        message: role === 'admin' ? 'First user created as admin' : 'Registration successful',
      });
    } catch (e) {
      request.log.error(e, 'Registration failed');
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  fastify.get('/auth/me', { preHandler: [authenticate] }, async (request, reply) => {
    let user = request.user;
    if (user) {
      const db = getDb();
      const fullUser = db.prepare('SELECT email, avatar_url, bio, theme FROM users WHERE id = ?').get(user.id);
      if (fullUser) {
        try { user = { ...user, email: encryptionService.decrypt(fullUser.email) }; } catch {}
        try { user = { ...user, avatar_url: fullUser.avatar_url ? encryptionService.decrypt(fullUser.avatar_url) : null }; } catch {}
        try { user = { ...user, bio: fullUser.bio ? encryptionService.decrypt(fullUser.bio) : null }; } catch {}
        user = { ...user, theme: fullUser.theme || 'dark' };
      }
    }
    return { user };
  });

  fastify.put('/auth/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const { username, email, currentPassword, newPassword, avatar_url, bio, theme } = parsed.data;
    const db = getDb();
    const userId = request.user.id;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!existing) return reply.code(404).send({ error: 'User not found' });

    // Require current password only for sensitive changes
    const changingSensitive = !!(newPassword || email);
    const changingUsername = !!(username && username !== existing.username);
    
    if ((changingSensitive || changingUsername) && !currentPassword) {
      if (changingSensitive) {
        return reply.code(400).send({ error: 'Current password required to change email or password' });
      }
      // For username, allow without current password for customization ease, but verify if provided
    }

    if (currentPassword) {
      const valid = await encryptionService.verifyPasswordWithPepper(currentPassword, existing.password_hash);
      if (!valid) return reply.code(401).send({ error: 'Current password incorrect' });
    }

    const updates = [];
    const params = { id: userId };

    if (username && username !== existing.username) {
      if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return reply.code(400).send({ error: 'Invalid username format' });
      const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId);
      if (dup) return reply.code(409).send({ error: 'Username already exists' });
      updates.push('username = @username');
      params.username = username;
    }

    if (email) {
      let currentDecEmail = existing.email;
      try { currentDecEmail = encryptionService.decrypt(existing.email); } catch {}
      if (email.toLowerCase() !== currentDecEmail.toLowerCase()) {
        const emailHash = encryptionService.hashEmail(email);
        const dup = db.prepare('SELECT id FROM users WHERE email_hash = ? AND id != ?').get(emailHash, userId);
        if (dup) return reply.code(409).send({ error: 'Email already exists' });
        const encryptedEmail = encryptionService.encrypt(email);
        updates.push('email = @email');
        updates.push('email_hash = @email_hash');
        params.email = encryptedEmail;
        params.email_hash = emailHash;
      }
    }

    if (newPassword) {
      const newHash = await encryptionService.hashPasswordWithPepper(newPassword);
      updates.push('password_hash = @password_hash');
      params.password_hash = newHash;
    }

    if (avatar_url !== undefined) {
      const encAvatar = avatar_url ? encryptionService.encrypt(avatar_url) : null;
      updates.push('avatar_url = @avatar_url');
      params.avatar_url = encAvatar;
    }

    if (bio !== undefined) {
      const encBio = bio ? encryptionService.encrypt(bio) : null;
      updates.push('bio = @bio');
      params.bio = encBio;
    }

    if (theme) {
      updates.push('theme = @theme');
      params.theme = theme;
    }

    if (updates.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    updates.push('updated_at = @updated_at');
    params.updated_at = new Date().toISOString();
    updates.push('encryption_version = @encryption_version');
    params.encryption_version = 'v1';

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = @id`).run(params);

    const updatedRaw = db.prepare('SELECT id, username, email, role, avatar_url, bio, theme FROM users WHERE id = ?').get(userId);
    let decEmail = updatedRaw.email; try { decEmail = encryptionService.decrypt(updatedRaw.email); } catch {}
    let decAvatar = updatedRaw.avatar_url; try { decAvatar = updatedRaw.avatar_url ? encryptionService.decrypt(updatedRaw.avatar_url) : null; } catch {}
    let decBio = updatedRaw.bio; try { decBio = updatedRaw.bio ? encryptionService.decrypt(updatedRaw.bio) : null; } catch {}

    return {
      user: { id: updatedRaw.id, username: updatedRaw.username, email: decEmail, role: updatedRaw.role, avatar_url: decAvatar, bio: decBio, theme: updatedRaw.theme || 'dark' },
      message: 'Profile updated',
    };
  });

  fastify.get('/auth/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const db = getDb();
    const userRaw = db.prepare('SELECT id, username, email, role, avatar_url, bio, theme, encryption_version, created_at FROM users WHERE id = ?').get(request.user.id);
    if (!userRaw) return reply.code(404).send({ error: 'User not found' });
    
    let decEmail = userRaw.email; try { decEmail = encryptionService.decrypt(userRaw.email); } catch {}
    let decAvatar = userRaw.avatar_url; try { decAvatar = userRaw.avatar_url ? encryptionService.decrypt(userRaw.avatar_url) : null; } catch {}
    let decBio = userRaw.bio; try { decBio = userRaw.bio ? encryptionService.decrypt(userRaw.bio) : null; } catch {}

    return {
      id: userRaw.id,
      username: userRaw.username,
      email: decEmail,
      role: userRaw.role,
      avatar_url: decAvatar,
      bio: decBio,
      theme: userRaw.theme || 'dark',
      encryption_version: userRaw.encryption_version,
      created_at: userRaw.created_at,
    };
  });

  /**
   * GET /auth/csrf - make sure the caller has a CSRF cookie. Called by the SPA
   * on boot: a restored session (httpOnly token survived, readable CSRF cookie
   * did not) would otherwise be unable to mutate anything until next login.
   */
  fastify.get('/auth/csrf', async (request, reply) => {
    const existing = request.cookies?.espress0_csrf;
    if (existing && existing.length >= 16) return { csrfToken: existing };
    return { csrfToken: issueCsrfCookie(reply) };
  });

  fastify.post('/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    reply.clearCookie('espress0_token', { path: '/' });
    reply.clearCookie('espress0_auth', { path: '/' });
    reply.clearCookie('espress0_csrf', { path: '/' });
    return { success: true, message: 'Logged out' };
  });

  /**
   * POST /auth/logout-all - "log out all devices". Bumping auth_version
   * invalidates every token minted so far, including the caller's own, so the
   * response also clears this device's cookies.
   */
  fastify.post('/auth/logout-all', { preHandler: [authenticate] }, async (request, reply) => {
    const db = getDb();
    db.prepare('UPDATE users SET auth_version = COALESCE(auth_version, 0) + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), request.user.id);
    reply.clearCookie('espress0_token', { path: '/' });
    reply.clearCookie('espress0_auth', { path: '/' });
    reply.clearCookie('espress0_csrf', { path: '/' });
    request.log.info({ userId: request.user.id }, 'User logged out of all sessions');
    return { success: true, message: 'All sessions were signed out. Log in again to continue.' };
  });

  fastify.get('/auth/security-info', async (request, reply) => {
    return {
      protections: {
        passwordHashing: 'pepper (HMAC-SHA256) + bcrypt cost 12 + versioned',
        emailEncryption: 'AES-256-GCM with random IV + HMAC hash for lookup',
        itemEncryption: 'storage_path, download_url, external_url, license_notes AES-256-GCM',
        jwt: 'HS256 (algorithm pinned) with expiry, invalidated on password change and on "log out all devices"; httpOnly SameSite=Lax cookie or Bearer header (query ?token= only on download/preview)',
        csrf: 'Double-submit cookie (espress0_csrf + X-CSRF-Token) on every cookie-authenticated mutation',
        rateLimiting: 'Enabled',
        sqlInjection: 'Parameterized queries',
        xss: 'React auto-escapes, strict Content-Security-Policy, uploads served sandboxed with nosniff',
        captcha: `Type: ${process.env.CAPTCHA_TYPE || 'math'}`,
        downloads: 'Login required, unlimited mirrors, can mark as down',
      },
      encryptedFields: {
        users: ['email + email_hash', 'avatar_url', 'bio'],
        items: ['storage_path, download_url, external_url, license_notes'],
        passwords: ['pepper_v1:HMAC + bcrypt'],
      },
    };
  });

  fastify.get('/auth/encryption-status', { preHandler: [authenticate] }, async (request, reply) => {
    const db = getDb();
    const users = db.prepare('SELECT id, username, email, email_hash, encryption_version, password_hash FROM users').all();
    const stats = {
      totalUsers: users.length,
      encryptedEmails: users.filter(u => u.email && u.email.startsWith('enc_v1:')).length,
      legacyEmails: users.filter(u => u.email && !u.email.startsWith('enc_v1:')).length,
      pepperedPasswords: users.filter(u => u.password_hash && u.password_hash.startsWith('pepper_v1:')).length,
      legacyPasswords: users.filter(u => u.password_hash && !u.password_hash.startsWith('pepper_v1:')).length,
      withEmailHash: users.filter(u => u.email_hash).length,
    };
    const items = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN storage_path LIKE 'enc_v1:%' THEN 1 ELSE 0 END) as enc_storage, SUM(CASE WHEN download_url LIKE 'enc_v1:%' THEN 1 ELSE 0 END) as enc_download FROM items").get();
    return {
      users: stats,
      items: { total: items.total, encryptedStoragePath: items.enc_storage, encryptedDownloadUrl: items.enc_download },
      config: { encryptionKeySet: !!process.env.ENCRYPTION_KEY, pepperSet: !!process.env.PASSWORD_PEPPER, jwtSet: !!process.env.JWT_SECRET && process.env.JWT_SECRET.length > 20 }
    };
  });
}
