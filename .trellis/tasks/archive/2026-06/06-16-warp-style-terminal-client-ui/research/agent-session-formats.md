# Research: On-disk session/history storage format per AI CLI (for Projects-first UI)

- **Query**: For each AI coding CLI, find session storage path, cwd→project mapping, title, timestamp, resume command, and session id format — to build a Conductor/Codex-style "Projects-first" UI that buckets sessions by project folder and resumes them.
- **Scope**: internal (read-only inspection of `~/.claude`, `~/.codex`, `~/.copilot`, `~/.kiro`, `~/.gemini` on this machine)
- **Date**: 2026-06-17
- **Machine state inspected**: Claude Code v2.1.178, Codex CLI v0.136.0-alpha (also old 0.98 sessions), Kiro CLI, Gemini CLI, GitHub Copilot CLI (data present; binary not on PATH this session).

---

## TL;DR per-agent summary

| Agent | Storage | cwd source | Title source | Resume command | Enumerate+bucket by project? |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | **inside** jsonl (`cwd` field on every event line) | `ai-title` line → else first `user` msg | `claude --resume <uuid>` (run in cwd) | YES — read real `cwd` from a line, do not trust dir name |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (+ `archived_sessions/`) | **inside** jsonl line 1 `session_meta.payload.cwd` | first user `response_item` text (strip AGENTS.md preamble) | `codex resume <uuid>` (run in cwd) | YES — 76k files; parse line 1 of each |
| Copilot CLI | `~/.copilot/session-store.db` (sqlite) + `~/.copilot/session-state/<id>/` | `sessions.cwd` column / `workspace.yaml` (UNRELIABLE — often `/`) | `sessions.summary` / `workspace.yaml name` / first turn | `copilot --resume <id>` (confirm; binary not installed here) | PARTIAL — cwd often `/`; bucketing unreliable |
| Kiro | `~/.kiro/sessions/cli/<uuid>.json` (meta) + `<uuid>.jsonl` (transcript) | **inside** sidecar `.json` `cwd` field | sidecar `.json` `title` field | `kiro-cli chat --resume-id <uuid>` | YES — cleanest; sidecar `.json` has everything |
| Gemini CLI | `~/.gemini/tmp/<project-hash>/chats/*.json` (per-project) | encoded by **path** (project dir, via `projects.json` + `.project_root`) | tag/checkpoint name | `gemini --resume <index|latest>` (**per-project index, NOT global id**) | NO global enumeration; resume is project-scoped by index only |

---

## Findings

### 1. Claude Code — CONFIRMED + cwd recovery

**Storage**: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
Encoded dir = absolute cwd with every non-alphanumeric char → `-`. **This is lossy** (a path containing literal `-` and `/` both map to `-`), so the dir name cannot reliably reconstruct the real path.

