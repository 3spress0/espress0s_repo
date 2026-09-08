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
#   ./scripts/auto-update.sh --no-restart       deploy WITHOUT restarting (offline)
#
# Resource safety (a small VM has to survive its own updates):
#   --min-free-mem MB     do not start the build phase with less than this
#                         available (default 512; 0 disables the gate)
#   --min-free-disk MB    do not stage a release with less than this free on
#                         the checkout's filesystem (default 2048; 0 disables)
#   --step-timeout SEC    hard cap per expensive step - dependency install,
#                         frontend build, migration rehearsal (default 900)
#   --build-heap MB       heap ceiling for the frontend build, passed as
#                         NODE_OPTIONS=--max-old-space-size (default 512; 0 = leave alone)
#   --max-sockets N       npm's parallel connections per origin (default 4;
#                         npm's own default of 15 is a lot for a 1-vCPU box)
#   --build-online        the historic order: build the staged tree while the
#                         app keeps serving. Faster, no build-window outage,
#                         and the reason a small VM could OOM mid-update.
#
# Restart target: detected automatically, override to be explicit.
#   --service NAME        systemd unit, via systemctl (sudo -n when needed)
#   --tmux-session NAME   the 'app'/'backend' window of a start-tmux session
#   --stop-cmd / --start-cmd   any supervisor: 'docker compose restart app', etc.
#
# NO VERIFIED RESTART TARGET, NO LIVE DEPLOYMENT.
#   Detection order: explicit flags, then an active systemd unit whose
#   WorkingDirectory is this checkout, then an 'espress0' tmux session with an
#   app/backend window. If none is found the update STOPS before touching the
#   live tree or the database - swapping files under a process that keeps
#   running leaves code and process on different commits, and the health check
#   then passes against the old release. Use --no-restart to say "I really do
#   want an offline file-only deploy"; it is never the default.
#
# How it updates:
#   --mode clone (default)  the new code is cloned into .auto-update/next while
#       the site keeps running. The release is then proven - dependency graph
#       resolved, dependencies installed, frontend built, migrations rehearsed
#       against a copy of the database - before anything in the live tree moves.
#       Only then: swap -> migrate -> start -> health check. If the site does
#       not come back, the previous commit is put back and started again, so a
#       bad release costs seconds instead of uptime.
#   --mode pull             fast-forward in place, but with the same
#       stop -> deps -> migrate -> build -> start -> verify -> rollback order.
#
# Where the expensive work happens (and why it changed):
#   `npm ci` and `vite build` are the two heaviest things this box ever runs.
#   Doing them while the app, its page cache and the updater all compete for
#   RAM is what can push a small VM into swap and then into the OOM killer -
#   which takes down SSH and the site, not just the update. So by DEFAULT the
#   application is stopped BEFORE the install/build phase and started again
#   whatever the outcome. That trades a short, predictable build window for not
#   losing the machine. --build-online restores the old overlap for hosts with
#   RAM to spare.
#
# Safety:
#   * A resource preflight runs before anything is staged (disk) and again
#     before the heavy phase (memory). Below the thresholds the cycle is
#     refused with the live tree untouched and the app running.
#   * Every expensive step runs under `timeout`, at nice 10 / best-effort I/O
#     priority 7, with npm's socket count reduced. A wedged build fails the
#     cycle instead of pinning the box.
#   * Dependencies are installed with `npm ci` from the lockfile, never
#     `npm install`: a release whose lockfile does not resolve (a peer
#     dependency conflict, say) is caught by a --dry-run check while the site
#     is still up, instead of after the app has been stopped.
#   * --mode pull only ever fast-forwards. Local commits/divergence are never
#     reset away - the cycle is skipped and logged instead.
#   * A dirty working tree skips the cycle in BOTH modes: a clone deploy
#     would silently rsync over the uncommitted edits, and a pull can never
#     fast-forward carrying them. (The setup.sh -> config.sh self-rename is
#     exempt - it is an intended post-install state.)
#   * With neither curl nor wget installed a deploy is refused before anything
#     is touched - an unverifiable restart always rolls back anyway, so it is
#     better refused while everything is still safely on disk.
#   * .env, data/, backups/, uploads/ and node_modules/ are gitignored and are
#     never replaced by a deploy; --mode clone copies .env forward and leaves
#     the rest where it is.
#   * The database is snapshotted before live migrations run, so a failed
#     release rolls back the schema as well as the code.
#   * A deploy is only accepted when /api/health reports the commit that was
#     just deployed. The commit is captured when Node starts, so an old process
#     answering on the port cannot pass the check.
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

# ------------------------------------------------------------ resource policy
# Defaults are deliberately modest: this runs on 1-2 GB Azure VMs where the app
# unit itself is capped at MemoryMax=800M. Every one of them is overridable by
# flag or environment, because "how much RAM is enough" is a property of the
# box, not of this script.
MIN_FREE_MEM_MB="${MIN_FREE_MEM_MB:-512}"    # gate for the install/build phase
MIN_FREE_DISK_MB="${MIN_FREE_DISK_MB:-2048}" # gate for staging a clone at all
STEP_TIMEOUT="${STEP_TIMEOUT:-900}"          # per expensive step
BUILD_HEAP_MB="${BUILD_HEAP_MB:-512}"        # NODE_OPTIONS for the frontend build
NPM_MAX_SOCKETS="${NPM_MAX_SOCKETS:-4}"      # npm defaults to 15 per origin
NICE_LEVEL="${NICE_LEVEL:-10}"
BUILD_ONLINE=0                               # 1 = build while the app serves


