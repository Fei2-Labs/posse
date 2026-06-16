# Separate Terminal Client from DuoCLI App

## Goal

Separate the interactive terminal surface from the DuoCLI Electron main app so DuoCLI can be restarted, rebuilt, or developed without interrupting the terminal UI the developer is actively using. PTY ownership has already moved to a background daemon; this task focuses on giving that daemon an independent local terminal client that does not depend on Electron IPC or the main renderer lifecycle.

## What I Already Know

* The user develops DuoCLI while also using DuoCLI for other work. Restarting the Electron app during development should not disrupt active terminal interaction.
* PTY processes are now owned by a background daemon through `src/main/pty-daemon.ts`.
* The Electron main app currently connects to the daemon through `src/main/pty-daemon-client.ts`.
* The current desktop terminal UI still lives in the main renderer:
  * `src/renderer/index.html`
  * `src/renderer/app.ts`
  * `src/renderer/terminal-manager.ts`
  * `src/renderer/styles.css`
* The renderer terminal UI depends on `window.duocli` preload IPC methods, so it cannot run independently in a normal browser.
* The daemon already exposes most primitives a terminal client needs: session list, raw buffer replay, create, write, resize, destroy, rename, title regeneration, and event WebSocket.
* The current mobile remote server already proves a browser-based client can operate PTY sessions over HTTP/WebSocket, but it is optimized for mobile remote access rather than desktop daily use.
* The existing mobile remote client must continue working. The terminal client separation should not break the current mobile LAN/PWA workflow.
* tmux is a possible persistence/session-sharing layer, but DuoCLI already has a PTY daemon that owns sessions and mobile replay. tmux should be evaluated as an optional integration rather than assumed as the replacement architecture.
* Warp is open source, but its client is Rust + custom WarpUI. Its structure is useful for product/UX reference, not direct code reuse.

## Assumptions

* The first independent terminal client should be local-only and connect to `127.0.0.1`, using the existing daemon token.
* The first version should prioritize uninterrupted development workflow over a complete Warp-like redesign.
* The main DuoCLI app should keep management/control features for now: presets, Devin accounts, AI config, mobile connection status, and settings.
* The terminal client should initially be a local web client served by the daemon, then later be wrapped as a separate Electron terminal window/app.

## Open Questions

* None for MVP.

## Requirements

* Provide an independent local terminal client that remains usable while the main DuoCLI Electron app restarts.
* The terminal client must connect directly to the PTY daemon, not through Electron IPC.
* The terminal client must restore existing daemon sessions on launch and replay recent terminal output.
* The terminal client must support core terminal operations: create session, switch session, write input, resize, close session.
* The terminal client must preserve current terminal affordances where practical: xterm rendering, session titles, cwd, display names, raw buffer replay.
* DuoCLI main app must expose a clear way to open the independent terminal client.
* The main app must not become the only usable terminal surface.
* Existing mobile remote access must remain compatible with daemon-owned PTY sessions.
* The implementation should not require tmux for normal operation.
* The existing embedded terminal workspace in the main DuoCLI app should remain fully available during the MVP as a rollback path.

## Acceptance Criteria

* [ ] With PTY daemon running and at least one active session, closing/restarting DuoCLI main Electron app does not close the independent terminal client.
* [ ] The independent terminal client can show active daemon sessions without relying on `ipcRenderer` or preload APIs.
* [ ] The independent terminal client can create a new terminal session through daemon HTTP APIs.
* [ ] Typed input in the independent terminal client reaches the PTY session.
* [ ] Terminal output streams to the independent terminal client over WebSocket.
* [ ] Refreshing the independent terminal client page restores sessions and replays raw buffer.
* [ ] Main DuoCLI app has an "Open Terminal Client" entry point.
* [ ] Existing mobile remote session list, subscribe, input, resize, and replay flows still work.
* [ ] Existing embedded terminal workflow in the main DuoCLI app still works after the independent client is added.
* [ ] `npm run build:ts` passes.

## Definition of Done

* Tests or smoke checks cover daemon API and client launch behavior where practical.
* Lint/typecheck/build pass.
* README or relevant docs describe the split: daemon, terminal client, main app.
* Rollback is clear: main app can still connect to daemon and existing terminal code is not destructively removed in the first iteration.

## Out of Scope

* Full Warp-like UI redesign.
* Warp command blocks or rich terminal block parsing.
* Multi-user remote access redesign.
* Replacing xterm.js.
* Replacing the PTY daemon with tmux.
* Moving all settings/Devin/mobile panels into the terminal client in the first iteration.
* Removing or hiding the existing main-app terminal workspace in the MVP.

## Technical Approach

The MVP is a daemon-served local web client first, followed by a later Electron wrapper:

* Add a terminal client source tree such as `src/terminal-client/`.
* Bundle it with esbuild to `dist/terminal-client/`.
* Extend the PTY daemon to serve static terminal client assets on a local route.
* Add a small browser-side daemon API client that talks to daemon HTTP/WebSocket directly.
* Reuse or adapt `TerminalManager` behavior without depending on `window.duocli`.
* Add an Electron main app button/menu action that opens the daemon-served terminal client URL in the default browser or a lightweight shell window.

This keeps the terminal UI alive across main app restarts because it is hosted by the daemon, not by the Electron renderer.

## Decision (ADR-lite)

**Context**: The user needs to keep using DuoCLI terminals while developing and restarting the DuoCLI Electron app. A separate Electron window gives a more desktop-native experience, but it adds packaging and lifecycle complexity before the core interruption problem is solved.

**Decision**: Build the daemon-served local web terminal client first, then wrap it as a separate Electron terminal window/app after the web client proves the daemon protocol and UI separation.

**Consequences**: The MVP has the fastest path to uninterrupted terminal use and can be tested in a normal browser. The later Electron wrapper can reuse the same terminal client bundle instead of forking UI logic.

## MVP Scope Decision

Keep the existing embedded terminal workspace fully available in the main DuoCLI app for the first version. Add the independent daemon-served terminal client alongside it. This preserves a rollback path and limits the first implementation to additive behavior.

## tmux Evaluation

tmux could help with terminal persistence and attach/detach semantics, but it is not the right default replacement for DuoCLI's current daemon model:

* tmux would add an external runtime dependency and platform-specific behavior.
* DuoCLI would lose some direct PTY-level control unless it wraps tmux carefully.
* The current mobile client already depends on daemon raw-buffer replay, WebSocket events, session metadata, titles, and provider state.
* tmux is useful as an optional backend mode for users who already want tmux-compatible sessions, but the MVP should keep the daemon as the source of truth.

## Research References

* [`research/warp-ui-architecture.md`](research/warp-ui-architecture.md) — Warp is useful as a workspace/tab/pane design reference, but its Rust/WarpUI implementation is not directly portable to DuoCLI.

## Technical Notes

* Relevant DuoCLI files:
  * `src/main/pty-daemon.ts`
  * `src/main/pty-daemon-client.ts`
  * `src/main/pty-backend.ts`
  * `src/main/remote-server.ts`
  * `src/renderer/app.ts`
  * `src/renderer/terminal-manager.ts`
  * `src/preload/index.ts`
  * `src/renderer/index.html`
  * `src/renderer/styles.css`
  * `package.json`
* Current branch: `feat/copilot-cli-support`.
* Existing daemon default port: `9811`.
* Current mobile remote server default port: `9800`.
