// Right-side file preview. Supports multiple render modes by file type:
//   - markdown  → sanitized rendered HTML (with source toggle)
//   - html      → sandboxed iframe (no scripts) (with source toggle)
//   - image     → <img> from a data URL
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

export type PreviewMode = 'markdown' | 'html' | 'image' | 'source';

// Choose the preview mode for a given file extension.
export function modeForExt(ext: string): PreviewMode {
  const e = ext.toLowerCase();
  if (MARKDOWN_EXTS.has(e)) return 'markdown';
  if (HTML_EXTS.has(e)) return 'html';
  if (IMAGE_EXTS.has(e)) return 'image';
  return 'source';
}

// Whether a file extension has a dedicated rich preview (used by terminal link routing).
export function isPreviewableExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return MARKDOWN_EXTS.has(e) || HTML_EXTS.has(e) || IMAGE_EXTS.has(e);
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
  show(content: string, ext: string, path?: string): void;
  // Show an image from a base64 data URL (or any URL).
  showImage(dataUrl: string, ext: string): void;
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

  // --- HTML iframe (sandboxed, no scripts) ---
  const htmlHost = document.createElement('iframe');
  htmlHost.className = 'fp-html';
  // No `allow-scripts` → previewed HTML cannot execute JS.
  htmlHost.setAttribute('sandbox', '');
  htmlHost.hidden = true;

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
  parent.appendChild(imgHost);
  parent.appendChild(cmHost);

  // Current document state for toggling between rendered and source.
  let curContent = '';
  let curExt = '';
  let curPath = '';
  let curMode: PreviewMode = 'source';
  let showingSource = false;
  // In-app editing state (source view only).
  let isEditing = false;
  let isDirty = false;
  let isSaving = false;

  // Source CodeMirror is visible when: pure source mode, OR a md/html file with
  // the Source view selected. Editing only applies to that CodeMirror.
  function sourceVisible(): boolean {
    return curMode === 'source' || (showingSource && curMode !== 'image');
  }

  // Edit/Save controls are offered only where a CodeMirror is actually shown.
  function editAvailable(): boolean {
    return sourceVisible();
  }

  function applyVisibility(): void {
    const renderedVisible = !showingSource;
    cmHost.hidden = !sourceVisible();
    mdHost.hidden = !(curMode === 'markdown' && renderedVisible);
    htmlHost.hidden = !(curMode === 'html' && renderedVisible);
    imgHost.hidden = curMode !== 'image';
    // Toolbar shows for md/html (rendered toggle) and any editable source view.
    toggleBar.hidden = !(curMode === 'markdown' || curMode === 'html' || editAvailable());
    toggleBtn.hidden = !(curMode === 'markdown' || curMode === 'html');
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

  async function doSave(): Promise<void> {
    if (!isEditing || !isDirty || isSaving) return;
    if (!curPath) {
      opts.onToast?.('No file path to save to');
      return;
    }
    if (!opts.onSave) return;
    isSaving = true;
    updateEditUi();
    const text = view.state.doc.toString();
    try {
      const res = await opts.onSave(curPath, text);
      if (res.ok) {
        curContent = text;
        isDirty = false;
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
  }
  // Expose to the Cmd/Ctrl+S keybinding declared in the editor extensions.
  saveCurrent = () => {
    void doSave();
  };

  editBtn.addEventListener('click', () => setEditing(!isEditing));
  saveBtn.addEventListener('click', () => {
    void doSave();
  });

  function renderRendered(): void {
    if (curMode === 'markdown') {
      const rawHtml = marked.parse(curContent, { async: false }) as string;
      mdHost.innerHTML = DOMPurify.sanitize(rawHtml);
      mdHost.scrollTop = 0;
    } else if (curMode === 'html') {
      // Sandboxed iframe with no script execution; render the file verbatim.
      htmlHost.srcdoc = curContent;
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
      // Re-seed from curContent (drops any unsaved edits); leaving source view
      // also exits edit mode so rendered stays read-only.
      renderSource();
    } else {
      if (isEditing) setEditing(false);
      isDirty = false;
      renderRendered();
    }
    applyVisibility();
  });

  // Reset editing/dirty state when a new document is loaded.
  function resetEditState(): void {
    if (isEditing) setEditing(false);
    isEditing = false;
    isDirty = false;
    isSaving = false;
  }

  return {
    show(content: string, ext: string, filePath = '') {
      curContent = content;
      curExt = ext;
      curPath = filePath;
      curMode = modeForExt(ext);
      showingSource = false;
      resetEditState();
      if (curMode === 'markdown' || curMode === 'html') {
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
    destroy() {
      view.destroy();
    },
  };
}