# Set by resolve_restart_target(); everything downstream reads these instead of
# re-deriving "how is this app supervised" at each call site.
SUPERVISOR=""          # systemd | tmux | command | none
SUPERVISOR_NAME=""     # unit name, session name, or 'custom'
NO_RESTART=0           # --no-restart: deliberate offline deploy
TMUX_SESSION_GIVEN=0
# Filled in as a deploy progresses so write_state can report exactly how far
# it got, rather than a single opaque "failed".
ST_STOPPED=unknown
ST_MIGRATED=unknown
ST_STARTED=unknown
ST_VERIFIED=unknown
ST_EXPECTED=""
ST_RUNNING=""
ST_REASON=""

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
    --tmux-session)   TMUX_SESSION="${2:-}"; TMUX_SESSION_GIVEN=1; shift ;;
    --tmux-session=*) TMUX_SESSION="${1#*=}"; TMUX_SESSION_GIVEN=1 ;;
    --mode)           MODE="${2:-}"; shift ;;
    --mode=*)         MODE="${1#*=}" ;;
    --stop-cmd)       STOP_CMD="${2:-}"; shift ;;
    --stop-cmd=*)     STOP_CMD="${1#*=}" ;;
    --start-cmd)      START_CMD="${2:-}"; shift ;;
    --start-cmd=*)    START_CMD="${1#*=}" ;;
    --health-url)     HEALTH_URL="${2:-}"; shift ;;
    --health-url=*)   HEALTH_URL="${1#*=}" ;;
    --no-migrate)     MIGRATE=0 ;;
    --no-restart)     NO_RESTART=1 ;;
    --build-online)   BUILD_ONLINE=1 ;;
    --min-free-mem)   MIN_FREE_MEM_MB="${2:-}"; shift ;;
    --min-free-mem=*) MIN_FREE_MEM_MB="${1#*=}" ;;
    --min-free-disk)   MIN_FREE_DISK_MB="${2:-}"; shift ;;
    --min-free-disk=*) MIN_FREE_DISK_MB="${1#*=}" ;;
    --step-timeout)   STEP_TIMEOUT="${2:-}"; shift ;;
    --step-timeout=*) STEP_TIMEOUT="${1#*=}" ;;
    --build-heap)     BUILD_HEAP_MB="${2:-}"; shift ;;
    --build-heap=*)   BUILD_HEAP_MB="${1#*=}" ;;
    --max-sockets)    NPM_MAX_SOCKETS="${2:-}"; shift ;;
    --max-sockets=*)  NPM_MAX_SOCKETS="${1#*=}" ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

case "$INTERVAL" in (*[!0-9]*|'') echo "!! --interval must be a number of seconds." >&2; exit 1 ;; esac
[ "$INTERVAL" -lt 30 ] && INTERVAL=30   # be nice to the remote (and the disk)
# The resource knobs are all plain integers; a typo here would otherwise only
# surface much later, in the middle of a deploy.
for _opt in MIN_FREE_MEM_MB MIN_FREE_DISK_MB STEP_TIMEOUT BUILD_HEAP_MB NPM_MAX_SOCKETS NICE_LEVEL; do
  case "${!_opt}" in
    (*[!0-9]*|'') echo "!! $_opt must be a whole number (got '${!_opt}')." >&2; exit 1 ;;
  esac
done
[ "$STEP_TIMEOUT" -lt 5 ] && STEP_TIMEOUT=5
[ "$NPM_MAX_SOCKETS" -lt 1 ] && NPM_MAX_SOCKETS=1
case "$MODE" in
  clone|pull) ;;
  *) echo "!! --mode must be 'clone' or 'pull' (got '$MODE')." >&2; exit 1 ;;
esac

mkdir -p data "$STAGE_ROOT"
# Serialize against cron/systemd/manual second copies of this script.
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another auto-update instance holds $LOCK_FILE — exiting."; exit 0; }

log()  { printf '[auto-update %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

json_str() { printf '%s' "${1:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || printf '""'; }

# The status file is the only thing an operator (or the admin card) sees when
# an update refuses to proceed, so it carries the whole decision: which
# supervisor was selected, which commit was expected, which one is actually
# answering, and which step failed. "failed" with no detail sent people
# reading journal logs to work out whether the app had even been stopped.
write_state() { # state message
  printf '{"state":"%s","message":%s,"at":"%s","branch":"%s","commit":"%s","expectedCommit":"%s","runningCommit":"%s","supervisor":"%s","target":%s,"stopped":"%s","migrated":"%s","started":"%s","verified":"%s","reason":%s}\n' \
    "$1" "$(json_str "$2")" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$BRANCH" "$(git rev-parse --short HEAD 2>/dev/null)" \
    "${ST_EXPECTED:0:40}" "${ST_RUNNING:0:40}" \
    "${SUPERVISOR:-none}" "$(json_str "$SUPERVISOR_NAME")" \
    "$ST_STOPPED" "$ST_MIGRATED" "$ST_STARTED" "$ST_VERIFIED" "$(json_str "$ST_REASON")" \
    > "$STATE_FILE" 2>/dev/null || true
}

# Refuse to deploy, loudly and without having touched anything.
refuse() { # <reason>
  ST_REASON="$1"
  log "REFUSING TO DEPLOY: $1"
  log "  nothing was changed: the live tree and database are untouched."
  write_state refused "$1"
  return 1
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || { log "FATAL: '$1' not installed"; exit 1; }; }
need_cmd git
need_cmd npm

# ------------------------------------------------------------------- resources
#
# The updater is the heaviest thing this machine runs: a clone, two dependency
# installs and a bundler, historically all while the app was still serving. On
# a 1-2 GB VM that combination is enough to exhaust memory, start swapping and
# end at the OOM killer - which does not politely pick the build, it takes SSH
# and the site with it. None of the careful rollback machinery below helps if
# the box itself stops answering.
#
# So: measure first, refuse early, and never let a single step run unbounded.

# MemAvailable is the kernel's own estimate of what can be allocated without
# swapping - a much better signal than 'free' minus 'used', which counts the
# page cache as gone.
mem_available_mb() {
  local kb
  kb="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  [ -n "$kb" ] || return 1
  printf '%d' $((kb / 1024))
}

mem_total_mb() {
  local kb
  kb="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  [ -n "$kb" ] || return 1
  printf '%d' $((kb / 1024))
}

swap_summary() {
  local total used
  total="$(awk '/^SwapTotal:/ {print int($2/1024); exit}' /proc/meminfo 2>/dev/null)"
  used="$(awk '/^SwapFree:/ {print int($2/1024); exit}' /proc/meminfo 2>/dev/null)"
  [ -n "$total" ] || { printf 'unknown'; return 0; }
  if [ "$total" = "0" ]; then printf 'none'; else printf '%dM free of %dM' "${used:-0}" "$total"; fi
}

disk_free_mb() { # <path>
  df -Pm "$1" 2>/dev/null | awk 'NR == 2 { print $4; exit }'
}

# One line an operator can read in journalctl and immediately understand, plus
# the raw tools' output when they exist - this is the evidence that says whether
# an update was refused for a good reason.
log_resources() { # <label>
  local avail total
  avail="$(mem_available_mb || echo '?')"
  total="$(mem_total_mb || echo '?')"
  log "$1: RAM ${avail}M available of ${total}M, swap $(swap_summary), disk $(disk_free_mb "$ROOT" || echo '?')M free on $ROOT"
}

# Gate a phase on free memory. Returns non-zero (without touching anything) when
# the box does not have the headroom the caller says it needs.
require_memory() { # <needed_mb> <phase>
  local need="$1" phase="$2" avail
  [ "$need" -gt 0 ] || return 0
  avail="$(mem_available_mb)" || { log "cannot read /proc/meminfo - skipping the memory gate"; return 0; }
  if [ "$avail" -lt "$need" ]; then
    log "only ${avail}M available, ${need}M needed for $phase"
    log "  raise or disable the gate with --min-free-mem <MB> (0 = off), or give the VM more RAM/swap."
    return 1
  fi
  log "memory gate passed for $phase: ${avail}M available, ${need}M required"
  return 0
}

require_disk() { # <needed_mb>
  local need="$1" free
  [ "$need" -gt 0 ] || return 0
  free="$(disk_free_mb "$ROOT")" || return 0
  [ -n "$free" ] || return 0
  if [ "$free" -lt "$need" ]; then
    log "only ${free}M free on $ROOT, ${need}M needed to stage a release"
    log "  a clone plus two node_modules trees is not small; free space or lower --min-free-disk."
    return 1
  fi
  return 0
}

# Run one expensive step with the brakes on:
#   timeout  - a wedged npm/vite fails the cycle instead of running forever
#   nice     - the app (when it is up) and sshd outrank the updater for CPU
#   ionice   - and for disk, which is what actually starves a small VM
#   npm_*    - fewer parallel sockets, no audit/fund round-trips, no progress
#              redraws in a journal
# Returns the command's exit status; 124/137 are reported as a timeout.
run_step() { # <seconds> <label> <command...>
  local secs="$1" label="$2"; shift 2
  local -a wrap=()
  command -v timeout >/dev/null 2>&1 && wrap+=(timeout -k 30 "$secs")
  command -v nice    >/dev/null 2>&1 && wrap+=(nice -n "$NICE_LEVEL")
  command -v ionice  >/dev/null 2>&1 && wrap+=(ionice -c2 -n7)
  local rc=0
  "${wrap[@]}" env \
    npm_config_maxsockets="$NPM_MAX_SOCKETS" \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_progress=false \
    "$@" || rc=$?
  case "$rc" in
    0)        ;;
    124|137)  log "$label TIMED OUT after ${secs}s (--step-timeout)" ;;
    *)        log "$label failed (exit $rc)" ;;
  esac
  return $rc
}

