import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';
import { authenticate, requireAdmin, requireEditor } from '../middleware/auth.js';
import { getSetting } from '../services/settingsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(__dirname, '../../../data/uploads');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// Real image types, matched on file signature rather than the client's claim.
const IMAGE_SIGNATURES = [
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], tail: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: 'image/svg+xml', ext: 'svg', textPrefixes: ['<?xml', '<svg'] },
];

function detectImageType(buffer) {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.textPrefixes) {
      const head = buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trim().toLowerCase();
      if (sig.textPrefixes.some(p => head.startsWith(p))) return sig;
      continue;
    }
    const magicOk = sig.magic.every((b, i) => buffer[i] === b);
    if (!magicOk) continue;
    if (sig.tail) {
      const { offset, bytes } = sig.tail;
      if (!bytes.every((b, i) => buffer[offset + i] === b)) continue;
    }
    return sig;
  }
  return null;
}

/**
 * SVG is a document format: it can carry <script>, event handlers and
 * external references, and it is served from our own origin. Even with the
 * hardened response headers below we refuse the obviously active constructs
 * rather than betting everything on one control.
 */
const SVG_FORBIDDEN = [
  /<\s*script/i,
  /<\s*foreignobject/i,
  /<\s*iframe/i,
  /<\s*embed/i,
  /<\s*object/i,
  /<\s*use[^>]+href\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /\son\w+\s*=/i,          // onload=, onclick=, ...
  /javascript\s*:/i,
  /<!ENTITY/i,               // XXE / billion laughs
  /<\s*set[^>]+attributeName/i,
];

function svgRejectionReason(buffer) {
  const text = buffer.toString('utf8');
  for (const pattern of SVG_FORBIDDEN) {
    if (pattern.test(text)) return `SVG contains disallowed markup (${pattern.source})`;
  }
  return null;
}

/**
 * Uploaded bytes are served from the app's own origin, so a stored file must
 * never be able to run as a document. `sandbox` + a null default-src makes an
 * SVG or HTML-ish payload inert even when opened directly, and `nosniff`
 * keeps the browser on the declared type.
 */
function applyUploadSecurityHeaders(reply, mimeType) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox");
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  if (mimeType === 'image/svg+xml') {
    // Renders fine in <img>; a direct hit downloads instead of executing.
    reply.header('Content-Disposition', 'attachment');
  }
}

function safeBaseName(name) {
  return path.basename(String(name || ''))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 60) || 'upload';
}

export async function uploadsRoutes(fastify) {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  /**
   * GET /api/uploads/:storedName - serve an uploaded file.
   * Public, because item cover images are shown to anonymous visitors.
   * `storedName` is our own generated slug, never user path input.
   */
  fastify.get('/uploads/:storedName', async (request, reply) => {
    const { storedName } = request.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(storedName) || storedName.includes('..')) {
      return reply.code(400).send({ error: 'Invalid file name' });
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM uploads WHERE stored_name = ?').get(storedName);
    if (!row) return reply.code(404).send({ error: 'File not found' });

    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    // Defence in depth: the resolved path must stay inside UPLOAD_DIR.
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      return reply.code(400).send({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'File missing from disk' });

    applyUploadSecurityHeaders(reply, row.mime_type);
    reply.header('Content-Type', row.mime_type);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(filePath));
  });

  /** GET /api/admin/uploads - list uploads for the media picker. */
  fastify.get('/admin/uploads', { preHandler: [authenticate, requireEditor] }, async (request) => {
    const db = getDb();
    const kind = request.query?.kind;
    const rows = kind
      ? db.prepare('SELECT * FROM uploads WHERE kind = ? ORDER BY created_at DESC LIMIT 200').all(kind)
      : db.prepare('SELECT * FROM uploads ORDER BY created_at DESC LIMIT 200').all();

    return {
      uploads: rows.map(r => ({
        id: r.id,
        original_name: r.original_name,
        stored_name: r.stored_name,
        url: `/api/uploads/${r.stored_name}`,
        mime_type: r.mime_type,
        size: r.size,
        kind: r.kind,
        created_at: r.created_at,
      })),
    };
  });

  /**
   * POST /api/admin/uploads - upload an image.
   * multipart/form-data field `file`, or JSON { dataUrl }.
   */
  fastify.post('/admin/uploads', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const maxBytes = getSetting('uploads_max_bytes', DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES;

    let buffer = null;
    // Assigned by both branches below; no default to overwrite.
    let originalName;

    if (request.isMultipart?.()) {
      const file = await request.file({ limits: { fileSize: maxBytes } });
      if (!file) return reply.code(400).send({ error: 'No file uploaded (expected field "file")' });
      buffer = await file.toBuffer();
      originalName = file.filename || 'upload';
      if (file.truncated) {
        return reply.code(413).send({ error: `File too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)` });
      }
    } else {
      const dataUrl = request.body?.dataUrl;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return reply.code(400).send({ error: 'Send multipart/form-data with a "file" field, or JSON { dataUrl }' });
      }
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return reply.code(400).send({ error: 'Malformed data URL' });
      const meta = dataUrl.slice(5, comma);
      const payload = dataUrl.slice(comma + 1);
      buffer = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      originalName = request.body?.filename || 'upload';
    }

    if (!buffer || !buffer.length) return reply.code(400).send({ error: 'Empty file' });
    if (buffer.length > maxBytes) {
      return reply.code(413).send({ error: `File too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)` });
    }

    const detected = detectImageType(buffer);
    if (!detected) {
      return reply.code(415).send({
        error: 'Unsupported file type. Allowed: PNG, JPEG, GIF, WebP, SVG.',
      });
    }

    if (detected.mime === 'image/svg+xml') {
      const reason = svgRejectionReason(buffer);
      if (reason) return reply.code(422).send({ error: reason });
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const storedName = `${Date.now().toString(36)}-${hash}.${detected.ext}`;

    // The bytes came off the network, so the only thing we get to choose is
    // where they land - and that name is generated here (timestamp + content
    // hash + an extension from the fixed signature table), never taken from
    // the upload. Resolve it and refuse anything outside UPLOAD_DIR, the same
    // way the DELETE below guards before it unlinks.
    const target = path.resolve(UPLOAD_DIR, storedName);
    if (!target.startsWith(UPLOAD_DIR + path.sep)) {
      return reply.code(500).send({ error: 'Refusing to store this upload' });
    }
    // Deliberately suppressed: storing an upload is the feature. The buffer is
    // sniffed against a fixed signature table (not the client's claim), SVG is
    // scanned for script, event handlers and entities, the size is capped by
    // the multipart limit and by the check above, the caller is an
    // authenticated editor, and the name is ours.
    fs.writeFileSync(target, buffer); // codeql[js/http-to-file-access]

    const db = getDb();
    const info = db.prepare(`
      INSERT INTO uploads (original_name, stored_name, mime_type, size, kind, uploaded_by)
      VALUES (?, ?, ?, ?, 'image', ?)
    `).run(safeBaseName(originalName), storedName, detected.mime, buffer.length, request.user?.id ?? null);

    return reply.code(201).send({
      success: true,
      upload: {
        id: info.lastInsertRowid,
        original_name: safeBaseName(originalName),
        stored_name: storedName,
        url: `/api/uploads/${storedName}`,
        mime_type: detected.mime,
        size: buffer.length,
        kind: 'image',
      },
    });
  });

  /** DELETE /api/admin/uploads/:id */
  fastify.delete('/admin/uploads/:id', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(request.params.id);
    if (!row) return reply.code(404).send({ error: 'Upload not found' });

    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    if (filePath.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    return { success: true, message: 'Upload deleted' };
  });
}
