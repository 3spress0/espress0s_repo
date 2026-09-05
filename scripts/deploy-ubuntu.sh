#!/usr/bin/env bash
#
# espress0's repo - Ubuntu production deployment
#
# Deploys this project on an Ubuntu server as a systemd service behind nginx,
# with an optional Let's Encrypt certificate. The website is served on port 80
# by default. Idempotent: safe to re-run for updates, it will pull, rebuild and
# restart without wiping data.
#
# Two topologies:
#   - no --domain: the app itself listens publicly on port 80 (change with
#     --port). Handy for quick IP-only deployments.
#   - with --domain: nginx listens publicly on 80 (and 443 with --https) and
#     proxies to the app, which binds 127.0.0.1:3000 (change with --port) so
#     the app port is never exposed to the internet.
#
# First deploy (run from inside the checked-out repository):
#
#   ./scripts/deploy-ubuntu.sh --repo https://github.com/you/espress0s-repo.git
#   ./scripts/deploy-ubuntu.sh --repo <url> --domain repo.example.com --https
#
# Update an existing deployment to the latest commit:
#
#   sudo ./scripts/deploy-ubuntu.sh --update
#   sudo ./scripts/deploy-ubuntu.sh --update --branch staging
#   sudo ./scripts/deploy-ubuntu.sh --update --repo <url>     # change the source
#
# Just (re)start and health-check an existing deployment:
#
#   sudo ./scripts/deploy-ubuntu.sh --start
#
# Automatic updates are installed and enabled by default: a second systemd unit
# (<app>-updater) watches the git remote and performs a staged, health-verified,
# rollback-capable deploy. It is generated from THIS installation directory, so
# a checkout in /home/<user>/espress0s_repo works exactly like /opt. Opt out
# with --no-auto-update.
#
# The repository URL is remembered in /etc/espress0-repo/deploy.conf, so
# --update needs no arguments after the first run. .env, data/ and backups/
# are never touched by an update.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="espress0-repo"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
# Override with APP_CONFIG_DIR to manage several deployments on one host.
CONFIG_DIR="${APP_CONFIG_DIR:-/etc/${APP_NAME}}"
CONFIG_FILE="${CONFIG_DIR}/deploy.conf"
APP_USER="espress0"
# The website is served on port 80 by default. Ports below 1024 are privileged,
# so the systemd unit grants CAP_NET_BIND_SERVICE to the unprivileged service
# user; see the "Installing systemd service" step.
APP_PORT=80
DOMAIN=""
WANT_HTTPS=0
WITH_TGPT=0
GEMINI_KEY=""
GEMINI_MODEL=""
UPDATE_ONLY=0
RESUME=0
START_ONLY=0
SKIP_FIREWALL=0
AUTO_UPDATE=1
PORT_GIVEN=0
REPO_URL=""
BRANCH=""
# Untracked files an update must never lose (all gitignored).
KEEP_FILES=".env"

# --- output ------------------------------------------------------------------
if [ -t 1 ]; then
  R=$'\033[0m'; B=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[36m'
else
  R=""; B=""; RED=""; GRN=""; YEL=""; BLU=""
fi
step() { printf '\n%s==> %s%s\n' "${BLU}${B}" "$1" "$R"; }
ok()   { printf '  %s[ok]%s %s\n' "$GRN" "$R" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$R" "$1"; }
err()  { printf '  %s[x]%s %s\n' "$RED" "$R" "$1" >&2; }
die()  { err "$1"; exit 1; }

usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; }

# --- args --------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)          DOMAIN="${2:-}"; shift ;;
    --domain=*)        DOMAIN="${1#*=}" ;;
    --https)           WANT_HTTPS=1 ;;
    --port)            APP_PORT="${2:-}"; PORT_GIVEN=1; shift ;;
    --port=*)          APP_PORT="${1#*=}"; PORT_GIVEN=1 ;;
    --user)            APP_USER="${2:-}"; shift ;;
    --user=*)          APP_USER="${1#*=}" ;;
    --update)          UPDATE_ONLY=1 ;;
    --resume)          RESUME=1 ;;
    --start)           START_ONLY=1 ;;
    --repo)            REPO_URL="${2:-}"; shift ;;
    --repo=*)          REPO_URL="${1#*=}" ;;
    --branch)          BRANCH="${2:-}"; shift ;;
    --branch=*)        BRANCH="${1#*=}" ;;
    --with-tgpt)       WITH_TGPT=1 ;;
    --gemini-key)      GEMINI_KEY="${2:-}"; shift ;;
    --gemini-key=*)    GEMINI_KEY="${1#*=}" ;;
    --gemini-model)    GEMINI_MODEL="${2:-}"; shift ;;
    --gemini-model=*)  GEMINI_MODEL="${1#*=}" ;;
    --skip-firewall)   SKIP_FIREWALL=1 ;;
    --no-auto-update)  AUTO_UPDATE=0 ;;
    --auto-update)     AUTO_UPDATE=1 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

[ "$WANT_HTTPS" -eq 1 ] && [ -z "$DOMAIN" ] && die "--https requires --domain <hostname>."
case "$APP_PORT" in (*[!0-9]*|'') die "--port must be a number." ;; esac

# Public vs internal listener. With a domain, nginx owns 80/443 and proxies to
# the app over loopback; the app must NOT also grab :80. Without a domain the
# app is the public listener and binds APP_PORT directly.
# Before this split, --domain made nginx and the app race for 0.0.0.0:80.
if [ -n "$DOMAIN" ]; then
  APP_HOST=127.0.0.1
  INTERNAL_PORT=3000
  if [ "${PORT_GIVEN:-0}" = "1" ]; then
    # An explicit --port pins the internal listener instead of the default 3000.
    INTERNAL_PORT="$APP_PORT"
  elif [ -f .env ]; then
    # Keep an existing deployment's custom internal port if there is one
    # (80/443 mean the pre-fix topology, where the app raced nginx for :80).
    EXISTING_PORT="$(sed -n 's|^PORT=\([0-9][0-9]*\).*|\1|p' .env | head -1)"
    case "$EXISTING_PORT" in
      ""|80|443) INTERNAL_PORT=3000 ;;
      *)          INTERNAL_PORT="$EXISTING_PORT" ;;
    esac
  fi
