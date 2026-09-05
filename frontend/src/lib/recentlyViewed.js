/**
 * Recently viewed entries, kept in this browser only (localStorage). The
 * server never records who looked at what - view_count is a bare counter -
 * and this keeps it that way. Stores the little an ItemCard needs so the list
 * renders without a round trip; entries are refreshed each time they are
 * opened again.
 */
const KEY = 'espress0_recent';
const MAX = 12;
const EVENT = 'espress0:recent';

export function getRecentlyViewed() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function recordView(item) {
  if (!item?.slug) return;
  const entry = {
    id: item.id, slug: item.slug, name: item.name, version: item.version || null,
    file_type: item.file_type || null, platform: item.platform || null, architecture: item.architecture || null,
    file_size: item.file_size ?? null, icon_url: item.icon_url || null, description: item.description || '',
    viewed_at: new Date().toISOString(),
  };
  const next = [entry, ...getRecentlyViewed().filter((r) => r.slug !== item.slug)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* quota / private mode */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function clearRecentlyViewed() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Subscribe to changes (same tab via the event, other tabs via storage). */
export function onRecentlyViewedChange(cb) {
  const h = () => cb(getRecentlyViewed());
  window.addEventListener(EVENT, h);
  window.addEventListener('storage', h);
  return () => { window.removeEventListener(EVENT, h); window.removeEventListener('storage', h); };
}
