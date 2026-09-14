import { publicMaintenanceNotice } from '../services/maintenanceService.js';

/**
 * A deliberately narrow public maintenance signal. The full host schedule and
 * timer state are admin-only; visitors get a warning only shortly before a
 * scheduled reboot so they can finish an upload or edit.
 */
export async function maintenanceRoutes(fastify) {
  fastify.get('/maintenance/notice', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return publicMaintenanceNotice();
  });
}
