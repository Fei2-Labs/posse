# Align Posse with Warp architecture

## Goal

Align Posse with the public `warpdotdev/warp` architecture and Warp/Oz ecosystem direction without destructively merging unrelated Git histories. Posse should remain an Electron/TypeScript app focused on local AI CLI sessions, mobile mirroring, and a long-lived PTY daemon, while selectively adopting compatible architecture conventions, terminology, and guardrails from Warp.

## Requirements

- Treat `warpdotdev/warp` as a reference source, not a normal upstream merge target.
- Preserve current Posse history and local work; do not merge unrelated histories into `main`.
- Add durable documentation/guardrails so future agents do not run `git merge --allow-unrelated-histories` against Warp.
- Research and map Warp/Oz public architecture concepts to Posse's existing PTY daemon, project/session navigator, AI CLI launch flows, and mobile mirror.
- Implement only low-risk alignment changes in this pass: reference-remote guidance, architecture notes, and product/docs positioning.

## Acceptance Criteria

- A dedicated integration branch exists for this work.
- A Trellis research artifact records why direct merge is unsafe and what alignment path was chosen.
- The repository documents `warpdotdev/warp` as a reference remote, not a merge upstream.
- Posse docs explain its relationship to Warp/Oz-style agentic terminal concepts without implying it is Warp or importing Warp source.
- Relevant build/typecheck commands pass after changes.

## Definition of Done

- No push is performed unless explicitly requested later.
- Unrelated untracked files are not staged or committed by this task.
- The final report includes validation status and restart guidance if a build is produced.

## Technical Approach

Use a reference-remote pattern. Add `warp-reference` pointing at `https://github.com/warpdotdev/warp.git` only for inspection, not merging. Record compatibility findings in Trellis research and update repo guidance/docs so future work can selectively port compatible architecture patterns.

## Decision (ADR-lite)

Context: `posse` and `warpdotdev/warp` have no common Git history and very different stacks. Posse is an Electron/TypeScript app with Node PTY and mobile sync; Warp is a large public Rust Cargo workspace.

Decision: Do not directly merge Warp into Posse. Use Warp as an architectural reference and integrate compatible ideas through reviewable, small Posse-native changes.

Consequences: This avoids destructive conflicts and license/product confusion, but it means architecture alignment happens incrementally rather than through a one-shot merge.

## Out of Scope

- Importing Warp source code wholesale.
- Rewriting Posse from Electron/TypeScript to Rust.
- Pushing branches or opening PRs.
- Shipping a new macOS app build unless explicitly requested.

## Technical Notes

- Current Posse root docs: `README.md`.
- Project instructions: `AGENTS.md`.
- Build scripts: `package.json`.
- Public reference repo: `https://github.com/warpdotdev/warp` on branch `master`.
