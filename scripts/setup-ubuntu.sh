#!/usr/bin/env bash
#
# espress0's repo - Ubuntu setup script
#
# Installs Node 20, project dependencies, generates secrets, initialises the
# database, builds the frontend, and optionally installs the systemd service.
#
# Safe to re-run: every step checks whether it is already done.
#
# Usage:
#   ./scripts/setup-ubuntu.sh                 # interactive defaults
#   ./scripts/setup-ubuntu.sh --with-tgpt     # also install the tgpt AI binary
#   ./scripts/setup-ubuntu.sh --with-systemd  # also install + start the service
#   ./scripts/setup-ubuntu.sh --skip-build    # skip the frontend production build
#   ./scripts/setup-ubuntu.sh --start         # (re)start and health-check
#   ./scripts/setup-ubuntu.sh --admin-password 'S3cret!'
#
set -euo pipefail

# --- locate the repository root (script lives in scripts/) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

WITH_TGPT=0
WITH_SYSTEMD=0
SKIP_BUILD=0
START_ONLY=0
ADMIN_PASSWORD_OVERRIDE=""
SERVICE_USER="espress0"

# --- output helpers ----------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi
step() { printf '\n%s==> %s%s\n' "$C_BLUE$C_BOLD" "$1" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
err()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
die()  { err "$1"; exit 1; }

# --- parse arguments ---------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --with-tgpt)       WITH_TGPT=1 ;;
    --with-systemd)    WITH_SYSTEMD=1 ;;
    --skip-build)      SKIP_BUILD=1 ;;
    --start)           START_ONLY=1 ;;
    --admin-password)  ADMIN_PASSWORD_OVERRIDE="${2:-}"; shift ;;
    --admin-password=*) ADMIN_PASSWORD_OVERRIDE="${1#*=}" ;;
    --user)            SERVICE_USER="${2:-}"; shift ;;
    --user=*)          SERVICE_USER="${1#*=}" ;;
    -h|--help)
      # Print the leading comment block, stopping at the first blank line.
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

printf '%s\n' "$C_BOLD"
cat <<'BANNER'
  ███████ ███████ ██████  ██████  ███████ ███████  ██████
  ██      ██      ██   ██ ██   ██ ██      ██      ██    ██
  █████   ███████ ██████  ██████  █████   ███████ ██    ██
  ██           ██ ██      ██           ██      ██ ██    ██
  ███████ ███████ ██      ██      ███████ ███████  ██████
                    Ubuntu setup
BANNER
printf '%s\n' "$C_RESET"
ok "Project root: $ROOT_DIR"

# --- 0. sanity checks --------------------------------------------------------
step "Checking platform"

if grep -qiE '^(ID|ID_LIKE)=.*(ubuntu|debian)' /etc/os-release 2>/dev/null; then
  . /etc/os-release
  ok "${PRETTY_NAME:-Ubuntu}"
else
  warn "This does not look like Ubuntu/Debian. Continuing anyway - apt is required."
fi

if ! command -v apt-get >/dev/null 2>&1; then
  die "apt-get not found. This script targets Ubuntu/Debian."
fi

# Run privileged commands through sudo only when we are not already root.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  ok "Running as root"
else
  if ! command -v sudo >/dev/null 2>&1; then
    die "sudo is required for non-root installs."
  fi
  SUDO="sudo"
  ok "Using sudo for privileged steps"
fi

# --- start / verify ----------------------------------------------------------
# Read the port early: --start needs it without running the install steps.
PORT="$(sed -n 's/^PORT=//p' .env 2>/dev/null | head -1)"
PORT="${PORT:-3000}"

