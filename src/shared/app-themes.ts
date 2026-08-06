/**
 * app-themes.ts — single source of truth for Posse's built-in app themes.
 * Shared between the desktop renderer (src/renderer/app.ts) and the standalone
 * terminal client (src/terminal-client/app.ts) so the two surfaces cannot drift
 * (unify-theme-editor task). Add/remove themes HERE only.
 */

export type AppTheme = { id: string; name: string; vars: Record<string, string>; term: Record<string, string> };
export const APP_THEMES: AppTheme[] = [
  { id: 'midnight', name: 'Midnight', vars: {
    '--bg-primary': '#0d1117', '--bg-panel': '#11171a', '--bg-sidebar': '#11171a', '--bg-toolbar': '#0f1418', '--bg-tertiary': '#0d1117',
    '--bg-secondary': '#161d20', '--bg-active': '#16221b', '--text-primary': '#c9d1d1', '--text-secondary': '#6e7a73',
    '--text-muted': '#6e7a73', '--accent-green': '#3fb950', '--accent-green-dim': '#2ea043', '--accent': '#3fb950',
    '--accent-color': '#3fb950', '--accent-hover': '#2ea043', '--accent-soft': '#3fb95022', '--border-color': '#1f2a24', '--border-default': '#1f2a24', '--border-subtle': '#182019', '--hover-bg': '#161d20',
    '--active-bg': '#16221b', '--row-selected': '#16221b', '--danger': '#f85149', '--status-success': '#3fb950', '--status-warning': '#d29922', '--status-error': '#f85149', '--input-bg': '#161d20', '--text-color': '#c9d1d1' },
    term: { background:'#0d1117', foreground:'#c9d1d1', cursor:'#3fb950', cursorAccent:'#0d1117', selectionBackground:'#264f78',
      black:'#484f58', red:'#ff7b72', green:'#3fb950', yellow:'#d29922', blue:'#58a6ff', magenta:'#bc8cff', cyan:'#39c5cf', white:'#b1bac4',
      brightBlack:'#6e7681', brightRed:'#ffa198', brightGreen:'#56d364', brightYellow:'#e3b341', brightBlue:'#79c0ff', brightMagenta:'#d2a8ff', brightCyan:'#56d4dd', brightWhite:'#f0f6fc' } },
  { id: 'dracula', name: 'Dracula', vars: {
    '--bg-primary': '#1e1f29', '--bg-panel': '#21222c', '--bg-sidebar': '#21222c', '--bg-toolbar': '#191a21', '--bg-tertiary': '#191a21',
    '--bg-secondary': '#2a2c38', '--bg-active': '#343746', '--text-primary': '#f8f8f2', '--text-secondary': '#9aa0b5',
    '--text-muted': '#9aa0b5', '--accent-green': '#bd93f9', '--accent-green-dim': '#a87ef0', '--accent': '#bd93f9',
    '--accent-color': '#bd93f9', '--accent-hover': '#a87ef0', '--accent-soft': '#bd93f922', '--border-color': '#343746', '--border-default': '#343746', '--border-subtle': '#2a2c38', '--hover-bg': '#2a2c38',
    '--active-bg': '#343746', '--row-selected': '#343746', '--danger': '#ff5555', '--status-success': '#50fa7b', '--status-warning': '#f1fa8c', '--status-error': '#ff5555', '--input-bg': '#2a2c38', '--text-color': '#f8f8f2' },
    term: { background:'#282a36', foreground:'#f8f8f2', cursor:'#f8f8f2', cursorAccent:'#282a36', selectionBackground:'#44475a',
      black:'#21222c', red:'#ff5555', green:'#50fa7b', yellow:'#f1fa8c', blue:'#bd93f9', magenta:'#ff79c6', cyan:'#8be9fd', white:'#f8f8f2',
      brightBlack:'#6272a4', brightRed:'#ff6e6e', brightGreen:'#69ff94', brightYellow:'#ffffa5', brightBlue:'#d6acff', brightMagenta:'#ff92df', brightCyan:'#a4ffff', brightWhite:'#ffffff' } },
  { id: 'nord', name: 'Nord', vars: {
    '--bg-primary': '#2e3440', '--bg-panel': '#2b303b', '--bg-sidebar': '#2b303b', '--bg-toolbar': '#272c36', '--bg-tertiary': '#272c36',
    '--bg-secondary': '#3b4252', '--bg-active': '#434c5e', '--text-primary': '#eceff4', '--text-secondary': '#a3adbf',
    '--text-muted': '#a3adbf', '--accent-green': '#88c0d0', '--accent-green-dim': '#6fa8b8', '--accent': '#88c0d0',
    '--accent-color': '#88c0d0', '--accent-hover': '#6fa8b8', '--accent-soft': '#88c0d022', '--border-color': '#3b4252', '--border-default': '#3b4252', '--border-subtle': '#353b47', '--hover-bg': '#3b4252',
    '--active-bg': '#434c5e', '--row-selected': '#434c5e', '--danger': '#bf616a', '--status-success': '#a3be8c', '--status-warning': '#ebcb8b', '--status-error': '#bf616a', '--input-bg': '#3b4252', '--text-color': '#eceff4' },
    term: { background:'#2e3440', foreground:'#d8dee9', cursor:'#88c0d0', cursorAccent:'#2e3440', selectionBackground:'#434c5e',
      black:'#3b4252', red:'#bf616a', green:'#a3be8c', yellow:'#ebcb8b', blue:'#81a1c1', magenta:'#b48ead', cyan:'#88c0d0', white:'#e5e9f0',
      brightBlack:'#4c566a', brightRed:'#bf616a', brightGreen:'#a3be8c', brightYellow:'#ebcb8b', brightBlue:'#81a1c1', brightMagenta:'#b48ead', brightCyan:'#8fbcbb', brightWhite:'#eceff4' } },
  { id: 'solarized', name: 'Solarized', vars: {
    '--bg-primary': '#002b36', '--bg-panel': '#073642', '--bg-sidebar': '#073642', '--bg-toolbar': '#00242e', '--bg-tertiary': '#00242e',
    '--bg-secondary': '#0a4250', '--bg-active': '#0d4d5c', '--text-primary': '#eee8d5', '--text-secondary': '#93a1a1',
    '--text-muted': '#93a1a1', '--accent-green': '#2aa198', '--accent-green-dim': '#1f8c84', '--accent': '#2aa198',
    '--accent-color': '#2aa198', '--accent-hover': '#1f8c84', '--accent-soft': '#2aa19822', '--border-color': '#0f5562', '--border-default': '#0f5562', '--border-subtle': '#0a4250', '--hover-bg': '#0a4250',
    '--active-bg': '#0d4d5c', '--row-selected': '#0d4d5c', '--danger': '#dc322f', '--status-success': '#859900', '--status-warning': '#b58900', '--status-error': '#dc322f', '--input-bg': '#0a4250', '--text-color': '#eee8d5' },
    term: { background:'#002b36', foreground:'#839496', cursor:'#93a1a1', cursorAccent:'#002b36', selectionBackground:'#073642',
      black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5',
      brightBlack:'#586e75', brightRed:'#cb4b16', brightGreen:'#586e75', brightYellow:'#657b83', brightBlue:'#839496', brightMagenta:'#6c71c4', brightCyan:'#93a1a1', brightWhite:'#fdf6e3' } },
  { id: 'monokai', name: 'Monokai', vars: {
    '--bg-primary': '#1e1f1c', '--bg-panel': '#272822', '--bg-sidebar': '#272822', '--bg-toolbar': '#1a1b16', '--bg-tertiary': '#1a1b16',
    '--bg-secondary': '#34352e', '--bg-active': '#3e3f37', '--text-primary': '#f8f8f2', '--text-secondary': '#a6a28c',
    '--text-muted': '#a6a28c', '--accent-green': '#a6e22e', '--accent-green-dim': '#8fbf28', '--accent': '#a6e22e',
    '--accent-color': '#a6e22e', '--accent-hover': '#8fbf28', '--accent-soft': '#a6e22e22', '--border-color': '#49483e', '--border-default': '#49483e', '--border-subtle': '#34352e', '--hover-bg': '#34352e',
    '--active-bg': '#3e3f37', '--row-selected': '#3e3f37', '--danger': '#f92672', '--status-success': '#a6e22e', '--status-warning': '#f4bf75', '--status-error': '#f92672', '--input-bg': '#34352e', '--text-color': '#f8f8f2' },
    term: { background:'#272822', foreground:'#f8f8f2', cursor:'#f8f8f2', cursorAccent:'#272822', selectionBackground:'#49483e',
      black:'#272822', red:'#f92672', green:'#a6e22e', yellow:'#f4bf75', blue:'#66d9ef', magenta:'#ae81ff', cyan:'#a1efe4', white:'#f8f8f2',
      brightBlack:'#75715e', brightRed:'#f92672', brightGreen:'#a6e22e', brightYellow:'#f4bf75', brightBlue:'#66d9ef', brightMagenta:'#ae81ff', brightCyan:'#a1efe4', brightWhite:'#f9f8f5' } },
  { id: 'daylight', name: 'Daylight', vars: {
    '--bg-primary': '#ffffff', '--bg-panel': '#f5f6f8', '--bg-sidebar': '#f5f6f8', '--bg-toolbar': '#eceef1', '--bg-tertiary': '#f6f8fa',
    '--bg-secondary': '#eceef1', '--bg-active': '#ddf4e3', '--text-primary': '#1f2328', '--text-secondary': '#6e7781',
    '--text-muted': '#6e7781', '--accent-green': '#1a7f37', '--accent-green-dim': '#116329', '--accent': '#1a7f37',
    '--accent-color': '#1a7f37', '--accent-hover': '#116329', '--accent-soft': '#1a7f3722', '--border-color': '#d0d7de', '--border-default': '#d0d7de', '--border-subtle': '#e1e4e8', '--hover-bg': '#eceef1',
    '--active-bg': '#ddf4e3', '--row-selected': '#ddf4e3', '--danger': '#cf222e', '--status-success': '#1a7f37', '--status-warning': '#9a6700', '--status-error': '#cf222e', '--input-bg': '#ffffff', '--text-color': '#1f2328' },
    term: { background:'#ffffff', foreground:'#1f2328', cursor:'#1a7f37', cursorAccent:'#ffffff', selectionBackground:'#b6e3ff',
      black:'#24292f', red:'#cf222e', green:'#1a7f37', yellow:'#9a6700', blue:'#0969da', magenta:'#8250df', cyan:'#1b7c83', white:'#6e7781',
      brightBlack:'#57606a', brightRed:'#a40e26', brightGreen:'#1a7f37', brightYellow:'#633c01', brightBlue:'#218bff', brightMagenta:'#a475f9', brightCyan:'#3192aa', brightWhite:'#8c959f' } },
];

/** Chrome shape used by the standalone terminal client (maps from desktop vars). */
export type TerminalClientTheme = {
  id: string;
  name: string;
  chrome: { bg: string; panel: string; panel2: string; panel3: string; border: string; text: string; muted: string; accent: string; accent2: string; danger: string };
  term: { background: string; foreground: string; cursor: string; selectionBackground: string };
};

/** Map a canonical AppTheme to the terminal client's chrome+term shape. */
export function toTerminalClientTheme(t: AppTheme): TerminalClientTheme {
  const v = t.vars;
  return {
    id: t.id,
    name: t.name,
    chrome: {
      bg: v['--bg-primary'],
      panel: v['--bg-panel'],
      panel2: v['--bg-secondary'],
      panel3: v['--bg-tertiary'],
      border: v['--border-color'],
      text: v['--text-primary'],
      muted: v['--text-muted'],
      accent: v['--accent'],
      accent2: v['--accent-hover'],
      danger: v['--danger'],
    },
    term: {
      background: t.term.background,
      foreground: t.term.foreground,
      cursor: t.term.cursor,
      selectionBackground: t.term.selectionBackground,
    },
  };
}
