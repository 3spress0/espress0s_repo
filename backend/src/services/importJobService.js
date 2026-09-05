/**
 * Scheduled import jobs.
 *
 * A job fetches a source on an interval and pushes what it finds through the
 * *existing* catalogue import pipeline (catalogService.importCatalogArchive),
 * so validation, upsert modes, dry-run reports, history rows, backups and
 * events all behave exactly as for a manual upload. Nothing here writes to
 * `items` directly.
 *
 * Sources
 *   catalog          a URL that serves a catalog.zip (or a bare catalog.json)
 *                    in the espress0-catalog format - e.g. another instance's
 *                    /api/admin/catalog/export mirrored somewhere public, or a
 *                    file you maintain in a repo
 *   github-releases  a GitHub repository. Each release becomes one entry
 *                    (slug `<prefix>-<tag>`), each asset one download link
 *                    (storage_provider 'github', direct browser_download_url).
 *                    Options: prefix, category, folder, tags, include_prereleases,
 *                    max_releases, asset_pattern (regex), platform, license_status.
 *
 * Runs are serialised per process; a run that is already going is skipped.
 * Everything fetched goes through the SSRF-safe fetcher (public hosts only).
 */
import { getDb } from '../db/index.js';
import { importCatalogArchive, CATALOG_FORMAT, CATALOG_VERSION, IMPORT_MODES } from './catalogService.js';
import { safeFetchBuffer } from '../lib/safeFetch.js';
import { zip } from '../lib/zip.js';
import { makeSlug } from '../utils/slug.js';

export const SOURCE_TYPES = ['catalog', 'github-releases'];
const MIN_INTERVAL_MINUTES = 15;
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const GITHUB_API = 'https://api.github.com';

const nowIso = () => new Date().toISOString();
const parseJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

export class ImportJobValidationError extends Error {
  constructor(message) { super(message); this.name = 'ImportJobValidationError'; this.statusCode = 400; }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    ...row,
    options: parseJson(row.options, {}),
    enabled: !!row.enabled,
    last_report: parseJson(row.last_report, null),
  };
}

/** Validate user input for create/update. */
export function validateJobInput({ name, source_type, source_url, mode, interval_minutes, options }) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new ImportJobValidationError('name is required');
  if (!SOURCE_TYPES.includes(source_type)) throw new ImportJobValidationError(`source_type must be one of ${SOURCE_TYPES.join(', ')}`);
  const url = String(source_url || '').trim();
  if (source_type === 'catalog' && !/^https?:\/\//i.test(url)) throw new ImportJobValidationError('source_url must be an http(s) URL');
  if (source_type === 'github-releases' && !parseRepo(url)) throw new ImportJobValidationError('source_url must be owner/repo or a github.com repository URL');
  if (!IMPORT_MODES.includes(mode)) throw new ImportJobValidationError(`mode must be one of ${IMPORT_MODES.join(', ')}`);
  const interval = Math.max(MIN_INTERVAL_MINUTES, parseInt(interval_minutes, 10) || 360);
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.asset_pattern) {
    try { new RegExp(opts.asset_pattern); } catch { throw new ImportJobValidationError('options.asset_pattern is not a valid regular expression'); }
  }
  return { name: cleanName, source_type, source_url: source_type === 'github-releases' ? parseRepo(url) : url, mode, interval_minutes: interval, options: opts };
}

