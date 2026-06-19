# SSH Remote: terminal access + remote 24/7 agent host

## Goal
Let the user work against remote servers from Posse. Two tiers:

- **Tier 1 — SSH terminal (lightweight).** Pick a host from `~/.ssh/config`, open a plain SSH terminal tab. For quick ops (`docker ps`, log tails). Zero remote install. Nearly free — spawn `ssh <host>` as the pty command in the existing terminal.
- **Tier 2 — Remote 24/7 agent host (heavy).** Run a full Posse backend on the remote so agent sessions run there 24/7, survive the user disconnecting, and the desktop lists remote agent sessions / browses files / edits — same UX as local.

The two tiers share the `~/.ssh/config` host picker as the entry point.

## Core requirements (from design interview)
1. **Disconnect ⇒ remote keeps running.** Remote agent processes must persist independent of the user's SSH/app session.
2. **LLM independence for true 24/7.** A remote agent that is meant to run unattended must use an LLM endpoint reachable WITHOUT the user's Mac (the remote's own credentials). If it depends on the user's Mac for LLM, it is not truly 24/7.
3. **"Borrow my Mac's LLM" mode (Warp-like).** When the remote has no LLM of its own, optionally route the remote agent's LLM calls back to the user's Mac. Interactive-only — stalls when the user disconnects (acceptable; explicitly not 24/7).
4. **Multi-host via windows.** One active host per window; "open in new window" binds a new window to another host → multiple hosts in parallel, each window's mental model stays "one host, like now".

## Resolved design decisions

### Architecture — remote runs a Posse backend (not a thin custom agent)
- Remote runs the SAME Posse backend (pty-daemon + session discovery + file IPC + remote-server), headless. Maximum code reuse: the desktop connects with the same protocol it already uses locally; sessions / 1MB scrollback / file IPC "just work".
- **New requirement: a headless backend run mode.** Posse is Electron (needs a display). Factor the backend (pty-daemon, remote-server, discovery, file IPC) into a headless-runnable process so it runs on a GUI-less 24/7 server. This is needed regardless of transport.
- `PtyBackend` interface (`src/main/pty-backend.ts`) is already the right abstraction. Each connection (local or remote) is a `PtyDaemonClient` instance pointed at a different endpoint.

### Persistence — reuse the existing detached daemon
- The local pty-daemon already self-detaches: `pty-daemon-client.ts:192` spawns it `detached: true` + `child.unref()`; `pty-daemon-config.ts` writes a `{port, pid}` config file for rediscovery. The remote reuses this verbatim: the daemon outlives the SSH session; on reconnect the client reads the config file, finds the live daemon, re-attaches. Sessions survive.

