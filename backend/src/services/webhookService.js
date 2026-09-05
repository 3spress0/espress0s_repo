/**
 * Outgoing webhooks.
 *
 * A webhook is a URL plus a list of event types. When a matching event is
 * emitted (see eventBus.js) a delivery row is queued and a small worker POSTs
 * the JSON payload, signed with the webhook's secret:
 *
 *   X-Espress0-Event:      item.updated
 *   X-Espress0-Delivery:   <delivery id>
 *   X-Espress0-Signature:  sha256=<hex HMAC of the raw body>
 *   User-Agent:            espress0-repo-webhook/1.0
 *
 * Failures retry with exponential backoff (1 min, 5, 15, 60, 6 h) and then
 * give up; every attempt is recorded so the admin UI can show it. Target URLs
 * pass the same SSRF policy as everything else that fetches on behalf of an
 * operator (public addresses only unless WEBHOOK_ALLOW_PRIVATE=true).
 *
 * Ownership: `user_id` NULL = site-wide hook (admin-managed). A non-null
 * user_id is a personal hook (used by per-user subscriptions, #13) and is
 * only delivered events that user is allowed to see - i.e. public items.
 */
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { userFollowsEvent } from './subscriptionService.js';
import { onEvent, EVENT_TYPES } from './eventBus.js';
import { encryptionService } from './encryptionService.js';
import { assertPublicUrl, assertConfiguredEndpoint } from '../lib/safeFetch.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SNIPPET = 500;

function nowIso() { return new Date().toISOString(); }

function allowPrivateTargets() {
  return String(process.env.WEBHOOK_ALLOW_PRIVATE || '').toLowerCase() === 'true';
}

/** Validate a target URL against the SSRF policy. Throws UnsafeUrlError. */
export async function validateWebhookUrl(url) {
  if (allowPrivateTargets()) return assertConfiguredEndpoint(url, { allowPrivate: true });
  return assertPublicUrl(url);
}

