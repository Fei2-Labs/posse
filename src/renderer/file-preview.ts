// 右侧只读文件预览（CodeMirror 6）
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle, foldGutter } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { yaml } from '@codemirror/lang-yaml';

// 按扩展名挑选语言扩展。未知类型返回空（纯文本）。
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

export interface FilePreview {
  show(content: string, ext: string): void;
  destroy(): void;
}

// 在给定容器内挂载一个只读 CodeMirror 编辑器。
export function createFilePreview(parent: HTMLElement): FilePreview {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        language.of([]),
      ],
    }),
  });

  return {
    show(content: string, ext: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: language.reconfigure(languageForExt(ext)),
      });
      view.scrollDOM.scrollTop = 0;
    },
    destroy() {
      view.destroy();
    },
  };
}
