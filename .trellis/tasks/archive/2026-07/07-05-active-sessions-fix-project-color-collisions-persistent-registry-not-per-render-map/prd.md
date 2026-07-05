# Active Sessions: fix project color collisions (persistent registry, not per-render map)

## Goal

Previous fix (`84d54130`, task 07-05 v1) didn't work: user reports different projects (posse, vps-fleet, Business) still render the same accent color in Active Sessions after rebuild + relaunch.

## Root cause

`appendProjectTagForCwd` (src/renderer/app.ts ~600) does:
```ts
const c = (projectColorAssignment?.get(key)) ?? projectColorForCwd(cwd);
```
`projectColorAssignment` is a **per-render** Map, built once at the top of `renderSessionList()` from `projects` + `sessionTitles` keys. If a key is missing from that map for ANY reason (timing, a row rendered outside the covered set, a project entry not yet merged into `projects` at build time, etc.), the code silently falls back to `projectColorForCwd(cwd)` — the **raw, non-deduped hash**. With only 8 palette buckets, raw-hash collisions across 3-8 real projects are common (birthday-paradox territory), not rare. This exactly matches the symptom: several visibly-different projects sharing one color.

Verified: build+install confirmed the new code IS present in the shipped `.app` (grepped the installed `app.asar`), and the app process was relaunched after install — so this isn't a stale-build issue. The bug is a logic gap: the per-render map's coverage can silently miss keys, and the fallback path reintroduces the exact collision the feature exists to prevent.

## Fix

Replace the fragile "build a complete map every render, hope it's complete" design with a **persistent, incrementally-built** color registry living directly inside `projectColorForCwd`:
* A module-level `Map<string, PaletteColor>` (`projectColorAssignments`) + `Set<number>` (`projectColorSlotsUsed`), never reset.
* On each call: if the key already has an assigned color, return it (stable forever, no re-render dependency).
* If not seen before: FNV-1a hash picks the preferred slot, walk forward to the nearest free slot (same dedupe logic as before, just applied incrementally instead of batch-per-render), record the assignment, return it.
* No per-render map, no `try/finally` scoping, no fallback path that can silently un-dedupe — `projectColorForCwd` is the single source of truth and is always authoritative by construction (a key either has a recorded color or gets one right now; there's no third state).

This is strictly simpler and removes the entire class of "map didn't cover this key" bugs, regardless of the exact reason coverage was incomplete.

## Requirements

* [ ] Remove `projectColorAssignment` (per-render map), `buildProjectColorAssignment()`, and the `_colorKeys` / `try { ... } finally { projectColorAssignment = null }` scaffolding from `renderSessionList()`.
* [ ] `projectColorForCwd(cwd)` becomes stateful: persistent Map + Set, incremental walk-forward assignment on first sight of a key.
* [ ] `appendProjectTagForCwd` reverts to calling `projectColorForCwd(cwd)` directly (no optional-chaining fallback needed — the function is now always authoritative).
* [ ] Same project (same normalized cwd) always gets the same color for the lifetime of the app process (stronger guarantee than before: not just "within an unchanged visible set" but permanently once assigned).
* [ ] Different projects get different colors while palette has capacity (8), assigned in first-seen order (not sorted — no need, since assignment no longer needs to be recomputed/compared across a whole set each render).

## Acceptance Criteria

* [ ] Manual: 3+ distinct real projects with live sessions → visually distinct chip colors.
* [ ] Manual: restart the app → same projects keep the same colors (persistent for the process lifetime; resets on relaunch since it's in-memory, which is fine — same as v1's guarantee).
* [ ] `npm run build:renderer` clean; tsc app.ts error count unchanged vs current baseline.
* [ ] `npm run build:mac` succeeds; verify via `asar extract` + grep that the new code (not the old per-render map) is present in the installed bundle before telling the user to check.

## Definition of Done

* Manual verification via running app AFTER confirming the installed bundle actually contains the fix (learned from this round: don't just trust the build succeeded — verify the artifact).
* Build/tsc green.

## Out of Scope

* Persisting colors to localStorage across restarts (in-memory-per-process is enough; not requested).
* Increasing palette size.

## Technical Notes

* File: `src/renderer/app.ts` only.
* Supersedes task `07-05-active-sessions-dedupe-project-colors-so-no-two-visible-projects-collide` (commit `84d54130`) — that approach is being replaced, not layered on top of.
