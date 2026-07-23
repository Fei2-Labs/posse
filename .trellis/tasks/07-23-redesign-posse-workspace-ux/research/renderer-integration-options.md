# Renderer Integration Options: Persistent Inspector

## Repository findings

- Posse is a vanilla-DOM TypeScript renderer bundled with esbuild (`src/renderer/app.ts` imports `file-preview.ts`); it is **not** a React/Vite application. The installed primitives are CodeMirror 6, `marked` + DOMPurify, xterm, and `sharp`.
- The current `#file-preview-panel` is an absolutely positioned terminal overlay. `file-preview.ts` supports Markdown (sanitized HTML), HTML (`srcdoc` with an empty sandbox, so scripts and project-relative assets do not work), images (base64 URL), and CodeMirror source. Its source/render toggle deliberately resets unsaved edits, which conflicts with the new requirement.
- The primary `BrowserWindow` already has `contextIsolation: true` and `nodeIntegration: false`. Electron 20+ enables renderer sandboxing by default. The exposed `window.posse` bridge is privileged and broad; preview content must never receive it.
- Existing `file-tree:list-dir`, `fs:read-file`, `fs:write-file`, and `fs:read-file-base64` delegate by calling window to a remote backend when applicable, then otherwise `path.resolve()` arbitrary input. They cap text at 1 MiB and image base64 at 16 MiB, but do **not** constrain local paths to the active project root. `git:branch` and `git:dirty` only cover local Git.
- The active root comes from selected project/session CWD. That is the authoritative root to pass as an opaque project handle, not an arbitrary path supplied by the renderer. Current remote file APIs are sufficient for source/image reads, but not for serving linked HTML assets or remote Git data.

## Architecture and boundary recommendation

Create an independently implemented `InspectorController` in the renderer (Files, Preview, Git tabs) with a small typed `window.posse.inspector` API. Keep terminal-manager ownership and DOM mounted; inspector selection changes only its own subtree. Use explicit `loading | empty | ready | error | external` states, cancellation/selection IDs for async work, retry buttons, and renderer-local error handling. Iframe load errors and worker/WebGL errors must become inspector errors, never terminal lifecycle errors. Persist widths/tab/drawer state in `localStorage`; use a CSS compact breakpoint to turn the inspector into an accessible modal drawer, focus it on open, and restore focus on close.

Move capability checks and path authorization into main-process helpers:

1. resolve the active local root once per window/project; canonicalize with `realpath`;
2. canonicalize every requested existing path and require it to be that root or a descendant (including symlink escape protection); validate a proposed write's parent similarly;
3. expose operations by project ID/root token plus relative path, never by arbitrary absolute path; return structured, user-safe errors (`outside-project`, `too-large`, `binary`, `unsupported`, `dependency-missing`);
4. give remote projects a separate opaque connection/root handle. Do not assume local-path semantics or use a local protocol for remote paths.

Do not expose any preload API in the preview frame. Load the document from its separate `posse-project://<token>` origin in `iframe sandbox="allow-scripts allow-same-origin"`: preserving that origin is needed for project-relative modules, fetches, and storage, while it remains cross-origin from Posse's `file://` UI. The combination is safe only because the project origin is distinct and the child gets no preload/IPC; preserve that separation. Omit popups, forms, downloads, and top navigation. Do not turn on `nodeIntegration`, disable `contextIsolation`/`webSecurity`, or add `nodeIntegrationInSubFrames`. Deny `window.open` and unapproved navigation at the owning `webContents`; only explicit, validated user clicks may call the existing external-open IPC. Treat “trusted project scripts” as permission to run browser JavaScript, **not** permission to escape the renderer or receive privileged IPC.

## HTML assets: custom protocol vs. loopback server

### Option A — custom protocol (recommended for local projects)

Register `posse-project` before `app.ready` as a **standard** and **secure** scheme, then install `protocol.handle()` after ready. A URL such as `posse-project://<per-window-project-token>/relative/path` maps in main only to the registered root. The handler must URL-decode once, reject NUL/traversal/host mismatch, `realpath` the target, re-check containment, return an explicit MIME type and `X-Content-Type-Options: nosniff`, and never list directories. Inject/set `<base href="posse-project://token/path/to/">` for the HTML document so relative CSS, modules, images, fonts, fetches, and worker URLs resolve. A standard scheme is essential: Electron documents that non-standard schemes do not resolve relative URLs correctly.

Benefits: no listening port, no bearer token exposed to other local processes, and fits Electron's recommendation to prefer a custom protocol over `file://`. Costs: implement MIME/range behavior deliberately; update esbuild packaging for worker assets; protocol registration is session-specific if an isolated partition is later used. Give each project/window a random host token so unrelated projects are not same-origin.

