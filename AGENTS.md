<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## Project conventions (preserved — outside the Trellis block)

### After every new build/version, tell me what to restart
When you ship a new version (build:mac → installed to /Applications), always tell me
explicitly whether I need to **restart both the app AND the daemon**, or **only the app**.

Rule of thumb:
- **App only** — changes to the renderer (`src/renderer/`), preload (`src/preload/`),
  `src/main/index.ts` window/IPC/menu wiring, or the mobile/terminal-client static assets.
  Restarting the app reconnects to the existing daemon; live sessions survive.
- **App + daemon** — changes to daemon-resident code: `src/main/pty-manager.ts`,
  `src/main/pty-daemon.ts`, `src/main/pty-backend.ts`, or the spawn/protocol logic in
  `src/main/pty-daemon-client.ts`. The app restart does NOT swap daemon code (the daemon
  is kept alive on purpose); restart the daemon via the "Restart daemon" button (it saves
  live sessions as resumable first — never SIGKILL it).

State the verdict on each version handoff, e.g. "v1.2.X installed — app-only restart" or
"v1.2.X — restart app AND daemon (touched pty-manager.ts)".

github account - clarezoe

### GitHub identity for this repo
This repo (Fei2-Labs/posse) belongs to the `clarezoe` GitHub account. All git/GitHub
operations (push, PR creation, gh CLI calls) for this repo must be done as `clarezoe`,
NOT whatever account the Copilot CLI/session happens to be logged in as (e.g.
`feifei-kosonen_volvo`, which lacks push access here). If a push/PR fails with a 403
permission error tied to the session's default identity, that's the cause — don't retry
as that account; use `clarezoe`'s credentials instead (or hand off to the user to push
locally with their own credentials).