# Dependencies come from the lockfile, or they do not come at all.
#
# `npm install` resolves afresh and rewrites package-lock.json, so a manifest
# whose peer dependencies cannot be satisfied gets papered over locally and the
# deployed tree stops matching the repository. `npm ci` installs exactly the
# lockfile and fails loudly when it disagrees with package.json - which is what
# a deployment wants. (npm's own guidance for CI/deploys.)
npm_install_in() { # <dir> <label>
  local dir="$1" label="$2"
  if [ -f "$dir/package-lock.json" ]; then
    ( cd "$dir" && run_step "$STEP_TIMEOUT" "$label npm ci" npm ci --no-audit --no-fund --loglevel=error )
  else
    log "$label: no package-lock.json in this release - falling back to npm install"
    ( cd "$dir" && run_step "$STEP_TIMEOUT" "$label npm install" npm install --no-audit --no-fund --loglevel=error )
  fi
}

# Resolve the release's dependency graph WITHOUT installing it, while the site
# is still up. This is the cheap way to catch the class of failure that took
# this deployment down: package.json asking for a major that no other package
# accepts, so every install ends in ERESOLVE. Discovering that after the app has
# been stopped costs an outage; discovering it here costs nothing.
validate_dependency_graph() { # <dir>
  local dir="$1" pkg
  for pkg in backend frontend; do
    [ -d "$dir/$pkg" ] || continue
    [ -f "$dir/$pkg/package-lock.json" ] || continue
    if ! ( cd "$dir/$pkg" && run_step "$STEP_TIMEOUT" "$pkg dependency check" \
             npm ci --dry-run --ignore-scripts --no-audit --no-fund --loglevel=error ); then
      log "$pkg: this release's dependencies do not resolve against its lockfile"
      log "  (npm ci --dry-run failed - a peer conflict or an out-of-date lockfile)"
      return 1
    fi
  done
  log "dependency graphs resolve for this release"
  return 0
}

# The frontend build, capped. vite/rollup will happily grow past the whole VM;
# a heap ceiling makes it fail as a build rather than as a machine.
build_frontend_in() { # <dir>
  local dir="$1"
  [ -d "$dir/frontend" ] || return 0
  local heap=()
  [ "$BUILD_HEAP_MB" -gt 0 ] && heap=(NODE_OPTIONS="--max-old-space-size=$BUILD_HEAP_MB")
  ( cd "$dir/frontend" && run_step "$STEP_TIMEOUT" "frontend build" env "${heap[@]}" npm run build ) >/dev/null 2>&1 \
    && [ -f "$dir/frontend/dist/index.html" ]
}

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

# Fetch a URL to stdout with whatever HTTP client exists. Empty output means
# "could not reach it", which the callers treat as not healthy.
http_get() { # <url>
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 5 -O - "$1" 2>/dev/null
  else
    return 1
  fi
}

