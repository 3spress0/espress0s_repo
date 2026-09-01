# Security audit — 2026-09

A read-through of the backend and frontend looking for exploitable bugs, plus
the fixes that came out of it. Everything listed under *Fixed* is in the tree;
everything under *Known gaps* is deliberate and documented.

Test the SSRF guard (no database or native modules needed):

```bash
cd backend && node --test tests/ssrf.test.js
```

---

## Fixed

### 1. Unpublished items were fully public — **high**

`GET /api/items?published=0`, `GET /api/items/:slug` and
`GET /api/items/:id/links` had no publication check. Anyone could list every
draft and read its **decrypted** `download_url`, `storage_path`,
`external_url` and `license_notes` — the fields that are encrypted at rest
precisely because they are sensitive. Unreleased material leaked before it was
ever published.

*Fix*: all three routes now run `optionalAuthenticate` and only admins may see
drafts. Non-admins get `404` (not `403`, which would confirm the slug exists),
`?published=0` is ignored for them, and draft views no longer bump
`view_count`. `GET /api/preview/info/:id` got the same treatment.

### 2. Server-side request forgery in the preview route — **high**

`GET /api/preview/:id` called `fetch(downloadUrl)` on a URL read from the
database and streamed the response back to the caller. Any logged-in user
could turn the server into a proxy for `http://169.254.169.254/…` (cloud
metadata, i.e. instance credentials), `http://127.0.0.1:*` (admin panels bound
to loopback) or anything on the LAN, and redirects were followed blindly.

*Fix*: new `backend/src/lib/safeFetch.js`. It enforces http/https only, no
credentials in the URL, no blocked ports, and rejects any target whose
resolved addresses fall in loopback/private/link-local/CGNAT/multicast ranges
(IPv4 and IPv6, including `::ffff:` mapped forms). Redirects are followed
manually, max 3 hops, each hop re-validated, and the body is streamed against
a hard byte ceiling so a lying `Content-Length` cannot exhaust memory.
Upstream error text is no longer echoed to the client.

### 3. Stored XSS via SVG upload — **high**

`POST /api/admin/uploads` accepts SVG, and `GET /api/uploads/:storedName`
served it from the app's own origin as `image/svg+xml` with no CSP and no
`nosniff`. An SVG is a document: `<script>` inside it runs with full access to
the origin, and the session token lives in `localStorage`.

*Fix*: three layers.
* Uploaded SVGs are rejected when they contain `<script>`, `<foreignObject>`,
  `<iframe>`, `<embed>`, `<object>`, external `<use href>`, `on*=` handlers,
  `javascript:` or a DTD entity.
* Every uploaded file is served with `Content-Security-Policy: default-src
  'none'; … sandbox`, `X-Content-Type-Options: nosniff`, `X-Frame-Options:
  DENY` and `Referrer-Policy: no-referrer`; SVGs additionally get
  `Content-Disposition: attachment` (still renders in `<img>`, but a direct
  hit downloads instead of executing).
* A site-wide CSP now applies (see 6).

### 4. JWT handling — **medium**

* `jwt.verify` ran without an `algorithms` list, so the token header decided
  the algorithm. Now pinned to `HS256`.
* Every authenticated route accepted `?token=…`. Query strings end up in
  access logs, browser history and `Referer` headers, and it made mutating
  endpoints reachable by a plain link. The query token is now only honoured on
  `GET /api/download/*` and `GET /api/preview/*` (which are opened as real
  navigations), or where a route opts in with
  `config: { allowQueryToken: true }`.
* Changing a password left every previously issued token valid for up to
  7 days. Tokens now carry a `pwv` fingerprint of the stored password hash;
  when the hash changes the old tokens stop verifying. Tokens issued before
  this change have no `pwv` and keep working until they expire.

### 5. Session cookies were never `Secure` — **medium**

`secure: false` was hardcoded with a `// set true in prod` comment, so the
session cookie travelled in clear text on any plain-HTTP hop. It now follows
`config.security.cookieSecure` (on by default when `NODE_ENV=production`,
overridable with `COOKIE_SECURE`).

### 6. No Content-Security-Policy — **medium**

