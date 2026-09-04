import { z } from 'zod';

/**
 * A URL field that also accepts paths to files uploaded through this app
 * (e.g. `/api/uploads/abc123.png`). `z.string().url()` rejects relative paths,
 * which would make admin-uploaded cover images impossible to save.
 */
/**
 * Accepts http(s) URLs only. `z.string().url()` happily accepts
 * `javascript:alert(1)`, which is an XSS vector for anything rendered into an
 * href or src, so the scheme is checked explicitly.
 */
const httpUrl = z.string().refine((v) => {
  try {
    const p = new URL(v).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}, { message: 'Must be an http(s) URL' });

const internalUploadPath = z.string().regex(/^\/api\/uploads\/[A-Za-z0-9._-]+$/, 'Not a valid upload path');
const appRelativePath = z.string().regex(/^\/[A-Za-z0-9._~/-]*$/, 'Not a valid local path');

export const imageUrlSchema = httpUrl.or(internalUploadPath).or(z.literal('')).optional().nullable();

/**
 * Stricter variant for catalogue imports: a plain http(s) URL and nothing else.
 *
 * Catalogue entries must not point at `/api/uploads/...` or any other local
 * path, because the archive is meant to be portable between installs and the
 * VM has no room for image files. `imageUrlSchema` above still allows upload
 * paths for the admin image picker, which is a different feature.
 */
export const externalImageUrlSchema = httpUrl.or(z.literal('')).optional().nullable();

/** True when a value is an http(s) URL; used to filter exports. */
export function isExternalUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const p = new URL(value).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export const REQUIREMENT_TYPES = ['os', 'runtime', 'hardware', 'dependency', 'other'];

/**
 * One dependency / system requirement line. Kept structured (not free text)
 * so the detail page can group them and other tools can read them, e.g.
 * { type: 'runtime', name: '.NET Framework', version: '>= 4.8' }.
 */
export const requirementSchema = z.object({
  type: z.enum(REQUIREMENT_TYPES).default('other'),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().max(60).optional().nullable(),
  optional: z.boolean().optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

/** Array of requirements; also accepts the JSON-encoded string the DB stores. */
export const requirementsSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}, z.array(requirementSchema).max(100).nullable());

export const itemSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z.string().min(2).max(200).optional(),
  // 1000, not 500: the column is TEXT and seeded rows already exceed 500,
  // which made catalogue exports un-importable.
  description: z.string().min(5).max(1000),
  // Markdown body for the item page. Raised from 5000 to 200k so catalogue
  // imports can carry full documentation; the DB column was always TEXT.
  long_description: z.string().max(200000).optional().nullable(),
  category_id: z.number().int().positive().optional().nullable(),
  folder_id: z.number().int().positive().optional().nullable(),
  version: z.string().max(100).optional().nullable(),
  release_date: z.string().optional().nullable(),
  file_name: z.string().max(255).optional().nullable(),
  file_size: z.number().int().nonnegative().optional().nullable(),
  file_type: z.string().max(20).optional().nullable(),
  platform: z.string().max(50).optional().nullable(),
  architecture: z.string().max(50).optional().nullable(),
  sha256: z.string().max(128).optional().nullable(),
  md5: z.string().max(64).optional().nullable(),
  storage_provider: z.enum(['local', 'gdrive', 'onedrive', 'github', 'external']).default('external'),
  storage_path: z.string().max(1000).optional().nullable(),
  // httpUrl (not z.string().url()) so javascript:/data: URLs cannot be stored
  // and later handed to the browser as an href or a redirect target.
  download_url: httpUrl.or(appRelativePath).or(z.literal('')).optional().nullable(),
  external_url: httpUrl.or(z.literal('')).optional().nullable(),
  featured: z.boolean().or(z.number()).optional(),
  published: z.boolean().or(z.number()).optional(),
  license_status: z.enum(['public-domain', 'redistributable', 'proprietary', 'check-license', 'internal-only', 'abandonware']).default('check-license'),
  license_notes: z.string().max(1000).optional().nullable(),
  tags: z.string().or(z.array(z.string())).optional().nullable(),
  icon_url: imageUrlSchema,
  banner_url: imageUrlSchema,
  image_url: imageUrlSchema,
  status: z.enum(['current', 'legacy', 'deprecated', 'archived', 'unreleased']).optional().nullable(),
  screenshots: z.string().or(z.array(imageUrlSchema)).optional().nullable(),
  documentation_url: httpUrl.or(z.literal('')).optional().nullable(),
  changelog: z.string().max(5000).optional().nullable(),
  requirements: requirementsSchema.optional(),
});

export const categorySchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(10).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

// Folders are an admin-defined grouping that sits next to (not inside)
// categories: an item has one category for *what it is* and optionally one
// folder for *where the admin files it*.
export const folderSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(10).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  sort_order: z.number().int().optional(),
});

export const loginSchema = z.object({
  username: z.string().min(2).max(100),
  password: z.string().min(4).max(200),
  captchaId: z.string().nullable().optional(),
  captchaAnswer: z.string().nullable().optional(),
  captchaToken: z.string().nullable().optional(),
});

export const registerSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscore and hyphen'),
  // Email is optional: you can add one, but it is not required to register.
  // An empty string is treated the same as omitting it.
  email: z.string().email().max(100).optional().or(z.literal('')),
  password: z.string().min(8).max(128)
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  confirmPassword: z.string().min(8).max(128),
  captchaId: z.string().nullable().optional(),
  captchaAnswer: z.string().nullable().optional(),
  captchaToken: z.string().nullable().optional(),
}).refine(data => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export const downloadLinkSchema = z.object({
  // Row id of an existing mirror, when the client is updating one. Optional,
  // and only ever honoured if the row already belongs to the item being
  // written - see routes/items.js. Carrying it lets an update edit a mirror
  // in place instead of deleting every row and re-inserting them, which used
  // to reset each mirror's download counter and health-check results.
  id: z.number().int().positive().optional(),
  label: z.string().min(2).max(100),
  storage_provider: z.enum(['local', 'gdrive', 'onedrive', 'github', 'external']).default('external'),
  storage_path: z.string().max(1000).optional().nullable(),
  download_url: httpUrl.or(appRelativePath).or(z.literal('')).optional().nullable(),
  file_size: z.number().int().nonnegative().optional().nullable(),
  is_primary: z.boolean().or(z.number()).optional(),
  is_down: z.boolean().or(z.number()).optional(),
  down_reason: z.string().max(500).optional().nullable(),
  status: z.enum(['up', 'down', 'unknown', 'checking']).optional(),
  sort_order: z.number().int().optional(),
});

/**
 * One prior turn of a Barista conversation. Bounded on both ends: the role is
 * an enum so nothing can inject a fake "system" instruction, and the content is
 * capped so a client cannot push an unbounded prompt through the model.
 */
export const aiMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(2000),
});

export const aiQuerySchema = z.object({
  q: z.string().min(2).max(500).optional(),
  question: z.string().min(2).max(500).optional(),
  // Follow-ups such as "does that work on my pc?" only make sense with the
  // preceding turns; the route used to parse them and then throw them away.
  messages: z.array(aiMessageSchema).max(20).optional(),
});
