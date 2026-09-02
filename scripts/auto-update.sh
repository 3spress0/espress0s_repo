#!/usr/bin/env bash
# Auto-update espress0's repo from its git remote.
#
#   ./scripts/auto-update.sh                    watch mode: check every 5 min
#   ./scripts/auto-update.sh --interval 600     watch mode with a 10 min cadence
#   ./scripts/auto-update.sh --once             check once and exit (cron-friendly)
#   ./scripts/auto-update.sh --branch main      track a specific branch
#   ./scripts/auto-update.sh --service NAME     restart this systemd unit after update
#   ./scripts/auto-update.sh --tmux-session N   restart the tmux app window after update
#
# Safety:
#   * Only fast-forward pulls are applied. Local commits/divergence are never
#     reset away - the cycle is skipped and logged instead.
#   * A dirty working tree blocks updates until cleaned.
#   * .env, uploads/ and data/ are gitignored and never touched.
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
STATE_FILE="data/.auto-update-status"
DISABLE_FILE="data/.auto-update-disabled"
LOCK_FILE="data/.auto-update.lock"

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
    -h|--help)        sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; sed -n '2,21p' "$0" >&2; exit 1 ;;
  esac
  shift
done

case "$INTERVAL" in (*[!0-9]*|'') echo "!! --interval must be a number of seconds." >&2; exit 1 ;; esac
[ "$INTERVAL" -lt 30 ] && INTERVAL=30   # be nice to the remote (and the disk)

mkdir -p data
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

restarted_notice() {
  if [ -n "$SERVICE" ]; then
    log "restarting systemd service: $SERVICE"
    if systemctl restart "$SERVICE" 2>/dev/null; then
      log "$SERVICE restarted."
    elif command -v sudo >/dev/null 2>&1 && sudo -n systemctl restart "$SERVICE" 2>/dev/null; then
      log "$SERVICE restarted via passwordless sudo."
    else
      log "could not restart $SERVICE - grant it with: echo \"$(id -un) ALL=(root) NOPASSWD: $(command -v systemctl) restart $SERVICE\" > /etc/sudoers.d/espress0-updater"
    fi
  elif [ -n "$TMUX_SESSION" ] && command -v tmux >/dev/null 2>&1 \
       && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "restarting tmux app window in session '$TMUX_SESSION'"
    # Kill whatever runs in the 'app' window; start-tmux's read-trap is bypassed
    # by respawning the window.
    if tmux list-windows -t "$TMUX_SESSION" -F '#W' | grep -qx app; then
      tmux respawn-window -k -t "$TMUX_SESSION:app" \
        "cd '$ROOT' && cd backend && NODE_ENV=production PORT=\${PORT:-3000} HOST=0.0.0.0 node src/index.js; echo '[app exited]'; read"
    elif tmux list-windows -t "$TMUX_SESSION" -F '#W' | grep -qx backend; then
      tmux respawn-window -k -t "$TMUX_SESSION:backend" \
        "cd '$ROOT' && cd backend && NODE_ENV=production PORT=\${PORT:-3000} HOST=0.0.0.0 node src/index.js; echo '[backend exited]'; read"
    else
      log "no 'app'/'backend' window in session '$TMUX_SESSION' - skipping restart"
    fi
  else
    log "no restart target configured - restart the app yourself (or pass --service/--tmux-session)"
  fi
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

  log "update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short FETCH_HEAD)"

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
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

  # Rebuild only what changed.
  if ! git diff --quiet "${local_sha}..HEAD" -- backend/package.json backend/package-lock.json; then
    log "backend dependencies changed - npm ci"
    (cd backend && npm ci --no-audit --no-fund) || log "backend npm ci FAILED"
  fi
  if ! git diff --quiet "${local_sha}..HEAD" -- frontend/package.json frontend/package-lock.json; then
    log "frontend dependencies changed - npm ci"
    (cd frontend && npm ci --no-audit --no-fund) || log "frontend npm ci FAILED"
  fi
  if ! git diff --quiet "${local_sha}..HEAD" -- frontend || [ ! -f frontend/dist/index.html ]; then
    log "frontend changed - rebuilding"
    (cd frontend && npm run build) || log "frontend build FAILED"
  fi

  log "now on $(git rev-parse --short HEAD); restarting app"
  restarted_notice
  write_state updated "Updated to $(git rev-parse --short HEAD)."
}

log "tracking $REMOTE/$BRANCH every ${INTERVAL}s (pause: touch $DISABLE_FILE)"

if [ "$ONCE" = 1 ]; then
  check_and_update
  exit 0
fi

while :; do
  check_and_update
  sleep "$INTERVAL"
done