/** "owner/repo" from either that form or a github.com URL. */
export function parseRepo(input) {
  const s = String(input || '').trim();
  let m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Source adapters: each returns a catalog.zip Buffer for the import pipeline.
// ---------------------------------------------------------------------------

async function fetchCatalogSource(job) {
  const buf = await safeFetchBuffer(job.source_url, { maxBytes: MAX_FETCH_BYTES, timeoutMs: 30000, headers: { accept: 'application/zip, application/json' } });
  // A bare catalog.json is wrapped so the reader sees the same archive shape.
  if (buf.length && buf[0] === 0x7b /* { */) return zip([{ name: 'catalog.json', data: buf }]);
  return buf;
}

function ghHeaders() {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'espress0-repo-import/1.0' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** GitHub releases -> catalog entries. Exposed for tests (pure given `releases`). */
export function releasesToCatalog(repo, releases, options = {}) {
  const [owner, name] = repo.split('/');
  const prefix = options.prefix ? makeSlug(String(options.prefix)) : makeSlug(name);
  const pattern = options.asset_pattern ? new RegExp(options.asset_pattern, 'i') : null;
  const max = Math.min(Math.max(parseInt(options.max_releases, 10) || 20, 1), 200);
  const items = [];
  for (const rel of releases) {
    if (rel.draft) continue;
    if (rel.prerelease && !options.include_prereleases) continue;
    if (items.length >= max) break;
    const assets = (rel.assets || []).filter(a => a.browser_download_url && (!pattern || pattern.test(a.name)));
    if (!assets.length && !options.include_empty_releases) continue;
    const tag = String(rel.tag_name || rel.name || rel.id);
    const version = tag.replace(/^v(?=\d)/, '');
    const primary = assets[0];
    items.push({
      // Dots become dashes so "v2.1.0" stays readable as "v2-1-0".
      slug: `${prefix}-${makeSlug(tag.replace(/\./g, '-'))}`.slice(0, 200),
      name: `${options.display_name || name} ${version}`.slice(0, 200),
      description: (rel.name && rel.name !== tag ? rel.name : `${name} release ${tag} from GitHub`).slice(0, 1000).padEnd(5, '.'),
      long_description: rel.body ? String(rel.body).slice(0, 200000) : null,
      category: options.category || null,
      folder: options.folder || null,
      version,
      release_date: (rel.published_at || rel.created_at || '').slice(0, 10) || null,
      file_name: primary?.name || null,
      file_size: primary?.size ?? null,
      file_type: primary?.name ? (primary.name.split('.').pop() || '').toLowerCase().slice(0, 20) || null : null,
      platform: options.platform || null,
      architecture: options.architecture || null,
      status: rel.prerelease ? 'unreleased' : 'current',
      published: options.published !== false,
      license_status: options.license_status || 'check-license',
      tags: [...new Set([...(options.tags || []), 'github', owner.toLowerCase()])].slice(0, 100),
      external_url: rel.html_url || `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      documentation_url: `https://github.com/${repo}`,
      changelog: rel.body ? String(rel.body).slice(0, 200000) : null,
      links: assets.slice(0, 50).map((a, i) => ({
        label: a.name.slice(0, 100),
        storage_provider: 'github',
        download_url: a.browser_download_url,
        file_size: a.size ?? null,
        is_primary: i === 0,
      })),
    });
  }
  return { format: CATALOG_FORMAT, version: CATALOG_VERSION, generated_at: nowIso(), source: `github:${repo}`, items };
}

async function fetchGithubSource(job) {
  const per = Math.min(Math.max(parseInt(job.options.max_releases, 10) || 20, 1), 100);
  const url = `${GITHUB_API}/repos/${job.source_url}/releases?per_page=${per}`;
  const buf = await safeFetchBuffer(url, { maxBytes: MAX_FETCH_BYTES, timeoutMs: 30000, headers: ghHeaders() });
  let releases;
  try { releases = JSON.parse(buf.toString('utf8')); } catch { throw new Error('GitHub answered with something that is not JSON'); }
  if (!Array.isArray(releases)) throw new Error(releases?.message || 'Unexpected GitHub response');
  const catalog = releasesToCatalog(job.source_url, releases, job.options);
  return zip([{ name: 'catalog.json', data: JSON.stringify(catalog) }]);
}

const ADAPTERS = { catalog: fetchCatalogSource, 'github-releases': fetchGithubSource };

// ---------------------------------------------------------------------------

export class ImportJobService {
  constructor() {
    this.timer = null;
    this.runningIds = new Set();
    this.logger = console;
    this.fetchSource = (job) => ADAPTERS[job.source_type](job); // test hook
  }

  list() {
    return getDb().prepare('SELECT * FROM import_jobs ORDER BY id').all().map(rowToJob);
  }

  get(id) {
    return rowToJob(getDb().prepare('SELECT * FROM import_jobs WHERE id = ?').get(id));
  }

  create(input, { userId = null } = {}) {
    const clean = validateJobInput(input);
    const enabled = input.enabled === undefined ? 1 : (input.enabled ? 1 : 0);
    const result = getDb().prepare(`
      INSERT INTO import_jobs (name, source_type, source_url, mode, interval_minutes, options, enabled, created_by, next_run_at, created_at, updated_at)
      VALUES (@name, @source_type, @source_url, @mode, @interval_minutes, @options, @enabled, @created_by, @next_run_at, @now, @now)
    `).run({ ...clean, options: JSON.stringify(clean.options), enabled, created_by: userId, next_run_at: nowIso(), now: nowIso() });
    return this.get(result.lastInsertRowid);
  }

  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const clean = validateJobInput({
      name: patch.name ?? existing.name,
      source_type: patch.source_type ?? existing.source_type,
      source_url: patch.source_url ?? existing.source_url,
      mode: patch.mode ?? existing.mode,
      interval_minutes: patch.interval_minutes ?? existing.interval_minutes,
      options: patch.options ?? existing.options,
    });
    const enabled = patch.enabled === undefined ? (existing.enabled ? 1 : 0) : (patch.enabled ? 1 : 0);
    getDb().prepare(`
      UPDATE import_jobs SET name = @name, source_type = @source_type, source_url = @source_url, mode = @mode,
        interval_minutes = @interval_minutes, options = @options, enabled = @enabled, updated_at = @now,
        next_run_at = CASE WHEN @enabled = 1 AND enabled = 0 THEN @now ELSE next_run_at END
      WHERE id = @id
    `).run({ id, ...clean, options: JSON.stringify(clean.options), enabled, now: nowIso() });
    return this.get(id);
  }

  remove(id) {
    return getDb().prepare('DELETE FROM import_jobs WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Run one job now. `apply=false` previews (the pipeline's dry run) without
   * touching the schedule. Returns { job, report, history } or { job, error }.
   */
  async run(id, { apply = true, userId = null, manual = false } = {}) {
    const job = this.get(id);
    if (!job) return null;
    if (this.runningIds.has(id)) return { job, skipped: true, reason: 'already running' };
    this.runningIds.add(id);
    const db = getDb();
    const startedAt = nowIso();
    try {
      const buffer = await this.fetchSource(job);
      const { report, history } = await importCatalogArchive({
        buffer, filename: `job-${job.id}-${job.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.zip`,
        mode: job.mode, apply, userId,
      });
      if (apply) {
        const summary = { items: report.items, relations: report.relations, errorCount: report.errorCount, history_id: history?.id ?? null };
        db.prepare(`UPDATE import_jobs SET last_run_at = ?, last_status = ?, last_error = NULL, last_report = ?, run_count = run_count + 1, next_run_at = ? WHERE id = ?`)
          .run(startedAt, report.errorCount ? 'ok-with-errors' : 'ok', JSON.stringify(summary), this.nextRun(job), id);
      }
      return { job: this.get(id), report, history, apply };
    } catch (e) {
      const message = e?.message || String(e);
      if (apply) {
        db.prepare(`UPDATE import_jobs SET last_run_at = ?, last_status = 'failed', last_error = ?, run_count = run_count + 1, next_run_at = ? WHERE id = ?`)
          .run(startedAt, message.slice(0, 1000), this.nextRun(job), id);
      }
      this.logger.warn?.({ jobId: id, err: message, manual }, 'Import job failed');
      return { job: this.get(id), error: message, apply };
    } finally {
      this.runningIds.delete(id);
    }
  }

  nextRun(job) {
    return new Date(Date.now() + Math.max(MIN_INTERVAL_MINUTES, job.interval_minutes) * 60_000).toISOString();
  }

  /** Run every enabled job whose next_run_at has passed. */
  async tick() {
    const due = getDb().prepare('SELECT id FROM import_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at').all(nowIso());
    const results = [];
    for (const { id } of due) results.push(await this.run(id, { apply: true }));
    return results;
  }

  start(logger) {
    this.logger = logger || console;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(err => this.logger.error?.({ err }, 'Import job tick failed')), 60_000);
    this.timer.unref?.();
    this.logger.info?.('Import job scheduler armed');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const importJobService = new ImportJobService();
