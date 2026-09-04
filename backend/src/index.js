import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import { config, assertProductionSecrets } from './config.js';
import crypto from 'crypto';
import fsSync from 'fs';
import pathSync from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/index.js';
import { COMMIT, COMMIT_SHORT, STARTED_AT } from './lib/buildInfo.js';

// Routes
import { itemsRoutes } from './routes/items.js';
import { categoriesRoutes } from './routes/categories.js';
import { foldersRoutes } from './routes/folders.js';
import { searchRoutes } from './routes/search.js';
import { statsRoutes } from './routes/stats.js';
import { authRoutes } from './routes/auth.js';
import { usersRoutes } from './routes/users.js';
import { favoritesRoutes } from './routes/favorites.js';
import { aiRoutes } from './routes/ai.js';
import { adminRoutes } from './routes/admin.js';
import { captchaRoutes } from './routes/captcha.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { previewRoutes } from './routes/preview.js';
import { settingsRoutes } from './routes/settings.js';
import { uploadsRoutes } from './routes/uploads.js';
import { linkHealthRoutes } from './routes/linkHealth.js';
import { backupRoutes } from './routes/backup.js';
import { catalogRoutes } from './routes/catalog.js';
import multipart from '@fastify/multipart';
import { monitoringService } from './services/monitoringService.js';
import { linkHealthService } from './services/linkHealthService.js';
import { rateLimitKey, rateLimitMax } from './middleware/rateLimit.js';
import { openapiPlugin } from './docs/openapi.js';

// Boot-time configuration audit. In production this throws; in development it
// prints the same list so the gap is visible before deploy day.
{
  const problems = assertProductionSecrets();
  if (problems.length && config.isDev) {
    console.warn('\n[security] Development defaults in use:\n  - ' + problems.join('\n  - ') + '\n');
  }
}

/**
 * Hashes of the inline <script> blocks in the built index.html (the theme
 * pre-paint that avoids a light flash). Hashing them keeps script-src free of
 * 'unsafe-inline' while still allowing exactly those bytes.
 */
function inlineScriptHashes() {
  try {
    const dir = pathSync.dirname(fileURLToPath(import.meta.url));
    const indexHtml = pathSync.resolve(dir, '../../frontend/dist/index.html');
    if (!fsSync.existsSync(indexHtml)) return [];
    const html = fsSync.readFileSync(indexHtml, 'utf8');
    const hashes = [];
    for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = match[1];
      if (!body.trim()) continue;
      hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport: config.isDev ? { target: 'pino-pretty' } : undefined,
  },
  trustProxy: true,
});

await fastify.register(cookie, {
  secret: config.security.jwtSecret, // for signed cookies
});

// gzip/brotli on the way out. Behind nginx (gzip is on in nginx.conf.example)
// or Caddy (compresses by default) the proxy already does this, but `./espress0
// dev --build`, the tmux runner and the plain Docker profile serve straight from
// this process — and there the ~570 kB bundle was going out byte for byte.
// Must be registered before @fastify/static. The plugin's own 1 kB threshold and
// brotli quality 4 keep it cheap on a 1 vCPU box, and assets are now hashed and
// cached for a year, so each visitor pays for it at most once.
await fastify.register(compress, {
  encodings: ['br', 'gzip'],
  // Uploads arrive as multipart bodies and nothing here needs a compressed
  // request, so leave inbound bytes untouched.
  globalDecompression: false,
});