**Recover the REAL cwd (do this, don't decode the dir name):** every transcript event line carries a `cwd` field. Read the first line that has one:
```
$ grep -m1 '"cwd"' <uuid>.jsonl
{"...","cwd":"/Users/clarezoe/My Apps/DuoCLI","gitBranch":"feat/copilot-cli-support","version":"2.1.178",...}
```
Real example (`75de3748-…DuoCLI.jsonl`): `cwd = /Users/clarezoe/My Apps/DuoCLI`, `gitBranch = feat/copilot-cli-support`. Bucket sessions by this `cwd`, not by the encoded folder name. (`gitBranch` is also available for sub-labeling.)

**Title**: scan for a line `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`. Real example found:
```json
{"type":"ai-title","aiTitle":"查看roadmap中未开始的任务","sessionId":"75de3748-4db5-42d2-9019-bd2f8deef8ce"}
```
If no `ai-title` line, fall back to the first `{"type":"user",...}` message text. Note some metadata-only lines exist (`type: last-prompt`, `type: mode`) with no `cwd` — skip those when searching.

**Timestamp**: `timestamp` field (ISO) on event lines; or use file mtime for "last modified", file ctime / first line timestamp for "created".

**Session id**: filename UUID == `sessionId` field.

**Resume**: `claude --resume <uuid>` (alias `-r`). Run it **in the real cwd**. Related flags: `-c/--continue` (most recent), `--fork-session` (new id on resume), `--session-id <uuid>` (force id).

---

### 2. Codex — file format, cwd, title, resume CONFIRMED

**Storage**: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ts>-<uuid>.jsonl`, plus `~/.codex/archived_sessions/`. There is also a `~/.codex/session_index.jsonl` (index) and `~/.codex/history.jsonl` (global prompt history, not per-session).
Real example: `~/.codex/sessions/2026/06/04/rollout-2026-06-04T08-40-17-019e915c-7b3b-7241-8e91-fbaaafaaa26a.jsonl`. **~76,593 session jsonl files** on this machine.

**Format**: JSONL. **Line 1 is `type: "session_meta"`** and is the key record:
```json
{
  "timestamp": "2026-06-04T06:40:17.820Z",
  "type": "session_meta",
  "payload": {
    "id": "019e915c-7b3b-7241-8e91-fbaaafaaa26a",
    "timestamp": "2026-06-04T06:40:17.667Z",
    "cwd": "/Users/clarezoe/My Apps/ai-video-genie",
    "originator": "Codex Desktop",
    "cli_version": "0.136.0-alpha.2",
    "source": "vscode",
    "git": { "commit_hash": "...", "branch": "main",
             "repository_url": "https://github.com/clarezoe/ai-video-genie.git" }
  }
}
```
**cwd source**: `payload.cwd` on line 1 (stored INSIDE the file). `payload.git.repository_url` / `branch` also available. (Older v0.98 sessions had `cwd: "/"` and no `git` block — handle missing fields.)

**Title / first prompt**: there is no dedicated title field. Take the first user message:
- newer files: `type: "response_item"`, `payload.type:"message"`, `payload.role:"user"`, text under `payload.content[].text`.
- older files: `type: "event_msg"`, `payload.type:"user_message"`, `payload.message`.
Caveat: the first user message is usually the injected `# AGENTS.md instructions for <path>` preamble — strip that and take the first real human line. (The preamble path itself is another cwd hint.)

**Timestamp**: top-level `timestamp` on each line (ISO); `session_meta.payload.timestamp` = created; file mtime = last activity. Date is also encoded in the path and filename.

**Session id**: `payload.id` UUID == the `<uuid>` in the filename.

**Resume**: `codex resume <SESSION_ID> [PROMPT]` (UUID or session name; UUID wins). `codex resume --last` = most recent. `codex fork <id>` = branch a copy. Run in the cwd. Confirmed via `codex resume --help`.

**Bucketing**: YES — enumerate all `rollout-*.jsonl`, read line 1, group by `payload.cwd`. Cheap (only line 1 needed).

---

### 3. GitHub Copilot CLI — sqlite + per-session dir; cwd UNRELIABLE

Two sqlite DBs in `~/.copilot/`:
- **`session-store.db`** = the CLI conversation store (USE THIS).
- **`data.db`** = the Copilot **desktop/IDE** "projects/workspaces/worktrees" store (different product surface; has `projects(main_repo_path)`, `workspaces`, `worktrees`). Not the CLI session list.

**`session-store.db` schema (relevant tables):**
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    repository TEXT,
    host_type TEXT,
    branch TEXT,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_index INTEGER NOT NULL,
    user_message TEXT,
    assistant_response TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, turn_index)
);
-- also: checkpoints, session_files, session_refs, forge_trajectory_events, search_index*
```

**Real rows** (`SELECT id,cwd,repository,branch,summary,updated_at`):
```
54bf002a-… | /Users/clarezoe/.copilot/chats/b27dddc5-…  |   |   | 我把项目文件夹转移了… | 2026-06-16T18:08:12Z
7c05fbb9-… | /                                            |   |   | Keel pages publish fix |
f783e6ed-… | /Users/clarezoe/Nextcloud/My Apps/copilot-worktrees/keel/feifei-… | VolvoGroup-Internal/keel | feifei-kosonen-volvo/refactored-sniffle | Add keel MCP |
```
Only 8 sessions total.

**Per-session sidecar dir**: `~/.copilot/session-state/<id>/` with `workspace.yaml`, `events.jsonl`, `session.db`, `checkpoints/`, `files/`. `workspace.yaml` mirrors the row:
```yaml
id: 54bf002a-…
cwd: /Users/clarezoe/.copilot/chats/b27dddc5-…
client_name: github/autopilot
name: 我把项目文件夹转移了…   # human title
user_named: false
summary_count: 0
created_at: 2026-06-12T19:35:07.640Z
updated_at: 2026-06-16T18:08:12.715Z
```

**cwd source**: `sessions.cwd` column (or `workspace.yaml cwd`) — stored inside DB. **CAVEAT: cwd is frequently `/` or a synthetic `~/.copilot/chats/<uuid>` path**, so bucketing by real project folder is UNRELIABLE for Copilot. Use `repository` column when present; otherwise the session may not map to a real folder.

**Title**: `sessions.summary`, else `workspace.yaml name`, else `turns.user_message WHERE turn_index=0`.

**Timestamp**: `created_at` / `updated_at` (ISO) columns.

**Session id**: UUID `sessions.id` == `session-state/<id>` dir name.

**Resume**: expected `copilot --resume <id>` / `copilot --continue` — **NOT verifiable on this machine**: the `copilot` binary is not on PATH under `copilot`/`gh-copilot`/`github-copilot`/`copilot-cli`, and not found in npm-global/homebrew. **MARK: resume command UNVERIFIED for Copilot — confirm the exact flag against the installed binary before relying on it.** Enumeration works (read the sqlite), but project bucketing is degraded by the unreliable cwd.

---

### 4. Kiro — cleanest; sidecar JSON has everything

**Storage**: `~/.kiro/sessions/cli/` with paired files per session:
- `<uuid>.json` — **metadata sidecar** (small, the one to read)
- `<uuid>.jsonl` — full transcript
- `<uuid>/` — optional dir with `tasks/` subfolder

Real example: `~/.kiro/sessions/cli/0329e716-2b4f-40ac-a13e-12e5edba6d85.json`.

**Sidecar `.json` head:**
```json
{
  "session_id": "0329e716-2b4f-40ac-a13e-12e5edba6d85",
  "cwd": "/Users/clarezoe/Dropbox/My Apps/karpathy-harness",
  "created_at": "2026-04-29T16:04:36.566114Z",
  "updated_at": "2026-04-29T17:09:20.599780Z",
  "title": "is trellis installed and can be used in kiro?",
  "session_state": { ... }
}
```
Everything we need is in this single small JSON: **cwd, created_at, updated_at, title, session_id** — no need to parse the big `.jsonl`.

**Transcript `.jsonl`** lines look like `{"version":"v1","kind":"Prompt","data":{"content":[{"kind":"text","data":"…"}]}}` / `kind:"AssistantMessage"` / `kind:"ToolResults"` if deeper content is needed.

**cwd source**: sidecar `.json` `cwd` (inside file). **Title**: sidecar `title`. **Timestamps**: `created_at` / `updated_at`. **Session id**: `session_id` == filename UUID.

**Resume**: confirmed via `kiro-cli chat --help`:
- `kiro-cli chat --resume-id <SESSION_ID>` — resume specific session
- `kiro-cli chat -r/--resume` — most recent in current dir
- `kiro-cli chat --resume-picker` — interactive
- `kiro-cli chat --list-sessions` (`-l`) — list sessions for current dir
- `kiro-cli chat -d/--delete-session <id>`
(Top-level entry is `kiro-cli chat`; resume flags live under the `chat` subcommand.)

**Bucketing**: YES — read each `<uuid>.json`, group by `cwd`. Best-structured of all five.

---

### 5. Gemini CLI — per-project, NO global session id resume

**Storage**: project-scoped under `~/.gemini/tmp/<project-tag>/chats/*.json`. The mapping of cwd→tag is in:
- `~/.gemini/projects.json`:
  ```json
  { "projects": {
      "/Users/clarezoe": "clarezoe",
      "/": "project",
      "/Users/clarezoe/Dropbox/My Apps/model-checker": "model-checker",
      "/Users/clarezoe/My Apps/Kompany": "kompany" } }
  ```
- and each `~/.gemini/tmp/<tag>/.project_root` file contains the absolute cwd (e.g. `clarezoe/.project_root` → `/Users/clarezoe`).

`~/.gemini/history/<tag>/` also exists (shell/command history per project), and `~/.gemini/agents/` holds agent definitions (`trellis-*.md`), not sessions.

On this machine the `chats/` dirs are present but **empty** (`~/.gemini/tmp/clarezoe/chats/` has no files), and `gemini --list-sessions` run from `~` returns `No previous sessions found for this project.` So saved-session checkpoints exist by design but none are currently stored here.

**cwd source**: encoded by **PATH** (the `<tag>` dir), resolved via `projects.json` / `.project_root`. Not stored as a field the way Claude/Codex/Kiro do.

**Title/timestamp**: chat checkpoints are saved under a user-supplied tag (`/chat save <tag>`); the tag is the human label, file mtime is the timestamp. No structured title field observed (none on disk to confirm).

**Resume**: `gemini --resume <"latest" | index>` (alias `-r`), e.g. `--resume 5`. Also `--list-sessions` and `--delete-session <index>`. **CRITICAL: resume is by PER-PROJECT INDEX, not a global/stable session UUID** — you must be in (or target) the right project, then pick by index. There is no `gemini resume <uuid>` across projects.

**Bucketing / enumeration**: NO global enumeration. Sessions are inherently per-project (you'd iterate `projects.json` and look in each `tmp/<tag>/chats/`). Cross-project "list every session with a stable id" is **NOT feasible** the way it is for the others. **MARK: Gemini per-session global resume = NOT feasible; only project-scoped index resume.**

---

## Cross-agent: cwd location & enumeration feasibility

**cwd stored INSIDE the session file** (reliable for bucketing): Claude (`cwd` per line), Codex (`session_meta.payload.cwd`), Kiro (sidecar `.json cwd`), Copilot (`sessions.cwd` column — but values unreliable).
**cwd encoded in the PATH**: Claude dir name (lossy — prefer the in-file field), Gemini (`tmp/<tag>` via `projects.json`/`.project_root`).

**Reliable global enumeration + project bucketing:**
- Claude: YES (glob `~/.claude/projects/*/*.jsonl`, read in-file `cwd`).
- Codex: YES (glob `~/.codex/sessions/**/rollout-*.jsonl` + `archived_sessions/`, read line-1 `cwd`).
- Kiro: YES (glob `~/.kiro/sessions/cli/*.json`, read `cwd`).
- Copilot: PARTIAL (sqlite query is easy; cwd often `/` → cannot always map to a real project folder).
- Gemini: NO (per-project only, index-based resume, no stable cross-project id).

## Caveats / Not Found

- **Copilot resume command UNVERIFIED** — `copilot` binary not on PATH this session; `--resume <id>` is the expected flag but confirm against the installed CLI.
- **Codex** title requires stripping the injected `AGENTS.md` preamble from the first user message; old (v0.98) sessions have `cwd:"/"` and no `git` block.
- **Gemini** has no on-disk session samples right now (empty `chats/`), and no stable global session id; UI should treat Gemini resume as project-scoped index only (or omit per-session resume).
- **Claude** encoded dir name is lossy for paths containing `-`; always recover real cwd from an in-file `cwd` line.
- Performance note: Codex has ~76k session files — bucketing should read only line 1 per file (cheap) and may want a cached index.
