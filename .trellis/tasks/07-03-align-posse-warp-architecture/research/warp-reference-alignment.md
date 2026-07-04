# Warp reference alignment research

## Summary

Posse and `warpdotdev/warp` should not be merged at the Git history or source-tree level. They have no common Git ancestor, very different implementation stacks, and different product boundaries. Warp is useful here as a public architecture and terminology reference, not as an upstream source tree.

## Repository compatibility facts

- Posse is an Electron/TypeScript desktop app centered on a long-lived local PTY daemon, mobile mirroring, and third-party AI coding CLIs.
- `warpdotdev/warp` is a public Rust Cargo workspace on branch `master`.
- The repositories have no shared Git history.
- Warp has thousands of tracked files and a Rust monorepo layout; Posse has a smaller Electron app layout.
- Top-level overlap is limited to generic repo files such as `.github`, `.gitignore`, `AGENTS.md`, and `README.md`.
- Warp repository metadata and docs indicate AGPL-3.0 for most source, with only specific UI crates documented as MIT.

## Decision

Use `warpdotdev/warp` as a public reference source only. Do not add it as a normal upstream remote, do not vendor it, and do not run `git merge --allow-unrelated-histories` against Warp.

## Compatible concepts to port in Posse-native terms

- Treat a terminal session as an explicit owned lifecycle object.
- Keep the PTY daemon as the owner of running processes while desktop, standalone terminal, and phone clients observe and steer sessions.
- Separate live PTY transport from higher-level command or agent execution strategy.
- Persist stable session metadata separately from runtime UI state.
- Model agent/user control handoff as explicit state instead of loose booleans.
- Preserve chronological transcript order while allowing each surface to render events differently.
- Keep remote/headless execution behind the same backend contract as local execution.
- Resolve secrets and external tool configuration at use time; do not persist rendered secret-bearing config.

## Concepts to avoid

- Copying Warp source, assets, file structure, or non-trivial text blocks.
- Rewriting Posse into Warp's Rust Cargo workspace model.
- Depending on private Warp/Oz server contracts.
- Calling Posse `Warp-compatible`, `Oz-compatible`, `Warp-based`, a `Warp fork`, or a `Warp client` without a real interoperability contract.

## Posse mapping

- `src/main/pty-daemon.ts` owns daemon-side PTY process execution.
- `src/main/pty-daemon-client.ts` adapts the daemon to the local backend interface and handles reconnect/restart.
- `src/main/pty-manager.ts` owns session lifecycle, buffers, titles, resume detection, and provider correlation.
- `src/main/pty-backend.ts` is the stable backend seam between local daemon and remote backend implementations.
- `src/main/remote-server.ts` exposes sessions to mobile and remote clients.
- `src/main/remote-server-backend.ts` adapts a remote Posse server into the backend interface.
- `src/renderer/app.ts` owns project/session navigation and launch flows.
- `src/terminal-client/app.ts` is the daemon-served standalone terminal surface.

## Guardrail wording

Treat `https://github.com/warpdotdev/warp` as a public architecture and terminology reference only. Do not add it as an upstream remote for normal sync, do not merge it into Posse, and never use `git merge --allow-unrelated-histories` against Warp. If comparing implementation details, use an isolated temp checkout or GitHub CLI/API, then port only compatible ideas through small Posse-native changes with license review.
