# Research: Multi-Agent Coding/Terminal Workspaces (OSS + closed) for DuoCLI renderer redesign

- **Query**: Find OSS GitHub projects that manage multiple concurrent AI coding-agent sessions in one window (session/task list grouped by agent + folder/repo, main work area, file preview/diff pane). Capture stars, stack, license, UX patterns to borrow into DuoCLI (Electron + DOM + xterm.js).
- **Scope**: external (GitHub API + web)
- **Date**: 2026-06-16

## TL;DR — most relevant matches for a DuoCLI renderer redesign

| Rank | Project | Stars | Stack | License | Why it matters |
|---|---|---|---|---|---|
| 1 | **Conductor** (conductor.build, closed-source Mac app) | n/a (not OSS) | Native Mac app | proprietary | The cleanest reference for the exact UX we want: per-task isolated workspace with branch + files + chat + terminal + preview + reviewable diff, parallel-agent overview, one-click PR. |
| 2 | **vibe-kanban** `BloopAI/vibe-kanban` | 27,026 | Rust (backend) + React/TS web UI | Apache-2.0 | Most-starred OSS. Kanban board of agent tasks; per-task workspace = branch + terminal + dev server; inline diff review + comments; 10+ agents (Claude/Codex/Copilot/Gemini/Cursor/...). NOTE: project is **sunsetting**. |
| 3 | **claude-squad** `smtg-ai/claude-squad` | 7,821 | Go (TUI, tmux-backed) | AGPL-3.0 | Closest conceptual twin to DuoCLI's model: manages multiple agent instances, each in an **isolated git worktree**, one terminal window, review-before-apply diff. TUI not GUI but the session-list + worktree-isolation model maps directly. AGPL — inspiration only, do not copy code. |

Additional strong OSS desktop matches (Electron/Tauri, directly borrowable patterns): **CodexFlow**, **Code-Bar**, **Coppice**, **Nimbalyst** (the successor to Crystal), **Sculptor**. See tables below.

## Findings

### Repos found (hard data, GitHub API 2026-06-16)

| Repo | Stars | Lang / Framework | License | Status | Notes |
|---|---|---|---|---|---|
| `BloopAI/vibe-kanban` | 27,026 | Rust + React/TS web | Apache-2.0 | **Sunsetting** (announced) | `npx vibe-kanban`. Kanban task board → per-task agent workspace. |
| `wavetermdev/waveterm` | 21,298 | Go + React/TS (Electron) | Apache-2.0 | Active | General AI terminal, not agent-session-list, but excellent **block/pane layout** + inline file preview reference. |
| `smtg-ai/claude-squad` | 7,821 | Go (TUI) | AGPL-3.0 | Active | tmux + git worktree per task. `cs` binary. |
| `stravu/crystal` | 3,083 | TypeScript (Electron) | MIT | **Deprecated Feb 2026** → Nimbalyst | Original "run multiple Codex/Claude Code in parallel worktrees" Electron app. |
| `Nimbalyst/nimbalyst` | 842 | TypeScript (Electron) | MIT | Active (Crystal successor) | Monaco editor, git-worktree isolation, agents stream edits into open editors, multi-editor workspace. |
| `boldsoftware/sketch` | 703 | Go | custom (NOASSERTION) | Active | Autonomous agent; less of a multi-session GUI. |
| `imbue-ai/sculptor` | 177 | Python (desktop app) | MIT | Experimental research preview | Parallel agents; each task = isolated workspace (worktree). Mac/Linux. Has built-in terminal, chat, changes review, PR, Cmd+K palette. |
| `lulu-sk/CodexFlow` | 81 | **Electron + React + Vite + node-pty + xterm** | Apache-2.0 | Active (pushed 2026-06-16) | **Closest stack match to DuoCLI.** "Unified Workbench"; organize sessions/history by **project directories**; parallel tasks via git worktree; graphical CLI input box (paste images / drag files / @project-files / full-screen input). |
| `For-Tr/Code-Bar` | 26 | **Tauri + TS** | Apache-2.0 | Active | "Parallel AI coding without repo chaos." Per-session git worktree; terminal + editor + SCM + diff in one place; multi-repo. |
| `iamfozzy/coppice` | 8 | **Tauri v2 + React + Rust, xterm.js** | none specified | Active | Per-worktree terminal tabs + AI agent tabs + diff viewers + configurable runners in one window. Worktree pin/archive, live branch status polling. |
| `s1gmamale1/SigmaLink` | 11 | TypeScript (Electron) | MIT | Active | Orchestrates 5 CLI agents (Claude/Codex/Gemini/Kimi/OpenCode) in isolated worktrees; resumes Claude sessions across restarts via mailbox back-channel. |
| `slicenferqin/xuanpu` (玄圃) | low | TypeScript | — | Active | AI-native desktop workbench, git-worktree GUI, Claude Code/OpenCode/Codex, macOS. |
| `ShebinKMohan/Grove` | 2 | TypeScript | — | Early | "Docker Desktop for AI coding agents" — wraps worktrees + Claude Code sessions. |

