import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getSettings, getSettingsMeta, updateSettings } from '../services/settingsService.js';

export async function settingsRoutes(fastify) {
  /**
   * GET /api/settings - public site configuration.
   * Admin-only keys (public = 0) are stripped.
   */
  fastify.get('/settings', async () => {
    const settings = getSettings({ publicOnly: true });
    return { settings, meta: getSettingsMeta({ publicOnly: true }) };
  });

  /** GET /api/admin/settings - every setting plus metadata for the form. */
  fastify.get('/admin/settings', { preHandler: [authenticate, requireAdmin] }, async () => {
    return {
      settings: getSettings(),
      meta: getSettingsMeta(),
    };
  });

  /**
   * PUT /api/admin/settings - bulk update.
   * body: { settings: { key: value, ... } }  (or a flat key/value object)
   */
  fastify.put('/admin/settings', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const patch = request.body?.settings && typeof request.body.settings === 'object'
      ? request.body.settings
      : request.body;

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return reply.code(400).send({ error: 'Expected an object of settings to update' });
    }
    if (!Object.keys(patch).length) {
      return reply.code(400).send({ error: 'No settings supplied' });
    }

    try {
      const written = updateSettings(patch);
      return { success: true, updated: written, settings: getSettings() };
    } catch (e) {
      if (e.statusCode === 400) {
        return reply.code(400).send({ error: e.message, unknownKeys: e.unknownKeys });
      }
      request.log.error(e);
      return reply.code(500).send({ error: 'Failed to save settings' });
    }
  });

  /** POST /api/admin/settings/reset/:key - restore a setting to its default. */
  fastify.post('/admin/settings/reset/:key', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { DEFAULT_SETTINGS } = await import('../db/schema.js');
    const def = DEFAULT_SETTINGS.find(s => s.key === request.params.key);
    if (!def) return reply.code(404).send({ error: 'Unknown setting key' });

    try {
      const written = updateSettings({ [def.key]: def.value }, { allowUnknownKeys: true });
      return { success: true, updated: written };
    } catch (e) {
      request.log.error(e);
      return reply.code(500).send({ error: 'Failed to reset setting' });
    }
  });
}
