# espress0's repo

A lightweight, self-hosted software catalogue for applications, operating systems, ISOs, tools, drivers, documents, and other downloadable resources.

Built with **Fastify**, **SQLite + FTS5**, and **React**. The application stores catalogue metadata and external download links rather than acting as a file mirror.

## What it does

espress0's repo gives you a searchable catalogue with:

* Software, ISO, tool, driver, document, and archive entries
* Fast full-text search powered by SQLite FTS5
* Categories, folders, tags, platforms, architectures, and versions
* Markdown descriptions and cover images
* Multiple download/mirror links per item
* Checksums and file metadata
* Version history with diffs and restore
* Personal favourites, private by default and shareable per file
* Public account profiles showing what someone chose to share
* Link-health monitoring
* Admin management and bulk operations
* Backup, restore, import, and export
* Optional AI-assisted metadata and description generation
* Dark and light themes

The application is designed to run on small machines, including old PCs, Raspberry Pis, and small virtual machines. It uses a single Node.js application and SQLite database rather than requiring a large service stack.

## Quick start

Requirements:

* Node.js 20+
* npm

Clone the repository:

```bash
git clone https://github.com/3spress0/espress0s_repo.git
cd espress0s_repo
```

Run the setup wizard:

```bash
./espress0 setup
```

The wizard configures the application, database, administrator account, optional AI integration, and runtime settings.

Start the application:

```bash
./espress0 serve
```

Check its status:

```bash
./espress0 status
```

## The `espress0` CLI

The repository uses `./espress0` as the main command-line entry point.

| Command             | Purpose                               |
| ------------------- | ------------------------------------- |
| `./espress0 setup`  | Initial setup                         |
| `./espress0 config` | Change configuration                  |
| `./espress0 dev`    | Development mode                      |
| `./espress0 serve`  | Run the application in the background |
| `./espress0 update` | Update the installation               |
| `./espress0 deploy` | Deploy to an Ubuntu server            |
| `./espress0 backup` | Create backups                        |
| `./espress0 db`     | Database utilities                    |
| `./espress0 ai`     | AI configuration/utilities            |
| `./espress0 scan`   | Security scanning                     |
| `./espress0 test`   | Run tests                             |
| `./espress0 status` | Show application status               |

Run:

```bash
./espress0 help
```

for the complete command list.

## Catalogue

Each catalogue entry can contain information such as:

* Name and version
* Stable slug
* Category and folder
* Description
* Release date
* File name and size
* Platform and architecture
* Tags
* Checksums
* License information
* External download links
* Related versions
* Icon and banner URLs

The catalogue is intended to describe software and resources, not to become a general-purpose file-hosting service.

## Search

Search uses **SQLite FTS5** for fast full-text queries.

Catalogue entries can be filtered and sorted by metadata such as category, folder, tags, platform, architecture, date, size, downloads, and views.

## Link health

External download and mirror links can be checked automatically.

The health system supports:

* Per-link status
* Manual checks
* Periodic checks
* Redirect handling
* Timeout handling
* SSRF protection
* Administrative "mark down" controls

Health checks run separately from normal catalogue browsing so an unavailable external server does not unnecessarily block the application.

## Accounts and favourites

### Two-factor authentication

Any account can add a TOTP second factor from **Account → Security**: scan the QR code with an authenticator app (Aegis, 1Password, Google Authenticator, …), confirm one code, and save the ten single-use recovery codes that are shown once. From then on the login form asks for a code after the password. Turning it off again needs the password *and* a current code.

Admins can make it mandatory for admin accounts with **Site Settings → Require two-factor auth for admins**: an admin who has not enrolled can only reach their Account page until they do. Codes accept ±30 s of clock drift and a code is never accepted twice. Secrets are encrypted at rest; recovery codes are stored hashed.

Every signed-in account can star a file from its page. Favourites are **private by default**: starring is a personal bookmark, not a publication.

Sharing is a second, deliberate step, and it can be taken two ways:

