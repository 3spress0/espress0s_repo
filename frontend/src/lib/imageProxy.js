/**
 * Load third-party-hosted images without sharing the visitor with the host.
 *
 * Cover art and avatars in the catalogue can point at arbitrary hosts (CDNs,
 * wikis, vendor sites). An <img src> straight at one of those URLs lets the
 * third party see the visitor's IP and set its own cookies - tracker blockers
 * flagged exactly that on cdn.jsdelivr.net and upload.wikimedia.org.
 *
 * So every cross-origin image URL is routed through the backend's cookieless
 * fetcher (/api/media/image), which is same-origin to the page: no cookies,
 * no referer, no request ever leaves for a third party from the browser.
 * Anything already same-origin, relative, or non-http (data:, blob:) passes
 * through untouched, including upload URLs served by this app itself.
 */

export function proxyImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return url; // relative, data:, blob:
  try {
    const origin = typeof window !== 'undefined' ? window.location?.origin : null;
    if (origin && new URL(trimmed).origin === origin) return url;
  } catch {
    return url; // malformed: let the <img> fail visibly rather than proxy junk
  }
  return `/api/media/image?u=${encodeURIComponent(trimmed)}`;
}
