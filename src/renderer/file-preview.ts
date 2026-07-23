// Right-side file preview. Supports multiple render modes by file type:
//   - markdown  → sanitized rendered HTML (with source toggle)
//   - html      → sandboxed iframe (no scripts) (with source toggle)
//   - image     → <img> from a data URL
//   - Mermaid/CSV/SVG → bounded, sanitized rendered output (with source toggle)
//   - source    → read-only CodeMirror 6 editor (fallback for everything else)
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, foldGutter } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { yaml } from '@codemirror/lang-yaml';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const MARKDOWN_EXTS = new Set(['md', 'markdown']);
const HTML_EXTS = new Set(['html', 'htm']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
const MERMAID_EXTS = new Set(['mmd', 'mermaid']);
const CSV_EXTS = new Set(['csv', 'tsv']);
const PDF_EXTS = new Set(['pdf']);

export type PreviewMode = 'markdown' | 'html' | 'image' | 'svg' | 'mermaid' | 'csv' | 'pdf' | 'source';

// Choose the preview mode for a given file extension.
export function modeForExt(ext: string): PreviewMode {
  const e = ext.toLowerCase();
  if (MARKDOWN_EXTS.has(e)) return 'markdown';
  if (HTML_EXTS.has(e)) return 'html';
  if (e === 'svg') return 'svg';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (MERMAID_EXTS.has(e)) return 'mermaid';
  if (CSV_EXTS.has(e)) return 'csv';
  if (PDF_EXTS.has(e)) return 'pdf';
  return 'source';
}

// Whether a file extension has a dedicated rich preview (used by terminal link routing).
export function isPreviewableExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return MARKDOWN_EXTS.has(e) || HTML_EXTS.has(e) || IMAGE_EXTS.has(e) || MERMAID_EXTS.has(e) || CSV_EXTS.has(e) || PDF_EXTS.has(e);
}

// MIME type for image data URLs.
function imageMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'svg': return 'image/svg+xml';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'ico': return 'image/x-icon';
    default: return `image/${ext.toLowerCase()}`;
  }
}

// Pick a language extension by file extension. Unknown types return empty (plain text).
function languageForExt(ext: string) {
  switch (ext) {
    case 'md':
    case 'markdown':
      return markdown();
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
      return javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
    case 'json':
      return json();
    case 'py':
      return python();
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'yml':
    case 'yaml':
      return yaml();
    default:
      return [];
  }
}

export interface FilePreviewOptions {
  // Persist the current editor text to disk. Resolves with { ok } so the
  // preview can clear the dirty flag and toast. The host wires this to the
  // file-write IPC; the preview never touches IPC directly.
  onSave?: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  // Brief, non-blocking notice (host's toast helper).
  onToast?: (message: string) => void;
}

export interface FilePreview {
  // Show text content (markdown/html/source picked by ext). `path` is the
  // absolute file path, threaded through so in-app edits know what to save.
  show(content: string, ext: string, path?: string, htmlPreviewUrl?: string): void;
  // Show an image from a base64 data URL (or any URL).
  showImage(dataUrl: string, ext: string): void;
  // Show a PDF from a bounded data URL.
  showPdf(dataUrl: string, path?: string): void;
  // Save the current editable source. Returns false when saving is unavailable
  // or fails so callers can keep the document open.
  save(): Promise<boolean>;
  hasUnsavedChanges(): boolean;
  discardChanges(): void;
  destroy(): void;
}

