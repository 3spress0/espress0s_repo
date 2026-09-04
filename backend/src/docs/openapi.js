/**
 * OpenAPI 3 document for every registered route, served at
 *
 *   GET /api/docs          - human-readable viewer (self-hosted, CSP-safe)
 *   GET /api/docs/json     - the OpenAPI document
 *   GET /api/docs/yaml     - the same, as YAML
 *
 * The document is derived from the live route table rather than from
 * hand-written schemas on each handler. Routes that declare `schema` (body,
 * querystring, params, response) are picked up verbatim by @fastify/swagger;
 * the rest get:
 *
 *   - a tag from the URL prefix (/api/admin/... -> Admin, /api/auth -> Auth)
 *   - a security requirement when `authenticate` / `requireAdmin` /
 *     `requireRole(...)` sit in the preHandler chain
 *   - path parameters inferred from the `:param` segments
 *
 * Adding `schema: { summary, description }` (or full JSON schemas) to a route
 * enriches the document without any change here.
 */
import swagger from '@fastify/swagger';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TAGS = [
  ['/api/admin/catalog', 'Catalog import/export'],
  ['/api/admin/link-health', 'Link health'],
  ['/api/admin/backup', 'Backup & restore'],
  ['/api/admin/ai', 'AI (admin)'],
  ['/api/admin', 'Admin'],
  ['/api/auth', 'Auth'],
  ['/api/users', 'Users & profiles'],
  ['/api/favorites', 'Favorites'],
  ['/api/items', 'Items'],
  ['/api/download', 'Downloads'],
  ['/api/preview', 'Preview'],
  ['/api/categories', 'Categories'],
  ['/api/folders', 'Folders'],
  ['/api/search', 'Search'],
  ['/api/stats', 'Stats'],
  ['/api/ai', 'AI'],
  ['/api/faq', 'AI'],
  ['/api/captcha', 'Captcha'],
  ['/api/monitoring', 'Monitoring'],
  ['/api/settings', 'Settings'],
  ['/api/uploads', 'Uploads'],
  ['/api/v1', 'Public API'],
  ['/api/feed', 'Feeds'],
  ['/api/docs', 'Docs'],
  ['/api/health', 'Health'],
];

function tagFor(url) {
  const hit = TAGS.find(([prefix]) => url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'));
  return hit ? hit[1] : 'Other';
}

/** Names of the preHandler functions on a route, whatever shape they arrive in. */
function handlerNames(route) {
  const list = [];
  for (const key of ['onRequest', 'preValidation', 'preHandler']) {
    const v = route[key];
    if (!v) continue;
    for (const fn of Array.isArray(v) ? v : [v]) list.push(fn?.name || '');
  }
  return list;
}

/**
 * The auth requirement, from the middleware chain. requireRole() returns a
 * closure whose name we set to `requireRole:<roles>` so it is readable here.
 */
function securityFor(route) {
  const names = handlerNames(route);
  const roleGate = names.find(n => n.startsWith('requireRole:'));
  if (names.includes('requireAdmin')) return { roles: ['admin'] };
  if (roleGate) return { roles: roleGate.slice('requireRole:'.length).split(',') };
  if (names.includes('authenticate')) return { roles: [] };
  // Plugin-wide `fastify.addHook('preHandler', requireAdmin)` (admin.js,
  // catalog.js, backup.js, linkHealth.js) is not visible per route, but the
  // whole /api/admin prefix is admin-only by construction.
  if ((route.url || '').startsWith('/api/admin')) return { roles: ['admin'] };
  return null;
}

export async function openapiPlugin(fastify) {
  const seen = new Set();

  fastify.addHook('onRoute', (route) => {
    const url = route.url || '';
    if (!url.startsWith('/api')) return; // static assets, SPA fallback
    if (route.method === 'HEAD') return;
    const schema = { ...(route.schema || {}) };
    if (schema.hide) return;
    schema.tags = schema.tags || [tagFor(url)];
    const sec = securityFor(route);
    if (sec) {
      schema.security = schema.security || [{ bearerAuth: [] }, { cookieAuth: [] }];
      const who = sec.roles.length ? `Requires role: ${sec.roles.join(' or ')}.` : 'Requires a signed-in user.';
      schema.description = [schema.description, who].filter(Boolean).join('\n\n');
    }
    if (route.config?.rateLimit || route.rateLimit) {
      schema.description = [schema.description, 'Rate limited.'].filter(Boolean).join('\n\n');
    }
    route.schema = schema;
    seen.add(`${route.method} ${url}`);
  });

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: "espress0's repo API",
        description:
          'HTTP API of the self-hosted software catalogue. Public catalogue reads need no credentials; ' +
          'everything under /api/admin needs an admin session (Bearer token or the httpOnly cookie). ' +
          'Mutating requests from a cookie session must also carry an `x-requested-with` header (CSRF).',
        version: '1.0.0',
      },
      servers: [{ url: '/', description: 'This instance' }],
      tags: TAGS.map(([, name]) => ({ name })).filter((t, i, a) => a.findIndex(x => x.name === t.name) === i),
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'espress0_token' },
        },
      },
    },
    hideUntagged: false,
    refResolver: { buildLocalReference: (json, baseUri, fragment, i) => json.$id || `def-${i}` },
  });

  fastify.get('/api/docs/json', { schema: { tags: ['Docs'], summary: 'OpenAPI document (JSON)' } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return fastify.swagger();
  });

  fastify.get('/api/docs/yaml', { schema: { tags: ['Docs'], summary: 'OpenAPI document (YAML)' } }, async (request, reply) => {
    reply.header('content-type', 'application/yaml; charset=utf-8').header('cache-control', 'no-store');
    return fastify.swagger({ yaml: true });
  });

  // A small self-hosted viewer: one HTML page and one external script, so it
  // works under the strict CSP (no inline script, no CDN) that the app ships.
  const html = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8');
  fastify.get('/api/docs', { schema: { tags: ['Docs'], summary: 'API reference viewer' } }, async (request, reply) => {
    reply.type('text/html; charset=utf-8');
    return html;
  });
  fastify.get('/api/docs/viewer.js', { schema: { hide: true } }, async (request, reply) => {
    reply.type('application/javascript; charset=utf-8');
    return js;
  });
}

// Break encapsulation: the onRoute hook and `fastify.swagger()` must live on
// the root instance to see every sibling route (same trick fastify-plugin uses).
openapiPlugin[Symbol.for('skip-override')] = true;
