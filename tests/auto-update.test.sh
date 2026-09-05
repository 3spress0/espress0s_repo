#!/usr/bin/env bash
#
# Regression tests for the auto-updater's restart-target safety rules.
#
# The bug these lock down: a bare `./espress0 update` found no restart target,
# logged "no stop target configured", swapped the live files, ran migrations
# against the live database, and then passed a health check answered by the OLD
# still-running Node process. Code on disk and code in memory ended up on
# different commits, and the updater reported success.
#
# The rule under test is: NO VERIFIED RESTART TARGET, NO LIVE DEPLOYMENT.
#
# Everything is mocked - git remotes are real local repositories, while
# systemctl, tmux and the HTTP client are stubs driven by files under
# $SANDBOX/mock-state. No systemd, no network, no root.
#
#   ./tests/auto-update.test.sh              run all
#   ./tests/auto-update.test.sh <substring>  run matching cases only

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPDATER="$REPO_ROOT/scripts/auto-update.sh"
DEPLOY="$REPO_ROOT/scripts/deploy-ubuntu.sh"
FILTER="${1:-}"

PASS=0; FAIL=0; FAILED_NAMES=()
if [ -t 1 ]; then GRN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RST=$'\033[0m'
else GRN=""; RED=""; DIM=""; RST=""; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- assertions