* per file — flip a single favourite to *Shared* in **Account → Favourites**
* by default — tick *New favourites start shared* so future stars begin public

Turning the default off never un-shares anything you already published; each favourite keeps the setting you gave it.

Anything shared shows on a public profile at `/u/username`, which anyone can open without logging in. It lists the account's avatar, bio, role, join date and shared files — and nothing else:

* no email address is ever returned by the profile endpoint
* only favourites flagged shared by their owner appear
* drafts never appear, so a shared favourite is not a back door into an unpublished file
* only card-level data is returned, so no mirror URL or storage path leaves with it

Admins can open any account's public profile straight from **Admin → Users**.

The API:

| Method   | Route                                | Purpose                                  |
| -------- | ------------------------------------ | ---------------------------------------- |
| `GET`    | `/api/favorites`                     | Your own list, private and shared         |
| `POST`   | `/api/favorites`                     | Star a file (`item_id` or `slug`)         |
| `PATCH`  | `/api/favorites/:itemId`             | Share or unshare one favourite            |
| `DELETE` | `/api/favorites/:itemId`             | Unstar                                    |
| `GET`    | `/api/users/:username`               | Public profile                            |
| `GET`    | `/api/users/:username/favorites`     | The favourites that account shared        |

Favourites belong to the database rather than the catalogue, so a full snapshot restore rolls them back with everything else, while a catalogue-only rollback keeps them — an undo after a bad bulk edit does not cost everyone their stars.

## Analytics dashboard

**Admin → Analytics** (`GET /api/admin/analytics?days=7|30|90|365`, admin
only) charts what the app already records - no extra tracking is added:

- pages created/updated per day, and the event log (`item.*`, `link.down` /
  `link.recovered`, `review.created`, `import.completed`) as daily series;
- downloads: top entries, by category, by platform and by storage provider;
- reviews: status counts, average rating, top rated, new reviews per day;
- users by role, sign-ups per day, favourites and subscriptions;
- mirror health, webhook deliveries, import runs and the in-process request
  metrics (the deeper process view stays under Monitoring).

## Torrent and magnet mirrors

A mirror can be a torrent: choose **Torrent / magnet** as the provider (or
just paste a `magnet:?xt=urn:btih:…` link - the editor and the import
pipeline detect it) and put the magnet URI or an http(s) `.torrent` URL in
the download URL. Rules:

- magnet links must carry a BitTorrent info-hash (`btih` or `btmh`) and only
  URL-safe characters; anything else is rejected at validation time;
- a magnet URL on any other provider is coerced to `torrent`, so it is never
  handed to an http-only storage adapter;
