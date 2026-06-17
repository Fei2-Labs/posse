import { Terminal, IBufferLine, ILinkProvider, ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';

// Terminal color schemes
const THEMES: Record<string, any> = {
  'vscode-dark': {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#aeafad',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  'monokai': {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  'dracula': {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  'one-dark': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  'nord': {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};

// Accent color for each theme (used for the sidebar dots)
const THEME_DOTS: Record<string, string> = {
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};

// File path regexes
const SOURCE_EXT_PATTERN = 'vue|ts|tsx|js|jsx|json|css|scss|less|html|md|yaml|yml|xml|svg|py|go|rs|java|kt|swift|c|cpp|h|hpp|sh|bash|zsh|toml|conf|txt|env|lock|config|nvue|wxml|wxss';
// 0. Prefixed source paths that may contain spaces: ~/My Apps/a.md, /Users/me/My App/a.ts, ./My App/a.ts
const PREFIXED_SOURCE_PATH_RE = new RegExp(
  `(?:~\\/|\\/|\\.{1,2}\\/|@\\/?)` +
    `[^\\n\\r<>"'\`|]*?` +
    `\\.(?:${SOURCE_EXT_PATTERN})(?::\\d+(?::\\d+)?)?`,
  'g',
);
// 1. Paths with a directory: /abs/path, rel/path, @alias/path, ./rel/path
const PATH_RE = /(?:@\/?|\.\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)+[\w.\-\u4e00-\u9fff]*(?:\.[\w]+)?/g;
// 2. Single filename (no directory, with a source extension)
const SINGLE_FILE_RE = new RegExp(`(?<![\\/\\w.\\-])[\\w.\\-\\u4e00-\\u9fff]+\\.(?:${SOURCE_EXT_PATTERN})(?![\\w.\\-])`, 'g');

// Common source extensions
const SOURCE_EXTS = new Set([
  'vue', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'html',
  'md', 'yaml', 'yml', 'xml', 'svg', 'py', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'toml', 'conf',
  'txt', 'env', 'lock', 'config', 'nvue', 'wxml', 'wxss',
]);

// URL regex
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function stripPathSuffix(filePath: string): string {
  return filePath
    .replace(/[.,;:!?)\]}>]+$/, '')
    .replace(/:\d+(?::\d+)?$/, '');
}

function cleanPathMatch(filePath: string): string {
  return stripPathSuffix(filePath).replace(/\\ /g, ' ');
}

// File-path link detector
class FilePathLinkProvider implements ILinkProvider {
  private onClickCallback: (resolvedPath: string) => void;
  private getCwd: () => string;
  private terminal: Terminal;

  constructor(terminal: Terminal, getCwd: () => string, onClick: (resolvedPath: string) => void) {
    this.terminal = terminal;
    this.getCwd = getCwd;
    this.onClickCallback = onClick;
  }

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(y - 1);
    if (!line) { callback(undefined); return; }

    // Skip wrapped continuation lines (the whole wrapped sequence is handled from its starting line)
    if (line.isWrapped) { callback(undefined); return; }

    // Collect the starting line and all subsequent wrapped lines
    const bufferLines: IBufferLine[] = [line];
    let nextY = y;
    while (true) {
      const nextLine = buffer.getLine(nextY);
      if (nextLine && nextLine.isWrapped) {
        bufferLines.push(nextLine);
        nextY++;
      } else {
        break;
      }
    }

    // Concatenate the text, recording each character's buffer line index and cell column
    let text = '';
    const posLine: number[] = [];
    const posCell: number[] = [];

    for (let li = 0; li < bufferLines.length; li++) {
      const bl = bufferLines[li];
      const bufLineIdx = y - 1 + li;
      for (let i = 0; i < bl.length; i++) {
        const cell = bl.getCell(i);
        const chars = cell?.getChars() || '';
        const width = cell?.getWidth() || 1;
        if (chars.length > 0) {
          for (let c = 0; c < chars.length; c++) {
            posLine.push(bufLineIdx);
            posCell.push(i);
          }
          text += chars;
        } else if (width === 0) {
          // Trailing cell of a wide character
        } else {
          posLine.push(bufLineIdx);
          posCell.push(i);
          text += ' ';
        }
      }
    }

