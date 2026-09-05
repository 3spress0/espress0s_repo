import { authenticate, requireAdmin } from '../middleware/auth.js';
import { importJobService, ImportJobValidationError, SOURCE_TYPES } from '../services/importJobService.js';
import { IMPORT_MODES } from '../services/catalogService.js';
import { UnsafeUrlError } from '../lib/safeFetch.js';

/** Admin-only: scheduled imports. */
export async function importJobRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

  const handle = (reply, e) => {
    if (e instanceof ImportJobValidationError) return reply.code(400).send({ error: e.message });
    if (e instanceof UnsafeUrlError) return reply.code(400).send({ error: `Refused URL: ${e.message}` });
    throw e;
  };
  const idOf = (request) => { const n = parseInt(request.params.id, 10); return Number.isInteger(n) && n > 0 ? n : null; };

  fastify.get('/admin/import-jobs', async () => ({ jobs: importJobService.list(), source_types: SOURCE_TYPES, modes: IMPORT_MODES }));

  fastify.post('/admin/import-jobs', async (request, reply) => {
    try { return reply.code(201).send({ job: importJobService.create(request.body || {}, { userId: request.user.id }) }); }
    catch (e) { return handle(reply, e); }
  });

  fastify.get('/admin/import-jobs/:id', async (request, reply) => {
    const job = idOf(request) && importJobService.get(idOf(request));
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return { job };
  });

  fastify.put('/admin/import-jobs/:id', async (request, reply) => {
    try {
      const job = idOf(request) && importJobService.update(idOf(request), request.body || {});
      if (!job) return reply.code(404).send({ error: 'Job not found' });
      return { job };
    } catch (e) { return handle(reply, e); }
  });

  fastify.delete('/admin/import-jobs/:id', async (request, reply) => {
    if (!idOf(request) || !importJobService.remove(idOf(request))) return reply.code(404).send({ error: 'Job not found' });
    return { success: true };
  });

  /** Run now. `?apply=0` previews through the pipeline's dry run. */
  fastify.post('/admin/import-jobs/:id/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const id = idOf(request);
    if (!id) return reply.code(404).send({ error: 'Job not found' });
    const apply = !(request.query?.apply === '0' || request.query?.apply === 'false');
    const result = await importJobService.run(id, { apply, userId: request.user.id, manual: true });
    if (!result) return reply.code(404).send({ error: 'Job not found' });
    if (result.error) return reply.code(502).send(result);
    return result;
  });
}
