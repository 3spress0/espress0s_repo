import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // Use actual cookies for downloads
});

// Add auth token if exists
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('espress0_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('espress0_token');
      // Don't redirect automatically, let component handle
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
  bulkItems: (action, ids) => api.post('/admin/items/bulk', { action, ids }).then(r => r.data),
  describeItem: (meta) => api.post('/admin/ai/describe', meta).then(r => r.data),
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
