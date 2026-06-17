#!/usr/bin/env bash
# Rename the project folder DuoCLI -> posse WITHOUT breaking Claude session history.
#
# WHY a script (not done live): the folder is the cwd of running processes (the
# Posse app, the pty-daemon, any Claude session running inside it) and Claude
# stores session history keyed to the absolute cwd. Renaming live would break
# the running app AND orphan every past session. This script must run when:
#   1. Posse is fully quit (Cmd+Q), and
#   2. you are NOT inside the folder (run it from your home dir), and
#   3. no Claude session is running in that folder.
#
# It migrates Claude's per-project session dir + rewrites the cwd inside every
# jsonl, plus Posse's closed-sessions store, so resume still works afterward.
#
# Usage:   bash ~/Desktop/rename-to-posse.sh          (copy it out of the repo first)
# Dry run: DRY=1 bash rename-to-posse.sh

set -euo pipefail

OLD="/Users/clarezoe/My Apps/DuoCLI"
NEW="/Users/clarezoe/My Apps/posse"
OLD_ENC="-Users-clarezoe-My-Apps-DuoCLI"
NEW_ENC="-Users-clarezoe-My-Apps-posse"
CLAUDE_PROJ="$HOME/.claude/projects"
CLOSED="$HOME/Library/Application Support/posse/closed-sessions.json"
BACKUP="$HOME/posse-rename-backup-$(date +%Y%m%d-%H%M%S)"
DRY="${DRY:-0}"

run() { echo "+ $*"; [ "$DRY" = "1" ] || "$@"; }

# --- guards ---
if pgrep -f "Posse.app/Contents/MacOS/Posse" >/dev/null 2>&1; then
  echo "ABORT: Posse is running. Quit it (Cmd+Q) first."; exit 1
fi
if pgrep -f "pty-daemon.js" >/dev/null 2>&1; then
  echo "ABORT: pty-daemon is running. Quit Posse fully first."; exit 1
fi
case "$PWD/" in "$OLD"/*) echo "ABORT: run this from OUTSIDE $OLD (e.g. cd ~)"; exit 1;; esac
[ -d "$OLD" ] || { echo "ABORT: $OLD not found (already renamed?)"; exit 1; }
[ -e "$NEW" ] && { echo "ABORT: $NEW already exists"; exit 1; }

echo "=== backup Claude history + closed-sessions to $BACKUP ==="
run mkdir -p "$BACKUP"
[ -d "$CLAUDE_PROJ/$OLD_ENC" ] && run cp -R "$CLAUDE_PROJ/$OLD_ENC" "$BACKUP/claude-$OLD_ENC"
[ -f "$CLOSED" ] && run cp "$CLOSED" "$BACKUP/closed-sessions.json"

echo "=== 1. rename the repo folder ==="
run mv "$OLD" "$NEW"

echo "=== 2. migrate Claude session dir + rewrite cwd in each jsonl ==="
if [ -d "$CLAUDE_PROJ/$OLD_ENC" ]; then
  run mkdir -p "$CLAUDE_PROJ/$NEW_ENC"
  if [ "$DRY" = "1" ]; then
    echo "+ (dry) would rewrite cwd '$OLD' -> '$NEW' in $CLAUDE_PROJ/$OLD_ENC/*.jsonl and move into $NEW_ENC"
  else
    # rewrite the absolute cwd string inside every jsonl, then move files over
    find "$CLAUDE_PROJ/$OLD_ENC" -maxdepth 1 -name '*.jsonl' -print0 | while IFS= read -r -d '' f; do
      LC_ALL=C sed -i '' "s#$OLD#$NEW#g" "$f"
    done
    # move everything (jsonl + sidecar dirs) into the new encoded dir
    (shopt -s dotglob nullglob; mv "$CLAUDE_PROJ/$OLD_ENC"/* "$CLAUDE_PROJ/$NEW_ENC"/ 2>/dev/null || true)
    rmdir "$CLAUDE_PROJ/$OLD_ENC" 2>/dev/null || true
  fi
else
  echo "  (no Claude history dir for old path — nothing to migrate)"
fi

echo "=== 3. rewrite cwd in Posse closed-sessions.json ==="
if [ -f "$CLOSED" ]; then
  if [ "$DRY" = "1" ]; then echo "+ (dry) would rewrite cwd in $CLOSED";
  else LC_ALL=C sed -i '' "s#$OLD#$NEW#g" "$CLOSED"; fi
fi

echo ""
echo "DONE. New folder: $NEW"
echo "Backup kept at:   $BACKUP   (delete once you've verified sessions resume)"
echo "Next: cd \"$NEW\" && open the app; old sessions should appear + resume normally."