# Start the app and prove it answers. Uses the systemd service when one is
# installed, otherwise runs the built app in the background.
start_and_verify() {
  step "Starting the app on port $PORT"

  if [ -f /etc/systemd/system/espress0-repo.service ] && command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO systemctl enable espress0-repo.service > /dev/null 2>&1 || true
    if $SUDO systemctl restart espress0-repo.service 2>/dev/null; then
      ok "systemd service restarted"
    else
      warn "'systemctl restart' failed (is systemd running?)"
    fi
  else
    # No service installed: run the production build in the background.
    if [ ! -f frontend/dist/index.html ]; then
      warn "No frontend build found - the backend will run API-only."
    fi

    # Stop a previously backgrounded instance by PID file. Deliberately not
    # pkill -f: pattern matching can hit unrelated processes, including this
    # script's own shell.
    PIDFILE="$ROOT_DIR/.app.pid"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      sleep 1
      ok "Stopped previous instance (pid $(cat "$PIDFILE"))"
    fi
    rm -f "$PIDFILE"

    ( cd backend && nohup node src/index.js >> "$ROOT_DIR/backend.log" 2>&1 & echo $! > "$ROOT_DIR/.app.pid" )
    ok "Started in the background (pid $(cat "$PIDFILE" 2>/dev/null || echo '?'), log: backend.log)"
  fi

  step "Verifying it responds"
  if [ "$PORT" = "80" ]; then URL_LOCAL="http://127.0.0.1/api/health"; else URL_LOCAL="http://127.0.0.1:${PORT}/api/health"; fi

  n=1
  while [ "$n" -le 15 ]; do
    sleep 1
    if command -v curl >/dev/null 2>&1 && curl -fsS -m 5 "$URL_LOCAL" > /dev/null 2>&1; then
      ok "GET $URL_LOCAL -> healthy (attempt $n)"
      return 0
    fi
    if ! command -v curl >/dev/null 2>&1 && command -v wget >/dev/null 2>&1 \
       && wget -q -T 5 -O /dev/null "$URL_LOCAL" 2>/dev/null; then
      ok "GET $URL_LOCAL -> healthy (attempt $n)"
      return 0
    fi
    n=$((n + 1))
  done

  err "Nothing answered on $URL_LOCAL after 15 seconds."
  if [ -f /etc/systemd/system/espress0-repo.service ]; then
    $SUDO journalctl -u espress0-repo -n 20 --no-pager 2>/dev/null | sed 's/^/      /' || true
  elif [ -f "$ROOT_DIR/backend.log" ]; then
    warn "Last log lines from backend.log:"
    tail -20 "$ROOT_DIR/backend.log" | sed 's/^/      /'
  fi
  return 1
}

if [ "$START_ONLY" -eq 1 ]; then
  [ -f .env ] || die ".env not found - run the full setup first."
  [ -f backend/src/index.js ] || die "backend/src/index.js not found - is this the repository root?"
  if start_and_verify; then
    printf '\n%s%s Running on port %s %s\n\n' "$C_BOLD" "$C_GREEN" "$PORT" "$C_RESET"
    exit 0
  fi
  exit 1
fi

# --- 1. system packages ------------------------------------------------------
step "Installing system packages"

$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl gnupg git \
  > /dev/null
ok "ca-certificates, curl, gnupg, git"

# --- 2. Node.js 20 -----------------------------------------------------------
step "Checking Node.js"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NEED_NODE=0
    ok "Node $(node -v) already installed"
  else
    warn "Node $(node -v) is too old (need 20+), upgrading"
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - > /dev/null
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs > /dev/null
  ok "Installed Node $(node -v), npm $(npm -v)"
fi

command -v node >/dev/null 2>&1 || die "Node installation failed."
NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is still below the required 20."

# --- 3. .env -----------------------------------------------------------------
step "Configuring .env"

