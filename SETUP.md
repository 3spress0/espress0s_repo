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
sudo ./espress0 deploy --repo https://github.com/you/espress0s-repo.git

# Behind nginx on a domain
sudo ./espress0 deploy --repo <url> --domain repo.example.com

# With a Let's Encrypt certificate (DNS must already point at the server)
sudo ./espress0 deploy --repo <url> --domain repo.example.com --https
```

`--repo` is remembered in `/etc/espress0-repo/deploy.conf`, so updates need no
arguments. It generates `.env` with fresh `JWT_SECRET`, `ENCRYPTION_KEY`,
`PASSWORD_PEPPER` and admin password, and prints the admin password **once** at
the end — save it.

### Updating to the latest commit

```bash
sudo ./espress0 deploy --update
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
sudo ./espress0 deploy --update --branch staging   # one-off, not sticky
sudo ./espress0 deploy --update --repo <other-url> # switch source
```

#### Hands-free: the auto-updater

On a **systemd deployment** (what deploy-ubuntu.sh sets up), run the updater
next to the app and it pulls, rebuilds and restarts on every new commit:

```bash
# once (e.g. from cron): checks and updates a single time
sudo -u espress0 /opt/espress0s-repo/espress0 update --once --service espress0-repo

# or permanent, as a service (unit ships in systemd/):
sudo cp systemd/espress0-repo-updater.service /etc/systemd/system/
sudo systemctl enable --now espress0-repo-updater
# let the (unprivileged) updater control the app unit - it stops before the
# swap and starts after, so all three verbs are needed, not just restart:
echo 'espress0 ALL=(root) NOPASSWD: /bin/systemctl stop espress0-repo, /bin/systemctl restart espress0-repo, /bin/systemctl start espress0-repo' \
  | sudo tee /etc/sudoers.d/espress0-updater
```

Behaviour notes: by default the next commit is cloned and built in
`.auto-update/next` while the site keeps running, its migrations are rehearsed
against a *copy* of the database, and only once that is proven does the updater
stop the app, swap the files, run the real migrations, restart and poll
`/api/health`. If the site does not come back, the previous commit **and** the
previous `frontend/dist` are restored and the app is started again — so a bad
release costs seconds rather than uptime. `git reset` cannot undo a gitignored
build directory, which is why the snapshot exists.

`--mode pull` keeps the in-place fast-forward behaviour (local commits are never
reset away, a dirty working tree postpones updates) with the same stop-first
ordering and health check. `touch data/.auto-update-disabled` pauses everything.
Restart target is explicit: `--service NAME` for systemd, `--tmux-session NAME`
for the tmux runner, or `--stop-cmd`/`--start-cmd` for anything else (Docker, a
custom supervisor). The current status is visible in the admin UI under
**Admin -> Settings -> Auto-update** and in `data/.auto-update-status`.

Other flags: `--port <n>` (default 80), `--user <name>`, `--with-tgpt` (AI
backend), `--skip-firewall`. Run `sudo ./espress0 deploy --help` for the
list. Set `APP_CONFIG_DIR` to keep several deployments on one host.

### Starting and health-checking

```bash
sudo ./espress0 deploy --start              # production deploy (systemd)
./espress0 serve restart                    # local/tmux setup
```

`deploy --start` restarts the systemd service and polls `/api/health` for up
to 15 seconds; on failure it prints the service state, the last 20 journal
lines and whether anything is listening on the port, and exits non-zero — so
you can use it in a CI step or a healthcheck. The tmux runner's `restart`
re-spawns and its `status` shows the listener.

Because port 80 is privileged and the service runs as an unprivileged user, the
generated systemd unit grants exactly one capability,
`AmbientCapabilities=CAP_NET_BIND_SERVICE`. Use `--port 3000` if you would
rather keep nginx as the only thing on 80.

## Developing locally

### Quick start (one command)

```bash
./espress0 setup        # wizard: admin login, port, exposure, tgpt, run mode
```

The wizard asks which **port** to expose and whether to bind `0.0.0.0`
(reachable from other machines — answer 'no' for localhost-only; SSH tunnels
work: `ssh -L 3000:localhost:3000 you@server`). Both land in `.env` as
`PORT`/`HOST`, which every runner honours (`dev`, `serve`, deploy, systemd).
Optionally it runs `sudo ufw allow <port>/tcp` for the OS firewall — on a
cloud VM you still need the provider's NSG/security-group rule yourself.

After the first successful run `scripts/setup.sh` renames itself to
`scripts/config.sh`: `./espress0 setup` and `./espress0 config` both reach it,
and skipping the wizard with any `--flag` keeps old scripted behaviour.
Pass `--reset-db` next time if a new admin password should actually apply
(the existing account's password is never rotated from here).

### Keep it running in the background (tmux)

`dev.sh` dies with your terminal. For a PC or box you SSH into, use the tmux
runner instead — the app (and the auto-updater) keeps running after you close
the laptop/SSH session:

```bash
./espress0 serve                   # built UI on :3000 + auto-updater window
./espress0 serve dev               # Vite dev mode instead (:5173 + :3000)
./espress0 serve status            # show health of the session
tmux attach -t espress0            # watch live logs (Ctrl-B D detaches)
./espress0 serve stop
```

The updater window runs `scripts/auto-update.sh`: every 5 minutes it fetches
the tracked branch, and if there is a new commit it clones and builds that
commit under `.auto-update/next`, then stops the app, swaps the files in, runs
migrations, restarts and health-checks it - rolling back if the site stays
down. `--mode pull` keeps the older fast-forward-in-place behaviour. To run
the updater in cron or systemd instead, see
`systemd/espress0-repo-updater.service` and `./espress0 update --help`.
Live status is written to `data/.auto-update-status` and shows up in the admin
UI (Settings -> Auto-update). `touch data/.auto-update-disabled` pauses it.

Checks Node/npm, creates `.env` from `.env.example` with freshly generated
`JWT_SECRET`, `ENCRYPTION_KEY` and `PASSWORD_PEPPER`, creates `data/`,
`data/uploads/` and `backups/`, installs both dependency trees, runs migrations,
seeds the database, and prints a generated admin password **once**. It is safe to
re-run: existing secrets, database and uploads are never overwritten.

```bash
./espress0 setup --start                    # ... then start the dev servers
./espress0 setup --build --start            # ... single origin on :3000
./espress0 setup --admin-password 'S3cret!' # choose the password yourself
./espress0 setup --with-tgpt                # also install tgpt (AI drafting)
./espress0 setup --reset-db                 # back up and recreate the database
./espress0 setup --help                     # every flag
```

No root, no `apt`, nothing installed system-wide — works on Linux, macOS and WSL.
For an Ubuntu *server* (Node install, systemd, nginx) use `./espress0 deploy`
(scripts/deploy-ubuntu.sh) instead.

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
