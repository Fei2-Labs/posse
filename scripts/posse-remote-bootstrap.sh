#!/usr/bin/env bash
#
# posse-remote-bootstrap.sh — deploy + start the headless Posse backend on a remote SSH host.
#
# Reproduces the manually-verified recipe (Mac mini `mymini`): detect the remote arch,
# install a private Node runtime without sudo, rsync a versioned backend bundle, install
# runtime deps, fix the node-pty spawn-helper exec bit, then start the headless backend
# DETACHED + idempotent and report its connect URL + token.
#
# Usage:  posse-remote-bootstrap.sh <ssh-host> [version] [source-dir]
#   <ssh-host>    a Host from ~/.ssh/config (or user@host). Used verbatim with ssh/scp/rsync.
#   [version]     backend version dir under ~/.posse-agent/<version>/. Default: derive-version.js.
#   [source-dir]  local dir to rsync from (must contain dist/, mobile/client/, package*.json).
#                 Default: <repo>/release/remote-bundle.
#
# Idempotent: re-runnable. Reuses an already-running backend for this version (coexist — it
# may hold live 24/7 sessions, so we NEVER restart it). Re-syncs changed files, re-chmods.
#
# Output contract:
#   - ALL human-readable progress goes to STDERR.
#   - STDOUT emits EXACTLY two machine-parseable lines on success:
#       POSSE_REMOTE_URL=http://<ip>:<port>
#       POSSE_REMOTE_TOKEN=<token>
#
set -euo pipefail

# ---- config ---------------------------------------------------------------
NODE_VERSION="v22.14.0"
# Single fixed port for now. Coexisting versions during an upgrade would each need a
# distinct port; the plan is to derive it (e.g. 9800 + hash(version) % 100) so the new
# version starts alongside the draining old one. Kept fixed at 9800 here for simplicity —
# the headless backend reads POSSE_REMOTE_PORT, so changing this is the only edit needed.
REMOTE_PORT="9800"
AGENT_ROOT="~/.posse-agent" # expanded on the remote (leave as literal ~ for ssh)

# ---- args -----------------------------------------------------------------
log() { echo "[bootstrap] $*" >&2; }
die() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }

HOST="${1:-}"
[ -n "$HOST" ] || die "usage: posse-remote-bootstrap.sh <ssh-host> [version] [source-dir]"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${2:-}"
if [ -z "$VERSION" ]; then
  if [ -f "$REPO_DIR/scripts/derive-version.js" ] && command -v node >/dev/null 2>&1; then
    VERSION="$(node "$REPO_DIR/scripts/derive-version.js")"
  fi
fi
[ -n "$VERSION" ] || die "could not determine version (pass it as arg 2)"

SOURCE_DIR="${3:-$REPO_DIR/release/remote-bundle}"
[ -d "$SOURCE_DIR" ] || die "source dir not found: $SOURCE_DIR (run: npm run build:remote-bundle)"
[ -d "$SOURCE_DIR/dist" ] || die "source dir missing dist/: $SOURCE_DIR"
[ -d "$SOURCE_DIR/mobile/client" ] || die "source dir missing mobile/client/: $SOURCE_DIR"
[ -f "$SOURCE_DIR/package.json" ] || die "source dir missing package.json: $SOURCE_DIR"

VER_DIR="$AGENT_ROOT/$VERSION"

log "host=$HOST version=$VERSION source=$SOURCE_DIR port=$REMOTE_PORT"

# A reused ControlMaster connection keeps every ssh/scp/rsync hop on one TCP/auth session.
SSH_CTL="/tmp/posse-bootstrap-%r@%h:%p"
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=$SSH_CTL" -o "ControlPersist=60s")
ssh_run() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# ---- step 1: detect remote arch ------------------------------------------
log "step 1/7: detecting remote platform…"
UNAME="$(ssh_run 'uname -sm')" || die "ssh to $HOST failed (check ~/.ssh/config + host key)"
OS="$(echo "$UNAME" | awk '{print $1}')"
MACH="$(echo "$UNAME" | awk '{print $2}')"

case "$OS-$MACH" in
  Darwin-arm64)            TRIPLE="darwin-arm64" ;;
  Darwin-x86_64)           TRIPLE="darwin-x64" ;;
  Linux-aarch64|Linux-arm64) TRIPLE="linux-arm64" ;;
  Linux-x86_64)            TRIPLE="linux-x64" ;;
  *) die "unsupported remote platform: $UNAME" ;;
esac
log "  remote: $OS $MACH -> node triple $TRIPLE"

# ---- step 2: ensure private Node (no sudo) -------------------------------
log "step 2/7: ensuring Node $NODE_VERSION on remote (no sudo)…"
# .tar.gz exists for every platform; prefer it over .tar.xz (Linux-only convenience).
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$TRIPLE.tar.gz"
ssh_run "bash -seuo pipefail" <<EOF || die "node install failed"
set -euo pipefail
AGENT="\$HOME/.posse-agent"
if [ -x "\$AGENT/node/bin/node" ]; then
  echo "[remote] node already present: \$("\$AGENT/node/bin/node" -v)" >&2
else
  echo "[remote] downloading $NODE_URL" >&2
  mkdir -p "\$AGENT/node"
  curl -fsSL "$NODE_URL" -o /tmp/posse-node.tgz
  tar -xzf /tmp/posse-node.tgz -C "\$AGENT/node" --strip-components=1
  rm -f /tmp/posse-node.tgz
  echo "[remote] installed node \$("\$AGENT/node/bin/node" -v)" >&2