`contentSecurityPolicy: false` was passed to helmet. The policy is now
explicit (`useDefaults: false`, so a helmet upgrade cannot silently change it):
`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
`base-uri 'self'`, `form-action 'self'`, `script-src 'self'` plus the sha256
hash of the inline theme-bootstrap script (computed from
`frontend/dist/index.html` at boot, so no `'unsafe-inline'`), and
`img-src`/`media-src` left open to `https:` because cover images and mirrors
legitimately point anywhere. HSTS is enabled in production.

### 7. Development secrets could reach production — **medium**

`JWT_SECRET` fell back to a value that is in the repository; with it, anyone
can mint an admin token. `ENCRYPTION_KEY` and `PASSWORD_PEPPER` were derived
from that same fallback.

*Fix*: `assertProductionSecrets()` runs at boot. In production it **refuses to
start** when `JWT_SECRET`, `ENCRYPTION_KEY`, `PASSWORD_PEPPER` or
`ADMIN_PASSWORD` are missing/default, when `JWT_SECRET` is under 32 characters,
or when `CORS_ORIGIN` is `*` alongside credentialed requests. In development it
prints the same list as a warning.

### 8. `javascript:` URLs accepted and rendered — **medium**

`itemSchema` used `z.string().url()` for `download_url`, `external_url` and
`documentation_url`, and `profileSchema` for `avatar_url`. `z.string().url()`
accepts `javascript:alert(1)`. Those values are rendered into `href`s and used
as redirect targets.

*Fix*: all of them now require http(s) (or an app-relative path where that
makes sense). Defence in depth on the way out too: `/api/download/*` refuses to
redirect to a non-http(s) URL, and the frontend has a shared `safeHref()` used
by `startDownload()`, the markdown renderer and the settings-driven footer.

### 9. Shell-out to `tgpt` — **medium**

`aiService` built `cat /tmp/tgpt-prompt-<timestamp>.txt | tgpt --provider <env>
--quiet` and ran it through a shell. The temp filename was predictable in a
world-writable directory (a local user could pre-create a symlink and either
clobber a file we write or swap the prompt), and the provider came from the
environment straight into the command string.

*Fix*: `runTgpt()` uses `spawn(binary, args, { shell: false })` and writes the
prompt to stdin — no shell, no temp file. The provider name is validated
against `/^[a-zA-Z0-9_.-]{1,32}$/`, output is capped, and the child is
SIGKILLed on timeout. `which tgpt` / `--version` use `execFile`.

### 10. Unauthenticated, unmetered AI endpoint — **low/medium**

`GET|POST /api/ai/ask` is public and spawns a subprocess per call, under only
the global 100-per-15-minutes limit. Now 15 per 5 minutes per IP with the
question clamped to 500 characters.

### 11. FTS5 query injection and search DoS — **low**

`buildFtsQuery()` wrapped raw tokens in double quotes: a token containing `"`
broke out of the phrase and could inject FTS operators or unbalanced syntax
(500 via the fallback path). Levenshtein ran on unbounded input.

*Fix*: tokens are stripped to letters/digits/`._-`, the query is clamped to 128
characters and 12 tokens, Levenshtein short-circuits above 64 characters, and
`page`/`limit` are parsed with bounds so `NaN` can no longer reach
`LIMIT`/`OFFSET`.

### 12. Smaller things

* Registration probed for existing usernames/emails *before* checking
  `ALLOW_REGISTRATION`, making a disabled endpoint an account oracle. The check
  moved to the top.
* `download_count` was incremented before the URL was resolved, so failures
  counted as downloads. It now increments once a URL is actually returned.
* `PREVIEW_DIR` was `path.resolve('./data/previews')` — relative to the working
  directory, so a systemd unit started from `/` wrote the cache to the
  filesystem root. It is now anchored to the module path and overridable with
  `PREVIEW_DIR`.
* Public health check echoed the raw database error (which can contain the file
  path); it now logs the detail and returns `Database unreachable`. Same for
  download-URL resolution failures and the AI route.
* `/api/search/suggestions` called `.toLowerCase()` on `request.query.q`, which
  is an array when the parameter is repeated (`?q=a&q=b`) → 500. Coerced.
* Missing `rel="noopener noreferrer"` added to the remaining `target="_blank"`
  links.

---

## Known gaps (accepted, for now)

* **Token in `localStorage`.** The API client reads
  `localStorage.espress0_token`, so an XSS would still be able to steal a
  session even though an httpOnly cookie is also set. Moving to cookie-only
  auth means adding CSRF tokens to every mutating call; the CSP plus the SVG
  and URL fixes above remove the vectors we found instead. Cookies are
  `SameSite=Lax`, so cross-site POSTs do not carry them.
* **Login lookup by email is O(users).** When the `email_hash` lookup misses,
  the login path decrypts every user row to compare addresses. Fine for a
  personal archive, a CPU sink at scale.
* **User enumeration on register.** Distinct "Username already exists" /
  "Email already exists" responses are kept because they are genuinely useful
  in a small private instance.
* **DNS rebinding.** `safeFetch` validates resolved addresses, then Node's
  `fetch` resolves again; there is a small window where a hostile resolver
  could return a public address first and a private one second. Node's fetch
  has no `lookup` hook to close it.
* **Admin trust.** Admins can store arbitrary http(s) URLs and markdown. The
  renderer builds React elements (never `dangerouslySetInnerHTML`) and URLs are
  scheme-checked, so this is a redirect/link-quality question, not code
  execution.
