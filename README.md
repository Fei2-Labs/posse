# DuoCLI

CLI proxy for **Claude Code** – expose a local HTTP endpoint that any Cascade-compatible IDE can talk to.

## Features

- 🌊 **Streaming SSE proxy** – Local HTTP endpoint for IDE integration
- 💬 **Interactive chat** – `duo chat` for quick terminal conversations
- 🔍 **Auto-detection** – Automatically finds Claude Code CLI
- ⚙️ **Persistent config** – `duo config` to set defaults

## Quick Start

```bash
# Install globally
pnpm install -g duocli

# Start chatting
duo chat

# Start proxy server for IDE integration
duo serve --port 8787
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
   Claude Code
```

## Development

```bash
pnpm install
pnpm build
pnpm start
```
