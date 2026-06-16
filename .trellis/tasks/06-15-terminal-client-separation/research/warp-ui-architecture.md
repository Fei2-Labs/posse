# Warp UI Architecture Research

## Sources Inspected

* `https://github.com/warpdotdev/warp`
* `https://www.warp.dev/blog/warp-is-now-open-source`
* Local partial checkout at `/tmp/warp-source`
* `README.md`
* `WARP.md`
* `.agents/skills/warp-ui-guidelines/SKILL.md`
* `app/src/root_view.rs`
* `app/src/workspace/mod.rs`
* `app/src/workspace/view.rs`
* `app/src/workspace/header_toolbar_item.rs`
* `app/src/pane_group/mod.rs`
* `app/src/terminal/view.rs`
* `app/src/view_components/action_button.rs`
* `app/src/appearance.rs`

## Findings

Warp is now open source and publicly positions itself as an agentic development environment born out of the terminal. Its repository is a Rust workspace. The GitHub language breakdown shows it is overwhelmingly Rust, and its README states the `warpui_core` and `warpui` crates are MIT while the rest is AGPL v3.

Warp uses a custom UI framework named WarpUI. The repo guide describes an entity/handle model, global app context, views/models, and Flutter-like element layout. DuoCLI is Electron + DOM + xterm.js, so direct UI implementation reuse is not practical.

Warp's app architecture is organized around a workspace model:

* `root_view` owns application-level windows, state restoration, launch config, and global resources.
* `workspace` owns tabs, panels, global search, launch modals, right/left panels, vertical tabs, and toolbar items.
* `pane_group` owns composable panes, split directions, pane headers, and terminal panes.
* `terminal/view` is a large terminal surface with AI/agent integration, block UI, banners, rich content, file upload, and shell/session integration.
* `view_components/action_button.rs` shows a design-system approach: buttons use named shared themes rather than one-off styling.

## Patterns Worth Adapting

* Treat terminal as the primary workspace, with side panels as optional context instead of permanent heavy sidebars.
* Model sessions as tabs/panes with compact headers, status, icon, and actions.
* Keep a command/launcher flow for creating terminals and switching actions.
* Centralize UI tokens and component roles instead of styling each button/list item ad hoc.
* Keep agent/chat/terminal concepts in the same workspace model, but avoid merging all management UI into the terminal surface immediately.

## Patterns Not Worth Copying Now

* Warp command blocks and rich block terminal rendering. DuoCLI currently streams raw PTY output through xterm.js; block rendering would require a separate shell integration and terminal model.
* WarpUI implementation details. They are Rust-specific and incompatible with DuoCLI's DOM renderer.
* Deep cloud/object sync architecture. DuoCLI's immediate problem is local developer workflow isolation.

## Mapping to DuoCLI

The near-term DuoCLI adaptation should not start with visual polish. It should first split the local terminal client from the main Electron app:

* The daemon already owns PTY sessions.
* A daemon-served local web client can become the stable terminal workspace.
* DuoCLI main app can become a management/control surface that can restart freely during development.
* After the split, the terminal client can adopt a Warp-like shell: command launcher, compact session rail, optional context panels, and design-system tokens.