### Option B — authenticated loopback asset server

Start a per-window, loopback-only HTTP server on an ephemeral port and serve `http://127.0.0.1:<port>/<random-token>/...` with the same canonical-root checks. This is more naturally compatible with web tooling expecting HTTP, service workers, WebSockets, range requests, and PDF.js workers. Bind only to loopback, require an unguessable token on every request, reject Host/origin surprises, stop it with the window, and never expose Electron/preload APIs. It increases lifecycle, firewall, token-leak, and local-process attack surface; do not use a fixed port or unauthenticated localhost server.

Choose Option A for the normal static project preview. Add Option B only after a demonstrated compatibility need (for example a project genuinely requires HTTP-only APIs). Neither option solves remote assets: first add a main-owned remote asset gateway that authenticates the active connection and applies remote-root authorization, or show source/external-open for remote HTML. Do not leak remote credentials into page URLs.

## Renderer choices by type

| Type | Recommended independent integration | Constraints / fallback |
| --- | --- | --- |
| Markdown/source/images/SVG | Retain CodeMirror and `marked`/DOMPurify; make a document model own dirty text and require Save/Discard/Cancel before selection/tab/close. SVG should be rendered as an image or sanitized SVG, not trusted inline HTML; strip scripts, event handlers, and external URLs. | Keep existing size guards, add format-specific limits and an external-open state. |
| HTML/CSS/JS | Sandbox iframe pointing at the local custom-protocol URL, with scripts enabled only under the registered active root. Keep a Source tab. | Script errors are iframe-local; listen for load/error and offer reload/source/external. Network access remains browser access, so document that trusted scripts can call permitted network endpoints. |
| Mermaid | Lazy-load `mermaid` (current npm result: 11.16.0), call `initialize({ startOnLoad: false, securityLevel: 'strict' })`, render a unique ID, then sanitize/insert the SVG. | Never use Mermaid `loose` security for project text; on parse/render failure show source and a clear diagram error. |
| CSV | Lazy-load Papa Parse (current 5.5.4); parse in its worker mode, use `skipEmptyLines`, cap bytes/rows/columns/cell length, and render a virtualized DOM grid using `textContent`. | The result exposes `data`, `errors`, and `meta`; show parser errors and a sampled table rather than freezing the inspector. CSV formulas must not be evaluated. |
| PDF | Use a lazy local `pdfjs-dist` display-layer canvas viewer, not Chromium's built-in `<embed>`. Pin `pdfjs-dist@4.10.38` initially: it declares Node `>=20`, while current 6.1.200 declares `>=22.13 || >=24`, a poor default for Electron 33-era runtime compatibility. Bundle/copy the matching `pdf.worker.mjs`, set `GlobalWorkerOptions.workerSrc` to its packaged/custom-protocol URL, and test the packaged macOS build. | PDF.js requires a worker/server-like URL rather than `file://`; paginate/zoom and cap document size. On worker/CMap/font failure show the error plus external-open. Reassess PDF.js when Electron is upgraded. |
| Jupyter `.ipynb` | Phase 1 should be read-only: JSON-parse nbformat v4, display Markdown via the existing sanitizer, code as CodeMirror, text/JSON streams, and stored image MIME bundles. Sanitize stored `text/html`; do not run it in the app origin. `@jupyterlab/rendermime` (current 4.5.10) is a larger optional later alternative for broad MIME support. | An `.ipynb` is data with optional metadata and stored outputs; source/output fields can be strings or string arrays. Execution is out of scope: it needs a user-selected Jupyter executable, a discovered kernel/environment, explicit consent, a timeout/cancel policy, and an output-file policy. Preflight in main (`jupyter --version` and kernelspec discovery) and report missing Jupyter/kernel/Python rather than silently failing; remote checks need remote support. |
| STL/OBJ/3MF/PLY | Lazy-load `three` (current 0.185.1) and the matching `three/addons` `STLLoader`, `OBJLoader`, `3MFLoader`, and `PLYLoader`. Pass bounded `ArrayBuffer`/text from the inspector, create one disposable scene/canvas per selection, fit camera, and dispose geometries/materials/textures/renderer on selection/close. | STL supports binary/ASCII; OBJ may need MTL/textures, so resolve those only through the asset boundary; 3MF is archive-based. Cap bytes/vertices/textures, catch WebGL/context loss, and offer source/external when parsing or GPU allocation fails. |

All new browser-only packages should be lazy imports so the xterm-first initial bundle remains small. Do not add a native renderer dependency: native modules would add Electron 33 rebuild/packaging risk. Package versions above are research targets, not a dependency change; lock and test them with esbuild and the packaged app before adoption.