else
  APP_HOST=0.0.0.0
  INTERNAL_PORT="$APP_PORT"
fi

printf '%s\n' "$B"
cat <<'BANNER'
  ░█▀▀░█▀▀░█▀█░█▀▄░█▀▀░█▀▀░█▀▀░▄▀▄░▀░█▀▀░░░█▀▄░█▀▀░█▀█░█▀█
  ░█▀▀░▀▀█░█▀▀░█▀▄░█▀▀░▀▀█░▀▀█░█/█░░░▀▀█░░░█▀▄░█▀▀░█▀▀░█░█
  ░▀▀▀░▀▀▀░▀░░░▀░▀░▀▀▀░▀▀▀░▀▀▀░░▀░░░░▀▀▀░░░▀░▀░▀▀▀░▀░░░▀▀▀
                    Ubuntu deployment
BANNER
printf '%s\n' "$R"
ok "Project:  $ROOT_DIR"
ok "Service:  $APP_NAME (user $APP_USER, port $APP_PORT)"
[ -n "$DOMAIN" ] && ok "Domain:   $DOMAIN$( [ "$WANT_HTTPS" -eq 1 ] && echo ' (HTTPS)')"

# --- prerequisites -----------------------------------------------------------
step "Checking prerequisites"

grep -qiE '^(ID|ID_LIKE)=.*(ubuntu|debian)' /etc/os-release 2>/dev/null \
  || warn "This does not look like Ubuntu/Debian - apt is required."
command -v apt-get >/dev/null 2>&1 || die "apt-get not found."

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  warn "Running as root. A dedicated service user is still recommended."
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required for non-root deploys."
  SUDO="sudo"
fi

# $SUDO is either "sudo" or "" (already root), and that empty case bites twice:
#   - `$SUDO VAR=value cmd` is NOT an environment assignment. Bash decides what
#     is an assignment before it expands $SUDO, so with SUDO="" the word
#     "VAR=value" becomes the command: "DEBIAN_FRONTEND=noninteractive: command
#     not found". Pass assignments through `env` instead.
#   - `$SUDO -E bash -` fails the same way ("-E: command not found"), so
#     anything piped into a root shell goes through this helper.
root_bash() { if [ -n "$SUDO" ]; then $SUDO -E bash -; else bash -; fi; }

for f in backend/package.json frontend/package.json .env.example systemd/${APP_NAME}.service systemd/${APP_NAME}-updater.service; do
  [ -e "$f" ] || die "Missing $f - run this script from the repository root."
done
ok "Repository layout looks correct"

# --- resolve the source repository -------------------------------------------
# Precedence: --repo flag, then the saved config, then the git remote.
# The result is persisted so later `--update` runs need no arguments.
read_saved_conf() {
  [ -r "$CONFIG_FILE" ] || return 0
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  [ -n "${REPO_URL:-}" ] || REPO_URL="${SAVED_REPO_URL:-}"
  [ -n "${DOMAIN:-}" ]   || DOMAIN="${SAVED_DOMAIN:-}"
  [ -n "${SAVED_PORT:-}" ] && [ "$APP_PORT" = "80" ] && APP_PORT="$SAVED_PORT"
  [ -n "${SAVED_HTTPS:-}" ] && [ "$WANT_HTTPS" -eq 0 ] && WANT_HTTPS="$SAVED_HTTPS"
}

detect_git_remote() {
  [ -d "$ROOT_DIR/.git" ] || return 0
  command -v git >/dev/null 2>&1 || return 0
  [ -n "$REPO_URL" ] && return 0
  REPO_URL="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
}

save_conf() {
  $SUDO mkdir -p "$CONFIG_DIR"
  # NOTE: --branch is deliberately NOT persisted. An update tracks whatever
  # branch the checkout is currently on, so a one-off --branch staging does
  # not silently pin every later update to staging.
  $SUDO tee "$CONFIG_FILE" > /dev/null <<CONF
# Written by deploy-ubuntu.sh - default source for '$APP_NAME --update'
SAVED_REPO_URL="$REPO_URL"
SAVED_DOMAIN="$DOMAIN"
SAVED_PORT="$APP_PORT"
SAVED_HTTPS="$WANT_HTTPS"
SAVED_ROOT="$ROOT_DIR"
CONF
  $SUDO chmod 644 "$CONFIG_FILE"
}

# Build the frontend into a staging directory and swap it into place only when
# the ENTIRE build succeeded. `vite build` empties dist/ before it writes, so
# a build that dies mid-way - a removed package export (the 918ecff incident:
# lucide-react 1.x dropped the brand icons and the build failed on `Github`),
# or an OOM on a loaded box - otherwise guts dist/ out from under the RUNNING
# site. Building beside the live tree keeps the last good build serving until
# its successor is proven complete.
build_frontend_safely() {
  local stage="frontend/.dist-stage"
  rm -rf "$stage"
  if ! (cd frontend && npm run build -- --outDir .dist-stage --emptyOutDir); then
    rm -rf "$stage"
    return 1
  fi
  if [ ! -f "$stage/index.html" ]; then
    rm -rf "$stage"
    return 1
  fi
  rm -rf frontend/dist
  mv "$stage" frontend/dist
  return 0
}

