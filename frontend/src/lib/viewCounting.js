/**
 * "This browser has already counted a view for this page."
 *
 * The server counts what it is told and keeps no per-device record (see the
 * POST /api/items/:slug/view handler in backend/src/routes/items.js), so the
 * once-per-device rule lives here, in localStorage, next to `recentlyViewed.js`
 * which made the same choice for the same reason: the app does not track
 * visitors. It is the browser's own bookkeeping, so it is a marker and not a
 * lock — the honest reading of `view_count` is "how many devices said they read
 * this", deduplicated per device, with storage-free clients counted again.
 *
 * What it does stop is the everyday inflation: a refresh, a back-navigation,
 * React's double effect in development, and the fiftieth visit to the same
 * page, all of which used to be one more view.
 *
 * `store` and `send` are injectable so the decision is testable without a
 * browser or the axios client, and so a failed request can never surface in
 * the UI. Without storage (private mode, quota, prerender) the module still
 * remembers for the lifetime of the page, which covers the re-navigation cases.
 */

const KEY = 'espress0_viewed_counted';
const MAX = 1000;

/** Ids already counted in this browser. Anything malformed reads as "none". */
export function readCounted(store) {
  try {
    const raw = JSON.parse(store?.getItem?.(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id) => Number.isFinite(id)) : [];
  } catch {
    return [];
  }
}

/**
 * Should this item be announced as a view?
 *
 * No id or no slug means there is nothing to dedupe or report against (a
 * malformed or deleted entry), so it stays quiet rather than sending a request
 * the server would only 404.
 */
export function shouldCountView(item, counted) {
  const id = Number(item?.id);
  if (!Number.isFinite(id) || !item?.slug) return false;
  return !counted.includes(id);
}

/**
 * `counted` with `id` added, newest last, trimmed to the newest `max`.
 *
 * The Set is not an optimisation: a repeated id would be stored twice and the
 * list would grow on every page view, which is the one thing a marker meant to
 * stay small must not do.
 */
export function withCounted(counted, id, max = MAX) {
  const next = [...new Set([...(Array.isArray(counted) ? counted : []), id])];
  return next.length > max ? next.slice(next.length - max) : next;
}

function writeCounted(store, ids) {
  try {
    store?.setItem?.(KEY, JSON.stringify(ids));
  } catch {
    /* private mode or full quota: the in-memory set below still covers this page */
  }
}

// Fallback for a browser with no usable storage: remembers the current page
// load only, which is enough for back/forward and the double-mount in dev.
const inSession = new Set();

const defaultStore = () => globalThis.localStorage;

// api.js reads import.meta.env, which only exists under Vite, so it is loaded
// on demand: this module stays importable from a plain `node --test` process.
const defaultSend = (slug) => import('./api').then(({ default: api }) => api.post(`/items/${slug}/view`));

/**
 * Report one view of `item`, unless this browser already reported it.
 *
 * Returns whether a request went out. The request is fire-and-forget: a view
 * counter that can fail the page it is counting is a worse page.
 */
export function countView(item, { store = defaultStore(), send = defaultSend, seen = inSession } = {}) {
  const counted = readCounted(store);
  if (!shouldCountView(item, counted)) return false;
  const id = Number(item.id);
  if (seen.has(id)) return false;
  seen.add(id);
  writeCounted(store, withCounted(counted, id));
  Promise.resolve(send(item.slug)).catch(() => { /* counters are advisory */ });
  return true;
}