ok()   { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$CURRENT: $1"); printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }

assert_contains() { # <haystack-file> <needle> <label>
  if grep -qF -- "$2" "$1"; then ok "$3"; else
    bad "$3 (expected to find: $2)"
    printf '%s      --- output ---%s\n' "$DIM" "$RST"
    sed 's/^/      /' "$1" | tail -n 25
  fi
}
assert_not_contains() { # <haystack-file> <needle> <label>
  if grep -qF -- "$2" "$1"; then
    bad "$3 (did NOT expect: $2)"
    sed 's/^/      /' "$1" | tail -n 25
  else ok "$3"; fi
}
assert_eq() { # <actual> <expected> <label>
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi
}
assert_file_contains() { # <file> <needle> <label>
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then ok "$3"; else
    bad "$3 (file $1 missing or lacks: $2)"
    [ -f "$1" ] && sed 's/^/      /' "$1"
  fi
}

CURRENT=""
testcase() { CURRENT="$1"; printf '\n%s\n' "$1"; }
should_run() { [ -z "$FILTER" ] || [[ "$1" == *"$FILTER"* ]]; }

# ------------------------------------------------------------------ sandbox

# A sandbox is: an "upstream" git repo with two commits, a "live" checkout at
# the first one, and a mock bin directory earlier on PATH than the real tools.
# Sets SB, OLD_SHA and NEW_SHA in the CALLER's scope (a $(...) subshell would
# throw the shas away). The updater resolves its own ROOT from $BASH_SOURCE, so
# a copy of it has to live inside the sandbox checkout - running the repo's own
# copy would make it update this very repository.
new_sandbox() { # <name>
  local name="$1" sb="$WORK/$1"
  rm -rf "$sb"; mkdir -p "$sb/mock-bin" "$sb/mock-state"

  # --- upstream repository with an update to deploy
  local up="$sb/upstream"
  mkdir -p "$up"
  git -C "$up" init -q -b main
  git -C "$up" config user.email t@t; git -C "$up" config user.name t
  mkdir -p "$up/backend/src/db" "$up/frontend"
  cat > "$up/backend/package.json" <<'J'
{"name":"b","version":"1.0.0","private":true}
J
  cat > "$up/frontend/package.json" <<'J'
{"name":"f","version":"1.0.0","private":true,"scripts":{"build":"node build.js"}}
J
  # A "build" that just produces dist/index.html, so no npm/vite is needed.
  cat > "$up/frontend/build.js" <<'J'
const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<html>built</html>');
J
  echo 'console.log("migrated");' > "$up/backend/src/db/migrate.js"
  echo 'v1' > "$up/VERSION"
  mkdir -p "$up/scripts"
  cp "$UPDATER" "$up/scripts/auto-update.sh"
  chmod +x "$up/scripts/auto-update.sh"
  git -C "$up" add -A; git -C "$up" commit -qm "v1"
  OLD_SHA="$(git -C "$up" rev-parse HEAD)"
  echo 'v2' > "$up/VERSION"
  echo 'new file from the release' > "$up/NEWFILE"
  git -C "$up" add -A; git -C "$up" commit -qm "v2"
  NEW_SHA="$(git -C "$up" rev-parse HEAD)"

  # --- the live checkout, one commit behind
  local live="$sb/live"
  git clone -q "$up" "$live"
  git -C "$live" checkout -q "$OLD_SHA"
  git -C "$live" checkout -q -B main "$OLD_SHA"
  git -C "$live" config user.email t@t; git -C "$live" config user.name t
  mkdir -p "$live/data" "$live/frontend/dist" "$live/backend/data"
  echo "PORT=3999" > "$live/.env"
  echo '<html>old build</html>' > "$live/frontend/dist/index.html"
  printf 'sqlite-ish' > "$live/backend/data/repo.db"
  echo "DATABASE_PATH=./data/repo.db" >> "$live/.env"

  # --- mock state defaults
  echo "inactive"      > "$sb/mock-state/systemd-active"
  echo ""              > "$sb/mock-state/systemd-workdir"
  echo "0"             > "$sb/mock-state/systemctl-stop-rc"
  echo "0"             > "$sb/mock-state/systemctl-restart-rc"
  echo "stays-stopped" > "$sb/mock-state/systemd-after-stop"
  echo ""              > "$sb/mock-state/tmux-session"
  echo ""              > "$sb/mock-state/tmux-windows"
  echo "$OLD_SHA"      > "$sb/mock-state/serving-commit"
  echo "up"            > "$sb/mock-state/http"
  : > "$sb/mock-state/calls"

  write_mocks "$sb"
  SB="$sb"
}

write_mocks() { # <sandbox>
  local sb="$1" st="$1/mock-state"

  cat > "$sb/mock-bin/systemctl" <<EOF
#!/usr/bin/env bash
ST="$st"
echo "systemctl \$*" >> "\$ST/calls"
verb="\$1"; shift
case "\$verb" in
  is-active)
    [ "\$1" = "--quiet" ] && shift
    [ "\$(cat "\$ST/systemd-active")" = "active" ] && exit 0 || exit 3 ;;
  show)
    # systemctl show -p WorkingDirectory --value <unit>
    cat "\$ST/systemd-workdir"; exit 0 ;;
  stop)
    rc="\$(cat "\$ST/systemctl-stop-rc")"
    if [ "\$rc" = "0" ]; then
      if [ "\$(cat "\$ST/systemd-after-stop")" = "stays-active" ]; then
        echo active > "\$ST/systemd-active"
      else
        echo inactive > "\$ST/systemd-active"
        echo down > "\$ST/http"
      fi
    fi
    exit "\$rc" ;;
  restart|start)
    rc="\$(cat "\$ST/systemctl-restart-rc")"
    if [ "\$rc" = "0" ]; then
      echo active > "\$ST/systemd-active"
      echo up > "\$ST/http"
      # A real restart re-reads the checkout: the new process reports the
      # commit that is now on disk. That is the whole point of the fix.
      if [ -f "\$ST/pin-serving-commit" ]; then :; else
        git -C "$sb/live" rev-parse HEAD > "\$ST/serving-commit" 2>/dev/null || true
      fi
    fi
    exit "\$rc" ;;
  list-units) exit 0 ;;
  daemon-reload|enable) exit 0 ;;
esac
exit 0
EOF

  cat > "$sb/mock-bin/tmux" <<EOF
#!/usr/bin/env bash
ST="$st"
echo "tmux \$*" >> "\$ST/calls"
case "\$1" in
  has-session)
    want="\$3"
    [ -n "\$(cat "\$ST/tmux-session")" ] && [ "\$want" = "\$(cat "\$ST/tmux-session")" ] && exit 0
    exit 1 ;;
  list-windows)
    tr ' ' '\n' < "\$ST/tmux-windows"; exit 0 ;;
  send-keys)
    keys="\$*"
    case "\$keys" in
      *C-c*) echo down > "\$ST/http" ;;
      *node*|*index.js*)
        echo up > "\$ST/http"
        git -C "$sb/live" rev-parse HEAD > "\$ST/serving-commit" 2>/dev/null || true ;;
    esac
    exit 0 ;;
