# Devin CLI: discover history sessions + new-session entry

## Goal

Make Devin CLI sessions (live + on-disk history) visible and resumable in the project navigator, with parity to Claude/Codex/Kiro/Copilot. Today Devin is completely invisible in the navigator because the backend has no `discoverDevinSessions()` and the renderer's resume/type plumbing omits `devin`.

## What I already know (verified by inspection)

* Devin agent-family detection in the renderer already recognizes Devin: `KNOWN_AGENT_ORDER` includes `'Devin'` (`src/renderer/app.ts:433`) and `agentFamilyFromDisplayName()` maps `devin` → `'Devin'` (`app.ts:788`).
* New-session preset for Devin already exists: `{ value: 'devin --permission-mode bypass', label: 'Devin (auto)' }` at `app.ts:1283` (BUILTIN_OPTIONS). So "create new Devin session" works.
* Devin account management IPC is fully wired (preload `src/preload/index.ts:164-173`, main `src/main/index.ts:3073-3173`, pty-manager device-rotation `src/main/pty-manager.ts:338-416`).
* pty-manager already knows the Devin resume command shape: `devin -r <session_name>` (`src/main/pty-manager.ts:101`) and `agentKindFromCommand` maps `devin` → but **returns null** for devin (`pty-manager.ts:114-121` only handles claude/codex/kiro/copilot).
* **Root cause of invisibility**: `buildProjectsList()` (`src/main/index.ts:1570-1576`) discovers sessions from `discoverClaude/Codex/Kiro/CopilotSessions()` only — there is **no `discoverDevinSessions`**. So no Devin history ever reaches the navigator.
* Second gap: renderer resume-command parser (`app.ts:3985-3988`) has no `devin` branch, so even a Devin resume command can't be parsed back to an id/agent.
* Type gap: `ProjectsAgentId = 'claude' | 'codex' | 'kiro' | 'copilot'` in BOTH `src/main/index.ts:1174` and `src/renderer/app.ts:401` — no `'devin'`. `normAgent` (`index.ts:1738-1741`) falls back unknown agents to `'claude'`, so a Devin live session is currently mislabeled Claude.
* Devin on-disk storage (verified on this machine): sqlite at `~/.local/share/devin/cli/sessions.db` (also `~/.local/share/devin/cli-next/sessions.db`). Schema:
  ```
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    model TEXT, agent_mode TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    title TEXT, ..., hidden INTEGER NOT NULL DEFAULT 0, ...);
  ```
  `devin --help` confirms: `devin -r, --resume [<SESSION_ID>]` resumes by id; `devin list` / `devin ls` lists sessions. Both local DBs are empty on this machine (0 rows) so implementation cannot be validated against real Devin data here — schema + CLI flags are the source of truth.
* Copilot discovery (`src/main/index.ts:1498-1566`) is the closest precedent to mirror: sqlite via `node:sqlite` with `sqlite3` binary fallback, best-effort/never-throw, filter synthetic cwds, cap results.

## Requirements

* [ ] Add `discoverDevinSessions()` in `src/main/index.ts` mirroring `discoverCopilotSessions()`'s sqlite approach (node:sqlite first, `sqlite3` binary fallback), reading `~/.local/share/devin/cli/sessions.db` (and `cli-next` if present). Map each row to `{ id, cwd=working_directory, title, mtimeMs=last_activity_at, agent:'devin', resumeCommand:\`devin -r ${id}\`, sourcePath:'' }`. Skip `hidden=1`. Never throw.
* [ ] Include Devin in `buildProjectsList()`'s discovered array (`index.ts:1571-1576`).
* [ ] Add `'devin'` to `ProjectsAgentId` union in BOTH `src/main/index.ts:1174` and `src/renderer/app.ts:401`, and to the backend `agent` union literals in the renderer (`app.ts:78`, `app.ts:211`/`ClaudeHistorySession` if it constrains agent).
* [ ] Update `normAgent()` (`index.ts:1738-1741`) to pass `'devin'` through instead of falling back to `'claude'`.
* [ ] Update `agentKindFromCommand()` (`pty-manager.ts:114-121`) to return `'devin'` for `devin` commands.
* [ ] Add a `devin` branch to the renderer resume-command parser (`app.ts:3985-3988`): match `devin -r <id>` / `devin --resume <id>` → `{ agent:'devin', id }`.
* [ ] Add `'devin'` → `'Devin'` to `AGENT_ID_LABEL` (`app.ts:411`) and any sibling label/order maps.
* [ ] `last_activity_at` unit handling: if value > 1e12 treat as ms, else treat as seconds and ×1000 — so sort times are comparable to other agents' ms timestamps.

## Acceptance Criteria

* [ ] On a machine with Devin sessions in the DB, Devin history rows appear under the correct project (by `working_directory`) in the navigator, with title + relative time.
* [ ] Clicking a Devin history row resumes it via `devin -r <id>` (launches a PTY that resumes the conversation).
* [ ] A live Devin session is labeled "Devin", not mislabeled "Claude".
* [ ] `hidden=1` Devin sessions are excluded.
* [ ] `discoverDevinSessions` never throws when the DB is missing / unreadable / empty (returns `[]`).
* [ ] `npm run build:ts` + `npm run build:renderer` clean; no new tsc errors beyond baseline.
* [ ] `npm run build:mac` produces an installable `.app`.

## Definition of Done

* Manual verification via running app (Devin DB empty on this machine → verify gracefully degrades to no Devin rows, no errors; full data-path verified by code inspection + schema).
* Lint / typecheck / build green (no new errors vs baseline).
* GitHub issue #50 scope note: #50 is Windows-only Copilot; this task fixes the Devin analog cross-platform. Do NOT auto-close #50 (different root cause). Leave #50 open; file a separate Devin issue if a tracking issue is desired, or note in commit body.

## Technical Approach

Mirror Copilot's discovery precisely (it's the closest sqlite precedent):
1. `discoverDevinSessions()` — read both `~/.local/share/devin/cli/sessions.db` and `cli-next/sessions.db`; query `SELECT id, working_directory, title, last_activity_at, hidden FROM sessions WHERE hidden=0 ORDER BY last_activity_at DESC LIMIT 100`; normalize cwd (`path.resolve`, skip empty/synthetic); ms-coerce `last_activity_at`; build `resumeCommand = \`devin -r ${id}\``.
2. Type-widen `ProjectsAgentId` to include `'devin'` in main + renderer; thread through `normAgent`, `agentKindFromCommand`, `AGENT_ID_LABEL`, resume parser.
3. No UI changes required for new-session (preset already exists at `app.ts:1283`).

## Out of Scope

* Windows-specific Copilot fix (#50) — separate issue, separate task.
* Devin account-management UI (IPC already exists; frontend UI not requested here).
* Persisting/rotating Devin device identity (already implemented in pty-manager).

## Technical Notes

* Files: `src/main/index.ts`, `src/main/pty-manager.ts`, `src/renderer/app.ts`. Possibly `src/preload/index.ts` only if a new IPC is needed (none expected — discovery is backend-internal).
* DB paths: `~/.local/share/devin/cli/sessions.db`, `~/.local/share/devin/cli-next/sessions.db`.
* Resume CLI: `devin -r <id>` (aliases `--resume`).
* Cannot validate against real Devin data on this machine (both DBs empty). Verify by: (a) unit-level schema/SQL correctness, (b) graceful empty/missing-DB path, (c) code inspection of the data flow into `buildProjectsList`.
