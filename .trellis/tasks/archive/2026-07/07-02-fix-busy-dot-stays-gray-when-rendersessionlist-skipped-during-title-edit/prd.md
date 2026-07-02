# Fix: busy dot stays gray when renderSessionList skipped during title-edit

## Goal

Session status dot must reliably turn pulsing-orange the moment a session flips busy, even if `renderSessionList()` is silently skipped due to an in-progress title edit elsewhere in the sidebar.

## What I already know

* Reported symptom: terminal spinner "Flummoxing…" active, dot showed static gray instead of pulsing orange.
* Confirmed via live `STATUS_DBG` log (`~/.posse-debug/status.log`): `WORKING_RE` detection and `sessionBusy` Set flip to `true` correctly on every spinner chunk (549/549 matches for this repro). Detection layer is NOT the bug.
* Root cause: `src/renderer/app.ts:3283-3290` — `renderSessionList()` early-returns (no-op) when `editingTitleId` is set and its input is focused (user is renaming some session's title). This guard has no retry/pending mechanism.
* The busy-transition call sites (`app.ts:4961`, `5017`, `5044`) are one-shot/transition-guarded (`if (!prevBusy || prevUnread) renderSessionList();`) — not idempotent, not re-invoked later.
* If a busy transition's render call lands while any title is mid-edit, that repaint is silently dropped. The dot stays stale (gray) until the unrelated 60s relative-time timer (`app.ts:5321`) forces a full repaint and self-heals — explains "briefly gray, then fixes itself" rather than permanently broken.
* `renderSessionList` (`app.ts:3275`) does a full DOM rebuild every call (`innerHTML = ''` then rebuild), reading `sessionBusy`/`sessionUnread`/`sessionWaiting` fresh — no caching/staleness bug inside the render itself.
* CSS (`styles.css:1560-1576`) and dot-building logic (`app.ts:2780-2791`, `sessionStatusColor` at `2752-2757`) are correct — orange color + pulse class applied whenever the function actually runs and `sessionBusy.has(id)` is true.

## Requirements

* [ ] `renderSessionList()` early-return (title-edit guard) must not permanently drop a pending repaint.
* [ ] When the title-edit ends (commit / blur / Escape), if a render was skipped while editing, a repaint must fire immediately after.
* [ ] No regression to existing title-edit UX (input must not lose focus / re-render mid-keystroke).

## Acceptance Criteria

* [ ] Add a `pendingRender` flag (or equivalent) set on the `renderSessionList()` early-return path (`app.ts:3283-3290`).
* [ ] On title-edit commit/blur/Escape (`app.ts:2649`, `2654`), check the flag and call `renderSessionList()` again if set, then clear it.
* [ ] Manual repro: start a session, begin editing another session's title, cause the first session to go busy (spinner active), confirm dot stays gray while editing, then turns orange immediately on ending the edit (not waiting for the 60s timer).
* [ ] No lint/typecheck regressions.

## Definition of Done

* Manual verification via the app (build + run), since this is UI/visual behavior — no dedicated test harness for terminal dot rendering exists.
* Lint / typecheck green.

## Technical Approach

Minimal, localized fix in `src/renderer/app.ts`:
1. Module-level `let sessionListRenderPending = false;` near the other status Sets.
2. In `renderSessionList()`'s early-return branch (`~3283-3290`), set `sessionListRenderPending = true;` before returning.
3. At the title-edit exit points (`~2649`, `~2654`), after clearing `editingTitleId`, check `if (sessionListRenderPending) { sessionListRenderPending = false; renderSessionList(); }`.

## Out of Scope

* Broader refactor of `renderSessionList` to a patch/diff-based renderer (full-rebuild-per-call stays as is).
* Any change to `WORKING_RE` detection or the echo/mouse/resize/replay suppression windows (confirmed working correctly).

## Technical Notes

* Files: `src/renderer/app.ts` only (single file, ~3 small edits).
* Live-debug flag stays enabled at `~/.posse-debug/ON` for verification; can be removed by the user afterward (`rm ~/.posse-debug/ON`).
* Related history: this bug sits in the same status-dot code area as issues #34/#41/#44/#45/#46/#52/#54 — all previously fixed detection-layer edge cases. This is a distinct render-scheduling bug, not a repeat of those.
