import axios from 'axios';

/**
 * API client.
 *
 * Auth is cookie-only: the server sets an httpOnly session cookie on login and
 * the browser attaches it automatically (`withCredentials`). No token is ever
 * stored in localStorage, where any injected script could walk off with it.
 *
 * CSRF: mutating cookie-authenticated calls must echo the readable
 * `espress0_csrf` cookie back as the X-CSRF-Token header (double-submit). On a
 * CSRF rejection we fetch a fresh cookie from /auth/csrf and retry once, which
 * keeps restored-but-stale sessions working without a reload.
 */

const SAFE_METHODS = new Set(['get', 'head', 'options']);

export function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[-.]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // session is an httpOnly cookie
});

/**
 * Budget for the AI endpoints, which either spawn the `tgpt` CLI or wait on an
 * external chat API.
 *
 * This has to be comfortably larger than the server's own budget
 * (AI_TIMEOUT_MS / AI_DRAFT_TIMEOUT_MS, 20s for a question and 30s for an admin
 * draft). Both were 30000 ms - the axios default - so a slow provider was
 * killed on the server at the exact moment the browser gave up: the
 * rule-based fallback answer was built for nobody and the visitor saw
 * "Sorry, error: timeout of 30000ms exceeded". backend/tests/ai.test.js
 * reads this constant and asserts the ordering, so the two cannot silently
 * drift back into a tie.
 */
export const AI_TIMEOUT = 60000;

/**
 * One label for "is a model answering, or just the catalogue?".
 *
 * Every Barista surface used to hardcode strings about tgpt, which stayed on
 * screen after the backend could be a Gemini key or any other endpoint - and
 * named a tool where the visitor only cares about the provenance of an answer.
 * `status` is GET /api/ai/status: { enabled, ready, provider, model, fallback }.
 */
export function describeAi(status) {
  if (!status) return { ready: false, badge: 'checking…', headline: 'checking the AI backend', blurb: 'Loading' };
  if (!status.enabled) {
    return { ready: false, badge: 'AI off', headline: 'answers come from the catalogue', blurb: 'The admin switched the AI entry points off in Settings.' };
  }
  if (!status.ready) {
    return {
      ready: false,
      badge: 'metadata search',
      headline: 'answers come from the catalogue',
      blurb: 'No model is configured on this server, so answers are built directly from verified file metadata — nothing invented, nothing hallucinated.',
    };
  }
  const who = status.model ? `${status.provider} · ${status.model}` : status.provider;
  const blurbs = {
    gemini: 'Answers are drafted by the Gemini API and then restricted to files that actually exist here.',
    openai: 'Answers are drafted by your configured chat endpoint and then restricted to files that actually exist here.',
    tgpt: 'Answers are drafted by the tgpt CLI and then restricted to files that actually exist here.',
  };
  return {
    ready: true,
    badge: `${status.provider} ready`,
    headline: who,
    blurb: blurbs[status.provider] || `Answers are drafted by ${status.provider} and then restricted to files that actually exist here.`,
    provider: status.provider,
    model: status.model,
  };
}

/**
 * Turns an axios error into something a visitor can act on.
 *
 * The raw axios message ("timeout of 30000ms exceeded") describes our
 * transport, not what the user should do next, and it leaked straight into
 * the chat bubble.
 */
export function describeApiError(error) {
  const serverMessage = error?.response?.data?.error;
  const status = error?.response?.status;

  if (error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '')) {
    return 'Barista took too long to answer and the request was cancelled. The AI provider may be slow or offline — try again, or browse the catalogue directly.';
  }
  if (!error?.response) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (status === 429) {
    return 'That is a lot of questions at once. Give it a minute, then try again.';
  }
  if (status >= 500) {
    return serverMessage || 'Something went wrong on the server while answering. Try again.';
  }
  return serverMessage || `The request could not be completed (${status}).`;
}

