#!/usr/bin/env bash
#
# espress0's repo - local setup
#
# One command to go from a fresh checkout to a running dev environment on
# Linux, macOS or WSL. No root, no apt, nothing installed system-wide:
#
#   1. checks Node / npm (and the toolchain better-sqlite3 needs)
#   2. creates .env from .env.example and fills in real secrets
#   3. creates data/, data/uploads/ and backups/
#   4. installs backend + frontend dependencies
#   5. runs migrations and seeds the database
#   6. optionally builds the frontend and starts the dev servers
#
# Safe to re-run: existing secrets, database and uploads are never overwritten.
#
# Usage:
#   ./scripts/setup.sh                       # full setup, then print next steps
#   ./scripts/setup.sh --start               # ... and start the dev servers
#   ./scripts/setup.sh --build --start       # ... single origin on :3000
#   ./scripts/setup.sh --admin-password 'S3cret!'
#   ./scripts/setup.sh --with-tgpt           # also install tgpt (AI drafting)
#   ./scripts/setup.sh --reset-db            # drop and recreate the database
#   ./scripts/setup.sh --skip-install        # dependencies already installed
#   ./scripts/setup.sh --skip-db             # do not touch the database
#   ./scripts/setup.sh --force-secrets       # regenerate secrets (destroys data!)
#
# For an Ubuntu server (Node install, systemd, nginx) use
# scripts/setup-ubuntu.sh or scripts/deploy-ubuntu.sh instead.
#
set -euo pipefail

# --- locate the repository root (script lives in scripts/) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BUILD=0
START=0
WITH_TGPT=0
SKIP_INSTALL=0
SKIP_DB=0
SKIP_SEED=0
RESET_DB=0
FORCE_SECRETS=0
ADMIN_PASSWORD_OVERRIDE=""
GENERATED_ADMIN_PASSWORD=""

MIN_NODE_MAJOR=18
RECOMMENDED_NODE_MAJOR=20

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
    --build)            BUILD=1 ;;
    --start)            START=1 ;;
    --with-tgpt)        WITH_TGPT=1 ;;
    --skip-install)     SKIP_INSTALL=1 ;;
    --skip-db)          SKIP_DB=1 ;;
    --skip-seed)        SKIP_SEED=1 ;;
    --reset-db)         RESET_DB=1 ;;
    --force-secrets)    FORCE_SECRETS=1 ;;
    --admin-password)   ADMIN_PASSWORD_OVERRIDE="${2:-}"; shift ;;
    --admin-password=*) ADMIN_PASSWORD_OVERRIDE="${1#*=}" ;;
    -h|--help)
      # Print the leading comment block, stopping at the first non-comment line.
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# --- secret generation -------------------------------------------------------
# openssl is present nearly everywhere; Node is a hard requirement anyway, so it
# is a guaranteed fallback.
rand_base64() {
  openssl rand -base64 32 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
}
rand_hex() {
  openssl rand -hex 32 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}
rand_password() {
  # Readable-ish but strong: 24 chars, no shell-hostile characters.
  local raw
  raw="$(openssl rand -base64 48 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  printf '%s' "$raw" | tr -d '/+=\n' | cut -c1-24
}

# --- .env helpers ------------------------------------------------------------
env_value() {
  # Prints the current value of KEY in .env (empty if unset).
  [ -f .env ] || return 0
  KEY="$1" awk -F= '
    BEGIN { k = ENVIRON["KEY"] }
    index($0, k "=") == 1 { sub("^" k "=", ""); print; exit }
  ' .env
}

set_env_value() {
  # Replaces (or appends) KEY=VALUE without interpreting slashes, +, & etc.
  local key="$1" value="$2"
  if [ -f .env ] && KEY="$key" awk 'BEGIN{k=ENVIRON["KEY"]} index($0,k"=")==1{found=1} END{exit !found}' .env; then
    KEY="$key" VALUE="$value" awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
      index($0, k "=") == 1 && !done { print k "=" v; done = 1; next }
      { print }
    ' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

needs_secret() {
  # True when the value is missing or still one of the shipped placeholders.
  local value="$1"
  [ -z "$value" ] && return 0
  case "$value" in
    *change-this*|*ChangeMe123!*|*CHANGE_ME*) return 0 ;;
  esac
  return 1
}

