#!/usr/bin/env bash
# Start the espress0 repo dev environment.
#
#   ./scripts/dev.sh            backend (:3000) + frontend dev server (:5173)
#   ./scripts/dev.sh --build    backend only, serving the production build
#
# Installs dependencies first if node_modules is missing (workspace snapshots
# exclude node_modules, so a restored checkout always needs this).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "!! No .env found. Copy .env.example to .env and set JWT_SECRET etc." >&2
  exit 1
fi

install_if_needed() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ] || [ -z "$(ls -A "$dir/node_modules" 2>/dev/null)" ]; then
    echo "==> Installing $dir dependencies"
    (cd "$dir" && npm install --no-audit --no-fund)
  else
    echo "==> $dir dependencies present"
  fi
}

install_if_needed backend
install_if_needed frontend

if [ "${1:-}" = "--build" ]; then
  echo "==> Building frontend"
  (cd frontend && npm run build)
  echo "==> Starting backend (serves the built frontend on :3000)"
  exec npm --prefix backend run dev
fi

echo "==> Starting backend on :3000"
npm --prefix backend run dev &
BACKEND_PID=$!

echo "==> Starting frontend dev server on :5173 (proxies /api to :3000)"
npm --prefix frontend run dev &
FRONTEND_PID=$!

trap 'kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true' INT TERM
wait