api.interceptors.request.use((config) => {
  if (!SAFE_METHODS.has((config.method || 'get').toLowerCase())) {
    // The client declares `Content-Type: application/json` for everything, so a
    // POST that carries no body at all arrived as an empty JSON body and
    // Fastify rejected it with FST_ERR_CTP_EMPTY_JSON_BODY. Every bodyless
    // mutation failed with a 400: logging out, duplicating a page, rebuilding
    // the search index, restoring a version, running a link check, resetting a
    // setting. Sending `{}` keeps the declared type honest and fixes all of
    // them in one place, including calls added later.
    if (config.data === undefined) config.data = {};
    const csrf = readCookie('espress0_csrf');
    if (csrf) config.headers['X-CSRF-Token'] = csrf;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    // Stale/missing CSRF cookie: refresh it, then retry the request once.
    if (status === 403 && error.response?.data?.code === 'CSRF_MISMATCH' && !error.config?._csrfRetried) {
      try {
        await api.get('/auth/csrf');
        error.config._csrfRetried = true;
        // Re-read the fresh cookie into the header for the retry.
        const csrf = readCookie('espress0_csrf');
        if (csrf) error.config.headers['X-CSRF-Token'] = csrf;
        return api.request(error.config);
      } catch { /* fall through to the original error */ }
    }
    if (status === 401) {
      // Session expired/invalidated - nothing to clear client-side any more;
      // components react to the rejection.
    }
    // "Require two-factor auth for admins" is on and this admin has not
    // enrolled: the API only allows the enrolment routes, so send them there.
    if (status === 403 && error.response?.data?.mfaSetupRequired && !window.location.pathname.startsWith('/account')) {
      window.location.assign('/account?tab=security&mfa=required');
    }
    return Promise.reject(error);
  }
);

export const itemsApi = {
  list: (params) => api.get('/items', { params }).then(r => r.data),
  get: (slug) => api.get(`/items/${slug}`).then(r => r.data),
  create: (data) => api.post('/items', data).then(r => r.data),
  update: (id, data) => api.put(`/items/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/items/${id}`).then(r => r.data),
};

export const categoriesApi = {
  list: () => api.get('/categories').then(r => r.data),
  get: (slug) => api.get(`/categories/${slug}`).then(r => r.data),
};

export const foldersApi = {
  /** Public list with published item counts. */
  list: () => api.get('/folders').then(r => r.data),
  get: (slug) => api.get(`/folders/${slug}`).then(r => r.data),
  /** Admin: same list, counts include drafts. */
  adminList: () => api.get('/admin/folders').then(r => r.data),
  create: (data) => api.post('/folders', data).then(r => r.data),
  update: (id, data) => api.put(`/folders/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/folders/${id}`).then(r => r.data),
};

export const searchApi = {
  search: (params) => api.get('/search', { params }).then(r => r.data),
  suggestions: (q) => api.get('/search/suggestions', { params: { q } }).then(r => r.data),
};

export const statsApi = {
  get: () => api.get('/stats').then(r => r.data),
};

export const aiApi = {
  ask: (q) => api.get('/ai/ask', { params: { q }, timeout: AI_TIMEOUT }).then(r => r.data),
  /**
   * The conversational entry point. `messages` is the transcript so far; the
   * server needs it to resolve follow-ups ("does that work on my pc?"). Ten
   * turns matches MAX_CONTEXT_MESSAGES in backend/src/services/aiService.js.
   */
  askPost: (question, messages = []) => api.post('/ai/ask', {
    question,
    messages: messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && !m.error)
      .slice(-10)
      .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 2000) })),
  }, { timeout: AI_TIMEOUT }).then(r => r.data),
  suggestions: () => api.get('/ai/suggestions').then(r => r.data),
  status: () => api.get('/ai/status').then(r => r.data),
  faq: () => api.get('/faq').then(r => r.data),
};

export const authApi = {
  login: (creds) => api.post('/auth/login', creds).then(r => r.data),
  /** Step two of a login when the account has TOTP on. */
  mfaVerify: (mfaToken, code) => api.post('/auth/mfa/verify', { mfaToken, code }).then(r => r.data),
  mfa: {
    status: () => api.get('/auth/mfa').then(r => r.data),
    setup: () => api.post('/auth/mfa/setup').then(r => r.data),
    enable: (code) => api.post('/auth/mfa/enable', { code }).then(r => r.data),
    disable: (password, code) => api.post('/auth/mfa/disable', { password, code }).then(r => r.data),
    recoveryCodes: (code) => api.post('/auth/mfa/recovery-codes', { code }).then(r => r.data),
  },
  register: (data) => api.post('/auth/register', data).then(r => r.data),
  me: () => api.get('/auth/me').then(r => r.data),
  logout: () => api.post('/auth/logout').then(r => r.data),
  /** Invalidates every session for the account, including this one. */
  logoutAll: () => api.post('/auth/logout-all').then(r => r.data),
  csrf: () => api.get('/auth/csrf').then(r => r.data),
  securityInfo: () => api.get('/auth/security-info').then(r => r.data),
  encryptionStatus: () => api.get('/auth/encryption-status').then(r => r.data),
};

/**
 * Personal favourites.
 *
 * `add` takes either an item id or a slug; `isPublic` is optional and omitted
 * means "use the profile default". Everything here needs a session - the
 * public, session-free view of someone's list is usersApi below.
 */
