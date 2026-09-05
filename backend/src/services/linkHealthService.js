import { getDb } from '../db/index.js';
import { emitEvent, itemSummary } from './eventBus.js';
import { storageManager } from './storage/index.js';
import { decryptLink } from './itemSerializer.js';
import { settingsService } from './settingsService.js';
import { safeProbeUrl } from '../lib/safeFetch.js';

/**
 * Download-link health checker.
 *
 * Probes every mirror's resolved URL with an SSRF-guarded HEAD (ranged GET
 * fallback) and records the verdict on the link row: `status`, `http_status`,
 * `check_error`, `check_duration_ms` and `last_checked`.
 *
 * Verdict policy - deliberately conservative so a flaky VM or a bot-wall
 * never takes a mirror offline by itself:
 *  - 2xx/3xx          -> up
 *  - 404 / 410        -> down (the host is alive and says the file is gone)
 *  - 401 / 403        -> unknown (access denied - could be an expired share
 *                        or simple bot protection; needs a human glance)
 *  - DNS/timeout/5xx  -> unknown with the error text recorded
 * The manual `is_down` flag stays the only authoritative "block downloads"
 * switch apart from an explicit 404/410.
 *
 * A run is triggered manually from the admin UI or periodically when the
 * `linkcheck_enabled` setting is on (see start()).
 */

const RUN_CONCURRENCY = 4;

