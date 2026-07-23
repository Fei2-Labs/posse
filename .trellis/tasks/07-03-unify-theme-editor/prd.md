# Unify Warp-inspired theme and editor systems
## Goal
Unify Posse's app chrome, terminal, standalone terminal client, and file preview editor around a coherent Posse-native theme model inspired by Warp's public theme concepts, while improving the file preview/editor safety and UX.
## Requirements
- Do not copy Warp source code, bundled assets, or branding. Use public documentation and the public theme schema only as behavioral/reference context.
- Preserve existing built-in themes and user selections where possible.
- Make app-wide theme selection the primary theme flow and apply it to live terminals immediately.
- Keep Auto Color behavior for per-project/session visual variation.
- Share theme definitions or generated theme constants between the desktop renderer and standalone terminal client so they do not drift.
- Keep markdown rendered/source preview, sandboxed HTML preview, image preview, and CodeMirror source editing.
- Improve editor affordances: visible modified state, clear save state, path metadata, and Cmd/Ctrl+S discoverability.
- Prevent accidental data loss when switching files, closing preview, or leaving source mode with unsaved edits.
- Harden saves so text writes are explicit and conflict-aware where feasible; retain size and binary guards.
- Preserve local and active remote backend support via existing IPC and remote server routes.
- Update user-facing documentation for the theme picker and file preview/editor scope without claiming Warp compatibility.
## Validation
- `npm run build:ts`
- `npm run copy:html`
- Manual smoke: launch app, switch themes, create terminal, open text/markdown/image files, edit and save a small text file, verify large/binary fallback, and verify behavior on a remote connection when available.
