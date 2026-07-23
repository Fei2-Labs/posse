# Redesign Posse Workspace UX

## Goal

Make Posse a reliable terminal-first AI coding workspace by replacing its disruptive file-preview interaction with a persistent, accessible inspector and by resolving high-impact UI reliability issues before expanding preview formats.

## What I Already Know

* Posse is an Electron application with a vanilla TypeScript renderer, xterm.js terminals, a three-pane desktop layout, and mobile sync.
* The current renderer is concentrated in `src/renderer/app.ts` (6,013 lines) and `src/renderer/styles.css` (3,384 lines).
* The existing preview implementation supports Markdown, HTML, images, and editable source in `src/renderer/file-preview.ts`.
* The preview is an absolute overlay over the terminal (`#file-preview-panel`), so it removes the terminal from view instead of supporting side-by-side inspection.
* HTML preview uses a fully sandboxed `srcdoc` iframe, so project-relative CSS, images, fonts, and JavaScript are not usable in preview.
* The file tree is rendered using non-semantic `div` and `span` rows, lacks keyboard navigation, and has no visible `:focus-visible` system.
* The existing chat screen is non-functional: all chat API methods in `src/preload/index.ts` are no-op compatibility stubs.
* Agent Desktop provides a persistent right panel with Preview and Git tabs, source/preview switching, an expanded viewer, typed rendering, and component-level tests. Its code is AGPL-3.0-only, so only interaction patterns and independently implemented architecture may be adopted.

## Assumptions

* Posse must stay terminal-first; this is not a rewrite into a chat-first product.
* The first delivery should prioritize reliability and discoverability over exhaustive renderer support.
* HTML files under the active project root are intentionally treated as trusted and may execute scripts in preview.
* Existing terminal sessions and mobile synchronization must remain uninterrupted by UI restructuring.

## Open Questions

* None before implementation-plan confirmation.

## Requirements

* Replace the terminal-covering file preview with a persistent right-side inspector that preserves the terminal context.
* Keep side panels resizable, collapsible, and responsive at compact desktop widths.
* Allow users to select a file from the inspector tree and switch between source and rendered views without losing unsaved edits.
* Support clear loading, empty, error, and external-open states for the file viewer.
* Use accessible, semantic controls for panel actions and file selection, including visible keyboard focus.
* Eliminate or hide the non-functional chat entry point unless the chat backend is explicitly restored in scope.
* Add a Git workspace tab and a restricted, user-mediated HTML preview runtime.
* Provide a read-only Git inspector for repository status, changed files, and expandable diffs; leave commits, branches, stash, and conflict resolution in the terminal.
* Add renderers for Mermaid, SVG, CSV, PDF, Jupyter notebooks, and common 3D model formats in addition to the current Markdown, HTML, image, and source viewers.
* Allow project-root HTML previews to execute scripts by default while keeping the preview isolated from Electron and Node APIs.
* Isolate inspector failures from terminal lifecycle, provide retryable failure states and missing-dependency explanations, persist panel layout, and use a compact-width drawer mode.

## Acceptance Criteria

* [ ] Opening a supported file does not cover or unmount the active terminal.
* [ ] The inspector has a discoverable Files/Preview surface with explicit loading, error, empty, and selected states.
* [ ] Source/preview switching cannot silently discard unsaved edits.
* [ ] Keyboard users can reach and operate file-tree and panel controls, with visible focus styling.
* [ ] HTML inside the active project root can execute in preview but cannot access Electron or Node APIs.
* [ ] The inspector includes a Git surface appropriate to the selected repository.
* [ ] Git status, changed files, and diffs can be inspected without exposing Git write actions.
* [ ] Supported Mermaid, SVG, CSV, PDF, notebook, and 3D files render a meaningful preview or a clear dependency/error state.
* [ ] A preview failure cannot make the active terminal unusable and provides a retry or recovery action.
* [ ] Inspector widths, visibility, and compact drawer behavior remain usable across app restarts and narrow desktop widths.
* [ ] The layout remains usable in wide desktop and compact-width modes.
* [ ] No live chat action remains exposed when backed by no-op IPC methods.

## Definition of Done

* Tests added or updated for changed behavior.
* TypeScript build and applicable existing tests pass.
* UI behavior is checked at wide desktop and compact widths.
* Preview security decisions and changed user-visible behavior are documented.
* Rollback is limited to feature-gated or isolated renderer changes.

## Out of Scope

* Rebuilding Posse as a React application.
* Copying Agent Desktop source code, assets, or design system.
* Jupyter notebook, OpenSCAD, or 3D-model preview in the first milestone.
* Restoring the removed chat backend unless explicitly selected.
* Broad visual rebranding unrelated to workspace reliability.
* Implementing an embedded Git write workflow or merge-conflict UI.

## Technical Notes

