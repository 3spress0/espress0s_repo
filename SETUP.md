# Getting started

This archive contains the full source tree, ready to push to GitHub. No
`node_modules`, build output, database, uploads, backups or `.env` are
included — all are generated locally and covered by `.gitignore`.

## Deploying on an Ubuntu server

One command does the whole thing — Node 20, dependencies, secrets, database,
frontend build, systemd service and an nginx reverse proxy. **The website is
served on port 80**, so no port is needed in the URL:

```bash
# HTTP only, app on port 3000
sudo ./scripts/deploy-ubuntu.sh --repo https://github.com/you/espress0s-repo.git

# Behind nginx on a domain
sudo ./scripts/deploy-ubuntu.sh --repo <url> --domain repo.example.com

# With a Let's Encrypt certificate (DNS must already point at the server)
sudo ./scripts/deploy-ubuntu.sh --repo <url> --domain repo.example.com --https
```

`--repo` is remembered in `/etc/espress0-repo/deploy.conf`, so updates need no
arguments. It generates `.env` with fresh `JWT_SECRET`, `ENCRYPTION_KEY`,
`PASSWORD_PEPPER` and admin password, and prints the admin password **once** at
the end — save it.

### Updating to the latest commit

```bash
sudo ./scripts/deploy-ubuntu.sh --update
```

This fetches from the remembered GitHub URL, syncs the checkout, reinstalls
dependencies, applies migrations, rebuilds the frontend and restarts the
service. `.env`, `data/` and `backups/` are never touched — secrets and your
database survive every update. If the pulled commit changes the script itself,
it re-executes the new version so the update finishes with the code you just
pulled.

Local edits to tracked files are discarded, because a server should match the
repository exactly; they are listed first so you can see what was dropped.

```bash
sudo ./scripts/deploy-ubuntu.sh --update --branch staging   # one-off, not sticky
sudo ./scripts/deploy-ubuntu.sh --update --repo <other-url> # switch source
```

Other flags: `--port <n>` (default 80), `--user <name>`, `--with-tgpt` (AI
backend), `--skip-firewall`. Run `./scripts/deploy-ubuntu.sh --help` for the
list. Set `APP_CONFIG_DIR` to keep several deployments on one host.

### Starting and health-checking

```bash
sudo ./scripts/deploy-ubuntu.sh --start     # production deploy
./scripts/setup-ubuntu.sh --start           # local setup
```

Both restart the app and then poll `/api/health` for up to 15 seconds. On
failure they print the service state, the last 20 journal lines and whether
anything is listening on the port, and exit non-zero — so you can use them in a
CI step or a healthcheck.

Because port 80 is privileged and the service runs as an unprivileged user, the
generated systemd unit grants exactly one capability,
`AmbientCapabilities=CAP_NET_BIND_SERVICE`. Use `--port 3000` if you would
rather keep nginx as the only thing on 80.

## Developing locally

### 1. Configure


```bash
cp .env.example .env
```

Then edit `.env` and change at minimum:

- `JWT_SECRET` — 32+ random bytes
- `ENCRYPTION_KEY` — base64, 32 bytes; encrypts download URLs and storage paths at rest
- `PASSWORD_PEPPER` — 64 hex chars
- `ADMIN_PASSWORD` — the shipped default is `ChangeMe123!`; do not keep it

Generate values:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # JWT_SECRET / ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # PASSWORD_PEPPER
```

Note: `ENCRYPTION_KEY` decrypts existing rows, so changing it after you have
data means previously stored URLs can no longer be read. Set it before seeding.

### 2. Install and seed

```bash
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..

npm --prefix backend run migrate
npm --prefix backend run seed
```

`data/repo.db` is created on first run. Site settings are seeded automatically
and are editable from the admin panel — they are never hardcoded in the UI.

### 3. Run

```bash
./scripts/dev.sh
```

- Frontend dev server: http://localhost:5173 (proxies `/api` to the backend)
- Backend API: http://localhost:3000

For a single origin, build the frontend and let Fastify serve it:

```bash
./scripts/dev.sh --build     # http://localhost:3000
```

Sign in at `/login` with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.
Login is CAPTCHA-gated.

### 4. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

If you are reusing the `.git` directory from an earlier copy of this project,
read the warning in `README.md` about committed database backups first — you
must remove them from history before pushing, not just from the working tree.

## Layout

```
backend/    Fastify API, SQLite + FTS5, storage providers, uploads
frontend/   Vite + React SPA
scripts/    dev.sh and helpers
systemd/    service units for VM deployment
.github/    CI workflows
```

Admin areas: `/admin` (overview), `/admin/items`, `/admin/categories`,
`/admin/users`, `/admin/storage`, `/admin/settings`, `/admin/monitoring`.
Item pages also expose an inline editor to admins via "Edit this page".
