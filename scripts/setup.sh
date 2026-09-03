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
#   ./scripts/setup.sh --with-tgpt           # also install tgpt (free AI fallback)
#   ./scripts/setup.sh --gemini-key KEY      # use the Gemini API for Barista
#   ./scripts/setup.sh --gemini-key KEY --gemini-model gemini-2.5-pro
#   ./scripts/setup.sh --reset-db            # drop and recreate the database
#   ./scripts/setup.sh --skip-install        # dependencies already installed
#   ./scripts/setup.sh --skip-db             # do not touch the database
#   ./scripts/setup.sh --force-secrets       # regenerate secrets (destroys data!)
#
# For an Ubuntu server (Node install, systemd, nginx) use
# `sudo ./espress0 deploy ...` (scripts/deploy-ubuntu.sh) instead.
#
set -euo pipefail

# --- locate the repository root (script lives in scripts/) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BUILD=0
START=0
WITH_TGPT=0
GEMINI_KEY=""
GEMINI_MODEL=""
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
ok()   { printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
err()  { printf '  %s[x]%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
die()  { err "$1"; exit 1; }

# --- parse arguments ---------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --build)            BUILD=1 ;;
    --start)            START=1 ;;
    --with-tgpt)        WITH_TGPT=1 ;;
    --gemini-key)       GEMINI_KEY="${2:-}"; shift ;;
    --gemini-key=*)     GEMINI_KEY="${1#*=}" ;;
    --gemini-model)     GEMINI_MODEL="${2:-}"; shift ;;
    --gemini-model=*)   GEMINI_MODEL="${1#*=}" ;;
    --skip-install)     SKIP_INSTALL=1 ;;
    --skip-db)          SKIP_DB=1 ;;
    --skip-seed)        SKIP_SEED=1 ;;
    --reset-db)         RESET_DB=1 ;;
    --force-secrets)    FORCE_SECRETS=1 ;;
    --admin-password)   ADMIN_PASSWORD_OVERRIDE="${2:-}"; shift ;;
    --admin-password=*) ADMIN_PASSWORD_OVERRIDE="${1#*=}" ;;
    --wizard)           WIZARD=1 ;;
    --no-wizard)        NO_WIZARD=1 ;;
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
# Interactive wizard. Runs when explicitly asked (--wizard) or when setup is
# invoked with no arguments in a real terminal. Headless shells, flag-driven
# invocations and --no-wizard skip straight to the scripted defaults.
# sits there, even if it was run before. Positional flags are a scripting
RUN_WIZARD=0
if [ "${NO_WIZARD:-0}" -eq 1 ] || [ "${WIZARD:-0}" -eq 1 ]; then
  [ "${WIZARD:-0}" -eq 1 ] && RUN_WIZARD=1
else
  HAS_FLAGS=0
  for a in "$@"; do case "$a" in --*) HAS_FLAGS=1 ;; esac; done
  if [ "$HAS_FLAGS" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
    RUN_WIZARD=1
  fi
fi
# Re-running on an already-configured checkout is "config", not "setup".
[ -f .env ] && CONFIG_MODE=1 || CONFIG_MODE=0

ask() { # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="$2" reply
  if [ -n "$default" ]; then
    printf '  %s?%s %s [%s]: ' "$C_BLUE$C_BOLD" "$C_RESET" "$prompt" "$default" >&2
  else
    printf '  %s?%s %s: ' "$C_BLUE$C_BOLD" "$C_RESET" "$prompt" >&2
  fi
  read -r reply || reply=""
  printf '%s' "${reply:-$default}"
}

ask_yn() { # ask_yn <prompt> <default y|n>
  local prompt="$1" default="$2" reply
  while :; do
    if [ "$default" = y ]; then
      printf '  %s?%s %s [Y/n]: ' "$C_BLUE$C_BOLD" "$C_RESET" "$prompt" >&2
    else
      printf '  %s?%s %s [y/N]: ' "$C_BLUE$C_BOLD" "$C_RESET" "$prompt" >&2
    fi
    read -r reply || reply=""
    case "${reply:-$default}" in
      y|Y|yes) return 0 ;;
      n|N|no)  return 1 ;;
    esac
  done
}

