import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  CATALOG_FILENAME, IMPORT_MODES, MAX_INLINE_ERRORS,
  importCatalogArchive, buildCatalogZip, buildTemplateZip,
  listImports, getImport, CatalogError,
} from '../services/catalogService.js';
import { toCatalogArchive, csvTemplate } from '../services/bulkFormats.js';
import { ZipError } from '../lib/zip.js';

/**
 * Bulk catalogue endpoints.
 *
 * All admin-only. Import is a two-step conversation: upload the archive for a
 * preview, then re-upload with `?apply=1` once the numbers look right. Keeping
 * the dry run and the apply on the same endpoint (as `routes/backup.js` does)
 * means the preview cannot drift from what actually gets written.
 */

/** 32 MB: a 20 000-item catalogue with long Markdown bodies stays well inside. */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function catalogRoutes(fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

  // GET /api/admin/catalog/template.csv - starter spreadsheet for bulk import
  fastify.get('/admin/catalog/template.csv', async (request, reply) => reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', 'attachment; filename="catalog-template.csv"')
    .send(csvTemplate()));

  // GET /api/admin/catalog/template - a starter archive to edit
  fastify.get('/admin/catalog/template', async (request, reply) => {
    const buffer = buildTemplateZip();
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="catalog-template.zip"')
      .send(buffer);
  });

  // GET /api/admin/catalog/export - the current catalogue, re-importable
  fastify.get('/admin/catalog/export', async (request, reply) => {
    const { buffer, warnings } = buildCatalogZip();
    if (warnings.length) request.log.info({ warnings }, 'Catalogue export warnings');
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="catalog-${date}.zip"`)
      .header('X-Catalog-Warnings', encodeURIComponent(warnings.join(' | ')).slice(0, 2000))
      .send(buffer);
  });

  // POST /api/admin/catalog/import - preview, or apply with ?apply=1
  fastify.post('/admin/catalog/import', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const apply = request.query.apply === '1' || request.query.apply === 'true';
    const mode = String(request.query.mode || 'upsert');
    if (!IMPORT_MODES.includes(mode)) {
      return reply.code(400).send({ error: `Unknown mode "${mode}"`, modes: IMPORT_MODES });
    }

    let buffer;
    let filename = 'catalog.zip';
    try {
      const file = await request.file({ limits: { fileSize: MAX_ARCHIVE_BYTES } });
      if (!file) return reply.code(400).send({ error: 'No file uploaded - send the catalogue archive as multipart form data' });
      filename = file.filename || filename;
      buffer = await file.toBuffer();
      // toBuffer() truncates silently at the limit unless this is checked.
      if (file.truncated) {
        return reply.code(413).send({
          error: `Archive is larger than the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB limit`,
        });
      }
    } catch (e) {
      if (e.code === 'FST_FILES_LIMIT' || e.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: `Archive is larger than the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB limit` });
      }
      request.log.error(e, 'Catalogue upload failed');
      return reply.code(400).send({ error: `Could not read the upload: ${e.message}` });
    }

    if (!buffer || !buffer.length) return reply.code(400).send({ error: 'Uploaded file is empty' });

    // .json and .csv are converted to the archive shape here, so everything
    // below (validation, modes, duplicates, snapshot, history) is shared.
    let converted = null;
    try {
      ({ buffer, filename, converted } = toCatalogArchive(buffer, filename));
    } catch (e) {
      if (e instanceof CatalogError) return reply.code(400).send({ error: e.message, code: e.code });
      throw e;
    }

    try {
      const { report, history } = await importCatalogArchive({
        buffer,
        filename,
        mode,
        apply,
        userId: request.user?.id ?? null,
      });

      const inline = report.errors.slice(0, MAX_INLINE_ERRORS);
      return reply.code(apply ? 200 : 200).send({
        success: true,
        dryRun: report.dryRun,
        mode: report.mode,
        importId: history.id,
        backupPath: history.backup_path || null,
        warnings: report.warnings || [],
        converted,
        categories: report.categories,
        folders: report.folders,
        items: report.items,
        relations: report.relations,
        errorCount: report.errorCount,
        errors: inline,
        duplicateCount: report.duplicateCount || 0,
        duplicates: (report.duplicates || []).slice(0, MAX_INLINE_ERRORS),
        duplicatesTruncated: (report.duplicateCount || 0) > Math.min(report.duplicates?.length || 0, MAX_INLINE_ERRORS),
        errorsTruncated: report.errorCount > inline.length,
        errorsUrl: report.errorCount
          ? `/api/admin/catalog/imports/${history.id}/errors`
          : null,
        hint: report.dryRun
          ? 'Nothing was written. Re-send with ?apply=1 to import.'
          : 'Import applied inside one transaction; a database snapshot was taken first.',
      });
    } catch (e) {
      if (e instanceof CatalogError || e instanceof ZipError) {
        return reply.code(400).send({
          error: e.message,
          code: e.code,
          details: e.details || null,
          importId: e.history?.id ?? null,
          errorsUrl: e.history?.id ? `/api/admin/catalog/imports/${e.history.id}/errors` : null,
        });
      }
      request.log.error(e, 'Catalogue import failed');
      return reply.code(500).send({ error: `Import failed, nothing was written: ${e.message}` });
    }
  });

  // GET /api/admin/catalog/imports - history
  fastify.get('/admin/catalog/imports', async (request) => {
    return { imports: listImports(request.query.limit) };
  });

  // GET /api/admin/catalog/imports/:id - one import with its errors
  fastify.get('/admin/catalog/imports/:id', async (request, reply) => {
    const record = getImport(request.params.id);
    if (!record) return reply.code(404).send({ error: 'No such import' });
    return record;
  });

  // GET /api/admin/catalog/imports/:id/errors - downloadable validation errors
  fastify.get('/admin/catalog/imports/:id/errors', async (request, reply) => {
    const record = getImport(request.params.id);
    if (!record) return reply.code(404).send({ error: 'No such import' });

    const format = String(request.query.format || 'json').toLowerCase();
    const base = `catalog-import-${record.id}-errors`;

    if (format === 'csv') {
      const rows = [['row', 'slug', 'field', 'error']];
      record.errors.forEach((e, i) => rows.push([i + 1, e.slug, e.field, e.error]));
      const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${base}.csv"`)
        .send(csv);
    }

    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${base}.json"`)
      .send({
        importId: record.id,
        filename: record.filename,
        mode: record.mode,
        status: record.status,
        dryRun: !!record.dry_run,
        errorCount: record.error_count,
        errors: record.errors,
      });
  });
}

export { CATALOG_FILENAME };
