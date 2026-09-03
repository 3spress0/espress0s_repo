import { getPublicProfile, listPublicFavorites } from '../services/favoritesService.js';

/**
 * Public account pages ("accounts viewing").
 *
 *   GET /api/users/:username                 anyone: profile + shared-favourite count
 *   GET /api/users/:username/favorites       anyone: the favourites they chose to share
 *
 * These are the only unauthenticated routes that talk about users, so they are
 * deliberately narrow:
 *
 *   - no email, ever (encrypted at rest, and a profile page must not be the
 *     way it escapes);
 *   - only favourites flagged `is_public` by their owner are listed;
 *   - only published items appear, so a shared favourite is never a back door
 *     into a draft;
 *   - card-shaped item rows only, so no mirror URL or storage path — encrypted
 *     or otherwise — leaves through here.
 *
 * Everything that manages accounts (roles, emails, deletion) stays under
 * /api/admin/users, which requires an admin session.
 */

function clampPage(value, fallback = 1) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 10000);
}

function clampLimit(value, fallback = 24) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 100);
}

export async function usersRoutes(fastify) {
  fastify.get('/users/:username', async (request, reply) => {
    const profile = getPublicProfile(request.params.username);
    if (!profile) return reply.code(404).send({ error: 'User not found' });
    return profile;
  });

  fastify.get('/users/:username/favorites', async (request, reply) => {
    const result = listPublicFavorites(request.params.username, {
      page: clampPage(request.query.page),
      limit: clampLimit(request.query.limit),
    });
    if (!result) return reply.code(404).send({ error: 'User not found' });
    return result;
  });
}
