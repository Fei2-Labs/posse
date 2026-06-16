import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

type DaemonConfig = {
  token: string;
  port: number;
  homeDir: string;
};

type PtySession = {
  id: string;
  rawBuffer: string;
  title: string;
  cwd: string;
  presetCommand: string;
  themeId: string;
  provider: string | null;
  createdAt: number;
};

type DaemonEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'titleUpdate'; id: string; title: string }
  | { type: 'exit'; id: string };

type TerminalInstance = {
  session: PtySession;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
};

const statusEl = getRequiredElement('daemon-status');
const sessionListEl = getRequiredElement('session-list');
const terminalStageEl = getRequiredElement('terminal-stage');
const emptyStateEl = getRequiredElement('empty-state');
const activeTitleEl = getRequiredElement('active-title');
const activeMetaEl = getRequiredElement('active-meta');
const cwdInputEl = getRequiredInput('cwd-input');
const presetSelectEl = getRequiredSelect('preset-select');
const refreshBtn = getRequiredButton('refresh-btn');
const restartDaemonBtn = getRequiredButton('restart-daemon-btn');
const renameBtn = getRequiredButton('rename-btn');
const closeBtn = getRequiredButton('close-btn');
const newSessionForm = getRequiredForm('new-session-form');
const renameOverlayEl = getRequiredElement('rename-overlay');
const renameDialogEl = getRequiredForm('rename-dialog');
const renameInputEl = getRequiredInput('rename-input');
const renameCancelBtn = getRequiredButton('rename-cancel-btn');

let daemonConfig: DaemonConfig | null = null;
let eventSocket: WebSocket | null = null;
let activeSessionId: string | null = null;
let pendingRenameResolve: ((title: string | null) => void) | null = null;
let restarting = false;
const terminals = new Map<string, TerminalInstance>();

function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element;
}

function getRequiredInput(id: string): HTMLInputElement {
  const element = getRequiredElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input: ${id}`);
  return element;
}

function getRequiredSelect(id: string): HTMLSelectElement {
  const element = getRequiredElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Expected select: ${id}`);
  return element;
}

function getRequiredButton(id: string): HTMLButtonElement {
  const element = getRequiredElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`);
  return element;
}

function getRequiredForm(id: string): HTMLFormElement {
  const element = getRequiredElement(id);
  if (!(element instanceof HTMLFormElement)) throw new Error(`Expected form: ${id}`);
  return element;
}

function apiUrl(path: string): string {
  return path;
}

function authHeaders(): HeadersInit {
  if (!daemonConfig) throw new Error('Daemon config not loaded');
  return { Authorization: `Bearer ${daemonConfig.token}` };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${init.method || 'GET'} ${path} failed: ${response.status} ${text}`);
  }
  return await response.json() as T;
}

function setStatus(text: string, className: 'online' | 'error' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('online', className === 'online');
  statusEl.classList.toggle('error', className === 'error');
}

function displayName(session: PtySession): string {
  if (session.provider) return session.provider;
  if (!session.presetCommand) return 'Shell';
  if (session.presetCommand.startsWith('claude')) return 'Claude';
  if (session.presetCommand.startsWith('codex')) return 'Codex';
  if (session.presetCommand.startsWith('copilot')) return 'Copilot';
  if (session.presetCommand.startsWith('devin')) return 'Devin';
  return session.presetCommand.split(/\s+/)[0] || 'Shell';
}

function createTerminal(session: PtySession): TerminalInstance {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    scrollback: 10000,
    theme: {
      background: '#111316',
      foreground: '#e6e8eb',
      cursor: '#47d18c',
      selectionBackground: '#334155',
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.dataset.sessionId = session.id;
  terminalStageEl.appendChild(container);
  terminal.open(container);
  terminal.onData((data) => {
    void writeSession(session.id, data);
  });

  if (session.rawBuffer) {
    terminal.write(session.rawBuffer);
  }

  const instance = { session, terminal, fitAddon, container };
  terminals.set(session.id, instance);
  return instance;
}

async function writeSession(id: string, data: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/write`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  }).catch((error: unknown) => {
    console.error('[TerminalClient] write failed', error);
  });
}

async function resizeSession(id: string, instance: TerminalInstance): Promise<void> {
  try {
    instance.fitAddon.fit();
    const cols = instance.terminal.cols;
    const rows = instance.terminal.rows;
    if (cols > 0 && rows > 0) {
      await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/resize`, {
        method: 'POST',
        body: JSON.stringify({ cols, rows }),
      });
    }
  } catch (error) {
    console.warn('[TerminalClient] resize failed', error);
  }
}