esac
exit 0
EOF

  # Health endpoint stand-in. Answers with the commit the "running process"
  # captured at start, which is what makes a stale process detectable.
  cat > "$sb/mock-bin/curl" <<EOF
#!/usr/bin/env bash
ST="$st"
echo "curl \$*" >> "\$ST/calls"
[ "\$(cat "\$ST/http")" = "up" ] || exit 7
c="\$(cat "\$ST/serving-commit")"
printf '{"status":"ok","service":"espress0'"'"'s repo","version":"1.0.0","commit":"%s","commitShort":"%s"}' "\$c" "\${c:0:7}"
exit 0
EOF

  # Keep wget out of the picture so only the curl stub is used.
  cat > "$sb/mock-bin/wget" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

  # npm: only 'run build' and 'install/ci' are ever invoked here.
  cat > "$sb/mock-bin/npm" <<EOF
#!/usr/bin/env bash
ST="$st"
echo "npm \$*" >> "\$ST/calls"
if [ "\$1" = "run" ] && [ "\$2" = "build" ]; then
  mkdir -p dist && echo '<html>built</html>' > dist/index.html
fi
exit 0
EOF

  chmod +x "$sb/mock-bin/"*
}

# Run the updater inside a sandbox with the mocks on PATH.
run_updater() { # <sandbox> [args...]
  local sb="$1"; shift
  ( cd "$sb/live" \
    && PATH="$sb/mock-bin:$PATH" \
       TMUX_SESSION_NAME=espress0 \
       HOME="$sb" \
       timeout 120 bash "$sb/live/scripts/auto-update.sh" --once --health-url "http://127.0.0.1:3999/api/health" "$@" \
  ) > "$sb/out.log" 2>&1
  echo $? > "$sb/rc"
}

live_sha()    { git -C "$1/live" rev-parse HEAD; }
state_file()  { echo "$1/live/data/.auto-update-status"; }

# ================================================================== the tests

# --- 1. detection ------------------------------------------------------------
if should_run "detects espress0-repo"; then
testcase "bare update detects the standard espress0-repo systemd unit"
  new_sandbox detect-systemd
  echo active            > "$SB/mock-state/systemd-active"
  echo "$SB/live"        > "$SB/mock-state/systemd-workdir"
  run_updater "$SB"
  assert_contains "$SB/out.log" "restart target: systemd unit 'espress0-repo' (detected" \
    "auto-detects espress0-repo when it is active and its WorkingDirectory matches"
  assert_contains "$SB/out.log" "stopping systemd service: espress0-repo" \
    "stops the detected unit"
  assert_eq "$(live_sha "$SB")" "$NEW_SHA" "the checkout advanced to the new commit"
  assert_contains "$SB/out.log" "the serving process runs" "confirms the serving process, not just the port"
fi

if should_run "WorkingDirectory of another deployment"; then
testcase "an active unit for a DIFFERENT checkout is not adopted"
  new_sandbox detect-other-dir
  echo active                 > "$SB/mock-state/systemd-active"
  echo "/opt/some-other-copy" > "$SB/mock-state/systemd-workdir"
  run_updater "$SB"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" \
    "refuses when the only active unit belongs to another deployment"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "the checkout was left alone"
fi

if should_run "backend workdir"; then
testcase "a unit whose WorkingDirectory is <root>/backend is recognised"
  new_sandbox detect-backend-dir
  echo active              > "$SB/mock-state/systemd-active"
  echo "$SB/live/backend"  > "$SB/mock-state/systemd-workdir"
  run_updater "$SB"
  assert_contains "$SB/out.log" "restart target: systemd unit" \
    "the shipped unit layout (WorkingDirectory=<root>/backend) is detected"
fi

if should_run "tmux detection"; then
testcase "falls back to an espress0 tmux session with an app window"
  new_sandbox detect-tmux
  echo espress0 > "$SB/mock-state/tmux-session"
  echo "app updater" > "$SB/mock-state/tmux-windows"
  run_updater "$SB"
  assert_contains "$SB/out.log" "restart target: tmux session 'espress0' (detected)" \
    "detects the tmux session started by ./espress0 serve"
  assert_contains "$SB/out.log" "stopping tmux window: app" "stops the app window"
  assert_eq "$(live_sha "$SB")" "$NEW_SHA" "deployed under tmux supervision"
fi

