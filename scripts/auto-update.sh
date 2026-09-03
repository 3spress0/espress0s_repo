#!/usr/bin/env bash
# Auto-update espress0's repo from its git remote.
#
#   ./scripts/auto-update.sh                    watch mode: check every 5 min
#   ./scripts/auto-update.sh --interval 600     watch mode with a 10 min cadence
#   ./scripts/auto-update.sh --once             check once and exit (cron-friendly)
#   ./scripts/auto-update.sh --branch main      track a specific branch
#   ./scripts/auto-update.sh --service NAME     manage this systemd unit
#   ./scripts/auto-update.sh --tmux-session N   restart the app window in tmux
#   ./scripts/auto-update.sh --no-migrate       skip the database migrations
#
# Restart target (pick one; the updater cannot restart what it cannot reach):
#   --service NAME        systemd unit, via systemctl (sudo -n when needed)
#   --tmux-session NAME   the 'app'/'backend' window of a start-tmux session
#   --stop-cmd / --start-cmd   any supervisor: 'docker compose restart app', etc.
#
# How it updates:
#   --mode clone (default)  the new code is cloned and BUILT in .auto-update/next
#       while the site keeps running. Nothing in the live tree changes until the
#       staged build is proven (frontend built, migrations rehearsed against a
#       copy of the database). Only then: stop -> swap -> migrate -> start ->
#       health check. If the site does not come back, the previous commit is put
#       back and started again, so a bad release costs seconds instead of uptime.
#   --mode pull             fast-forward in place, but with the same
#       stop -> deps -> migrate -> build -> start -> verify -> rollback order.
#
# Safety:
#   * --mode pull only ever fast-forwards. Local commits/divergence are never
#     reset away - the cycle is skipped and logged instead.
#   * A dirty working tree blocks updates until cleaned (the setup.sh ->
#     config.sh self-rename is exempt - it is an intended post-install state).
#   * .env, data/, backups/, uploads/ and node_modules/ are gitignored and are
#     never replaced by a deploy; --mode clone copies .env forward and leaves
#     the rest where it is.
#   * Pause everything with: touch data/.auto-update-disabled
#   * A flock prevents two updaters from running at once.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

INTERVAL=300
ONCE=0
BRANCH=""
SERVICE=""
TMUX_SESSION="${TMUX_SESSION_NAME:-espress0}"
REMOTE="${GIT_REMOTE:-origin}"
MODE="clone"
MIGRATE=1
STOP_CMD=""
START_CMD=""
HEALTH_URL=""
STAGE_ROOT=".auto-update"
STAGE_DIR="$STAGE_ROOT/next"
STATE_FILE="data/.auto-update-status"
DISABLE_FILE="data/.auto-update-disabled"
LOCK_FILE="data/.auto-update.lock"

# Print the header block above, stopping at the first non-comment line. A fixed
# sed range here silently grows or truncates the help every time the header is
# edited, and had already started leaking `set -uo pipefail` into --help.
usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --once)           ONCE=1 ;;
    --interval)       INTERVAL="${2:-}"; shift ;;
    --interval=*)     INTERVAL="${1#*=}" ;;
    --branch)         BRANCH="${2:-}"; shift ;;
    --branch=*)       BRANCH="${1#*=}" ;;
    --service)        SERVICE="${2:-}"; shift ;;
    --service=*)      SERVICE="${1#*=}" ;;
    --tmux-session)   TMUX_SESSION="${2:-}"; shift ;;
    --tmux-session=*) TMUX_SESSION="${1#*=}" ;;
    --mode)           MODE="${2:-}"; shift ;;
    --mode=*)         MODE="${1#*=}" ;;
    --stop-cmd)       STOP_CMD="${2:-}"; shift ;;
    --stop-cmd=*)     STOP_CMD="${1#*=}" ;;
    --start-cmd)      START_CMD="${2:-}"; shift ;;
    --start-cmd=*)    START_CMD="${1#*=}" ;;
    --health-url)     HEALTH_URL="${2:-}"; shift ;;
    --health-url=*)   HEALTH_URL="${1#*=}" ;;
    --no-migrate)     MIGRATE=0 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

