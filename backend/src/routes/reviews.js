import { authenticate, optionalAuthenticate, requireEditor, roleAtLeast } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  ratingSummary, listForItem, getOwn, upsertReview, deleteReview, setReviewStatus, listAll, ReviewError,
} from '../services/reviewService.js';

/**
 * Ratings and reviews.
 *
 *   GET    /api/items/:slug/reviews         public: summary + visible reviews (+ own row)
 *   PUT    /api/items/:slug/reviews/mine    create/replace my review   (auth, rate-limited)
 *   DELETE /api/items/:slug/reviews/mine    withdraw my review
 *   GET    /api/admin/reviews?status=       moderation queue           (editor+)
 *   PATCH  /api/admin/reviews/:id           { status }                 (editor+)
 *   DELETE /api/admin/reviews/:id                                      (editor+)
 */
function sendError(reply, e) {
  if (e instanceof ReviewError) return reply.code(e.status).send({ error: e.message });
  throw e;
}

function findItem(request) {
  const key = String(request.params.slug).slice(0, 200);
  return getDb().prepare('SELECT id, slug, published FROM items WHERE slug = ? OR id = ?').get(key, /^\d+$/.test(key) ? Number(key) : -1);
}

export async function reviewRoutes(fastify) {
  const tags = { tags: ['Reviews'] };

  fastify.get('/items/:slug/reviews', { preHandler: [optionalAuthenticate], schema: { ...tags, summary: 'Rating summary and visible reviews for an entry' } }, async (request, reply) => {
    const item = findItem(request);
    const moderator = roleAtLeast(request.user?.role, 'editor');
    if (!item || (!item.published && !moderator)) return reply.code(404).send({ error: 'Item not found' });
    const q = request.query || {};
    return {
      summary: ratingSummary(item.id),
      reviews: listForItem(item.id, { limit: q.limit, offset: q.offset, viewerId: request.user?.id ?? null, moderator }),
      mine: request.user ? getOwn(item.id, request.user.id) : null,
    };
  });

  fastify.put('/items/:slug/reviews/mine', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: { ...tags, summary: 'Create or replace my review (rating 1-5, optional comment)' },
  }, async (request, reply) => {
    const item = findItem(request);
    if (!item || !item.published) return reply.code(404).send({ error: 'Item not found' });
    try {
      const { rating, comment } = request.body || {};
      const { review, created } = upsertReview(request.user, item.id, { rating, comment });
      return reply.code(created ? 201 : 200).send({ review, summary: ratingSummary(item.id) });
    } catch (e) { return sendError(reply, e); }
  });

  fastify.delete('/items/:slug/reviews/mine', { preHandler: [authenticate], schema: { ...tags, summary: 'Withdraw my review' } }, async (request, reply) => {
    const item = findItem(request);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    const mine = getOwn(item.id, request.user.id);
    if (!mine || !deleteReview(mine.id, { userId: request.user.id })) return reply.code(404).send({ error: 'No review to remove' });
    return { success: true, summary: ratingSummary(item.id) };
  });

  // ---- moderation --------------------------------------------------------
  fastify.get('/admin/reviews', { preHandler: [authenticate, requireEditor], schema: { ...tags, summary: 'Moderation queue' } }, async (request) => {
    const q = request.query || {};
    return listAll({ status: q.status && ['visible', 'pending', 'hidden'].includes(q.status) ? q.status : null, limit: q.limit, offset: q.offset });
  });

  fastify.patch('/admin/reviews/:id', { preHandler: [authenticate, requireEditor], schema: { ...tags, summary: 'Approve / hide a review' } }, async (request, reply) => {
    try {
      const review = setReviewStatus(parseInt(request.params.id, 10), request.body?.status);
      if (!review) return reply.code(404).send({ error: 'Review not found' });
      return { review };
    } catch (e) { return sendError(reply, e); }
  });

  fastify.delete('/admin/reviews/:id', { preHandler: [authenticate, requireEditor], schema: { ...tags, summary: 'Delete a review' } }, async (request, reply) => {
    if (!deleteReview(parseInt(request.params.id, 10))) return reply.code(404).send({ error: 'Review not found' });
    return { success: true };
  });
}