export function signBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function parseEvents(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function rowToWebhook(row, { withSecret = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    url: row.url,
    events: parseEvents(row.events),
    filter_mode: row.filter_mode || 'all',
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_delivery_at: row.last_delivery_at,
    last_status: row.last_status,
    failure_count: row.failure_count || 0,
  };
  if (withSecret) {
    try { out.secret = encryptionService.decrypt(row.secret); } catch { out.secret = null; }
  }
  return out;
}

export class WebhookService {
  constructor() {
    this.timer = null;
    this.unsubscribe = null;
    this.logger = console;
    this.delivering = false; // false | Promise while a sweep runs
    // Test hook: replace the transport.
    this.fetchImpl = (...args) => fetch(...args);
  }

  // ---- CRUD -------------------------------------------------------------

  list({ userId = null } = {}) {
    const db = getDb();
    const rows = userId === null
      ? db.prepare('SELECT * FROM webhooks WHERE user_id IS NULL ORDER BY id').all()
      : db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY id').all(userId);
    return rows.map(r => rowToWebhook(r));
  }

  get(id, { userId = undefined, withSecret = false } = {}) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    if (!row) return null;
    if (userId !== undefined && row.user_id !== userId) return null;
    return rowToWebhook(row, { withSecret });
  }

  /**
   * Create a hook. Returns the row including the plaintext secret exactly
   * once (it is stored encrypted and never listed again).
   */
  async create({ userId = null, name, url, events, secret = null, active = true, filter_mode = 'all' }) {
    const clean = this.validateInput({ name, url, events, filter_mode, personal: userId !== null });
    await validateWebhookUrl(clean.url);
    const plainSecret = secret || crypto.randomBytes(24).toString('base64url');
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO webhooks (user_id, name, url, events, filter_mode, secret, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, clean.name, clean.url, JSON.stringify(clean.events), clean.filter_mode, encryptionService.encrypt(plainSecret), active ? 1 : 0, nowIso(), nowIso());
    return { ...this.get(result.lastInsertRowid), secret: plainSecret };
  }

  async update(id, patch, { userId = undefined } = {}) {
    const existing = this.get(id, { userId });
    if (!existing) return null;
    const merged = {
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      events: patch.events ?? existing.events,
      filter_mode: patch.filter_mode ?? existing.filter_mode,
      personal: existing.user_id !== null,
    };
    const clean = this.validateInput(merged);
    if (patch.url !== undefined && patch.url !== existing.url) await validateWebhookUrl(clean.url);
    const db = getDb();
    const sets = ['name = @name', 'url = @url', 'events = @events', 'filter_mode = @filter_mode', 'updated_at = @now'];
    const params = { id, name: clean.name, url: clean.url, events: JSON.stringify(clean.events), filter_mode: clean.filter_mode, now: nowIso() };
    if (patch.active !== undefined) { sets.push('active = @active'); params.active = patch.active ? 1 : 0; }
    if (patch.active) { sets.push('failure_count = 0'); }
    if (patch.rotateSecret) {
      params.secret = encryptionService.encrypt(crypto.randomBytes(24).toString('base64url'));
      sets.push('secret = @secret');
    }
    db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = @id`).run(params);
    const out = this.get(id, { withSecret: !!patch.rotateSecret });
    return out;
  }

  remove(id, { userId = undefined } = {}) {
    if (!this.get(id, { userId })) return false;
    getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return true;
  }

  validateInput({ name, url, events, filter_mode = 'all', personal = false }) {
    const cleanName = String(name || '').trim().slice(0, 100);
    if (!cleanName) throw new WebhookValidationError('name is required');
    const cleanUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(cleanUrl) || cleanUrl.length > 2000) throw new WebhookValidationError('url must be an http(s) URL');
    const list = Array.isArray(events) ? [...new Set(events.map(String))] : [];
    if (!list.length) throw new WebhookValidationError('at least one event is required');
    const bad = list.filter(e => !EVENT_TYPES.includes(e));
    if (bad.length) throw new WebhookValidationError(`unknown event(s): ${bad.join(', ')}`);
    if (!['all', 'subscribed'].includes(filter_mode)) throw new WebhookValidationError("filter_mode must be 'all' or 'subscribed'");
    if (filter_mode === 'subscribed' && !personal) throw new WebhookValidationError('only personal webhooks can be limited to subscriptions');
    return { name: cleanName, url: cleanUrl, events: list, filter_mode };
  }

  // ---- Queueing ---------------------------------------------------------

  /** Which hooks want this event. Personal hooks only get public-item events. */
  matchingHooks(event) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM webhooks WHERE active = 1').all();
    const isPublicItem = event.payload?.item?.published !== false;
    return rows.filter(r => {
      if (!parseEvents(r.events).includes(event.type)) return false;
      if (r.user_id !== null && !isPublicItem) return false;
      if (r.user_id !== null && r.filter_mode === 'subscribed' && !userFollowsEvent(r.user_id, event)) return false;
      return true;
    });
  }

  /** Called by the event bus. Queues deliveries and kicks the worker. */
  enqueueForEvent(event, { extraHookIds = [] } = {}) {
    const db = getDb();
    const hooks = this.matchingHooks(event);
    const ids = new Set(hooks.map(h => h.id));
    for (const id of extraHookIds) ids.add(id);
    if (!ids.size) return 0;
    const insert = db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
    `);
    const body = JSON.stringify({ id: event.id, type: event.type, created_at: event.created_at, data: event.payload });
    const tx = db.transaction(() => {
      for (const id of ids) insert.run(id, event.id, event.type, body, nowIso(), nowIso());
    });
    tx();
    setImmediate(() => this.deliverPending().catch(() => {}));
    return ids.size;
  }

  /** Manual "send a test" for one hook. Delivers synchronously. */
  async sendTest(id) {
    const hook = this.get(id, { withSecret: true });
    if (!hook) return null;
    const db = getDb();
    const body = JSON.stringify({ id: 0, type: 'ping', created_at: nowIso(), data: { message: 'Test delivery from espress0 repo', webhook: { id: hook.id, name: hook.name } } });
    const result = db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
      VALUES (?, NULL, 'ping', ?, 'pending', 0, ?, ?)
    `).run(hook.id, body, nowIso(), nowIso());
    const delivery = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(result.lastInsertRowid);
    return this.attempt(delivery, hook);
  }

  // ---- Delivery ---------------------------------------------------------

  async deliverPending({ limit = 50 } = {}) {
    // Serialise sweeps: a caller that arrives mid-sweep waits for it and then
    // runs its own, so "enqueue then deliverPending()" always sees its rows.
    while (this.delivering) await this.delivering;
    let release;
    this.delivering = new Promise(r => { release = r; });
    try {
      const db = getDb();
      const due = db.prepare(`
        SELECT * FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY id LIMIT ?
      `).all(nowIso(), limit);
      let delivered = 0, failed = 0;
      for (const d of due) {
        const hook = this.get(d.webhook_id, { withSecret: true });
        if (!hook || !hook.active) {
          db.prepare("UPDATE webhook_deliveries SET status = 'cancelled' WHERE id = ?").run(d.id);
          continue;
        }
        const res = await this.attempt(d, hook);
        if (res.ok) delivered++; else failed++;
      }
      return { delivered, failed, due: due.length };
    } finally {
      this.delivering = false;
      release();
    }
  }

  /** One HTTP attempt for one delivery row. Records the outcome. */
  async attempt(delivery, hook) {
    const db = getDb();
    const attempts = (delivery.attempts || 0) + 1;
    const started = Date.now();
    let status = 0, ok = false, error = null, snippet = null;
    try {
      const target = await validateWebhookUrl(hook.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(target.toString(), {
          method: 'POST',
          redirect: 'manual', // a redirect could point us at an internal host
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'espress0-repo-webhook/1.0',
            'x-espress0-event': delivery.event_type,
            'x-espress0-delivery': String(delivery.id),
            'x-espress0-signature': signBody(hook.secret || '', delivery.payload),
          },
          body: delivery.payload,
        });
        status = res.status;
        ok = res.status >= 200 && res.status < 300;
        try { snippet = (await res.text()).slice(0, MAX_RESPONSE_SNIPPET); } catch {}
        if (!ok) error = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e.name === 'AbortError' ? `Timed out after ${DELIVERY_TIMEOUT_MS} ms` : (e.message || String(e));
    }
    const duration = Date.now() - started;

    let next = null, finalStatus;
    if (ok) finalStatus = 'delivered';
    else if (attempts >= MAX_ATTEMPTS) finalStatus = 'failed';
    else { finalStatus = 'pending'; next = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]).toISOString(); }

    db.prepare(`
      UPDATE webhook_deliveries
      SET status = ?, attempts = ?, next_attempt_at = ?, last_attempt_at = ?, response_status = ?, response_body = ?, error = ?, duration_ms = ?
      WHERE id = ?
    `).run(finalStatus, attempts, next, nowIso(), status || null, snippet, error, duration, delivery.id);
    db.prepare(`
      UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failure_count = ?
      WHERE id = ?
    `).run(nowIso(), ok ? 'ok' : 'error', ok ? 0 : (hook.failure_count || 0) + 1, hook.id);

    return { ok, status, error, attempts, duration_ms: duration, next_attempt_at: next, delivery_id: delivery.id, final_status: finalStatus };
  }

  deliveries(webhookId, { limit = 50 } = {}) {
    const db = getDb();
    return db.prepare(`
      SELECT id, event_id, event_type, status, attempts, next_attempt_at, last_attempt_at,
             response_status, error, duration_ms, created_at
      FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?
    `).all(webhookId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  }

  redeliver(deliveryId) {
    const db = getDb();
    const row = db.prepare('SELECT id FROM webhook_deliveries WHERE id = ?').get(deliveryId);
    if (!row) return false;
    db.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, attempts = 0 WHERE id = ?").run(nowIso(), deliveryId);
    setImmediate(() => this.deliverPending().catch(() => {}));
    return true;
  }

  // ---- Lifecycle --------------------------------------------------------

  start(logger) {
    this.logger = logger || console;
    if (!this.unsubscribe) {
      this.unsubscribe = onEvent((event) => this.enqueueForEvent(event));
    }
    if (this.timer) return;
    // Retry sweep every minute; pending-but-not-due rows wait their turn.
    this.timer = setInterval(() => {
      this.deliverPending().catch(err => this.logger.error?.({ err }, 'Webhook sweep failed'));
      this.prune();
    }, 60_000);
    this.timer.unref?.();
    this.logger.info?.('Webhook dispatcher armed');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  prune({ keepDays = 30 } = {}) {
    const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
    return getDb().prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND status != 'pending'").run(cutoff).changes;
  }
}

export class WebhookValidationError extends Error {
  constructor(message) { super(message); this.name = 'WebhookValidationError'; this.statusCode = 400; }
}

export const webhookService = new WebhookService();