# ==============================================================================
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node ${RECOMMENDED_NODE_MAJOR}+ from https://nodejs.org and re-run."
command -v npm  >/dev/null 2>&1 || die "npm is not installed (it ships with Node.js)."

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node $NODE_VERSION is too old — this project needs Node ${MIN_NODE_MAJOR}+ (${RECOMMENDED_NODE_MAJOR}+ recommended)."
fi
if [ "$NODE_MAJOR" -lt "$RECOMMENDED_NODE_MAJOR" ]; then
  warn "Node $NODE_VERSION works, but ${RECOMMENDED_NODE_MAJOR}+ is what this project is tested on."
else
  ok "Node $NODE_VERSION"
fi
ok "npm $(npm -v)"

# better-sqlite3 ships prebuilt binaries, but falls back to compiling. Warn now
# rather than halfway through a long install.
if [ "$SKIP_INSTALL" -eq 0 ] && [ ! -d backend/node_modules/better-sqlite3 ]; then
  MISSING_TOOLS=""
  for tool in python3 make; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS $tool"
  done
  command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1 \
    || MISSING_TOOLS="$MISSING_TOOLS a C compiler"
  if [ -n "$MISSING_TOOLS" ]; then
    warn "Missing:${MISSING_TOOLS}. better-sqlite3 normally downloads a prebuilt binary,"
    warn "but if that fails it compiles from source and will need them"
    warn "(Debian/Ubuntu: sudo apt install -y build-essential python3 — macOS: xcode-select --install)."
  fi
fi

# ==============================================================================
step "Configuring .env"

if [ ! -f .env ]; then
  [ -f .env.example ] || die ".env.example is missing — is this the repository root?"
  cp .env.example .env
  # A fresh local checkout is a dev environment; the example ships production
  # defaults because it doubles as the server template.
  set_env_value NODE_ENV development
  ok "Created .env from .env.example"
else
  ok ".env already exists — keeping your values"
fi
chmod 600 .env 2>/dev/null || true

# JWT_SECRET / ENCRYPTION_KEY / PASSWORD_PEPPER.
#
# ENCRYPTION_KEY decrypts existing rows: rotating it makes stored download URLs
# and storage paths unreadable, so it is only ever written when it is still a
# placeholder (or --force-secrets is given, which says "I know").
for pair in "JWT_SECRET:base64" "ENCRYPTION_KEY:base64" "PASSWORD_PEPPER:hex"; do
  key="${pair%%:*}"; kind="${pair##*:}"
  current="$(env_value "$key")"
  if [ "$FORCE_SECRETS" -eq 1 ] || needs_secret "$current"; then
    if [ "$key" = "ENCRYPTION_KEY" ] && [ "$FORCE_SECRETS" -eq 1 ] && ! needs_secret "$current"; then
      warn "Rotating ENCRYPTION_KEY — previously encrypted URLs and paths become unreadable."
    fi
    if [ "$kind" = "base64" ]; then set_env_value "$key" "$(rand_base64)"; else set_env_value "$key" "$(rand_hex)"; fi
    ok "Generated $key"
  else
    ok "$key already set"
  fi
done

# Admin password.
current_admin="$(env_value ADMIN_PASSWORD)"
if [ -n "$ADMIN_PASSWORD_OVERRIDE" ]; then
  set_env_value ADMIN_PASSWORD "$ADMIN_PASSWORD_OVERRIDE"
  GENERATED_ADMIN_PASSWORD="$ADMIN_PASSWORD_OVERRIDE"
  ok "Admin password set from --admin-password"
elif [ "$FORCE_SECRETS" -eq 1 ] || needs_secret "$current_admin"; then
  GENERATED_ADMIN_PASSWORD="$(rand_password)"
  set_env_value ADMIN_PASSWORD "$GENERATED_ADMIN_PASSWORD"
  ok "Generated a random admin password (shown at the end)"
else
  ok "Admin password already set"
fi

# The seeded admin is only created on the first seed; changing ADMIN_PASSWORD
# later does not rewrite an existing account.
ADMIN_USERNAME_VALUE="$(env_value ADMIN_USERNAME)"
[ -n "$ADMIN_USERNAME_VALUE" ] || ADMIN_USERNAME_VALUE="admin"

# ==============================================================================
step "Creating local directories"

for dir in data data/uploads backups; do
  if [ -d "$dir" ]; then
    ok "$dir/ exists"
  else
    mkdir -p "$dir"
    ok "Created $dir/"
  fi
done

# ==============================================================================
if [ "$SKIP_INSTALL" -eq 1 ]; then
  step "Skipping dependency install (--skip-install)"
