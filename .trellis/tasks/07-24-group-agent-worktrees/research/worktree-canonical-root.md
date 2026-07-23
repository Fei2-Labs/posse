# Research: Worktree Canonical Root

- **Query**: How comparable tools map Git linked worktrees to a canonical/root repository for sidebar grouping, especially Copilot CLI worktrees under `~/My Apps/copilot-worktrees/<repo>/<generated-name>`.
- **Scope**: mixed (Posse source, public tool source/docs, authoritative Git docs)
- **Date**: 2026-07-24

## Findings

### Executive conclusion

The reliable identity is Git's **common directory**, not the worktree path, folder name, branch, or remote URL:

```text
git -C <cwd> rev-parse --path-format=absolute --git-dir --git-common-dir
```

In a normal checkout, `--git-dir` and `--git-common-dir` identify the same `.git` directory. In a linked worktree, `--git-dir` is the per-worktree administrative directory (normally `<main>/.git/worktrees/<id>`) while `--git-common-dir` is the shared `<main>/.git`. Therefore, the realpath of `--git-common-dir` is the stable **group key**, and, for an ordinary non-bare repository whose common directory ends in `.git`, its parent is the canonical/main checkout root.

`git worktree list --porcelain -z` is the authoritative bulk/enumeration companion: Git documents that the main worktree is first, the format is stable for scripts, and `-z` safely handles unusual path characters. It should not replace `--git-common-dir` as identity, because a list can contain missing/prunable paths and a bare repository has no main checkout.

### Files found in Posse

| File Path | Description |
|---|---|
| `src/main/index.ts:1626-1722` | `discoverCopilotWorktreeProjectMap()` reads `~/.copilot/data.db` and maps workspace/worktree paths to `projects.main_repo_path`. |
| `src/main/index.ts:1819-1871` | `buildProjectsList()` applies that map only when `s.agent === 'copilot'`, then buckets by the resulting path. |
| `src/main/index.ts:2589-2612` | Existing `git:branch` IPC demonstrates safe `execFile('git', ['-C', cwd, ...])`, timeout, and non-throwing fallback. |
| `src/renderer/app.ts:3218-3261` | `collectProjectSessions()` compares live and closed session cwd values directly to the project path after lexical normalization. |
| `src/preload/index.ts:69-70` | Existing main/renderer Git IPC bridge for branch lookup. |

Current data flow is therefore split: historical Copilot sessions can be remapped from a private local database, but live PTYs and other agents retain their worktree cwd. Git-native canonicalization needs to be applied consistently to every cwd used as a project key, regardless of agent.

### Comparable approaches