fi
EOF

# ---- step 3: rsync the versioned backend bundle --------------------------
log "step 3/7: syncing backend bundle to $VER_DIR …"
ssh_run "mkdir -p \"\$HOME/.posse-agent/$VERSION/mobile\""
RSYNC_RSH="ssh ${SSH_OPTS[*]}"
# Trailing slashes on sources matter: copy the *contents* into the versioned dir.
rsync -az --delete -e "$RSYNC_RSH" "$SOURCE_DIR/dist/" "$HOST:.posse-agent/$VERSION/dist/"
rsync -az --delete -e "$RSYNC_RSH" "$SOURCE_DIR/mobile/client/" "$HOST:.posse-agent/$VERSION/mobile/client/"
rsync -az -e "$RSYNC_RSH" "$SOURCE_DIR/package.json" "$HOST:.posse-agent/$VERSION/package.json"
if [ -f "$SOURCE_DIR/package-lock.json" ]; then
  rsync -az -e "$RSYNC_RSH" "$SOURCE_DIR/package-lock.json" "$HOST:.posse-agent/$VERSION/package-lock.json"
fi

# ---- step 4: install runtime deps (builds native modules for remote node) -
log "step 4/7: installing runtime deps on remote…"
ssh_run "bash -seuo pipefail" <<EOF || die "npm install failed on remote"
set -euo pipefail
export PATH="\$HOME/.posse-agent/node/bin:\$PATH"
cd "\$HOME/.posse-agent/$VERSION"
npm install --omit=dev --no-audit --no-fund
EOF

# ---- step 5: fix node-pty spawn-helper exec bit --------------------------
# node-pty 1.x prebuilds can land without +x on spawn-helper -> posix_spawnp failed on every
# session create. Always re-chmod (guard: only if it exists). See project memory.
log "step 5/7: fixing node-pty spawn-helper exec bit…"
ssh_run "bash -seuo pipefail" <<EOF
set -euo pipefail
HELPER="\$HOME/.posse-agent/$VERSION/node_modules/node-pty/prebuilds/$TRIPLE/spawn-helper"
if [ -f "\$HELPER" ]; then
  chmod +x "\$HELPER"
  echo "[remote] chmod +x \$HELPER" >&2
else
  echo "[remote] spawn-helper not found at \$HELPER (skipping)" >&2
fi
EOF

# ---- step 6: start headless backend DETACHED + idempotent ----------------
log "step 6/7: starting headless backend (idempotent, coexist-safe)…"
ssh_run "bash -seuo pipefail" <<EOF || die "failed to start headless backend"
set -euo pipefail
export PATH="\$HOME/.posse-agent/node/bin:\$PATH"
DIR="\$HOME/.posse-agent/$VERSION"
cd "\$DIR"
PIDFILE="\$DIR/headless.pid"
# Reuse a live backend for this version — it may hold 24/7 sessions; never restart it.
if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "[remote] backend already running (pid \$(cat "\$PIDFILE")), reusing" >&2
else
  echo "[remote] starting headless backend on port $REMOTE_PORT" >&2
  : > headless.log
  POSSE_REMOTE_PORT=$REMOTE_PORT nohup node dist/main/headless.js > headless.log 2>&1 &
  echo \$! > "\$PIDFILE"
  echo "[remote] started pid \$(cat "\$PIDFILE")" >&2
fi
EOF

# ---- step 7: read connect info (token + URL host) ------------------------
log "step 7/7: reading connect info…"
# The headless log prints "Token: <token>". Poll briefly in case it just started.
TOKEN=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  TOKEN="$(ssh_run "grep -m1 'Token:' \"\$HOME/.posse-agent/$VERSION/headless.log\" 2>/dev/null | sed 's/.*Token: *//' | tr -d '\r'" || true)"
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || die "could not read token from remote headless.log (backend may have failed; check ~/.posse-agent/$VERSION/headless.log on $HOST)"

# Prefer the remote's Tailscale IP (reachable over WireGuard E2E); fall back to LAN IP / HostName.
IP="$(ssh_run "bash -s" <<'EOF' || true
set -uo pipefail
ts=""
if [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  ts="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null | head -n1)"
elif command -v tailscale >/dev/null 2>&1; then
  ts="$(tailscale ip -4 2>/dev/null | head -n1)"
fi
if [ -n "$ts" ]; then echo "$ts"; exit 0; fi
# Fall back to a LAN address.
if command -v ipconfig >/dev/null 2>&1; then
  ipconfig getifaddr en0 2>/dev/null && exit 0
fi
hostname -I 2>/dev/null | awk '{print $1}'
EOF
)"
IP="$(echo "$IP" | tr -d '\r' | awk 'NF{print; exit}')"

if [ -z "$IP" ]; then
  # Last resort: resolve the HostName ssh would use (covers user@host and config HostName).
  IP="$(ssh "${SSH_OPTS[@]}" -G "$HOST" 2>/dev/null | awk '/^hostname /{print $2; exit}' || true)"
fi
[ -n "$IP" ] || die "could not determine a reachable IP/host for $HOST"

log "done: backend reachable at http://$IP:$REMOTE_PORT"

# ---- final machine-parseable output (stdout only) -------------------------
echo "POSSE_REMOTE_URL=http://$IP:$REMOTE_PORT"
echo "POSSE_REMOTE_TOKEN=$TOKEN"
