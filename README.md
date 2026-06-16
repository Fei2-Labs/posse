# Posse

> Your AI coding posse.

Desktop and mobile-synced terminal for AI coding CLIs, including Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, and custom commands.

## Features

- 🌊 **Streaming SSE proxy** – Local HTTP endpoint for IDE integration
- 💬 **Interactive chat** – `duo chat` for quick terminal conversations
- 🔍 **Built-in AI CLI presets** – Start Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, or custom commands
- 🧵 **Background PTY daemon** – Terminal processes keep running when the Electron window closes or restarts for an update
- 🖥️ **Independent terminal client** – Open the daemon-served terminal UI at `http://127.0.0.1:9811/terminal/` while the Electron shell restarts
- 🗂️ **Project navigator** – A Codex-style sidebar on the **left** with **Pinned** and **Projects** sections. Add a folder as a project, expand it to see its conversations grouped by agent (Claude / Codex / Copilot / …), and click any session to open it in the center terminal. Each project has a **new-conversation** button (agent picker), plus pin / rename / remove. Live, closed, and native on-disk history sessions (Claude / Codex / Kiro / Copilot) all surface per project with one-click resume.
- 🖥️ **Layout** – Sessions on the left, terminal in the center, file tree on the right. Both side panels are collapsible and resizable.
- 📄 **File preview** – Click any file in the directory tree to preview its contents read-only in-app (syntax-highlighted via CodeMirror); binary or large files fall back to the external editor
- ⚙️ **Persistent config** – `duo config` to set defaults

## Quick Start

```bash
# Install globally
pnpm install -g posse

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
│  Posse Proxy  │  ← HTTP/SSE on localhost:8787
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ Posse PTY Daemon  │  ← owns terminal processes on localhost:9811
└──────┬───────────┘
       │
       ▼
   Claude Code / Codex / GitHub Copilot CLI / custom CLI
```

The desktop app connects to the PTY daemon as a client. Closing or restarting the Electron UI disconnects the client, but existing PTY sessions remain alive in the daemon and are reattached on the next launch.

The PTY daemon also serves an independent local terminal client at `http://127.0.0.1:9811/terminal/`. Use the desktop sidebar button labeled `Standalone Terminal` to open it. This client talks directly to the daemon over local HTTP/WebSocket APIs, so it remains usable while the main Electron window is updated or restarted. The mobile remote UI remains served separately by the remote server.

Posse itself is single-instance on macOS; launching it again while it is already running brings the existing window to the front and shows a "Posse is already running" message in the new process.

The desktop sidebar footer shows the running app version so you can verify the newest build at a glance.

macOS release bundles keep the app name as `Posse.app`; the DMG still carries the version number.

## Development

```bash
pnpm install
pnpm build
pnpm start
```