# The one proof that matters after an update: the process answering on the
# app's port reports the commit we just deployed. `systemctl restart` returning
# 0 does NOT imply that. Without this check the script printed "Update
# complete" while the previous release kept serving / a crashed-restart loop
# left nothing serving - exactly the state where every visitor only got the
# "Loading" boot screen. Same discipline auto-update.sh applies, lighter.
verify_running_commit() {
  local expected body attempt=1
  expected="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$expected" ]; then
    warn "No git HEAD to verify against - skipping the running-commit check."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl missing - cannot verify the running commit. Check /api/health yourself."
    return 0
  fi
  local url="http://127.0.0.1:${INTERNAL_PORT}/api/health"
  [ "$INTERNAL_PORT" = "80" ] && url="http://127.0.0.1/api/health"
  step "Verifying the running commit"
  while [ "$attempt" -le 15 ]; do
    body="$(curl -fsS -m 5 "$url" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q "\"commit\":\"$expected\""; then
      ok "Verified: the process answering on $url runs ${expected:0:7}"
      return 0
    fi
    # Health answers but reports a DIFFERENT commit: the restart did not take
    # and waiting longer cannot change that.
    if [ "$attempt" -ge 3 ] && printf '%s' "$body" | grep -q '"commit":"'; then
      break
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  die "The service did not come up on the deployed commit (${expected:0:7}) - NOT calling this update done.
    GET $url answered: $(printf '%s' "$body" | head -c 200)
    Files, dependencies and migrations are already in place; only the process hand-over failed.
    Recover with:
      sudo journalctl -u $APP_NAME -n 50 --no-pager
      sudo systemctl restart $APP_NAME
      sleep 2 && curl -s $url"
}

# Dependency refresh + migrate + rebuild + restart. Shared by the update path
# and the --resume re-exec.
run_post_update() {
  step "Refreshing dependencies"
  (cd backend  && npm install --no-audit --no-fund --loglevel=error)
  (cd frontend && npm install --no-audit --no-fund --loglevel=error)
  ok "backend + frontend"

  step "Applying migrations"
  (cd backend && node src/db/migrate.js)
  ok "Migrations applied"

  step "Rebuilding frontend"
  build_frontend_safely \
    || die "Frontend build failed - the previous build is STILL in place and serving."
  ok "Built frontend/dist"

  step "Restarting service"
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not available here - restart $APP_NAME yourself so the new build is served."
    return 0
  fi
  # A failed restart used to be a mere warning: files and dist had already
  # moved forward, the old process kept serving (or nothing did), and the
  # site silently degraded until someone noticed the boot screen. Loud now.
  if ! $SUDO systemctl restart "$APP_NAME" 2>/dev/null; then
    die "systemctl restart $APP_NAME failed - files are updated but the service was not.
    Recover with:
      sudo journalctl -u $APP_NAME -n 50 --no-pager
      sudo systemctl restart $APP_NAME"
  fi
  verify_running_commit
}

# Start the stack and prove it is answering. Returns non-zero if not.
start_and_verify() {
  step "Starting $APP_NAME"

  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO systemctl enable "$APP_NAME" > /dev/null 2>&1 || true
    if $SUDO systemctl restart "$APP_NAME" 2>/dev/null; then
      ok "systemctl restart issued"
    else
      warn "'systemctl restart' failed (is systemd running in this environment?)"
    fi
  else
    warn "systemctl not available - cannot manage the service here."
  fi

  if command -v nginx >/dev/null 2>&1; then
    if $SUDO nginx -t > /dev/null 2>&1; then
      $SUDO systemctl reload nginx 2>/dev/null || $SUDO systemctl restart nginx 2>/dev/null || true
      ok "nginx reloaded"
    else
      err "nginx config test failed:"
      $SUDO nginx -t || true
    fi
  fi

  # Give the app a moment, then check it really answers on its internal port.
  step "Verifying the site responds"
  local probe_host="127.0.0.1"
  local url="http://${probe_host}:${INTERNAL_PORT}/api/health"
  [ "$INTERNAL_PORT" = "80" ] && url="http://${probe_host}/api/health"

  local attempt=1
  while [ "$attempt" -le 15 ]; do
    sleep 1
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS -m 5 "$url" > /dev/null 2>&1; then
        ok "GET $url -> healthy (attempt $attempt)"
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -T 5 -O /dev/null "$url" 2>/dev/null; then
        ok "GET $url -> healthy (attempt $attempt)"
        return 0
      fi
    else
      warn "Neither curl nor wget available - cannot verify. Check the port manually."
      return 0
    fi
    attempt=$((attempt + 1))
  done

  err "The site did not answer on $url after 15 seconds."
  if command -v systemctl >/dev/null 2>&1; then
    printf '  service state: %s\n' "$($SUDO systemctl is-active "$APP_NAME" 2>/dev/null || echo unknown)"
    warn "Last log lines:"
    $SUDO journalctl -u "$APP_NAME" -n 20 --no-pager 2>/dev/null | sed 's/^/      /' || true
  fi
  if command -v ss >/dev/null 2>&1; then
    warn "Nothing listening on :$INTERNAL_PORT?"
    ss -ltnp 2>/dev/null | grep -E ":${INTERNAL_PORT}\b" | sed 's/^/      /' || echo "      (no listener on :$INTERNAL_PORT)"
  fi
  return 1
}

# --- start-only mode ---------------------------------------------------------
# --- automatic updates -------------------------------------------------------
#
# Installs the updater as its own systemd unit, generated from the REAL
# installation directory (the shipped file hardcodes /opt/espress0s-repo, which
# is wrong for e.g. /home/espress0/espress0s_repo), plus the narrow sudoers rule
# it needs to restart the app unit.
#
# The updater refuses to deploy unless it can stop and restart the application,
# so without these two pieces automatic updates simply decline to run - which is
# safe, but useless. Installing them here is what makes `./espress0 update`
# work unattended on a standard deployment.
UPDATER_NAME="${APP_NAME}-updater"
UPDATER_FILE="/etc/systemd/system/${UPDATER_NAME}.service"
SUDOERS_FILE="/etc/sudoers.d/espress0-updater"

