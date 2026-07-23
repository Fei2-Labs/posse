# Agent Desktop Workspace Audit

## Scope

This research examines the public `BaLaurent/agent-desktop` repository as a product and interaction reference for Posse. It does not recommend copying code because Agent Desktop is licensed AGPL-3.0-only while Posse is MIT.

## Relevant Patterns

### Persistent inspector

Agent Desktop keeps the main work surface visible while presenting Files, Preview, and Git in a right panel. On compact layouts, the panel becomes an overlay with an explicit backdrop rather than compressing the main surface indefinitely.

**Mapping to Posse:** Move the existing preview from an absolute terminal overlay to a right inspector. Preserve Posse's terminal as the primary center surface, with the inspector as optional secondary context.

### Viewer state

Its file explorer tracks selected path, content, language, loading, errors, dirty state, and source versus preview mode in one state boundary. This lets the viewer show a loading state, preserve edits, and render an appropriate empty state.

**Mapping to Posse:** Define a focused inspector state model before adding formats. Do not let individual click handlers own loading, selection, edit state, and layout independently.

### HTML safety

For file previews, Agent Desktop uses a custom protocol that resolves local relative resources. JavaScript is disabled by default and requires an explicit one-time or trusted-folder decision.

**Mapping to Posse:** `iframe.srcdoc` is sufficient only for static isolated markup. A functional local app preview requires a constrained Electron protocol and a deliberate trust policy; this should not be enabled silently.

### Typed renderers

The preview dispatches by extension to source editor, HTML, Markdown, SVG, Mermaid, CSV, notebooks, and model viewers. The source/preview toggle and expanded viewer are consistent across types.

**Mapping to Posse:** First add high-value developer formats: Markdown/GFM, Mermaid, HTML/CSS/JS, SVG, images, CSV, and source. Defer notebook and 3D previews.

### Resilience and quality

The app uses renderer error boundaries, component tests, and Storybook. Panel and preview failures have isolated fallback states instead of crashing the workspace.

**Mapping to Posse:** The first refactor should isolate the inspector from terminal lifecycle. Add focused tests before expanding feature breadth.

## Recommended Direction

Build a terminal-first persistent inspector in incremental milestones:

1. Stabilize the inspector shell, layout behavior, semantic controls, and preview state.
2. Move current Markdown, HTML, image, and source preview into it while preserving dirty edits and exposing state feedback.
3. Add Mermaid, SVG, and CSV, then implement a scoped HTML runtime trust model if functional HTML app previews are required.
4. Consider Git and advanced artifact formats only after the inspector behavior is stable.

## Sources

* https://github.com/BaLaurent/agent-desktop
* `src/renderer/layouts/MainLayout.tsx`
* `src/renderer/components/panel/PreviewTab.tsx`
* `src/renderer/components/panel/RightSidebarPanel.tsx`
* `src/renderer/components/panel/ExpandedViewerModal.tsx`
* `src/renderer/components/artifacts/HtmlPreview.tsx`
