# Research: File Preview Pane + Session/Task List Grouping UI

- **Query**: (1) Embedded read-only syntax-highlighted file preview / diff inside a terminal/agent app; lightweight DOM/Electron options. (2) Session/task list grouping + filtering UI with collapsible groups and live status.
- **Scope**: External (library/UX patterns) + internal (this repo's renderer constraints)
- **Date**: 2026-06-16

## Repo constraints that shape the recommendation

- Renderer is **vanilla TypeScript + DOM**, **no React/Vue**. (`src/terminal-client/app.ts`, `src/renderer/app.ts`)
- Bundler is **esbuild**, `--platform=browser` (`package.json` `build:renderer`, `build:terminal-client`).
- Rendering surface already uses **xterm.js** (`@xterm/xterm@^5.5.0`).
- Standalone client talks to a daemon over **HTTP/WS only** (no Electron IPC); preview content must be fetchable that way.
- Design tokens already exist as CSS vars in `:root`; components styled ad hoc.
- Build is a simple single-entry esbuild bundle — anything pulling in web workers, WASM, or CSS-import side effects adds build friction.

---

## Topic 1 — File preview / diff library options

### Comparison table

| Library | License | Approx bundle (min) | Workers/WASM | Non-React / vanilla DOM | Diff support | esbuild friction |
|---|---|---|---|---|---|---|
| **Monaco Editor** (read-only) | MIT | ~2–5 MB JS + workers | Yes (web workers per language for full IntelliSense; can run worker-less for plain highlight) | Yes — imperative `monaco.editor.create(el, {...})` API, framework-agnostic | First-class **DiffEditor** (side-by-side + inline) | High — needs worker entry points / `MonacoWebpackPlugin`-equivalent wiring; with esbuild you must define worker URLs manually |
| **CodeMirror 6** | MIT | ~150–400 KB depending on languages | No | Yes — pure imperative `EditorView`/`EditorState`, no framework | Via `@codemirror/merge` (unified or side-by-side merge view) | Low–medium — tree-shakeable ES modules, plays well with esbuild; many small packages to wire |
| **Shiki** | MIT | core small, but ships TextMate grammars + Oniguruma WASM (grammars are large, lazy-loadable per language) | WASM (Oniguruma) | Yes — `codeToHtml(code, {lang, theme})` returns an HTML string; render-only, no editor | No native diff (pair with diff2html or render two columns) | Medium — WASM asset must be served/bundled; works but needs asset handling |
| **highlight.js** | BSD-3-Clause | ~25–120 KB depending on bundled languages | No | Yes — `hljs.highlightElement(el)` on a `<pre><code>` | No diff | Very low — drop-in, single import, trivial under esbuild |
| **Prism.js** (alt to hljs) | MIT | ~20–60 KB | No | Yes — `Prism.highlightElement` | No diff | Very low |
| **diff2html** | MIT | ~40–80 KB (+ optional hljs for in-diff highlighting) | No | Yes — `Diff2Html.html(unifiedDiffString, {...})` returns HTML; or `Diff2HtmlUI` for DOM | **Purpose-built**: parses unified-diff/`git diff` text → side-by-side or line-by-line HTML | Very low |

Notes / caveats:
- **Monaco** is the heaviest by far. Its value is full editor behavior (folding, minimap, find, perfect diff). For a *read-only preview* most of that is unused weight, and esbuild worker wiring is the biggest integration cost. Worker-less mode loses language services but still renders. It is what VS Code itself uses.
- **CodeMirror 6** is the sweet spot for "interactive-ish but lightweight": small, tree-shakeable, vanilla-imperative, has a real merge/diff view (`@codemirror/merge`), virtual-scrolls long files natively. More wiring than a one-liner highlighter because you compose extensions.
- **Shiki** produces VS Code-quality, theme-accurate highlighting as a static HTML string — ideal when you only need to *display* code, not edit it. Cost is the Oniguruma WASM + per-language TextMate grammars (lazy-load the languages you need). No virtual scroll on its own; for very large files you must add windowing or chunk the highlight.
- **highlight.js / Prism** are the lightest. They highlight a `<pre>` block. For huge files you must add your own virtual scrolling (highlight only visible lines), since highlighting a 50k-line file in one DOM pass is slow.
- **diff2html** is the cleanest answer specifically for the *diff* requirement: feed it the unified diff text (which a coding-agent/daemon typically already has), get side-by-side or inline HTML, optionally syntax-highlight cells via hljs.

### Recommendation for THIS app

Two-track, both MIT/BSD, both vanilla-friendly, both trivial-to-medium under esbuild, no React:

- **File preview (read-only):** **CodeMirror 6** if you want native virtual scrolling + future light interactivity (search, line selection) in a small bundle; **Shiki** if you want the closest VS-Code-accurate static highlight and the files are small/medium (lazy-load grammars). Avoid Monaco unless you later need full editor features — its bundle + esbuild worker setup is disproportionate for read-only preview.
- **Diff view:** **diff2html** — it is the lowest-friction, purpose-built option for rendering unified diffs the daemon/agent already produces, and pairs with highlight.js for colored diff cells.

If you must minimize total dependency count and the files are typically small, **highlight.js (preview) + diff2html (diff)** is the absolute lightest, lowest-build-friction combo — at the cost of adding your own virtual scroll for large files.

---

## Topic 2 — Session/task list grouping & filtering UI

### How reference tools render grouped lists with live status

- **VS Code (Explorer / Source Control / Terminal tabs):** uses a **tree with collapsible group headers**. Group header is a row with a twistie (chevron) + label + a **count badge** on the right. Status is shown via per-item **decorations**: a colored letter/dot badge (e.g. `M`/`U` in SCM) and item-level icons. The terminal panel uses a flat list of tabs with per-tab status icons; the "split" terminals nest under a parent. Key pattern: header row is sticky while its children scroll.
- **Warp:** sessions/tabs are **compact rows**; Warp groups blocks within a session rather than grouping sessions in a left rail, but its launch/command palette and tab strip show **status affordances** (running spinner, exit-code color). The takeaway worth adapting (already noted in the prior Warp research): terminal-primary surface, compact session headers, command launcher to create/switch.
- **Wave Terminal:** left-rail **workspace/tab model** with grouped blocks; each block/tab carries a small **status indicator**. Grouping is by workspace, shown as collapsible sections.
- **Claude Code / agent GUIs (general pattern):** left rail of agent/session rows grouped by repo or agent type, each row showing a **live status pill**: spinner = running, amber/pulse = waiting-for-input, check/grey = done. In-progress rows often animate (pulsing dot or indeterminate bar).

### Reusable UI primitives observed across all of them

1. **Collapsible group header row**: chevron/twistie + group label + right-aligned count badge; click toggles `aria-expanded`. Sticky on scroll is a common upgrade.
2. **Status badge / pill per item**, three+ states:
   - running → spinner or pulsing accent dot
   - waiting-for-input → amber/attention dot, often with a subtle pulse to draw the eye
   - done/idle → static check or muted grey dot; error → red dot + exit code
3. **In-progress indicator**: indeterminate spinner or pulsing dot at the row level; some show an indeterminate progress bar under the active row.
4. **Filtering**: a top search box filters items live; selecting a "group by" control (by agent type / by folder-repo) re-buckets the same flat data into different headers.

### Tree vs flat-with-group-headers — trade-offs

| | **True tree** (nested, arbitrary depth) | **Flat list + group headers** (single level of grouping) |
|---|---|---|
| Data model | Recursive nodes; expand state per node | Flat array + a `groupBy` key; headers derived at render time |
| Re-group by different key | Expensive — must rebuild the tree | Cheap — just change the `groupBy` selector and re-bucket |
| Virtualization | Harder (variable depth, dynamic expand) | Easy — flatten to `[header, item, item, header, ...]` rows and window them |
| Implementation in vanilla DOM | More code (recursion, indent guides, deep a11y) | Much simpler; one map/reduce by key, render section + rows |
| Fits requirement (group by agent type OR folder/repo, switchable) | Overkill | **Ideal** — the requirement is exactly one switchable grouping dimension |
| UX for this app | Indent noise for a shallow hierarchy | Cleaner; matches VS Code SCM-group / Wave-workspace feel |

**Pattern recommendation:** Use **flat-with-group-headers**, not a true tree. Keep sessions as a flat array; derive groups at render time from a `groupBy` selector (`agentType` | `folderRepo`). Render each group as a **collapsible sticky header (chevron + label + count)** followed by compact session rows, each row carrying a **3-state status pill** (running spinner / waiting-for-input amber pulse / done-or-error dot). This re-buckets trivially when the user switches the grouping dimension and virtualizes easily if the list grows — both of which a real tree makes harder. It also matches the Warp-style compact, terminal-primary direction already chosen for this task.

---

## External references

- Monaco Editor — github.com/microsoft/monaco-editor (MIT); Diff Editor API.
- CodeMirror 6 — codemirror.net (MIT); `@codemirror/merge` for diff/merge view.
- Shiki — shiki.style (MIT); `codeToHtml`, lazy language/theme loading, Oniguruma WASM.
- highlight.js — highlightjs.org (BSD-3-Clause); `highlightElement`.
- Prism.js — prismjs.com (MIT).
- diff2html — github.com/rtfpessoa/diff2html (MIT); unified-diff → side-by-side/inline HTML.
- VS Code tree/SCM decoration + collapsible group patterns; Wave Terminal workspace/block model; Warp tab/command-launcher patterns (see prior note below).

## Related specs / prior research

- `.trellis/tasks/archive/2026-06/06-15-terminal-client-separation/research/warp-ui-architecture.md` — prior Warp UI patterns (terminal-primary, compact session headers, command launcher).
- `.trellis/tasks/06-16-warp-style-terminal-client-ui/prd.md` — this task's PRD (vanilla DOM, esbuild, daemon HTTP/WS, no Electron IPC).

## Caveats / Not Found

- Bundle sizes are approximate and version-dependent (depend on which languages/themes/extensions you include) — verify with an actual esbuild `--metafile` once you pick libs.
- Did not find this app shipping any of these libs today; all five preview options would be **new dependencies**. Confirm the daemon can serve file contents and/or unified diffs over the existing HTTP API before building the pane (the standalone client has no Electron IPC fallback).
- Warp/Wave are closed-source on the UI layer; their exact internal status-badge implementation is inferred from observable UX, not source.