# Pull one top-level string field out of the health JSON without needing jq.
json_field() { # <json> <key>
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

# The commit the process answering on HEALTH_URL is running, or empty.
running_commit() {
  local body
  body="$(http_get "$HEALTH_URL")" || return 1
  [ -n "$body" ] || return 1
  json_field "$body" commit
}

# Verify the deployment, not merely the port.
#
# Called with the commit that was just deployed, this accepts the release only
# when the responding process reports THAT commit. /api/health captures its
# commit when Node starts, so an old process that never restarted keeps
# reporting the old sha and is rejected - which is precisely the false positive
# that let a bare `./espress0 update` claim success while serving stale code.
#
# Called with no argument (rollback path) it only requires status=ok.
verify_healthy() { # [expected_sha]
  local expected="${1:-}" attempt=1 body status commit
  while [ "$attempt" -le 20 ]; do
    sleep 1
    body="$(http_get "$HEALTH_URL")"
    if [ -z "$body" ]; then
      if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        log "no curl or wget available - cannot verify that the new code is serving"
        ST_VERIFIED=skipped
        return 1
      fi
      attempt=$((attempt + 1)); continue
    fi

    status="$(json_field "$body" status)"
    if [ "$status" != "ok" ]; then
      log "health endpoint answered with status='$status' (attempt $attempt)"
      attempt=$((attempt + 1)); continue
    fi

    commit="$(json_field "$body" commit)"
    ST_RUNNING="$commit"
    if [ -z "$expected" ]; then
      log "healthy: GET $HEALTH_URL (attempt $attempt)"
      ST_VERIFIED=ok
      return 0
    fi
    if [ -n "$commit" ] && [ "$commit" = "$expected" ]; then
      log "verified: the process serving $HEALTH_URL runs ${commit:0:7} (attempt $attempt)"
      ST_VERIFIED=ok
      return 0
    fi
    if [ -z "$commit" ]; then
      # An older release predates the commit field. Do not silently accept it:
      # that is the same false positive with an extra step.
      log "health endpoint reports no commit - this process predates commit-aware health"
      log "  (expected ${expected:0:7}); treating as NOT verified"
    else
      log "still ${commit:0:7} on $HEALTH_URL, expected ${expected:0:7} (attempt $attempt)"
    fi
    attempt=$((attempt + 1))
  done
  if [ -n "$expected" ]; then
    log "the responding process never reported ${expected:0:7} within 20s"
    ST_VERIFIED=wrong-commit
  else
    log "site did not answer on $HEALTH_URL within 20s"
    ST_VERIFIED=unreachable
  fi
  return 1
}

# --------------------------------------------------------- restart target

# Which systemd unit (if any) supervises THIS checkout?
#
# Matching on the unit's WorkingDirectory is what keeps a second deployment on
# the same host from being restarted by this one. The unit runs the backend
# from <root>/backend, so both that and the root itself count as a match.
systemd_unit_matches_root() { # <unit>
  local wd
  wd="$(systemctl show -p WorkingDirectory --value "$1" 2>/dev/null)" || return 1
  [ -n "$wd" ] || return 1
  wd="${wd%/}"
  [ "$wd" = "$ROOT" ] || [ "$wd" = "$ROOT/backend" ]
}

tmux_session_has_app_window() { # <session>
  command -v tmux >/dev/null 2>&1 || return 1
  tmux has-session -t "$1" 2>/dev/null || return 1
  tmux list-windows -t "$1" -F '#W' 2>/dev/null | grep -qxE 'app|backend'
}

# Decide, once per cycle and BEFORE anything is modified, how this application
# is supervised. Sets SUPERVISOR/SUPERVISOR_NAME, or fails with an actionable
# message. Explicit flags always win over detection.
resolve_restart_target() {
  SUPERVISOR=""
  SUPERVISOR_NAME=""

  if [ "$NO_RESTART" = 1 ]; then
    SUPERVISOR="none"
    SUPERVISOR_NAME="--no-restart"
    log "--no-restart: deploying files without restarting anything (you must restart the app yourself)"
    return 0
  fi

  # 1. Explicit options.
  if [ -n "$STOP_CMD" ] || [ -n "$START_CMD" ]; then
    if [ -z "$STOP_CMD" ] || [ -z "$START_CMD" ]; then
      refuse "--stop-cmd and --start-cmd must be given together (got only one)."
      return 1
    fi
    SUPERVISOR="command"; SUPERVISOR_NAME="custom"
    log "restart target: custom stop/start commands"
    return 0
  fi
  if [ -n "$SERVICE" ]; then
    SUPERVISOR="systemd"; SUPERVISOR_NAME="$SERVICE"
    log "restart target: systemd unit '$SERVICE' (explicit)"
    return 0
  fi
  if [ "$TMUX_SESSION_GIVEN" = 1 ]; then
    if ! tmux_session_has_app_window "$TMUX_SESSION"; then
      refuse "--tmux-session '$TMUX_SESSION' has no running 'app' or 'backend' window."
      return 1
    fi
    SUPERVISOR="tmux"; SUPERVISOR_NAME="$TMUX_SESSION"
    log "restart target: tmux session '$TMUX_SESSION' (explicit)"
    return 0
  fi

  # 2. An active systemd unit whose WorkingDirectory is this checkout. The
  #    standard install is espress0-repo; a renamed one is still found by
  #    scanning units that look like this app.
  if command -v systemctl >/dev/null 2>&1; then
    local unit
    for unit in "${APP_SERVICE_NAME:-espress0-repo}" espress0-repo; do
      [ -n "$unit" ] || continue
      if systemctl is-active --quiet "$unit" 2>/dev/null && systemd_unit_matches_root "$unit"; then
        SUPERVISOR="systemd"; SUPERVISOR_NAME="$unit"
        log "restart target: systemd unit '$unit' (detected: active, WorkingDirectory matches $ROOT)"
        return 0
      fi
    done
    for unit in $(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null \
                    | awk '{print $1}' | grep -E 'espress0' || true); do
      unit="${unit%.service}"
      if systemd_unit_matches_root "$unit"; then
        SUPERVISOR="systemd"; SUPERVISOR_NAME="$unit"
        log "restart target: systemd unit '$unit' (detected by working directory)"
        return 0
      fi
    done
  fi

  # 3. A tmux session from start-tmux.sh.
  if tmux_session_has_app_window "$TMUX_SESSION"; then
    SUPERVISOR="tmux"; SUPERVISOR_NAME="$TMUX_SESSION"
    log "restart target: tmux session '$TMUX_SESSION' (detected)"
    return 0
  fi

  # 4. Nothing manageable. Stop here - before the live tree or the database.
  log "could not work out how this application is being run."
  log "  Looked for: an active systemd unit with WorkingDirectory=$ROOT (or $ROOT/backend),"
  log "              and a tmux session '$TMUX_SESSION' with an app/backend window."
  log "  Fix it with ONE of:"
  log "    ./espress0 update --service <unit>          # systemd"
  log "    ./espress0 update --tmux-session <name>     # tmux (./espress0 serve)"
  log "    ./espress0 update --stop-cmd '...' --start-cmd '...'   # any supervisor"
  log "    ./espress0 update --no-restart              # deliberate offline file-only deploy"
  refuse "No manageable application process found; refusing to deploy over a running app."
  return 1
}

# ------------------------------------------------------------------- stop/start

LAUNCH_BACKEND='cd backend && NODE_ENV=production node src/index.js'

tmux_has_window() {
  local name="$1"
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null \
    && tmux list-windows -t "$TMUX_SESSION" -F '#W' 2>/dev/null | grep -qx "$name"
}

# (Re)start a command in a named tmux window.
#
# respawn-window, never send-keys: a start-tmux window is a wrapper shell
# ("launch; echo; read"), so after the stop the shell sits waiting at `read` -
# typing the launch command there feeds the waiting read builtin, the wrapper
# consumes it as input and exits, and the app never starts. respawn replaces
# the window's process whatever it is currently doing; a window whose wrapper
# already exited (the read hit EOF/Enter) is recreated.
tmux_launch() { # <window> <command>
  if tmux_has_window "$1"; then
    tmux respawn-window -k -d -t "$TMUX_SESSION:$1" "$2" 2>/dev/null && return 0
  fi
  tmux new-window -d -t "$TMUX_SESSION" -n "$1" "$2" 2>/dev/null
}

# Stop the application. Returns non-zero if it cannot be proven stopped.
#
# This used to log "no stop target configured" and carry on, which is the bug
# this whole change is about: files were swapped and migrations applied under a
# process that kept serving the old code. Every caller must now treat a failure
# here as "do not deploy".
stop_app() {
  case "$SUPERVISOR" in
    none)
      log "--no-restart: not stopping anything"
      ST_STOPPED=skipped
      return 0
      ;;
    command)
      log "stopping app: $STOP_CMD"
      # 9>&-: never let a child inherit the lock fd, or a long-lived process we
      # start would keep data/.auto-update.lock held and every later cycle would
      # exit as "another instance is running".
      if ! bash -c "$STOP_CMD" 9>&-; then
        log "the custom stop command failed"
        ST_STOPPED=failed
        return 1
      fi
      ;;
    systemd)
      log "stopping systemd service: $SUPERVISOR_NAME"
      if ! systemctl stop "$SUPERVISOR_NAME" 2>/dev/null && ! sudo -n systemctl stop "$SUPERVISOR_NAME" 2>/dev/null; then
        log "could not stop $SUPERVISOR_NAME - permission denied or unit unknown."
        log "  Grant the updater the three verbs it needs:"
        log "    echo \"$(id -un) ALL=(root) NOPASSWD: $(command -v systemctl) stop $SUPERVISOR_NAME, $(command -v systemctl) restart $SUPERVISOR_NAME, $(command -v systemctl) start $SUPERVISOR_NAME\" \\"
        log "      | sudo tee /etc/sudoers.d/espress0-updater   (sudo visudo -cf it first)"
        ST_STOPPED=failed
        return 1
      fi
      # "systemctl stop returned 0" and "the unit is down" are different facts
      # when a unit is slow to stop or restarts itself.
      local waited=0
      while [ "$waited" -lt 15 ]; do
        systemctl is-active --quiet "$SUPERVISOR_NAME" 2>/dev/null || break
        sleep 1; waited=$((waited + 1))
      done
      if systemctl is-active --quiet "$SUPERVISOR_NAME" 2>/dev/null; then
        log "$SUPERVISOR_NAME is STILL active after 15s - refusing to swap files under it"
        ST_STOPPED=failed
        return 1
      fi
      ;;
    tmux)
      # Ctrl-C the app and (in dev mode) the frontend window, but never the
      # session: this script is often the 'updater' window inside it, and killing
      # the session would take the updater down mid-deploy.
      local w stopped=0
      for w in app backend frontend; do
        tmux_has_window "$w" || continue
        log "stopping tmux window: $w"
        if tmux send-keys -t "$TMUX_SESSION:$w" C-c 2>/dev/null; then
          case "$w" in app|backend) stopped=1 ;; esac
        fi
      done
      if [ "$stopped" != 1 ]; then
        log "could not stop an 'app'/'backend' window in tmux session '$TMUX_SESSION'"
        ST_STOPPED=failed
        return 1
      fi
      ;;
    *)
      log "internal error: stop_app called with no resolved supervisor"
      ST_STOPPED=failed
      return 1
      ;;
  esac

  sleep 2   # let the listener actually go away before files move under it

  # Belt and braces: if something is still answering the health URL, the old
  # process is alive and deploying now would repeat the original bug.
  if [ "$SUPERVISOR" != "none" ] && running_commit >/dev/null 2>&1; then
    sleep 3
    if running_commit >/dev/null 2>&1; then
      log "something is STILL serving $HEALTH_URL after the stop - not deploying"
      ST_STOPPED=failed
      return 1
    fi
  fi

  ST_STOPPED=ok
  return 0
}