Closed-source / non-GitHub references (web):
- **Conductor** (conductor.build) — native Mac app, proprietary.
- **Warp** (warp.dev) — proprietary terminal; "Warp Agent" + "Oz" orchestration platform that runs Claude Code, Codex, and Warp Agent in parallel.

### UX / layout patterns (the part worth borrowing)

#### Conductor (conductor.build) — primary inspiration
From landing + docs copy:
- **Core model**: "Run parallel coding agents on your Mac. Create parallel Claude Code, Codex, and Cursor agents in **isolated workspaces**. See at a glance what they're working on, then review and merge their changes."
- **Per task = one workspace** containing: its own **branch, files, chat, terminal, preview, and reviewable diff** (git-worktree backed).
- **Left rail**: workspace/session list grouped per task (History / Workspaces), "see at a glance what each agent is working on" — status badges (running, ready-for-review).
- **Center**: chat/agent transcript + terminal for the active workspace.
- **Right / tabbed work area**: **diff viewer** ("All files / Changes / Checks / Review"), live app **Preview** (Setup/Run/Open :5173/Stop), agent/model selector (e.g. "GPT-5.5 Fast / High / Plan"), and **Create PR** button with PR status ("PR #1432 Ready for review").
- Takeaway for DuoCLI: model the unit of work as a **workspace card** (folder/worktree + agent), not just a raw PTY tab; give each a status, a diff tab, and a preview tab.

#### vibe-kanban (`BloopAI/vibe-kanban`)
- **Kanban board** of issues as the top-level navigation (plan column → in-progress → review). Grouping is **by task/issue**, mapped onto branches.
- Each task → **workspace** = agent + branch + terminal + dev server.
- **Inline diff review with comments** sent back to the agent without leaving the UI; built-in **browser preview** with devtools/inspect/device emulation.
- Agent switcher across 10+ agents (Claude Code, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen). PR creation + merge from UI.
- Takeaway: the **review-diff-inline + comment-back-to-agent** loop and the agent dropdown are clean patterns.

#### claude-squad (`smtg-ai/claude-squad`) — closest to DuoCLI's session/daemon model
- Terminal app (Bubble Tea TUI) managing multiple agent **instances**, each in a **separate isolated git workspace (worktree)** — "no conflicts."
- **Left list**: instances/tasks; **right pane**: the selected agent's live terminal (tmux session).
- Background completion incl. yolo/auto-accept; **review changes before applying, checkout before pushing** (built-in diff/checkout step).
- Grouping is **by task/worktree** (each instance owns a branch). Maps almost 1:1 onto DuoCLI's background PTY daemon owning sessions.

#### Wave Terminal (`wavetermdev/waveterm`) — layout/block reference (not agent-list)
- **Flexible drag-&-drop block grid**: terminals, editors, web browsers, AI chat widgets are all "blocks" you arrange.
- **Quick full-screen toggle** for any block, then back to multi-block view.
- **Rich inline file preview** (markdown, images, video, PDF, CSV, directories) + built-in editor.
- Takeaway: the **block/pane system + one-key maximize** and the **inline preview pane** are directly applicable to a Warp-style DuoCLI layout.

#### CodexFlow (`lulu-sk/CodexFlow`) — closest STACK match (Electron + node-pty + xterm)
- "UI Host with a Minimal Terminal Bridge" — Electron + React + Vite + node-pty + xterm (same primitives as DuoCLI).
- **Sessions/history organized by project directory** (folder-grouped left tree), one-click engine switch (Codex/Claude/Gemini/custom), parallel tasks via git worktree.
- **Graphical CLI input box**: paste images, drag files, `@project-file` references, full-screen input mode — a richer composer above the raw PTY.
- Takeaway: shows how to wrap xterm.js with a **structured composer + folder-grouped session tree** in the exact stack DuoCLI uses.

