#!/usr/bin/env bash
# Run espress0's repo in the background inside a tmux session.
#
#   ./scripts/start-tmux.sh             built UI, single origin on :3000
#   ./scripts/start-tmux.sh dev         backend :3000 + Vite dev server :5173
#   ./scripts/start-tmux.sh --build     force a fresh frontend build first
#   ./scripts/start-tmux.sh --no-updater   don't start the auto-update window
#
#   ./scripts/start-tmux.sh stop        kill the session
#   ./scripts/start-tmux.sh restart     stop, then start again
#   ./scripts/start-tmux.sh status      show session + window health
#   ./scripts/start-tmux.sh logs        attach to the session (Ctrl-B D detaches)
#
# Why tmux: the app survives SSH logouts, and you can always attach to read
# what the server and the updater are doing live.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SESSION="${TMUX_SESSION_NAME:-espress0}"
MODE="build"           # build | dev
FORCE_BUILD=0
WITH_UPDATER=1

usage() {
  sed -n '2,16p' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    dev)          MODE=dev ;;
    --build)      FORCE_BUILD=1 ;;
    --no-updater) WITH_UPDATER=0 ;;
    stop|restart|status|logs) ACTION="$1" ;;
    -h|--help)    usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "!! '$1' is not installed. Debian/Ubuntu: sudo apt install $1" >&2; exit 1; }; }

case "${ACTION:-start}" in
  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "tmux session '$SESSION' is running:"
      tmux list-windows -t "$SESSION" -F "  #I: #W (pane alive: #{?pane_dead,no,yes})"
      ST_PORT="$(awk -F= '/^PORT=/{print $2}' .env 2>/dev/null)"; ST_PORT="${ST_PORT:-3000}"
      ST_HOST="$(awk -F= '/^HOST=/{print $2}' .env 2>/dev/null)"; ST_HOST="${ST_HOST:-0.0.0.0}"
      if ss -ltn 2>/dev/null | grep -q ":$ST_PORT "; then
        echo "  backend:  http://localhost:$ST_PORT (listening, bound to $ST_HOST)"
      else
        echo "  backend:  nothing on :$ST_PORT yet"
      fi
      ss -ltn 2>/dev/null | grep -q ":5173 " && echo "  frontend: http://localhost:5173 (listening)" || true
    else
      echo "No tmux session '$SESSION'. Start it with: ./scripts/start-tmux.sh"
    fi
    exit 0 ;;
  logs)
    tmux attach -t "$SESSION" || { echo "No session '$SESSION' to attach to."; exit 1; }
    exit 0 ;;
  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "Stopped session '$SESSION'." \
      || echo "No session '$SESSION' was running."
    exit 0 ;;
  restart)
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Restarting..."
    ;;
esac

need tmux
need node
need npm
need git

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' is already running."
  echo "  attach:  tmux attach -t $SESSION"
  echo "  stop:    ./scripts/start-tmux.sh stop"
  exit 0
fi

[ -f .env ] || { echo "!! No .env found — run ./scripts/setup.sh first." >&2; exit 1; }

install_if_needed() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ] || [ -z "$(ls -A "$dir/node_modules" 2>/dev/null)" ]; then
    echo "==> Installing $dir dependencies"
    (cd "$dir" && npm install --no-audit --no-fund)
  fi
}
install_if_needed backend
install_if_needed frontend

# PORT/HOST come from .env (set by the wizard); config.js falls back to
# 3000 / 0.0.0.0. Shell-env PORT/HOST, when exported, still win over .env.
LAUNCH_BACKEND='cd backend && NODE_ENV=production node src/index.js'

if [ "$MODE" = "build" ]; then
  if [ "$FORCE_BUILD" = 1 ] || [ ! -f frontend/dist/index.html ]; then
    echo "==> Building frontend"
    (cd frontend && npm run build)
  fi
  tmux new-session -d -s "$SESSION" -n app "cd '$ROOT' && $LAUNCH_BACKEND; echo; echo '[exited — press Ctrl-B D to leave, or ./scripts/start-tmux.sh restart]'; read"
else
  tmux new-session -d -s "$SESSION" -n backend "cd '$ROOT' && $LAUNCH_BACKEND; echo '[backend exited]'; read"
  tmux new-window  -t "$SESSION" -n frontend "cd '$ROOT/frontend' && npm run dev -- --host; echo '[frontend exited]'; read"
fi

if [ "$WITH_UPDATER" = 1 ]; then
  tmux new-window -t "$SESSION" -n updater \
    "cd '$ROOT' && ./scripts/auto-update.sh --tmux-session '$SESSION'; echo '[updater exited — remove data/.auto-update-disabled to re-enable]'; read"
fi

echo
echo "Running in tmux session '$SESSION' ($([ "$MODE" = dev ] && echo 'dev :5173+3000' || echo 'single origin :3000'))$([ "$WITH_UPDATER" = 1 ] && echo ', auto-updater on')."
echo "  watch:   ./scripts/start-tmux.sh status"
echo "  logs:    tmux attach -t $SESSION      (Ctrl-B D to detach, Ctrl-B N/P to switch windows)"
echo "  stop:    ./scripts/start-tmux.sh stop"
echo
echo "Auto-update: checks origin every 5 min; pause it with: touch data/.auto-update-disabled"