start_app() {
  case "$SUPERVISOR" in
    none)
      log "--no-restart: not starting anything. Restart the app yourself to serve the new code."
      ST_STARTED=skipped
      return 0
      ;;
    command)
      log "starting app: $START_CMD"
      bash -c "$START_CMD" 9>&- || { log "start command failed"; ST_STARTED=failed; return 1; }
      ;;
    systemd)
      log "starting systemd service: $SUPERVISOR_NAME"
      systemctl restart "$SUPERVISOR_NAME" 2>/dev/null || sudo -n systemctl restart "$SUPERVISOR_NAME" 2>/dev/null || {
        log "could not restart $SUPERVISOR_NAME - grant the three verbs it needs with:"
        log "  echo \"$(id -un) ALL=(root) NOPASSWD: $(command -v systemctl) stop $SUPERVISOR_NAME, $(command -v systemctl) restart $SUPERVISOR_NAME, $(command -v systemctl) start $SUPERVISOR_NAME\" \\"
        log "    > /etc/sudoers.d/espress0-updater   (visudo -cf it before installing)"
        ST_STARTED=failed
        return 1
      }
      ;;
    tmux)
      local started=0 w
      for w in app backend; do
        tmux_has_window "$w" || continue
        log "restarting tmux window: $w"
        tmux_launch "$w" "cd '$ROOT' && $LAUNCH_BACKEND" && started=1
      done
      if tmux_has_window frontend; then
        log "restarting tmux window: frontend"
        tmux_launch frontend "cd '$ROOT/frontend' && npm run dev -- --host" && started=1
      fi
      [ "$started" = 1 ] || { log "no 'app'/'backend'/'frontend' window in '$TMUX_SESSION' - cannot start"; ST_STARTED=failed; return 1; }
      ;;
    *)
      log "internal error: start_app called with no resolved supervisor"
      ST_STARTED=failed
      return 1
      ;;
  esac
  ST_STARTED=ok
  return 0
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
  (cd "$2" && run_step "$STEP_TIMEOUT" "$1 migrations" node src/db/migrate.js) >/dev/null 2>&1 \
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
  # A relative DATABASE_PATH is resolved by config.js against the REPO ROOT
  # (backend/src -> ../../), not against the launch cwd - so probe the
  # root-relative path first, then the backend/-relative one for installs that
  # historically kept the database there, and finally config.js's own default
  # fallbacks.
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
  # Absolute on purpose: config.js resolves a RELATIVE DATABASE_PATH against
  # the repo root (backend/src -> ../../), not the cwd, so a './data/repo.db'
  # here would point at $STAGE_DIR/data and miss the copy made above - the
  # rehearsal would run, pass, and have tested an empty file it just created.
  local staged_db="$ROOT/$STAGE_DIR/backend/data/repo.db"
  if (cd "$STAGE_DIR/backend" && run_step "$STEP_TIMEOUT" "migration rehearsal" \
        env DATABASE_PATH="$staged_db" node src/db/migrate.js) >/dev/null 2>&1; then
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
    [ -d "$dir/$pkg" ] || continue
    # A symlink here is reuse_live_deps' doing: the manifests are identical to
    # the running commit, so there is nothing to install.
    if [ -L "$dir/$pkg/node_modules" ]; then
      log "$pkg: reusing the live node_modules (manifests unchanged)"
      continue
    fi
    if [ -d "$dir/$pkg/node_modules" ] && [ -n "$(ls -A "$dir/$pkg/node_modules" 2>/dev/null)" ]; then
      continue
    fi
    log "installing $pkg dependencies (staged, from the lockfile)"
    npm_install_in "$dir/$pkg" "$pkg" || { log "dependency install failed in $dir/$pkg"; return 1; }
  done
  return 0
}