export class LinkHealthService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastRun = null; // { startedAt, finishedAt, checked, up, down, unknown, skipped, errors }
  }

  getConfig() {
    return {
      enabled: settingsService.getSetting('linkcheck_enabled', 'false') === 'true',
      intervalMinutes: Math.max(5, parseInt(settingsService.getSetting('linkcheck_interval_minutes', '360'), 10) || 360),
      timeoutMs: Math.min(30000, Math.max(1000, parseInt(settingsService.getSetting('linkcheck_timeout_ms', '8000'), 10) || 8000)),
    };
  }

  /** Map a probe result to the stored status + a human-readable verdict. */
  verdictFor(result) {
    if (result.ok) return { status: 'up', error: null };
    if (result.status === 404 || result.status === 410) {
      return { status: 'down', error: `HTTP ${result.status} — the host says the file is gone` };
    }
    if (result.status === 401 || result.status === 403) {
      return { status: 'unknown', error: `HTTP ${result.status} — access denied (expired share or bot protection?)` };
    }
    if (result.status) return { status: 'unknown', error: `HTTP ${result.status}` };
    return { status: 'unknown', error: result.error || 'Probe failed' };
  }

  /**
   * Work out the URL to probe for a link row. Mirrors that only have a
   * storage path get their URL built by the provider (Drive file-id -> uc?...
   * etc). Local provider rows have no URL - those are skipped.
   */
  async resolveUrl(link) {
    if (link.download_url) return link.download_url;
    if (link.storage_provider === 'local') return null;
    if (!link.storage_path) return null;
    return await storageManager.getDownloadUrl(link.storage_provider, link.storage_path, link);
  }

  /**
   * Check one link row (raw or decrypted) and persist the outcome.
   * Returns { id, status, http_status, check_error, check_duration_ms, last_checked, skipped?, reason? }.
   */
  async checkLink(linkRow, { timeoutMs } = {}) {
    const db = getDb();
    const timeout = timeoutMs ?? this.getConfig().timeoutMs;
    const link = decryptLink(linkRow);
    const now = new Date().toISOString();

    let outcome;
    try {
      const url = await this.resolveUrl(link);
      if (url && /^magnet:/i.test(url)) {
        // A magnet link has no server to ask; swarm health is out of scope.
        outcome = { status: link.status || 'unknown', http_status: null, check_error: 'Skipped — magnet links cannot be probed', skipped: true };
      } else if (!url || !/^https?:\/\//i.test(url)) {
        outcome = {
          status: link.status || 'unknown',
          http_status: null,
          check_error: 'Skipped — no probeable URL (local provider or missing path/URL)',
          skipped: true,
        };
      } else {
        const probe = await safeProbeUrl(url, { timeoutMs: timeout });
        const verdict = this.verdictFor(probe);
        outcome = {
          status: verdict.status,
          http_status: probe.status || null,
          check_error: verdict.error,
          duration: probe.durationMs,
        };
      }
    } catch (e) {
      outcome = { status: 'unknown', http_status: null, check_error: `Resolver error: ${e.message}` };
    }

    const previousStatus = linkRow.status || 'unknown';
    db.prepare(`
      UPDATE item_download_links
      SET status = @status, http_status = @http_status, check_error = @check_error,
          check_duration_ms = @duration, last_checked = @now
      WHERE id = @id
    `).run({
      id: linkRow.id,
      status: outcome.status,
      http_status: outcome.http_status,
      check_error: outcome.check_error,
      duration: outcome.duration ?? null,
      now,
    });

    // Only transitions are events: down stays down silently, and a flap back
    // to 'up' after a recorded 'down' is a recovery.
    if (!outcome.skipped && outcome.status !== previousStatus) {
      const linkPublic = { id: linkRow.id, label: link.label, storage_provider: link.storage_provider, status: outcome.status, http_status: outcome.http_status, check_error: outcome.check_error };
      const item = db.prepare('SELECT id, slug, name, version, category_id, platform, status, published, updated_at FROM items WHERE id = ?').get(linkRow.item_id);
      if (outcome.status === 'down') {
        emitEvent('link.down', { item: itemSummary(item), link: linkPublic, previous_status: previousStatus }, { itemId: linkRow.item_id });
      } else if (outcome.status === 'up' && previousStatus === 'down') {
        emitEvent('link.recovered', { item: itemSummary(item), link: linkPublic }, { itemId: linkRow.item_id });
      }
    }

    return {
      id: linkRow.id,
      item_id: linkRow.item_id,
      status: outcome.status,
      http_status: outcome.http_status,
      check_error: outcome.check_error,
      check_duration_ms: outcome.duration ?? null,
      last_checked: now,
      ...(outcome.skipped ? { skipped: true, reason: outcome.check_error } : {}),
    };
  }

  /** Check a single link by id. Returns null when the link does not exist. */
  async checkById(linkId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM item_download_links WHERE id = ?').get(linkId);
    if (!row) return null;
    return this.checkLink(row);
  }

  /**
   * Check every link (newest-unchecked first), bounded concurrency. Safe to
   * call while another part of the app writes links - each link is updated
   * row-by-row.
   */
  async runAll({ limit = 1000 } = {}) {
    if (this.running) return { alreadyRunning: true, ...this.lastRun };
    this.running = true;
    const startedAt = new Date().toISOString();
    const summary = { startedAt, finishedAt: null, checked: 0, up: 0, down: 0, unknown: 0, skipped: 0 };

    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT * FROM item_download_links
        ORDER BY last_checked IS NOT NULL ASC, last_checked ASC
        LIMIT ?
      `).all(limit);

      // Tiny worker pool: no Promise.all over hundreds of sockets, and no
      // external dependency for what is a dozen lines.
      let cursor = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          try {
            const result = await this.checkLink(row);
            summary.checked++;
            if (result.skipped) summary.skipped++;
            else summary[result.status] = (summary[result.status] || 0) + 1;
          } catch (e) {
            summary.checked++;
            summary.unknown++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, Math.max(rows.length, 1)) }, worker));
    } finally {
      summary.finishedAt = new Date().toISOString();
      this.lastRun = summary;
      this.running = false;
    }
    return summary;
  }

  /** Aggregate numbers for the admin dashboard. */
  getSummary() {
    const db = getDb();
    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up,
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) as down,
        SUM(CASE WHEN status = 'unknown' OR status IS NULL THEN 1 ELSE 0 END) as unknown,
        SUM(CASE WHEN last_checked IS NULL THEN 1 ELSE 0 END) as never_checked,
        SUM(CASE WHEN is_down = 1 THEN 1 ELSE 0 END) as manually_down
      FROM item_download_links
    `).get();

    const problems = db.prepare(`
      SELECT l.id, l.item_id, l.label, l.status, l.http_status, l.check_error, l.last_checked,
             l.is_down, i.name as item_name, i.slug as item_slug
      FROM item_download_links l
      JOIN items i ON i.id = l.item_id
      WHERE l.status = 'down' OR l.is_down = 1 OR l.check_error IS NOT NULL
      ORDER BY l.last_checked DESC NULLS LAST
      LIMIT 50
    `).all();

    return {
      counts: {
        total: counts.total || 0,
        up: counts.up || 0,
        down: counts.down || 0,
        unknown: counts.unknown || 0,
        neverChecked: counts.never_checked || 0,
        manuallyDown: counts.manually_down || 0,
      },
      problems,
      lastRun: this.lastRun,
      running: this.running,
      config: this.getConfig(),
    };
  }

  /**
   * Periodic sweep. The interval setting is re-read every minute, so toggling
   * it in admin settings takes effect without a restart. Skips a tick when a
   * run is already in flight.
   */
  start(logger) {
    if (this.timer) return;
    const tick = () => {
      const { enabled } = this.getConfig();
      if (!enabled || this.running) return;
      this.runAll().catch(err => logger?.error({ err }, 'Link check sweep failed'));
    };
    // First tick after a short grace period; then once per minute the config is consulted.
    this._lastSweep = 0;
    this.timer = setInterval(() => {
      const { intervalMinutes } = this.getConfig();
      if (Date.now() - this._lastSweep < intervalMinutes * 60 * 1000) return;
      this._lastSweep = Date.now();
      tick();
    }, 60 * 1000);
    this.timer.unref?.();
    logger?.info('Link health scheduler armed (checks run when linkcheck_enabled is on)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const linkHealthService = new LinkHealthService();
