# Restore archive/delete session actions in sidebar

## Goal

Archive (soft-hide) and permanent-delete actions exist in `buildHistorySessionRow` but are CSS hover-only (`display:none` → `display:inline-flex` on `:hover`). On touch/mobile they are invisible. "Show Archived" toggle lives inside the project ··· context menu — also hard to discover. Restore discoverability on all surfaces.

## What I already know

- `buildHistorySessionRow` (app.ts:2533): archive `⊟/⊕` button + delete `🗑` button — both `.nav-session-action`, hidden until hover.
- `buildClosedSessionRow` (app.ts:2490): resume `↩` + delete `×` buttons, same hover-only pattern.
- CSS: `.nav-session-action { display: none }` / `.nav-session:hover .nav-session-action { display: inline-flex }` (styles.css:1541–1558).
- "Show Archived" toggle: inside `showProjectMenu` → `archivedOn` item (app.ts:3039–3044). Only reachable via ··· menu on the project row.
- `toggleArchiveSession` and `deleteHistorySession` functions are intact and work.
- The codex-style redesign (475178a) did NOT remove these buttons — it just didn't add touch affordance.

## Requirements

- Archive/delete buttons must be reachable on mobile (touch) without hover.
- "Show Archived" toggle should remain in ··· project menu (already discoverable enough).
- Behavior unchanged: archive = soft-hide (reversible), delete = permanent (confirm-gated).

## Open Questions

- (none blocking — see acceptance criteria question below)

## Acceptance Criteria

- [ ] On mobile/touch, user can archive a history session without needing hover.
- [ ] On mobile/touch, user can permanently delete a history session.
- [ ] On desktop, existing hover behavior still works.
- [ ] Archived sessions are hidden from list by default; "Show Archived" toggle still works.

## Definition of Done

- Lint / typecheck green
- Manual test: mobile + desktop both can archive and delete a session

## Technical Approach

**Option A (Recommended): Always-visible on touch, hover on desktop**
Add `@media (hover: none)` CSS rule: `.nav-session-action { display: inline-flex }` for touch devices. No JS change needed.

**Option B: Swipe-to-reveal action strip**
On touch, left-swipe a session row reveals action buttons. More complex, requires touch gesture handling.

**Option C: Long-press context menu**
Long-press opens a small popup with Archive/Delete options. Requires gesture detection JS.

## Decision

Option A — minimal change, CSS-only, preserves desktop hover UX, ships fast.

## Out of Scope

- Redesigning the archive/delete UX on desktop
- Moving "Show Archived" toggle elsewhere

## Technical Notes

- Files to change: `src/renderer/styles.css` (add `@media (hover: none)` rule)
- Possibly also widen the session row action area on touch so small buttons are tappable (min 44px touch target)
