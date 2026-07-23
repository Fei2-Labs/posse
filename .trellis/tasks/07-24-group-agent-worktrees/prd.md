# Group Agent Worktrees Under Canonical Projects

## Goal

Group sessions running inside Git linked worktrees beneath the canonical/root
repository project in Posse's sidebar, while preserving each session's real
worktree cwd for PTY, file, resume, and Git operations.

## What I Already Know

- Copilot worktrees currently appear as separate top-level projects named after
  generated worktree folders.
- Real examples reproduce the issue:
  - `.../copilot-worktrees/skill-genie/feifei-kosonen-volvo-legendary-robot`
    should group under `/Users/clarezoe/My Apps/skill-genie`.
  - `.../copilot-worktrees/faithloom/feifei-kosonen-volvo-vigilant-tribble`
    should group under `/Users/clarezoe/My Apps/faithloom`.
- `git rev-parse --path-format=absolute --git-dir --git-common-dir
  --is-bare-repository` resolves both examples correctly.
- Posse's current Copilot database mapping is empty against the installed schema:
  `workspaces` has no `path` column and `worktrees` joins directly by
  `project_id`, not through a `workspace_id`.
- The current backend remap only targets Copilot history. Renderer live and
  closed sessions still compare their raw cwd directly to project paths.

## Requirements

- Use Git repository metadata, not generated folder names or remote URLs, as the
  authoritative worktree identity.
- Keep checkout cwd and canonical project grouping path as separate concepts.
- Apply canonical grouping consistently to discovered history, live PTYs,
  restored sessions, closed sessions, and explicitly tracked folders.
- Support every agent using a Git worktree, not only Copilot.
- Resolve remote worktree roots on the remote host and group remote live/history
  sessions with the same semantics as local sessions.
- Preserve current behavior for non-Git folders, normal checkouts, separate
  clones of the same remote, and missing/deleted paths.
- Avoid shell interpolation; paths with spaces must work.

## Acceptance Criteria

- [ ] The two real Copilot worktree examples group under `skill-genie` and
      `faithloom`, respectively.
- [ ] A normal checkout groups under itself.
- [ ] A non-Git folder remains unchanged.
- [ ] Separate clones with the same remote remain separate projects.
- [ ] Live, closed, restored, and historical sessions use the same project key.
- [ ] Remote worktree sessions group under the remote canonical project without
      executing Git against remote paths on the desktop.
- [ ] Session resume and PTY cwd remain the actual worktree path.
- [ ] A regression test exercises canonical-root resolution and bucketing.
- [ ] TypeScript build passes.

## Definition of Done

- Tests added at the correct service/bucketing seam.
- Targeted tests and TypeScript build pass.
- External research and project specs are included in implementation/check
  context.
- New reusable behavior is documented in the relevant Trellis spec.

## Research References

- [`research/worktree-canonical-root.md`](research/worktree-canonical-root.md) -
  Git common-dir is the portable repository identity; checkout cwd remains
  separate.

## Hypotheses

1. **Database schema drift is the immediate history-session cause.** If true,
   both current Copilot mapping queries fail and no worktree path is remapped.
2. **Raw renderer cwd comparison is the live/closed-session cause.** If true,
   fixing only the Copilot DB query still leaves active and closed worktree
   sessions under separate top-level projects.
3. **Canonicalization is applied too late/inconsistently.** If true, resolving a
   common project key once in the main process and returning alias metadata will
   remove duplicate project entries without changing execution cwd.
4. **Stale localStorage project entries can preserve old top-level worktrees.**
   If true, canonical refresh must coalesce or remove aliases already saved in
   `posse_projects`.

## Technical Approach

Recommended direction:

- Add a reusable main-process Git canonical-root resolver based on
  `--git-dir`/`--git-common-dir`, with safe fallback and caching.
- Canonicalize backend buckets for all agents.
- Return raw checkout aliases with each canonical backend project so the
  renderer can map live/closed raw cwd values and clean stale saved worktree
  project entries without changing session execution cwd.
- Add a token-authenticated remote batch endpoint that resolves canonical roots
  on the remote host; `RemoteServerBackend` uses it before remote bucketing.
- Keep the Copilot database map only as an optional hint/fallback, updated for
  schema compatibility rather than treating it as the source of truth.

## Expansion Sweep

- Future: cache/in-flight deduplication should support large multi-agent history
  scans without spawning Git on every render.
- Related: remote-host project lists use the same resolver through a server-side
  batch endpoint and never run local Git against remote paths.
- Edge cases: bare repositories, submodules, symlinks, vanished worktrees,
  nested cwd, and older Git without `--path-format=absolute`.

## Out of Scope

- Guessing repository identity from Copilot folder naming.
- Grouping independent clones by remote URL.
- Folding Git submodules into their superproject; submodules remain distinct
  projects.
- Changing where sessions execute or where files are read/written.
- Reproducing proprietary Copilot, Claude, or Cursor sidebar internals.
