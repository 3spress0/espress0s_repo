#!/usr/bin/env bash
# Append one fixed host-maintenance event for the admin Operations timeline.
#
# This can run as root from the reboot unit or as the unprivileged app user.
# Events are observability only: failure to write one must never prevent a
# reboot or a clean shutdown.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
EVENT_FILE="$DATA_DIR/.operations-events.jsonl"
EVENT_TYPE="${1:-}"

case "$EVENT_TYPE" in
  scheduled-reboot-starting)
    MESSAGE='Scheduled reboot started; stopping the updater and application before host shutdown.'
    ;;
  auto-update-starting)
    MESSAGE='Automatic update started; the release will be staged and health-verified.'
    ;;
  *)
    # Do not accept caller-controlled event text into an admin audit feed.
    exit 64
    ;;
esac

mkdir -p "$DATA_DIR" 2>/dev/null || exit 0
# The app process appends its own started/stopping events. A root-run reboot
# unit may create this file first, so return ownership to the data directory's
# owner after writing; the timeline contains operational facts, not secrets.
if [ "$(id -u)" -eq 0 ]; then
  DATA_OWNER="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || true)"
else
  DATA_OWNER=""
fi

umask 027
printf '{"at":"%s","type":"%s","message":"%s","source":"systemd"}\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$EVENT_TYPE" "$MESSAGE" >> "$EVENT_FILE" 2>/dev/null || exit 0
[ -z "$DATA_OWNER" ] || chown "$DATA_OWNER" "$EVENT_FILE" 2>/dev/null || true
chmod 640 "$EVENT_FILE" 2>/dev/null || true
