import { authenticate, requireAdmin } from '../middleware/auth.js';
import { webhookService, WebhookValidationError } from '../services/webhookService.js';
import { EVENT_TYPES, listEvents } from '../services/eventBus.js';
import { UnsafeUrlError } from '../lib/safeFetch.js';

/**
 * Webhooks.
 *
 *   /api/admin/webhooks[...]  site-wide hooks, admin only, every event type
 *   /api/webhooks[...]        the signed-in user's personal hooks; they only
 *                             ever receive events about public items
 *   /api/admin/events         the recent event log (what would be delivered)
 */
function sendError(reply, e) {
  if (e instanceof WebhookValidationError) return reply.code(400).send({ error: e.message });
  if (e instanceof UnsafeUrlError) return reply.code(400).send({ error: `Refused URL: ${e.message}` });
  throw e;
}

function idParam(request) {
  const n = parseInt(request.params.id, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The same handlers, parameterised by owner: null = site-wide, id = personal. */
function mount(fastify, prefix, ownerOf) {
  fastify.get(`${prefix}`, async (request) => ({
    webhooks: webhookService.list({ userId: ownerOf(request) }),
    events: EVENT_TYPES,
  }));

  fastify.post(`${prefix}`, async (request, reply) => {
    try {
      const { name, url, events, active, filter_mode } = request.body || {};
      const hook = await webhookService.create({ userId: ownerOf(request), name, url, events, active, filter_mode });
      return reply.code(201).send({ webhook: hook, note: 'Store the secret now - it is not shown again.' });
    } catch (e) { return sendError(reply, e); }
  });

  fastify.get(`${prefix}/:id`, async (request, reply) => {
    const id = idParam(request);
    const hook = id && webhookService.get(id, { userId: ownerOf(request) });
    if (!hook) return reply.code(404).send({ error: 'Webhook not found' });
    return { webhook: hook, deliveries: webhookService.deliveries(id, { limit: request.query.limit }) };
  });

  fastify.put(`${prefix}/:id`, async (request, reply) => {
    const id = idParam(request);
    if (!id) return reply.code(404).send({ error: 'Webhook not found' });
    try {
      const { name, url, events, active, rotateSecret, filter_mode } = request.body || {};
      const hook = await webhookService.update(id, { name, url, events, active, filter_mode, rotateSecret: !!rotateSecret }, { userId: ownerOf(request) });
      if (!hook) return reply.code(404).send({ error: 'Webhook not found' });
      return { webhook: hook };
    } catch (e) { return sendError(reply, e); }
  });

  fastify.delete(`${prefix}/:id`, async (request, reply) => {
    const id = idParam(request);
    if (!id || !webhookService.remove(id, { userId: ownerOf(request) })) return reply.code(404).send({ error: 'Webhook not found' });
    return { success: true };
  });

  fastify.post(`${prefix}/:id/test`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = idParam(request);
    if (!id || !webhookService.get(id, { userId: ownerOf(request) })) return reply.code(404).send({ error: 'Webhook not found' });
    return webhookService.sendTest(id);
  });

  fastify.post(`${prefix}/:id/deliveries/:deliveryId/redeliver`, async (request, reply) => {
    const id = idParam(request);
    if (!id || !webhookService.get(id, { userId: ownerOf(request) })) return reply.code(404).send({ error: 'Webhook not found' });
    const deliveryId = parseInt(request.params.deliveryId, 10);
    const belongs = webhookService.deliveries(id, { limit: 200 }).some(d => d.id === deliveryId);
    if (!belongs || !webhookService.redeliver(deliveryId)) return reply.code(404).send({ error: 'Delivery not found' });
    return { success: true };
  });
}

export async function webhookRoutes(fastify) {
  // Personal hooks
  await fastify.register(async (scope) => {
    scope.addHook('preHandler', authenticate);
    mount(scope, '/webhooks', (request) => request.user.id);
  });

  // Site-wide hooks + the event log
  await fastify.register(async (scope) => {
    scope.addHook('preHandler', authenticate);
    scope.addHook('preHandler', requireAdmin);
    mount(scope, '/admin/webhooks', () => null);

    scope.get('/admin/events', async (request) => {
      const { type, item_id, limit } = request.query || {};
      const types = type ? String(type).split(',').filter(t => EVENT_TYPES.includes(t)) : null;
      return { events: listEvents({ types, itemId: item_id ? parseInt(item_id, 10) : null, limit }), types: EVENT_TYPES };
    });
  });
}
