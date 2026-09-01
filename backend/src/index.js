import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { config, assertProductionSecrets } from './config.js';
import crypto from 'crypto';
import fsSync from 'fs';
import pathSync from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/index.js';

// Routes
import { itemsRoutes } from './routes/items.js';
import { categoriesRoutes } from './routes/categories.js';
import { searchRoutes } from './routes/search.js';
import { statsRoutes } from './routes/stats.js';
import { authRoutes } from './routes/auth.js';
import { aiRoutes } from './routes/ai.js';
import { adminRoutes } from './routes/admin.js';
import { captchaRoutes } from './routes/captcha.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { previewRoutes } from './routes/preview.js';
import { settingsRoutes } from './routes/settings.js';
import { uploadsRoutes } from './routes/uploads.js';
import multipart from '@fastify/multipart';
import { monitoringService } from './services/monitoringService.js';

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token', 'X-Requested-With', 'Cookie'],
});

// Image uploads from the admin UI. Per-request size limit is enforced in the
// upload route itself (driven by the `uploads_max_bytes` setting); this is the
// outer ceiling.
await fastify.register(multipart, {
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

await fastify.register(rateLimit, {
  global: true,
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
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

fastify.get('/api/health', async () => {
  return { status: 'ok', service: "espress0's repo", version: '1.0.0', timestamp: new Date().toISOString() };
});

await fastify.register(async (api) => {
  await api.register(itemsRoutes);
  await api.register(categoriesRoutes);
  await api.register(searchRoutes);
  await api.register(statsRoutes);
  await api.register(authRoutes);
  await api.register(aiRoutes);
  await api.register(adminRoutes);
  await api.register(captchaRoutes);
  await api.register(monitoringRoutes);
  await api.register(previewRoutes);
  await api.register(settingsRoutes);
  await api.register(uploadsRoutes);
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
    await fastify.register(fastifyStatic, { root: frontendDist, prefix: '/', wildcard: false });
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
    console.log(`
  ███████ ███████ ██████  ██████  ███████ ███████  ██████        ██████  ███████ ██████   ██████  
  ██      ██      ██   ██ ██   ██ ██      ██      ██    ██       ██   ██ ██      ██   ██ ██    ██ 
  █████   ███████ ██████  ██████  █████   ███████ ██    ██ █████ ██████  █████   ██████  ██    ██ 
  ██           ██ ██      ██   ██ ██           ██ ██    ██       ██   ██ ██      ██      ██    ██ 
  ███████ ███████ ██      ██   ██ ███████ ███████  ██████        ██   ██ ███████ ██       ██████  
                                                                                                 
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