if should_run "tmux without an app window"; then
testcase "a tmux session with only an updater window is not a restart target"
  new_sandbox detect-tmux-noapp
  echo espress0    > "$SB/mock-state/tmux-session"
  echo "updater"   > "$SB/mock-state/tmux-windows"
  run_updater "$SB"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" \
    "an updater-only session cannot restart the app, so it is refused"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "nothing was deployed"
fi

# --- 2. explicit overrides ---------------------------------------------------
if should_run "explicit overrides detection"; then
testcase "explicit --service overrides detection"
  new_sandbox explicit-service
  echo active       > "$SB/mock-state/systemd-active"
  echo "$SB/live"   > "$SB/mock-state/systemd-workdir"
  echo espress0     > "$SB/mock-state/tmux-session"
  echo "app"        > "$SB/mock-state/tmux-windows"
  run_updater "$SB" --service my-custom-unit
  assert_contains "$SB/out.log" "restart target: systemd unit 'my-custom-unit' (explicit)" \
    "--service wins over both detected targets"
  assert_contains "$SB/out.log" "stopping systemd service: my-custom-unit" "stops the named unit"
fi

if should_run "explicit stop/start commands"; then
testcase "explicit --stop-cmd/--start-cmd override detection"
  new_sandbox explicit-cmd
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  run_updater "$SB" \
    --stop-cmd "echo down > '$SB/mock-state/http'" \
    --start-cmd "echo up > '$SB/mock-state/http'; git -C '$SB/live' rev-parse HEAD > '$SB/mock-state/serving-commit'"
  assert_contains "$SB/out.log" "restart target: custom stop/start commands" "custom commands win"
  assert_eq "$(live_sha "$SB")" "$NEW_SHA" "deployed via the custom supervisor"
fi

if should_run "half a command pair"; then
testcase "--stop-cmd without --start-cmd is refused"
  new_sandbox half-cmd
  run_updater "$SB" --stop-cmd "true"
  assert_contains "$SB/out.log" "must be given together" "refuses an unrunnable half-configuration"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "nothing deployed"
fi

# --- 3. no supervisor: the original bug --------------------------------------
if should_run "no supervisor aborts"; then
testcase "no supervisor aborts BEFORE the file swap and the migration"
  new_sandbox no-supervisor
  # Nothing active, no tmux - exactly the state that produced the false positive.
  run_updater "$SB"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" "the update refuses to proceed"
  assert_contains "$SB/out.log" "No manageable application process found" "and says why"
  assert_contains "$SB/out.log" "--no-restart" "and points at the deliberate-offline escape hatch"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "HEAD did NOT move"
  assert_not_contains "$SB/out.log" "migrated" "migrations never ran"
  [ -f "$SB/live/NEWFILE" ] && bad "the new release's files were swapped in anyway" \
                            || ok "the live tree was never swapped"
  assert_contains "$SB/live/frontend/dist/index.html" "old build" "the old frontend build is intact"
  assert_file_contains "$(state_file "$SB")" '"state":"refused"' "status file records the refusal"
  assert_file_contains "$(state_file "$SB")" '"stopped":"unknown"' "status file shows the stop never happened"
fi

if should_run "old process false positive"; then
testcase "the old bug cannot recur: a healthy old process does not mark success"
  new_sandbox stale-process
  # A process IS answering, healthily - but it is the old release, and no
  # supervisor is configured to replace it.
  echo up        > "$SB/mock-state/http"
  echo "$OLD_SHA" > "$SB/mock-state/serving-commit"
  run_updater "$SB"
  assert_not_contains "$SB/out.log" "Updated to" "a healthy OLD process must not be reported as an update"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" "it refuses instead"
fi

# --- 4. stop failures --------------------------------------------------------
if should_run "stop denied"; then
testcase "a denied systemctl stop aborts safely"
  new_sandbox stop-denied
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  echo 1          > "$SB/mock-state/systemctl-stop-rc"
  run_updater "$SB"
  assert_contains "$SB/out.log" "could not stop espress0-repo" "reports the denial"
  assert_contains "$SB/out.log" "sudoers.d/espress0-updater" "prints the exact sudoers fix"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" "and refuses to deploy"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "HEAD did not move"
  [ -f "$SB/live/NEWFILE" ] && bad "files were swapped despite the failed stop" \
                            || ok "no files were swapped"
