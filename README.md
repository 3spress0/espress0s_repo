# espress0's repo

> A polished, personal software archive — dark futuristic UI, external storage abstraction, fast search, and tgpt-powered AI discovery.

> ### ⚠️ Before you push this to GitHub
> Earlier revisions of this project committed `backups/` — database dumps
> containing **user records and bcrypt password hashes**. `.gitignore` now
> excludes that directory, but ignoring a path does **not** untrack files that
> are already committed, and it does not remove them from history.
>
> If your local `.git` has those files in any commit, strip them before pushing:
>
> ```bash
> git rm -r --cached backups/          # untrack, keep on disk
> git commit -m "Remove database backups from version control"
> # then rewrite history so the blobs never reach GitHub:
> git filter-repo --path backups --invert-paths
> ```
>
> If they were ever pushed to a remote already, treat those password hashes as
> exposed and force a password reset for every account.
>
> The zip this tree came from contains **no** `backups/`, `.env`, `data/` or
> `node_modules/`. See `SETUP.md` to get running.

![License](https://img.shields.io/badge/license-MIT-purple)
![Node](https://img.shields.io/badge/node-20%2B-blue)
![SQLite](https://img.shields.io/badge/db-SQLite%20%2B%20FTS5-green)

**Brand:** espress0's repo — curated personal repository for discovering and downloading software, ISOs, tools, documentation, and other important files.

## ✨ Features

- **Dark futuristic UI** with purple → blue gradient, glassmorphism, rounded cards, micro-animations
- **9 colour schemes** — Midnight, Starry Night, Galaxy, Cotton Candy, Forest, Sunrise, Amber, plus Sky and Daybreak for light mode. CSS-variable driven, switchable from the navbar, `auto` follows the OS, admins set the site default and the starfield/aurora effects. Palettes adapted from Spicetify's StarryNight — see [THEME.md](THEME.md)
- **Fast search** with SQLite FTS5, typo-tolerance via Levenshtein reranking
- **Category browsing** — OS, ISOs, Apps, Utilities, Dev, Games, Docs, Other
- **Storage abstraction** — `StorageProvider` interface with Google Drive, OneDrive, External, GitHub, Local providers. VM never stores large files; downloads redirect to providers
- **AI FAQ** — "Ask espress0's repo" powered by [aandrew-me/tgpt](https://github.com/aandrew-me/tgpt) CLI. Searches metadata first, never hallucinates files, gracefully degrades to rule-based
- **Admin panel** — add/edit files, set checksums, assign storage provider, feature/unpublish, reindex search
- **Fast page authoring** — templates for new file pages, markdown body with preview and an AI draft button, paste-a-URL mirrors, live URL (slug) checking, duplicate-as-draft, bulk publish/unpublish/delete (see [Authoring file pages](#-authoring-file-pages))
- **Security** — JWT auth, bcrypt, helmet, rate-limiting, CSRF-safe, no secrets in frontend
- **Low-resource optimized** — designed for small Azure VM (1 vCPU, 1GB RAM), no local AI models, no ISO hosting on VM
- **Production ready** — Docker, docker-compose, systemd, Nginx/Caddy examples, HTTPS, backup script, GitHub Actions CI/CD

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Frontend       │────▶│  Backend/API     │────▶│  SQLite + FTS5      │
│  Vite + React   │     │  Fastify         │     │  metadata only      │
│  Tailwind       │     │  Node 20         │     └─────────────────────┘
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ├─▶ StorageProvider abstraction
                                 │    ├─ GoogleDriveProvider (file ID → uc?export=download)
                                 │    ├─ OneDriveProvider (share link → ?download=1)
                                 │    ├─ ExternalProvider (direct URL)
                                 │    └─ Future providers
                                 │
                                 └─▶ AI Service (tgpt CLI)
                                      ├─ metadata search first
                                      ├─ tgpt binary if available
                                      └─ rule-based fallback
```

**Data model:**
- `Item`: id, name, slug, description, category, version, release_date, file_name, file_size, file_type, platform, architecture, sha256, storage_provider, storage_path, download_url, featured, published, license_status, tags, etc.
- `Category`, `Tag`, `FAQ`, `User`
- FTS5 virtual table for search

**Download flow:**
1. User clicks Download → `GET /api/download/:id`
2. Backend increments counter, resolves provider via `storageManager.getDownloadUrl()`
3. 302 Redirect to Google Drive / OneDrive / External URL — VM does NOT proxy large files

## 🚀 Quick Start (Local Dev)

```bash
git clone <your-repo> espress0s-repo
cd espress0s-repo

./scripts/setup.sh --start
```

One command: checks Node, writes a `.env` with freshly generated secrets, creates
`data/` and `backups/`, installs both dependency trees, migrates + seeds the
database, prints a generated admin password once, then starts the dev servers
(frontend :5173, API :3000). Re-running never overwrites secrets or data.
`./scripts/setup.sh --help` lists the flags (`--build`, `--reset-db`,
`--admin-password`, `--with-tgpt`, ...).

<details>
<summary>Manual steps, if you prefer</summary>

```bash
# Env
cp .env.example .env
# Edit .env: set JWT_SECRET, ADMIN_PASSWORD, etc.

# Backend
cd backend
npm install
node src/db/migrate.js
node src/db/seed.js
npm run dev  # :3000

# Frontend (new terminal)
cd ../frontend
npm install
npm run dev  # :5173

# Open http://localhost:5173
# Admin: http://localhost:5173/login (admin / ChangeMe123!)
```

</details>

## 🐳 Docker (Production)

```bash
cp .env.example .env
# Edit .env for production

docker-compose up -d --build
# App at http://localhost:3000
# With Caddy (auto HTTPS):
docker-compose --profile with-caddy up -d
```

Frontend is built inside Docker and served by Fastify in production (`frontend/dist`).

## 🔧 Deployment — Ubuntu 24.04 LTS on Azure VM

### Option 1: Systemd (minimal Azure credit)

```bash
# On VM (Ubuntu 24.04)
sudo apt update && sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx git sqlite3
# Node 20 via nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo useradd -m -s /bin/bash espress0
sudo mkdir -p /opt/espress0s-repo
sudo chown espress0:espress0 /opt/espress0s-repo
cd /opt/espress0s-repo
git clone <repo> .

# Env
cp .env.example .env
nano .env  # set JWT_SECRET (openssl rand -base64 32), ADMIN_PASSWORD, etc.

# Install & init
cd backend && npm ci --only=production && node src/db/migrate.js && node src/db/seed.js && cd ..
cd frontend && npm ci && npm run build && cd ..

# Systemd
sudo cp systemd/espress0-repo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable espress0-repo
sudo systemctl start espress0-repo
sudo journalctl -u espress0-repo -f

# Nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/espress0
sudo ln -s /etc/nginx/sites-available/espress0 /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/espress0  # set server_name
sudo nginx -t && sudo systemctl reload nginx

# HTTPS
sudo certbot --nginx -d espress0.example.com
```

### Option 2: Docker + Caddy (auto HTTPS)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out/in

cd /opt/espress0s-repo
cp .env.example .env
nano .env
cp Caddyfile.example Caddyfile
nano Caddyfile  # set domain

docker-compose --profile with-caddy up -d --build
```

### Backup

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh
# Cron: 0 2 * * * /opt/espress0s-repo/scripts/backup.sh

# Backup only DB + config, NOT ISOs (those live externally)
# For off-site, configure rclone in backup.sh
```

## ✍️ Authoring file pages

Every file in the repo has its own public page at `/file/<slug>`. Admins manage those
pages under **Admin → File pages** (`/admin/items`).

**Creating a page**

1. Click **New page** and pick a template (Linux ISO, Windows app, portable utility,
   dev tool, game, document, or blank). The template fills in type, platform,
   architecture, tags, license posture and a markdown outline — nothing you have
   already typed is overwritten.
2. Fill in the **Basics**. The page URL is generated from the name; you can edit it
   and it is checked against existing pages while you type (`GET /api/admin/slug-check`).
3. Write the **Description** in markdown, with a toolbar and a live preview.
   **Draft with AI** (`POST /api/admin/ai/describe`, admin-only) turns the metadata
   you have entered into a first draft via tgpt; without tgpt installed it produces a
   filled-in outline with `[bracketed]` prompts instead. Always review it — the model
   is told not to invent versions, sizes or links, but it does not know your files.
4. Add **Images** (upload, paste a URL, or pick from the media library) and
   **Downloads** — paste a link into the quick-add box and the provider, label and
   Google Drive file ID are detected for you.
5. The **page checklist** at the bottom shows what is still missing; each entry jumps to
   the relevant section. Save with **Save as draft**, **Create page** or
   **Save & publish** — or `Ctrl`/`⌘ + S`.

**Editing and removing**

- Inline **publish/unpublish** toggle straight from the list, plus a per-row
  **duplicate as draft** (copies every field and mirror, `POST /api/admin/items/:id/duplicate`)
  for a new release or a sibling edition.
- Tick several rows for **bulk publish / unpublish / feature / unfeature / delete**
  (`POST /api/admin/items/bulk`, one transaction).
- Deleting asks for confirmation and spells out what disappears (the URL and its
  mirrors). Unpublishing is the reversible alternative.

Page bodies and changelogs are rendered by a small in-house markdown renderer
(`frontend/src/lib/markdown.jsx`) that builds React elements directly — no HTML string
and no `dangerouslySetInnerHTML`, so admin-authored content cannot inject markup, and
`javascript:` links are dropped.

## 🔐 Storage Providers

**Do NOT store ISOs on VM.** Configure in Admin panel:

- **Google Drive**: `storage_provider=gdrive`, `storage_path=FILE_ID` (from `https://drive.google.com/file/d/FILE_ID/view`). Backend returns `https://drive.google.com/uc?export=download&id=FILE_ID`
- **OneDrive**: `storage_provider=onedrive`, `download_url=https://1drv.ms/...` (share link). Adds `?download=1`
- **External**: `storage_provider=external`, `download_url=https://releases.ubuntu.com/...`
- **GitHub**: `storage_provider=github`, `download_url=https://github.com/.../releases/download/...`

Admin can validate paths via `/api/admin/validate-storage`.

## 🤖 AI / tgpt Integration

Install tgpt on VM for AI feature:

```bash
# Install tgpt per https://github.com/aandrew-me/tgpt
go install github.com/aandrew-me/tgpt@latest
# or
curl -sSL https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | bash -s /usr/local/bin

# Configure provider (e.g., openai)
tgpt --provider openai --key sk-...

# Test
echo "Hello" | tgpt --provider openai

# Backend env
TGPT_ENABLED=true
TGPT_BINARY_PATH=/usr/local/bin/tgpt
TGPT_PROVIDER=openai
```

**How it works:**
1. User asks: "Which Ubuntu ISO for Intel PC?"
2. Backend searches FTS5 for "Ubuntu Intel" → gets relevant items
3. Builds strict prompt with repo context: "Only mention files listed below, never invent..."
4. If tgpt binary exists: `cat prompt | tgpt --provider openai --quiet`
5. Else: rule-based answer from metadata (size comparison, arch filtering, etc.)
6. Sanitizes answer: strips unverified http links, only allows `/item/slug` and known domains
7. Returns answer + sources (verified item slugs)

Gracefully degrades if tgpt unavailable — search still works.

## 🔒 Security

- JWT + bcrypt, no public registration
- Helmet security headers, CORS allowlist
- Rate limiting (100 req / 15min global, 20 / 5min for AI)
- Input validation with Zod
- No secrets in frontend, env-based config
- SQLite WAL mode, parameterized queries
- No arbitrary command exec — tgpt prompt written to temp file, not interpolated into shell unsafely
- License status field for legal clarity

## 📚 API Docs

- `GET /api/health`
- `GET /api/items?q=&category=&file_type=&platform=&architecture=&sort=&page=&limit=`
- `GET /api/items/:slug`
- `POST /api/items` (admin)
- `PUT /api/items/:id` (admin)
- `DELETE /api/items/:id` (admin)
- `GET /api/categories`
- `GET /api/search?q=&...`
- `GET /api/stats`
- `GET /api/download/:id` → 302 redirect
- `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/ai/ask?q=`, `POST /api/ai/ask`, `GET /api/ai/status`
- `GET /api/faq`
- `GET /api/admin/overview` (admin), `POST /api/admin/reindex` (admin)

## 🛠️ Project Structure

```
espress0s-repo/
├── backend/
│   ├── src/
│   │   ├── db/ (schema, migrate, seed)
│   │   ├── routes/ (items, categories, search, stats, auth, ai, admin)
│   │   ├── services/
│   │   │   ├── storage/ (StorageProvider abstraction)
│   │   │   ├── searchService (FTS5 + Levenshtein)
│   │   │   └── aiService (tgpt + fallback)
│   │   ├── middleware/ (auth, rateLimit)
│   │   └── index.js
├── frontend/
│   ├── src/
│   │   ├── components/ (Navbar, Hero, CategoryGrid, ItemCard, Stats, Footer)
│   │   ├── pages/ (Home, Browse, ItemDetail, Ask, Admin, Login)
│   │   └── lib/ (api, utils)
├── .github/workflows/ (ci.yml, deploy.yml)
├── systemd/
├── scripts/ (setup.sh, dev.sh, backup.sh, init-db.sh, deploy-ubuntu.sh)
├── Dockerfile, docker-compose.yml
├── Caddyfile.example, nginx.conf.example
└── .env.example
```

## 📄 Legal

- Metadata about file ≠ permission to redistribute
- Each item has `license_status`: `public-domain`, `redistributable`, `proprietary`, `check-license`, `internal-only`, `abandonware`
- Admin must set correctly
- Do not assume ISO is redistributable because publicly downloadable
- Provide original source URL in `external_url` when possible

## 🤝 Contributing

- Env-based config, no secrets committed
- Migrations version-controlled
- Tests for backend logic
- GitHub Actions build/test/deploy

## 📦 Deliverables Done

- [x] Project structure
- [x] Frontend (dark gradient, glassmorphism, responsive)
- [x] Backend/API (Fastify, CRUD, auth)
- [x] Database (SQLite + FTS5, seed)
- [x] Search (typo-tolerant, filters, pagination)
- [x] Storage abstraction (GDrive, OneDrive, External, GitHub, Local)
- [x] Admin panel
- [x] tgpt AI integration (metadata-first, no hallucination, graceful degrade)
- [x] Security (JWT, bcrypt, helmet, rate limit)
- [x] Deployment (Docker, systemd, Nginx/Caddy, backup, GitHub Actions)
- [x] Docs (.env.example, README)

---

Built for low-resource Azure VM — no 200GB ISO storage on VM, no local LLM, just metadata, search, and smart redirects.