| Tool | Approach | Sidebar/project behavior relevant to Posse |
|---|---|---|
| VS Code Git extension | `Git.getRepositoryDotGit()` runs `rev-parse --git-dir --git-common-dir` in one subprocess, absolutizes relative output, and stores `commonPath` only when it differs from `path` ([`extensions/git/src/git.ts:560-592`](https://github.com/microsoft/vscode/blob/2982f951552e94f38cd972764ae94c1d90c41da3/extensions/git/src/git.ts#L560-L592)). | VS Code detects linked worktrees but exposes each as a separate Source Control repository. Its docs state this explicitly; `Model.checkForWorktrees()` scans each listed worktree as a repository ([`model.ts:806-828`](https://github.com/microsoft/vscode/blob/2982f951552e94f38cd972764ae94c1d90c41da3/extensions/git/src/model.ts#L806-L828), [docs](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees)). This is detection, not parent-child sidebar grouping. |
| VS Code Copilot display heuristic | `isCopilotWorktreeFolder()` recognizes basenames beginning `copilot-` or `agents-` ([`util.ts:870-872`](https://github.com/microsoft/vscode/blob/2982f951552e94f38cd972764ae94c1d90c41da3/extensions/git/src/util.ts#L870-L872)); the artifact provider uses it only to select a `chat-sparkle` icon ([`artifactProvider.ts:171-184`](https://github.com/microsoft/vscode/blob/2982f951552e94f38cd972764ae94c1d90c41da3/extensions/git/src/artifactProvider.ts#L171-L184)). | Folder naming is presentation metadata, not repository identity. It is insufficient for Posse's `<repo>/<generated-name>` layout and must not drive grouping. |
| OpenAI Codex | `resolve_root_git_project_for_trust()` walks upward to `.git`; if `.git` is a gitfile, it resolves its `gitdir:` target, verifies the `worktrees` segment, then climbs to the main root without invoking Git ([`codex-rs/git-utils/src/info.rs:788-838`](https://github.com/openai/codex/blob/05cdbb3ae04a839ffc465facdc0e0f207e37dbe0/codex-rs/git-utils/src/info.rs#L788-L838)). Config loading keeps both checkout root and canonical repo root, using the latter for shared trust/hooks ([`config/src/loader/mod.rs:925-935`](https://github.com/openai/codex/blob/05cdbb3ae04a839ffc465facdc0e0f207e37dbe0/codex-rs/config/src/loader/mod.rs#L925-L935)). | Demonstrates a useful distinction: preserve the actual checkout cwd for execution while using canonical repo identity for shared project state/grouping. Its filesystem parser assumes standard linked-worktree layout; invoking Git is more robust for Posse. |
| Claude Code (public repository component) | The official `security-guidance` plugin uses `rev-parse --git-common-dir`, resolves relative output against the repo root, and intentionally stores review state per clone across worktrees ([`gitutil.py:144-176`](https://github.com/anthropics/claude-code/blob/41a4c0f77144c5beb5f5f000a89cff379c680606/plugins/security-guidance/hooks/gitutil.py#L144-L176)). | Confirms common-dir identity for state shared by linked worktrees. The public repository does not expose Claude Code's proprietary sidebar implementation. |
| oh-my-claudecode | `getProjectIdentifier()` runs `rev-parse --path-format=absolute --git-common-dir`; it accepts only a common path ending in `.git`, explicitly skips `.git/modules/...` submodules and bare repos, and derives the primary root with `dirname()` ([`worktree-paths.ts:497-530`](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/1ee8f49175a91c8fbfb9e93310331dfc45fc0dbd/src/lib/worktree-paths.ts#L497-L530)). It also compares real common dirs to decide whether two sibling paths are linked worktrees ([lines 1266-1325](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/1ee8f49175a91c8fbfb9e93310331dfc45fc0dbd/src/lib/worktree-paths.ts#L1266-L1325)). | Closest open-source identity/grouping pattern; importantly guards against treating submodule or bare-repo common dirs as `<root>/.git`. |
| myrlin-workbook | `resolveTdRepoDir()` runs `git -C inferredDir rev-parse --git-common-dir`, resolves relative output, and returns `dirname(commonDir)` when it exists ([`src/web/server.js:1003-1035`](https://github.com/therealarthur/myrlin-workbook/blob/e2e76248f08e74878caf01851fedc0884cb33a2d/src/web/server.js#L1003-L1035)). | Minimal Node implementation for rebucketing workspace state. It lacks explicit bare/submodule guards, so the OMC pattern is safer. |
| Cursor | Public worktree documentation is routed at [Cursor worktrees](https://docs.cursor.com/en/configuration/worktrees), but Cursor's implementation is not open source and no public canonical-root function was found. | No source-backed claim can be made about how its sidebar keys or groups worktrees. |

### GitHub Copilot conventions that are publicly verifiable

- The public `github/copilot-cli` changelog says `/worktree` (alias `/move`) creates a new Git worktree, switches into it, and moves uncommitted changes ([`changelog.md:707-714`](https://github.com/github/copilot-cli/blob/7e26a80d9a2228d6606d48545f7b4d523128b845/changelog.md#L707-L714)).
- No public Copilot CLI source or documentation found in this search specifies `~/My Apps/copilot-worktrees/<repo>/<generated-name>` or guarantees the generated-name format. Posse should treat the observed path as an instance detail and use Git metadata.
- GitHub's separately documented Copilot cloud coding agent runs in an ephemeral GitHub Actions environment ([GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)); that does not establish a local Copilot CLI worktree convention.
- Posse's local `~/.copilot/data.db` mapping remains useful as an optional product-specific hint, but Git metadata is the portable authority.

### Authoritative Git primitives

- [`git rev-parse`](https://git-scm.com/docs/git-rev-parse): `--git-dir` is relative to the current working directory when relative; `--git-common-dir` prints `$GIT_COMMON_DIR` or falls back to `$GIT_DIR`; `--path-format=absolute` makes affected paths absolute and canonical; `--is-bare-repository` identifies bare repositories; `--show-toplevel` errors when there is no working tree.
- [`git worktree`](https://git-scm.com/docs/git-worktree): a non-bare repository has one main worktree and zero or more linked worktrees; linked worktrees share repository data except per-worktree files. `worktree list` lists the main worktree first, then linked worktrees.
- `git worktree list --porcelain` is documented as stable across Git versions and user configuration; Git recommends combining it with `-z`. Records include `worktree <path>`, `HEAD`, and one of `branch`, `detached`, or `bare`, with optional `locked`/`prunable`.

Example:

```text
worktree /Users/clarezoe/My Apps/posse
HEAD <oid>
branch refs/heads/main

worktree /Users/clarezoe/My Apps/copilot-worktrees/posse/<generated-name>
HEAD <oid>
branch refs/heads/<agent-branch>
```

Do not split shell-rendered output on spaces. With `--porcelain -z`, parse NUL-terminated fields and blank-record boundaries according to Git's documented format.

### Recommended Electron/Node algorithm

Keep two concepts:

1. **checkout root/cwd**: where the PTY and file operations run;
2. **canonical project key/root**: where sidebar sessions are grouped.

For each distinct session cwd:

1. Validate a nonempty path, make it absolute, and use `fs.realpath()` when possible (retain a normalized lexical fallback if the path vanished).
2. Run asynchronously with no shell:

   ```ts
   execFile('git', [
     '-C', cwd,
     'rev-parse',
     '--path-format=absolute',
     '--git-dir',
     '--git-common-dir',
     '--is-bare-repository',
   ], { timeout: 2000, windowsHide: true })
   ```

3. On nonzero exit, timeout, missing Git, or malformed output, return the normalized input cwd unchanged.
4. Realpath the returned common directory when possible. Use it as the **repository group identity**. This keeps separate clones separate even when remotes match.
5. For a non-bare repository, if `basename(commonDir) === '.git'` and the path is not under a `.git/modules/` segment, use `dirname(commonDir)` as the canonical display/project root. Otherwise use `git rev-parse --show-toplevel` as the checkout root without climbing to an unrelated parent.
6. Optionally run `git worktree list --porcelain -z` once per unseen common-dir identity to populate a reverse map for all linked paths. Trust the first record as the main worktree only when it is non-bare, exists, and is not marked prunable. This is useful for bulk sidebar refreshes, not required for a single cwd.
7. Apply the same canonicalization before all bucket comparisons: historical discovered sessions, live `sessionCwds`, closed sessions, extra folders, and project paths. Preserve the original cwd for resume/PTY behavior.

Cache both positive and negative results in the Electron main process. A bounded LRU/TTL cache keyed by real absolute cwd (plus a second map keyed by real common dir) avoids one process per render. Deduplicate concurrent lookups with in-flight promises and cap subprocess concurrency during a large history refresh. Invalidate/expire when a cwd disappears or after worktree add/remove operations.

### Pitfalls and exact handling

| Pitfall | Handling |
|---|---|
| Paths with spaces (the reported `~/My Apps/...` case) | Use `execFile` with an argument array and `-C`; never interpolate a shell command. Use `--porcelain -z` when parsing lists. |
| Symlinks, macOS `/private`, Windows casing/UNC | Compare `realpath` results where available, then pass through Posse's platform normalization. Keep lexical fallback for deleted paths. |
| Nested cwd | `git -C <nested>` discovers the containing repository. `--path-format=absolute` avoids resolving relative output against the wrong directory. |
| Bare repository | The common dir is the repository itself; `dirname(commonDir)` would incorrectly select its parent. Keep common dir as identity, but there is no canonical working-tree root. Use a surviving linked checkout or current cwd as display fallback. |
| Submodule | Its common dir can be `<super>/.git/modules/<name>`; blindly taking `dirname()` is wrong. Treat the submodule checkout as its own project unless product policy explicitly says otherwise. |
| Separate clones sharing a remote | Never group by normalized remote URL. Their common dirs differ and should remain distinct projects. |
| Missing/moved main worktree | `worktree list` can report a missing/prunable path, and Git documents `worktree repair` for moved metadata. Do not return a nonexistent main path merely because it is first; retain common-dir identity and choose an existing checkout/current cwd for display. |
| Invalid/non-Git cwd | Treat expected Git exit failure as a negative lookup and leave cwd unchanged; do not emit a top-level error. |
| Process cost | Resolve unique cwd values in main process, asynchronously, with timeout, bounded concurrency, in-flight deduplication, and LRU/TTL positive and negative caching. |
| Older Git | `--path-format=absolute` is newer than linked worktrees. On an unsupported-option failure, retry `--git-dir --git-common-dir`, resolving each relative result against the exact `-C` cwd. |
| Environment overrides | `GIT_DIR`, `GIT_COMMON_DIR`, and `GIT_WORK_TREE` affect `rev-parse`. For inherited agent environments, prefer a sanitized app process environment or consciously accept those overrides as Git's active repository identity. |

### Related specs

- `.trellis/spec/frontend/ipc-electron.md:134-165` — Node/filesystem work belongs in the main process and must cross the context-isolated preload API.
- `.trellis/spec/backend/directory-structure.md:114-135` — reusable business logic belongs in a service/lib and IPC handlers should stay thin.

## Caveats / Not Found

- The Trellis task command reported no active task, but the caller supplied the exact task directory and required output path; this report was written only there.
- Public source confirms Git primitives and several state/trust grouping implementations, but not the proprietary sidebar logic of Copilot CLI, Claude Code, or Cursor.
- The local repository currently has only its main worktree, so the reported Copilot path layout was not reproduced in-place.