fi

if should_run "service stays active"; then
testcase "a service that stays active after stop aborts safely"
  new_sandbox stop-ineffective
  echo active        > "$SB/mock-state/systemd-active"
  echo "$SB/live"    > "$SB/mock-state/systemd-workdir"
  echo "stays-active" > "$SB/mock-state/systemd-after-stop"
  run_updater "$SB"
  assert_contains "$SB/out.log" "STILL active" "notices the unit did not actually go down"
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" "and refuses"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "HEAD did not move"
fi

# --- 5. commit verification --------------------------------------------------
if should_run "wrong commit rejected"; then
testcase "a healthy process on the WRONG commit fails verification and rolls back"
  new_sandbox wrong-commit
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  # Pin the reported commit: the restart "succeeds" but the process keeps
  # serving the old release, which is the false positive being tested.
  touch "$SB/mock-state/pin-serving-commit"
  echo "$OLD_SHA" > "$SB/mock-state/serving-commit"
  run_updater "$SB"
  assert_contains "$SB/out.log" "expected ${NEW_SHA:0:7}" "notices the served commit is not the deployed one"
  assert_contains "$SB/out.log" "rolling back" "rolls the deployment back"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "the checkout is back on the previous commit"
  assert_file_contains "$(state_file "$SB")" '"state":"failed"' "reported as failed, not updated"
fi

if should_run "no commit field"; then
testcase "a health endpoint with no commit field is not accepted as proof"
  new_sandbox no-commit-field
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  touch "$SB/mock-state/pin-serving-commit"
  echo "" > "$SB/mock-state/serving-commit"
  run_updater "$SB"
  assert_contains "$SB/out.log" "reports no commit" "an old health endpoint cannot silently pass"
  assert_file_contains "$(state_file "$SB")" '"state":"failed"' "the deploy is not called a success"
fi

if should_run "successful restart reports"; then
testcase "a successful restart reports the expected commit"
  new_sandbox success
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  run_updater "$SB"
  assert_eq "$(cat "$SB/rc")" "0" "the updater exits 0"
  assert_contains "$SB/out.log" "verified: the process serving" "verification is explicit"
  assert_eq "$(live_sha "$SB")" "$NEW_SHA" "HEAD is on the new commit"
  assert_file_contains "$(state_file "$SB")" '"state":"updated"' "status says updated"
  assert_file_contains "$(state_file "$SB")" "\"expectedCommit\":\"$NEW_SHA\"" "status records the expected commit"
  assert_file_contains "$(state_file "$SB")" "\"runningCommit\":\"$NEW_SHA\"" "status records the running commit"
  assert_file_contains "$(state_file "$SB")" '"supervisor":"systemd"' "status records the supervisor"
  assert_file_contains "$(state_file "$SB")" '"verified":"ok"' "status records the verification"
fi

# --- 6. rollback, including the database -------------------------------------
if should_run "failed startup restores"; then
testcase "a failed start restores the previous source, build and database"
  new_sandbox failed-start
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  # The stop works; the restart does not.
  echo 1          > "$SB/mock-state/systemctl-restart-rc"
  # A migration that mutates the live database, so the rollback has something
  # to undo.
  cat > "$SB/upstream/backend/src/db/migrate.js" <<'J'
const fs=require('fs');fs.writeFileSync(process.env.DATABASE_PATH||'./data/repo.db','MIGRATED-BY-NEW-RELEASE');
J
  git -C "$SB/upstream" add -A; git -C "$SB/upstream" commit -qm "v2 with migration"
  NEW_SHA2="$(git -C "$SB/upstream" rev-parse HEAD)"

  run_updater "$SB"
  assert_contains "$SB/out.log" "rolling back" "rolls back after the failed start"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "source is back on the previous commit"
  assert_contains "$SB/live/frontend/dist/index.html" "old build" "the previous frontend build is restored"
  assert_eq "$(cat "$SB/live/backend/data/repo.db")" "sqlite-ish" \
    "the pre-update database is restored (forward-only migration undone)"
  [ -f "$SB/live/NEWFILE" ] && bad "a file added by the failed release survived the rollback" \
                            || ok "files added by the failed release were removed"
fi