else
  step "Installing dependencies"
  for pkg in backend frontend; do
    if [ -d "$pkg/node_modules" ] && [ -n "$(ls -A "$pkg/node_modules" 2>/dev/null)" ]; then
      printf '  installing/updating %s ...\n' "$pkg"
    else
      printf '  installing %s (first run, this takes a minute) ...\n' "$pkg"
    fi
    (cd "$pkg" && npm install --no-audit --no-fund) \
      || die "npm install failed in $pkg/. Fix the error above and re-run."
    ok "$pkg dependencies ready"
  done
fi

# ==============================================================================
DB_PATH="$(env_value DATABASE_PATH)"
[ -n "$DB_PATH" ] || DB_PATH="./data/repo.db"

if [ "$SKIP_DB" -eq 1 ]; then
  step "Skipping database setup (--skip-db)"
else
  step "Setting up the database"

  if [ "$RESET_DB" -eq 1 ] && [ -f "$DB_PATH" ]; then
    STAMP="$(date +%Y%m%d-%H%M%S)"
    mv "$DB_PATH" "${DB_PATH}.${STAMP}.bak"
    rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
    warn "Existing database moved to ${DB_PATH}.${STAMP}.bak"
  fi

  DB_EXISTED=0
  [ -f "$DB_PATH" ] && DB_EXISTED=1

  npm --prefix backend run migrate >/dev/null || die "Migrations failed. Run 'npm --prefix backend run migrate' to see the full output."
  ok "Migrations applied"

  if [ "$SKIP_SEED" -eq 1 ]; then
    warn "Skipping seed (--skip-seed)"
  else
    # seed.js is idempotent: it creates the admin, categories and settings only
    # when they are missing, so re-running never clobbers your content.
    npm --prefix backend run seed >/dev/null || die "Seeding failed. Run 'npm --prefix backend run seed' to see the full output."
    if [ "$DB_EXISTED" -eq 1 ]; then
      ok "Database up to date (existing data kept)"
    else
      ok "Database created and seeded at $DB_PATH"
    fi
  fi
fi

# ==============================================================================
step "Checking the AI drafting backend (tgpt)"

if command -v tgpt >/dev/null 2>&1; then
  ok "tgpt found: $(command -v tgpt)"
elif [ "$WITH_TGPT" -eq 1 ]; then
  if [ -x "$SCRIPT_DIR/install-tgpt.sh" ]; then
    "$SCRIPT_DIR/install-tgpt.sh" || warn "tgpt install failed — the admin AI button will fall back to a template outline."
  else
    warn "scripts/install-tgpt.sh is missing; skipping."
  fi
else
  warn "tgpt is not installed. Everything works without it: 'Ask AI' falls back to"
  warn "metadata search, and the admin 'Draft with AI' button produces a filled-in"
  warn "outline instead of prose. Install later with ./scripts/setup.sh --with-tgpt"
fi

# ==============================================================================
PORT_VALUE="$(env_value PORT)"
[ -n "$PORT_VALUE" ] || PORT_VALUE="3000"

if [ "$BUILD" -eq 1 ]; then
  step "Building the frontend"
  (cd frontend && npm run build) || die "Frontend build failed."
  ok "Built frontend/dist — the backend serves it on http://localhost:${PORT_VALUE}"
fi

printf '\n%s' "$C_GREEN$C_BOLD"
cat <<'BANNER'
  Setup complete.
BANNER
printf '%s\n' "$C_RESET"

cat <<EOF
  Sign in at /login with:
    username  ${ADMIN_USERNAME_VALUE}
EOF
if [ -n "$GENERATED_ADMIN_PASSWORD" ]; then
  printf '    password  %s%s%s\n' "$C_BOLD" "$GENERATED_ADMIN_PASSWORD" "$C_RESET"
  printf '              %s(shown once — it is stored in .env as ADMIN_PASSWORD)%s\n' "$C_YELLOW" "$C_RESET"
else
  printf '    password  (the ADMIN_PASSWORD already in your .env)\n'
fi

cat <<EOF

  Start it:
    ./scripts/dev.sh            frontend http://localhost:5173 + API :${PORT_VALUE}
    ./scripts/dev.sh --build    single origin on http://localhost:${PORT_VALUE}

  Manage file pages at /admin/items — "New page" starts from a template,
  writes the description in markdown (with an AI draft button) and detects the
  provider from a pasted download link.

  Re-run this script any time; it never overwrites secrets, the database or uploads.
EOF

if [ "$START" -eq 1 ]; then
  step "Starting the dev environment"
  if [ "$BUILD" -eq 1 ]; then
    exec "$SCRIPT_DIR/dev.sh" --build
  else
    exec "$SCRIPT_DIR/dev.sh"
  fi
fi
