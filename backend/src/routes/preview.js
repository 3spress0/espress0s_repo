import { getDb } from '../db/index.js';
import { storageManager } from '../services/storage/index.js';
import { encryptionService, ENCRYPTED_ITEM_FIELDS } from '../services/encryptionService.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PREVIEW_MAX_SIZE = 50 * 1024 * 1024; // 50MB max for preview
const ALLOWED_PREVIEW_TYPES = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'webm', 'mp3', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'];
const PREVIEW_DIR = path.resolve('./data/previews');

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

  // GET /api/preview/:id - preview small media files - requires login
  fastify.get('/preview/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const itemRaw = db.prepare('SELECT * FROM items WHERE id = ? OR slug = ?').get(id, id);
    if (!itemRaw) {
      return reply.code(404).send({ error: 'Item not found' });
    }

    const item = decryptItem(itemRaw);

    if (!item.published) {
      return reply.code(403).send({ error: 'Item not published' });
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

      // Fetch file (only small files)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const response = await fetch(downloadUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'espress0-repo-preview/1.0'
        }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Failed to fetch from storage: ${response.status} ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > PREVIEW_MAX_SIZE) {
        return reply.code(400).send({ error: 'File too large for preview' });
      }

      // Stream to cache file and to response simultaneously
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > PREVIEW_MAX_SIZE) {
        return reply.code(400).send({ error: 'File too large for preview' });
      }

      // Save to cache
      fs.writeFileSync(cachedPath, buffer);

      // Cleanup old previews (keep last 20)
      try {
        const files = fs.readdirSync(PREVIEW_DIR)
          .map(f => ({ name: f, path: path.join(PREVIEW_DIR, f), mtime: fs.statSync(path.join(PREVIEW_DIR, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);
        
        if (files.length > 20) {
          for (let i = 20; i < files.length; i++) {
            fs.unlinkSync(files[i].path);
          }
        }
      } catch {}

      reply.header('Content-Type', getContentType(fileType));
      reply.header('Content-Length', buffer.length);
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('X-Preview-Cached', 'false');
      reply.header('X-Preview-Source', item.storage_provider);
      
      return reply.send(buffer);

    } catch (e) {
      if (e.name === 'AbortError') {
        return reply.code(504).send({ error: 'Preview timeout - storage provider too slow' });
      }
      return reply.code(500).send({ error: `Preview failed: ${e.message}` });
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
      return reply.code(500).send({ error: e.message });
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
