# Fix duplicate live session rows (agent uuid misbinding)

## Problem
Sidebar shows the same Claude conversation twice. Confirmed via live daemon state: two live PTYs share one Claude uuid `75de3748`:
- `term-1` (resumed, resumeId=75de3748) — legit
- `term-3` (fresh `claude`, resumeId=None, agentSessionId=75de3748) — **mis-bound**

## Root cause
`findAgentSessionIdOnDisk` (src/main/pty-manager.ts) claude branch picks the newest `.jsonl` in the cwd project dir by **mtime ≥ spawnedAt−5s**. A freshly spawned `claude` (term-3) runs the scan before it writes its own session file, so it grabs an already-active session's file (term-1's, whose mtime is fresh because that session is live). Both PTYs end up with the same uuid.

The renderer dedups live↔closed↔history by uuid (`shownUuids`) but does NOT dedup **live↔live**, so both rows render.

## Fix
1. **Discovery (root fix)** — claude branch of `findAgentSessionIdOnDisk`: require the file to be **created** after spawn (`st.birthtimeMs >= minMtime`), not merely modified. A fresh session's file is born after spawn; an existing live session's file was born earlier and is excluded. Fall back to mtime only if birthtime is unavailable (0/invalid).
2. **Exclusion guard (defense in depth)** — pass a set of uuids already bound to other live sessions (their `agentSessionId`/`resumeId`) into `findAgentSessionIdOnDisk` and skip them, so a discovered uuid can never collide with another live PTY.
3. **Renderer backstop** — in `collectProjectSessions` (src/renderer/app.ts ~2065), when adding live PTYs, dedup by uuid: if a live session's uuid is already in `shownUuids` from another live row, skip the duplicate (prefer the resumed one / earliest-bound). Prevents any visible double even if binding races.

## Out of scope
- Resume path (uuid set directly from launch command) is unaffected.
- No IPC/wire changes.

## Acceptance
- Spawning a fresh `claude` in a cwd with an existing active session no longer binds to the existing uuid.
- Sidebar never shows two rows for the same uuid.
- Typecheck passes.
