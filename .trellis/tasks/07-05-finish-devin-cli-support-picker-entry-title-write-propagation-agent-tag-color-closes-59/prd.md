# Finish Devin CLI support: picker entry, title-write propagation, agent-tag color

## Goal

Close the 3 remaining gaps from issue #59 (Add Devin CLI session support). Discovery, `agentKindFromCommand`, resume parsing, and `ProjectsAgentId` were already completed in commit `cab1a0c2`. Display-name mapping (`getDisplayName`, `PRESET_DISPLAY_NAMES`) was already correct pre-existing. Remaining gaps, confirmed by inspection:

1. **Agent picker entry** — `getAgentPickerOptions()` (`src/renderer/app.ts:3920-3934`) has no Devin option. This is the menu used to start a NEW session from a project row; it currently lists Claude/Codex/Copilot/Kiro only.
2. **Title-write propagation** — no `writeDevinSessionTitle`. `writeClaudeSessionTitle`/`writeCodexSessionTitle` (`src/main/pty-manager.ts:158`, `:223`) propagate a sidebar rename into the agent's own on-disk session store. Two call sites dispatch by agent (`src/main/index.ts:2128-2137` for closed sessions by regex on presetCommand, `src/main/index.ts:2770-2784` for history sessions by explicit agent string) — both have `claude`/`codex` branches only.
3. **Agent-tag color** — `CLI_TAG_COLORS` (`src/renderer/app.ts:2109-2116`) has no `'Devin'`/`'Devin (auto)'` entries, so Devin session rows currently fall through to `getCliTagColors`'s hash-based fallback palette instead of an intentional, guaranteed-distinct color like every other known agent.

## What I already know

* Devin session store is sqlite: `~/.local/share/devin/cli/sessions.db` + `cli-next/sessions.db`, schema `sessions(id, working_directory, title, ..., hidden, ...)` (verified in commit `cab1a0c2`'s `discoverDevinSessions`/`deleteSessionFromStore` devin branches — same file already has the sqlite read/delete pattern to mirror for a title UPDATE).
* `getDisplayName()` (`pty-manager.ts:406-424`) and `PRESET_DISPLAY_NAMES` (`pty-manager.ts:61-69`) already produce `'Devin'` / `'Devin (auto)'` correctly — no changes needed there.
* `KNOWN_AGENT_ORDER` (`app.ts:434`) already includes `'Devin'`.
* Kiro is a precedent for "known agent without a writable title format" (the `history-sessions:rename` comment at `index.ts:2781` says "copilot/kiro/unknown — no writable title format, skip"). Devin, unlike Copilot, has a plain `title TEXT` column that's trivially UPDATE-able — worth implementing since the issue explicitly asks for it, without touching Copilot/Kiro (out of scope).

## Requirements

* [ ] `getAgentPickerOptions()` includes a Devin entry (label + auto-permission command), consistent with the existing `BUILTIN_OPTIONS` entry (`'devin --permission-mode bypass'`, label `'Devin (auto)'` per existing convention at ~app.ts:1283).
* [ ] `writeDevinSessionTitle(id, title)` in `pty-manager.ts`: best-effort, never-throw, UPDATEs `sessions.title` by id in BOTH `cli` and `cli-next` DBs (node:sqlite first, `sqlite3` binary fallback — mirror the existing devin discovery/delete pattern exactly).
* [ ] Wire `writeDevinSessionTitle` into both rename call sites (`index.ts:2128-2137` regex-dispatch, `index.ts:2770-2784` agent-string dispatch) alongside the existing claude/codex branches.
* [ ] `CLI_TAG_COLORS` gains `'Devin'` and `'Devin (auto)'` entries — a color pair visually distinct from existing Claude (amber)/Codex (green)/Copilot (green) entries.

## Acceptance Criteria

* [ ] Devin appears as a selectable option in the "new session" agent picker menu on a project row.
* [ ] Renaming a Devin session (live via title-edit, or a closed/history Devin row) updates the `title` column in the on-disk Devin sqlite DB(s) for that session id.
* [ ] Devin session rows show a fixed, intentional tag color (not the hash-fallback palette).
* [ ] `npm run build:ts` clean; tsc baseline unchanged (no new errors).
* [ ] `npm run build:mac`; verify via `asar extract` + grep that the new code is present in the installed bundle before reporting done (lesson from the color-fix round).

## Definition of Done

* Manual verification of picker entry + tag color via running app.
* Title-write verified by code inspection + a manual sqlite check (create/rename a real Devin session on this machine if one exists, or verify the SQL against the schema since local DBs may be empty).
* Build/tsc green; installed-bundle content verified.
* Close #59 via commit (`closes #59`) once merged/pushed to a shared branch (not auto-closed on a feature-branch-only push).

## Out of Scope

* Copilot/Kiro title-write (still no writable format per existing code comment — not part of this task).
* Any change to discovery, resume, or ProjectsAgentId typing (already done in `cab1a0c2`).

## Technical Notes

* File: `src/renderer/app.ts`, `src/main/pty-manager.ts`, `src/main/index.ts`.
* Mirror `writeClaudeSessionTitle`'s "best-effort, try/catch swallow" contract and the existing devin sqlite helper pattern from `discoverDevinSessions`/`deleteSessionFromStore` (both already in `pty-manager.ts`/`index.ts` from `cab1a0c2`) rather than reinventing sqlite access.