export const favoritesApi = {
  list: (params) => api.get('/favorites', { params }).then(r => r.data),
  add: ({ itemId, slug, isPublic }) => api.post('/favorites', {
    ...(itemId ? { item_id: itemId } : { slug }),
    ...(isPublic === undefined ? {} : { is_public: isPublic }),
  }).then(r => r.data),
  setVisibility: (itemId, isPublic) =>
    api.patch(`/favorites/${encodeURIComponent(itemId)}`, { is_public: isPublic }).then(r => r.data),
  remove: (itemId) => api.delete(`/favorites/${encodeURIComponent(itemId)}`).then(r => r.data),
};

/** Public account pages. No session required, and no email is ever returned. */
export const usersApi = {
  /** Searchable directory of accounts. params: { q, page, limit, sort }. */
  list: (params) => api.get('/users', { params }).then(r => r.data),
  profile: (username) => api.get(`/users/${encodeURIComponent(username)}`).then(r => r.data),
  favorites: (username, params) =>
    api.get(`/users/${encodeURIComponent(username)}/favorites`, { params }).then(r => r.data),
};

export const captchaApi = {
  generate: () => api.get('/captcha').then(r => r.data),
  verify: (data) => api.post('/captcha/verify', data).then(r => r.data),
  config: () => api.get('/captcha/config').then(r => r.data),
  stats: () => api.get('/captcha/stats').then(r => r.data),
};

export const adminApi = {
  overview: () => api.get('/admin/overview').then(r => r.data),
  reindex: () => api.post('/admin/reindex').then(r => r.data),
  storage: () => api.get('/admin/storage').then(r => r.data),
  validateStorage: (provider, path) => api.post('/admin/validate-storage', { provider, path }).then(r => r.data),
  items: (params) => api.get('/admin/items', { params }).then(r => r.data),
  settings: () => api.get('/admin/settings').then(r => r.data),
  updateSettings: (settings) => api.put('/admin/settings', { settings }).then(r => r.data),
  resetSetting: (key) => api.post(`/admin/settings/reset/${key}`).then(r => r.data),
  /** Page authoring helpers. */
  checkSlug: (slug, excludeId) =>
    api.get('/admin/slug-check', { params: { slug, ...(excludeId ? { excludeId } : {}) } }).then(r => r.data),
  duplicateItem: (id) => api.post(`/admin/items/${id}/duplicate`).then(r => r.data),
  bulkItems: (action, ids, extra = {}) => api.post('/admin/items/bulk', { action, ids, ...extra }).then(r => r.data),
  describeItem: (meta) => api.post('/admin/ai/describe', meta, { timeout: AI_TIMEOUT }).then(r => r.data),
  /** Suggest values for the still-empty fields of a page from what's typed so far. */
  fillGaps: (meta) => api.post('/admin/ai/fill-gaps', meta, { timeout: AI_TIMEOUT }).then(r => r.data),
  // Admin view of the AI backend: resolved provider, endpoint, last failure.
  aiStatus: () => api.get('/admin/ai/status').then(r => r.data),
  // One live round-trip, so a saved provider/model/base-URL edit can be proven
  // instead of hoped for. Needs the long budget: it is a real generation.
  aiTest: () => api.post('/admin/ai/test', {}, { timeout: AI_TIMEOUT }).then(r => r.data),
  /** Version history. */
  versions: (id) => api.get(`/admin/items/${id}/versions`).then(r => r.data),
  version: (id, num) => api.get(`/admin/items/${id}/versions/${num}`).then(r => r.data),
  restoreVersion: (id, num) => api.post(`/admin/items/${id}/versions/${num}/restore`).then(r => r.data),
};

export const linkHealthApi = {
  summary: () => api.get('/admin/link-health').then(r => r.data),
  runAll: () => api.post('/admin/link-health/run').then(r => r.data),
  checkLink: (linkId) => api.post(`/admin/link-health/links/${linkId}/check`).then(r => r.data),
};

export const autoUpdateApi = {
  status: () => api.get('/admin/auto-update').then(r => r.data),
};

export const backupApi = {
  /** Triggers a file download of the full JSON export. */
  export: () => api.get('/admin/export', { responseType: 'blob' }).then(r => r.data),
  /** data = parsed export object. apply=false returns the dry-run report. */
  import: (data, apply = false) => api.post(`/admin/import${apply ? '?apply=1' : ''}`, data).then(r => r.data),
};

/**
 * Bulk catalogue import/export.
 *
 * Import is deliberately two calls: first without `apply` for the preview, then
 * with it. The archive travels as multipart form data, not JSON.
 */
/**
 * Admin catalogue management: filtered FTS search, bulk edits, dashboard
 * statistics, slug generation and metadata autofill.
 */