    const cwd = this.getCwd();
    const matched: Array<{ filePath: string; display: string; index: number; length: number; isUrl: boolean }> = [];

    // 1. Match URLs
    let match: RegExpExecArray | null;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      let url = match[0].replace(/[.,;:!?)\]}>]+$/, '');
      if (url.length < 8) continue;
      const overlaps = matched.some(r => match!.index >= r.index && match!.index < r.index + r.length);
      if (overlaps) continue;
      matched.push({ filePath: url, display: url, index: match.index, length: url.length, isUrl: true });
    }

    // 2. Match prefixed paths that may contain spaces
    PREFIXED_SOURCE_PATH_RE.lastIndex = 0;
    while ((match = PREFIXED_SOURCE_PATH_RE.exec(text)) !== null) {
      const rawPath = stripPathSuffix(match[0]);
      const fp = cleanPathMatch(rawPath);
      if (fp.length < 4) continue;
      if (fp.includes('node_modules')) continue;
      const overlaps = matched.some(r => match!.index >= r.index && match!.index < r.index + r.length);
      if (overlaps) continue;
      matched.push({ filePath: fp, display: fp, index: match.index, length: rawPath.length, isUrl: false });
    }

    // 3. Match paths with a directory
    PATH_RE.lastIndex = 0;
    while ((match = PATH_RE.exec(text)) !== null) {
      const rawPath = stripPathSuffix(match[0]);
      let fp = cleanPathMatch(rawPath);
      if (fp.length < 4) continue;
      const before = text.substring(Math.max(0, match.index - 10), match.index);
      if (/:\/{0,2}$/.test(before) || /:\d+$/.test(before)) continue;
      if (fp.includes('node_modules')) continue;
      const ext = fp.split('.').pop()?.toLowerCase() || '';
      const isDir = fp.endsWith('/');
      if (!isDir && !fp.startsWith('/') && !SOURCE_EXTS.has(ext)) continue;
      const overlaps = matched.some(r => match!.index >= r.index && match!.index < r.index + r.length);
      if (overlaps) continue;
      matched.push({ filePath: fp, display: fp, index: match.index, length: rawPath.length, isUrl: false });
    }

    // 4. Match single filenames
    SINGLE_FILE_RE.lastIndex = 0;
    while ((match = SINGLE_FILE_RE.exec(text)) !== null) {
      const fp = match[0];
      const overlaps = matched.some(r => match!.index >= r.index && match!.index < r.index + r.length);
      if (overlaps) continue;
      matched.push({ filePath: fp, display: fp, index: match.index, length: fp.length, isUrl: false });
    }

    // Build links
    const links: ILink[] = [];
    for (const m of matched) {
      const si = m.index;
      const ei = m.index + m.length - 1;
      if (si >= posLine.length || ei >= posLine.length) continue;

      if (m.isUrl) {
        links.push({
          range: {
            start: { x: posCell[si] + 1, y: posLine[si] + 1 },
            end: { x: posCell[ei] + 1, y: posLine[ei] + 1 },
          },
          text: m.display,
          activate: () => { (window as any).posse?.openUrl?.(m.filePath); },
        });
      } else {
        let resolved = m.filePath;
        resolved = resolved.replace(/\\ /g, ' ');
        if (resolved.startsWith('~/')) {
          // main process expands this to the current user's home directory.
        } else if (resolved.startsWith('/')) {
          // Absolute path
        } else if (resolved.startsWith('@/') || resolved.startsWith('@')) {
          resolved = cwd + '/' + resolved.replace(/^@\/?/, '');
        } else if (resolved.startsWith('./')) {
          resolved = cwd + '/' + resolved.replace(/^\.\//, '');
        } else {
          resolved = cwd + '/' + resolved;
        }
        if (resolved.endsWith('/')) resolved = resolved.slice(0, -1);
        links.push({
          range: {
            start: { x: posCell[si] + 1, y: posLine[si] + 1 },
            end: { x: posCell[ei] + 1, y: posLine[ei] + 1 },
          },
          text: m.display,
          activate: () => { this.onClickCallback(resolved); },
        });
      }
    }
    callback(links.length > 0 ? links : undefined);
  }
}

