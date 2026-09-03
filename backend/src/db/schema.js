export const SCHEMA_SQL = `
-- Users table - with encrypted fields
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  -- Email is OPTIONAL: an account can register without one. Encrypted at rest
  -- with AES-256-GCM when present. UNIQUE still holds because SQLite treats
  -- every NULL as distinct, so any number of accounts may have no email.
  email TEXT UNIQUE, -- encrypted at rest with AES-256-GCM (nullable)
  email_hash TEXT UNIQUE, -- deterministic HMAC for lookup (nullable)
  password_hash TEXT NOT NULL, -- pepper + bcrypt
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'editor', 'viewer')),
  auth_version INTEGER DEFAULT 0, -- bump to invalidate every issued token ("log out all devices")
  avatar_url TEXT, -- encrypted
  bio TEXT, -- encrypted
  theme TEXT DEFAULT 'dark' CHECK(theme IN ('dark', 'light', 'auto')),
  -- Profile default for new favourites. 0 = private (the safe default), 1 =
  -- public. Individual favourites can still be flipped either way.
  favorites_default_public INTEGER NOT NULL DEFAULT 0,
  encryption_version TEXT DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Folders - free-form grouping of items, orthogonal to categories
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_folders_slug ON folders(slug);

-- Items (main repository entries) - sensitive fields encrypted
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  long_description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  version TEXT,
  release_date DATE,
  file_name TEXT,
  file_size INTEGER, -- bytes
  file_type TEXT, -- iso, exe, zip, pdf, etc
  platform TEXT, -- windows, linux, macos, cross-platform
  architecture TEXT, -- x86, x64, arm64, universal
  sha256 TEXT,
  md5 TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'local' CHECK(storage_provider IN ('local', 'gdrive', 'onedrive', 'github', 'external')),
  storage_path TEXT, -- encrypted: path or file ID in external storage
  download_url TEXT, -- encrypted: direct or constructed URL
  external_url TEXT, -- encrypted: original source URL if applicable
  featured INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1,
  license_status TEXT DEFAULT 'check-license' CHECK(license_status IN ('public-domain', 'redistributable', 'proprietary', 'check-license', 'internal-only', 'abandonware')),
  license_notes TEXT, -- encrypted
  tags TEXT, -- JSON array for simplicity, plus junction table
  icon_url TEXT,
  banner_url TEXT, -- external http(s) URL only; images are never stored locally
  image_url TEXT, -- cover image selected by admin, placeholder if none
  screenshots TEXT, -- JSON array of URLs
  documentation_url TEXT,
  changelog TEXT,
  -- Catalogue lifecycle. Orthogonal to the published flag: an item can be
  -- published and still be the deprecated release of a product line.
  status TEXT DEFAULT 'current' CHECK(status IN ('current', 'legacy', 'deprecated', 'archived', 'unreleased')),
  download_count INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  encryption_version TEXT DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Item-Tag junction
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

-- FAQ entries
CREATE TABLE IF NOT EXISTS faq_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  related_item_ids TEXT, -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Search index FTS5
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name,
  slug,
  description,
  long_description,
  version,
  file_name,
  file_type,
  platform,
  architecture,
  tags,
  content='items',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags)
  VALUES (new.id, new.name, new.slug, new.description, new.long_description, new.version, new.file_name, new.file_type, new.platform, new.architecture, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags)
  VALUES('delete', old.id, old.name, old.slug, old.description, old.long_description, old.version, old.file_name, old.file_type, old.platform, old.architecture, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags)
  VALUES('delete', old.id, old.name, old.slug, old.description, old.long_description, old.version, old.file_name, old.file_type, old.platform, old.architecture, old.tags);
  INSERT INTO items_fts(rowid, name, slug, description, long_description, version, file_name, file_type, platform, architecture, tags)
  VALUES (new.id, new.name, new.slug, new.description, new.long_description, new.version, new.file_name, new.file_type, new.platform, new.architecture, new.tags);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_items_slug ON items(slug);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_folder ON items(folder_id);
CREATE INDEX IF NOT EXISTS idx_items_featured ON items(featured);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published);
CREATE INDEX IF NOT EXISTS idx_items_platform ON items(platform);
CREATE INDEX IF NOT EXISTS idx_items_arch ON items(architecture);
CREATE INDEX IF NOT EXISTS idx_items_file_type ON items(file_type);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
-- Admin catalogue filters. platform / architecture / file_type / category_id /
-- folder_id / published were already indexed; these are the columns the admin
-- filter set added.
CREATE INDEX IF NOT EXISTS idx_items_version ON items(version);
CREATE INDEX IF NOT EXISTS idx_items_release_date ON items(release_date);
CREATE INDEX IF NOT EXISTS idx_items_storage_provider ON items(storage_provider);
-- The admin sort defaults to "recently updated"; without this it is a full scan
-- plus a sort on every page of results.
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);

-- Unlimited download links per item
CREATE TABLE IF NOT EXISTS item_download_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label TEXT NOT NULL, -- e.g., "Google Drive Mirror 1", "OneDrive EU", "Direct"
  storage_provider TEXT NOT NULL DEFAULT 'external' CHECK(storage_provider IN ('local', 'gdrive', 'onedrive', 'github', 'external')),
  storage_path TEXT, -- encrypted: file ID or path in external storage
  download_url TEXT, -- encrypted: direct URL
  file_size INTEGER, -- optional override per mirror
  is_primary INTEGER DEFAULT 0, -- primary mirror
  is_down INTEGER DEFAULT 0, -- marked as down by admin or checker
  down_reason TEXT, -- reason why down
  status TEXT DEFAULT 'up' CHECK(status IN ('up', 'down', 'unknown', 'checking')),
  last_checked DATETIME, -- last health check
  http_status INTEGER, -- last HTTP response code seen by the link checker
  check_error TEXT, -- last checker error/verdict message
  check_duration_ms INTEGER, -- how long the last probe took
  sort_order INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_download_links_item ON item_download_links(item_id);
CREATE INDEX IF NOT EXISTS idx_download_links_primary ON item_download_links(item_id, is_primary);
CREATE INDEX IF NOT EXISTS idx_download_links_down ON item_download_links(is_down);
-- (idx_items_status and idx_download_links_item_status index columns that are
-- added by ALTER on older databases, so they are created in the guarded
-- migration block in db/index.js rather than here.)

-- Item version history - a full decrypted snapshot after every create/edit,
-- so admins can inspect what changed and roll a page back.
CREATE TABLE IF NOT EXISTS item_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL, -- 1-based, per item
  snapshot TEXT NOT NULL, -- JSON: serialized item incl. download links
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  change_summary TEXT, -- e.g. "name, description" or "Restored from version 3"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, version_num)
);

CREATE INDEX IF NOT EXISTS idx_item_versions_item ON item_versions(item_id, version_num DESC);

-- Site-wide configuration. Everything the UI shows that isn't item data lives
-- here so admins can change copy/branding/links without a code deploy.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  type TEXT DEFAULT 'text' CHECK(type IN ('text', 'textarea', 'boolean', 'number', 'json', 'url', 'color')),
  group_name TEXT DEFAULT 'general',
  label TEXT,
  description TEXT,
  public INTEGER DEFAULT 1, -- 1 = exposed via GET /api/settings, 0 = admin only
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_settings_group ON site_settings(group_name);
CREATE INDEX IF NOT EXISTS idx_settings_public ON site_settings(public);

-- Files uploaded through the admin UI (item cover images, icons, logos).
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT DEFAULT 'image' CHECK(kind IN ('image', 'document', 'other')),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_uploads_kind ON uploads(kind);
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at DESC);

-- Explicit links between items, used by catalogue imports to say "these are
-- releases of the same thing" or "this one supersedes that one". The public
-- item page also derives a same-category related list, which stays as-is;
-- this table is the curated, admin-controlled version.
CREATE TABLE IF NOT EXISTS item_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  related_item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related' CHECK(relation IN ('related', 'supersedes', 'superseded-by', 'variant')),
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, related_item_id)
);

CREATE INDEX IF NOT EXISTS idx_item_relations_item ON item_relations(item_id);
CREATE INDEX IF NOT EXISTS idx_item_relations_related ON item_relations(related_item_id);

-- Personal favourites ("starred files"). One row per user+item.
--
-- is_public is opt-in: a favourite is private by default and only appears on
-- the owner's public profile once they flip it. Visibility lives on the row
-- rather than only on the profile so a user can share a single file without
-- publishing the whole list.
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at DESC);
-- Public profile listing: the favourites one user chose to share.
CREATE INDEX IF NOT EXISTS idx_favorites_public ON favorites(user_id, is_public);
-- "How many people starred this file" and the cascade when an item is deleted.
CREATE INDEX IF NOT EXISTS idx_favorites_item ON favorites(item_id);

-- One row per catalogue import, dry runs included, so an admin can see what
-- was loaded, when, by whom, and what was rejected. The full error list is
-- kept as JSON so it can be downloaded rather than truncated to a toast.
CREATE TABLE IF NOT EXISTS catalog_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL, -- of the uploaded archive, so re-uploads are traceable
  size_bytes INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'upsert' CHECK(mode IN ('upsert', 'add-only', 'update-only')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'failed', 'rejected')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  items_created INTEGER DEFAULT 0,
  items_updated INTEGER DEFAULT 0,
  items_unchanged INTEGER DEFAULT 0,
  items_skipped INTEGER DEFAULT 0,
  relations_created INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  errors_json TEXT, -- JSON array; downloadable via the history endpoint
  backup_path TEXT, -- database backup taken before applying, when one was made
  catalog_format TEXT,
  catalog_version INTEGER,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_catalog_imports_started ON catalog_imports(started_at DESC);
`;

