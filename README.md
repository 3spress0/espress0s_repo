# espress0's repo

A self-hosted catalogue for software, ISOs, tools and documents: a Fastify
API with SQLite/FTS5 search and a React frontend, no containers or external
services required. Files themselves live with external providers (Google
Drive, OneDrive, plain URLs); the app stores only metadata and redirects.

Built to run on the smallest machine you own — an old laptop, a Raspberry Pi
or a 1 vCPU VM. One Node process, one SQLite file, zero memory-hungry
services.

Requires Node 20+. Everything else ships in the repo or is installed by the
setup script.

## Start here

```bash
git clone <your-repo> espress0s-repo
cd espress0s-repo
./espress0 setup
```

`./espress0` is the single entry point for every command:

| Command | What it does |
| --- | --- |
| `setup` | First run installs everything. The wizard asks for admin login, port, network exposure, AI and how to run. Any `--flag` keeps it scriptable. |
| `config` | Re-run the same wizard on a configured machine (after its first run, `scripts/setup.sh` renames itself to `scripts/config.sh`). |
| `dev` | Backend on :3000 + Vite dev server on :5173. `--build` serves the production build from :3000 only. |
| `serve` | Keeps the app running in tmux (survives logout), with an auto-update window. Options: `dev`, `status`, `stop`, `logs`. |
| `update` | Auto-updater: builds the next commit off to the side, then stop → swap → migrate → restart → health check, rolling back if the site stays down. `--once` for cron. |
| `deploy` | Full Ubuntu server install (root): systemd, nginx, certbot HTTPS. |
| `backup`, `db`, `ai`, `scan`, `test`, `status` | Backup/seed/install the optional tgpt CLI/security probe/tests/dashboard. |

`./espress0 help` prints the same list. Each command calls the matching
script in `scripts/`, so direct script usage keeps working.

## Features

- Pages per file (`/file/<slug>`) with markdown body, cover images,
  multiple mirror links, checksums and platform/architecture metadata.
- Search with SQLite FTS5 and typo-tolerant reranking; filters for
  category, folder, tag, license, file type, platform and architecture;
  sorting by date, name, size, downloads, views.
- Folders (admin-defined groupings) alongside categories; bulk assign.
- Version history for every page: 50 snapshots, diff preview, one-click
  restore.
- Mirror health: HEAD-probes with SSRF protection, per-link status, manual
  and periodic sweeps, "mark down" from the admin panel.
- Backup & restore: full JSON export, dry-run import preview, upsert by slug.
- Admin panel for pages, categories, folders, users, settings, storage and
  monitoring.
- AI helpers (Gemini key, any OpenAI-compatible endpoint, or the free tgpt
  CLI): a metadata-first "Ask" assistant and a one-click description drafter;
  both fall back to deterministic templates with no model configured.
- Themes: 9 dark/light palettes switchable from the navbar, admin-set site
  default.
- Seeded catalog (`backend/src/db/seed-catalog.js`, `seed-modern.js`,
  `seed-archive.js`): **100k+ entries** across Windows and Linux -- distro
  ISOs (Ubuntu, Fedora, Debian, Mint, Arch, Alpine, Kali, rescue/live images,
  retro OS corner), Windows media, drivers and firmware, flagship desktop apps
  with per-version history, CLI tools, fonts, portable apps, open-source games
  and documentation. The modern wave adds AI/LLM tooling (ollama, llama.cpp,
  LM Studio, ComfyUI, Claude Code, aider), current editors/IDEs, cloud-native
  and IoC tooling, plus release archives for npm/PyPI/crates/Maven/NuGet and
  daily nightly-build snapshots. Everything lands in folders with
  deterministic slugs; re-running the seeder is a no-op.
- Legacy/abandonware corner: Windows 1.0 through 2000 and Office 95-2000 with
  written histories and the generic installation keys documented by the
  preservation community (these releases predate activation and are no longer
  sold or supported). XP-era and later ships no keys; an entry also lists
  Microsoft's officially published KMS client setup keys (GVLK) as reference.

## Security