# Copy the staged build over the live tree, leaving every gitignored runtime
# directory exactly where it is. Uses rsync when available, otherwise a
# tar-pipe so a box without rsync still updates.
swap_tree() {
  if command -v rsync >/dev/null 2>&1; then
    # The runtime exclusions are unanchored basename patterns on purpose: a
    # 'data/' style pattern would only guard <root>/data, and --delete then
    # removes a database living at backend/data - plus the rehearsal's copy in
    # the staged tree would rsync straight over it.
    rsync -a --delete \
      --exclude '.git/' --exclude "$STAGE_ROOT/" --exclude 'data' --exclude 'backups' \
      --exclude 'uploads' --exclude '.env' --exclude 'node_modules' \
      "$STAGE_DIR/" "$ROOT/" || return 1
  else
    # Patterns are basename-style (no './x' anchors) so they match at every
    # depth, exactly like the rsync list above - a staged tree with real
    # backend/node_modules must not spray it over the live one, and a
    # release's deleted files linger without --delete, which tar has no
    # equivalent of: acceptable for a box without rsync, and noted.
    ( cd "$STAGE_DIR" && tar cf - \
        --exclude='.git' --exclude="$STAGE_ROOT" --exclude='data' --exclude='backups' \
        --exclude='uploads' --exclude='.env' --exclude='node_modules' . ) \
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
    build_frontend_in "$ROOT" || log "rollback rebuild FAILED"
  fi
}

# ------------------------------------------------------------- database snapshot

# Migrations are forward-only, so rolling code back is not enough: a release
# that added a column leaves the old code talking to a new schema. Snapshot the
# database immediately before the live migration runs, and restore it if the
# deploy is abandoned. Previously the updater only printed a note telling the
# operator to go find a backup themselves.
PREV_DB="$STAGE_ROOT/prev-db"
DB_SNAPSHOT_PATH=""
DB_SNAPSHOT_TAKEN=0

save_db_snapshot() {
  DB_SNAPSHOT_TAKEN=0
  DB_SNAPSHOT_PATH=""
  [ "$MIGRATE" = 1 ] || return 0
  local live
  live="$(find_live_db)" || { log "no database file yet - nothing to snapshot"; return 0; }

  rm -rf "$PREV_DB"; mkdir -p "$PREV_DB"
  # sqlite3 .backup is the only way to copy a database that may still have a
  # WAL attached; a plain cp of a hot database can capture a torn page. Fall
  # back to copying the file plus its side files when sqlite3 is not installed.
  if command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$live" ".backup '$PREV_DB/repo.db'" 2>/dev/null; then
    :
  else
    cp "$live" "$PREV_DB/repo.db" 2>/dev/null || { log "could not snapshot $live"; return 1; }
    local ext
    for ext in -wal -shm; do [ -f "$live$ext" ] && cp "$live$ext" "$PREV_DB/repo.db$ext" 2>/dev/null; done
  fi
  DB_SNAPSHOT_PATH="$live"
  DB_SNAPSHOT_TAKEN=1
  log "snapshotted the database ($live) for rollback"
  return 0
}