install_auto_updater() {
  step "Installing automatic updates"

  local src="systemd/${APP_NAME}-updater.service"
  if [ ! -f "$src" ]; then
    warn "$src is missing - skipping automatic updates."
    return 0
  fi

  local systemctl_bin
  systemctl_bin="$(command -v systemctl || echo /usr/bin/systemctl)"

  # 1. The sudoers rule: exactly three verbs on exactly one unit, for exactly
  #    the service user. Anything broader would hand the app user general root.
  local tmp_sudo
  tmp_sudo="$(mktemp)"
  cat > "$tmp_sudo" <<SUDO
# Installed by deploy-ubuntu.sh for ${UPDATER_NAME}.
# The updater stops the app before swapping files and starts it afterwards.
# Restricted to three verbs on ${APP_NAME} only.
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_bin} stop ${APP_NAME}, ${systemctl_bin} stop ${APP_NAME}.service, ${systemctl_bin} restart ${APP_NAME}, ${systemctl_bin} restart ${APP_NAME}.service, ${systemctl_bin} start ${APP_NAME}, ${systemctl_bin} start ${APP_NAME}.service
SUDO
  chmod 440 "$tmp_sudo"

  # A malformed sudoers file can lock the box out of sudo entirely, so it is
  # validated before it is ever placed in /etc/sudoers.d.
  if command -v visudo >/dev/null 2>&1; then
    if ! $SUDO visudo -cf "$tmp_sudo" >/dev/null 2>&1; then
      err "the generated sudoers rule failed validation - not installing it:"
      $SUDO visudo -cf "$tmp_sudo" || true
      rm -f "$tmp_sudo"
      warn "Automatic updates will refuse to deploy until the updater can restart $APP_NAME."
      return 0
    fi
    ok "sudoers rule validated with visudo -cf"
  else
    warn "visudo not found - installing the sudoers rule unvalidated."
  fi
  $SUDO cp "$tmp_sudo" "$SUDOERS_FILE"
  $SUDO chown root:root "$SUDOERS_FILE"
  $SUDO chmod 440 "$SUDOERS_FILE"
  rm -f "$tmp_sudo"
  ok "Installed $SUDOERS_FILE (stop/restart/start on $APP_NAME only)"

  # 2. The unit, with every path taken from this installation.
  local tmp_unit
  tmp_unit="$(mktemp)"
  sed -e "s|/opt/espress0s-repo|$ROOT_DIR|g" \
      -e "s|^User=.*|User=$APP_USER|" \
      -e "s|^Group=.*|Group=$APP_USER|" \
      "$src" > "$tmp_unit"

  # Pin the unit it manages, so detection never has to guess on this box.
  if grep -q '^ExecStart=' "$tmp_unit" && ! grep -q -- '--service' "$tmp_unit"; then
    sed -i "s|^\(ExecStart=.*auto-update.sh.*\)$|\1 --service $APP_NAME|" "$tmp_unit"
  fi
  sed -i "s|--service espress0-repo\b|--service $APP_NAME|g" "$tmp_unit"

  if grep -q '/opt/espress0s-repo' "$tmp_unit"; then
    err "the generated updater unit still contains /opt/espress0s-repo"
    rm -f "$tmp_unit"
    return 0
  fi

  $SUDO cp "$tmp_unit" "$UPDATER_FILE"
  rm -f "$tmp_unit"
  $SUDO chmod 644 "$UPDATER_FILE"
  ok "Generated $UPDATER_FILE for $ROOT_DIR"

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$UPDATER_NAME" >/dev/null 2>&1 || warn "could not enable $UPDATER_NAME"
  if $SUDO systemctl restart "$UPDATER_NAME" 2>/dev/null; then
    ok "Automatic updates active ($UPDATER_NAME)"
  else
    warn "Could not start $UPDATER_NAME - journalctl -u $UPDATER_NAME -n 50"
  fi
  printf '  %sPause updates:%s touch %s/data/.auto-update-disabled\n' "$B" "$R" "$ROOT_DIR"
  printf '  %sDisable:%s      sudo systemctl disable --now %s\n' "$B" "$R" "$UPDATER_NAME"
}

remove_auto_updater_if_disabled() {
  [ "$AUTO_UPDATE" -eq 0 ] || return 0
  if [ -f "$UPDATER_FILE" ]; then
    step "Disabling automatic updates (--no-auto-update)"
    $SUDO systemctl disable --now "$UPDATER_NAME" >/dev/null 2>&1 || true
    ok "Stopped and disabled $UPDATER_NAME (unit left in place)"
  else
    step "Skipping automatic updates (--no-auto-update)"
    ok "The updater was not installed"
  fi
}

if [ "$START_ONLY" -eq 1 ]; then
  [ -f .env ] || die ".env not found in $ROOT_DIR - run a full deploy first."
  if start_and_verify; then
    printf '\n%s%s Started - http://%s%s %s\n\n' "$B" "$GRN" \
      "$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)" \
      "$( [ "$APP_PORT" = "80" ] && echo "" || echo ":$APP_PORT" )" "$R"
    exit 0
  fi
  exit 1
fi

