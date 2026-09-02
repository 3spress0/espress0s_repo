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

An applied import runs inside a single SQLite transaction, so a failure part way
through a 2 000-entry archive leaves the database exactly as it was. Before
writing, the service takes an online snapshot into `BACKUP_DIR`
(`pre-catalog-import-<id>-<timestamp>.db`) and records its path in the history
row. If the snapshot cannot be made, the import refuses to run. Set
`CATALOG_BACKUP=false` to skip snapshots (not recommended).

## Data model additions

* `items.banner_url` — external image URL
* `items.status` — lifecycle marker, defaults to `current`
* `item_relations` — curated links between entries
* `catalog_imports` — one row per import, dry runs included

Both new item columns are added by `ALTER TABLE` in `backend/src/db/index.js`,
so existing databases are migrated in place and every existing row is backfilled
to `status = 'current'`.

## Known issue in the seed data

`backend/src/db/seed-modern.js:99` defines `GH_REL` as a curried function, and
some entries store the function's source text instead of calling it. Roughly 680
rows end up with an `external_url` like `(v) => \`https://github.com/…\``. The
catalogue reports these on export and rejects those entries on import rather
than rewriting them. Fixing the seed data is a separate change.