// Mount the preview inside the given container.
export function createFilePreview(parent: HTMLElement, opts: FilePreviewOptions = {}): FilePreview {
  // --- Source editor (CodeMirror) ---
  const cmHost = document.createElement('div');
  cmHost.className = 'fp-source';
  const language = new Compartment();
  // Toggled between read-only (default) and editable when the user opts in.
  const editable = new Compartment();
  // Save current editor text to disk; declared after `view` exists.
  let saveCurrent: () => void = () => {};
  const view = new EditorView({
    parent: cmHost,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        EditorView.lineWrapping,
        language.of([]),
        // Cmd/Ctrl+S saves when editable. High precedence so it beats defaults.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                saveCurrent();
                return true;
              },
            },
          ]),
        ),
        // Track dirty state: any user edit while editable marks the doc dirty.
        EditorView.updateListener.of((u) => {
          if (u.docChanged && isEditing) {
            markDirty();
          }
        }),
      ],
    }),
  });

  // --- Rendered markdown container ---
  const mdHost = document.createElement('div');
  mdHost.className = 'fp-markdown markdown-body';
  mdHost.hidden = true;

  // --- HTML iframe (project scripts run only in its separate protocol origin) ---
  const htmlHost = document.createElement('iframe');
  htmlHost.className = 'fp-html';
  htmlHost.setAttribute('sandbox', '');
  htmlHost.hidden = true;

  const mermaidHost = document.createElement('div');
  mermaidHost.className = 'fp-mermaid';
  mermaidHost.hidden = true;

  const csvHost = document.createElement('div');
  csvHost.className = 'fp-csv';
  csvHost.hidden = true;

  const svgHost = document.createElement('div');
  svgHost.className = 'fp-svg';
  svgHost.hidden = true;

  const pdfHost = document.createElement('div');
  pdfHost.className = 'fp-pdf';
  pdfHost.hidden = true;

  // --- Image container ---
  const imgHost = document.createElement('div');
  imgHost.className = 'fp-image';
  imgHost.hidden = true;
  const imgEl = document.createElement('img');
  imgHost.appendChild(imgEl);

  // --- Toolbar: Edit/Save (left) + source/rendered toggle (right) ---
  const toggleBar = document.createElement('div');
  toggleBar.className = 'fp-toggle';
  toggleBar.hidden = true;

  // Edit toggle + Save live on the left, pushed away from the rendered toggle.
  const editGroup = document.createElement('div');
  editGroup.className = 'fp-edit-group';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'fp-toggle-btn fp-edit-btn';
  editBtn.textContent = 'Edit';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'fp-toggle-btn fp-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.hidden = true;
  editGroup.appendChild(editBtn);
  editGroup.appendChild(saveBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'fp-toggle-btn';

  toggleBar.appendChild(editGroup);
  toggleBar.appendChild(toggleBtn);

  parent.appendChild(toggleBar);
  parent.appendChild(mdHost);
  parent.appendChild(htmlHost);
  parent.appendChild(mermaidHost);
  parent.appendChild(csvHost);
  parent.appendChild(svgHost);
  parent.appendChild(pdfHost);
  parent.appendChild(imgHost);
  parent.appendChild(cmHost);

  // Current document state for toggling between rendered and source.
  let curContent = '';
  let curExt = '';
  let curPath = '';
  let curHtmlPreviewUrl = '';
  let curMode: PreviewMode = 'source';
  let showingSource = false;
  // In-app editing state (source view only).
  let isEditing = false;
  let isDirty = false;
  let isSaving = false;
  let renderRequestId = 0;
  let pdfPage = 1;
  let activePdfDocument: { destroy(): Promise<void> } | null = null;

  // Source CodeMirror is visible when: pure source mode, OR a md/html file with
  // the Source view selected. Editing only applies to that CodeMirror.
  function sourceVisible(): boolean {
    return curMode === 'source' || (showingSource && curMode !== 'image');
  }

  // Edit/Save controls are offered only where a CodeMirror is actually shown.
  function editAvailable(): boolean {
    return sourceVisible() && curMode !== 'pdf';
  }

  function applyVisibility(): void {
    const renderedVisible = !showingSource;
    cmHost.hidden = !sourceVisible();
    mdHost.hidden = !(curMode === 'markdown' && renderedVisible);
    htmlHost.hidden = !(curMode === 'html' && renderedVisible);
    mermaidHost.hidden = !(curMode === 'mermaid' && renderedVisible);
    csvHost.hidden = !(curMode === 'csv' && renderedVisible);
    svgHost.hidden = !(curMode === 'svg' && renderedVisible);
    pdfHost.hidden = !(curMode === 'pdf' && renderedVisible);
    imgHost.hidden = curMode !== 'image';
    // Toolbar shows for md/html (rendered toggle) and any editable source view.
    toggleBar.hidden = !(curMode === 'markdown' || curMode === 'html' || curMode === 'svg' || curMode === 'mermaid' || curMode === 'csv' || curMode === 'pdf' || editAvailable());
    toggleBtn.hidden = !(curMode === 'markdown' || curMode === 'html' || curMode === 'svg' || curMode === 'mermaid' || curMode === 'csv' || curMode === 'pdf');
    toggleBtn.textContent = showingSource ? 'Rendered' : 'Source';
    editGroup.hidden = !editAvailable();
    updateEditUi();
  }

  function updateEditUi(): void {
    editBtn.textContent = isEditing ? 'Editing' : 'Edit';
    editBtn.classList.toggle('fp-edit-active', isEditing);
    saveBtn.hidden = !(isEditing && isDirty);
    saveBtn.disabled = isSaving;
    saveBtn.textContent = isDirty ? 'Save *' : 'Save';
  }

  function markDirty(): void {
    if (!isDirty) {
      isDirty = true;
      updateEditUi();
    }
  }

  function setEditing(on: boolean): void {
    isEditing = on;
    view.dispatch({
      effects: editable.reconfigure(
        on
          ? [EditorState.readOnly.of(false), EditorView.editable.of(true)]
          : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      ),
    });
    if (on) {
      // Switching a md/html file into edit mode forces the Source view.
      if (!showingSource && curMode !== 'source') {
        showingSource = true;
        renderSource();
      }
      view.focus();
    }
    updateEditUi();
  }

  async function doSave(): Promise<boolean> {
    if (!isEditing || !isDirty) return true;
    if (isSaving) return false;
    if (!curPath) {
      opts.onToast?.('No file path to save to');
      return false;
    }
    if (!opts.onSave) return false;
    isSaving = true;
    updateEditUi();
    const text = view.state.doc.toString();
    let saved = false;
    try {
      const res = await opts.onSave(curPath, text);
      if (res.ok) {
        curContent = text;
        isDirty = false;
        saved = true;
        opts.onToast?.('Saved');
      } else {
        opts.onToast?.(`Save failed: ${res.error || 'unknown error'}`);
      }
    } catch (err) {
      opts.onToast?.(`Save failed: ${(err as Error).message}`);
    } finally {
      isSaving = false;
      updateEditUi();
    }
    return saved;
  }
  // Expose to the Cmd/Ctrl+S keybinding declared in the editor extensions.
  saveCurrent = () => {
    void doSave();
  };

  editBtn.addEventListener('click', () => setEditing(!isEditing));
  saveBtn.addEventListener('click', () => {
    void doSave();
  });

  function renderPreviewError(host: HTMLElement, message: string): void {
    host.replaceChildren();
    const state = document.createElement('div');
    state.className = 'fp-render-error';
    state.textContent = message;
    host.appendChild(state);
  }

  function hasBoundedContent(limit: number): boolean {
    return new Blob([curContent]).size <= limit;
  }

  function renderSvg(): void {
    if (!hasBoundedContent(2 * 1024 * 1024)) {
      renderPreviewError(svgHost, 'SVG previews are limited to 2 MB. Open Source or use an external viewer.');
      return;
    }
    const sanitized = DOMPurify.sanitize(curContent, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject'],
    });
    svgHost.innerHTML = sanitized;
    for (const element of svgHost.querySelectorAll('[href], [xlink\\:href], [src]')) {
      const href = element.getAttribute('href') || element.getAttribute('xlink:href') || element.getAttribute('src') || '';
      if (href && !href.startsWith('#')) {
        element.removeAttribute('href');
        element.removeAttribute('xlink:href');
        element.removeAttribute('src');
      }
    }
  }

  async function renderMermaid(requestId: number): Promise<void> {
    if (!hasBoundedContent(1024 * 1024)) {
      renderPreviewError(mermaidHost, 'Mermaid previews are limited to 1 MB. Open Source to inspect this file.');
      return;
    }
    mermaidHost.replaceChildren();
    mermaidHost.textContent = 'Rendering diagram…';
    try {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      const result = await mermaid.render(`posse-mermaid-${requestId}`, curContent);
      if (requestId !== renderRequestId) return;
      mermaidHost.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    } catch {
      if (requestId === renderRequestId) renderPreviewError(mermaidHost, 'The diagram could not be rendered. Open Source to fix the syntax.');
    }
  }

  async function renderCsv(requestId: number): Promise<void> {
    if (!hasBoundedContent(2 * 1024 * 1024)) {
      renderPreviewError(csvHost, 'CSV previews are limited to 2 MB. Open Source or use an external viewer.');
      return;
    }
    csvHost.replaceChildren();
    csvHost.textContent = 'Parsing table…';
    try {
      const { default: Papa } = await import('papaparse');
      const delimiter = curExt.toLowerCase() === 'tsv' ? '\t' : '';
      Papa.parse<string[]>(curContent, {
        delimiter,
        skipEmptyLines: true,
        worker: true,
        complete: (result) => {
          if (requestId !== renderRequestId) return;
          const rows = result.data.slice(0, 500).map((row) => row.slice(0, 100).map((cell) => cell.slice(0, 20_000)));
          if (result.errors.length > 0 || rows.length === 0) {
            renderPreviewError(csvHost, result.errors[0]?.message || 'The table is empty or invalid.');
            return;
          }
          const table = document.createElement('table');
          const head = table.createTHead().insertRow();
          for (const cell of rows[0]) head.insertCell().textContent = cell;
          const body = table.createTBody();
          for (const row of rows.slice(1)) {
            const tableRow = body.insertRow();
            for (const cell of row) tableRow.insertCell().textContent = cell;
          }
          csvHost.replaceChildren(table);
        },
        error: () => {
          if (requestId === renderRequestId) renderPreviewError(csvHost, 'The table could not be parsed.');
        },
      });
    } catch {
      if (requestId === renderRequestId) renderPreviewError(csvHost, 'CSV preview is unavailable.');
    }
  }

  function decodeDataUrl(dataUrl: string): Uint8Array | null {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    try {
      const binary = atob(dataUrl.slice(comma + 1));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }

  async function renderPdf(requestId: number, dataUrl: string): Promise<void> {
    const data = decodeDataUrl(dataUrl);
    if (!data) {
      renderPreviewError(pdfHost, 'The PDF data could not be decoded.');
      return;
    }
    pdfHost.replaceChildren();
    pdfHost.textContent = 'Loading PDF…';
    try {
      const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).toString();
      const pdfDocument = await pdfjs.getDocument({ data }).promise;
      if (requestId !== renderRequestId) {
        void pdfDocument.destroy();
        return;
      }
      activePdfDocument = pdfDocument;
      const toolbar = document.createElement('div');
      toolbar.className = 'fp-pdf-toolbar';
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.textContent = 'Previous';
      const pageLabel = document.createElement('span');
      const next = document.createElement('button');
      next.type = 'button';
      next.textContent = 'Next';
      const canvas = document.createElement('canvas');
      const renderPage = async (): Promise<void> => {
        const page = await pdfDocument.getPage(pdfPage);
        if (requestId !== renderRequestId) return;
        const viewport = page.getViewport({ scale: window.devicePixelRatio > 1 ? 1.5 : 1.25 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        pageLabel.textContent = `${pdfPage} / ${pdfDocument.numPages}`;
        previous.disabled = pdfPage === 1;
        next.disabled = pdfPage === pdfDocument.numPages;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable');
        await page.render({ canvasContext: context, viewport }).promise;
      };
      previous.addEventListener('click', () => {
        if (pdfPage > 1) {
          pdfPage -= 1;
          void renderPage();
        }
      });
      next.addEventListener('click', () => {
        if (pdfPage < pdfDocument.numPages) {
          pdfPage += 1;
          void renderPage();
        }
      });
      toolbar.append(previous, pageLabel, next);
      pdfHost.replaceChildren(toolbar, canvas);
      await renderPage();
    } catch {
      if (requestId === renderRequestId) renderPreviewError(pdfHost, 'The PDF could not be rendered. Open it externally if the problem continues.');
    }
  }

  function renderRendered(): void {
    if (curMode === 'markdown') {
      const rawHtml = marked.parse(curContent, { async: false }) as string;
      mdHost.innerHTML = DOMPurify.sanitize(rawHtml);
      mdHost.scrollTop = 0;
    } else if (curMode === 'html') {
      htmlHost.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      if (curHtmlPreviewUrl && !isDirty) {
        htmlHost.removeAttribute('srcdoc');
        htmlHost.src = curHtmlPreviewUrl;
      } else {
        htmlHost.removeAttribute('src');
        htmlHost.srcdoc = curContent;
      }
    } else if (curMode === 'svg') {
      renderSvg();
    } else if (curMode === 'mermaid') {
      const requestId = ++renderRequestId;
      void renderMermaid(requestId);
    } else if (curMode === 'csv') {
      const requestId = ++renderRequestId;
      void renderCsv(requestId);
    }
  }

  function renderSource(): void {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: curContent },
      effects: language.reconfigure(languageForExt(curExt)),
    });
    view.scrollDOM.scrollTop = 0;
  }

  toggleBtn.addEventListener('click', () => {
    showingSource = !showingSource;
    if (showingSource) {
      renderSource();
    } else {
      // Rendering from the editor keeps dirty source available when the user
      // returns to Source instead of silently resetting their changes.
      curContent = view.state.doc.toString();
      renderRendered();
    }
    applyVisibility();
  });

  // Reset editing/dirty state when a new document is loaded.
  function resetEditState(): void {
    if (activePdfDocument) {
      void activePdfDocument.destroy();
      activePdfDocument = null;
    }
    if (isEditing) setEditing(false);
    isEditing = false;
    isDirty = false;
    isSaving = false;
  }

  return {
    show(content: string, ext: string, filePath = '', htmlPreviewUrl = '') {
      curContent = content;
      curExt = ext;
      curPath = filePath;
      curHtmlPreviewUrl = htmlPreviewUrl;
      curMode = modeForExt(ext);
      if (curMode === 'html' && !curHtmlPreviewUrl) curMode = 'source';
      showingSource = false;
      resetEditState();
      if (curMode === 'markdown' || curMode === 'html' || curMode === 'svg' || curMode === 'mermaid' || curMode === 'csv') {
        renderRendered();
      } else {
        // source / fallback
        renderSource();
      }
      applyVisibility();
    },
    showImage(dataUrl: string, ext: string) {
      curContent = '';
      curExt = ext;
      curPath = '';
      curMode = 'image';
      showingSource = false;
      resetEditState();
      imgEl.src = dataUrl;
      imgEl.alt = '';
      applyVisibility();
    },
    showPdf(dataUrl: string, filePath = '') {
      curContent = 'PDF files are binary. Use an external viewer to inspect their raw contents.';
      curExt = 'pdf';
      curPath = filePath;
      curMode = 'pdf';
      showingSource = false;
      pdfPage = 1;
      resetEditState();
      const requestId = ++renderRequestId;
      void renderPdf(requestId, dataUrl);
      applyVisibility();
    },
    save() {
      return doSave();
    },
    hasUnsavedChanges() {
      return isDirty;
    },
    discardChanges() {
      if (isEditing) setEditing(false);
      isDirty = false;
      updateEditUi();
    },
    destroy() {
      view.destroy();
    },
  };
}
