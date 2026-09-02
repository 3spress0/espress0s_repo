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

export const itemSchema = z.object({
  name: z.string().min(2).max(200),
  slug: z.string().min(2).max(200).optional(),
  description: z.string().min(5).max(500),
  long_description: z.string().max(5000).optional().nullable(),
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
  image_url: imageUrlSchema,
  screenshots: z.string().or(z.array(imageUrlSchema)).optional().nullable(),
  documentation_url: httpUrl.or(z.literal('')).optional().nullable(),
  changelog: z.string().max(5000).optional().nullable(),
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
  email: z.string().email().max(100),
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

export const aiQuerySchema = z.object({
  q: z.string().min(2).max(500).optional(),
  question: z.string().min(2).max(500).optional(),
});
