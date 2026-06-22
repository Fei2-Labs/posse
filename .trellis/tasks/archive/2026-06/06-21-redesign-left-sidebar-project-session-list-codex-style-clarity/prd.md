# Redesign left sidebar: project/session list (Codex-style clarity)

## Problem
The left sidebar is hard to scan; you can't quickly locate a project/session.
Root cause: each project nests an extra **agent-group layer** (Claude/Codex/Kiro
collapsible headers), so sessions sit 3 levels deep and different agents are
mixed together in one long list. Selection state is a thin left border (weak),
density is cramped.

## Goal
Codex-style clarity: shallow hierarchy, agents not mixed, fast scanning.

## Decisions (confirmed with user)
- **Agents become top filter TABS** (All / Claude / Codex / Kiro / Copilot …),
  not per-project nested groups. Selecting a tab scopes the whole list to that
  agent so it isn't "拉开特别长" and agents aren't mixed.
- Inside the list: **project → sessions directly** (2 levels). No agent
  sub-headers. In the "All" tab, each session row carries a small agent color
  tag/dot to distinguish; in a specific-agent tab, no tag needed.
- Adopt Codex visuals: full-row **rounded selection box**, airier spacing,
  right-aligned relative time, status dot.
- Hover preview card (project + git branch) — OUT of scope this round.
- Scope: **desktop renderer only** (src/renderer). Mobile redesign separate.

## Scope of change
- index.html: add agent filter tab strip above the existing search/sort toolbar.
- app.ts: add `activeAgentTab` state (persisted); build the tab strip (only show
  tabs for agents that have sessions, plus All); filter `collectProjectSessions`
  output by active tab; remove the agent-group header rendering, render sessions
  directly under the project; add inline agent tag for "All". Hide projects with
  zero sessions under the active tab.
- styles.css: tab strip styles; rounded selection; spacing; session-row agent tag.

## Keep working (no regressions)
- Pinned section, search + clear, sort (Recent/Name), expand/collapse persistence,
  live/closed/history session distinction, status dots, archive/delete/rename
  hover actions, active-session highlight, file-tree root selection on project click.

## Acceptance
- Switching agent tabs filters the list; only that agent's sessions show.
- A project with no sessions for the active tab is hidden.
- Selecting a project/session shows a clear rounded highlight.
- No agent-group collapsible headers remain.
- Build installs to /Applications; version bumped; verified.
