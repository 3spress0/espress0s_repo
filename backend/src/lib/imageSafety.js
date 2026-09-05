/**
 * Shared image-content checks: the same "what bytes are these really" logic
 * for files uploaded to our own storage (routes/uploads.js) and for images
 * fetched from third parties (routes/imageProxy.js). One list, one posture -
 * a fix here must not silently apply to only one of the two paths.
 */

// Real image types, matched on file signature rather than the client's claim.
export const IMAGE_SIGNATURES = [
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], tail: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: 'image/svg+xml', ext: 'svg', textPrefixes: ['<?xml', '<svg'] },
];

export function detectImageType(buffer) {
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
 * hardened response headers we refuse the obviously active constructs rather
 * than betting everything on one control.
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

export function svgRejectionReason(buffer) {
  const text = buffer.toString('utf8');
  for (const pattern of SVG_FORBIDDEN) {
    if (pattern.test(text)) return `SVG contains disallowed markup (${pattern.source})`;
  }
  return null;
}