if should_run "database snapshot taken"; then
testcase "the database is snapshotted before live migrations run"
  new_sandbox db-snapshot
  echo active     > "$SB/mock-state/systemd-active"
  echo "$SB/live" > "$SB/mock-state/systemd-workdir"
  run_updater "$SB"
  assert_contains "$SB/out.log" "snapshotted the database" "a snapshot is taken every deploy"
  [ -f "$SB/live/.auto-update/prev-db/repo.db" ] && ok "the snapshot file exists on disk" \
                                                 || bad "no snapshot file was written"
fi

# --- 7. --no-restart ---------------------------------------------------------
if should_run "no-restart"; then
testcase "--no-restart is required for a deliberately unmanaged update"
  new_sandbox no-restart
  run_updater "$SB" --no-restart
  assert_contains "$SB/out.log" "without restarting anything" "the offline path is taken explicitly"
  assert_eq "$(live_sha "$SB")" "$NEW_SHA" "files are deployed"
  assert_file_contains "$(state_file "$SB")" '"state":"deployed-not-restarted"' \
    "the state makes it unambiguous that the running process is stale"
  assert_not_contains "$SB/out.log" "verified: the process serving" \
    "it must NOT claim the new code is being served"
fi

# --- 8. pull mode ------------------------------------------------------------
if should_run "pull mode"; then
testcase "--mode pull obeys the same rule"
  new_sandbox pull-no-target
  run_updater "$SB" --mode pull
  assert_contains "$SB/out.log" "REFUSING TO DEPLOY" "pull mode refuses without a restart target"
  assert_eq "$(live_sha "$SB")" "$OLD_SHA" "the checkout was not fast-forwarded"

  new_sandbox pull-ok; SB2="$SB"
  echo active      > "$SB2/mock-state/systemd-active"
  echo "$SB2/live" > "$SB2/mock-state/systemd-workdir"
  run_updater "$SB2" --mode pull
  assert_eq "$(live_sha "$SB2")" "$NEW_SHA" "pull mode deploys when a target exists"
  assert_contains "$SB2/out.log" "verified: the process serving" "and verifies the commit"
fi

# --- 9. unit generation for home-directory installs --------------------------
if should_run "home-directory installs"; then
testcase "the updater unit is generated from the real installation directory"
  new_sandbox unit-paths
  INSTALL="/home/espress0/espress0s_repo"
  OUT="$WORK/unit-out.service"
  # Same generation the deploy script performs, exercised directly.
  sed -e "s|/opt/espress0s-repo|$INSTALL|g" \
      -e "s|^User=.*|User=espress0|" \
      -e "s|^Group=.*|Group=espress0|" \
      "$REPO_ROOT/systemd/espress0-repo-updater.service" > "$OUT"
  assert_contains "$OUT" "WorkingDirectory=$INSTALL" "WorkingDirectory points at the real checkout"
  assert_contains "$OUT" "ExecStart=$INSTALL/scripts/auto-update.sh" "ExecStart uses the real path"
  assert_not_contains "$OUT" "/opt/espress0s-repo" "no hardcoded /opt path survives"
fi

# --- 10. deploy integration --------------------------------------------------
if should_run "deploy enables auto-update"; then
testcase "deploy installs the updater by default and --no-auto-update opts out"
  assert_contains "$DEPLOY" "--no-auto-update" "deploy accepts --no-auto-update"
  assert_contains "$DEPLOY" "install_auto_updater" "deploy has an updater installation step"
  assert_contains "$DEPLOY" "visudo -cf" "the sudoers rule is validated before installation"
  # The generated sudoers rule must be narrow: three verbs, one unit.
  assert_contains "$DEPLOY" "NOPASSWD" "the sudoers rule is passwordless for the updater only"
  grep -q 'AUTO_UPDATE=1' "$DEPLOY" && ok "auto-update defaults to on" \
                                    || bad "auto-update does not default to on"
fi

if should_run "help documents"; then
testcase "the documented contract is present in --help"
  HELP="$WORK/help.txt"
  bash "$UPDATER" --help > "$HELP" 2>&1
  assert_contains "$HELP" "NO VERIFIED RESTART TARGET, NO LIVE DEPLOYMENT" "the rule is documented"
  assert_contains "$HELP" "--no-restart" "the escape hatch is documented"
  assert_not_contains "$HELP" "set -uo pipefail" "the help does not leak shell code"