// Terminal context menu (right-click on a file link)
function showTermContextMenu(x: number, y: number, fileName: string, openFn: () => void): void {
  // Remove any existing menu
  document.querySelectorAll('.term-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const openItem = document.createElement('div');
  openItem.className = 'term-context-item';
  openItem.textContent = `Open ${fileName.split('/').pop() || fileName}`;
  openItem.addEventListener('click', () => { menu.remove(); openFn(); });

  const editorItem = document.createElement('div');
  editorItem.className = 'term-context-item';
  editorItem.textContent = 'Change editor...';
  editorItem.addEventListener('click', async () => {
    menu.remove();
    await (window as any).posse.filewatcherSelectEditor();
  });

  menu.appendChild(openItem);
  menu.appendChild(editorItem);
  document.body.appendChild(menu);

  // Close when clicking elsewhere
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

interface TermInstance {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  themeId: string;
  pendingInputScroll: boolean;
}

export class TerminalManager {
  private instances: Map<string, TermInstance> = new Map();
  private activeId: string | null = null;
  private terminalArea: HTMLElement;
  private resizeObserver: ResizeObserver;
  private onResize: ((id: string, cols: number, rows: number) => void) | null = null;
  private lastFitSize: { w: number; h: number } = { w: 0, h: 0 };
  private fitCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(terminalArea: HTMLElement, onResize?: (id: string, cols: number, rows: number) => void) {
    this.terminalArea = terminalArea;
    this.onResize = onResize || null;
    this.resizeObserver = new ResizeObserver(() => {
      this.fitActive();
    });
    this.resizeObserver.observe(terminalArea);

    // When the window regains focus, re-fit and sync the pty size
    // Fixes desktop terminal size getting out of sync after mobile remote control
    window.addEventListener('focus', () => {
      this.fitActive();
    });

    // Periodically check for container size changes (fallback: ResizeObserver may miss some layout changes)
    this.fitCheckTimer = setInterval(() => {
      this.fitIfSizeChanged();
    }, 3000);
  }

  create(id: string, themeId: string, cwd: string, onData: (data: string) => void): void {
    const theme = THEMES[themeId] || THEMES['vscode-dark'];
    const terminal = new Terminal({
      theme,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';

    const container = document.createElement('div');
    container.className = 'terminal-container';
    container.id = `tc-${id}`;
    this.terminalArea.appendChild(container);

    terminal.open(container);
    terminal.onData((data) => onData(data));

    // Shift+Enter inserts a literal newline (LF) instead of submitting. Plain Enter keeps the
    // default behavior (xterm sends CR `\r`, which submits). Returning false suppresses xterm's
    // own handling of this key event so it does NOT also send the default `\r`.
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        onData('\n');
        return false;
      }
      return true;
    });

    // Register file-path link detection
    const linkProvider = new FilePathLinkProvider(
      terminal,
      () => cwd,
      (filePath) => {
        (window as any).posse.filewatcherOpen(filePath).then((result: { ok?: boolean; error?: string } | undefined) => {
          if (result && result.ok === false) {
            console.error('Failed to open editor:', result.error);
          }
        }).catch((error: unknown) => {
          console.error('Failed to open editor:', error);
        });
      },
    );
    terminal.registerLinkProvider(linkProvider);

    // Context menu: right-click on a file link to change the editor
    container.addEventListener('contextmenu', (e: MouseEvent) => {
      // Get the row under the cursor
      const cellHeight = terminal.element?.querySelector('.xterm-rows')?.children[0]?.getBoundingClientRect().height || 17;
      const viewportEl = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      const rowsEl = terminal.element?.querySelector('.xterm-rows') as HTMLElement | null;
      if (!rowsEl || !viewportEl) return;
      const rect = rowsEl.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const row = Math.floor(relY / cellHeight);
      const bufferY = row + terminal.buffer.active.viewportY + 1;

      // Use linkProvider to check whether this row has any links
      linkProvider.provideLinks(bufferY, (links) => {
        if (!links || links.length === 0) return;
        e.preventDefault();
        showTermContextMenu(e.clientX, e.clientY, links[0].text, () => {
          (links[0] as any).activate(undefined, links[0].text);
        });
      });
    });

    // Intercept paste events to detect clipboard images or files
    container.addEventListener('paste', async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      );
      // Handle images first
      if (hasImage) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const filePath = await (window as any).posse.clipboardSaveImage();
          if (filePath) {
            onData(filePath);
          }
        } catch { /* fail silently */ }
        return;
      }
      // Try to handle files (get the file path from the clipboard)
      try {
        const filePath = await (window as any).posse.clipboardGetFilePath();
        if (filePath) {
          e.preventDefault();
          e.stopPropagation();
          // Shell-escape the path
          const escapedPath = filePath.includes("'") ? `"${filePath.replace(/"/g, '\\"')}"` : `'${filePath}'`;
          onData(escapedPath + ' ');
        }
      } catch { /* fail silently */ }
    }, true);

    // Floating "scroll to bottom" button
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-bottom-btn';
    scrollBtn.textContent = '⬇';
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.style.display = 'none';
    container.appendChild(scrollBtn);

    scrollBtn.addEventListener('click', () => {
      terminal.scrollToBottom();
      scrollBtn.style.display = 'none';
    });

    // Watch scrolling: show the button when not at the bottom
    const checkScroll = () => {
      const buf = terminal.buffer.active;
      const atBottom = buf.viewportY >= buf.baseY;
      scrollBtn.style.display = atBottom ? 'none' : 'block';
    };
    terminal.onScroll(() => checkScroll());
    terminal.onWriteParsed(() => checkScroll());

    // Sometimes wheel-scrolling down stops near, but not at, the bottom; snap to the latest output when scrolling down
    const viewport = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    viewport?.addEventListener('wheel', (e: WheelEvent) => {
      if (e.deltaY <= 0) return;
      const snapIfNearBottom = () => {
        const buf = terminal.buffer.active;
        const distanceToBottom = buf.baseY - buf.viewportY;
        if (distanceToBottom <= 18) {
          terminal.scrollToBottom();
          scrollBtn.style.display = 'none';
        }
      };
      snapIfNearBottom();
      requestAnimationFrame(() => requestAnimationFrame(snapIfNearBottom));
    }, { passive: true });

    this.instances.set(id, { id, terminal, fitAddon, container, themeId, pendingInputScroll: false });
    this.switchTo(id);

    // After creating the terminal, default to the bottom so interactive CLIs don't leave you at the top of history after init output.
    setTimeout(() => {
      terminal.scrollToBottom();
    }, 100);
  }

  switchTo(id: string): void {
    // Hide all
    this.instances.forEach((inst) => {
      inst.container.classList.remove('active');
    });
    // Show the target
    const target = this.instances.get(id);
    if (!target) return;
    target.container.classList.add('active');
    this.activeId = id;
    // Delay fit to ensure the DOM has updated
    setTimeout(() => {
      // Within 50ms the user may have closed this terminal → the instance is no longer in the map or DOM
      // Calling fit directly would throw an "ITerminalDimensions" error, and cols/rows would be 0
      const stillActive = this.instances.get(id);
      if (!stillActive || stillActive !== target) return;
      try {
        target.fitAddon.fit();
        if (this.onResize) {
          const { cols, rows } = target.terminal;
          if (cols > 0 && rows > 0) this.onResize(target.id, cols, rows);
        }
        target.terminal.focus();
        target.terminal.scrollToBottom();
      } catch {}
    }, 50);
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    // Record whether we were at the bottom before writing (use a tolerance to avoid float/line-height misjudgment)
    const buf = inst.terminal.buffer.active;
    const wasAtBottom = buf.viewportY >= buf.baseY - 2;
    inst.terminal.write(data, () => {
      // After writing, double-check: at the bottom before writing, or pendingInputScroll → scroll to bottom
      // The second condition is a fallback: if fit() changed the viewport between two writes,
      // wasAtBottom still records the user's last real position
      const currentBuf = inst.terminal.buffer.active;
      const stillAtBottom = currentBuf.viewportY >= currentBuf.baseY - 2;
      if (wasAtBottom || inst.pendingInputScroll) {
        inst.terminal.scrollToBottom();
        inst.pendingInputScroll = false;
      } else if (stillAtBottom && currentBuf.baseY > 0) {
        // If the user wasn't at the bottom before but is right after writing (content auto-scrolled to the bottom),
        // and the buffer already has content, stay at the bottom (normal follow-the-output behavior)
        inst.terminal.scrollToBottom();
      }
    });
  }

  notifyInput(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.pendingInputScroll = true;
    inst.terminal.scrollToBottom();
  }

  destroy(id: string): string | null {
    const inst = this.instances.get(id);
    if (!inst) return this.activeId;
    inst.terminal.dispose();
    inst.container.remove();
    this.instances.delete(id);

    // Switch to another terminal
    if (this.activeId === id) {
      const remaining = Array.from(this.instances.keys());
      if (remaining.length > 0) {
        this.switchTo(remaining[remaining.length - 1]);
        return this.activeId;
      }
      this.activeId = null;
    }
    return this.activeId;
  }

  fitActive(): void {
    if (!this.activeId) return;
    const inst = this.instances.get(this.activeId);
    if (inst) {
      // fit() calls terminal.resize(), which can change the row/column count and shift the viewport unexpectedly.
      // Record whether we were at the bottom before fit, then restore after, to avoid jumping to the top of the buffer.
      const buf = inst.terminal.buffer.active;
      const wasAtBottom = buf.baseY > 0 && buf.viewportY >= buf.baseY - 2;
      inst.fitAddon.fit();
      if (wasAtBottom) {
        inst.terminal.scrollToBottom();
      }
      // Record the current container size for the periodic check
      const rect = inst.container.getBoundingClientRect();
      this.lastFitSize = { w: rect.width, h: rect.height };
      if (this.onResize) {
        const { cols, rows } = inst.terminal;
        this.onResize(inst.id, cols, rows);
      }
    }
  }

  // Periodic fallback: check whether the container size changed, and re-fit if so
  private fitIfSizeChanged(): void {
    if (!this.activeId) return;
    const inst = this.instances.get(this.activeId);
    if (!inst) return;
    const rect = inst.container.getBoundingClientRect();
    if (Math.abs(rect.width - this.lastFitSize.w) > 1 || Math.abs(rect.height - this.lastFitSize.h) > 1) {
      this.fitActive();
    }
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getActiveDimensions(): { cols: number; rows: number } | null {
    if (!this.activeId) return null;
    const inst = this.instances.get(this.activeId);
    if (!inst) return null;
    return { cols: inst.terminal.cols, rows: inst.terminal.rows };
  }

  hasInstances(): boolean {
    return this.instances.size > 0;
  }

  static getThemeDotColor(themeId: string): string {
    return THEME_DOTS[themeId] || '#0078d4';
  }
}
