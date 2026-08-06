# Posse

> Your AI coding posse.

Posse is a desktop app that runs your AI coding CLIs — Claude Code, Codex, GitHub Copilot CLI, Devin, OpenCode, Kiro, or any custom command — in real terminals, and mirrors them to your phone over your local network. Start a session on the desktop, keep watching and typing from your phone, get a push when a session needs you.

## Features

- 📱 **Mobile mirror** – A phone PWA mirrors every live terminal in real time over your LAN. Scan the in-app QR code to pair, then read output and type back from anywhere in the house. Install it to the home screen for a full-screen, app-like experience.
- 🌐 **Remote access tunnel** – Built-in Cloudflare tunnel (`cloudflared`) exposes the mobile UI on a public URL when you're off the LAN, with a per-session access token.
- 🔔 **Push & iMessage alerts** – When a session sits waiting for input, Posse sends a web-push notification to the paired phone, and can text you over iMessage/SMS (`POSSE_IMESSAGE_TO`).
- 🧵 **Background PTY daemon** – Terminal processes live in a long-running daemon, so they keep running when the desktop window closes or restarts for an update.
- 🖥️ **Standalone terminal client** – The daemon serves its own terminal UI at `http://127.0.0.1:9811/terminal/`, usable while the Electron shell restarts. Open it from the standalone-terminal icon button in the sidebar top bar. It has its own mood color themes (Midnight / Dracula / Nord / Solarized / Monokai / Daylight).
- 🗂️ **Project navigator** – A sidebar on the left with **Pinned** and **Projects** sections. Add a folder as a project, expand it to see conversations grouped by agent (Claude / Codex / Copilot / …), and click any session to open it in the center terminal. Each project has a new-conversation button (agent picker), plus pin / rename / remove. Live, closed, and native on-disk history sessions (Claude / Codex / Kiro / Copilot) all surface per project with one-click resume.
- 🤖 **Auto session titles** – New conversations get a short AI-generated title so the sidebar stays readable.
- 🖥️ **Three-pane layout** – Sessions on the left, terminal in the center, file tree on the right. Both side panels are collapsible and resizable.
- 📄 **File preview** – Click any file in the directory tree to preview it read-only in-app (syntax-highlighted via CodeMirror); binary or large files fall back to the external editor.

## Quick Start

```bash
pnpm install
pnpm start
```

This builds the main / preload / renderer / terminal-client bundles and launches the Electron app.

### Pair your phone

1. Make sure the phone is on the same Wi-Fi as the desktop.
2. Open the **Mobile** panel in the app and scan the QR code (or visit `http://<desktop-lan-ip>:9800`).
3. To reach it from outside the LAN, enable the Cloudflare tunnel and use the public URL it prints.

### Ports

| Service | Default | Bind |
| --- | --- | --- |
| Mobile remote server | `9800` (`POSSE_REMOTE_PORT`) | `0.0.0.0` (LAN) |
| PTY daemon / standalone terminal | `9811` | `127.0.0.1` |

## Architecture

```
        Phone PWA (LAN / Cloudflare tunnel)
                 │  WebSocket + web-push
                 ▼
        ┌──────────────────┐
        │  Remote server    │  ← :9800, LAN-exposed
        └────────┬─────────┘
                 │
   Electron UI ──┤
   (desktop)     ▼
        ┌──────────────────┐
        │   PTY daemon      │  ← :9811, owns terminal processes
        └────────┬─────────┘
                 ▼
   Claude Code / Codex / Copilot CLI / Devin / OpenCode / Kiro / custom
```

The desktop app and the phone both connect to the PTY daemon as clients. Closing or restarting the Electron UI disconnects its client, but existing PTY sessions stay alive in the daemon and reattach on the next launch. The daemon also serves the standalone terminal client at `http://127.0.0.1:9811/terminal/`, so terminals remain reachable while the main window updates or restarts.

Because the daemon is long-lived, new daemon code only takes effect after a restart. The sidebar button labeled `Restart daemon` performs a **graceful** restart: it first saves every live session as resumable (nothing is lost — sessions reappear in the Projects history with one-click resume), then stops the old daemon and starts a fresh one running the updated code, and finally refreshes the navigator.

Posse is single-instance on macOS; launching it again while it is already running brings the existing window to the front and shows a "Posse is already running" message in the new process.

The desktop sidebar footer shows the running app version so you can confirm the newest build at a glance.

## Relationship to Warp

Posse is not a Warp fork, client, or port. `warpdotdev/warp` (public Rust workspace) is tracked as a **reference remote** only:

```bash
git fetch warp-reference   # read-only inspection; push is DISABLED
```

Hard rule for agents and contributors: never run `git merge --allow-unrelated-histories` (or any merge/cherry-pick) against `warp-reference`. The repos share no Git history and different stacks; merging would be destructive and would import AGPL-licensed code. Alignment happens incrementally through small, Posse-native changes informed by Warp's public architecture concepts — never by importing Warp source, assets, or branding. Posse is not "Warp-compatible" and makes no interoperability claim.

## Build

```bash
pnpm build         # current platform
pnpm build:mac     # macOS DMG (app stays Posse.app; DMG carries the version)
pnpm build:win     # Windows
pnpm build:linux   # Linux
```
