export type TerminalTheme = Record<string, string>;

export interface PosseTheme {
  id: string;
  name: string;
  accent: string;
  cssVars: Record<string, string>;
  terminal: TerminalTheme;
}

export const POSSE_THEMES: PosseTheme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    accent: '#3fb950',
    cssVars: {
      '--bg-primary': '#0d1117', '--bg-panel': '#11171a', '--bg-sidebar': '#11171a', '--bg-toolbar': '#0f1418',
      '--bg-secondary': '#161d20', '--bg-active': '#16221b', '--text-primary': '#c9d1d1', '--text-secondary': '#6e7a73',
      '--text-muted': '#6e7a73', '--accent-green': '#3fb950', '--accent-green-dim': '#2ea043', '--accent': '#3fb950',
      '--accent-color': '#3fb950', '--border-color': '#1f2a24', '--border-subtle': '#182019', '--hover-bg': '#161d20',
      '--active-bg': '#16221b', '--row-selected': '#16221b', '--danger': '#f85149', '--input-bg': '#161d20', '--text-color': '#c9d1d1',
    },
    terminal: {
      background: '#0d1117', foreground: '#c9d1d1', cursor: '#3fb950', cursorAccent: '#0d1117', selectionBackground: '#264f78',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    accent: '#bd93f9',
    cssVars: {
      '--bg-primary': '#1e1f29', '--bg-panel': '#21222c', '--bg-sidebar': '#21222c', '--bg-toolbar': '#191a21',
      '--bg-secondary': '#2a2c38', '--bg-active': '#343746', '--text-primary': '#f8f8f2', '--text-secondary': '#9aa0b5',
      '--text-muted': '#9aa0b5', '--accent-green': '#bd93f9', '--accent-green-dim': '#a87ef0', '--accent': '#bd93f9',
      '--accent-color': '#bd93f9', '--border-color': '#343746', '--border-subtle': '#2a2c38', '--hover-bg': '#2a2c38',
      '--active-bg': '#343746', '--row-selected': '#343746', '--danger': '#ff5555', '--input-bg': '#2a2c38', '--text-color': '#f8f8f2',
    },
    terminal: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    accent: '#88c0d0',
    cssVars: {
      '--bg-primary': '#2e3440', '--bg-panel': '#2b303b', '--bg-sidebar': '#2b303b', '--bg-toolbar': '#272c36',
      '--bg-secondary': '#3b4252', '--bg-active': '#434c5e', '--text-primary': '#eceff4', '--text-secondary': '#a3adbf',
      '--text-muted': '#a3adbf', '--accent-green': '#88c0d0', '--accent-green-dim': '#6fa8b8', '--accent': '#88c0d0',
      '--accent-color': '#88c0d0', '--border-color': '#3b4252', '--border-subtle': '#353b47', '--hover-bg': '#3b4252',
      '--active-bg': '#434c5e', '--row-selected': '#434c5e', '--danger': '#bf616a', '--input-bg': '#3b4252', '--text-color': '#eceff4',
    },
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    accent: '#2aa198',
    cssVars: {
      '--bg-primary': '#002b36', '--bg-panel': '#073642', '--bg-sidebar': '#073642', '--bg-toolbar': '#00242e',
      '--bg-secondary': '#0a4250', '--bg-active': '#0d4d5c', '--text-primary': '#eee8d5', '--text-secondary': '#93a1a1',
      '--text-muted': '#93a1a1', '--accent-green': '#2aa198', '--accent-green-dim': '#1f8c84', '--accent': '#2aa198',
      '--accent-color': '#2aa198', '--border-color': '#0f5562', '--border-subtle': '#0a4250', '--hover-bg': '#0a4250',
      '--active-bg': '#0d4d5c', '--row-selected': '#0d4d5c', '--danger': '#dc322f', '--input-bg': '#0a4250', '--text-color': '#eee8d5',
    },
    terminal: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    accent: '#a6e22e',
    cssVars: {
      '--bg-primary': '#1e1f1c', '--bg-panel': '#272822', '--bg-sidebar': '#272822', '--bg-toolbar': '#1a1b16',
      '--bg-secondary': '#34352e', '--bg-active': '#3e3f37', '--text-primary': '#f8f8f2', '--text-secondary': '#a6a28c',
      '--text-muted': '#a6a28c', '--accent-green': '#a6e22e', '--accent-green-dim': '#8fbf28', '--accent': '#a6e22e',
      '--accent-color': '#a6e22e', '--border-color': '#49483e', '--border-subtle': '#34352e', '--hover-bg': '#34352e',
      '--active-bg': '#3e3f37', '--row-selected': '#3e3f37', '--danger': '#f92672', '--input-bg': '#34352e', '--text-color': '#f8f8f2',
    },
    terminal: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822', selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    accent: '#1a7f37',
    cssVars: {
      '--bg-primary': '#ffffff', '--bg-panel': '#f5f6f8', '--bg-sidebar': '#f5f6f8', '--bg-toolbar': '#eceef1',
      '--bg-secondary': '#eceef1', '--bg-active': '#ddf4e3', '--text-primary': '#1f2328', '--text-secondary': '#6e7781',
      '--text-muted': '#6e7781', '--accent-green': '#1a7f37', '--accent-green-dim': '#116329', '--accent': '#1a7f37',
      '--accent-color': '#1a7f37', '--border-color': '#d0d7de', '--border-subtle': '#e1e4e8', '--hover-bg': '#eceef1',
      '--active-bg': '#ddf4e3', '--row-selected': '#ddf4e3', '--danger': '#cf222e', '--input-bg': '#ffffff', '--text-color': '#1f2328',
    },
    terminal: {
      background: '#ffffff', foreground: '#1f2328', cursor: '#1a7f37', cursorAccent: '#ffffff', selectionBackground: '#b6e3ff',
      black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
  },
];

export const LEGACY_TERMINAL_THEMES: Record<string, TerminalTheme> = {
  'vscode-dark': {
    background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#1e1e1e', selectionBackground: '#264f78',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
  },
  'one-dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
};

const THEME_BY_ID = new Map(POSSE_THEMES.map((theme) => [theme.id, theme]));

export function getPosseTheme(id: string | undefined | null): PosseTheme {
  return THEME_BY_ID.get(id || '') || POSSE_THEMES[0];
}

export function getTerminalTheme(id: string | undefined | null): TerminalTheme {
  const posseTheme = THEME_BY_ID.get(id || '');
  if (posseTheme) return posseTheme.terminal;
  return LEGACY_TERMINAL_THEMES[id || ''] || POSSE_THEMES[0].terminal;
}

export function getThemeAccent(id: string | undefined | null): string {
  const posseTheme = THEME_BY_ID.get(id || '');
  if (posseTheme) return posseTheme.accent;
  if (id === 'vscode-dark') return '#0078d4';
  if (id === 'one-dark') return '#61afef';
  return POSSE_THEMES[0].accent;
}

export function applyThemeCssVars(style: CSSStyleDeclaration, theme: PosseTheme): void {
  for (const [key, value] of Object.entries(theme.cssVars)) {
    style.setProperty(key, value);
  }
}
