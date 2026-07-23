# Active Sessions: sort by Project and Recent (closes #53)

## Goal

Add a section-local sort toggle to the sidebar **Active Sessions** section (Project vs Recent), independent from the main Projects-section sort control, so users can either see newest activity first or cluster sessions by owning project.

## What I already know (from issue #53 + repo inspection)

* Follow-up to #28 (Active Sessions flattened section, already shipped).
* `collectActiveSessionRows(activeId)` — `src/renderer/app.ts:3279-3296` — flattens all live sessions across projects, currently hardcoded `out.sort((a, b) => b.time - a.time)` (time desc only).
* `renderSessionList()` renders the Active Sessions header/block at `src/renderer/app.ts:3340-3364` (shifted slightly from issue's line numbers due to an unrelated dot-render fix landed earlier today).
* Existing precedent to mirror for the section-local control:
  * `ProjectSortMode` type + `PROJECT_SORT_STORAGE_KEY` + `loadProjectSort()` — `app.ts:296-303`
  * `sortProjects()` — `app.ts:697-707`
  * Toolbar sort button wiring (click cycles mode, persists to localStorage, calls `invalidateProjectOrder()` + `renderSessionList()`) — `app.ts:1774-1781`
  * Static HTML button precedent: `<button id="project-sort" type="button" title="Sort projects">Recent</button>` — `src/renderer/index.html:153`
* Project identity for grouping: `sessionCwds.get(id)` + `normalizeCwd()` (same key used by `projectNameForCwd`/`appendProjectTag`, `app.ts:509-521`) — must group by this, not by title text (explicit issue requirement).
* Per-section collapse persistence already exists via `collapsedSections` (`toggleSectionCollapsed('active')`, `app.ts:3359`) — same pattern to follow for a new section-local sort-mode toggle, but as its own localStorage key (not reusing collapse state).

## Requirements

* [ ] Active Sessions header exposes a section-local sort control with at least `Project` and `Recent`.
* [ ] Default remains equivalent to current `Recent` ordering unless a persisted mode says otherwise.
* [ ] `Recent` mode: rows ordered by `sessionUpdateTimes` descending (current behavior, unchanged).
* [ ] `Project` mode: live sessions grouped by owning project (via `normalizeCwd(sessionCwds.get(id))`); within each project group, rows ordered by latest activity (`sessionUpdateTimes`) descending. Groups themselves ordered by each group's most-recent activity descending (keeps the pattern self-consistent with `sortProjects`'s "Recent" semantics — no separate group-order control needed).
* [ ] Switching Active Sessions sort mode does not affect the Projects section sort/order.
* [ ] Active Sessions sort mode persists across app restarts (separate localStorage key from `PROJECT_SORT_STORAGE_KEY`).
* [ ] Existing row actions unchanged: switch session, pin, rename, close.
* [ ] Existing Active Sessions collapse behavior unchanged.
* [ ] Pinned live sessions still appear in both Active Sessions and Pinned (no dedup change).

## Acceptance Criteria

* [ ] New `ActiveSessionSortMode = 'recent' | 'project'` type + `ACTIVE_SESSION_SORT_STORAGE_KEY` + `loadActiveSessionSort()`/`activeSessionSortMode` module state, mirroring `ProjectSortMode`.
* [ ] `collectActiveSessionRows(activeId)` sorts per `activeSessionSortMode` instead of the hardcoded time-desc sort.
* [ ] A small sort toggle button rendered inside the Active Sessions header (next to the existing label, not affecting the collapse click target — collapse click is on the header; sort button must `stopPropagation` on its own click so it doesn't also toggle collapse).
* [ ] Clicking the toggle cycles `recent ↔ project`, persists to localStorage, calls `renderSessionList()`.
* [ ] Manual verification: open 3+ live sessions across 2+ projects, toggle Active Sessions sort, confirm Project mode clusters by project (grouped, most-recently-active project group first) and Recent mode matches current behavior; confirm Projects-section sort is unaffected; restart app, confirm persisted mode holds.
* [ ] No new lint/typecheck errors (baseline currently has pre-existing unrelated errors in this file — compare count before/after).
* [ ] `npm run build:renderer` builds clean.

## Definition of Done

* Manual verification via the running app (sidebar behavior/visual, no dedicated test harness for this UI).
* Lint / typecheck green (no new errors vs baseline).
* GitHub issue #53 closed via commit message (`closes #53`).

## Technical Approach

1. **State** (near `ProjectSortMode` at `app.ts:296-303`):
   ```ts
   type ActiveSessionSortMode = 'recent' | 'project';
   const ACTIVE_SESSION_SORT_STORAGE_KEY = 'posse_active_session_sort';
   function loadActiveSessionSort(): ActiveSessionSortMode {
     const raw = localStorage.getItem(ACTIVE_SESSION_SORT_STORAGE_KEY);
     return raw === 'project' ? 'project' : 'recent';
   }
   let activeSessionSortMode: ActiveSessionSortMode = loadActiveSessionSort();
   ```
2. **Sorting** — rewrite `collectActiveSessionRows` (`app.ts:3279-3296`) to also capture each row's `projectKey` (`normalizeCwd(sessionCwds.get(id) || '')`), then:
   * `recent`: unchanged `time desc` sort.
   * `project`: compute each project group's max `time`, sort groups by that desc, then sort rows within a group by `time` desc, then flatten.
3. **Header UI** — in the Active Sessions header block (`app.ts:3345-3364`), add a small button (mirroring `#project-sort` styling/pattern but with its own id/class, e.g. `active-session-sort`) appended to `header`, with a click handler that does `e.stopPropagation()` (so it doesn't also fire `toggleSectionCollapsed('active')`), cycles the mode, persists, and calls `renderSessionList()`.
4. Keep `refreshLiveDotInPlace` (added earlier today) and the title-edit early-return path unaffected — this task only touches `collectActiveSessionRows` and the Active Sessions header block.

## Decision (ADR-lite)

**Context**: Issue leaves group ordering under Project mode unspecified beyond "cluster by project, most-recent-first within group."
**Decision**: Order the project groups themselves by each group's most-recent activity, descending — consistent with how "Recent" already means in this codebase (`projectLastActiveMs`), and avoids needing a third control just for group order.
**Consequences**: If a user wants alphabetical project grouping, that's out of scope for this task (not requested); can be a future follow-up if asked.

## Out of Scope

* Changing the Projects-section sort control or its persistence.
* Deduping pinned sessions that appear in both Pinned and Active Sessions (explicitly called out as intentional in the issue).
* Alphabetical-by-project-name ordering of groups (only recency-of-group is implemented; see ADR).

## Technical Notes

* File: `src/renderer/app.ts` only (no HTML/CSS changes strictly required — button can be created in JS like other dynamic header icons; if a static HTML anchor point is easier, `src/renderer/index.html` may get a placeholder, but default to JS-built like the rest of the header per `app.ts:3347-3358`).
* Related: #28 (Active Sessions section), #29 (project tag), #24 (Projects sort discoverability).
* GitHub repo: `Fei2-Labs/posse` (no hyphen) — file/close issues there, never the archived `posse-`.