Sessions live in an httpOnly, SameSite=Lax cookie (never localStorage) with a
double-submit CSRF token on mutations. Passwords are bcrypt+pepper; emails
are AES-encrypted at rest. Login is captcha-gated and rate-limited; "log out
all devices" and password changes invalidate old tokens. The cookie `Secure`
flag adapts to the transport (HTTPS logins keep it; plain-HTTP logins drop
it, with a log warning, because browsers would otherwise refuse to store the
cookie at all). Helmet CSP, SSRF-guarded outbound fetches, strict input
validation with zod throughout. See `SECURITY-AUDIT.md` for the full list.

## Running it

Local machine or LAN box:

```bash
./espress0 serve            # background, includes the auto-updater
./espress0 status           # everything at a glance
```

Ubuntu server with a domain (app stays on 127.0.0.1:3000 behind nginx on
80/443, Let's Encrypt included):

```bash
sudo ./espress0 deploy --repo <url> --domain repo.example.com --https
```

Docker works too (`docker compose up -d --build`; Caddy profile adds HTTPS).
Details: `SETUP.md`. For the catalogue import/export format see `CATALOG.md`,
for palettes and brand defaults `THEME.md`, and for the hardening record
`SECURITY-AUDIT.md`.

## Storage providers

The VM never hosts the files. A download is a 302 redirect resolved from the
item's provider:

- `gdrive` — store the Google Drive file ID; resolved to `uc?export=download`
- `onedrive` — share link, `?download=1` appended
- `external` — any direct URL
- `github` — release asset URL

## AI (Barista)

Optional, and the backend is a plug, not a dependency. "Ask AI" and the admin
"Draft with AI" button both go through one transport layer
(`backend/src/services/aiProviders.js`); whichever you pick, the answer is
still restricted to files that exist in the catalogue.

| `AI_PROVIDER` | what it does |
| --- | --- |
| `auto` (default) | Gemini if a key exists, the tgpt CLI if it does not, metadata search if neither |
| `gemini` | Google's `generateContent` REST API — needs a key, nothing to install |
| `openai` | anything speaking `POST {AI_BASE_URL}/chat/completions` |
| `tgpt` | the free [tgpt](https://github.com/aandrew-me/tgpt) CLI — `./espress0 ai` |
| `none` | no model at all; deterministic metadata matching |

```bash
# .env — Gemini is one line, no binary, no Go toolchain in the image
AI_PROVIDER=gemini
AI_API_KEY=<key from https://aistudio.google.com/apikey>
AI_MODEL=gemini-2.5-flash        # optional; this is the default
```

`AI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` are all read, in that order,
so a box that already exports one of Google's names needs no edit. Note that
Google now rejects *unrestricted* legacy API keys (auth keys are what AI Studio
issues), so a key that returns 403 was probably created before that change and
needs a restriction or a replacement.

**Any other endpoint** works through the OpenAI-shaped client:

```bash
AI_PROVIDER=openai
AI_BASE_URL=https://openrouter.ai/api/v1     # many models, one key
AI_BASE_URL=http://127.0.0.1:11434/v1        # Ollama on this box
AI_MODEL=llama3.1:8b
```

`AI_BASE_URL` is a server-side request the admin controls, so it is validated:
loopback is fine, a LAN address needs `AI_ALLOW_PRIVATE_BASE_URL=true`, cloud
metadata addresses are refused whatever you set, and redirects are never
followed (see `backend/src/lib/safeFetch.js`, the same guard the download-link
checker uses).

Provider, model, endpoint, temperature, token ceiling and timeouts are also
editable in **Admin → Settings → AI**, with a "Send a test prompt" button that
proves the combination actually answers. The **key is deliberately not one of
those settings**: `site_settings` is plaintext, readable through
`/api/admin/settings` and copied into every database backup, so the key stays
in `.env` beside `JWT_SECRET` and is never echoed by any endpoint or log line.

Without a model configured, nothing breaks: Ask answers from metadata and the
drafter produces a filled-in markdown skeleton with `[bracketed]` gaps.

## Layout

```
backend/src    Fastify app: routes/, services/ (storage, search, ai,
               versioning, link health), db/ (schema, migrate, seed)
frontend/src   React app: pages/ (public + admin/), components/, themes/
scripts/       the tools behind ./espress0
systemd/       app + updater unit examples
```

## Legal

Each item carries a `license_status` (`public-domain`,
`redistributable`, `proprietary`, `check-license`, `internal-only`,
`abandonware`) — set it honestly; hosting metadata is not permission to
redistribute, and linking an original source URL is good practice.
