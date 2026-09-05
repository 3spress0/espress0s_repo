import { getDb } from '../db/index.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService, ENCRYPTED_ITEM_FIELDS } from '../services/encryptionService.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { safeFetchBuffer, UnsafeUrlError } from '../lib/safeFetch.js';

const PREVIEW_MAX_SIZE = 50 * 1024 * 1024; // 50MB max for preview
const ALLOWED_PREVIEW_TYPES = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'];
// Anchored to this file, not to process.cwd(): a service started from / (systemd)
// used to silently write its cache into the filesystem root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_DIR = process.env.PREVIEW_DIR
  ? path.resolve(process.env.PREVIEW_DIR)
  : path.resolve(__dirname, '../../../data/previews');

/**
 * Headers for bytes we fetched from a third party and echo back. The content
 * is never trusted: no sniffing, no scripting, no framing.
 */
function applyPreviewSecurityHeaders(reply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
}

function decryptItem(item) {
  if (!item) return item;
  const decrypted = { ...item };
  for (const field of ENCRYPTED_ITEM_FIELDS) {
    if (decrypted[field]) {
      try {
        decrypted[field] = encryptionService.decrypt(decrypted[field]);
      } catch {}
    }
  }
  return decrypted;
}

export async function previewRoutes(fastify) {
  if (!fs.existsSync(PREVIEW_DIR)) {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  }

  // Preview requires login (same as download)
  const { authenticate } = await import('../middleware/auth.js');

  const isAdmin = (request) => request.user?.role === 'admin';

  // GET /api/preview/:id - preview small media files - requires login
  fastify.get('/preview/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const itemRaw = db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!itemRaw) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    const item = decryptItem(itemRaw);

    if (!item.published && !isAdmin(request)) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    // Check if preview allowed
    const fileType = (item.file_type || '').toLowerCase();
    if (!ALLOWED_PREVIEW_TYPES.includes(fileType)) {
      return reply.code(400).send({ 
        error: 'Preview not available for this file type',
        allowedTypes: ALLOWED_PREVIEW_TYPES,
        fileType: fileType
      });
    }

    // Check size
    if (item.file_size && item.file_size > PREVIEW_MAX_SIZE) {
      return reply.code(400).send({ 
        error: `File too large for preview (max ${PREVIEW_MAX_SIZE / 1024 / 1024}MB)`,
        fileSize: item.file_size,
        maxSize: PREVIEW_MAX_SIZE
      });
    }

    // Check if we have cached preview
    const cacheKey = crypto.createHash('sha256').update(`${item.id}-${item.updated_at || item.created_at}`).digest('hex');
    const cachedPath = path.join(PREVIEW_DIR, `${cacheKey}.${fileType}`);
    
    if (fs.existsSync(cachedPath)) {
      const stat = fs.statSync(cachedPath);
      applyPreviewSecurityHeaders(reply);
      reply.header('Content-Type', getContentType(fileType));
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('X-Preview-Cached', 'true');
      reply.header('X-Preview-Source', item.storage_provider);
      const stream = fs.createReadStream(cachedPath);
      return reply.send(stream);
    }

    // Download from external storage
    try {
      const downloadUrl = await storageManager.getDownloadUrl(item.storage_provider, item.storage_path, item);
      
      if (downloadUrl.startsWith('/api/files/')) {
        return reply.code(400).send({ error: 'Local file preview not configured' });
      }

      // SSRF guard: the URL comes from the database, so it is attacker-
      // influenced input as far as this process is concerned. safeFetchBuffer
      // refuses non-public targets, re-checks every redirect hop and caps the
      // number of bytes we are willing to buffer.
      const { buffer } = await safeFetchBuffer(downloadUrl, {
        maxBytes: PREVIEW_MAX_SIZE,
        timeoutMs: 30000,
        headers: { 'User-Agent': 'espress0-repo-preview/1.0' },
      });

      // Save to cache. Network bytes, so the destination is ours to control:
      // the name is a hash of the item id and its updated_at, the extension
      // came from the allowlist above, and the write goes to a private
      // temporary file that is then renamed into place. Two requests racing on
      // the same item each get their own temp file, and a reader either sees
      // the previous cached preview or the complete new one - never a partial
      // write, and never a file someone else planted at the final path.
      //
      // Best effort: a cache we cannot write must not cost the user their
      // preview, we already have the bytes.
      try {
        const tmpPath = path.join(
          PREVIEW_DIR,
          `.${cacheKey}.${crypto.randomBytes(8).toString('hex')}.tmp`
        );
        // Deliberately suppressed: caching fetched bytes is the feature, and
        // the controls are the ones around it. safeFetchBuffer refused any
        // non-public target and re-checked every redirect hop, the size is
        // capped, the name is our own hash plus random suffix, the file is
        // private, and the bytes are only ever served back behind login with
        // nosniff, a default-src 'none' CSP and X-Frame-Options: DENY.
        fs.writeFileSync(tmpPath, buffer, { mode: 0o600 }); // codeql[js/http-to-file-access]
        fs.renameSync(tmpPath, cachedPath);
      } catch (cacheErr) {
        request.log.warn({ itemId: item.id, err: cacheErr.message }, 'Preview cache write failed');
      }

      // Cleanup old previews (keep last 20)
      try {
        const files = fs.readdirSync(PREVIEW_DIR)
          .filter(f => !f.startsWith('.')) // leave in-flight .tmp writes alone
          .map(f => ({ name: f, path: path.join(PREVIEW_DIR, f), mtime: fs.statSync(path.join(PREVIEW_DIR, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);
        
        if (files.length > 20) {
          for (let i = 20; i < files.length; i++) {
            fs.unlinkSync(files[i].path);
          }
        }
      } catch {}

      applyPreviewSecurityHeaders(reply);
      reply.header('Content-Type', getContentType(fileType));
      reply.header('Content-Length', buffer.length);
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('X-Preview-Cached', 'false');
      reply.header('X-Preview-Source', item.storage_provider);
      
      return reply.send(buffer);

    } catch (e) {
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        return reply.code(504).send({ error: 'Preview timeout - storage provider too slow' });
      }
      if (e instanceof UnsafeUrlError) {
        request.log.warn({ itemId: item.id, err: e.message }, 'Blocked unsafe preview target');
        return reply.code(400).send({ error: 'This item\'s storage URL is not allowed for preview' });
      }
      if (e.statusCode === 413) return reply.code(400).send({ error: 'File too large for preview' });
      // Do not leak upstream error text (paths, hostnames) to the client.
      request.log.error({ itemId: item.id, err: e.message }, 'Preview failed');
      return reply.code(502).send({ error: 'Preview failed - storage provider unreachable' });
    }
  });

  // GET /api/preview/info/:id - get preview info without downloading - requires login
  fastify.get('/preview/info/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const itemRaw = db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!itemRaw) {
      return reply.code(404).send({ error: 'Item not found' });
    }
    if (!itemRaw.published && !isAdmin(request)) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    const item = decryptItem(itemRaw);
    const fileType = (item.file_type || '').toLowerCase();

    return {
      id: item.id,
      name: item.name,
      fileType,
      fileSize: item.file_size,
      canPreview: ALLOWED_PREVIEW_TYPES.includes(fileType) && (!item.file_size || item.file_size <= PREVIEW_MAX_SIZE),
      maxPreviewSize: PREVIEW_MAX_SIZE,
      allowedTypes: ALLOWED_PREVIEW_TYPES,
      storageProvider: item.storage_provider,
      reason: !ALLOWED_PREVIEW_TYPES.includes(fileType) ? 'File type not allowed for preview' :
              item.file_size > PREVIEW_MAX_SIZE ? 'File too large' : 'Preview available',
      previewUrl: `/api/preview/${item.id}`,
    };
  });

  // DELETE /api/preview/cache - clear preview cache (admin)
  fastify.delete('/preview/cache', { preHandler: [(await import('../middleware/auth.js')).authenticate, (await import('../middleware/auth.js')).requireAdmin] }, async (request, reply) => {
    try {
      if (fs.existsSync(PREVIEW_DIR)) {
        const files = fs.readdirSync(PREVIEW_DIR);
        for (const f of files) {
          fs.unlinkSync(path.join(PREVIEW_DIR, f));
        }
      }
      return { success: true, message: 'Preview cache cleared' };
    } catch (e) {
      request.log.error({ err: e }, 'Failed to clear preview cache');
      return reply.code(500).send({ error: 'Failed to clear preview cache' });
    }
  });
}

function getContentType(fileType) {
  const map = {
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'ogg': 'audio/ogg',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'pdf': 'application/pdf',
  };
  return map[fileType.toLowerCase()] || 'application/octet-stream';
}