if [ "$RUN_WIZARD" -eq 1 ]; then
  if [ "$CONFIG_MODE" -eq 1 ]; then
    printf '\n%s==> espress0 config wizard%s  (this machine is already set up; Enter keeps current values)\n' "$C_BLUE$C_BOLD" "$C_RESET"
  else
    printf '\n%s==> espress0 setup wizard%s  (press Enter to accept [defaults])\n' "$C_BLUE$C_BOLD" "$C_RESET"
  fi

  # Admin login -----------------------------------------------------------
  WZ_USER_DEFAULT="$(env_value ADMIN_USERNAME || true)"
  WZ_USER="$(ask 'Admin username' "${WZ_USER_DEFAULT:-admin}")"
  [ -n "$WZ_USER" ] && ADMIN_USERNAME_WIZARD="$WZ_USER"

  # Password: empty twice = generate.
  if [ "$CONFIG_MODE" -eq 1 ] && [ -f data/repo.db ]; then
    warn "An admin account already exists in the database — a new password here"
    warn "only applies to a FUTURE reset (change the live one at /profile)."
  fi
  while :; do
    printf '  %s?%s Admin password %s: ' "$C_BLUE$C_BOLD" "$C_RESET" "(empty = generate a random one)" >&2
    read -rs WZ_PW1 || WZ_PW1=""; printf '\n' >&2
    if [ -z "$WZ_PW1" ]; then
      ok "A random admin password will be generated (shown once at the end)."
      break
    fi
    if [ "${#WZ_PW1}" -lt 8 ]; then
      warn "Use at least 8 characters."; continue
    fi
    printf '  %s?%s Repeat it: ' "$C_BLUE$C_BOLD" "$C_RESET" >&2
    read -rs WZ_PW2 || WZ_PW2=""; printf '\n' >&2
    if [ "$WZ_PW1" != "$WZ_PW2" ]; then warn "Passwords don't match, try again."; continue; fi
    ADMIN_PASSWORD_OVERRIDE="$WZ_PW1"
    break
  done

  # Port ------------------------------------------------------------------
  while :; do
    WZ_PORT_DEFAULT="$(env_value PORT || true)"
    WZ_PORT="$(ask 'Port to expose the app on' "${WZ_PORT_DEFAULT:-3000}")"
    case "$WZ_PORT" in
      ''|*[!0-9]*) warn "A port is a number."; continue ;;
    esac
    if [ "$WZ_PORT" -lt 1 ] || [ "$WZ_PORT" -gt 65535 ]; then
      warn "Pick a port between 1 and 65535."; continue
    fi
    [ "$WZ_PORT" -lt 1024 ] && warn "Ports below 1024 need root (or the deploy script's CAP_NET_BIND_SERVICE)."
    break
  done
  PORT_WIZARD="$WZ_PORT"
  if [ "$WZ_PORT" != "80" ] && [ "$WZ_PORT" != "443" ]; then
    printf '       the site will be reachable at http://<this-machine>:%s\n' "$WZ_PORT" >&2
  fi

  # Exposure -------------------------------------------------------------
  WZ_HOST_DEFAULT="$(env_value HOST || true)"
  if [ "${WZ_HOST_DEFAULT:-0.0.0.0}" = "0.0.0.0" ]; then EXPOSE_DEFAULT=y; else EXPOSE_DEFAULT=n; fi
  if ask_yn "Reachable from other machines (bind 0.0.0.0, answer 'no' for localhost-only)" "$EXPOSE_DEFAULT"; then
    HOST_WIZARD=0.0.0.0
    ok "Binding 0.0.0.0 — the site will be reachable on port $WZ_PORT from the network."
    ask_yn "Open the port in ufw now (sudo ufw allow $WZ_PORT/tcp)" "n" && UFW_WIZARD=1
  else
    HOST_WIZARD=127.0.0.1
    ok "Localhost-only (use ssh -L $WZ_PORT:localhost:$WZ_PORT <host> from your laptop to peek)."
  fi

  # AI --------------------------------------------------------------------
  # A key is the good path: no binary to install, no scraping a third-party
  # free tier under a rate limit. Offer it before falling back to tgpt.
  if [ -n "$(env_value AI_API_KEY)" ]; then
    ok "AI_API_KEY is already set in .env — keeping it."
  elif ask_yn "Use a Gemini API key for Barista (recommended; Ask AI + drafting)" "n"; then
    # Hidden input, like the password prompt above: a key pasted at a terminal
    # should not sit on screen or land in shell history.
    printf '  %s?%s Gemini API key %s: ' "$C_BLUE$C_BOLD" "$C_RESET" "(paste; Enter to leave AI_API_KEY empty)" >&2
    read -rs WZ_KEY || WZ_KEY=""; printf '\n' >&2
    [ -n "$WZ_KEY" ] && GEMINI_KEY="$WZ_KEY"
  fi
  if [ -z "$GEMINI_KEY" ] && ! command -v tgpt >/dev/null 2>&1; then
    if ask_yn "No key given — install tgpt instead (free, no key, lower quality)" "n"; then
      WITH_TGPT=1
    fi
  fi

  # How to run afterwards ---------------------------------------------------
  echo >&2
  echo "    How do you want to run it after setup?" >&2
  echo "    1) just install — I'll start it myself" >&2
  echo "    2) dev servers (frontend :5173 + API :$WZ_PORT, hot reload)" >&2
  echo "    3) production build, single origin on :$WZ_PORT" >&2
  echo "    4) background via tmux (survives logout, incl. auto-updater)" >&2
  WZ_RUN="$(ask 'Choice' '1')"
  case "$WZ_RUN" in
    2) START=1 ;;
    3) BUILD=1; START=1 ;;
    4) BUILD=1; RUN_TMUX_WIZARD=1 ;;
    *) ;;
  esac
  echo >&2