function webhookScope(base) {
  return {
    list: () => api.get(base).then(r => r.data),
    get: (id) => api.get(`${base}/${id}`).then(r => r.data),
    create: (data) => api.post(base, data).then(r => r.data),
    update: (id, data) => api.put(`${base}/${id}`, data).then(r => r.data),
    remove: (id) => api.delete(`${base}/${id}`).then(r => r.data),
    test: (id) => api.post(`${base}/${id}/test`).then(r => r.data),
    redeliver: (id, deliveryId) => api.post(`${base}/${id}/deliveries/${deliveryId}/redeliver`).then(r => r.data),
  };
}

/** Outgoing webhooks: site-wide (admin) and the signed-in user's own. */
export const webhooksApi = {
  admin: webhookScope('/admin/webhooks'),
  me: webhookScope('/webhooks'),
  events: (params) => api.get('/admin/events', { params }).then(r => r.data),
};

/** Scheduled imports (admin). */
export const importJobsApi = {
  list: () => api.get('/admin/import-jobs').then(r => r.data),
  create: (data) => api.post('/admin/import-jobs', data).then(r => r.data),
  update: (id, data) => api.put(`/admin/import-jobs/${id}`, data).then(r => r.data),
  remove: (id) => api.delete(`/admin/import-jobs/${id}`).then(r => r.data),
  run: (id, apply = true) => api.post(`/admin/import-jobs/${id}/run`, null, { params: { apply: apply ? 1 : 0 }, timeout: 120000 }).then(r => r.data),
};

export const catalogAdminApi = {
  /** FTS5 search with the admin filter set; sort is allow-listed server-side. */
  search: (params) => api.get('/admin/catalog/search', { params, timeout: AI_TIMEOUT }).then(r => r.data),
  facets: () => api.get('/admin/catalog/facets').then(r => r.data),
  stats: () => api.get('/admin/catalog/stats').then(r => r.data),
  /** Same slug the server would generate, plus a collision-free suggestion. */
  slugify: (text, excludeId) => api.post('/admin/slugify', { text, excludeId }).then(r => r.data),
  /** Suggest fields from a public software URL. Writes nothing. */
  autofill: (url) => api.post('/admin/metadata-autofill', { url }, { timeout: AI_TIMEOUT }).then(r => r.data),
  related: (id) => api.get(`/admin/items/${id}/related`).then(r => r.data),
  addRelated: (id, data) => api.post(`/admin/items/${id}/related`, data).then(r => r.data),
  removeRelated: (id, relationId) => api.delete(`/admin/items/${id}/related/${relationId}`).then(r => r.data),
};

export const catalogApi = {
  /** Preview (`apply=false`) or write (`apply=true`) a catalogue archive. */
  import: (file, { apply = false, mode = 'upsert' } = {}) => {
    const form = new FormData();
    form.append('file', file, file?.name || 'catalog.zip');
    const params = new URLSearchParams({ mode });
    if (apply) params.set('apply', '1');
    return api.post(`/admin/catalog/import?${params}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: AI_TIMEOUT,
    }).then(r => r.data);
  },
  /** Current catalogue as a re-importable catalog.zip. */
  export: () => api.get('/admin/catalog/export', { responseType: 'blob', timeout: AI_TIMEOUT }).then(r => r.data),
  /** Starter archive with two fully-populated example entries. */
  template: () => api.get('/admin/catalog/template', { responseType: 'blob' }).then(r => r.data),
  history: (limit = 50) => api.get('/admin/catalog/imports', { params: { limit } }).then(r => r.data),
  get: (id) => api.get(`/admin/catalog/imports/${id}`).then(r => r.data),
  errors: (id, format = 'json') => api.get(`/admin/catalog/imports/${id}/errors`, {
    params: { format }, responseType: 'blob',
  }).then(r => r.data),
};

export const snapshotApi = {
  /** Database snapshots taken before risky changes. */
  list: () => api.get('/admin/snapshots').then(r => r.data),
  /** Roll the catalogue (or everything) back to one. dryRun previews the counts. */
  restore: (path, { scope = 'catalogue', dryRun = false } = {}) =>
    api.post('/admin/snapshots/restore', { path, scope, dryRun }, { timeout: AI_TIMEOUT }).then(r => r.data),
};

export const settingsApi = {
  get: () => api.get('/settings').then(r => r.data),
};

export const uploadsApi = {
  list: (kind) => api.get('/admin/uploads', { params: kind ? { kind } : {} }).then(r => r.data),
  /** Upload a File (or Blob) and get back { upload: { url, ... } }. */
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/admin/uploads', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },
  remove: (id) => api.delete(`/admin/uploads/${id}`).then(r => r.data),
};

export default api;
