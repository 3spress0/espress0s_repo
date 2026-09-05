/**
 * URL assertions for response bodies.
 *
 * These tests check *which host* a response points at, so they parse the URLs
 * they find instead of pattern-matching the body. A substring or unanchored
 * regex against a URL is satisfied by the wrong thing: a body containing
 * `https://evil.example/?next=secret.example.com` "matches" a
 * /secret\.example\.com/ check even though nothing is served from that host.
 * Comparing `new URL(...).host` cannot be fooled that way.
 */
const URL_IN_BODY = /https?:\/\/[^\s"'<>)\]},;]+/g;

/** Every absolute URL in a body, parsed. Unparseable matches are dropped. */
export function urlsIn(body) {
  return [...String(body).matchAll(URL_IN_BODY)]
    .map((m) => { try { return new URL(m[0]); } catch { return null; } })
    .filter(Boolean);
}

/** The distinct hosts referenced by absolute URLs in a body. */
export function hostsIn(body) {
  return new Set(urlsIn(body).map((u) => u.host));
}