#### Code-Bar / Coppice (Tauri) — multi-pane worktree workbenches
- Both: per-session **git worktree isolation**, and a single window holding **terminal + editor + SCM + diff** (Code-Bar) / **per-worktree terminal tabs + agent tabs + diff viewers + runners** (Coppice, xterm.js).
- Coppice groups **by worktree**, with worktree pin/archive and 3s live branch-status polling — a good model for a sidebar that's grouped by folder/worktree with live status dots.

#### Nimbalyst (Crystal successor) / Sculptor
- Nimbalyst: Electron, **agents stream edits directly into open Monaco editors in real time**, git-worktree isolation, project-level workspace + AI session tracking.
- Sculptor: each task = isolated workspace (worktree copy); built-in terminal scoped to workspace, changes review + commit, PR tracking, **Cmd+K command palette**, multiple agents collaborating on one workspace.

### Common patterns across all matches (the convergent design)
1. **Unit of work = "workspace/session" = (folder or git worktree) + (one agent)**, not a bare terminal tab. Almost every project isolates each task in its own git worktree.
2. **Left sidebar = session/task list**, grouped either by **project/folder** (CodexFlow, Conductor) or **by worktree/branch** (claude-squad, Coppice), with **live status** (running / ready-for-review / done) and an agent badge.
3. **Center = agent transcript/chat + live terminal** (xterm/tmux) for the selected workspace.
4. **Right (or tabbed) = file preview + diff/review pane**, frequently with **inline comments back to the agent** and a **Create PR / merge** action.
5. **Agent/model switcher** per workspace (dropdown listing Claude / Codex / Copilot / Gemini ...).
6. **Optional app Preview** (run dev server, embedded browser) as another tab.
7. Power-user affordances: **Cmd+K palette** (Sculptor), **one-key maximize a pane** (Wave), **rich composer** with image paste / `@file` mentions (CodexFlow).

### External references
- Conductor — https://conductor.build , https://docs.conductor.build (Concepts: Isolated workspaces, Parallel agents, Git worktrees, Review and merge)
- Warp Agent / Oz — https://www.warp.dev/warp-ai
- vibe-kanban — https://github.com/BloopAI/vibe-kanban (Apache-2.0)
- claude-squad — https://github.com/smtg-ai/claude-squad (AGPL-3.0)
- Wave Terminal — https://github.com/wavetermdev/waveterm (Apache-2.0)
- CodexFlow — https://github.com/lulu-sk/CodexFlow (Apache-2.0)
- Code-Bar — https://github.com/For-Tr/Code-Bar (Apache-2.0)
- Coppice — https://github.com/iamfozzy/coppice
- Nimbalyst — https://github.com/Nimbalyst/nimbalyst (MIT)
- Sculptor — https://github.com/imbue-ai/sculptor (MIT)

## Caveats / Not Found
- **License watch for code copy**: `claude-squad` is **AGPL-3.0** — borrow UX ideas only, never copy source into DuoCLI. vibe-kanban (Apache-2.0), Wave (Apache-2.0), CodexFlow/Code-Bar (Apache-2.0), Nimbalyst/Sculptor (MIT) are permissive but DuoCLI only wants inspiration per the brief.
- **Crystal is deprecated** (Feb 2026) and now redirects to **Nimbalyst**; use Nimbalyst as the live reference.
- **vibe-kanban is sunsetting** (shutdown announced) despite 27k stars — patterns are still valid, project longevity is not.
- **Conductor and Warp are closed-source** — no repo/stars; layout details here are reconstructed from public landing/docs copy, not screenshots.
- **omux** — could not confirm a canonical repo/product. `github.com/omux` is not a project page and no clear "omux" multi-agent terminal repo surfaced in GitHub search. Marked **NOT FOUND / unverified**; do not cite without confirmation.
- **Terragon / Async** — no OSS repo located; appears to be a hosted/closed product. Not verified here.
- Screenshots themselves were not downloaded; layout descriptions are derived from README/landing text. The `coppice` repo references `docs/screenshot-pi-agent.png` and `docs/screenshot-agent-menu.png` if visual reference is needed later.
