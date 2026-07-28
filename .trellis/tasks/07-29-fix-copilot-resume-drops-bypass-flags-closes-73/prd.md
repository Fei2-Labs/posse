# Fix: Copilot sessions resume without bypass mode (closes #73)

## Problem
Resuming a Copilot session from sidebar/Active/Recent drops the `--allow-all --autopilot` bypass flags. Fresh launches include them; resume does not.

## Root cause (two reinforcing places)
1. `src/main/index.ts:1652` — `resumeCommand: \`copilot --resume ${id}\`` omits bypass flags.
2. `src/main/pty-manager.ts:88` — `parseResumeCommand` Copilot pattern rebuilds without bypass flags, unlike Claude (`--dangerously-skip-permissions`) and Kiro (`--trust-all-tools`).

## Fix
- `src/main/index.ts:1652`: emit `copilot --allow-all --autopilot --resume ${id}`.
- `src/main/pty-manager.ts:88`: build `${m[1]} --allow-all --autopilot --resume ${m[2]}`.

## Verification
1. Start fresh Copilot session (agent picker) — confirm `--allow-all --autopilot` present.
2. Close it; resume from Recent/Active — confirm resumed command now includes `--allow-all --autopilot --resume <id>`.
3. Confirm Claude and Kiro resume paths still include their own bypass flags (regression check).

## Restart verdict
Touches `src/main/index.ts` (window/IPC wiring — app-only) AND `src/main/pty-manager.ts` (daemon-resident — app+daemon). → **App + daemon restart.**