* Likely initial surfaces: `src/renderer/index.html`, `src/renderer/app.ts`, `src/renderer/file-preview.ts`, `src/renderer/styles.css`, and `src/preload/index.ts`.
* Related renderer IPC will require main-process and preload review before changes.
* Existing UI debt metrics: 569 raw color values, 53 sub-12px font declarations, 16 `!important` rules, 159 event listeners in `app.ts`, and no `:focus-visible` rule.
* The selected scope includes the Git inspector and a constrained HTML runtime trust model.
* Git is intentionally read-only in the inspector so Posse remains terminal-first for repository mutation.
* Candidate advanced preview formats: `.ipynb` and `.stl`, `.obj`, `.3mf`, and `.ply`; the exact runtime dependencies need technical validation.
* HTML trust is project-scoped: the active session's project root is trusted by default. The implementation must still use Electron isolation, prevent privileged APIs, and visibly identify the executing project.

## Research References

* [`research/agent-desktop-workspace-audit.md`](research/agent-desktop-workspace-audit.md) - Interaction patterns and safe preview architecture mapped to Posse constraints.
* [`research/renderer-integration-options.md`](research/renderer-integration-options.md) - Pending dependency and Electron security research for advanced previews.

## Technical Approach

Create a renderer-local `InspectorController` that owns Files, Preview, and Git tab state without changing terminal-manager ownership. The persistent inspector replaces the existing terminal overlay and has typed `loading`, `empty`, `ready`, `error`, and `external` states. It persists width, active tab, and compact drawer state, and it isolates viewer failures from live terminal sessions.

All file, preview, and Git requests will cross a narrowed, typed preload API. Main-process helpers will receive a project-root token and relative paths, canonicalize the resolved path, prevent traversal and symlink escapes, and return structured errors. Existing broad absolute-path calls must not become the authorization boundary for the new inspector.

For local trusted-project HTML, register a root-token-scoped `posse-project://` protocol and display it in an iframe with browser scripts but no preload, Node, Electron, popups, downloads, or top navigation. Remote projects remain source/external-open only until a separate remote asset gateway exists.

Rich renderers are lazy-loaded to preserve terminal startup performance. Markdown/source/images reuse existing capabilities; Mermaid, sanitized SVG, CSV, PDF, read-only notebooks, and bounded Three.js model previews are added behind explicit size, dependency, and recovery limits. Notebook execution is explicitly deferred.

Git uses an existing-system-Git main-process service with non-shell, read-only `status` and `diff` commands. It returns typed repository and truncation failures and never exposes mutation actions.

## Decision (ADR-lite)

**Context**: Posse has a functional but undiscoverable preview implementation that overlays the terminal. It needs richer artifact rendering and Git context without becoming a chat-first IDE or weakening Electron's security model.

**Decision**: Build a terminal-first persistent inspector, use a root-token custom protocol for trusted local HTML, keep Git inspection read-only, and deliver advanced renderers progressively. Treat project-root HTML as browser-script trusted but keep it isolated from all privileged APIs.

**Consequences**: The work spans renderer, preload, main-process IPC, protocol handling, packaging, and tests. Remote parity, notebook execution, and Git writes remain deliberately out of scope. PDF workers and dynamic renderer assets require packaging validation before release.

## Implementation Plan

1. **Workspace foundation**
   * Replace the file overlay with the persistent Files/Preview/Git inspector shell.
   * Introduce semantic controls, keyboard tree navigation, visible focus, retryable states, error isolation, edit-loss guards, panel persistence, compact drawer behavior, and removal of no-op chat entry points.
2. **Project-safe HTML and IPC boundary**
   * Add project-root tokens, canonical path authorization, structured inspector errors, the `posse-project` protocol, iframe navigation policy, and tests for traversal, symlink, relative-asset, and privilege isolation cases.
3. **Core rich previews**
   * Add Mermaid, hardened SVG, CSV, and PDF renderers with lazy imports, limits, loading/error/source/external recovery, and PDF worker packaging verification.
4. **Read-only Git**
   * Add a local Git service for repository state, changed files, and bounded staged/unstaged diffs; render it in the inspector without write controls.
5. **Advanced artifacts**
   * Add a read-only notebook renderer and Three.js previews for STL, OBJ, 3MF, and PLY with resource budgets, missing-dependency states, and lifecycle disposal.

## Risks and Rollback

* Project HTML can still make browser network requests or consume CPU/GPU. The iframe isolation, navigation limits, visible root identity, reload/stop controls, and terminal error isolation are mandatory.
* Advanced renderer assets may fail in packaged builds. Each renderer is isolated, lazy-loaded, and falls back to source/external open, allowing individual formats to be withheld without reverting the workspace foundation.
* Remote sessions lack equivalent asset and Git capabilities. The inspector must report unsupported remote preview types rather than assume local behavior.
