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

#### Hands-free: the auto-updater

On a **systemd deployment** (what deploy-ubuntu.sh sets up), run the updater
next to the app and it pulls, rebuilds and restarts on every new commit:

```bash
# once (e.g. from cron): checks and updates a single time
sudo -u espress0 /opt/espress0s-repo/scripts/auto-update.sh --once --service espress0-repo

# or permanent, as a service (unit ships in systemd/):
sudo cp systemd/espress0-repo-updater.service /etc/systemd/system/
sudo systemctl enable --now espress0-repo-updater
# let the (unprivileged) updater restart the app:
echo 'espress0 ALL=(root) NOPASSWD: /bin/systemctl restart espress0-repo' \
  | sudo tee /etc/sudoers.d/espress0-updater
```

Behaviour notes: fast-forward pulls only (local commits are never reset away),
a dirty working tree postpones updates, and `touch data/.auto-update-disabled`
pauses everything. The current status is visible in the admin UI under
**Admin → Settings → Auto-update** and in `data/.auto-update-status`.

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

### Quick start (one command)

```bash
./scripts/setup.sh
```

### Keep it running in the background (tmux)

`dev.sh` dies with your terminal. For a PC or box you SSH into, use the tmux
runner instead — the app (and the auto-updater) keeps running after you close
the laptop/SSH session:

```bash
./scripts/start-tmux.sh            # built UI on :3000 + auto-updater window
./scripts/start-tmux.sh dev        # Vite dev mode instead (:5173 + :3000)
./scripts/start-tmux.sh status     # show health of the session
tmux attach -t espress0            # watch live logs (Ctrl-B D detaches)
./scripts/start-tmux.sh stop
```

The updater window runs `scripts/auto-update.sh`: every 5 minutes it fetches
the tracked branch, and if there is a new commit it pulls (fast-forward only),
reinstalls what changed, rebuilds the frontend and restarts the app. To bike
the updater into cron or systemd instead, see
`systemd/espress0-repo-updater.service` and `./scripts/auto-update.sh --help`.
Live status is written to `data/.auto-update-status` and shows up in the admin
UI (Settings → Auto-update). `touch data/.auto-update-disabled` pauses it.

Checks Node/npm, creates `.env` from `.env.example` with freshly generated
`JWT_SECRET`, `ENCRYPTION_KEY` and `PASSWORD_PEPPER`, creates `data/`,
`data/uploads/` and `backups/`, installs both dependency trees, runs migrations,
seeds the database, and prints a generated admin password **once**. It is safe to
re-run: existing secrets, database and uploads are never overwritten.

```bash
./scripts/setup.sh --start                    # ... then start the dev servers
./scripts/setup.sh --build --start            # ... single origin on :3000
./scripts/setup.sh --admin-password 'S3cret!' # choose the password yourself
./scripts/setup.sh --with-tgpt                # also install tgpt (AI drafting)
./scripts/setup.sh --reset-db                 # back up and recreate the database
./scripts/setup.sh --help                     # every flag
```

No root, no `apt`, nothing installed system-wide — works on Linux, macOS and WSL.
For an Ubuntu *server* (Node install, systemd, nginx) use `scripts/setup-ubuntu.sh`
or `scripts/deploy-ubuntu.sh` instead.

The manual equivalent is below, if you would rather do it step by step.

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
scripts/    setup.sh (one-command local setup), dev.sh and helpers
systemd/    service units for VM deployment
.github/    CI workflows
```

Admin areas: `/admin` (overview), `/admin/items`, `/admin/categories`,
`/admin/users`, `/admin/storage`, `/admin/settings`, `/admin/monitoring`.
Item pages also expose an inline editor to admins via "Edit this page".
