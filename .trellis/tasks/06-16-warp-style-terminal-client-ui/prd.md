# Warp/Codex-inspired Multi-Session Workspace (Desktop)

## Goal

Redesign the **desktop main renderer** (`src/renderer/`) session+terminal workspace into a Warp/Codex-inspired layout so the user can: (1) see all live terminals and resume them, (2) clearly tell what each terminal is doing (label + agent + folder + status), grouped by agent/folder, (3) work in the main window, and (4) preview document/file contents in a side panel. Inspired-by, not a code copy. Single-agent is the common case; multi-agent is occasional.

## What I already know

* Target = **main Electron renderer** (`src/renderer/app.ts`, `index.html`, `styles.css`), NOT the daemon-served standalone web client (`src/terminal-client/`), NOT mobile remote.
* Main renderer today already has a sessions sidebar + single xterm terminal + preset selector + Devin/AI-config tabs. This task enhances the session/terminal workspace; existing management tabs stay.
* **Session resume already works**: PTY processes are owned by the background daemon; closing/restarting Electron keeps sessions alive, replayed on reattach. This task surfaces resume clearly in the UI; it does NOT rebuild the persistence layer.
* DuoCLI has `src/main/title-ai.ts` for auto session-title generation — reuse for the "what is this terminal doing" label.
* Presets: Claude / Codex / Copilot / Devin / custom. Agent type is derivable from the session's preset/command.
* Daemon exposes session list, raw-buffer replay, create/write/resize/destroy/rename, title regen, event WS. File-preview needs a way to read file contents (via Electron main IPC fs, since this is the desktop renderer — IPC available here, unlike the standalone client).

## Requirements

* **Session list (left rail)**: list ALL known sessions per agent — both **live** daemon sessions AND **closed** sessions for which a resume command was captured. Default grouping by agent so the user sees every existing conversation under each agent.
* **Per-session identity**: each row shows a clear label (auto title from `title-ai` + cwd + agent type) so the user knows what that terminal is doing.
* **Status indicator**: 3-state pill per session — running / waiting-for-input / idle-or-done. Closed sessions show a "closed/resumable" state.
* **Per-session actions** (the three the user requires):
  * **One-click resume**: if the PTY is alive → reattach + replay; if closed → relaunch via captured `resumeCommand` (`claude --resume <id>`, `codex resume <id>`, `copilot --resume <id>`, `devin -r <name>`, cursor/kiro variants — already parsed in `pty-manager.ts`).
  * **Rename**: reuse existing rename flow; persists.
  * **Delete**: kill the live PTY if any + remove the session from the history list.
* **Closed-session persistence**: persist metadata (agent, cwd, label, `resumeId`/`resumeCommand`, last-active) for closed sessions so "all existing sessions per agent" survives terminal close and app restart.
* **Grouping**: group the session list by **agent** (default) and by **folder**, user-togglable (groupBy selector). Flat-list + collapsible group headers (chevron + label + count), not a true tree.
* **Main workspace**: active session renders in the main window via existing xterm.
* **File preview (right panel)**: a side panel to browse the active session's working directory and preview document/file contents read-only (markdown / text / code with syntax highlight). Opening a file does not modify it.
* Keep existing management tabs (Devin, AI config, presets) working.
* No regression to existing session create/switch/write/resize/close/rename or mobile remote compatibility.

## Acceptance Criteria

* [ ] Left rail lists all known sessions per agent — live AND closed-but-resumable; default grouped by agent.
* [ ] Each session row shows: label (auto title), agent type, folder, and a status pill (running / waiting / idle / closed-resumable).
* [ ] One-click resume works for both live (reattach+replay) and closed (relaunch via captured resumeCommand) sessions.
* [ ] Each session row supports rename (persists) and delete (kills live PTY if any + removes from history).
* [ ] User can toggle grouping by agent vs by folder; group headers collapse/expand with a count.
* [ ] Closed-session metadata (agent, cwd, label, resumeCommand, last-active) persists across terminal close and app restart.
* [ ] Restarting the Electron app preserves sessions and they reappear in the rail with correct labels/status.
* [ ] Right panel can browse the active session's cwd and preview a selected file's contents read-only with syntax highlight (markdown/text/code).
* [ ] Opening a file in preview never writes to disk.
* [ ] Existing Devin/AI-config/preset tabs and mobile remote flows still work.
* [ ] `npm run build:ts` / `build:terminal-client` passes; typecheck green.

## Definition of Done

* Lint / typecheck / build green.
* README updated for the new workspace layout + file preview.
* No destructive removal of working renderer logic (rollback-safe; existing terminal path remains).

## Technical Approach