# --- AI backend configuration -----------------------------------------------
# Used by BOTH paths: a fresh deploy writes it next to the other secrets, and
# `--update --gemini-key ...` can add the key to a server that predates the AI
# settings without a re-deploy. Upsert rather than append, because .env survives
# every update: an older file has no AI_* lines at all, and a duplicated key
# would leave the first (empty) one winning for anyone reading it by eye.
env_upsert() { # <file> <key> <value>
  # Replaces (or appends) KEY=VALUE without the shell or sed interpreting
  # '/', '&' and '\' in the value - an API key is full of them.
  local file="$1" key="$2" value="$3"
  if KEY="$key" awk 'BEGIN{k=ENVIRON["KEY"]} index($0,k"=")==1{found=1} END{exit !found}' "$file"; then
    KEY="$key" VALUE="$value" awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
      index($0, k "=") == 1 && !done { print k "=" v; done = 1; next }
      { print }
    ' "$file" > "$file.tmp" || { rm -f "$file.tmp"; return 1; }
    $SUDO tee "$file" >/dev/null < "$file.tmp"
    rm -f "$file.tmp"
  else
    printf '%s=%s\n' "$key" "$value" | $SUDO tee -a "$file" >/dev/null
  fi
  $SUDO chmod 600 "$file"
}

configure_ai_env() {
  local envfile="$ROOT_DIR/.env"
  [ -f "$envfile" ] || return 0

  # Same preference order the backend uses: flag, then Google's documented
  # export names, then whatever .env already carries.
  local key="$GEMINI_KEY"
  [ -n "$key" ] || key="${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}"

  if [ -n "$key" ]; then
    step "Configuring the AI backend (Gemini)"
    if [ "$GEMINI_KEY" = "$key" ]; then
      warn "A --gemini-key value is visible in ps(1) and shell history on a shared"
      warn "box. GEMINI_API_KEY=<key> sudo -E $0 --update ... avoids both."
    fi
    env_upsert "$envfile" AI_API_KEY "$key"
    env_upsert "$envfile" AI_PROVIDER gemini
    [ -n "$GEMINI_MODEL" ] && env_upsert "$envfile" AI_MODEL "$GEMINI_MODEL"
    ok "AI_PROVIDER=gemini - Barista calls the Gemini API; no CLI to install."
    ok "Prove it after the restart: Admin -> Settings -> AI -> Send a test prompt."
  elif [ "$WITH_TGPT" -eq 1 ]; then
    step "Configuring the AI backend (tgpt)"
    env_upsert "$envfile" AI_PROVIDER auto
    ok "No key given: with AI_PROVIDER=auto the free tgpt CLI answers when installed."
    bash "$SCRIPT_DIR/install-tgpt.sh" || warn "tgpt install failed - AI falls back to metadata search."
  elif [ -n "$GEMINI_MODEL" ]; then
    step "AI backend"
    env_upsert "$envfile" AI_MODEL "$GEMINI_MODEL"
    warn "AI_MODEL set but no key - add AI_API_KEY to $envfile to use it."
  fi
  return 0
}

# --- update path -------------------------------------------------------------
if [ "$UPDATE_ONLY" -eq 1 ] && [ "$RESUME" -eq 0 ]; then
  step "Updating $APP_NAME"

  [ -f .env ] || die ".env not found in $ROOT_DIR - this does not look like an installed deployment."
  command -v git >/dev/null 2>&1 || die "git is required to update. Install it or copy files in manually."

  read_saved_conf
  detect_git_remote

  if [ -z "$REPO_URL" ]; then
    die "No repository URL known. Pass one with:
    sudo $0 --update --repo https://github.com/<you>/<repo>.git"
  fi
  ok "Source: $REPO_URL"

  if [ ! -d "$ROOT_DIR/.git" ]; then
    die "$ROOT_DIR is not a git checkout, so it cannot be updated in place.
    Clone it first:
      sudo git clone $REPO_URL $ROOT_DIR
    then re-run: sudo $0 --update"
  fi

  # Record where we are so we can tell the user what changed.
  BEFORE="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  # Snapshot anything git does not track but the app needs, so a reset can
  # never lose it. .env is restored only if it vanished.
  STASH="$(mktemp -d)"
  trap 'rm -rf "$STASH"' EXIT
  for keep in $KEEP_FILES; do
    [ -f "$ROOT_DIR/$keep" ] && cp -a "$ROOT_DIR/$keep" "$STASH/" || true
  done

  # Fetch from the resolved URL rather than assuming a remote called "origin":
  # the saved config may point somewhere else, or the checkout may have no
  # remote at all after being restored from an archive.
  if [ -n "$BRANCH" ]; then
    warn "Fetching branch '$BRANCH' from $REPO_URL"
    git -C "$ROOT_DIR" fetch --prune "$REPO_URL" "$BRANCH" \
      || die "Could not fetch branch '$BRANCH' from $REPO_URL"
  else
    BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    warn "Fetching '$BRANCH' from $REPO_URL"
    git -C "$ROOT_DIR" fetch --prune "$REPO_URL" "$BRANCH" \
      || die "Could not fetch '$BRANCH' from $REPO_URL.
    Check the URL and your credentials: sudo $0 --update --repo <url>"
  fi

  # FETCH_HEAD is what we just pulled, independent of remote naming.
  UPSTREAM="FETCH_HEAD"
  git -C "$ROOT_DIR" rev-parse --verify "$UPSTREAM" >/dev/null 2>&1 \
    || die "Fetch produced no commit - is '$BRANCH' present in $REPO_URL?"

  # Make the local branch point at what we pulled.
  git -C "$ROOT_DIR" checkout --quiet "$BRANCH" 2>/dev/null \
    || git -C "$ROOT_DIR" checkout --quiet -b "$BRANCH" "$UPSTREAM" \
    || die "Could not check out branch '$BRANCH'"

  # A server should not carry local edits: they cause silent drift between
  # machines. Reset hard so the deployment always matches the repository.
  if ! git -C "$ROOT_DIR" diff --quiet HEAD "$UPSTREAM" 2>/dev/null; then
    # Only report files git actually tracks; untracked-but-ignored files such
    # as .env, data/ and backups/ are never touched by a reset.
    DIRTY="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no 2>/dev/null | head -5)"
    if [ -n "$DIRTY" ]; then
      warn "Discarding local modifications to tracked files:"
      printf '      %s\n' "$DIRTY"
    fi
    git -C "$ROOT_DIR" reset --hard "$UPSTREAM"
    git -C "$ROOT_DIR" clean -fd -e .env -e data -e backups
    ok "Synced $BEFORE -> $(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  else
    ok "Already at $(git -C "$ROOT_DIR" rev-parse --short HEAD) - nothing to pull"
  fi

  # Restore untracked essentials if the sync removed them.
  for keep in $KEEP_FILES; do
    if [ ! -f "$ROOT_DIR/$keep" ] && [ -f "$STASH/$keep" ]; then
      cp -a "$STASH/$keep" "$ROOT_DIR/$keep"
      warn "Restored $keep after the sync"
    fi
  done

  # New AI settings can arrive with this same update, so give the operator a way
  # to store the key in the same command that pulls the code.
  configure_ai_env

  AFTER="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  save_conf

  # If the pulled commit changed this script, re-exec the new copy so the rest
  # of the update runs the code we just pulled rather than the version already
  # loaded into this shell. --resume stops the second run pulling again.
  if [ "$BEFORE" != "$AFTER" ]; then
    warn "Repository moved $BEFORE -> $AFTER; re-running the updated script"
    # --port carries the EFFECTIVE internal listener, not the public one: in
    # domain mode APP_PORT is the public 80 while the app itself answers on
    # INTERNAL_PORT, and the resumed run probes with exactly this value.
    REEXEC_ARGS=(--update --resume --repo "$REPO_URL" --branch "$BRANCH" --port "$INTERNAL_PORT")
    [ -n "$DOMAIN" ] && REEXEC_ARGS+=(--domain "$DOMAIN")
    [ "$WANT_HTTPS" -eq 1 ] && REEXEC_ARGS+=(--https)
    # Without this the opt-out is silently forgotten by the second run.
    [ "$AUTO_UPDATE" -eq 0 ] && REEXEC_ARGS+=(--no-auto-update)
    # ${BASH_SOURCE[0]} is whatever path invoked THIS copy: relative when the
    # ./espress0 wrapper execs scripts/deploy-ubuntu.sh, absolute when run as
    # 'sudo "$PWD/scripts/deploy-ubuntu.sh"'. "$ROOT_DIR/${BASH_SOURCE[0]}"
    # concatenated both in the absolute case and bash died on the doubled
    # path - which meant every update that actually pulled a commit aborted
    # right here, AFTER the sync but BEFORE the rebuild/restart below, so the
    # site was left half-updated on the old build. Resolve via SCRIPT_DIR,
    # which is absolute by construction, whichever way we were invoked.
    exec bash "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" "${REEXEC_ARGS[@]}"
  fi

  run_post_update
  if [ "$AUTO_UPDATE" -eq 1 ]; then install_auto_updater; else remove_auto_updater_if_disabled; fi

  printf '\n%s%s Update complete (%s) %s\n\n' "$B" "$GRN" "$AFTER" "$R"
  exit 0