## Read-only Git inspector

Implement a main-process Git service, not `isomorphic-git`: Posse already invokes the system `git` with `execFile`, and the CLI exactly represents worktree/index states and diffs. Add project-root authorization and a remote capability branch. For local repositories call direct argument arrays only, use a short timeout/max buffer, `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff`, `--no-color`, and no shell. Recommended operations:

- `git -C <root> status --porcelain=v1 -z --untracked-files=all` → parse NUL records into staged/unstaged/untracked/renamed entries;
- `git -C <root> diff --no-ext-diff --no-color -U3 -- <relative-path>` and the `--cached` equivalent → bounded raw unified diff, then renderer tokenizes lines/hunks with `textContent`;
- a small repository summary/branch call. Never offer add/restore/commit/branch/stash/merge actions.

Return a `not-repository`, `git-missing`, `timeout`, `diff-too-large`, or `remote-unsupported` state rather than an empty success. Pagination/truncation belongs in the service so a large/binary diff cannot starve the renderer. Existing Git IPC needs expansion and does not route remote connections, making remote Git an explicit blocker rather than an accidental local command.

## Recommended delivery phases

1. **Foundation and layout:** Replace the overlay with persistent inspector structure; semantic buttons/tree keyboard model and visible focus; persisted splitter/collapse/drawer; remove/hide no-op chat entry; document model prevents edit loss. Retain current Markdown/image/source behavior and explicit states.
2. **Secure local HTML:** introduce the root-token registry, root-scoped IPC, protocol handler, sandboxed iframe, navigation/popup policy, tests for traversal/symlink/relative assets, and failure isolation. Leave remote HTML source-only until its gateway exists.
3. **Low-risk rich views:** Mermaid, hardened SVG, CSV, then PDF.js with packaged-worker validation. Each is lazy and has source/external recovery.
4. **Git:** local read-only status/file/diff service and inspector; add remote implementation only when the remote service exposes equivalent read-only Git endpoints.
5. **Advanced optional views:** read-only notebook output renderer, then Three.js models with strict resource budgets. Keep notebook execution separate and opt-in after dependency preflight and a dedicated security/product decision.

## Blockers and risks

- **Security blocker:** current file IPC accepts arbitrary local paths. Root-scoped authorization must land before an HTML protocol or a new inspector API exposes more filesystem access.
- **Remote parity blocker:** linked HTML assets, PDF/3D bytes above current caps, Git, and Jupyter dependency checks have no remote serving/execution contract.
- **Packaging blocker:** esbuild only bundles `src/renderer/app.ts`; PDF worker, dynamic imports, Three addons, and any WASM/CMap/font assets need explicit production copy/URL tests. Both `pnpm-lock.yaml` and `package-lock.json` exist; choose the project's package-manager policy before changing either.
- **Trust risk:** project HTML can exfiltrate accessible network data or consume CPU/GPU even when denied Node/Electron. Show the executing root, keep the browser sandbox, enforce navigation policy, make reload/stop available, and preserve terminal responsiveness.
- **Version risk:** Electron 33 is materially older than Electron's current security guidance. Keep Electron upgrades separate, but verify every preview on the Electron 33 Chromium/Node versions actually shipped.

## Sources

- Electron security checklist and isolation guidance: https://www.electronjs.org/docs/latest/tutorial/security
- Electron sandbox behavior: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Electron custom protocol API and standard-scheme relative URL behavior: https://www.electronjs.org/docs/latest/api/protocol
- Electron `WebContentsView` / deprecated `BrowserView`: https://www.electronjs.org/docs/latest/api/web-contents-view and https://www.electronjs.org/docs/latest/api/browser-view
- PDF.js layers, worker layout, and `file://` worker limitation: https://mozilla.github.io/pdf.js/getting_started/
- Mermaid usage/configuration: https://mermaid.js.org/config/usage.html
- Papa Parse result contract: https://www.papaparse.com/docs
- Jupyter nbformat v4 structure and MIME outputs: https://nbformat.readthedocs.io/en/latest/format_description.html ; Jupyter execution requires a notebook server/CLI: https://docs.jupyter.org/en/latest/running.html
- Three.js loaders: https://threejs.org/docs/pages/STLLoader.html , https://threejs.org/docs/pages/OBJLoader.html , https://threejs.org/docs/#examples/en/loaders/3MFLoader , https://threejs.org/docs/#examples/en/loaders/PLYLoader
- `isomorphic-git` status matrix (alternative considered, not recommended here): https://isomorphic-git.org/docs/en/statusMatrix
