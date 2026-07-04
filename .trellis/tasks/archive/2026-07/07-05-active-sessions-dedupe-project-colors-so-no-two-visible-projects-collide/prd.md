# Active Sessions: dedupe project colors so no two visible projects collide

## Goal

In the Active Sessions section, no two currently-visible projects should share the same accent color. Today `projectColorForCwd` is a pure hash into an 8-color palette, so two different projects can hash to the same bucket and render identically — making them hard to tell apart (the exact problem the color feature was meant to solve).

## What I already know

* `projectColorForCwd(cwd)` (src/renderer/app.ts, added in `a0bcdd42`) returns a palette entry by FNV-1a hash of `normalizeCwd(cwd)`. Pure function, no awareness of other projects.
* Called from `appendProjectTagForCwd(row, cwd)` (app.ts ~534) which is invoked per flattened row in `collectActiveSessionRows` / `collectPinnedSessionRows` / search results.
* Palette `PROJECT_TAG_PALETTE` has 8 entries.
* `normalizeCwd` (app.ts:2106) is the stable project key.
* Collisions are inevitable with pure hashing once visible-project count approaches palette size, and can happen even with few projects.

## Requirements

* [ ] No two currently-visible projects in the Active Sessions section share the same accent color (until palette is exhausted).
* [ ] A given project's color stays stable within a single render pass and ideally across renders as long as the set of visible projects hasn't changed in a way that forces reassignment.
* [ ] When palette size < visible-project count, exhaustion is graceful (some collision unavoidable) — log/ignore, don't crash.
* [ ] No regression to Pinned section or search-result chips (they also use `appendProjectTagForCwd`).

## Acceptance Criteria

* [ ] Implement an assignment pass that, given the set of visible project keys, assigns each a distinct palette color (hash as the initial preference, then walk to the nearest free slot).
* [ ] Two different visible projects render different colors when palette has capacity.
* [ ] Same project keeps the same color across renders when the visible set is unchanged.
* [ ] `npm run build:renderer` clean; no new tsc errors vs baseline.
* [ ] Manual: open 3+ projects' live sessions, confirm all distinct colors; add/remove a project, confirm no flicker of unchanged projects' colors.

## Definition of Done

* Manual verification via running app.
* Lint / typecheck green (no new errors).
* Commit + (if requested) push.

## Technical Approach

Replace the pure `projectColorForCwd(cwd)` lookup at render time with a per-render assignment:
1. Keep `PROJECT_TAG_PALETTE` and the FNV-1a hash as the *preference* index for each project key.
2. Add a `buildProjectColorAssignment(projectKeys: string[]): Map<string, {bg,border,fg}>` that iterates keys in a stable order (sorted by key), assigns each its hash-preferred color if free, else walks forward through the palette to the next free slot (wrapping). Exhaustion → fall back to hash color (collision tolerated).
3. In the Active Sessions render path, collect the visible project keys first, build the assignment, then have `appendProjectTagForCwd` consult the assignment map instead of calling `projectColorForCwd` directly. Pass the assignment map through (or stash it in a module-level variable scoped to the render pass, reset at the top of `renderSessionList`).
4. To keep stability across renders when the set is unchanged: assignment is deterministic given the same key-set (sorted keys + hash preference), so identical sets produce identical assignments — no flicker.

Scope guard: Pinned section and search results also call `appendProjectTagForCwd`. Simplest non-regressing approach: make the assignment map cover ALL project keys rendered in the current `renderSessionList` pass (Active + Pinned + Projects sections), built once at the top of the render, so every chip is consistent and deduped within the pass.

## Out of Scope

* User-editable per-project color overrides.
* Increasing palette size (8 stays; dedupe handles it; if exhaustion is common, that's a separate follow-up).
* Persisting color assignment to localStorage (deterministic-per-set is enough).

## Technical Notes

* File: `src/renderer/app.ts` only.
* The assignment must be rebuilt each `renderSessionList` pass because the visible set changes (projects added/removed, sessions closed).
* Determinism: sort the visible keys before assignment so the same set always yields the same mapping regardless of iteration order.