fi

# Re-exec target: the pull already happened, just finish the update.
if [ "$UPDATE_ONLY" -eq 1 ] && [ "$RESUME" -eq 1 ]; then
  step "Finishing update (post-sync)"
  run_post_update
  if [ "$AUTO_UPDATE" -eq 1 ]; then install_auto_updater; else remove_auto_updater_if_disabled; fi
  # "Update complete" over an unanswering site is how bricked deploys went
  # unnoticed; a failed verification now fails the run (non-zero exit).
  if ! start_and_verify; then
    die "Update applied, but the site is not answering - see the log lines above."
  fi
  printf '\n%s%s Update complete (%s) %s\n\n' "$B" "$GRN" \
    "$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'current build')" "$R"
  exit 0
fi

# --- 1. system packages ------------------------------------------------------
step "Installing system packages"
$SUDO apt-get update -qq
PKGS="ca-certificates curl gnupg git nginx"
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PKGS > /dev/null
ok "nginx and build prerequisites"

# --- 2. Node 20 --------------------------------------------------------------
step "Checking Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$MAJOR" -ge 20 ]; then NEED_NODE=0; ok "Node $(node -v) present"; else warn "Node $(node -v) too old"; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | root_bash > /dev/null
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs > /dev/null
  ok "Installed Node $(node -v)"
fi
MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "$MAJOR" -ge 20 ] || die "Node $MAJOR is below the required 20."

# --- 3. .env -----------------------------------------------------------------
step "Configuring .env"

