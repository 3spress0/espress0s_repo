import { authenticate, requireAdmin } from '../middleware/auth.js';
import { linkHealthService } from '../services/linkHealthService.js';

/**
 * Admin endpoints for the download-link health checker. All of it is behind
 * requireAdmin: probe results reveal which mirrors exist and which hosts the
 * server can reach.
 */
export async function linkHealthRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

  // GET /api/admin/link-health - aggregate counts + problem list
  fastify.get('/admin/link-health', async () => {
    return linkHealthService.getSummary();
  });

  // POST /api/admin/link-health/run - probe every mirror now
  fastify.post('/admin/link-health/run', {
    config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (linkHealthService.running) {
      return reply.code(409).send({ error: 'A link check run is already in progress' });
    }
    const summary = await linkHealthService.runAll();
    request.log.info(summary, 'Link health run completed');
    return { success: true, run: summary };
  });

  // POST /api/admin/link-health/links/:linkId/check - probe a single mirror
  fastify.post('/admin/link-health/links/:linkId/check', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const linkId = Number(request.params.linkId);
    if (!Number.isInteger(linkId) || linkId <= 0) return reply.code(400).send({ error: 'Invalid link id' });
    const result = await linkHealthService.checkById(linkId);
    if (!result) return reply.code(404).send({ error: 'Link not found' });
    return result;
  });
}