// Content-Security-Policy. Cover images and mirrors legitimately point at
// arbitrary https hosts, so img-src/media-src stay open, but scripts are
// restricted to our own bundle (plus the hashed inline theme bootstrap), which
// is what actually contains an XSS.
await fastify.register(helmet, {
  contentSecurityPolicy: {
    // Explicit list rather than helmet's defaults, so the policy does not
    // change under us on a dependency bump.
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'", ...inlineScriptHashes()],
      scriptSrcAttr: ["'none'"],
      // Tailwind ships a stylesheet, but React inline styles and the
      // starfield's injected keyframes need attribute/inline styles.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: config.isDev ? ["'self'", 'http:', 'https:', 'ws:', 'wss:'] : ["'self'", 'https:'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      // Only meaningful behind TLS; leaving it on in dev would break a
      // locally served production build over plain http.
      ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  // Uploaded images are consumed by the SPA on the same origin; in dev the
  // Vite origin differs, so keep this permissive there only.
  crossOriginResourcePolicy: { policy: config.isDev ? 'cross-origin' : 'same-site' },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

await fastify.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token', 'X-CSRF-Token', 'X-Requested-With', 'Cookie'],
});

/**
 * CSRF protection: double-submit cookie.
 *
 * Session auth rides on an httpOnly cookie, which browsers attach to every
 * request - including forged ones from other origins. SameSite=Lax already
 * blocks cross-site POSTs, but that is a relatively new behaviour and says
 * nothing about same-site gadgets. So for every *mutating* API call that is
 * authenticated by cookie (and ONLY those - Bearer/header auth is not ambient
 * and cannot be CSRFed) we require the X-CSRF-Token header to match the
 * readable espress0_csrf cookie. A foreign page cannot read our cookies, so
 * it cannot produce the header.
 *
 * Login/register are exempt: the caller provably has no session cookie yet
 * (the guard only engages when espress0_token is present).
 */
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/register']);

fastify.addHook('onRequest', async (request, reply) => {
  if (CSRF_SAFE_METHODS.has(request.method)) return;
  const pathname = (request.raw?.url || request.url || '').split('?')[0];
  if (!pathname.startsWith('/api/')) return;
  if (CSRF_EXEMPT_PATHS.has(pathname)) return;
  if (!request.cookies?.espress0_token) return; // cookie-less = Bearer/anon, not CSRF-able
  if (request.headers.authorization || request.headers['x-access-token']) return; // explicit token wins

  const header = String(request.headers['x-csrf-token'] || '');
  const cookieToken = String(request.cookies.espress0_csrf || '');
  const valid = header.length > 0 && header.length === cookieToken.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookieToken));
  if (!valid) {
    request.log.warn({ url: pathname }, 'CSRF validation failed');
    return reply.code(403).send({
      error: 'CSRF validation failed - refresh the page and try again',
      code: 'CSRF_MISMATCH',
    });
  }
});

