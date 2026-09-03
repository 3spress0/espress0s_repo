import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  setFavoriteVisibility,
  findItem,
  itemIsFavoriteable,
  countFavorites,
} from '../services/favoritesService.js';

/**
 * Personal favourites.
 *
 *   GET    /api/favorites          your own list (private + shared)
 *   POST   /api/favorites          star a file      { item_id | slug, is_public? }
 *   PATCH  /api/favorites/:itemId  share / unshare  { is_public }
 *   DELETE /api/favorites/:itemId  unstar
 *
 * Every route requires a session: a favourite belongs to someone. The public,
 * session-free view of someone's list lives in routes/users.js and only ever
 * returns rows whose `is_public` flag the owner set themselves.
 *
 * The profile-level "new favourites start public" switch is not here — it is a
 * user field, so it rides on GET/PUT /auth/profile alongside theme and bio.
 */

const asBoolean = z.preprocess(
  (v) => (typeof v === 'string'
    ? (['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) ? true
      : (['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase()) ? false : v))
    : v),
  z.boolean()
);

const createSchema = z.object({
  item_id: z.union([z.number().int().positive(), z.string().min(1).max(200)]).optional(),
  slug: z.string().min(1).max(200).optional(),
  // Omitted = use the user's stored profile default. Explicit = override it.
  is_public: asBoolean.optional(),
}).refine(data => data.item_id !== undefined || data.slug !== undefined, {
  message: 'item_id or slug is required',
});

const visibilitySchema = z.object({ is_public: asBoolean });

const itemRefSchema = z.union([z.number().int().positive(), z.string().min(1).max(200)]);

/** Reject an obviously malformed reference before it reaches SQL. */
function parseItemRef(value) {
  const parsed = itemRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function favoritesRoutes(fastify) {
  fastify.get('/favorites', { preHandler: [authenticate] }, async (request) => {
    const { page = 1, limit = 24 } = request.query;
    // An admin can favourite a draft, so their own list may contain one;
    // everyone else's list is restricted to published items, because listing
    // a draft here would be a way to read a file that is not public.
    const includeUnpublished = request.user.role === 'admin';

    return {
      ...listFavorites(request.user.id, { page, limit, includeUnpublished }),
      counts: {
        total: countFavorites(request.user.id),
        public: countFavorites(request.user.id, { publicOnly: true }),
      },
    };
  });

  fastify.post('/favorites', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 240, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    const itemRef = parseItemRef(parsed.data.item_id ?? parsed.data.slug);
    if (itemRef === null) return reply.code(400).send({ error: 'Invalid item reference' });

    const item = findItem(itemRef);
    // 404, not 403: answering at all would confirm that a hidden slug exists.
    if (!itemIsFavoriteable(item, request.user)) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    const result = addFavorite(request.user.id, itemRef, { isPublic: parsed.data.is_public });
    if (!result) return reply.code(404).send({ error: 'Item not found' });

    return reply.code(result.created ? 201 : 200).send({
      favorite: {
        item_id: result.item.id,
        is_public: Boolean(result.favorite.is_public),
        created_at: result.favorite.created_at,
      },
      item: { id: result.item.id, slug: result.item.slug, name: result.item.name },
      created: result.created,
      is_favorite: true,
    });
  });

  fastify.patch('/favorites/:itemId', { preHandler: [authenticate] }, async (request, reply) => {
    const itemRef = parseItemRef(request.params.itemId);
    if (itemRef === null) return reply.code(400).send({ error: 'Invalid item reference' });

    const parsed = visibilitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.errors });

    // Unstarred files have no visibility to set, so there is nothing to patch.
    const updated = setFavoriteVisibility(request.user.id, itemRef, parsed.data.is_public);
    if (!updated) return reply.code(404).send({ error: 'Not favourited' });

    return {
      favorite: { item_id: updated.item.id, is_public: Boolean(updated.favorite.is_public) },
      item: { id: updated.item.id, slug: updated.item.slug, name: updated.item.name },
    };
  });

  fastify.delete('/favorites/:itemId', { preHandler: [authenticate] }, async (request, reply) => {
    const itemRef = parseItemRef(request.params.itemId);
    if (itemRef === null) return reply.code(400).send({ error: 'Invalid item reference' });

    const result = removeFavorite(request.user.id, itemRef);
    if (!result) return reply.code(404).send({ error: 'Item not found' });

    return { success: true, removed: result.removed, is_favorite: false };
  });
}