function switchSession(id: string): void {
  const instance = terminals.get(id);
  if (!instance) return;
  activeSessionId = id;
  for (const current of terminals.values()) {
    current.container.classList.toggle('active', current.session.id === id);
  }
  emptyStateEl.style.display = 'none';
  activeTitleEl.textContent = instance.session.title || 'Terminal';
  activeMetaEl.textContent = `${displayName(instance.session)} · ${instance.session.cwd}`;
  renameBtn.disabled = false;
  closeBtn.disabled = false;
  renderSessionList();
  setTimeout(() => {
    void resizeSession(id, instance);
    instance.terminal.focus();
  }, 30);
}

function removeSession(id: string): void {
  const instance = terminals.get(id);
  if (instance) {
    instance.terminal.dispose();
    instance.container.remove();
    terminals.delete(id);
  }
  if (activeSessionId === id) {
    const next = terminals.keys().next();
    if (next.done === false) {
      switchSession(next.value);
    } else {
      activeSessionId = null;
      emptyStateEl.style.display = 'flex';
      activeTitleEl.textContent = 'No session';
      activeMetaEl.textContent = 'Create or select a terminal';
      renameBtn.disabled = true;
      closeBtn.disabled = true;
    }
  }
  renderSessionList();
}

function renderSessionList(): void {
  sessionListEl.replaceChildren();
  const sorted = Array.from(terminals.values()).sort((a, b) => b.session.createdAt - a.session.createdAt);
  for (const instance of sorted) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${instance.session.id === activeSessionId ? ' active' : ''}`;
    button.addEventListener('click', () => switchSession(instance.session.id));

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    button.appendChild(dot);

    const body = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = instance.session.title || 'Terminal';
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${displayName(instance.session)} · ${instance.session.cwd}`;
    body.appendChild(title);
    body.appendChild(meta);
    button.appendChild(body);
    sessionListEl.appendChild(button);
  }
}

async function loadConfig(): Promise<void> {
  const response = await fetch('/terminal/config');
  if (!response.ok) throw new Error(`config failed: ${response.status}`);
  daemonConfig = await response.json() as DaemonConfig;
  cwdInputEl.value = daemonConfig.homeDir;
  setStatus(`Daemon ${daemonConfig.port}`, 'online');
}

async function loadSessions(): Promise<void> {
  const sessions = await requestJson<PtySession[]>('/api/sessions');
  const seen = new Set<string>();
  for (const session of sessions) {
    seen.add(session.id);
    const existing = terminals.get(session.id);
    if (existing) {
      existing.session = session;
    } else {
      createTerminal(session);
    }
  }
  for (const id of Array.from(terminals.keys())) {
    if (!seen.has(id)) removeSession(id);
  }
  renderSessionList();
  if (!activeSessionId && sessions.length > 0) {
    switchSession(sessions[0].id);
  }
}

function connectEvents(): void {
  if (!daemonConfig) return;
  if (eventSocket && eventSocket.readyState !== WebSocket.CLOSED) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/events?token=${encodeURIComponent(daemonConfig.token)}`;
  eventSocket = new WebSocket(url);
  eventSocket.addEventListener('open', () => setStatus(`Daemon ${daemonConfig?.port || ''}`, 'online'));
  eventSocket.addEventListener('close', () => {
    eventSocket = null;
    // During an explicit restart, restartDaemon() owns status + recovery.
    if (restarting) return;
    setStatus('Reconnecting', '');
    setTimeout(connectEvents, 1000);
  });
  eventSocket.addEventListener('message', (message) => {
    let event: DaemonEvent;
    try {
      event = JSON.parse(String(message.data)) as DaemonEvent;
    } catch {
      return;
    }
    if (event.type === 'data') {
      terminals.get(event.id)?.terminal.write(event.data);
      return;
    }
    if (event.type === 'titleUpdate') {
      const instance = terminals.get(event.id);
      if (!instance) return;
      instance.session = { ...instance.session, title: event.title };
      if (activeSessionId === event.id) activeTitleEl.textContent = event.title;
      renderSessionList();
      return;
    }
    if (event.type === 'exit') {
      removeSession(event.id);
    }
  });
}

async function createSession(): Promise<void> {
  const cwd = cwdInputEl.value.trim() || daemonConfig?.homeDir || '';
  const presetCommand = presetSelectEl.value;
  const session = await requestJson<PtySession>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd, presetCommand, themeId: 'default' }),
  });
  createTerminal(session);
  switchSession(session.id);
}

async function closeActiveSession(): Promise<void> {
  if (!activeSessionId) return;
  const id = activeSessionId;
  await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  removeSession(id);
}

async function renameActiveSession(): Promise<void> {
  if (!activeSessionId) return;
  const instance = terminals.get(activeSessionId);
  if (!instance) return;
  const title = await requestRenameTitle(instance.session.title);
  if (!title) return;
  await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(activeSessionId)}/title`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
}