fi

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
if [ -n "${ADMIN_USERNAME_WIZARD:-}" ] && [ "$ADMIN_USERNAME_WIZARD" != "$ADMIN_USERNAME_VALUE" ]; then
  set_env_value ADMIN_USERNAME "$ADMIN_USERNAME_WIZARD"
  ADMIN_USERNAME_VALUE="$ADMIN_USERNAME_WIZARD"
  ok "Admin username set to $ADMIN_USERNAME_VALUE"
fi
if [ -n "${PORT_WIZARD:-}" ] && [ "$PORT_WIZARD" != "$(env_value PORT)" ]; then
  set_env_value PORT "$PORT_WIZARD"
  ok "App port set to $PORT_WIZARD"
fi
if [ -n "${HOST_WIZARD:-}" ] && [ "$HOST_WIZARD" != "$(env_value HOST)" ]; then
  set_env_value HOST "$HOST_WIZARD"
  ok "Listening address set to $HOST_WIZARD"
fi
if [ "${UFW_WIZARD:-0}" -eq 1 ]; then
  if command -v sudo >/dev/null 2>&1 && command -v ufw >/dev/null 2>&1; then
    sudo -n ufw allow "${PORT_WIZARD:-3000}/tcp" >/dev/null 2>&1       && ok "ufw allows :${PORT_WIZARD:-3000}/tcp"       || { sudo ufw allow "${PORT_WIZARD:-3000}/tcp" && ok "ufw allows :${PORT_WIZARD:-3000}/tcp"; }
  else
    warn "ufw not available — remember to open :${PORT_WIZARD:-3000} yourself (plus the cloud firewall/NSG on a VM)."
  fi
fi

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
step "Configuring the AI backend (Barista)"