gen_base64() { openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64; }
gen_hex()    { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
gen_password() {
  # 20 chars from an unambiguous alphabet, no shell-hostile characters.
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 18
  printf '%s' 'aA7.'
}

if [ -f .env ]; then
  warn ".env already exists - leaving it untouched."
else
  [ -f .env.example ] || die ".env.example is missing; cannot create .env."
  cp .env.example .env
  chmod 600 .env

  JWT="$(gen_base64)"
  ENC="$(gen_base64)"
  PEPPER="$(gen_hex)"
  ADMIN_PW="${ADMIN_PASSWORD_OVERRIDE:-$(gen_password)}"

  # Escape | and & so they survive in the sed replacement.
  esc() { printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'; }

  sed -i \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(esc "$JWT")|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(esc "$ENC")|" \
    -e "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(esc "$PEPPER")|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(esc "$ADMIN_PW")|" \
    .env

  ok "Created .env with freshly generated secrets (chmod 600)"
  printf '\n  %sSave these now - they are not shown again:%s\n' "$C_BOLD" "$C_RESET"
  printf '    admin user:     %s\n' "$(sed -n 's/^ADMIN_USERNAME=//p' .env | head -1)"
  printf '    admin password: %s%s%s\n' "$C_BOLD" "$ADMIN_PW" "$C_RESET"
  printf '\n'
fi

# Refuse to continue with the shipped placeholders.
if grep -qE '^(JWT_SECRET|ENCRYPTION_KEY|PASSWORD_PEPPER)=change-this-to' .env; then
  die ".env still contains 'change-this-to-*' placeholders. Set real secrets and re-run."
fi
if [ "$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -1)" = "ChangeMe123!" ]; then
  warn "ADMIN_PASSWORD is still the shipped default 'ChangeMe123!'. Change it before exposing this host."
fi
ok "No placeholder secrets present"

# --- 4. dependencies ---------------------------------------------------------
step "Installing dependencies"

for dir in backend frontend; do
  [ -f "$dir/package.json" ] || die "$dir/package.json is missing."
  printf '  installing %s...\n' "$dir"
  (cd "$dir" && npm install --no-audit --no-fund --loglevel=error)
done
ok "backend + frontend dependencies installed"

# --- 5. directories ----------------------------------------------------------
step "Preparing data directories"
mkdir -p data backups backend/data/uploads
ok "data/, backups/, backend/data/uploads/"

# --- 6. database -------------------------------------------------------------
step "Initialising database"
(cd backend && node src/db/migrate.js)
ok "migrations applied"

if [ ! -f data/repo.db ] || [ -z "$(ls -A data 2>/dev/null)" ]; then
  (cd backend && node src/db/seed.js)
  # seed-direct adds the demo items with cover images and download mirrors.
  [ -f backend/src/db/seed-direct.js ] && (cd backend && node src/db/seed-direct.js)
  ok "database seeded"
else
  ok "database already present - skipping seed (re-run manually with: npm --prefix backend run seed)"
fi

# --- 7. frontend build -------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  step "Skipping frontend build (--skip-build)"
else
  step "Building frontend"
  (cd frontend && npm run build)
  ok "built to frontend/dist - the backend serves it on the same port"
fi

# --- 8. tgpt (optional) ------------------------------------------------------
if [ "$WITH_TGPT" -eq 1 ]; then
  step "Installing tgpt (AI backend)"
  bash "$SCRIPT_DIR/install-tgpt.sh" || warn "tgpt install failed - AI falls back to metadata search."
fi

# --- 9. systemd (optional) ---------------------------------------------------
if [ "$WITH_SYSTEMD" -eq 1 ]; then
  step "Installing systemd service"
  [ -f systemd/espress0-repo.service ] || die "systemd/espress0-repo.service is missing."

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    $SUDO useradd --system --home "$ROOT_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    ok "created system user '$SERVICE_USER'"
  else
    ok "user '$SERVICE_USER' already exists"
  fi

  # The committed unit hardcodes /opt/espress0s-repo; rewrite it for this path.
  NODE_BIN="$(command -v node)"
  TMP_UNIT="$(mktemp)"
  sed -e "s|/opt/espress0s-repo|$ROOT_DIR|g" \
      -e "s|^User=.*|User=$SERVICE_USER|" \
      -e "s|^Group=.*|Group=$SERVICE_USER|" \
      -e "s|/usr/bin/node|$NODE_BIN|g" \
      systemd/espress0-repo.service > "$TMP_UNIT"

  $SUDO cp "$TMP_UNIT" /etc/systemd/system/espress0-repo.service
  rm -f "$TMP_UNIT"

  # The service needs to write here.
  $SUDO chown -R "$SERVICE_USER:$SERVICE_USER" data backups backend/data
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable espress0-repo.service > /dev/null 2>&1 || true

  # Tolerate failure here: the service may not start yet (e.g. no systemd in a
  # container), and aborting would hide the diagnostics below.
  if $SUDO systemctl restart espress0-repo.service 2>/dev/null; then
    sleep 2
    if $SUDO systemctl is-active --quiet espress0-repo.service; then
      ok "service running"
    else
      warn "service is installed but not active - check: journalctl -u espress0-repo -n 50"
    fi
  else
    warn "installed the unit but 'systemctl restart' failed (is systemd running?)."
    warn "  start it manually with: sudo systemctl start espress0-repo"
  fi
fi

# --- summary -----------------------------------------------------------------
PORT="$(sed -n 's/^PORT=//p' .env | head -1)"
PORT="${PORT:-3000}"

printf '\n%s%s Setup complete %s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '  Project:    %s\n' "$ROOT_DIR"
printf '  Database:   %s\n' "$ROOT_DIR/data/repo.db"
printf '  Port:       %s\n' "$PORT"

if [ "$WITH_SYSTEMD" -eq 1 ]; then
  printf '\n  Manage the service:\n'
  printf '    sudo systemctl status espress0-repo\n'
  printf '    sudo journalctl -u espress0-repo -f\n'
else
  printf '\n  Run it:\n'
  printf '    ./scripts/dev.sh              # dev, frontend on :5173 + API on :%s\n' "$PORT"
  printf '    ./scripts/dev.sh --build      # production, everything on :%s\n' "$PORT"
  printf '\n  Or install as a service:\n'
  printf '    ./scripts/setup-ubuntu.sh --with-systemd\n'
fi

start_and_verify || warn "Setup finished but the app is not answering - see the errors above."

printf '\n  %sReminder:%s rotate the admin password and back up .env somewhere safe.\n\n' "$C_YELLOW" "$C_RESET"
