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

api.interceptors.request.use((config) => {
  if (!SAFE_METHODS.has((config.method || 'get').toLowerCase())) {
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
  ask: (q) => api.get('/ai/ask', { params: { q } }).then(r => r.data),
  askPost: (question) => api.post('/ai/ask', { question }).then(r => r.data),
  suggestions: () => api.get('/ai/suggestions').then(r => r.data),
  status: () => api.get('/ai/status').then(r => r.data),
  faq: () => api.get('/faq').then(r => r.data),
};

export const authApi = {
  login: (creds) => api.post('/auth/login', creds).then(r => r.data),
  register: (data) => api.post('/auth/register', data).then(r => r.data),
  me: () => api.get('/auth/me').then(r => r.data),
  logout: () => api.post('/auth/logout').then(r => r.data),
  /** Invalidates every session for the account, including this one. */
  logoutAll: () => api.post('/auth/logout-all').then(r => r.data),
  csrf: () => api.get('/auth/csrf').then(r => r.data),
  securityInfo: () => api.get('/auth/security-info').then(r => r.data),
  encryptionStatus: () => api.get('/auth/encryption-status').then(r => r.data),
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
  describeItem: (meta) => api.post('/admin/ai/describe', meta).then(r => r.data),
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

export const backupApi = {
  /** Triggers a file download of the full JSON export. */
  export: () => api.get('/admin/export', { responseType: 'blob' }).then(r => r.data),
  /** data = parsed export object. apply=false returns the dry-run report. */
  import: (data, apply = false) => api.post(`/admin/import${apply ? '?apply=1' : ''}`, data).then(r => r.data),
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
