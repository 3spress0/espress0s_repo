# Bulk Catalogue Import / Export

Move large numbers of entries in and out of the repository as a `catalog.zip`
containing a single `catalog.json`.

Everything here is admin-only and lives behind `/api/admin/catalog/*`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/catalog/template` | A starter `catalog-template.zip` with two fully-populated example entries |
| `GET` | `/api/admin/catalog/export` | The current catalogue as a re-importable `catalog-<date>.zip` |
| `POST` | `/api/admin/catalog/import` | Upload an archive. **Preview only** unless `?apply=1` |
| `GET` | `/api/admin/catalog/imports?limit=50` | Import history, newest first |
| `GET` | `/api/admin/catalog/imports/:id` | One import, including its stored errors |
| `GET` | `/api/admin/catalog/imports/:id/errors?format=json\|csv` | Download the full validation error list |

Query parameters on import: `apply=1` to write, `mode=upsert|add-only|update-only`.

```bash
# 1. Preview — nothing is written
curl -b cookies.txt -F "file=@catalog.zip" \
  "https://repo.example.com/api/admin/catalog/import?mode=upsert"

# 2. Read the numbers, then apply
curl -b cookies.txt -F "file=@catalog.zip" \
  "https://repo.example.com/api/admin/catalog/import?mode=upsert&apply=1"