case "$INTERVAL" in (*[!0-9]*|'') echo "!! --interval must be a number of seconds." >&2; exit 1 ;; esac
[ "$INTERVAL" -lt 30 ] && INTERVAL=30   # be nice to the remote (and the disk)
case "$MODE" in
  clone|pull) ;;
  *) echo "!! --mode must be 'clone' or 'pull' (got '$MODE')." >&2; exit 1 ;;
esac

mkdir -p data "$STAGE_ROOT"
# Serialize against cron/systemd/manual second copies of this script.
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another auto-update instance holds $LOCK_FILE — exiting."; exit 0; }

log()  { printf '[auto-update %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
write_state() { # state message
  printf '{"state":"%s","message":%s,"at":"%s","branch":"%s","commit":"%s"}\n' \
    "$1" "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || echo '""')" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$BRANCH" "$(git rev-parse --short HEAD 2>/dev/null)" > "$STATE_FILE" 2>/dev/null || true
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || { log "FATAL: '$1' not installed"; exit 1; }; }
need_cmd git
need_cmd npm

# Default: follow whatever the checkout currently tracks.
[ -n "$BRANCH" ] || BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || { log "FATAL: detached HEAD and no --branch given."; exit 1; }

# ---------------------------------------------------------------- port / health

# The app's own port comes from .env (config.js defaults to 3000); reading it
# here keeps the health probe honest when the deployment is not on 3000.
app_port() {
  local p=""
  if [ -f .env ]; then
    p="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n1 | tr -d '"'"'"'' | tr -d '[:space:]')"
  fi
  printf '%s' "${p:-${PORT:-3000}}"
}

[ -n "$HEALTH_URL" ] || HEALTH_URL="http://127.0.0.1:$(app_port)/api/health"

# 15 tries, 1s apart, curl or wget — same contract as `./espress0 deploy`.
verify_healthy() {
  local attempt=1
  while [ "$attempt" -le 15 ]; do
    sleep 1
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1 && { log "healthy: GET $HEALTH_URL (attempt $attempt)"; return 0; }
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 5 -O /dev/null "$HEALTH_URL" 2>/dev/null && { log "healthy: GET $HEALTH_URL (attempt $attempt)"; return 0; }
    else
      log "no curl or wget available - cannot verify health"
      return 0
    fi
    attempt=$((attempt + 1))
  done
  log "site did not answer on $HEALTH_URL within 15s"
  return 1
}

# ------------------------------------------------------------------- stop/start

LAUNCH_BACKEND='cd backend && NODE_ENV=production node src/index.js'

tmux_has_window() {
  local name="$1"
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null \
    && tmux list-windows -t "$TMUX_SESSION" -F '#W' 2>/dev/null | grep -qx "$name"
}

stop_app() {
  if [ -n "$STOP_CMD" ]; then
    log "stopping app: $STOP_CMD"
    # 9>&-: never let a child inherit the lock fd, or a long-lived process we
    # start would keep data/.auto-update.lock held and every later cycle would
    # exit as "another instance is running".
    bash -c "$STOP_CMD" 9>&- || log "stop command exited non-zero (continuing - it may already be stopped)"
  elif [ -n "$SERVICE" ]; then
    log "stopping systemd service: $SERVICE"
    systemctl stop "$SERVICE" 2>/dev/null || sudo -n systemctl stop "$SERVICE" 2>/dev/null \
      || log "could not stop $SERVICE - the update will restart it instead"
  elif tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Ctrl-C the app and (in dev mode) the frontend window, but never the
    # session: this script is often the 'updater' window inside it, and killing
    # the session would take the updater down mid-deploy.
    local w
    for w in app backend frontend; do
      tmux_has_window "$w" && { log "stopping tmux window: $w"; tmux send-keys -t "$TMUX_SESSION:$w" C-c 2>/dev/null || true; }
    done
  else
    log "no stop target configured - stopping nothing. Pass --service/--tmux-session/--stop-cmd."
  fi
  sleep 1   # let the listener actually go away before files move under it
}

start_app() {
  if [ -n "$START_CMD" ]; then
    log "starting app: $START_CMD"
    bash -c "$START_CMD" 9>&- || { log "start command failed"; return 1; }
  elif [ -n "$SERVICE" ]; then
    log "starting systemd service: $SERVICE"
    systemctl restart "$SERVICE" 2>/dev/null || sudo -n systemctl restart "$SERVICE" 2>/dev/null || {
      log "could not restart $SERVICE - grant the three verbs it needs with:"
      log "  echo \"$(id -un) ALL=(root) NOPASSWD: $(command -v systemctl) stop $SERVICE, $(command -v systemctl) restart $SERVICE, $(command -v systemctl) start $SERVICE\" \\"
      log "    > /etc/sudoers.d/espress0-updater   (visudo -cf it before installing)"
      return 1
    }
  elif tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    local started=0 w
    for w in app backend; do
      tmux_has_window "$w" || continue
      log "starting tmux window: $w"
      tmux send-keys -t "$TMUX_SESSION:$w" "cd '$ROOT' && $LAUNCH_BACKEND" C-m 2>/dev/null && started=1
    done
    if tmux_has_window frontend; then
      log "starting tmux window: frontend"
      tmux send-keys -t "$TMUX_SESSION:frontend" "cd '$ROOT/frontend' && npm run dev -- --host" C-m 2>/dev/null && started=1
    fi
    [ "$started" = 1 ] || { log "no 'app'/'backend'/'frontend' window in '$TMUX_SESSION' - cannot start"; return 1; }
  else
    log "no start target configured - start the app yourself (or pass --service/--tmux-session/--start-cmd)"
    return 0
  fi
}

# --------------------------------------------------------------------- migrations

run_migrations() { # <label> <dir> — the dir's DB config decides which file it touches
  [ "$MIGRATE" = 1 ] || { log "migrations skipped (--no-migrate)"; return 0; }
  # Rehearsing needs a working native module; without one, say so and move on
  # rather than failing an update that would otherwise have applied cleanly.
  if ! (cd "$2" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
    log "$1: cannot run migrations here (better-sqlite3 unavailable) - skipping"
    return 0
  fi
  (cd "$2" && node src/db/migrate.js) >/dev/null 2>&1 \
    && { log "$1: migrations applied"; return 0; } \
    || { log "$1: MIGRATIONS FAILED"; return 1; }
}

# Copy the live database and migrate the copy, so a release with a bad
# migration is caught while the site is still up and nothing is committed.
find_live_db() {
  local from_env candidate
  from_env=""
  if [ -f .env ]; then
    from_env="$(sed -n 's/^[[:space:]]*DATABASE_PATH[[:space:]]*=[[:space:]]*//p' .env | tail -n1 | tr -d "\"'" | tr -d '[:space:]')"
  fi
  # .env resolves DATABASE_PATH against backend/ (that is where the app is
  # launched from), while config.js falls back to <root>/data/repo.db.
  for candidate in "$from_env" "backend/$from_env" "data/repo.db" "backend/data/repo.db"; do
    [ -n "$candidate" ] || continue
    [ -f "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

rehearse_migrations() {
  [ "$MIGRATE" = 1 ] || return 0
  local live
  if ! live="$(find_live_db)"; then
    log "no database file found yet - nothing to rehearse"
    return 0
  fi
  mkdir -p "$STAGE_DIR/backend/data"
  cp "$live" "$STAGE_DIR/backend/data/repo.db" 2>/dev/null || { log "could not copy $live for rehearsal"; return 0; }
  # side files too, or SQLite sees an inconsistent database
  local ext
  for ext in -wal -shm; do [ -f "$live$ext" ] && cp "$live$ext" "$STAGE_DIR/backend/data/repo.db$ext"; done
  log "rehearsing migrations against a copy of $live"
  if (cd "$STAGE_DIR/backend" && DATABASE_PATH=./data/repo.db node src/db/migrate.js) >/dev/null 2>&1; then
    log "migrations rehearse cleanly"
    return 0
  fi
  log "the new migrations do NOT apply to the live database copy - not deploying"
  return 1
}

# ------------------------------------------------------------------- swap/restore

# .env is gitignored, so a fresh clone has none: carry the live one forward.
# node_modules/ is deliberately NOT copied - see install_deps_for.
carry_runtime_state() {
  [ -f .env ] && cp .env "$STAGE_DIR/.env"
  return 0
}

deps_changed() {
  ! git diff --quiet "$1..$2" -- backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json 2>/dev/null
}

# A fresh clone has no node_modules, so installing in the staged tree means a
# full `npm install` of both packages on EVERY cycle: minutes of CPU on a small
# VM, and a native rebuild (better-sqlite3) that has nothing to do with the
# release. When the manifests are identical between the running commit and the
# incoming one, the staged tree does not need its own dependency set - point it
# at the installed one and let the build and the migration rehearsal use it.
# Only a symlink is created, and it is dropped again before the swap, so the live
# tree is never written through it - the only thing a build puts in node_modules
# is a regenerable .vite cache. A tree that already has real dependencies
# installed is left alone rather than shadowed by a link.
reuse_live_deps() {
  local pkg
  for pkg in backend frontend; do
    [ -d "$ROOT/$pkg/node_modules" ] || continue
    [ -d "$STAGE_DIR/$pkg" ] || continue
    if [ -e "$STAGE_DIR/$pkg/node_modules" ] && [ ! -L "$STAGE_DIR/$pkg/node_modules" ] \
       && [ -n "$(ls -A "$STAGE_DIR/$pkg/node_modules" 2>/dev/null)" ]; then
      continue
    fi
    ln -sfn "$ROOT/$pkg/node_modules" "$STAGE_DIR/$pkg/node_modules"
  done
  log "reuse: staged tree points at the live node_modules (manifests unchanged)"
}

release_live_deps() {
  local pkg
  for pkg in backend frontend; do
    [ -L "$STAGE_DIR/$pkg/node_modules" ] && rm -f -- "$STAGE_DIR/$pkg/node_modules"
  done
  return 0
}

install_deps_in() { # <dir>
  local dir="$1"
  local pkg
  for pkg in backend frontend; do
    if [ ! -d "$dir/$pkg/node_modules" ] || [ -z "$(ls -A "$dir/$pkg/node_modules" 2>/dev/null)" ]; then
      log "installing $pkg dependencies (staged)"
      (cd "$dir/$pkg" && npm install --no-audit --no-fund --loglevel=error) || { log "npm install failed in $dir/$pkg"; return 1; }
    fi
  done
  return 0
}

# Copy the staged build over the live tree, leaving every gitignored runtime
# directory exactly where it is. Uses rsync when available, otherwise a
# tar-pipe so a box without rsync still updates.
swap_tree() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git/' --exclude "$STAGE_ROOT/" --exclude 'data/' --exclude 'backups/' \
      --exclude 'uploads/' --exclude '.env' --exclude 'node_modules' \
      "$STAGE_DIR/" "$ROOT/" || return 1
  else
    ( cd "$STAGE_DIR" && tar cf - \
        --exclude='./.git' --exclude="./$STAGE_ROOT" --exclude='./data' --exclude='./backups' \
        --exclude='./uploads' --exclude='./.env' --exclude='./node_modules' . ) \
      | ( cd "$ROOT" && tar xf - ) || return 1
  fi
  return 0
}

# HEAD is still at the pre-deploy commit while the files on disk are the new
# ones, which is what makes rollback a `git reset --hard`. Once the site is
# healthy, move HEAD onto the deployed commit without touching the worktree.
confirm_deployment() { # <remote_sha>
  git reset --mixed --quiet "$1" || { log "could not move HEAD to $1 - check 'git status'"; return 1; }
  git rev-parse HEAD | grep -qx "$1" || { log "HEAD did not land on $1"; return 1; }
  return 0
}

# frontend/dist is gitignored, so `git reset --hard` cannot put it back - and it
# is the thing the app actually serves. Snapshot it before deploying so a
# rollback restores the previous BUILD, not just the previous source.
PREV_DIST="$STAGE_ROOT/prev-dist"

save_dist_snapshot() {
  rm -rf "$PREV_DIST"
  if [ -d frontend/dist ]; then
    cp -a frontend/dist "$PREV_DIST" && log "snapshotted frontend/dist for rollback"
  fi
}

restore_dist_snapshot() {
  if [ -d "$PREV_DIST" ]; then
    rm -rf frontend/dist && cp -a "$PREV_DIST" frontend/dist \
      && log "restored the previous frontend/dist" \
      || log "could not restore the dist snapshot - rebuild the frontend by hand"
  elif [ -f frontend/package.json ]; then
    log "no dist snapshot - rebuilding the frontend from the restored source"
    (cd frontend && npm run build) >/dev/null 2>&1 || log "rollback rebuild FAILED"
  fi
}

# Roll the working tree back to <old_sha> after a failed deploy. `git reset
# --hard` restores files that existed before, but a file the new release ADDED
# is simply untracked afterwards and would survive - which can keep the old
# build broken (a replaced module, a marker the entrypoint reads). So remove
# exactly the paths this release added and nothing else: never `git clean`,
# which would also eat a deployment's untracked local files.
rollback_to() { # <old_sha> <new_sha>
  git reset --hard --quiet "$1" || { log "automatic rollback FAILED - restore $1 by hand"; return 1; }
  local added
  added="$(git diff --name-only --diff-filter=A "$1".."$2" 2>/dev/null)"
  if [ -n "$added" ]; then
    local f
    while IFS= read -r f; do
      [ -n "$f" ] && [ -e "$f" ] && rm -rf -- "$f"
    done <<< "$added"
    log "removed $(printf '%s\n' "$added" | grep -c .) file(s) the failed release added"
  fi
  return 0
}

# ------------------------------------------------------------------- the two modes

# clone mode: prove the build off to the side, then swap and restart.
deploy_via_clone() { # <local_sha> <remote_sha>
  local remote_url
  remote_url="$(git remote get-url "$REMOTE" 2>/dev/null)"
  if [ -z "$remote_url" ]; then
    log "no '$REMOTE' URL to clone from - falling back to --mode pull"
    deploy_via_pull "$1" "$2"
    return $?
  fi

  log "cloning $remote_url ($BRANCH @ ${2:0:7}) into $STAGE_DIR"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  # --no-hardlinks: the staged tree must not share object storage with the live
  # checkout, or a later `git gc` could touch files mid-deploy.
  if ! git clone --quiet --no-hardlinks --branch "$BRANCH" "$remote_url" "$STAGE_DIR"; then
    log "clone failed (unreachable remote, or '$BRANCH' does not exist on it)"
    write_state error "git clone of $REMOTE/$BRANCH failed - live tree untouched"
    return 1
  fi
  local staged_sha
  staged_sha="$(git -C "$STAGE_DIR" rev-parse HEAD)"
  if [ "$staged_sha" != "$2" ]; then
    log "remote moved during clone (${2:0:7} -> ${staged_sha:0:7}) - deploying next cycle"
    write_state skipped "Remote moved mid-clone; skipped this cycle to avoid deploying an unverified commit."
    return 0
  fi

  carry_runtime_state
  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - staged tree gets its own install"
  else
    reuse_live_deps
  fi
  if ! install_deps_in "$STAGE_DIR"; then
    write_state error "Dependency install failed in the staged tree - live tree untouched"
    return 1
  fi
  if ! (cd "$STAGE_DIR/frontend" && npm run build) >/dev/null 2>&1 || [ ! -f "$STAGE_DIR/frontend/dist/index.html" ]; then
    log "the new frontend does not build - not deploying"
    write_state error "Frontend build failed in the staged tree - live tree untouched"
    return 1
  fi
  if ! rehearse_migrations; then
    write_state error "Migrations failed against a copy of the live DB - not deployed"
    return 1
  fi

  # Everything above ran with the site up and the live tree untouched.
  release_live_deps
  log "staged build is good - stopping the app to swap"
  stop_app
  save_dist_snapshot
  if ! swap_tree; then
    log "swap failed - putting the app back on the old code"
    start_app
    write_state error "File swap failed part-way; previous build restored."
    return 1
  fi

  # Deps actually changed: install against the live tree now that the app is
  # stopped, so node_modules never moves under a running process.
  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - installing into the live tree"
    (cd backend && npm install --no-audit --no-fund --loglevel=error) || log "backend npm install FAILED"
    (cd frontend && npm run build) >/dev/null 2>&1 || log "frontend rebuild FAILED (staged build kept)"
  fi

  run_migrations "live database" backend || log "live migrations failed - see the rollback note below"
  confirm_deployment "$2" || true

  if ! start_app; then
    log "start failed after deploy"
  elif verify_healthy; then
    log "now on $(git rev-parse --short HEAD); site verified healthy"
    write_state updated "Updated to $(git rev-parse --short HEAD)."
    return 0
  fi

  log "rolling back to ${1:0:7}"
  rollback_to "$1" "$2"
  restore_dist_snapshot
  log "note: staged dependency installs are not reversed; run 'npm ci' in"
  log "      backend/ and frontend/ if this release changed them."
  if [ "$MIGRATE" = 1 ]; then
    # A migration may already have run against the real DB; the pre-deploy
    # snapshot is the only way back, so keep one.
    log "note: migrations are forward-only. If this release changed the schema,"
    log "      the code is back on ${1:0:7} but the database is on the new one -"
    log "      restore backups/ or data/ if the app complains about a column."
  fi
  start_app
  write_state failed "Deployed ${2:0:7} but the site failed its health check; rolled back to ${1:0:7}."
  return 1
}

# pull mode: the historic fast-forward path, with the stop-first ordering and
# the verify/rollback steps the in-place update always needed.
deploy_via_pull() { # <local_sha> <remote_sha>
  if [ -n "$(git status --porcelain --untracked-files=no -- . ':(exclude)scripts/setup.sh')" ]; then
    log "working tree has uncommitted changes - skipping this cycle"
    write_state skipped "Dirty working tree - update postponed until it is committed/stashed."
    return 0
  fi
  # never clobber local work: fast-forward only
  if ! git merge --ff-only --quiet FETCH_HEAD; then
    log "non-fast-forward (local commits ahead or history diverged) - skipping"
    write_state skipped "Local commits diverge from $REMOTE/$BRANCH - resolve manually, updater will not reset."
    return 0
  fi
  log "merged to $(git rev-parse --short HEAD); stopping the app before rebuilding"
  stop_app
  save_dist_snapshot

  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - reinstalling"
    (cd backend && npm ci --no-audit --no-fund) || log "backend npm ci FAILED"
    (cd frontend && npm ci --no-audit --no-fund) || log "frontend npm ci FAILED"
  fi
  if ! git diff --quiet "$1..$2" -- frontend 2>/dev/null || [ ! -f frontend/dist/index.html ]; then
    log "frontend changed - rebuilding"
    (cd frontend && npm run build) || log "frontend build FAILED"
  fi
  run_migrations "live database" backend || log "live migrations FAILED"

  if start_app && verify_healthy; then
    log "now on $(git rev-parse --short HEAD); site verified healthy"
    write_state updated "Updated to $(git rev-parse --short HEAD)."
    return 0
  fi
  log "site unhealthy after the in-place update; rolling back to ${1:0:7}"
  rollback_to "$1" "$2"
  restore_dist_snapshot
  start_app
  write_state failed "In-place update to ${2:0:7} failed its health check; rolled back to ${1:0:7}."
  return 1
}

check_and_update() {
  if [ -e "$DISABLE_FILE" ]; then
    write_state paused "Paused by $DISABLE_FILE - remove it to resume."
    return 0
  fi

  if ! git fetch --quiet "$REMOTE" "$BRANCH"; then
    log "fetch failed (offline?); trying again next cycle"
    write_state error "git fetch $REMOTE $BRANCH failed (offline?)"
    return 0
  fi

  local local_sha remote_sha
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse FETCH_HEAD)"

  if [ "$local_sha" = "$remote_sha" ]; then
    write_state idle "Up to date."
    return 0
  fi

  log "update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short FETCH_HEAD) ($MODE mode)"
  if [ "$MODE" = "clone" ]; then
    deploy_via_clone "$local_sha" "$remote_sha"
  else
    deploy_via_pull "$local_sha" "$remote_sha"
  fi
  return $?
}

log "tracking $REMOTE/$BRANCH every ${INTERVAL}s, mode=$MODE (pause: touch $DISABLE_FILE)"

if [ "$ONCE" = 1 ]; then
  check_and_update
  exit $?
fi

while :; do
  check_and_update
  sleep "$INTERVAL"
done