# Order of preference: a key given here, a key already in .env, then the two
# names Google's own SDKs document, then the key an older tgpt setup used. The
# exported names are read from .env only - not the caller's environment - so a
# stray shell variable cannot silently become a persisted secret.
[ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(env_value AI_API_KEY)"
[ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(env_value GEMINI_API_KEY)"
[ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(env_value GOOGLE_API_KEY)"
[ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(env_value TGPT_API_KEY)"

if [ -n "$GEMINI_KEY" ]; then
  set_env_value AI_API_KEY "$GEMINI_KEY"
  set_env_value AI_PROVIDER gemini
  [ -n "$GEMINI_MODEL" ] && set_env_value AI_MODEL "$GEMINI_MODEL"
  ok "AI_PROVIDER=gemini with an API key: Ask AI and admin drafting use the Gemini API."
  ok "Nothing to install; key rotation is just editing AI_API_KEY and restarting."
elif [ "$WITH_TGPT" -eq 1 ]; then
  set_env_value AI_PROVIDER auto
  if command -v tgpt >/dev/null 2>&1; then
    ok "tgpt already installed: $(command -v tgpt)"
  elif [ -x "$SCRIPT_DIR/install-tgpt.sh" ]; then
    "$SCRIPT_DIR/install-tgpt.sh" || warn "tgpt install failed — the admin AI button will fall back to a template outline."
  else
    warn "scripts/install-tgpt.sh is missing; skipping."
  fi
else
  set_env_value AI_PROVIDER auto
  warn "No AI backend configured. Everything still works: 'Ask AI' answers from"
  warn "repository metadata and the admin 'Draft with AI' button produces a"
  warn "filled-in outline instead of prose."
  warn "For model-written answers, either add a key to .env:"
  warn "  AI_API_KEY=<your Gemini key from https://aistudio.google.com/apikey>"
  warn "or install the free CLI:  ./scripts/setup.sh --with-tgpt"
fi

# Warn about a stale .env that would silently degrade the provider. config.js
# prefers AI_* and falls back to TGPT_*, so both are honoured; what bites people
# is TGPT_PROVIDER=openai (etc.) with no key, which used to fail every call.
if [ -z "$(env_value AI_API_KEY)" ] && [ -n "$(env_value TGPT_PROVIDER)" ]; then
  case "$(env_value TGPT_PROVIDER)" in
    openai|deepseek|groq|gemini|mistral|anthropic)
      warn "TGPT_PROVIDER=$(env_value TGPT_PROVIDER) needs a key. AI_PROVIDER=auto now"
      warn "falls back to tgpt's free provider instead of failing every request."
      ;;
  esac
fi

# ==============================================================================
PORT_VALUE="$(env_value PORT)"
[ -n "$PORT_VALUE" ] || PORT_VALUE="3000"

if [ "$BUILD" -eq 1 ]; then
  step "Building the frontend"
  (cd frontend && npm run build) || die "Frontend build failed."
  ok "Built frontend/dist — the backend serves it on http://localhost:${PORT_VALUE}"
fi

# After the first successful run, setup.sh becomes config.sh: re-running it is
# a reconfiguration, not an installation. The updater ignores this pair.
if [ "$(basename "$0")" = "setup.sh" ] && [ -f "$SCRIPT_DIR/setup.sh" ] && [ ! -f "$SCRIPT_DIR/config.sh" ]; then
  if mv "$SCRIPT_DIR/setup.sh" "$SCRIPT_DIR/config.sh" 2>/dev/null; then
    ok "First run complete — scripts/setup.sh is now scripts/config.sh"
    ok "  (re-run with: ./espress0 config)"
  fi
fi

printf '\n%s' "$C_GREEN$C_BOLD"
if [ "$CONFIG_MODE" -eq 1 ]; then echo "  Configuration complete."; else echo "  Setup complete."; fi
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

if [ "${RUN_TMUX_WIZARD:-0}" -eq 1 ]; then
  step "Starting in tmux (app + auto-updater keep running after you log out)"
  exec "$SCRIPT_DIR/start-tmux.sh"
fi

if [ "$START" -eq 1 ]; then
  step "Starting the dev environment"
  if [ "$BUILD" -eq 1 ]; then
    exec "$SCRIPT_DIR/dev.sh" --build
  else
    exec "$SCRIPT_DIR/dev.sh"
  fi
fi