- the download endpoint returns the magnet as-is (the browser opens the
  user's torrent client); it is never used as an HTTP redirect target for
  non-torrent mirrors;
- the link checker skips magnets ("cannot be probed") instead of marking
  them down; `.torrent` URLs are probed like any other link;
- existing databases are migrated once at start-up (the mirror table's
  `CHECK` constraint is rebuilt; rows, counters and indexes are preserved).

Nothing is seeded or hosted by espress0 - it only stores the link.

## Similar software

Every published entry shows a "Similar software" block
(`GET /api/items/:slug/similar`, add `?ai=0` to skip the model). The list is
built in two layers:

1. **Deterministic scoring** over the catalogue: curator-made relations
   (Admin → related items) weigh most, then shared tags, same category,
   same platform, and an FTS5 match on name + description. This alone is the
   answer when no AI provider is configured, when it errors, or when it times
   out - the response carries `usedAI: false` and the page shows
   "catalogue match".
2. **Optional AI rerank**: the configured provider receives only the
   candidate pool (id, name, one line) and may reorder it and add a short
   reason. It cannot add entries - unknown ids are dropped - so it never
   points at software the archive does not have.

Results are cached for ten minutes per entry and flushed on any item write.

## Ratings and reviews

Signed-in users can rate any published entry from 1 to 5 stars and leave an
optional comment (up to 2000 characters). One review per user per entry;
saving again replaces the previous one. The aggregate (`average`, `count`,
histogram) is shown on the entry page and included in the public JSON API.

Spam protection, all server-side:

- accounts younger than `REVIEW_MIN_ACCOUNT_MINUTES` (default 10) cannot post;
- at most `REVIEW_MAX_PER_DAY` (default 20) reviews per account per day, plus a
  per-IP rate limit on the write endpoints;
- comments with more than 2 links are rejected; comments with any link are
  held as **pending** until an editor approves them;
- the same comment text pasted onto several entries is rejected.

Editors and admins moderate from **Admin → Reviews** (approve / hide / delete).
A hidden review stays hidden even if its author edits it. Every new review
emits a `review.created` event, so webhooks can be notified.

## Drafts and preview links

An entry with *Published* off is a draft: invisible to visitors (404, not
403), listed only for staff, never in the public API or feeds. Drafts already
save version history, so staging edits on a draft and publishing later is the
normal flow. To show a draft to someone without an account, editors use
**Copy preview link** (on the entry page banner or in the editor): a signed,
expiring link (`/file/<slug>?preview=<token>`, 7 days) that renders the page
read-only - download URLs and paths are stripped, downloads still require a
session, and preview views are not counted. Tokens are HMACs over the entry
id and expiry keyed by `JWT_SECRET`, so nothing is stored and rotating the
secret invalidates every link. API: `POST /api/items/:id/preview-link`
`{ ttl_hours }` (max 720).

## Recently viewed

The home page and Account → Favourites show the last twelve entries you
opened. This list lives in `localStorage` only - the server keeps a bare
`view_count` per entry and never records who viewed what - and has a Clear
button. Favourites, by contrast, are stored on the account and can be public.

## Public API

`/api/v1` is a versioned, read-only JSON API for scripts and third-party tools. It is separate from the endpoints the web UI uses: it only ever returns **published** entries (no session is read, so no draft branch exists), never includes download URLs or encrypted fields, and has its **own rate-limit bucket** (`PUBLIC_API_RATE_LIMIT`, default 60 requests per minute per IP, `PUBLIC_API_RATE_WINDOW` to change the window) so an integration cannot starve a browser session on the same IP or vice versa. `GET` is allowed from any origin.

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1` | version, limits, endpoint list |
| `GET /api/v1/items` | paginated list; filters `q`, `category`, `folder`, `tag`, `platform`, `architecture`, `file_type`, `license_status`, `featured`, `updated_since`, `sort`, `order`, `page`, `limit` (≤100) |
| `GET /api/v1/items/{slug\|id}` | one entry with mirrors (label, provider, health) and relations; supports `If-None-Match` |
| `GET /api/v1/categories`, `/folders`, `/tags` | taxonomies with published item counts |
| `GET /api/v1/search?q=` | alias of `/items?q=` |
| `GET /api/v1/changes?since=&limit=` | recent create/update/publish/link-status events |
| `GET /api/v1/stats` | totals |

Downloads are not part of the public API by design: each entry carries `download_url_api` (`/api/download/{id}`), which needs a signed-in session as in the UI. The full schema is in `/api/docs` under *Public API*.

## RSS / Atom feeds

Public, published-only, on the same rate-limit bucket as the JSON API:

| Feed | RSS | Atom |
| --- | --- | --- |
| New entries | `/api/v1/feed.rss` | `/api/v1/feed.atom` |
| Change log (created / updated / published / link status) | `/api/v1/feed/changes.rss` | `/api/v1/feed/changes.atom` |

Entry feeds take `?category=`, `?folder=`, `?tag=` and `?limit=` (≤200). Links
are absolute: set `PUBLIC_URL=https://repo.example.com` in `.env` when the app
sits behind a proxy that does not forward the host, otherwise the request host
is used. The pages advertise the feeds with `<link rel="alternate">`, so feed
readers can discover them from the site URL.

## Webhooks and events

Everything notable that happens to the catalogue is written to an event log and can be pushed to a URL of your choice:

| Event | When |
| --- | --- |
| `item.created` / `item.updated` / `item.deleted` | a file page is written (payload lists the changed fields) |
| `item.published` / `item.unpublished` | a draft goes live, or a live page is pulled |
| `link.down` / `link.recovered` | the link checker sees a mirror change state (transitions only, never repeats) |
| `review.created` | a user posts a new rating/review (payload: item summary, rating, status) |
| `import.completed` | a catalogue import was applied |

**Admin → Webhooks** manages site-wide hooks; **Account → Security** has personal hooks, which only receive events about public file pages. Each delivery is a JSON `POST` with `X-Espress0-Event`, `X-Espress0-Delivery` and `X-Espress0-Signature: sha256=<HMAC-SHA256 of the body with the hook's secret>`. Non-2xx responses retry after 1, 5, 15, 60 minutes and 6 hours; every attempt is logged and can be redelivered by hand. Payloads never contain download URLs or encrypted fields. Target URLs must be public (set `WEBHOOK_ALLOW_PRIVATE=true` to allow LAN receivers such as a local n8n).

`GET /api/admin/events` exposes the raw log.

## Following entries and tags

Signed-in users can **Follow** an entry (button on its page) or a tag (from the
entry page or Account → Notifications). Following on its own is a filter: a
personal webhook created with scope *"only entries and tags I follow"*
(`filter_mode: "subscribed"`) receives just those `item.*` / `link.*` events;
hooks with the default scope keep receiving everything public. Site-wide admin
hooks cannot be scoped this way. API: `GET/POST /api/subscriptions`,
`DELETE /api/subscriptions/:id`, `GET /api/subscriptions/status/:slug`.

## Import and export

The catalogue supports backup and metadata import/export workflows.

Imports support:

* Dry-run validation
* Upsert by slug
* Existing-entry updates
* Validation errors and warnings
* Safe processing of untrusted input

Backups can be used to restore catalogue data when necessary.

## Keyboard shortcuts

`Ctrl/⌘ K` (or `/`) opens the command palette: live catalogue search plus
navigation, theme, language and admin commands filtered by role. `g` then
`h` / `b` / `f` / `a` jumps to home, Browse, favourites, Admin; `?` lists all
shortcuts. Nothing fires while typing in a field; `Ctrl/⌘ S` still saves in
the item editor.

## Languages

The interface has a small, dependency-free i18n layer (`frontend/src/i18n/`).
Strings live in `locales/<code>.json` (English is the source of truth;
Dutch ships as the first translation); components call `const { t } = useI18n()`
and `t('nav.browse')`, with `{{placeholders}}` and a `_plural` key for counts.
The active language follows the browser and can be overridden from the navbar
or Account → Appearance (stored per browser). Dates and numbers use `Intl`
for the active locale. Catalogue content is not translated. To add a language,
copy `en.json`, translate it, and register it in `i18n/index.jsx`;
`npm test` in `frontend/` checks every locale has the same keys as English.
Only the navigation, log-out dialog and item page headings are wired so far;
the rest of the UI is still literal English and can be migrated file by file.

## Administration

The admin interface provides management for:

* Catalogue entries
* Categories
* Folders
* Users
* Settings
* Storage configuration
* Monitoring
* AI configuration

Version history is available for catalogue pages, including snapshots, diffs, and restore operations.

### Roles

Every account has one of three roles, set from **Admin → Users**:

| Role | Can |
| --- | --- |
| `viewer` | Sign in, download, favourite, edit their own profile. The default for new registrations. |
| `editor` | Everything a viewer can, plus: create and edit file pages and their mirrors, categories and folders, upload images, use the AI drafting helpers, see drafts. Editors open `/admin/items` and see only the content areas. |
| `admin` | Everything: delete, bulk edits, users, settings, storage, backups, imports, monitoring. |

On the API, the requirement is visible per route in `/api/docs` ("Requires role: editor or admin"). Requests without a session get `401`; a signed-in account below the required role gets `403` with `requiredRole` in the body.

## AI

AI is optional.

The application can use:

* Google Gemini
* OpenAI-compatible APIs
* The `tgpt` command-line client
* No AI provider at all

The AI layer is designed as an optional service. Without an AI provider, the catalogue continues to work and deterministic metadata/template fallbacks can still be used.

Example Gemini configuration:

```env
AI_PROVIDER=gemini
AI_API_KEY=your_api_key
AI_MODEL=your_model
```

For more AI configuration options, see `SETUP.md`.

## Deployment

### Ubuntu server

The repository includes a deployment script that can configure:

* Node.js
* Dependencies
* SQLite/database migrations
* systemd
* nginx
* HTTPS with Let's Encrypt

Example:

```bash
sudo ./espress0 deploy \
  --repo https://github.com/3spress0/espress0s_repo.git \
  --domain repo.example.com \
  --https
```

The deployment keeps the application behind nginx while the Node.js application runs locally.

### Docker

Docker Compose configuration is also included:

```bash
docker compose up -d --build
```

See `SETUP.md` and `DEPLOYMENT.md` for detailed deployment instructions.

## Running in the background

For machines accessed through SSH, the built-in tmux runner keeps the application alive after disconnecting:

```bash
./espress0 serve
```

Useful commands:

```bash
./espress0 serve status
./espress0 serve logs
./espress0 serve stop
```

You can also attach directly to the tmux session:

```bash
tmux attach -t espress0
```

The repository also includes an automatic updater that fetches new commits, builds them off to the side, runs migrations, restarts the application, and rolls back a failed update — including the database, which is snapshotted before forward-only migrations run.

The updater will not deploy over an application it cannot restart. It detects the supervisor (systemd unit for this checkout, or a tmux session) before touching anything, and aborts if it finds none, because swapping files under a still-running process leaves the code on disk and the code in memory on different commits. It confirms success by reading the commit that `/api/health` reports — captured when the process started — so an old process cannot pass the check just because the files changed. Use `--no-restart` for a deliberate offline, file-only deploy.

## Project structure

```text
backend/
  src/
    routes/
    services/
    db/

frontend/
  src/
    pages/
    components/
    themes/

scripts/
systemd/
```

The backend contains the Fastify API, services, database logic, search, AI integration, storage handling, versioning, and link-health functionality.

The frontend contains the React application, public catalogue pages, administration interface, components, and themes.

## Security

Security is a core part of the project.

The application includes protections such as:

* HTTP-only SameSite cookies
* CSRF protection
* Rate limiting
* bcrypt password hashing with pepper
* Encrypted sensitive data
* Content Security Policy via Helmet
* SSRF protection for outbound requests
* Input validation
* Authentication and authorization controls

See `SECURITY-AUDIT.md` for the project's security documentation.

## Documentation

| File                | Description                          |
| ------------------- | ------------------------------------ |
| `README.md`         | Project overview and quick start     |
| `SETUP.md`          | Local installation and configuration |
| `DEPLOYMENT.md`     | Server deployment                    |
| `CATALOG.md`        | Catalogue/import/export format       |
| `THEME.md`          | Themes and visual configuration      |
| `SECURITY-AUDIT.md` | Security documentation               |
| `/api/docs`         | Live OpenAPI reference (`/api/docs/json`, `/api/docs/yaml`) |

## Storage model

The application does not need to host every file itself.

Supported storage/link types include:

* Google Drive
* OneDrive
* GitHub release assets
* Direct external URLs

The application stores the relevant metadata and resolves the configured external download destination when a user downloads an item.

## Contributing

Contributions are welcome.

Before submitting changes:

```bash
./espress0 test
```

and verify that the application still builds correctly.

For larger changes, keep the existing architecture and avoid introducing unnecessary services or dependencies.

## License

Copyright (c) 2026 Esper. All rights reserved. See `LICENSE`. This is a personal project; no permission to use, copy, modify or distribute is granted.

Catalogue entries may link to third-party software. A catalogue entry or external link does not grant redistribution rights. Always respect the original software's license and distribution terms.
