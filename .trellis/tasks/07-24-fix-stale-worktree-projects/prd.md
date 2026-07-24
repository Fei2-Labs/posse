# Fix Stale Worktree Project Migration

## Goal

Remove stale Copilot worktree top-level rows after the worktree directory has
been deleted by mapping both historical sessions and persisted sidebar folders
to the canonical root project.

## What I Already Know

- The installed app is version `1.2.17624840`; this is not an old-build issue.
- Posse localStorage still contains the exact stale generated worktree paths
  shown in the screenshot.
- All five screenshot worktree directories are now missing.
- Copilot `session-store.db` still has the historical sessions and records a
  `repository` value such as `Fei2-Labs/posse` or `Fei2-Labs/skill-genie`.
- `data.db.workspace_checkout_bindings` preserves `checkout_path -> repo_path`
  for several deleted worktrees, including paths no longer present in
  `worktrees`.
- For other deleted worktrees, `session-store.repository` uniquely matches a
  `data.db.projects` GitHub owner/repo and canonical `main_repo_path`.
- The first fix remapped discovered sessions, but canonicalized `extraFolders`
  independently. A stale localStorage path therefore recreated a second bucket.

## Ranked Hypotheses

1. **Confirmed**: stale `extraFolders` bypass the Copilot fallback map and
   recreate deleted worktree buckets after history sessions are remapped.
2. **Confirmed**: `worktrees` alone is incomplete; durable
   `workspace_checkout_bindings` contains additional checkout-to-root mappings.
3. **Confirmed**: deleted workspace rows can still be mapped safely when a
   Copilot session's repository uniquely matches one registered project.
4. **Possible**: stale persisted project entries with no session and no metadata
   should remain untouched to avoid deleting user-added missing folders.

## Requirements

- Apply one canonical mapping pipeline to discovered session cwd values and
  `extraFolders`.
- Include Copilot `workspace_checkout_bindings.checkout_path -> repo_path`.
- Include session `repository -> project main_repo_path` only when the project
  match is unique.
- Preserve generated worktree paths as aliases so renderer state migrates.
- Do not infer identity from generated folder names.
- Do not delete unknown missing folders that lack trustworthy metadata.

## Acceptance Criteria

- [ ] The five screenshot paths map to `posse`, `skill-genie`, or `keel`.
- [ ] A deleted worktree represented in `workspace_checkout_bindings` maps to
      its `repo_path`.
- [ ] A deleted worktree absent from bindings maps through a unique
      session-repository/project match.
- [ ] The same stale path supplied as both a historical session cwd and an
      `extraFolder` produces one canonical bucket.
- [ ] Unknown missing manually-added folders remain unchanged.
- [ ] Existing live worktree, normal checkout, non-Git, and remote behavior
      remains intact.

## Technical Approach

- Extend Copilot session discovery to retain repository identity internally.
- Extend Copilot metadata mapping with checkout bindings and unique
  owner/repository project matches.
- Apply the fallback map before Git resolution to both session cwd values and
  extra folders; Git remains authoritative for paths that still exist.
- Add a regression seam/test for deleted worktree + stale extra folder
  coalescing.

## Decision

Use only explicit Copilot metadata for deleted paths. Folder-name heuristics are
not allowed, and unknown missing folders are preserved.

## Out of Scope

- Deleting arbitrary missing folders from user project history.
- Grouping separate clones solely by remote URL.
- Changing PTY/resume/file cwd.