function requestRenameTitle(currentTitle: string): Promise<string | null> {
  renameInputEl.value = currentTitle;
  renameOverlayEl.hidden = false;
  renameInputEl.focus();
  renameInputEl.select();

  return new Promise((resolve) => {
    pendingRenameResolve = resolve;
  });
}

function closeRenameDialog(title: string | null): void {
  renameOverlayEl.hidden = true;
  const resolve = pendingRenameResolve;
  pendingRenameResolve = null;
  if (resolve) resolve(title);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonUp(): Promise<boolean> {
  try {
    const response = await fetch('/terminal/config', { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

async function restartDaemon(): Promise<void> {
  if (restarting || !daemonConfig) return;
  // Lightweight inline confirm — live terminals drop but are saved as resumable.
  const confirmed = window.confirm(
    'Restart the daemon? Live terminals will drop, but sessions are saved as resumable and reappear once the daemon is back.',
  );
  if (!confirmed) return;

  restarting = true;
  restartDaemonBtn.disabled = true;
  refreshBtn.disabled = true;
  setStatus('Restarting…', '');

  try {
    await fetch('/shutdown', { method: 'POST', headers: authHeaders() });
  } catch {
    // The daemon may drop the connection while exiting — that's expected.
  }

  // Close the current event socket so reconnect logic re-establishes against
  // the fresh daemon once it binds the port.
  if (eventSocket) {
    try {
      eventSocket.close();
    } catch {
      // ignore
    }
    eventSocket = null;
  }

  // Poll /terminal/config until the respawned daemon (started by the main
  // Posse app's reconnect logic) is up, with a ~15s timeout.
  const deadlineMs = Date.now() + 15000;
  // Give the old process a moment to exit and free the port first.
  await sleep(600);
  while (Date.now() < deadlineMs) {
    if (await isDaemonUp()) {
      try {
        await loadConfig();
        await loadSessions();
        connectEvents();
        setStatus(`Daemon ${daemonConfig?.port || ''}`, 'online');
      } catch (error) {
        console.error('[TerminalClient] post-restart reload failed', error);
        setStatus('Reload failed', 'error');
      }
      restarting = false;
      restartDaemonBtn.disabled = false;
      refreshBtn.disabled = false;
      return;
    }
    await sleep(700);
  }

  // Timed out — the main app likely isn't running to respawn the daemon.
  setStatus('Daemon down — open the Posse app', 'error');
  restarting = false;
  restartDaemonBtn.disabled = false;
  refreshBtn.disabled = false;
}

newSessionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void createSession().catch((error: unknown) => {
    console.error('[TerminalClient] create failed', error);
    setStatus('Create failed', 'error');
  });
});

refreshBtn.addEventListener('click', () => {
  void loadSessions().catch((error: unknown) => {
    console.error('[TerminalClient] refresh failed', error);
    setStatus('Refresh failed', 'error');
  });
});

restartDaemonBtn.addEventListener('click', () => {
  void restartDaemon().catch((error: unknown) => {
    console.error('[TerminalClient] restart failed', error);
    setStatus('Restart failed', 'error');
    restarting = false;
    restartDaemonBtn.disabled = false;
    refreshBtn.disabled = false;
  });
});

closeBtn.addEventListener('click', () => {
  void closeActiveSession().catch((error: unknown) => {
    console.error('[TerminalClient] close failed', error);
    setStatus('Close failed', 'error');
  });
});

renameBtn.addEventListener('click', () => {
  void renameActiveSession().catch((error: unknown) => {
    console.error('[TerminalClient] rename failed', error);
    setStatus('Rename failed', 'error');
  });
});

renameDialogEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = renameInputEl.value.trim();
  closeRenameDialog(title || null);
});

renameCancelBtn.addEventListener('click', () => closeRenameDialog(null));
renameOverlayEl.addEventListener('click', (event) => {
  if (event.target === renameOverlayEl) closeRenameDialog(null);
});

window.addEventListener('resize', () => {
  if (!activeSessionId) return;
  const instance = terminals.get(activeSessionId);
  if (instance) void resizeSession(activeSessionId, instance);
});

async function main(): Promise<void> {
  try {
    await loadConfig();
    await loadSessions();
    connectEvents();
  } catch (error) {
    console.error('[TerminalClient] startup failed', error);
    setStatus('Connection failed', 'error');
  }
}

void main();
