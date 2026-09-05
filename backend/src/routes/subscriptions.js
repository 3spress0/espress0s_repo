import { authenticate } from '../middleware/auth.js';
import { listSubscriptions, subscribe, unsubscribe, subscriptionStatus, SubscriptionError } from '../services/subscriptionService.js';
import { getDb } from '../db/index.js';

/**
 * /api/subscriptions - the signed-in user's followed entries and tags.
 * Deliveries happen through the user's personal webhooks (filter_mode =
 * 'subscribed'); see services/subscriptionService.js.
 */
export async function subscriptionRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  const tags = { tags: ['Subscriptions'] };

  fastify.get('/subscriptions', { schema: { ...tags, summary: 'List my subscriptions' } }, async (request) => ({
    subscriptions: listSubscriptions(request.user.id),
  }));

  fastify.post('/subscriptions', { schema: { ...tags, summary: 'Follow an entry (item_id or item_slug) or a tag' } }, async (request, reply) => {
    try {
      const { kind, item_id, item_slug, tag } = request.body || {};
      const sub = subscribe(request.user.id, { kind, item_id: item_id ? parseInt(item_id, 10) : undefined, item_slug, tag });
      return reply.code(201).send({ subscription: sub });
    } catch (e) {
      if (e instanceof SubscriptionError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  fastify.delete('/subscriptions/:id', { schema: { ...tags, summary: 'Unfollow' } }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!id || !unsubscribe(request.user.id, id)) return reply.code(404).send({ error: 'Subscription not found' });
    return { success: true };
  });

  fastify.get('/subscriptions/status/:slug', { schema: { ...tags, summary: 'Am I following this entry (directly or via a tag)?' } }, async (request, reply) => {
    const item = getDb().prepare('SELECT id, tags FROM items WHERE slug = ?').get(String(request.params.slug).slice(0, 200));
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    let itemTags = [];
    try { itemTags = JSON.parse(item.tags || '[]'); } catch { itemTags = []; }
    return subscriptionStatus(request.user.id, item.id, Array.isArray(itemTags) ? itemTags : []);
  });
}