// Image uploads from the admin UI. Per-request size limit is enforced in the
// upload route itself (driven by the `uploads_max_bytes` setting); this is the
// outer ceiling.
await fastify.register(multipart, {
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

await fastify.register(rateLimit, {
  global: true,
  timeWindow: config.rateLimit.windowMs,
  // Two buckets, not one: see rateLimitKey() in middleware/rateLimit.js for
  // why an admin session cannot share the anonymous allowance.
  keyGenerator: rateLimitKey,
  max: (request, key) => rateLimitMax(key),
});

// Security: Block path traversal
fastify.addHook('onRequest', async (request, reply) => {
  const url = request.raw.url || request.url;
  if (url.includes('..') || url.includes('%2e%2e') || url.includes('%2E%2E') || url.includes('%2f%2e') || url.includes('%252e')) {
    const pathPart = url.split('?')[0];
    if (pathPart.includes('..')) {
      request.log.warn({ url }, 'Blocked path traversal');
      return reply.code(400).send({ error: 'Invalid request - path traversal detected' });
    }
  }
  if (url.includes('\0') || url.includes('%00')) {
    return reply.code(400).send({ error: 'Invalid request' });
  }
});

fastify.addHook('onResponse', async (request, reply) => {
  monitoringService.recordRequest(request, reply, reply.elapsedTime);
});

getDb();

// OpenAPI: must be registered before any route so its onRoute hook sees them.
await fastify.register(openapiPlugin);

/**
 * Health, and the proof of which release is actually serving it.
 *
 * `commit` is captured when this process starts (see lib/buildInfo.js), not
 * read per request, so an old Node process cannot answer with the new commit
 * just because the files on disk were swapped underneath it. The auto-updater
 * relies on exactly that: it compares this value to the commit it deployed and
 * refuses to call an update successful until they match.
 */
fastify.get('/api/health', async () => {
  return {
    status: 'ok',
    service: "espress0's repo",
    version: '1.0.0',
    commit: COMMIT,
    commitShort: COMMIT_SHORT,
    startedAt: STARTED_AT,
    timestamp: new Date().toISOString(),
  };
});

await fastify.register(async (api) => {
  await api.register(itemsRoutes);
  await api.register(categoriesRoutes);
  await api.register(foldersRoutes);
  await api.register(searchRoutes);
  await api.register(statsRoutes);
  await api.register(authRoutes);
  await api.register(usersRoutes);
  await api.register(favoritesRoutes);
  await api.register(aiRoutes);
  await api.register(adminRoutes);
  await api.register(captchaRoutes);
  await api.register(monitoringRoutes);
  await api.register(previewRoutes);
  await api.register(settingsRoutes);
  await api.register(uploadsRoutes);
  await api.register(linkHealthRoutes);
  await api.register(backupRoutes);
  await api.register(catalogRoutes);
}, { prefix: '/api' });

// Serve the built frontend when it exists, in any environment. Deep links
// (/admin, /login, /file/slug) fall back to index.html so a hard refresh or a
// shared URL works instead of 404ing. When dist/ is absent (plain dev, where
// Vite serves the UI on :5173) we stay in API-only mode with a clear message.
{
  const path = await import('path');
  const fs = await import('fs');
  const { fileURLToPath } = await import('url');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  const hasDist = fs.existsSync(path.join(frontendDist, 'index.html'));

  if (hasDist) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await fastify.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
      wildcard: false,
      // Vite fingerprints everything it emits under /assets/ (index-<hash>.js),
      // so those URLs change whenever the bytes do and can be pinned for a year.
      // Unhashed files — index.html, the logo, the loading gif — keep the same
      // URL across deploys, so they must be revalidated or a release sticks.
      setHeaders: (reply, path) => {
        if (/[\\/]assets[\\/]/.test(path)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found' });
      return reply.sendFile('index.html');
    });
    fastify.log.info(`Serving frontend from ${frontendDist}`);
  } else {
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found' });
      return reply.code(404).send({
        error: 'Frontend not built',
        hint: `Run "npm run build" in frontend/ to serve the UI from this port (expected ${frontendDist}/index.html). In development the Vite dev server serves the UI on port 5173.`,
      });
    });
    fastify.log.info(`API-only mode: no frontend build at ${frontendDist}`);
  }
}

fastify.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const status = error.statusCode || 500;
  reply.code(status).send({
    error: status === 500 ? 'Internal server error' : error.message,
    ...(config.isDev && { stack: error.stack }),
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: config.port, host: config.host });
    // Periodic download-link checks; idle unless linkcheck_enabled is set.
    linkHealthService.start(fastify.log);
    console.log(`
  ░█▀▀░█▀▀░█▀█░█▀▄░█▀▀░█▀▀░█▀▀░▄▀▄░▀░█▀▀░░░█▀▄░█▀▀░█▀█░█▀█
  ░█▀▀░▀▀█░█▀▀░█▀▄░█▀▀░▀▀█░▀▀█░█/█░░░▀▀█░░░█▀▄░█▀▀░█▀▀░█░█
  ░▀▀▀░▀▀▀░▀░░░▀░▀░▀▀▀░▀▀▀░▀▀▀░░▀░░░░▀▀▀░░░▀░▀░▀▀▀░▀░░░▀▀▀

  Backend running at http://${config.host}:${config.port}
  Environment: ${config.env}
  Database: ${config.db.path}
  Cookies: Enabled (httpOnly, SameSite Lax)
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