gen_b64()  { openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64; }
gen_hex()  { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
gen_pass() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 18; printf 'aA7.'; }
esc()      { printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'; }

NEW_ADMIN_PW=""
if [ -f .env ]; then
  warn ".env exists - keeping it (secrets and data stay intact)."
else
  cp .env.example .env
  chmod 600 .env
  ADMIN_PW="$(gen_pass)"
  sed -i \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(esc "$(gen_b64)")|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(esc "$(gen_b64)")|" \
    -e "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(esc "$(gen_hex)")|" \
    -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(esc "$ADMIN_PW")|" \
    -e "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=admin|" \
    -e "s|^NODE_ENV=.*|NODE_ENV=production|" \
    -e "s|^PORT=.*|PORT=$INTERNAL_PORT|" \
    -e "s|^HOST=.*|HOST=$APP_HOST|" \
    .env
  NEW_ADMIN_PW="$ADMIN_PW"
  ok "Generated .env with fresh secrets (chmod 600)"
fi

# Point CORS / frontend URL at the real domain when one was supplied.
if [ -n "$DOMAIN" ]; then
  # Domain mode made the app loopback-only; older installs had the app racing
  # nginx for 0.0.0.0:80. Correct .env in place (secrets untouched).
  if [ -f .env ]; then
    sed -i "s|^PORT=.*|PORT=$INTERNAL_PORT|" .env
    grep -q "^HOST=" .env \
      && sed -i "s|^HOST=.*|HOST=127.0.0.1|" .env \
      || printf '\nHOST=127.0.0.1\n' >> .env
  fi
  SCHEME="http"; [ "$WANT_HTTPS" -eq 1 ] && SCHEME="https"
  sed -i \
    -e "s|^FRONTEND_URL=.*|FRONTEND_URL=${SCHEME}://${DOMAIN}|" \
    -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=${SCHEME}://${DOMAIN},http://localhost,http://127.0.0.1|" \
    .env
  ok "FRONTEND_URL / CORS_ORIGIN set to ${SCHEME}://${DOMAIN}"
fi

grep -qE '^(JWT_SECRET|ENCRYPTION_KEY|PASSWORD_PEPPER)=change-this-to' .env \
  && die ".env still has 'change-this-to-*' placeholders - fix it and re-run."
[ "$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -1)" = "ChangeMe123!" ] \
  && warn "ADMIN_PASSWORD is the shipped default. Change it before going live."
ok "Secrets validated"

# --- 4. service user ---------------------------------------------------------
step "Creating service user"
if id "$APP_USER" >/dev/null 2>&1; then
  ok "User '$APP_USER' exists"
else
  $SUDO useradd --system --home "$ROOT_DIR" --shell /usr/sbin/nologin "$APP_USER"
  ok "Created system user '$APP_USER'"
fi

# --- 5. install + build ------------------------------------------------------
step "Installing dependencies"
(cd backend  && npm install --no-audit --no-fund --loglevel=error)
(cd frontend && npm install --no-audit --no-fund --loglevel=error)
ok "backend + frontend"

step "Initialising data"
mkdir -p data backups backend/data/uploads
(cd backend && node src/db/migrate.js)
ok "Migrations applied"

if [ -f data/repo.db ]; then
  ok "Database present - not seeding"
else
  (cd backend && node src/db/seed.js)
  [ -f backend/src/db/seed-direct.js ] && (cd backend && node src/db/seed-direct.js)
  ok "Database seeded"
fi

step "Building frontend"
build_frontend_safely || die "Frontend build failed (see the output above)."
ok "Built frontend/dist"

# configure_ai_env already ran on the --update path; on a fresh deploy this is
# where .env first exists, so this is the one that actually writes anything.
configure_ai_env

# --- 6. ownership ------------------------------------------------------------
step "Setting ownership"
$SUDO chown -R "$APP_USER:$APP_USER" "$ROOT_DIR"
# Keep secrets readable only by the service user.
$SUDO chmod 600 "$ROOT_DIR/.env"
ok "$APP_USER owns $ROOT_DIR"

# --- 7. systemd --------------------------------------------------------------
step "Installing systemd service"
NODE_BIN="$(command -v node)"
TMP="$(mktemp)"
sed -e "s|/opt/espress0s-repo|$ROOT_DIR|g" \
    -e "s|^User=.*|User=$APP_USER|" \
    -e "s|^Group=.*|Group=$APP_USER|" \
    -e "s|/usr/bin/node|$NODE_BIN|g" \
    "systemd/${APP_NAME}.service" > "$TMP"

# ProtectHome=true is right for an /opt install, but it mounts an empty,
# inaccessible view over /home, /root and /run/user inside the unit's mount
# namespace. With the checkout in a home directory — or a Node binary from
# nvm/fnm under one — the service cannot chdir into its WorkingDirectory at
# boot (status=200/CHDIR) and Restart=always then loops forever. The site
# never comes up and visitors only ever see the "Loading espress0's repo"
# screen. Relax it for that layout only; /opt installs keep the hardening.
lives_under_home() {
  local p
  p="$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")"
  case "$p" in /home/*|/root|/root/*|/run/user/*) return 0 ;; esac
  return 1
}
if lives_under_home "$ROOT_DIR" || lives_under_home "$NODE_BIN"; then
  sed -i 's|^ProtectHome=true|# Relaxed by deploy-ubuntu.sh: this installation (or the Node\n# binary) lives in a home directory. ProtectHome=true would hide it from\n# the unit and the app could never start at boot.\nProtectHome=false|' "$TMP"
  warn "Installation is under a home directory - set ProtectHome=false in the"
  warn "generated unit (with ProtectHome=true the app cannot start at boot)."
fi

# The unit must be told which interface/port to bind. In domain mode the app
# is loopback-only; nginx is the only public listener.
grep -q "^Environment=PORT=" "$TMP" || sed -i "/^Environment=NODE_ENV=/a Environment=PORT=$INTERNAL_PORT" "$TMP"
grep -q "^Environment=HOST=" "$TMP" || sed -i "/^Environment=PORT=/a Environment=HOST=$APP_HOST" "$TMP"

# Ports below 1024 are privileged. The service runs as an unprivileged user,
# so grant just the bind capability rather than running it as root.
if [ "$INTERNAL_PORT" -lt 1024 ]; then
  if ! grep -q "^AmbientCapabilities=" "$TMP"; then
    sed -i "/^\[Service\]/a AmbientCapabilities=CAP_NET_BIND_SERVICE" "$TMP"
  fi
  ok "Unit grants CAP_NET_BIND_SERVICE (port $INTERNAL_PORT is privileged)"
fi

$SUDO cp "$TMP" "$SERVICE_FILE"
rm -f "$TMP"
$SUDO chmod 644 "$SERVICE_FILE"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$APP_NAME" > /dev/null 2>&1 || true

if $SUDO systemctl restart "$APP_NAME" 2>/dev/null; then
  sleep 2
  if $SUDO systemctl is-active --quiet "$APP_NAME"; then
    ok "Service running"
  else
    warn "Service installed but not active - journalctl -u $APP_NAME -n 50"
  fi
else
  warn "'systemctl restart' failed (is systemd running?). Start it with: sudo systemctl start $APP_NAME"
fi


# --- 8. remember the update source -------------------------------------------
step "Recording deployment source"
if [ -z "$REPO_URL" ]; then detect_git_remote; fi
if [ -n "$REPO_URL" ]; then
  save_conf
  ok "Saved to $CONFIG_FILE - 'sudo $0 --update' will pull from it"
else
  warn "No git remote and no --repo given; --update will need --repo <url>."
fi

# --- 8b. automatic updates ---------------------------------------------------
if [ "$AUTO_UPDATE" -eq 1 ]; then
  install_auto_updater
else
  remove_auto_updater_if_disabled
fi

# --- 9. nginx ----------------------------------------------------------------
if [ -n "$DOMAIN" ]; then
  step "Configuring nginx for $DOMAIN"

  VHOST="/etc/nginx/sites-available/${APP_NAME}"
  $SUDO tee "$VHOST" > /dev/null <<NGINX
upstream ${APP_NAME}_backend {
    server 127.0.0.1:${INTERNAL_PORT};
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

    location / {
        proxy_pass http://${APP_NAME}_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # Downloads are redirected to external providers; do not buffer them.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Never expose dotfiles or the data/backup directories.
    location ~ /\. { deny all; access_log off; log_not_found off; }
    location ~ ^/(data|backups|node_modules)/ { deny all; return 404; }

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types text/plain text/css text/xml text/javascript application/json
               application/javascript application/xml image/svg+xml;

    access_log /var/log/nginx/${APP_NAME}_access.log;
    error_log  /var/log/nginx/${APP_NAME}_error.log;
}
NGINX

  $SUDO ln -sf "$VHOST" "/etc/nginx/sites-enabled/${APP_NAME}"
  # The stock vhost also answers on :80 and would shadow this one.
  if [ -L /etc/nginx/sites-enabled/default ]; then
    $SUDO rm -f /etc/nginx/sites-enabled/default
    ok "Disabled the default nginx site"
  fi

  if $SUDO nginx -t > /dev/null 2>&1; then
    $SUDO systemctl reload nginx || $SUDO systemctl restart nginx
    ok "nginx serving http://${DOMAIN}"
  else
    err "nginx config test failed:"
    $SUDO nginx -t || true
    die "Fix $VHOST and reload nginx."
  fi

  if [ "$WANT_HTTPS" -eq 1 ]; then
    step "Requesting a TLS certificate"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx > /dev/null
    if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
         --redirect --keep-until-expiring -m "admin@${DOMAIN}" 2>/dev/null; then
      ok "HTTPS enabled for https://${DOMAIN}"
    else
      warn "certbot did not complete. Is DNS for $DOMAIN pointing at this server, and port 80 reachable?"
      warn "  Re-run: sudo certbot --nginx -d $DOMAIN"
    fi
  fi
else
  step "Skipping nginx (no --domain given)"
  warn "The app listens directly on port $APP_PORT."
fi

# --- 10. firewall ------------------------------------------------------------
if [ "$SKIP_FIREWALL" -eq 0 ] && command -v ufw >/dev/null 2>&1; then
  step "Configuring firewall"
  if $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow OpenSSH > /dev/null 2>&1 || true
    $SUDO ufw allow 80/tcp  > /dev/null 2>&1 || true
    [ "$WANT_HTTPS" -eq 1 ] && $SUDO ufw allow 443/tcp > /dev/null 2>&1 || true
    ok "ufw: OpenSSH, 80$( [ "$WANT_HTTPS" -eq 1 ] && echo ', 443') allowed"
    if [ -z "$DOMAIN" ] && [ "$APP_PORT" != "80" ] && [ "$APP_PORT" != "443" ]; then
      $SUDO ufw allow "${APP_PORT}/tcp" > /dev/null 2>&1 || true
      warn "Opened ${APP_PORT}/tcp directly. Close it once nginx fronts the app."
    fi
  else
    warn "ufw is not active - leaving firewall rules alone."
  fi
fi

# --- 11. start and verify ----------------------------------------------------
if ! start_and_verify; then
  warn "Deployment finished but the site is not answering yet - fix the errors above,"
  warn "then run: sudo $0 --start"
fi

# --- summary -----------------------------------------------------------------
if [ "$APP_PORT" = "80" ]; then
  URL="http://127.0.0.1"
else
  URL="http://127.0.0.1:${APP_PORT}"
fi
if [ -n "$DOMAIN" ]; then
  if [ "$WANT_HTTPS" -eq 1 ]; then URL="https://${DOMAIN}"; else URL="http://${DOMAIN}"; fi
fi

printf '\n%s%s Deployment complete %s\n' "$B" "$GRN" "$R"
printf '  URL:        %s\n' "$URL"
printf '  Service:    sudo systemctl status %s\n' "$APP_NAME"
printf '  Restart:    sudo %s --start\n' "$0"
printf '  Logs:       sudo journalctl -u %s -f\n' "$APP_NAME"
printf '  Database:   %s/data/repo.db\n' "$ROOT_DIR"
printf '  Back up:    ./scripts/backup.sh\n'

if [ -n "$NEW_ADMIN_PW" ]; then
  printf '\n  %sAdmin credentials - shown once, store them now:%s\n' "$B" "$R"
  printf '    username: admin\n'
  printf '    password: %s%s%s\n' "$B" "$NEW_ADMIN_PW" "$R"
fi

printf '\n  %sBefore going live:%s change the admin password, confirm .env is chmod 600,\n' "$YEL" "$R"
printf '  and make sure data/ and backups/ are excluded from any repository you push.\n\n'