### Tier 2 transport — token + Tailscale (primary), ssh -L (fallback)
- **Primary: token + Tailscale.** Remote runs the Posse backend as a server (the existing `remote-server.ts` with token auth). Desktop connects as a rich client over Tailscale (WireGuard E2E) — reusing the Mobile Access infra already shipped in #2. The desktop client ≈ the mobile PWA client, same protocol. Pairing = exchange the token once / recognize the Tailscale peer.
- **Fallback: `ssh -L` tunnel.** Remote daemon binds 127.0.0.1 only; desktop forwards a local port via `ssh -L`. Used when Tailscale isn't available. Reuses `~/.ssh/config`.
- Rationale: Tailscale makes BOTH LLM directions natural and symmetric (remote→cloud for 24/7, remote→user's-Mac for borrow-mode), and reuses #2.

### SSH transport mechanics — system `ssh` binary
- Use the system `ssh`/`scp` binaries (+ ControlMaster for one reused long connection). Honors `~/.ssh/config` natively (Host / ProxyJump / IdentityFile / Include), ssh-agent, keys — all free. (Chosen over the `ssh2` node lib, which would force reimplementing `.ssh/config`/ProxyJump/agent handling.)
- Used for: Tier 1 raw terminal (`ssh <host>` as pty command), Tier 2 `ssh -L` fallback transport, and bootstrap (scp the backend bundle).

### LLM topology — per-session/per-host switch, two modes
- **Remote-native (default, 24/7):** Posse injects NO LLM env for the remote session. The remote agent uses the remote machine's own config (`claude login` on the remote / its own API key). Survives disconnect. Implementation note: the remote-session spawn path must SKIP the preset env-injection that local sessions use.
- **Borrow-my-Mac (Warp-like, interactive-only):** the remote agent's LLM endpoint is pointed (via env injection: `ANTHROPIC_BASE_URL=<user-Mac-reachable proxy>`, `ANTHROPIC_API_KEY=<Posse gate token placeholder>`) at an **auth-relay proxy on the user's Mac**. The user authenticates with **Claude Code OAuth** (no API key), so we MUST NOT copy oauth creds to the remote. Instead the relay proxy on the user's Mac holds the oauth, attaches the real bearer, and forwards to `api.anthropic.com`. OAuth never leaves the Mac. Disconnect ⇒ proxy unreachable ⇒ remote stalls (expected). Reuse the user's existing cc-proxy / oauth-switch relay.
- With Tailscale, the remote reaches the Mac's relay via the Mac's tailnet IP directly; with `ssh -L` transport, add an `ssh -R` reverse tunnel for the relay.

### Upgrade / version sync (Tier 2 backend)
- Backend versioned per app version (versions are already git-derived `1.2.<commitcount>`). Installed under `~/.posse-agent/<version>/`.
- On connect: version handshake. If the remote backend version != the connecting app's expected version (or missing) → push + launch the matching version. The backend never self-upgrades; it is always slaved to the connecting app's version → no skew.
- **Coexist + drain on upgrade (chosen).** A running backend holding live 24/7 sessions is NOT force-restarted. The new-version backend starts alongside (different port / versioned dir); new sessions use the newest; old sessions drain on the old backend; the old backend is GC'd when its session count hits 0. (Chosen over protocol back-compat, which would lock protocol evolution.)

### Bootstrap / binary distribution (Tier 2)
- Open sub-decision (was being asked when scope pivoted): how the backend reaches the remote. Leading option: backend shipped as a single-file binary per arch (Node SEA / `bun compile`), bundled with the Posse app; first connect detects arch via `uname -m && uname -s`, scp's the right bundle to `~/.posse-agent/<ver>/`, chmod + launches. Host-key trust via system ssh `known_hosts` (first-connect fingerprint prompt, same as CLI ssh). **To finalize in Phase 2 planning.**

### UI / multi-host model
- A connection = (host, transport, `PtyDaemonClient`). Main process holds a **connection registry** (Local always present; remotes on demand).
- Each window binds to ONE connection; window title shows the host. In-window host switcher switches that window's connection; "open in new window" spawns a window bound to the chosen host.
- Closing a remote window does NOT kill the remote: detached daemon + sessions stay 24/7; reopening reconnects.
- **Architectural change:** replace the single global `ptyManager` (`index.ts:490`) with a per-host connection registry; bind window ↔ connection. `PtyBackend` abstraction already supports this.

### File editing (local + remote, uniform)
- Today editing = hand off to a LOCAL external editor (`filewatcher:open` → `spawnEditorCommand`, `index.ts:359-364`); preview is read-only; there is NO general `fs:write-file` IPC. External-editor handoff is local-only.
- Add an **in-app editable preview**: make the right-pane CodeMirror editable + add an `fs:write-file` IPC routed through the daemon's file IPC. Works identically local AND remote (same backend). Strict upgrade over today's read-only preview.

## Phasing
- **Phase 1 — SSH terminal.** `~/.ssh/config` host picker → open `ssh <host>` as a terminal tab. Zero remote install. Ships standalone value.
- **Phase 2 — Remote 24/7 agent host.** Headless backend mode; connection registry + window↔host binding; Tier 2 transport (token+Tailscale primary, ssh -L fallback); bootstrap/versioned install + coexist-drain upgrades; remote session discovery / file tree / in-app edit reuse; LLM mode switch (remote-native default + borrow-my-Mac relay). Large, multi-step.

## Out of scope / deferred
- Final bootstrap binary packaging (SEA vs bun) + arch matrix → decide at Phase 2 planning.
- Mounting remote fs (sshfs) — not used; in-app edit covers it.
- Non-Anthropic agents' borrow-mode auth nuances (Codex/Copilot) — Phase 2 detail.

## Key files (reuse map)
- `src/main/pty-backend.ts` — backend interface (already the abstraction seam).
- `src/main/pty-daemon-client.ts` / `pty-daemon.ts` / `pty-daemon-config.ts` — detached daemon + config-file rediscovery (reuse for remote).
- `src/main/remote-server.ts` — token-auth server + Tailscale (#2); the Tier 2 channel + `getTailscaleInfo()`.
- `src/main/pty-manager.ts:437-460` — env injection (used for borrow-my-Mac; SKIP for remote-native).
- `src/main/index.ts:490` — global `ptyManager` → becomes per-host connection registry; `:359-364`/`:2110` external-editor (local-only) → add in-app edit + `fs:write-file`.
- `src/renderer/terminal-manager.ts` — terminal/pty; Phase 1 spawns `ssh <host>`.
- `src/renderer/file-preview.ts` — make editable (in-app edit).
