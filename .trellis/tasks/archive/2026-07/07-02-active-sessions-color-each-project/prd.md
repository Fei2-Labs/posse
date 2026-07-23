# Active Sessions: color each project

## Goal

Make every project in the Active Sessions section visually easier to distinguish by giving each project a stable, high-contrast color treatment. The current same-color project tags are hard to scan when multiple live sessions are open.

## What I already know

* User wants projects in Active Sessions to be easy to tell apart.
* User does not care about the exact color source as long as it is stable and readable.
* The section already renders a flattened list of live sessions in `src/renderer/app.ts` and adds a project chip via `appendProjectTag()` / `appendProjectTagForCwd()`.
* Existing project chips are currently muted gray outlined chips in `src/renderer/styles.css:1523-1539` (`.nav-session-project-tag`).
* The section already has stable project identity via `normalizeCwd(sessionCwds.get(id) || '')` and `projectNameForCwd(cwd)`.
* Repo already uses stable project-related state/persistence patterns in the sidebar and has a project color precedent in the project list (`projectSortMode`, `projectLastActiveMs`, etc.).

## Assumptions (temporary)

* The project color should be stable across restarts.
* Color should be derived from project identity, not from render order.
* We should keep text readable by using a palette with good contrast and not rely on pure random colors.

## Open Questions

* None blocking: stable per-project color is the right choice.

## Requirements (evolving)

* Each project shown in Active Sessions must get a stable color treatment.
* The color must be derived from project identity so the same project keeps the same color across restarts.
* Different projects should usually look different enough to separate at a glance.
* The chip still must fit inside the current row layout and not break truncation/ellipsis.
* Readability matters more than fancy color variety.

## Acceptance Criteria

* [ ] Project tags in Active Sessions use a stable project-derived color.
* [ ] Same project keeps same color across rerenders/restarts.
* [ ] Different projects are visually distinct enough to scan.
* [ ] Tag text remains readable in dark and light sidebar themes.
* [ ] Existing Active Sessions row layout still works.

## Definition of Done

* Tests added/updated where practical.
* Lint / typecheck / build green.
* Docs/spec updated if behavior changes.

## Technical Approach

Use project identity already available in the row render path (`normalizeCwd(sessionCwds.get(id) || '')`) to choose a color from a stable palette. Prefer a deterministic hash over project path rather than random generation so colors do not drift on refresh.

For the UI, replace the current neutral chip styling in `.nav-session-project-tag` with a color-aware treatment that still preserves contrast and truncation. The safest version is:

* chip background = stable project color with muted opacity or darkened variant
* chip border = same family or slightly stronger contrast
* chip text = readable foreground chosen for contrast

## Decision (ADR-lite)

**Context**: User wants project tags easier to tell apart; exact source of color is flexible, but stability matters.

**Decision**: Use a stable project-path-derived color, not random per render. Render it in the project chip so every project gets a distinct readable accent.

**Consequences**: Colors stay predictable across app restarts. Some projects may still collide if palette is small, but that is acceptable for this task.

## Out of Scope

* Changing Active Sessions sort order.
* Changing project list colors outside Active Sessions.
* Per-user custom color assignments.
* Persisting colors in config/localStorage unless needed for a good stable derivation.

## Technical Notes

* Files likely touched: `src/renderer/app.ts`, `src/renderer/styles.css`.
* Existing project chip code path: `appendProjectTagForCwd()`.
* Existing chip class: `.nav-session-project-tag`.
* Use stable project identity, not title text.