fi

# --- 11. deploy --update cannot die mid-update on the re-exec ----------------
#
# The bug: re-running the just-pulled script built its path as
# "$ROOT_DIR/${BASH_SOURCE[0]}". Invoked via an absolute path that becomes
# ROOT + absolute => "bash: /home/.../espress0s_repo//home/.../scripts/
# deploy-ubuntu.sh: No such file or directory", and the update aborted AFTER
# the git sync but BEFORE npm install / vite build / systemctl restart ever
# ran - the exact halfway state that left sites on the boot screen.
if should_run "deploy re-exec"; then
testcase "deploy --update re-execs via an absolute path that always exists"
  assert_not_contains "$DEPLOY" 'exec bash "$ROOT_DIR/${BASH_SOURCE[0]}"' \
    "the re-exec no longer builds ROOT + possibly-absolute invocation path"
  assert_contains "$DEPLOY" 'exec bash "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"' \
    "the re-exec resolves the script from SCRIPT_DIR (absolute by construction)"
  assert_contains "$DEPLOY" '--port "$INTERNAL_PORT"' \
    "the resumed run pins the internal listener, not the public port"
fi

# --- 12. deploy --update finishes by proving what runs, not by hoping --------
#
# A failed 'systemctl restart' used to be a mere warn, after which the script
# still printed "Update complete" while the old process kept serving (or
# nothing served at all).
if should_run "deploy verifies"; then
testcase "deploy --update dies loudly when the new release is not what answers"
  assert_contains "$DEPLOY" "verify_running_commit" \
    "the update verifies the commit the RUNNING process reports"
  assert_not_contains "$DEPLOY" "systemctl restart' failed (is systemd running?). Try: sudo systemctl start" \
    "a failed restart in the update path is no longer a shrug"
  assert_not_contains "$DEPLOY" 'start_and_verify || warn "Update applied, but the site is not answering' \
    "the resumed run no longer prints 'Update complete' over an unanswering site"
fi

# --- 13. the backend never serves index.html where a file should be ----------
#
# The boot-screen mechanism at the HTTP layer: with wildcard:false the asset
# route set was frozen at process start, and the SPA fallback answered
# /assets/<old-hash>.js with index.html itself - which browsers refuse to
# execute as a module, leaving #boot on screen forever.
if should_run "static serving"; then
testcase "static assets resolve on disk per request and missing files 404 honestly"
  INDEXJS="$REPO_ROOT/backend/src/index.js"
  assert_not_contains "$INDEXJS" "wildcard: false," \
    "static routes are not frozen at process start (assets resolve per request)"
  assert_contains "$INDEXJS" "lastSegment.includes('.')" \
    "file-shaped URLs (stale hashed assets) get an honest 404, not index.html"
  assert_contains "$INDEXJS" "imageProxyRoutes" \
    "the cookieless image proxy route is registered"
fi

# --- 14. the frontend build cannot gut dist/ under a live site ---------------
#
# The second half of the 918ecff incident: `vite build` empties dist/ BEFORE
# writing, so the lucide-react build failure (and any box that dies mid-build
# - theirs was so loaded SSH stopped answering) leaves the running site with
# no working build at all. The deploy must build beside dist/ and swap only
# the COMPLETED result into place.
if should_run "atomic frontend build"; then
testcase "deploy builds the frontend in a staging dir and swaps only a complete build"
  assert_contains "$DEPLOY" "build_frontend_safely" "deploy uses a build-staging helper"
  assert_contains "$DEPLOY" "--outDir .dist-stage" "vite builds into .dist-stage, not dist"
  assert_contains "$DEPLOY" 'mv "$stage" frontend/dist' "only a finished build lands in dist"
  assert_contains "$DEPLOY" "the previous build is STILL in place and serving" \
    "a failed update build leaves the old build serving (and says so)"
fi

# ===================================================================== summary
printf '\n────────────────────────────────────────\n'
printf '%s%d passed%s, %s%d failed%s\n' "$GRN" "$PASS" "$RST" \
  "$([ "$FAIL" -gt 0 ] && echo "$RED" || echo "")" "$FAIL" "$RST"
if [ "$FAIL" -gt 0 ]; then
  printf '\nFailed:\n'
  printf '  - %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
exit 0