```

## Import modes

| Mode | Missing in the database | Already present |
| --- | --- | --- |
| `upsert` (default) | create | update |
| `add-only` | create | skip |
| `update-only` | skip | update |

## Identity and idempotency

`slug` is the identity of an entry. Importing the same slug twice updates the
existing row instead of creating a second one, so re-running an import is safe.

Matching tries the slug exactly as written first and then the normalised form.
That order matters: `makeSlug()` strips dots, so `7zip-18.06` normalises to
`7zip-1806`, and matching only the normalised form would duplicate every dotted
slug on each import.

## Format

```json
{
  "format": "espress0-catalog",
  "version": 1,
  "categories": [{ "name": "Operating Systems", "slug": "operating-systems" }],
  "folders": [],
  "items": [
    {
      "slug": "ubuntu-24-04-lts-desktop",
      "name": "Ubuntu 24.04 LTS Desktop",
      "description": "One-line summary, 5-1000 characters.",
      "long_description": "## Overview\n\nMarkdown, up to 200 000 characters.",
      "category": "operating-systems",
      "folder": null,
      "tags": ["linux", "ubuntu", "lts"],
      "platform": "linux",
      "architecture": "x64",
      "status": "current",
      "version": "24.04.1",
      "release_date": "2024-08-29",
      "file_name": "ubuntu-24.04.1-desktop-amd64.iso",
      "file_size": 5905580032,
      "file_type": "iso",
      "sha256": "…",
      "featured": false,
      "published": true,
      "license_status": "redistributable",
      "icon_url": "https://example.com/icon.png",
      "banner_url": "https://example.com/banner.png",
      "documentation_url": "https://ubuntu.com/tutorials",
      "external_url": "https://releases.ubuntu.com/24.04/",
      "links": [
        { "label": "Ubuntu releases", "storage_provider": "external",
          "download_url": "https://releases.ubuntu.com/24.04/ubuntu-24.04.1-desktop-amd64.iso",
          "is_primary": true, "sort_order": 0 }
      ],
      "related": [
        { "slug": "ubuntu-22-04-lts-desktop", "relation": "supersedes", "note": "Previous LTS" }
      ]
    }
  ]
}
```

`category` and `folder` are slugs and are created on demand, so an archive
written on one install imports cleanly on another.

`status` is one of `current`, `legacy`, `deprecated`, `archived`, `unreleased`.
It is a lifecycle marker and is independent of `published`: an entry can be
published and still be the deprecated release of a product line.

`related` links entries by slug. Relations: `related`, `supersedes`,
`superseded-by`, `variant`. Targets may appear later in the same archive.

## Images are never stored locally

`icon_url` and `banner_url` must be external `http(s)` URLs. A value such as
`/api/uploads/abc.png` is rejected, reported in the error list, and **not**
written — the rest of that entry still imports. Locally uploaded icons are also
omitted from exports, because they would not resolve on another install; the
export reports how many were left out.

## Errors

One bad entry never fails the archive. Each problem becomes a row in
`errors[]`, capped at 50 in the HTTP response and at 5 000 in storage, with the
complete list downloadable as JSON or CSV from the history endpoint. Whole-file
problems (no `catalog.json`, malformed JSON, duplicate slugs, a hostile archive)
are rejected outright and still recorded in the history as `rejected`.

## Safety

`backend/src/lib/zip.js` parses the archive itself rather than shelling out or
pulling in a general-purpose library, and enforces:

* entry-name checks — no absolute paths, drive letters, backslashes, `.` or `..`
  segments, empty segments or null bytes
* no symlinks or other non-regular files
* no ZIP64, no spanning, no encryption, only `stored` and `deflate`
* caps on entry count (1 000), per-entry inflated size (16 MB), total inflated
  size (32 MB) and compression ratio (1 000:1), all checked against the declared
  sizes *before* anything is inflated
* CRC-32 verification and a declared-versus-actual size check on every entry

The ratio cap is deliberately generous: the absolute caps are what bound the
damage, and a catalogue of repetitive Markdown legitimately reaches ~120:1.

## Transactions and backups

Two layers of protection, because they answer different questions.

**Transactions** answer "what if it fails halfway". An applied import runs inside
a single SQLite transaction, so a failure part way through a 2 000-entry archive
leaves the database exactly as it was. Every bulk edit does the same.

**Snapshots** answer "what if it succeeds and I was wrong". Before writing, the
service takes an online snapshot into `BACKUP_DIR`
(`pre-catalog-import-<id>-<timestamp>.db`) and records its path in the history
row. If the snapshot cannot be made, the import refuses to run — a change with
nothing to roll back to is a change not worth making. Set
`CATALOG_BACKUP=false` to skip snapshots (not recommended).

### Snapshots before bulk edits

`POST /api/admin/items/bulk` snapshots the database before any action that
rewrites rows (`delete`, `archive`, `tags`, `category`, `folder`, and the
single-field edits) and returns the path as `backupPath`. Publish/unpublish/
feature are one click to reverse, so they do not pay for a snapshot; `?backup=0`
opts out explicitly.

### Rolling back

```
GET  /api/admin/snapshots
POST /api/admin/snapshots/restore   { path, scope?, dryRun? }
```

`scope` is `catalogue` (default: categories, folders, tags, items, download
links, item_tags, relations) or `all` (adds FAQ, site settings, users, uploads).

A restore ATTACHes the snapshot and copies rows back inside one transaction
rather than swapping the file out from under an open connection, so a failure
leaves the database untouched instead of half-restored. Foreign keys are dropped
for the copy and re-enabled after; the FTS index is rebuilt so search matches the
restored rows. The path must resolve inside `BACKUP_DIR` and end in `.db`, and
the file must actually be an espress0 snapshot (it is checked for an `items`
table before anything is written).

Send `dryRun: true` to see the row counts first — **Admin → Backup** always does.

### Import history

`GET /api/admin/catalog/imports` lists one row per import, dry runs included,
with the admin who ran it (`imported_by_name`), when it started and finished, the
file name, size and SHA-256, the mode, per-bucket counts
(`items_created` / `updated` / `unchanged` / `skipped`, `relations_created`),
the error count, the result (`ok` / `failed` / `rejected`) and the snapshot path.
`GET /api/admin/catalog/imports/:id/errors?format=json|csv` downloads the stored
per-row errors. All of it is in **Admin → Catalogue**.

## Data model additions

* `items.banner_url` — external image URL
* `items.status` — lifecycle marker, defaults to `current`
* `item_relations` — curated links between entries
* `catalog_imports` — one row per import, dry runs included

Both new item columns are added by `ALTER TABLE` in `backend/src/db/index.js`,
so existing databases are migrated in place and every existing row is backfilled
to `status = 'current'`. Nothing is dropped and no existing row is rewritten.

### Indexes

Added for the admin filter and sort set:

| Index | Serves |
| --- | --- |
| `idx_items_status` | `?status=` |
| `idx_items_version` | `?version=` |
| `idx_items_release_date` | `?release_from` / `?release_to` |
| `idx_items_storage_provider` | `?storage_provider=` |
| `idx_items_updated` | the default sort (recently updated) |
| `idx_download_links_item_status` | `?link_health=` |

`platform`, `architecture`, `file_type`, `category_id`, `folder_id` and
`published` were already indexed.

**Ordering matters.** `SCHEMA_SQL` runs *before* the `ALTER TABLE` guards in
`db/index.js`, so an index on a column that only an ALTER adds (`status`, and
`item_download_links.status`) cannot live in `SCHEMA_SQL` — on a database that
predates the column it would fail with `no such column`. Those two are created
in the guarded block instead. `tests/migration.test.js` builds a genuine
pre-catalogue database from the original schema and asserts the upgrade
preserves its rows, so a regression here fails the suite rather than a
deployment.

## Managing the catalogue in the admin

Everything the bulk importer writes can also be managed by hand in
**Admin → File pages** and **Admin → Dashboard**.

### Searching, filtering and sorting

`GET /api/admin/catalog/search` runs the same FTS5 index as the public search
(`buildFtsQuery`, so tokens are sanitised the same way) and adds the admin-only
filter set. Every filter is a bound parameter; `sort` is allow-listed against a
column map, so a `?sort=` value can never reach the `ORDER BY` clause.

| Parameter | Values |
| --- | --- |
| `q` | free text (FTS5; falls back to `LIKE` if the MATCH expression is malformed) |
| `status` | `current`, `legacy`, `deprecated`, `archived`, `unreleased` |
| `platform`, `architecture`, `version`, `file_type` | exact (case-insensitive for platform/architecture/file_type) |
| `storage_provider` | `local`, `gdrive`, `onedrive`, `github`, `external` |
| `category`, `folder` | slug or numeric id; `folder=none` means unfiled |
| `tag` | matches the quoted JSON token, so `iso` does not match `isometric` |
| `release_from`, `release_to` | `YYYY-MM-DD`, and must be a real calendar date |
| `published` | `true` / `false` |
| `missing_images` | either artwork column empty |
| `missing` | `icon`, `banner`, `checksum`, `description`, `version`, `release_date`, `links` |
| `link_health` | `up`, `down`, `unknown`, `checking`, `missing` |
| `sort` | `name`, `slug`, `created_at`, `updated_at`, `release_date`, `file_size`, `download_count`, `view_count`, `status`, `version` |
| `order`, `page`, `limit` | `asc`/`desc`, 1-based, 1–500 (default 50) |

Each row is annotated with `link_health` (`missing` when the page has no
download links at all), `missing_icon` and `missing_banner`, so the table can
flag incomplete pages without a second request.

`GET /api/admin/catalog/facets` returns the distinct values that actually exist
for each filterable column, with counts, so the filter dropdowns never list a
value that matches nothing.

### Bulk edits

`POST /api/admin/items/bulk` takes `{ action, ids: [...], <field> }` — up to
500 ids, applied in one transaction so a bad id cannot leave the list
half-changed.

- Flags: `publish`, `unpublish`, `feature`, `unfeature`
- Destructive: `archive` (sets `status='archived'` **and** unpublishes — nothing
  is deleted), `delete`
- Field edits: `status`, `platform`, `architecture`, `version`, `icon_url`,
  `banner_url`, `tags`, `category`, `folder`

The new value goes under a generic `value` key, or under a key named after the
action (`{ action: 'tags', tags: 'a, b' }`); `folder` keeps its own `folderId`
so `null` can mean "remove from folder". A field edit with **no** value is
rejected with 400 rather than blanking the column across every selected row.
`tags` accepts an array or a comma-separated string and re-syncs the `item_tags`
junction table. `icon_url` / `banner_url` must be external http(s) URLs, matching
the importer's rule that images are never stored locally.

The UI routes archive and delete through a confirmation dialog first.

### Dashboard statistics

`GET /api/admin/catalog/stats` (also embedded in `GET /api/admin/overview` as
`catalog`) reports totals, the status spread, per-category/platform/
architecture breakdowns, quality gaps (missing icon, banner, checksum,
description, version, release date, download links), link-health counts and the
most recent catalogue import. Every figure in the dashboard links straight into
**File pages** with the matching filter already applied.

### Manual item creation

- The page URL follows the name as you type; `POST /api/admin/slugify` returns
  the slug the server would generate plus a collision-free alternative
  (`…-2`, `…-3`) when the plain one is taken, offered as a one-click fix next to
  the "already used" warning. Note `makeSlug` strips dots, so "24.04" becomes
  `2404` — the same reason the importer tries the raw slug before the
  normalised one.
- **Autofill from a public URL** (`POST /api/admin/metadata-autofill`,
  rate-limited) is optional and suggestion-only: it scrapes `og:`/`twitter:`
  meta, the title, version and release hints, platform/architecture/file-type
  hints, an icon and any checksums from the page, and the admin applies each
  field individually. Nothing is written by the request. It fetches through the
  SSRF-hardened client, so private, loopback and link-local addresses are
  refused with 400 `UNSAFE_URL`; responses are capped at 2 MB over 15 s.

### Related versions

`item_relations` is managed per item:

```
GET    /api/admin/items/:id/related
POST   /api/admin/items/:id/related   { relatedSlug | relatedId, relation, note? }
DELETE /api/admin/items/:id/related/:relationId
```

`relation` is one of `related`, `supersedes`, `superseded-by`, `variant`.
Self-relations are refused, and re-adding an existing pair updates its relation
and note instead of failing.

### Loading and progress

Searches, filters, bulk actions, health checks, dashboard loads and forms all
use the same loading treatment (`frontend/src/components/Loading.jsx`, which
drives `loading_dots_white.gif`). Long operations — bulk edits, autofill,
imports — report progress through `frontend/src/components/Progress.jsx`, which
shows a determinate bar when the caller knows the percentage and the standard
dots plus a pulsing track when it only knows that work is still running.

## Quality checks

Run from `backend/` and `frontend/` respectively:

```sh
npm test          # backend unit tests (node:test)
npm run lint      # ESLint, both packages
npm run build     # frontend production build
npm run audit     # npm audit, production dependencies
node tests/e2e-catalog.mjs   # end-to-end HTTP checks (needs a running server)
```

CI runs all of them: `test-backend` (lint then tests), `build-frontend` (lint
then build) and a `security` job that audits production dependencies in both
packages at `--audit-level=high`. `docker-build` waits on all three.

**On type checks:** this repository is plain JavaScript with no TypeScript and
no `tsconfig.json`, so there is no type checker to run. ESLint's `no-undef` and
`no-dupe-keys` catch the closest class of bug — identifiers that do not exist
and object literals where one key silently shadows another. Adding TypeScript is
a separate, much larger change; it was not folded into this work.

The ESLint configs are deliberately narrow (`eslint:recommended` plus a few
bug-finding rules). Both packages currently report zero errors and a few hundred
warnings, all of them unused variables in pre-existing code — they are left as
warnings so the linter can be introduced without rewriting working files.

### End-to-end setup

`tests/e2e-catalog.mjs` needs a server with a seeded database and the login
captcha off:

```sh
DATABASE_PATH=./data/e2e.db node src/db/migrate.js
DATABASE_PATH=./data/e2e.db node src/db/seed.js
DATABASE_PATH=./data/e2e.db PORT=3200 CAPTCHA_TYPE=disabled node src/index.js
```

The captcha gate is `CAPTCHA_TYPE=disabled`, not the `require_captcha` site
setting. The import endpoint is rate-limited to 10 requests per 5 minutes, and
the script makes 10 — so a second run against the same server fails with 429
until the window resets. Restart the server to clear it.

## Known issue in the seed data

`backend/src/db/seed-modern.js:99` defines `GH_REL` as a curried function, and
some entries store the function's source text instead of calling it. Roughly 680
rows end up with an `external_url` like `(v) => \`https://github.com/…\``. The
catalogue reports these on export and rejects those entries on import rather
than rewriting them. Fixing the seed data is a separate change.