// Sensible starting values. INSERT OR IGNORE means re-running migrations never
// clobbers an admin's edits.
export const DEFAULT_SETTINGS = [
  // general / branding
  { key: 'site_name', value: "espress0's repo", type: 'text', group_name: 'general', label: 'Site name', description: 'Shown in the navbar, footer and browser tab.', public: 1 },
  { key: 'site_tagline', value: 'Personal Archive • Est. 2026', type: 'text', group_name: 'general', label: 'Tagline', description: 'Small line under the site name in the footer.', public: 1 },
  { key: 'hero_title', value: "espress0's repo", type: 'text', group_name: 'homepage', label: 'Hero title', description: 'Large heading on the homepage.', public: 1 },
  { key: 'hero_subtitle', value: 'A curated personal archive of software, ISOs, tools and documentation. Everything verified, checksummed and stored off-VM.', type: 'textarea', group_name: 'homepage', label: 'Hero subtitle', description: 'Paragraph under the hero title.', public: 1 },
  { key: 'hero_search_placeholder', value: 'Search files...', type: 'text', group_name: 'homepage', label: 'Search placeholder', public: 1 },
  { key: 'hero_stat_encryption_label', value: 'AES-256', type: 'text', group_name: 'homepage', label: '"Encrypted" stat value', description: 'Third stat shown under the hero search box.', public: 1 },
  { key: 'footer_intro', value: 'A curated personal repository for software, ISOs, tools and documentation. Built for a low-resource VM with external storage: metadata is encrypted here, the files themselves live off-VM.', type: 'textarea', group_name: 'footer', label: 'Footer intro', description: 'Paragraph in the left-hand footer column.', public: 1 },
  { key: 'footer_copyright', value: '', type: 'text', group_name: 'footer', label: 'Copyright line', description: 'Leave blank to auto-generate "© <year> <site name>".', public: 1 },
  { key: 'footer_note', value: 'Storage: GDrive, OneDrive, External', type: 'text', group_name: 'footer', label: 'Footer note', description: 'Line at the bottom of the footer.', public: 1 },
  { key: 'footer_links', value: JSON.stringify([
    { label: 'Operating Systems', href: '/browse?category=operating-systems', group: 'Browse' },
    { label: 'ISOs', href: '/browse?category=isos', group: 'Browse' },
    { label: 'Applications', href: '/browse?category=applications', group: 'Browse' },
    { label: 'Development', href: '/browse?category=development', group: 'Browse' },
    { label: 'All Categories', href: '/browse', group: 'Browse' },
    { label: 'Ask AI (tgpt)', href: '/ask', group: 'System' },
    { label: 'API Health', href: '/api/health', group: 'System' },
    { label: 'tgpt Project', href: 'https://github.com/aandrew-me/tgpt', external: true, group: 'System' },
  ], null, 0), type: 'json', group_name: 'footer', label: 'Footer links', description: 'JSON array of { label, href, group, external }.', public: 1 },
  // behaviour toggles
  { key: 'allow_registration', value: 'true', type: 'boolean', group_name: 'auth', label: 'Allow public registration', description: 'Overrides the ALLOW_REGISTRATION env var when set.', public: 1 },
  { key: 'require_captcha', value: 'true', type: 'boolean', group_name: 'auth', label: 'Require CAPTCHA on login', public: 0 },
  { key: 'show_dev_credentials_panel', value: 'false', type: 'boolean', group_name: 'auth', label: 'Show test-credentials panel on login', description: 'Development aid. Leave off in production.', public: 1 },
  { key: 'ai_enabled', value: 'true', type: 'boolean', group_name: 'ai', label: 'Enable Ask AI', description: 'Turns the AI entry points on or off.', public: 1 },
  // Provider selection. Everything here overrides .env, except the key: an API
  // key in this table would be readable through /api/admin/settings and shipped
  // off in every DB backup, so AI_API_KEY stays in .env (see SETUP.md).
  { key: 'ai_provider', value: '', type: 'text', group_name: 'ai', label: 'Provider', description: 'auto (Gemini if a key exists, else tgpt) | gemini | openai | tgpt | none. Empty = keep the .env value.', public: 0 },
  { key: 'ai_model', value: '', type: 'text', group_name: 'ai', label: 'Model', description: 'For gemini: e.g. gemini-2.5-flash. For openai: any model the endpoint serves, e.g. gpt-4o-mini or llama3.1:8b. Empty = .env AI_MODEL, else the provider default.', public: 0 },
  { key: 'ai_base_url', value: '', type: 'url', group_name: 'ai', label: 'API base URL', description: 'Point at any compatible endpoint: https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1 (Ollama), an Azure gateway. Link-local and cloud-metadata addresses are always refused. Empty = provider default.', public: 0 },
  { key: 'ai_format', value: '', type: 'text', group_name: 'ai', label: 'Wire format', description: 'gemini | openai. Only set it to talk to a proxy that speaks the other shape; it is derived from the provider otherwise.', public: 0 },
  { key: 'ai_temperature', value: '', type: 'number', group_name: 'ai', label: 'Temperature', description: '0-2. Barista is a file finder, so the default is low (0.2).', public: 0 },
  { key: 'ai_max_tokens', value: '', type: 'number', group_name: 'ai', label: 'Max output tokens', description: 'Ceiling for one answer. The default 2048 covers a 300-word reply plus lists and links without cutting it off; 256 is the minimum.', public: 0 },
  { key: 'ai_timeout_ms', value: '', type: 'number', group_name: 'ai', label: 'Ask timeout (ms)', description: 'Must stay below the browser\u2019s 60 s request budget or the metadata fallback never arrives. Clamped for you.', public: 0 },
  { key: 'ai_draft_timeout_ms', value: '', type: 'number', group_name: 'ai', label: 'Draft timeout (ms)', description: 'Budget for the admin \u201cDraft with AI\u201d button, which writes more text than an answer.', public: 0 },
  { key: 'maintenance_mode', value: 'false', type: 'boolean', group_name: 'general', label: 'Maintenance mode', description: 'Shows a maintenance banner across the site.', public: 1 },
  { key: 'maintenance_message', value: 'We are performing maintenance. Downloads may be temporarily unavailable.', type: 'textarea', group_name: 'general', label: 'Maintenance message', public: 1 },
  { key: 'uploads_max_bytes', value: '5242880', type: 'number', group_name: 'uploads', label: 'Max upload size (bytes)', public: 0 },
  // download-link health checker
  { key: 'linkcheck_enabled', value: 'false', type: 'boolean', group_name: 'linkcheck', label: 'Background link checks', description: 'Periodically probe every download mirror and record its status.', public: 0 },
  { key: 'linkcheck_interval_minutes', value: '360', type: 'number', group_name: 'linkcheck', label: 'Check interval (minutes)', public: 0 },
  { key: 'linkcheck_timeout_ms', value: '8000', type: 'number', group_name: 'linkcheck', label: 'Per-link timeout (ms)', public: 0 },
  // theming — see frontend/src/themes for the scheme registry
  { key: 'theme_default', value: 'midnight', type: 'text', group_name: 'theme', label: 'Default dark scheme', description: 'Scheme id used for visitors on a dark device (midnight, starrynight, galaxy, cotton-candy, forest, sunrise, amber).', public: 1 },
  { key: 'theme_light_default', value: 'daybreak', type: 'text', group_name: 'theme', label: 'Default light scheme', description: 'Scheme id used for visitors on a light device (daybreak, sky).', public: 1 },
  { key: 'theme_allow_user_choice', value: 'true', type: 'boolean', group_name: 'theme', label: 'Let visitors pick a theme', description: 'Shows the palette switcher in the navbar. Off = everyone sees the defaults above.', public: 1 },
  { key: 'theme_starfield', value: 'true', type: 'boolean', group_name: 'theme', label: 'Animated starfield', description: 'Twinkling stars behind the hero, Ask and 404 pages.', public: 1 },
  { key: 'theme_shooting_stars', value: 'true', type: 'boolean', group_name: 'theme', label: 'Shooting stars', public: 1 },
  { key: 'theme_aurora', value: 'true', type: 'boolean', group_name: 'theme', label: 'Aurora glow', description: 'Soft coloured blobs behind the stars.', public: 1 },
  { key: 'theme_star_density', value: '100', type: 'number', group_name: 'theme', label: 'Star density (%)', description: '100 = default. Lower it on low-powered devices; 0 hides the stars.', public: 1 },
];

export const DEFAULT_CATEGORIES = [
  { name: 'Operating Systems', slug: 'operating-systems', description: 'OS distributions, installers, and recovery media', icon: '🖥️', color: '#8b5cf6' },
  { name: 'ISOs', slug: 'isos', description: 'Bootable ISO images and disk images', icon: '💿', color: '#6366f1' },
  { name: 'Applications', slug: 'applications', description: 'Productivity and creative applications', icon: '📦', color: '#3b82f6' },
  { name: 'Utilities', slug: 'utilities', description: 'System tools, cleaners, and maintenance utilities', icon: '🔧', color: '#06b6d4' },
  { name: 'Development', slug: 'development', description: 'IDEs, SDKs, runtimes, and dev tools', icon: '💻', color: '#10b981' },
  { name: 'Games', slug: 'games', description: 'Games, emulators, and game tools', icon: '🎮', color: '#f59e0b' },
  { name: 'Documentation', slug: 'documentation', description: 'Manuals, guides, datasheets, and references', icon: '📚', color: '#ec4899' },
  { name: 'Other', slug: 'other', description: 'Miscellaneous files and archives', icon: '📁', color: '#6b7280' },
];
