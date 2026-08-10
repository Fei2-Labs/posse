#!/usr/bin/env bash
# Copy the freshly built Posse.app over /Applications/Posse.app so the installed
# app is always the latest build. Safe to run while the old app is running:
# macOS keeps the running process (and its pty-daemon child) on the old on-disk
# files, so we do NOT kill anything — the next launch picks up the new bundle.
set -euo pipefail

SRC="release/mac-arm64/Posse.app"
DEST="/Applications/Posse.app"

if [ ! -d "$SRC" ]; then
  echo "[install] $SRC not found — run the mac build first" >&2
  exit 1
fi

echo "[install] replacing $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

VER="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "[install] $DEST is now version $VER"

# Install the Posse CLI without launching another Node/Chrome runtime. Electron runs the
# bundled CLI in Node mode, while ChatGPT work remains inside the already-running app.
CLI_DIR="$HOME/.local/bin"
CLI_PATH="$CLI_DIR/posse"
CLI_MARKER="# managed by Posse installer"
mkdir -p "$CLI_DIR"
if [ -e "$CLI_PATH" ] && ! grep -qF "$CLI_MARKER" "$CLI_PATH" 2>/dev/null; then
  echo "[install] preserving existing non-Posse command: $CLI_PATH" >&2
else
  cat > "$CLI_PATH" <<'SH'
#!/usr/bin/env bash
# managed by Posse installer
set -euo pipefail
APP="/Applications/Posse.app"
EXEC="$APP/Contents/MacOS/Posse"
CLI="$APP/Contents/Resources/app.asar/dist/cli/posse.js"
if [ ! -x "$EXEC" ] || [ ! -f "$CLI" ]; then
  echo "Posse CLI unavailable. Reinstall /Applications/Posse.app." >&2
  exit 3
fi
ELECTRON_RUN_AS_NODE=1 exec "$EXEC" "$CLI" "$@"
SH
  chmod 0755 "$CLI_PATH"
  echo "[install] CLI installed: $CLI_PATH"
fi