* **Layout**: 3-zone in main renderer — left grouped session rail | center xterm workspace | right collapsible file-preview panel.
* **Grouping**: derive groups at render via a `groupBy(agent|folder)` selector over the flat session list; collapsible headers with status-rollup counts.
* **Status**: infer running/waiting/idle from PTY activity (last-output timing / prompt detection) exposed by daemon; start simple (recent-output heuristic), refine later.
* **Label**: reuse `title-ai` auto titles + cwd basename + agent badge.
* **File preview**: read-only **CodeMirror 6** (MIT, fits non-React esbuild renderer; markdown/text/code highlight). File contents read via Electron main-process IPC fs (renderer has IPC). A lightweight file list/tree rooted at session cwd to pick files. NO diff2html (user does not need diffs).
* **Resume**: surface existing daemon-backed sessions on launch; no persistence-layer changes.

## Decision (ADR-lite)

**Context**: User's real pain = session resume visibility + knowing what each terminal does + occasional file viewing. Common case is single-agent; multi-agent is occasional.
**Decision**: Build the grouped, status-aware, resumable session workspace + read-only file preview in the desktop renderer. Do NOT force git-worktree isolation per session (the "档3" Conductor model) — it only pays off for frequent multi-agent-same-repo work, which is not the user's pattern, and adds worktree lifecycle/conflict complexity. Use CodeMirror 6 read-only for preview; no diff view.
**Consequences**: Fast path to the user's stated needs, low risk, reuses the existing daemon + title-ai. Optional per-session worktree isolation and diff review are deferred as future extensions if multi-agent parallel use grows.

## Out of Scope

* Git-worktree isolation per session (deferred; optional future toggle).
* Diff / change-review panel (user does not need diffs).
* One-click PR / branch automation.
* Split panes / multi-terminal tiling.
* Warp command blocks / rich block terminal rendering.
* Rebuilding the PTY persistence/daemon layer.
* Standalone web client (`src/terminal-client/`) and mobile remote redesign.
* Full Monaco editor (too heavy for read-only preview).

## Research References

* [`research/multi-agent-workspace-oss.md`](research/multi-agent-workspace-oss.md) — OSS blueprints (Conductor, vibe-kanban, claude-squad, CodexFlow); convergent pattern = grouped status-badged session list + center terminal + right panel.
* [`research/file-preview-and-grouping.md`](research/file-preview-and-grouping.md) — CodeMirror 6 for read-only preview; flat-list + collapsible group headers + 3-state status pill for grouping.
* [`../archive/2026-06/06-15-terminal-client-separation/research/warp-ui-architecture.md`](../../archive/2026-06/06-15-terminal-client-separation/research/warp-ui-architecture.md) — Warp patterns to adapt.

## Reuse Map (already in codebase — confirmed via investigation)

* Closed-session persistence EXISTS: `ClosedSession` + `closed-sessions.json` + `addClosedSession()` (stores `resumeId`/`resumeCommand`) + IPC `closed-sessions:list/remove/clear/update`. (`src/main/index.ts:63-105,769-777`)
* Session list ALREADY grouped by cwd (`session-group-header`) in `renderSessionList()` (`src/renderer/app.ts:1488-1807`) — add a groupBy(agent|folder) toggle on top.
* Rename EXISTS (`pty:rename` / `startTitleEdit` app.ts:1398). Delete: live=`pty:destroy`, closed=`closed-sessions:remove`.
* Agent identity EXISTS: `PRESET_DISPLAY_NAMES` + `getDisplayName()` (pty-manager.ts:49-58,170), `sessionProviders` Map, `cli:get-provider` (index.ts:1057).
* title-ai EXISTS + wired (`onTitleUpdate`). Busy state: `sessionBusy` Set (app.ts:937).
* Directory browsing EXISTS: `file-tree:list-dir` + `renderFileTree()` (app.ts:1236). MISSING: read FILE CONTENTS IPC (only readdir today) → new `fs:read-file`.

## PR Plan (dependency order)

* **PR1 (foundation, independent)**: add `fs:read-file` IPC (main + preload) returning file text + a size/binary guard.
* **PR2**: right-zone file-preview panel — reuse existing file tree to pick a file, render contents read-only via CodeMirror 6 (new dep). Collapsible 3rd zone.
* **PR3**: rail enhancements — groupBy(agent|folder) toggle (default agent), surface closed sessions per agent inline with one-click resume (reattach live / relaunch `resumeCommand` closed) + rename + delete; status pill (running/waiting/idle/closed).

## Technical Notes

* Files: `src/renderer/{app.ts,index.html,styles.css}`, `src/renderer/terminal-manager.ts`, `src/main/index.ts` (IPC for fs read + session metadata), `src/main/title-ai.ts`, `src/preload/index.ts`, `package.json`.
* New dep: `codemirror` v6 (+ lang/markdown, theme). MIT.
* Branch: `feat/copilot-cli-support`.