# Only called on the rollback path, and only when a snapshot exists. The app is
# stopped at this point, so replacing the file is safe.
restore_db_snapshot() {
  [ "$DB_SNAPSHOT_TAKEN" = 1 ] || return 0
  [ -f "$PREV_DB/repo.db" ] || { log "no database snapshot to restore"; return 1; }
  local live="$DB_SNAPSHOT_PATH"
  [ -n "$live" ] || return 1

  # Keep whatever the failed release left behind, for a post-mortem.
  if [ -f "$live" ]; then
    cp "$live" "$STAGE_ROOT/failed-db-$(date -u '+%Y%m%dT%H%M%SZ').db" 2>/dev/null || true
  fi
  local ext
  for ext in -wal -shm; do rm -f "$live$ext"; done
  if cp "$PREV_DB/repo.db" "$live" 2>/dev/null; then
    for ext in -wal -shm; do
      [ -f "$PREV_DB/repo.db$ext" ] && cp "$PREV_DB/repo.db$ext" "$live$ext" 2>/dev/null
    done
    log "restored the pre-update database snapshot to $live"
    return 0
  fi
  log "COULD NOT restore the database snapshot - it is kept at $PREV_DB/repo.db"
  return 1
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

# The expensive half of a clone deploy: dependencies, the frontend bundle and
# the migration rehearsal. Split out because WHEN it runs is now a policy
# decision - by default with the app stopped (so the build is not competing
# with the running site for a small VM's memory), or, with --build-online, the
# historic overlap. Sets STAGE_FAIL to the state message for the caller.
STAGE_FAIL=""
stage_build() { # <local_sha> <remote_sha>
  STAGE_FAIL=""
  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - staged tree gets its own install"
  else
    reuse_live_deps
  fi
  if ! install_deps_in "$STAGE_DIR"; then
    STAGE_FAIL="Dependency install failed in the staged tree - live tree untouched"
    return 1
  fi
  if ! build_frontend_in "$STAGE_DIR"; then
    log "the new frontend does not build - not deploying"
    STAGE_FAIL="Frontend build failed in the staged tree - live tree untouched"
    return 1
  fi
  if ! rehearse_migrations; then
    STAGE_FAIL="Migrations failed against a copy of the live DB - not deployed"
    return 1
  fi
  return 0
}

# clone mode: prove the release off to the side, then swap and restart.
deploy_via_clone() { # <local_sha> <remote_sha>
  local remote_url
  remote_url="$(git remote get-url "$REMOTE" 2>/dev/null)"
  if [ -z "$remote_url" ]; then
    log "no '$REMOTE' URL to clone from - falling back to --mode pull"
    deploy_via_pull "$1" "$2"
    return $?
  fi

  # Preflight, before a single byte is written: staging a release costs a git
  # clone plus (usually) two node_modules trees. Running out of disk halfway
  # through that is a much worse place to discover it.
  log_resources "before staging"
  if ! require_disk "$MIN_FREE_DISK_MB"; then
    refuse "Not enough free disk to stage a release safely (need ${MIN_FREE_DISK_MB}M on $ROOT)."
    return 1
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

  # Cheap, read-only, and it runs while the site is still up: does this
  # release's dependency graph resolve at all? An unresolvable manifest is the
  # single most common way a release cannot be installed, and the one failure
  # we refuse to discover with the application already stopped.
  if ! validate_dependency_graph "$STAGE_DIR"; then
    write_state error "This release's dependencies do not resolve (npm ci --dry-run) - live tree untouched, app still serving."
    return 1
  fi

  if [ "$BUILD_ONLINE" = 1 ]; then
    # Historic order: build alongside the running app. Kept for hosts with the
    # memory to spare, never the default on a small VM.
    log "--build-online: building the staged tree while the app keeps serving"
    if ! stage_build "$1" "$2"; then
      write_state error "$STAGE_FAIL"
      return 1
    fi
    release_live_deps
    log "staged build is good - stopping the app to swap"
    if ! stop_app; then
      refuse "Could not stop the application ($SUPERVISOR:$SUPERVISOR_NAME); live tree and database untouched."
      return 1
    fi
  else
    # Default order. The app goes down FIRST, so the install and the bundler get
    # the machine to themselves - no 800M of Node, no live page cache, no
    # request traffic to compete with. The tree and the database are still
    # untouched at this point, so every failure below simply starts the app
    # again on the commit it was already running.
    log "stopping the app before the install/build phase (see --build-online)"
    if ! stop_app; then
      refuse "Could not stop the application ($SUPERVISOR:$SUPERVISOR_NAME); live tree and database untouched."
      return 1
    fi

    log_resources "after stopping the app"
    if ! require_memory "$MIN_FREE_MEM_MB" "the install/build phase"; then
      start_app
      refuse "Not enough free memory to build this release safely; the app was restarted on ${1:0:7} and nothing else was touched."
      return 1
    fi

    if ! stage_build "$1" "$2"; then
      log "the staged build failed with the app down - restarting the previous release"
      release_live_deps
      start_app
      verify_healthy "$1" >/dev/null 2>&1 || log "the previous release is not answering - check the logs"
      write_state error "${STAGE_FAIL%% - *} - the app was restarted on ${1:0:7}; the live tree, build and database were never touched."
      return 1
    fi
    release_live_deps
    log "staged build is good, and the app is already stopped - swapping"
  fi

  save_dist_snapshot
  if ! save_db_snapshot; then
    log "could not snapshot the database - starting the app again without deploying"
    start_app
    refuse "Database snapshot failed; refused to run forward-only migrations without a way back."
    return 1
  fi

  if ! swap_tree; then
    # A half-finished rsync leaves old and new files intermixed on disk;
    # merely starting the app would serve that. Nothing above this line moved
    # HEAD, so the rollback machinery is still exact: reset the tracked files
    # to the old commit, drop files that release added, restore the dist
    # snapshot taken just before the swap - and only then restart.
    log "swap failed part-way - rolling the tree back to $(printf %.7s "$1") before restarting"
    rollback_to "$1" "$2" || true
    restore_dist_snapshot
    start_app
    write_state error "File swap failed part-way; tree reset to ${1:0:7} and previous build restored."
    return 1
  fi

  # Deps actually changed: install against the live tree now that the app is
  # stopped, so node_modules never moves under a running process. The staged
  # tree already proved this lockfile installs, so a failure here is a genuine
  # surprise and is logged as one.
  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - installing into the live tree"
    npm_install_in "$ROOT/backend" "backend (live)" || log "backend dependency install FAILED"
    build_frontend_in "$ROOT" || log "frontend rebuild FAILED (staged build kept)"
  fi

  if run_migrations "live database" backend; then
    ST_MIGRATED=ok
  else
    ST_MIGRATED=failed
    log "live migrations failed - rolling back"
    rollback_to "$1" "$2"; restore_dist_snapshot; restore_db_snapshot
    start_app
    verify_healthy >/dev/null 2>&1 || log "the previous release is not answering either - check the logs"
    write_state failed "Live migrations failed; source, build and database restored to ${1:0:7}."
    return 1
  fi
  confirm_deployment "$2" || true

  if [ "$SUPERVISOR" = "none" ]; then
    # --no-restart: the files are deployed and that is all that was asked for.
    log "deployed ${2:0:7} to disk. NOT restarted (--no-restart) - the running"
    log "  process, if any, still serves the previous code until you restart it."
    write_state deployed-not-restarted "Deployed ${2:0:7} to disk; restart skipped (--no-restart)."
    return 0
  fi

  if start_app && verify_healthy "$2"; then
    log "now on $(git rev-parse --short HEAD); the serving process runs ${2:0:7}"
    write_state updated "Updated to ${2:0:7} and verified running."
    return 0
  fi

  log "rolling back to ${1:0:7}"
  rollback_to "$1" "$2"
  restore_dist_snapshot
  restore_db_snapshot
  log "note: staged dependency installs are not reversed; run 'npm ci' in"
  log "      backend/ and frontend/ if this release changed them."
  start_app
  if verify_healthy "$1"; then
    log "rolled back: the serving process runs ${1:0:7} again"
    write_state failed "Deployed ${2:0:7} but it did not come up; rolled back to ${1:0:7}, which is verified running."
  else
    log "ROLLBACK DID NOT COME UP - manual intervention needed"
    write_state failed "Deployed ${2:0:7}, it failed, and the rollback to ${1:0:7} is not answering. Manual recovery required."
  fi
  return 1
}

# pull mode: the historic fast-forward path, with the stop-first ordering and
# the verify/rollback steps the in-place update always needed.
deploy_via_pull() { # <local_sha> <remote_sha>
  # (the shared dirty-tree gate lives in check_and_update, ahead of both modes)
  # never clobber local work: fast-forward only. Checked before stopping the
  # app (a dry run), then actually performed once the app is down.
  if ! git merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; then
    log "non-fast-forward (local commits ahead or history diverged) - skipping"
    write_state skipped "Local commits diverge from $REMOTE/$BRANCH - resolve manually, updater will not reset."
    return 0
  fi
  log "update available; stopping the app before touching the checkout"
  if ! stop_app; then
    refuse "Could not stop the application ($SUPERVISOR:$SUPERVISOR_NAME); the checkout was left on ${1:0:7}."
    return 1
  fi

  # Same gate as clone mode, just later: pull mode does its install and build in
  # the live tree, and it is already stopped by here.
  log_resources "after stopping the app"
  if ! require_memory "$MIN_FREE_MEM_MB" "the in-place install/build"; then
    start_app
    refuse "Not enough free memory to rebuild in place; the app was restarted on ${1:0:7} and the checkout was left alone."
    return 1
  fi

  save_dist_snapshot
  if ! save_db_snapshot; then
    start_app
    refuse "Database snapshot failed; refused to run forward-only migrations without a way back."
    return 1
  fi

  # Only now does the checkout move. Doing this before the stop succeeded would
  # leave a running process on files that no longer match its commit.
  if ! git merge --ff-only --quiet FETCH_HEAD; then
    log "fast-forward failed after stopping - restarting the app unchanged"
    start_app
    write_state skipped "Could not fast-forward to $REMOTE/$BRANCH; app restarted on ${1:0:7}."
    return 0
  fi
  log "merged to $(git rev-parse --short HEAD)"

  if deps_changed "$1" "$2"; then
    log "dependency manifests changed - reinstalling from the lockfiles"
    npm_install_in "$ROOT/backend" "backend" || log "backend dependency install FAILED"
    npm_install_in "$ROOT/frontend" "frontend" || log "frontend dependency install FAILED"
  fi
  if ! git diff --quiet "$1..$2" -- frontend 2>/dev/null || [ ! -f frontend/dist/index.html ]; then
    log "frontend changed - rebuilding"
    build_frontend_in "$ROOT" || log "frontend build FAILED"
  fi
  if run_migrations "live database" backend; then
    ST_MIGRATED=ok
  else
    ST_MIGRATED=failed
    log "live migrations FAILED - rolling back"
    rollback_to "$1" "$2"; restore_dist_snapshot; restore_db_snapshot
    start_app
    write_state failed "Live migrations failed; source, build and database restored to ${1:0:7}."
    return 1
  fi

  if [ "$SUPERVISOR" = "none" ]; then
    log "deployed ${2:0:7} to disk. NOT restarted (--no-restart)."
    write_state deployed-not-restarted "Deployed ${2:0:7} to disk; restart skipped (--no-restart)."
    return 0
  fi

  if start_app && verify_healthy "$2"; then
    log "now on $(git rev-parse --short HEAD); the serving process runs ${2:0:7}"
    write_state updated "Updated to ${2:0:7} and verified running."
    return 0
  fi
  log "site unhealthy (or on the wrong commit) after the in-place update; rolling back to ${1:0:7}"
  rollback_to "$1" "$2"
  restore_dist_snapshot
  restore_db_snapshot
  start_app
  if verify_healthy "$1"; then
    write_state failed "In-place update to ${2:0:7} failed; rolled back to ${1:0:7}, which is verified running."
  else
    write_state failed "In-place update to ${2:0:7} failed and the rollback to ${1:0:7} is not answering. Manual recovery required."
  fi
  return 1
}

check_and_update() {
  if [ -e "$DISABLE_FILE" ]; then
    write_state paused "Paused by $DISABLE_FILE - remove it to resume."
    return 0
  fi

  # A tracked file with local edits would be silently overwritten by a clone
  # deploy (and its trail erased by the final `git reset`), and no
  # fast-forward can carry it in pull mode - so BOTH modes skip the cycle
  # until it is committed, stashed or reverted. The setup.sh -> config.sh
  # self-rename is exempt: every fresh install ends with exactly that
  # deletion pending.
  if [ -n "$(git status --porcelain --untracked-files=no -- . ':(exclude)scripts/setup.sh')" ]; then
    log "working tree has uncommitted changes - skipping this cycle"
    write_state skipped "Dirty working tree - update postponed until it is committed/stashed."
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

  # Accepting a deploy means proving it: a health check needs an HTTP client.
  # Discovering that mid-verify would roll an otherwise-good release back, so
  # say it here, while nothing is touched. (--no-restart deploys never verify.)
  if [ "$NO_RESTART" != 1 ] \
     && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    refuse "neither curl nor wget is installed, so a deploy could never be verified against $HEALTH_URL."
    return 1
  fi

  log "update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short FETCH_HEAD) ($MODE mode)"

  # Preflight, before a single file moves: work out how to restart this app.
  # If we cannot, the update stops here with the live tree and database exactly
  # as they were - a stale process serving old code is recoverable, a swapped
  # tree under a stale process is not.
  ST_EXPECTED="$remote_sha"
  ST_STOPPED=unknown; ST_MIGRATED=unknown; ST_STARTED=unknown; ST_VERIFIED=unknown; ST_REASON=""
  ST_RUNNING="$(running_commit 2>/dev/null || true)"
  if ! resolve_restart_target; then
    return 1
  fi

  if [ "$MODE" = "clone" ]; then
    deploy_via_clone "$local_sha" "$remote_sha"
  else
    deploy_via_pull "$local_sha" "$remote_sha"
  fi
  return $?
}

log "tracking $REMOTE/$BRANCH every ${INTERVAL}s, mode=$MODE (pause: touch $DISABLE_FILE)"
log "health/verification endpoint: $HEALTH_URL"
if [ "$BUILD_ONLINE" = 1 ]; then
  log "build policy: --build-online (install/build run while the app serves)"
else
  log "build policy: the app is stopped for the install/build phase"
fi
log "resource policy: >=${MIN_FREE_MEM_MB}M free RAM to build, >=${MIN_FREE_DISK_MB}M free disk to stage,"
log "  ${STEP_TIMEOUT}s per step, nice ${NICE_LEVEL}, npm maxsockets ${NPM_MAX_SOCKETS}, build heap ${BUILD_HEAP_MB}M"
log_resources "at startup"

if [ "$ONCE" = 1 ]; then
  check_and_update
  exit $?
fi

while :; do
  check_and_update
  sleep "$INTERVAL"
done
