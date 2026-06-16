# DuoCLI

Desktop and mobile-synced terminal for AI coding CLIs, including Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, and custom commands.

## Features

- 🌊 **Streaming SSE proxy** – Local HTTP endpoint for IDE integration
- 💬 **Interactive chat** – `duo chat` for quick terminal conversations
- 🔍 **Built-in AI CLI presets** – Start Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, or custom commands
- 🧵 **Background PTY daemon** – Terminal processes keep running when the Electron window closes or restarts for an update
- 🖥️ **Independent terminal client** – Open the daemon-served terminal UI at `http://127.0.0.1:9811/terminal/` while the Electron shell restarts
- 🗂️ **Multi-session workspace** – Group the session rail by **agent** or by **folder** (toggle at the top of the 会话 tab); live and closed sessions both show under each agent, with one-click resume / rename / delete
- 📄 **File preview** – Click any file in the directory tree to preview its contents read-only in-app (syntax-highlighted via CodeMirror); binary or large files fall back to the external editor
- ⚙️ **Persistent config** – `duo config` to set defaults

## Quick Start

```bash
# Install globally
pnpm install -g duocli

# Start chatting
duo chat

# Start proxy server for IDE integration
duo serve --port 8787

# GitHub Copilot CLI preset used by the desktop and mobile UI
copilot --allow-all --autopilot
```

## Configuration

```bash
# Show current config
duo config --show

# Auto-detect and save
duo config --detect
```

## Architecture

```
IDE (Cascade-compatible)
    │
    ▼
┌──────────────┐
│  DuoCLI Proxy │  ← HTTP/SSE on localhost:8787
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ DuoCLI PTY Daemon │  ← owns terminal processes on localhost:9811
└──────┬───────────┘
       │
       ▼
   Claude Code / Codex / GitHub Copilot CLI / custom CLI
```

The desktop app connects to the PTY daemon as a client. Closing or restarting the Electron UI disconnects the client, but existing PTY sessions remain alive in the daemon and are reattached on the next launch.

The PTY daemon also serves an independent local terminal client at `http://127.0.0.1:9811/terminal/`. Use the desktop sidebar button labeled `独立终端` to open it. This client talks directly to the daemon over local HTTP/WebSocket APIs, so it remains usable while the main Electron window is updated or restarted. The mobile remote UI remains served separately by the remote server.

DuoCLI itself is single-instance on macOS; launching it again while it is already running brings the existing window to the front and shows a "DuoCLI 已在运行" message in the new process.

The desktop sidebar footer shows the running app version so you can verify the newest build at a glance.

macOS release bundles keep the app name as `DuoCLI.app`; the DMG still carries the version number.

## Development

```bash
pnpm install
pnpm build
pnpm start
```
