import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, globalShortcut, Tray, Menu } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getDisplayName, rotateDevinInstallationId, writeClaudeSessionTitle } from './pty-manager';
import { PtyBackend } from './pty-backend';
import { PtyDaemonClient } from './pty-daemon-client';
import { loadOrCreatePtyDaemonConfig } from './pty-daemon-config';
import { AIConfigManager } from './ai-config';
import { startRemoteServer, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd, type RemoteConnectionStatus } from './remote-server';
import { CloudflaredManager } from './cloudflared-manager';
import { ChatSessionManager } from './chat-session-manager';
import { WindsurfProxyManager } from './windsurf-proxy-manager';

type OpenEditorResult = { ok: true } | { ok: false; error: string };

// macOS: set regular app mode so it appears in the Dock and Command+Tab switcher
if (process.platform === 'darwin') {
  app.setActivationPolicy('regular');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  dialog.showErrorBox('Posse is already running', 'Posse is already running; please switch to the existing window.');
  app.exit(0);
}

app.on('second-instance', () => {
  const windows = BrowserWindow.getAllWindows();
  const mainWindow = windows[0];
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow(currentAppIcon);
});

// File watcher
let fileWatcher: fs.FSWatcher | null = null;
let watchingCwd: string | null = null;

import * as os from 'os';

const PASTE_IMAGE_DIR = path.join(os.tmpdir(), 'posse-paste');

// Session notification state
const sessionLastInputAt: Map<string, number> = new Map();
const sessionArmedForNotify: Set<string> = new Set();
const sessionLastNotifyAt: Map<string, number> = new Map();
const sessionUserClosed: Set<string> = new Set();

const NOTIFY_COOLDOWN_MS = 15_000;
const WAITING_INPUT_DELAY_MS = 8_000;
const IMESSAGE_TARGET = (process.env.POSSE_IMESSAGE_TO || '').trim();
const IMESSAGE_SERVICE = ((process.env.POSSE_IMESSAGE_SERVICE || 'iMessage').trim().toLowerCase() === 'sms')
  ? 'SMS'
  : 'iMessage';

const sessionOutputTail: Map<string, string> = new Map();

// ========== Closed session persistence ==========
interface ClosedSession {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
}
const CLOSED_SESSIONS_FILE = path.join(app.getPath('userData'), 'closed-sessions.json');
const MAX_CLOSED_SESSIONS = 20;

function loadClosedSessions(): ClosedSession[] {
  try {
    const raw = fs.readFileSync(CLOSED_SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveClosedSessions(sessions: ClosedSession[]): ClosedSession[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter(s => s.closedAt > cutoff).slice(-MAX_CLOSED_SESSIONS);
  fs.writeFileSync(CLOSED_SESSIONS_FILE, JSON.stringify(filtered, null, 2));
  return filtered;
}

function addClosedSession(session: { title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string }): void {
  const list = loadClosedSessions();
  list.push({
    id: `closed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: session.title,
    cwd: session.cwd,
    presetCommand: session.presetCommand,
    resumeId: session.resumeId,
    resumeCommand: session.resumeCommand,
    displayName: getDisplayName(session.presetCommand),
    closedAt: Date.now(),
  });
  const saved = saveClosedSessions(list);
  safeSend('closed-sessions:update', saved);
}

// ========== Closed chat session persistence ==========
interface ClosedChatSession {
  id: string;
  title: string;
  model: string;
  workspace: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }>;
  closedAt: number;
}
const CLOSED_CHAT_SESSIONS_FILE = path.join(app.getPath('userData'), 'closed-chat-sessions.json');
const MAX_CLOSED_CHAT_SESSIONS = 20;

function loadClosedChatSessions(): ClosedChatSession[] {
  try {
    const raw = fs.readFileSync(CLOSED_CHAT_SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveClosedChatSessions(sessions: ClosedChatSession[]): ClosedChatSession[] {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter(s => s.closedAt > cutoff).slice(-MAX_CLOSED_CHAT_SESSIONS);
  fs.writeFileSync(CLOSED_CHAT_SESSIONS_FILE, JSON.stringify(filtered, null, 2));
  return filtered;
}

function addClosedChatSession(session: { title: string; model: string; workspace: string; messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }> }): void {
  const list = loadClosedChatSessions();
  list.push({
    id: `closed-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: session.title,
    model: session.model,
    workspace: session.workspace,
    messages: session.messages,
    closedAt: Date.now(),
  });
  const saved = saveClosedChatSessions(list);
  safeSend('closed-chat-sessions:update', saved);
}

function getPreferencePath(): string {
  return path.join(app.getPath('userData'), 'ai-preference.json');
}

interface AiPreferenceData {
  providerId: string | null;
  model: string | null;
  manualConfig?: { apiFormat: string; baseUrl: string; apiKey: string; model: string };
}

function saveAiPreference(providerId: string, model?: string): void {
  try {
    const existing = loadAiPreferenceData();
    const data = { providerId, model: model || existing.model || '' };
    fs.writeFileSync(getPreferencePath(), JSON.stringify(data));
    aiPreferenceCache = null;
  } catch { /* ignore */ }
}

function loadAiPreference(): string | null {
  return loadAiPreferenceData().providerId;
}

let aiPreferenceCache: AiPreferenceData | null = null;
function loadAiPreferenceData(): AiPreferenceData {
  if (aiPreferenceCache) return aiPreferenceCache;
  try {
    const data = JSON.parse(fs.readFileSync(getPreferencePath(), 'utf-8'));
    aiPreferenceCache = {
      providerId: data.providerId || null,
      model: data.model || null,
      manualConfig: data.manualConfig || undefined,
    };
  } catch {
    aiPreferenceCache = { providerId: null, model: null };
  }
  return aiPreferenceCache;
}

function invalidateAiPreferenceCache(): void {
  aiPreferenceCache = null;
}

// Editor preference persistence
function getEditorPrefPath(): string {
  return path.join(app.getPath('userData'), 'editor-preference.json');
}

function saveEditorPreference(editorPath: string): void {
  try { fs.writeFileSync(getEditorPrefPath(), JSON.stringify({ editorPath })); } catch { /* ignore */ }
}

function loadEditorPreference(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(getEditorPrefPath(), 'utf-8'));
    return data.editorPath || null;
  } catch { return null; }
}

function expandUserPath(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function spawnEditorCommand(command: string, args: string[]): Promise<OpenEditorResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    let settled = false;
    const settle = (result: OpenEditorResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on('error', (error) => {
      settle({ ok: false, error: error.message });
    });
    child.on('spawn', () => {
      child.unref();
      setTimeout(() => {
        settle({ ok: true });
      }, 500);
    });
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        settle({ ok: true });
      } else {
        settle({ ok: false, error: `${command} exited with code ${code}` });
      }
    });
  });
}

async function openFileInEditor(filePath: string): Promise<OpenEditorResult> {
  const targetPath = expandUserPath(filePath);
  const editor = loadEditorPreference();
  if (editor) {
    if (process.platform === 'win32') {
      return spawnEditorCommand(editor, [targetPath]);
    }
    if (process.platform === 'darwin') {
      return spawnEditorCommand('open', ['-a', editor, targetPath]);
    }
    return spawnEditorCommand(editor, [targetPath]);
  }

  if (process.platform === 'darwin') {
    return spawnEditorCommand('open', ['-t', targetPath]);
  }

  const error = await shell.openPath(targetPath);
  return error ? { ok: false, error } : { ok: true };
}

// ========== CLI model provider detection ==========

// Resolve the model provider actually used from the preset command
function getCliProvider(presetCommand: string): string | null {
  const home = os.homedir();

  // Determine which CLI it is
  if (presetCommand.startsWith('claude')) {
    // Read the Claude config
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';

        // Determine the model provider from baseUrl
        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
        if (baseUrl.includes('cloudflare')) return 'Cloudflare';
        if (baseUrl.includes('anthropic') || !baseUrl) return 'Anthropic';

        // If there is a custom baseUrl, try to extract the domain
        if (baseUrl) {
          try {
            const url = new URL(baseUrl);
            return url.hostname.replace(/^api\./, '').split('.')[0].toUpperCase();
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // Try reading from shell environment variables
    try {
      const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
      for (const rcFile of rcFiles) {
        if (!fs.existsSync(rcFile)) continue;
        const content = fs.readFileSync(rcFile, 'utf-8');
        const vars = parseShellExports(content);
        const baseUrl = vars.get('ANTHROPIC_BASE_URL') || '';
        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
      }
    } catch { /* ignore */ }

    return 'Anthropic';
  }

  if (presetCommand.startsWith('codex')) {
    // Codex uses an OpenAI-compatible API
    return 'OpenAI';
  }

  if (presetCommand.startsWith('copilot')) {
    return 'GitHub Copilot';
  }

  if (presetCommand.startsWith('kimi')) {
    // Kimi uses the Moonshot API
    return 'Moonshot';
  }

  if (presetCommand.startsWith('gemini')) {
    return 'Google';
  }

  if (presetCommand.startsWith('opencode')) {
    // OpenCode may use various backends
    const cfgPath = path.join(home, '.config', 'opencode', 'opencode.json');
    try {
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const provider = cfg.provider || {};
        if (provider.anthropic) return 'Anthropic';
        if (provider.openai) return 'OpenAI';
        if (provider.google) return 'Google';
      }
    } catch { /* ignore */ }
    return 'OpenCode';
  }

  if (presetCommand.startsWith('devin')) {
    return 'Devin';
  }

  if (presetCommand.startsWith('kiro-cli')) {
    return 'Kiro';
  }

  if (presetCommand.startsWith('agent') || presetCommand.includes('cursor')) {
    // Cursor agent
    return 'Cursor';
  }

  // Default to null
  return null;
}

// Parse shell export statements
function parseShellExports(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+?)["']?\s*$/);
    if (match) {
      vars.set(match[1], match[2]);
    }
  }
  return vars;
}

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyBackend;
const aiConfigManager = new AIConfigManager();
let cloudflaredManager: CloudflaredManager | null = null;
let chatSessionManager: ChatSessionManager | null = null;
let windsurfProxyManager: WindsurfProxyManager | null = null;
let cachedRemoteServerInfo: RemoteServerInfoWithTunnel | null = null;
let tray: Tray | null = null;
let currentAppIcon: Electron.NativeImage | undefined;

type RemoteServerInfoWithTunnel = RemoteConnectionStatus & {
  publicUrl?: string;
  tunnel?: unknown;
};

type TrayState = {
  isOnline: boolean;
  lanUrl: string | null;
  publicUrl: string | null;
  port: number | null;
  connectedClients: number;
  subscribedSessions: number;
};

const trayState: TrayState = {
  isOnline: false,
  lanUrl: null,
  publicUrl: null,
  port: null,
  connectedClients: 0,
  subscribedSessions: 0,
};

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(currentAppIcon);
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function copyRemoteUrl(): void {
  const url = trayState.publicUrl || trayState.lanUrl;
  if (url) clipboard.writeText(url);
}

function getTerminalClientUrl(): string {
  const config = loadOrCreatePtyDaemonConfig();
  return `http://127.0.0.1:${config.port}/terminal/`;
}

function createTrayIcon(): Electron.NativeImage {
  const icon = currentAppIcon || nativeImage.createEmpty();
  if (icon.isEmpty()) return icon;
  const resizedIcon = icon.resize({ width: 16, height: 16 });
  resizedIcon.setTemplateImage(process.platform === 'darwin');
  return resizedIcon;
}

function updateTray(): void {
  if (!tray) return;
  const statusText = trayState.isOnline ? 'Online' : 'Starting';
  const clientText = `${trayState.connectedClients} remote client${trayState.connectedClients === 1 ? '' : 's'}`;
  const title = trayState.isOnline
    ? `Posse ${trayState.connectedClients > 0 ? trayState.connectedClients : '●'}`
    : 'Posse …';
  tray.setTitle(title);
  tray.setToolTip(`Posse Remote: ${statusText}${trayState.lanUrl ? `\n${trayState.lanUrl}` : ''}\n${clientText}`);

  const url = trayState.publicUrl || trayState.lanUrl;
  const menu = Menu.buildFromTemplate([
    { label: `Remote: ${statusText}`, enabled: false },
    { label: `Clients: ${trayState.connectedClients}`, enabled: false },
    { label: `Subscribed sessions: ${trayState.subscribedSessions}`, enabled: false },
    { label: trayState.lanUrl ? `LAN: ${trayState.lanUrl}` : 'LAN: starting…', enabled: false },
    ...(trayState.publicUrl ? [{ label: `Public: ${trayState.publicUrl}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Posse', click: showMainWindow },
    { label: 'Open Terminal Client', click: () => { shell.openExternal(getTerminalClientUrl()); } },
    { label: 'Copy Remote URL', enabled: Boolean(url), click: copyRemoteUrl },
    { label: 'Open Remote URL', enabled: Boolean(url), click: () => { if (url) shell.openExternal(url); } },
    { type: 'separator' },
    { label: 'Quit Posse', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.on('click', showMainWindow);
  updateTray();
}

function updateRemoteTrayStatus(status: RemoteConnectionStatus): void {
  trayState.isOnline = true;
  trayState.lanUrl = status.lanUrl;
  trayState.port = status.port;
  trayState.connectedClients = status.connectedClients;
  trayState.subscribedSessions = status.subscribedSessions;
  updateTray();
}

function loadAppIcon(): Electron.NativeImage | undefined {
  // macOS uses .icns when packaged, .png in dev mode
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.icns'),
  ];
  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon;
    } catch { /* next */ }
  }
  return undefined;
}

function createWindow(appIcon?: Electron.NativeImage): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Posse',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      mainWindow?.webContents.send('app:close-current-session');
    }
    // Block Cmd+R / Ctrl+R refresh ONLY inside Posse's own window. Using a
    // window-scoped before-input-event (not globalShortcut.register, which would
    // register an OS-level hotkey and swallow Cmd+R for every other app too).
    if ((input.meta || input.control) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function safeSend(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch {
      // render frame disposed during GPU crash/restart
    }
  }
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

function sendIMessageNotification(message: string): void {
  if (process.platform !== 'darwin' || !IMESSAGE_TARGET) return;
  const scriptLines = [
    'tell application "Messages"',
    `set targetService to 1st service whose service type = ${IMESSAGE_SERVICE}`,
    `set targetBuddy to buddy ${appleScriptQuote(IMESSAGE_TARGET)} of targetService`,
    `send ${appleScriptQuote(message)} to targetBuddy`,
    'end tell',
  ];
  const args = scriptLines.flatMap((line) => ['-e', line]);
  const p = spawn('osascript', args, { stdio: 'ignore', detached: true });
  p.on('error', () => { /* ignore */ });
  p.unref();
}

function sendUserNotification(id: string, title: string, body: string): void {
  sendRemotePush(title, body, id);
  sendIMessageNotification(`[Posse] ${title}：${body}`);
}

function maybeNotifyAttention(id: string, data: string): void {
  const now = Date.now();
  const lastNotify = sessionLastNotifyAt.get(id) || 0;
  if (now - lastNotify < NOTIFY_COOLDOWN_MS) return;

  const plain = stripAnsi(data);
  if (!plain) return;

  const tail = ((sessionOutputTail.get(id) || '') + plain).slice(-1200);
  sessionOutputTail.set(id, tail);

  const promptLike = /(?:^|\n)\s*(?:[$#>❯›▷➜]|(?:\[[^\]]+\]))\s*$/.test(tail);
  const cliWorking = /\w+…\s*\(/.test(tail);
  const hasPrompt = promptLike && !cliWorking;
  const needDecision = /(是否|请选择|请确认|需要你|输入\s*(?:y|n|yes|no)|\[(?:y\/n|yes\/no)\]|continue\?|press enter|按回车|确认继续)/i.test(tail);
  const taskDone = /(任务已完成|已完成|完成了|done\b|completed\b|finished\b|all set\b|success(?:fully)?\b)/i.test(tail);
  const lastInputAt = sessionLastInputAt.get(id) || 0;
  const waitedLongEnough = now - lastInputAt >= WAITING_INPUT_DELAY_MS;

  const session = ptyManager.getSession(id);
  const title = session?.title || session?.presetCommand || 'Terminal';

  if (hasPrompt && needDecision) {
    sendUserNotification(id, 'Your decision needed', title);
    sessionLastNotifyAt.set(id, now);
    sessionArmedForNotify.delete(id);
    return;
  }

  if (!sessionArmedForNotify.has(id) || !hasPrompt || !waitedLongEnough) return;

  if (taskDone) {
    sendUserNotification(id, 'Task completed', title);
  } else {
    sendUserNotification(id, 'Session waiting for input', title);
  }
  sessionLastNotifyAt.set(id, now);
  sessionArmedForNotify.delete(id);
}

async function setupPtyManager(): Promise<void> {
  ptyManager = await PtyDaemonClient.connect({
    onData: (id, data) => {
      safeSend('pty:data', id, data);
      maybeNotifyAttention(id, data);
    },
    onRawData: (id, data) => {
      pushRawDataToRemote(id, data);
    },
    onTitleUpdate: (id, title) => {
      safeSend('pty:title-update', id, title);
    },
    onExit: (id, exitedSession) => {
      // Save sessions that have a resume ID to the closed list
      const session = exitedSession || ptyManager.getSession(id);
      if (session?.resumeId) {
        addClosedSession({
          title: session.title,
          cwd: session.cwd,
          presetCommand: session.presetCommand,
          resumeId: session.resumeId,
          resumeCommand: session.resumeCommand || '',
        });
      }

      // Do not notify for sessions the user closed deliberately
      if (!sessionUserClosed.has(id)) {
        const title = session?.title || 'Terminal';
        sendUserNotification(id, 'Session ended', title);
      }
      sessionUserClosed.delete(id);
      sessionOutputTail.delete(id);
      sessionLastInputAt.delete(id);
      sessionArmedForNotify.delete(id);
      sessionLastNotifyAt.delete(id);

      safeSend('pty:exit', id);
    },
    onPasteInput: (id, cwd) => {
      sessionLastInputAt.set(id, Date.now());
      sessionArmedForNotify.add(id);
    },
    onAutoSwitchStatus: (id, status, detail) => {
      safeSend('pty:auto-switch-status', id, status, detail);
    },
  });
}

type AgentHistorySession = {
  id: string;
  title: string;
  cwd: string;
  mtimeMs: number;
  agent: 'claude' | 'codex';
  resumeCommand: string;
};

// Read the first line of a file (up to ~16KB) for cheap parsing of the Codex session_meta
function readFirstLine(filePath: string, maxBytes = 16 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytes).toString('utf-8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// List a directory's session history in Codex
// Codex stores by date: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// cwd is in session_meta.payload.cwd on each file's first line; the title is in ~/.codex/session_index.jsonl
function listCodexSessions(targetCwd: string): AgentHistorySession[] {
  const MAX_MATCHES = 40;
  const MAX_FILES = 800;
  const results: AgentHistorySession[] = [];

  try {
    const normTarget = path.resolve(String(targetCwd || ''));
    if (!normTarget) return [];

    // 1. Read the title index (id -> thread_name); the last line wins
    const titleMap = new Map<string, string>();
    try {
      const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as { id?: string; thread_name?: string };
            if (obj.id && typeof obj.thread_name === 'string') {
              titleMap.set(obj.id, obj.thread_name);
            }
          } catch { /* skip bad line */ }
        }
      }
    } catch { /* missing index -> empty map */ }

    // 2. Walk the date directories in descending order
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsRoot)) return [];

    const listDirDesc = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir)
          .filter((n) => /^\d+$/.test(n))
          .sort((a, b) => Number(b) - Number(a));
      } catch { return []; }
    };

    let scanned = 0;
    outer:
    for (const year of listDirDesc(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      for (const month of listDirDesc(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of listDirDesc(monthDir)) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const file of files) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            if (scanned >= MAX_FILES || results.length >= MAX_MATCHES) break outer;
            scanned++;
            const full = path.join(dayDir, file);
            try {
              const st = fs.statSync(full);
              if (!st.isFile()) continue;
              const firstLine = readFirstLine(full).trim();
              if (!firstLine) continue;
              const obj = JSON.parse(firstLine) as {
                type?: string;
                payload?: { id?: string; cwd?: string };
              };
              if (obj.type !== 'session_meta' || !obj.payload) continue;
              const fileCwd = path.resolve(String(obj.payload.cwd || ''));
              if (fileCwd !== normTarget) continue;
              const id = String(obj.payload.id || '');
              if (!id) continue;
              results.push({
                id,
                title: titleMap.get(id) || id,
                cwd: normTarget,
                mtimeMs: st.mtimeMs,
                agent: 'codex',
                resumeCommand: `codex resume ${id}`,
              });
            } catch { /* skip unreadable / unparseable file */ }
          }
        }
      }
    }
  } catch { /* never throw */ }

  return results;
}

// ============================================================
// Projects-first discovery (Stage 1 backend for projects:list)
// Scan every AI-CLI session store, bucket by absolute project cwd.
// Every scanner is wrapped so one bad agent never breaks the list.
// ============================================================

type ProjectsAgentId = 'claude' | 'codex' | 'kiro' | 'copilot';

type ProjectSession = {
  id: string;
  title: string;
  mtimeMs: number;
  resumeCommand: string;
};

// Internal flat record before bucketing
type DiscoveredSession = ProjectSession & {
  agent: ProjectsAgentId;
  cwd: string; // absolute project folder (may be '' / '/' when unknown)
};

type ProjectEntry = {
  path: string;
  name: string;
  agents: Array<{ agent: ProjectsAgentId; sessions: ProjectSession[] }>;
  lastActiveMs: number;
};

const PROJECTS_MAX_SESSIONS_PER_AGENT = 50;
const PROJECTS_HEAD_BYTES = 64 * 1024;

// Strip command/xml tags + collapse whitespace; truncate for a session title.
function cleanSessionTitle(raw: string): string {
  return raw
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// When a user RENAMES a Claude Code session, Claude records it as a user message like:
//   The user named this session "New UI". This may indicate the ...
// Extract the quoted name (tolerate "named"/"renamed", straight or curly quotes). Match against
// the RAW message text (quotes matter, so do not run on the tag-stripped/cleaned form).
const RENAME_TITLE_RE = /the user (?:re)?named this session\s*["“”'']([^"“”'']+)["“”'']/i;
function extractRenameTitle(userText: string): string | null {
  const m = RENAME_TITLE_RE.exec(userText);
  if (!m) return null;
  const name = m[1].trim();
  return name ? name.slice(0, 60) : null;
}

// Decide whether a cleaned user-message string is a real prompt usable as a session title.
// Skips Claude Code's injected system preambles (the "Caveat:" local-command notice), empty
// strings, leftover XML/tag wrappers, and session-continuation meta lines.
function isRealUserPrompt(cleaned: string): boolean {
  if (!cleaned) return false;
  if (cleaned.startsWith('<')) return false; // unstripped tag wrapper / tool-result echo
  if (cleaned.startsWith('Caveat:')) return false; // local-command caveat preamble
  if (cleaned.startsWith('This session is being continued')) return false;
  if (cleaned.startsWith('<command-message>')) return false;
  if (cleaned.startsWith('<local-command-stdout>')) return false;
  return true;
}

// Read up to maxBytes from the head of a file (cheap parse for large jsonl).
function readHead(filePath: string, maxBytes = PROJECTS_HEAD_BYTES): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytes).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Read up to tailBytes from the END of a file. Claude appends the `ai-title` line late, so for
// large jsonl files it can sit beyond the head window; scanning the tail recovers it cheaply.
function readTail(filePath: string, size: number, tailBytes = 32 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = Math.max(0, size - tailBytes);
    const len = Math.min(tailBytes, size);
    const buf = Buffer.alloc(len);
    const bytes = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, bytes).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Above this size, scan only the tail for title-type lines instead of the whole file.
const CLAUDE_TITLE_FULL_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const CLAUDE_TITLE_TAIL_BYTES = 512 * 1024;

interface ClaudeTitleFields {
  customTitle: string; // explicit user rename (authoritative)
  agentName: string; // usually mirrors customTitle
  aiTitle: string; // Claude's auto title
}

// Scan a chunk of jsonl lines for the LAST occurrence of each title-type line. Uses a cheap
// substring `.includes` filter BEFORE JSON.parse so we don't parse every line of a large file.
function scanClaudeTitleFields(chunk: string, acc: ClaudeTitleFields): void {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hasCustom = trimmed.includes('"type":"custom-title"');
    const hasAgent = trimmed.includes('"type":"agent-name"');
    const hasAi = trimmed.includes('"type":"ai-title"');
    if (!hasCustom && !hasAgent && !hasAi) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        customTitle?: string;
        agentName?: string;
        aiTitle?: string;
      };
      // Last occurrence of each type wins (most recent).
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        acc.customTitle = obj.customTitle;
      } else if (obj.type === 'agent-name' && typeof obj.agentName === 'string') {
        acc.agentName = obj.agentName;
      } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        acc.aiTitle = obj.aiTitle;
      }
    } catch { /* skip partial/broken line (tail reads may start mid-line) */ }
  }
}

// Find the title-type lines (customTitle / agentName / aiTitle) for a Claude session file.
// They can appear anywhere in the file (often late), so we scan beyond the head:
//   - file <= 8MB  -> read the WHOLE file and scan (cheap substring filter before parse).
//   - file >  8MB  -> read only the LAST ~512KB (titles are typically late) and scan that.
// Returns the LAST occurrence of each type. Never throws.
function findClaudeTitleFields(filePath: string, size: number): ClaudeTitleFields {
  const acc: ClaudeTitleFields = { customTitle: '', agentName: '', aiTitle: '' };
  try {
    if (size > CLAUDE_TITLE_FULL_SCAN_MAX_BYTES) {
      scanClaudeTitleFields(readTail(filePath, size, CLAUDE_TITLE_TAIL_BYTES), acc);
    } else {
      scanClaudeTitleFields(fs.readFileSync(filePath, 'utf-8'), acc);
    }
  } catch { /* never throw; leave acc empty -> caller falls back */ }
  return acc;
}

// Resolve the best Claude session title from scanned fields + head-derived fallbacks.
// Priority: customTitle > agentName > aiTitle > first real user prompt > uuid.
function resolveClaudeTitle(
  fields: ClaudeTitleFields,
  firstUserTitle: string,
  renameTitle: string,
  uuid: string
): string {
  if (fields.customTitle.trim()) return fields.customTitle.trim().slice(0, 60);
  if (fields.agentName.trim()) return fields.agentName.trim().slice(0, 60);
  if (fields.aiTitle.trim()) return fields.aiTitle.trim().slice(0, 60);
  // Low-priority legacy fallback: the "The user named this session" marker (pre customTitle).
  if (renameTitle) return renameTitle;
  if (firstUserTitle) return firstUserTitle;
  return uuid;
}

// Cache resolved Claude session titles keyed by absolute file path. A cached entry is valid
// only while the file's mtimeMs AND size are unchanged — when Claude appends (rename, new
// ai-title, more messages) the mtime/size change, the lookup misses, and we re-scan for a fresh
// title. No manual invalidation needed. Capped to avoid unbounded growth.
const claudeTitleCache = new Map<string, { mtimeMs: number; size: number; title: string }>();
const CLAUDE_TITLE_CACHE_MAX_ENTRIES = 2000;

// Lookup-or-(scan-and-store). Reuses the mtimeMs/size the caller already statted (no double
// stat). On a hit (same path + mtimeMs + size) returns the cached title without reading the
// file; on a miss runs `compute()` (the head + full/tail scan) and caches the result.
function getCachedClaudeTitle(
  filePath: string,
  mtimeMs: number,
  size: number,
  compute: () => string
): string {
  const cached = claudeTitleCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.title;
  }
  const title = compute();
  if (claudeTitleCache.size > CLAUDE_TITLE_CACHE_MAX_ENTRIES) claudeTitleCache.clear();
  claudeTitleCache.set(filePath, { mtimeMs, size, title });
  return title;
}

// --- Claude: ~/.claude/projects/<enc>/<uuid>.jsonl ; real cwd from in-file `cwd` ---
function discoverClaudeSessions(): DiscoveredSession[] {
  const MAX_FILES = 300;
  const out: DiscoveredSession[] = [];
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return [];

    // Gather all jsonl files across all project dirs, newest first.
    const files: Array<{ full: string; uuid: string; mtimeMs: number; size: number }> = [];
    let projectDirs: string[];
    try { projectDirs = fs.readdirSync(root); } catch { return []; }
    for (const sub of projectDirs) {
      const dir = path.join(root, sub);
      let names: string[];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        names = fs.readdirSync(dir);
      } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          files.push({ full, uuid: name.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const f of files.slice(0, MAX_FILES)) {
      try {
        // Head read: recover real cwd + first-real-user-message fallback (titles handled below).
        const head = readHead(f.full);
        const lines = head.split('\n');
        let cwd = '';
        let firstUserTitle = '';
        let renameTitle = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: { type?: string; cwd?: string; message?: { content?: unknown } };
          try { obj = JSON.parse(trimmed); } catch { continue; }
          if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
          // Legacy rename marker (low-priority fallback). Match the RAW text; last rename wins.
          if (obj.type === 'user' && typeof obj.message?.content === 'string') {
            const r = extractRenameTitle(obj.message.content);
            if (r) renameTitle = r;
          }
          // First REAL user prompt: skip the injected "Caveat:" system preamble, empty/tag-only
          // messages, and continuation meta. Take the first one that survives the filter.
          if (!firstUserTitle && obj.type === 'user' && typeof obj.message?.content === 'string') {
            const cleaned = cleanSessionTitle(obj.message.content);
            if (isRealUserPrompt(cleaned)) firstUserTitle = cleaned;
          }
        }
        // Title-type lines (customTitle/agentName/aiTitle) can appear far into the file, beyond
        // the head window. Scan the whole file (or tail for huge files) to recover them.
        const title = getCachedClaudeTitle(f.full, f.mtimeMs, f.size, () => {
          const titleFields = findClaudeTitleFields(f.full, f.size);
          return resolveClaudeTitle(titleFields, firstUserTitle, renameTitle, f.uuid);
        });
        out.push({
          agent: 'claude',
          cwd: cwd ? path.resolve(cwd) : '',
          id: f.uuid,
          title,
          mtimeMs: f.mtimeMs,
          resumeCommand: `claude --resume ${f.uuid}`,
        });
      } catch { /* skip unreadable file */ }
    }
  } catch { /* never throw */ }
  return out;
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl ; cwd from line 1 ---
function discoverCodexSessions(): DiscoveredSession[] {
  const MAX_FILES = 300;
  const out: DiscoveredSession[] = [];
  try {
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsRoot)) return [];

    // Title index: id -> thread_name (last line wins)
    const titleMap = new Map<string, string>();
    try {
      const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as { id?: string; thread_name?: string };
            if (obj.id && typeof obj.thread_name === 'string') titleMap.set(obj.id, obj.thread_name);
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }

    const listDirDesc = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir)
          .filter((n) => /^\d+$/.test(n))
          .sort((a, b) => Number(b) - Number(a));
      } catch { return []; }
    };

    // Collect newest files first by walking date dirs descending. Only scan the
    // active sessions tree (NOT the ~76k archived_sessions tree).
    const files: Array<{ full: string; mtimeMs: number }> = [];
    let walked = 0;
    const WALK_CAP = 1500; // bound the readdir/stat work
    outer:
    for (const year of listDirDesc(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      for (const month of listDirDesc(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of listDirDesc(monthDir)) {
          const dayDir = path.join(monthDir, day);
          let names: string[];
          try { names = fs.readdirSync(dayDir); } catch { continue; }
          for (const name of names) {
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
            if (walked >= WALK_CAP) break outer;
            walked++;
            const full = path.join(dayDir, name);
            try {
              const st = fs.statSync(full);
              if (st.isFile()) files.push({ full, mtimeMs: st.mtimeMs });
            } catch { /* skip */ }
          }
          if (files.length >= MAX_FILES) break outer; // dirs are date-descending, enough collected
        }
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // The Codex session_meta first line embeds the full system prompt and can be
    // >20KB, so a bounded JSON.parse of the line fails. Extract the uuid from the
    // filename and the cwd via regex over a generous head read instead.
    const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
    for (const f of files.slice(0, MAX_FILES)) {
      try {
        const base = path.basename(f.full);
        const idMatch = base.match(uuidRe);
        if (!idMatch) continue;
        const id = idMatch[1];
        const head = readFirstLine(f.full, 64 * 1024);
        // cwd appears in payload before the giant base_instructions block.
        const cwdMatch = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const cwdRaw = cwdMatch ? cwdMatch[1].replace(/\\(.)/g, '$1') : '';
        out.push({
          agent: 'codex',
          cwd: cwdRaw ? path.resolve(cwdRaw) : '',
          id,
          title: titleMap.get(id) || id,
          mtimeMs: f.mtimeMs,
          resumeCommand: `codex resume ${id}`,
        });
      } catch { /* skip */ }
    }
  } catch { /* never throw */ }
  return out;
}

// --- Kiro: ~/.kiro/sessions/cli/<uuid>.json sidecar (cwd/title/timestamps) ---
function discoverKiroSessions(): DiscoveredSession[] {
  const MAX_FILES = 300;
  const out: DiscoveredSession[] = [];
  try {
    const dir = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
    if (!fs.existsSync(dir)) return [];

    const files: Array<{ full: string; uuid: string; mtimeMs: number }> = [];
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) files.push({ full, uuid: name.replace(/\.json$/, ''), mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const f of files.slice(0, MAX_FILES)) {
      try {
        const content = fs.readFileSync(f.full, 'utf-8');
        const obj = JSON.parse(content) as {
          session_id?: string;
          cwd?: string;
          title?: string;
          updated_at?: string;
        };
        const id = String(obj.session_id || f.uuid);
        const cwdRaw = String(obj.cwd || '');
        const title = (typeof obj.title === 'string' && obj.title.trim())
          ? obj.title.trim().slice(0, 60)
          : id;
        out.push({
          agent: 'kiro',
          cwd: cwdRaw ? path.resolve(cwdRaw) : '',
          id,
          title,
          mtimeMs: f.mtimeMs,
          resumeCommand: `kiro-cli chat --resume-id ${id}`,
        });
      } catch { /* skip */ }
    }
  } catch { /* never throw */ }
  return out;
}

// --- Copilot: ~/.copilot/session-store.db (sqlite). Best-effort, cwd unreliable. ---
function discoverCopilotSessions(): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  try {
    const dbPath = path.join(os.homedir(), '.copilot', 'session-store.db');
    if (!fs.existsSync(dbPath)) return [];

    // Try node's built-in sqlite first (Node >= 22.5 with --experimental-sqlite),
    // fall back to shelling out to the `sqlite3` binary if present.
    type Row = { id?: string; cwd?: string; summary?: string; updated_at?: string };
    let rows: Row[] = [];

    let usedNode = false;
    try {
      // node:sqlite is experimental and may be absent; guard the require.
      const sqlite = require('node:sqlite') as {
        DatabaseSync?: new (p: string, opts?: { readOnly?: boolean }) => {
          prepare: (sql: string) => { all: () => unknown[] };
          close: () => void;
        };
      };
      if (sqlite?.DatabaseSync) {
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          rows = db.prepare(
            'SELECT id, cwd, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 100'
          ).all() as Row[];
          usedNode = true;
        } finally {
          db.close();
        }
      }
    } catch { /* node:sqlite unavailable -> fall through */ }

    if (!usedNode) {
      try {
        const { execFileSync } = require('child_process') as typeof import('child_process');
        const raw = execFileSync(
          'sqlite3',
          ['-json', dbPath, 'SELECT id, cwd, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 100;'],
          { encoding: 'utf-8', timeout: 5000 }
        );
        const parsed = JSON.parse(raw || '[]') as Row[];
        if (Array.isArray(parsed)) rows = parsed;
      } catch { /* sqlite3 binary missing / query failed -> degrade to empty */ }
    }

    for (const r of rows) {
      const id = String(r.id || '');
      if (!id) continue;
      const cwdRaw = String(r.cwd || '');
      // cwd often '/' or a synthetic ~/.copilot/chats path -> treat as unknown.
      const isRealFolder = cwdRaw && cwdRaw !== '/' && !cwdRaw.startsWith(path.join(os.homedir(), '.copilot'));
      const mtimeMs = r.updated_at ? Date.parse(r.updated_at) || 0 : 0;
      const title = (typeof r.summary === 'string' && r.summary.trim())
        ? r.summary.trim().slice(0, 60)
        : id;
      out.push({
        agent: 'copilot',
        cwd: isRealFolder ? path.resolve(cwdRaw) : '',
        id,
        title,
        mtimeMs,
        resumeCommand: `copilot --resume ${id}`,
      });
    }
  } catch { /* never throw - Copilot is best-effort */ }
  return out;
}

// Bucket all discovered sessions by project cwd. Sessions with no usable folder
// are grouped under a synthetic project (e.g. Copilot without a real cwd).
function buildProjectsList(extraFolders: string[] = []): ProjectEntry[] {
  const discovered: DiscoveredSession[] = [
    ...discoverClaudeSessions(),
    ...discoverCodexSessions(),
    ...discoverKiroSessions(),
    ...discoverCopilotSessions(),
  ];

  const COPILOT_NO_FOLDER = '__copilot_no_folder__';
  // bucketKey -> { path, name, agentMap }
  const buckets = new Map<string, {
    path: string;
    name: string;
    agentMap: Map<ProjectsAgentId, ProjectSession[]>;
  }>();

  const getBucket = (key: string, displayPath: string, name: string) => {
    let b = buckets.get(key);
    if (!b) {
      b = { path: displayPath, name, agentMap: new Map() };
      buckets.set(key, b);
    }
    return b;
  };

  for (const s of discovered) {
    let key: string;
    let displayPath: string;
    let name: string;
    if (s.cwd) {
      key = s.cwd;
      displayPath = s.cwd;
      name = path.basename(s.cwd) || s.cwd;
    } else if (s.agent === 'copilot') {
      key = COPILOT_NO_FOLDER;
      displayPath = '';
      name = 'Copilot (no folder)';
    } else {
      continue; // unknown-folder non-copilot sessions are skipped
    }
    const bucket = getBucket(key, displayPath, name);
    let arr = bucket.agentMap.get(s.agent);
    if (!arr) { arr = []; bucket.agentMap.set(s.agent, arr); }
    arr.push({ id: s.id, title: s.title, mtimeMs: s.mtimeMs, resumeCommand: s.resumeCommand });
  }

  // Ensure explicitly-added folders appear even with no sessions.
  for (const folder of extraFolders) {
    try {
      const abs = path.resolve(String(folder || ''));
      if (!abs) continue;
      getBucket(abs, abs, path.basename(abs) || abs);
    } catch { /* ignore bad folder */ }
  }

  const projects: ProjectEntry[] = [];
  for (const b of buckets.values()) {
    const agents: ProjectEntry['agents'] = [];
    let lastActiveMs = 0;
    for (const [agent, sessions] of b.agentMap) {
      sessions.sort((a, b2) => b2.mtimeMs - a.mtimeMs);
      const capped = sessions.slice(0, PROJECTS_MAX_SESSIONS_PER_AGENT);
      if (capped.length > 0) lastActiveMs = Math.max(lastActiveMs, capped[0].mtimeMs);
      agents.push({ agent, sessions: capped });
    }
    projects.push({ path: b.path, name: b.name, agents, lastActiveMs });
  }

  projects.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return projects;
}

function registerIPC(): void {
  // Set window title
  ipcMain.on('window:set-title', (_e, title: string) => {
    if (mainWindow) mainWindow.setTitle(title);
  });

  // Create terminal
  ipcMain.handle('pty:create', async (_e, cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>) => {
    const session = await ptyManager.create(cwd, presetCommand, themeId, providerEnv);
    // If providerEnv is present, infer the provider name from baseUrl
    let provider: string | null = null;
    if (providerEnv && providerEnv.ANTHROPIC_BASE_URL) {
      const baseUrl = providerEnv.ANTHROPIC_BASE_URL;
      if (baseUrl.includes('minimaxi')) provider = 'MiniMax';
      else if (baseUrl.includes('deepseek')) provider = 'DeepSeek';
      else if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) provider = 'GLM';
      else if (baseUrl.includes('anthropic') && !baseUrl.includes('minimaxi')) provider = 'Anthropic';
      else {
        // Try extracting from the domain
        try {
          const url = new URL(baseUrl);
          provider = url.hostname.replace(/^(api|code)\./, '').split('.')[0];
          // Capitalize the first letter
          provider = provider.charAt(0).toUpperCase() + provider.slice(1);
        } catch { provider = 'Custom'; }
      }
    } else {
      provider = getCliProvider(presetCommand);
    }
    await ptyManager.setProvider(session.id, provider);
    return {
      id: session.id,
      title: session.title,
      themeId: session.themeId,
      cwd: session.cwd,
      displayName: getDisplayName(session.presetCommand),
      provider,
      agentSessionId: session.agentSessionId,
    };
  });

  // Write data
  ipcMain.handle('pty:write', async (_e, id: string, data: string) => {
    console.log(`[Main] pty:write received, id=${id}, data="${data}"`);
    await ptyManager.write(id, data);
    return true;
  });

  // Resize
  ipcMain.handle('pty:resize', async (_e, id: string, cols: number, rows: number) => {
    await ptyManager.resize(id, cols, rows);
    return true;
  });

  // Destroy terminal
  ipcMain.on('pty:destroy', async (_e, id: string) => {
    // Fallback: extract the resume ID from the buffer and save to the closed list
    await ptyManager.captureResumeFromBuffer(id);
    const session = ptyManager.getSession(id);
    if (session?.resumeId) {
      addClosedSession({
        title: session.title,
        cwd: session.cwd,
        presetCommand: session.presetCommand,
        resumeId: session.resumeId,
        resumeCommand: session.resumeCommand || '',
      });
    }

    sessionUserClosed.add(id);
    await ptyManager.destroy(id);
    sessionOutputTail.delete(id);
    sessionLastInputAt.delete(id);
    sessionArmedForNotify.delete(id);
    sessionLastNotifyAt.delete(id);
    sessionUserClosed.delete(id);
  });

  // Rename terminal
  ipcMain.on('pty:rename', (_e, id: string, title: string) => {
    ptyManager.rename(id, title).catch((error) => {
      console.error('[Main] Failed to rename PTY session:', error);
    });
  });

  // Regenerate title with AI
  ipcMain.handle('pty:regenerate-title', async (_e, id: string) => {
    await ptyManager.regenerateTitle(id);
  });

  // Get info for all sessions
  ipcMain.handle('pty:sessions', async () => {
    const sessions = await ptyManager.refreshSessions();
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      themeId: s.themeId,
      cwd: s.cwd,
      displayName: getDisplayName(s.presetCommand),
      provider: s.provider,
      rawBuffer: s.rawBuffer,
      agentSessionId: s.agentSessionId,
    }));
  });

  // Gracefully restart the background PTY daemon.
  // Saves every live session as resumable FIRST so nothing is lost, then
  // stops the old daemon and starts a fresh one (picks up new daemon code).
  ipcMain.handle('daemon:restart', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 1. Persist every live session as resumable before stopping the daemon.
      const liveSessions = ptyManager.getAllSessions();
      for (const live of liveSessions) {
        try {
          await ptyManager.captureResumeFromBuffer(live.id);
        } catch {
          // Best-effort: keep going even if one capture fails.
        }
        const session = ptyManager.getSession(live.id) || live;
        // Persist EVERY live session, even without a captured resumeId. Entries
        // without a resume id are re-opened as a fresh terminal in the original
        // cwd running the original command (handled in restoreClosedSession).
        addClosedSession({
          title: session.title,
          cwd: session.cwd,
          presetCommand: session.presetCommand,
          resumeId: session.resumeId || '',
          resumeCommand: session.resumeCommand || '',
        });
      }

      // 2-3. Stop the old daemon and start a fresh one, reconnecting events.
      await ptyManager.restart();

      // 5. Tell the renderer the live list is now empty so it refreshes.
      safeSend('daemon:restarted');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Main] Failed to restart PTY daemon:', message);
      return { ok: false, error: message };
    }
  });

  // ========== Closed session IPC ==========
  ipcMain.handle('closed-sessions:list', () => loadClosedSessions());
  ipcMain.handle('closed-sessions:remove', (_e, id: string) => {
    const sessions = loadClosedSessions().filter(s => s.id !== id);
    saveClosedSessions(sessions);
    return sessions;
  });
  ipcMain.handle('closed-sessions:clear', () => {
    saveClosedSessions([]);
    return [];
  });
  ipcMain.handle('closed-sessions:rename', (_e, id: string, title: string) => {
    const newTitle = String(title || '').slice(0, 200);
    const sessions = loadClosedSessions().map(s =>
      s.id === id ? { ...s, title: newTitle } : s
    );
    saveClosedSessions(sessions);
    // Propagate into Claude's own session file for closed Claude sessions.
    const target = sessions.find(s => s.id === id);
    if (target && /^claude\b/i.test((target.presetCommand || '').trim()) && target.resumeId) {
      writeClaudeSessionTitle(target.resumeId, newTitle);
    }
    return sessions;
  });

  // ========== Closed chat session IPC ==========
  ipcMain.handle('closed-chat:list', () => loadClosedChatSessions());
  ipcMain.handle('closed-chat:remove', (_e, id: string) => {
    const sessions = loadClosedChatSessions().filter(s => s.id !== id);
    const saved = saveClosedChatSessions(sessions);
    return saved;
  });
  ipcMain.handle('closed-chat:clear', () => {
    saveClosedChatSessions([]);
    return [];
  });
  ipcMain.handle('chat:restore', (_e, closedId: string) => {
    if (!chatSessionManager) return null;
    const list = loadClosedChatSessions();
    const closed = list.find(s => s.id === closedId);
    if (!closed) return null;
    const session = chatSessionManager.restore(closed.workspace, closed.model, closed.messages, closed.title);
    // Remove from the closed list
    const remaining = list.filter(s => s.id !== closedId);
    saveClosedChatSessions(remaining);
    return { id: session.id, title: session.title, model: session.model, workspace: session.workspace, createdAt: session.createdAt };
  });

  // Select working directory
  ipcMain.handle('dialog:select-folder', async (_e, currentPath?: string) => {
    const defaultPath = currentPath && fs.existsSync(currentPath) ? currentPath : os.homedir();
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Select working directory',
      buttonLabel: 'Select this folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath,
    };
    const ownerWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Read directory (left-side file tree)
  ipcMain.handle('file-tree:list-dir', (_e, dirPath: string) => {
    try {
      const abs = path.resolve(String(dirPath || ''));
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return [];

      const names = fs.readdirSync(abs);
      const items = names
        .filter((name) => name !== '.DS_Store')
        .map((name) => {
          const fullPath = path.join(abs, name);
          let isDir = false;
          try { isDir = fs.statSync(fullPath).isDirectory(); } catch { /* ignore */ }
          return { name, path: fullPath, isDir };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-CN');
        })
        .slice(0, 500);

      return items;
    } catch {
      return [];
    }
  });

  // Read file contents for the right-side preview panel (read-only, with size/binary guards)
  ipcMain.handle('fs:read-file', (_e, filePath: string) => {
    const MAX_PREVIEW_BYTES = 1024 * 1024; // 1MB cap to avoid lag
    try {
      const abs = path.resolve(String(filePath || ''));
      const st = fs.statSync(abs);
      if (!st.isFile()) return { ok: false, error: 'not-a-file' };
      if (st.size > MAX_PREVIEW_BYTES) {
        return { ok: false, error: 'too-large', size: st.size };
      }
      const buf = fs.readFileSync(abs);
      // Simple binary detection: treat NUL in the first 8000 bytes as binary
      const sniff = buf.subarray(0, 8000);
      if (sniff.includes(0)) {
        return { ok: false, error: 'binary', size: st.size };
      }
      return {
        ok: true,
        content: buf.toString('utf-8'),
        size: st.size,
        ext: path.extname(abs).slice(1).toLowerCase(),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // List a directory's native session history in Claude Code (~/.claude/projects/<encoded>/<uuid>.jsonl)
  ipcMain.handle('claude-sessions:list', (_e, cwd: string) => {
    const MAX_SESSIONS = 40;

    const parseTitle = (filePath: string, size: number, mtimeMs: number, uuid: string): string =>
      getCachedClaudeTitle(filePath, mtimeMs, size, () => {
        try {
          // Head read: first-real-user-message fallback + legacy rename marker.
          const head = readHead(filePath);
          let firstUserTitle = '';
          let renameTitle = '';
          for (const line of head.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let obj: { type?: string; message?: { content?: unknown } };
            try { obj = JSON.parse(trimmed); } catch { continue; }
            if (obj.type === 'user' && typeof obj.message?.content === 'string') {
              const r = extractRenameTitle(obj.message.content);
              if (r) renameTitle = r;
              if (!firstUserTitle) {
                const cleaned = cleanSessionTitle(obj.message.content);
                if (isRealUserPrompt(cleaned)) firstUserTitle = cleaned;
              }
            }
          }
          // Title-type lines (customTitle/agentName/aiTitle) can appear far into the file, beyond
          // the head window. Scan the whole file (or tail for huge files) to recover them.
          const titleFields = findClaudeTitleFields(filePath, size);
          return resolveClaudeTitle(titleFields, firstUserTitle, renameTitle, uuid);
        } catch { /* ignore, fall through to uuid */ }
        return uuid;
      });

    try {
      const abs = path.resolve(String(cwd || ''));
      if (!abs) return [];
      const encoded = abs.replace(/[^a-zA-Z0-9]/g, '-');
      const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
      if (!fs.existsSync(dir)) return [];

      const entries = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) return null;
            return { name, full, size: st.size, mtimeMs: st.mtimeMs };
          } catch { return null; }
        })
        .filter((e): e is { name: string; full: string; size: number; mtimeMs: number } => e !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SESSIONS);

      const claudeList = entries.map((e) => {
        const uuid = e.name.replace(/\.jsonl$/, '');
        return {
          id: uuid,
          title: parseTitle(e.full, e.size, e.mtimeMs, uuid),
          cwd: abs,
          mtimeMs: e.mtimeMs,
          agent: 'claude' as const,
          resumeCommand: `claude --resume ${uuid}`,
        };
      });

      const codexList = listCodexSessions(abs);

      return [...claudeList, ...codexList]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SESSIONS);
    } catch {
      return [];
    }
  });

  // Verify a session id is actually resumable in the given cwd. Agents store
  // sessions per-cwd (claude/kiro) — resuming in the wrong folder silently
  // starts a FRESH empty session, so the renderer pre-validates and warns.
  // Fail-open: on any error / unknown agent return { exists: true }.
  ipcMain.handle('session:verify-resumable', (_e, agent: string, cwd: string, sessionId: string): { exists: boolean } => {
    try {
      const id = String(sessionId || '').trim();
      if (!id) return { exists: true };
      const a = String(agent || '').trim().toLowerCase();

      if (a === 'claude') {
        const abs = path.resolve(String(cwd || ''));
        const encoded = abs.replace(/[^a-zA-Z0-9]/g, '-');
        const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
        const direct = path.join(dir, `${id}.jsonl`);
        if (fs.existsSync(direct)) return { exists: true };
        // Also accept if a file containing the uuid is found by scanning the dir.
        if (fs.existsSync(dir)) {
          const found = fs.readdirSync(dir).some((name) => name.includes(id) && name.endsWith('.jsonl'));
          return { exists: found };
        }
        return { exists: false };
      }

      if (a === 'codex') {
        // Codex is date-bucketed (not cwd-bucketed): verify the uuid file exists
        // anywhere under ~/.codex/sessions. cwd match is informational only.
        const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
        if (!fs.existsSync(sessionsRoot)) return { exists: false };
        const found = (function scan(dir: string, depth: number): boolean {
          if (depth > 5) return false;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
          for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              if (scan(full, depth + 1)) return true;
            } else if (ent.name.includes(id) && ent.name.endsWith('.jsonl')) {
              return true;
            }
          }
          return false;
        })(sessionsRoot, 0);
        return { exists: found };
      }

      if (a === 'kiro') {
        const file = path.join(os.homedir(), '.kiro', 'sessions', 'cli', `${id}.json`);
        return { exists: fs.existsSync(file) };
      }

      // copilot / unknown: can't reliably verify — don't block.
      return { exists: true };
    } catch {
      return { exists: true };
    }
  });

  // Projects-first discovery: bucket every AI-CLI session by project folder
  ipcMain.handle('projects:list', (_e, opts?: { extraFolders?: string[] }) => {
    try {
      return buildProjectsList(opts?.extraFolders ?? []);
    } catch {
      return [];
    }
  });

  ipcMain.handle('remote:add-recent-cwd', (_e, cwd: string) => {
    try { addRemoteRecentCwd(cwd); } catch { /* ignore */ }
    return true;
  });

  // ========== Clipboard image IPC ==========

  ipcMain.handle('clipboard:save-image', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    if (!fs.existsSync(PASTE_IMAGE_DIR)) {
      fs.mkdirSync(PASTE_IMAGE_DIR, { recursive: true });
    }

    const filename = `paste-${Date.now()}.png`;
    const filePath = path.join(PASTE_IMAGE_DIR, filename);
    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  });

  // ========== Clipboard file IPC ==========
  ipcMain.handle('clipboard:get-file-path', async () => {
    // Try reading the file URL
    const formats = clipboard.availableFormats();
    if (formats.includes('public.file-url')) {
      const buffer = clipboard.readBuffer('public.file-url');
      const url = buffer.toString('utf8');
      // file-url format: file://localhost/path/to/file or file:///path/to/file
      const match = url.match(/file:\/\/\/?(.+)$/);
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }
    return null;
  });

  // ========== File watching IPC ==========

  // Allowlist of common source file extensions
  const SOURCE_FILE_EXTENSIONS = [
    // TypeScript/JavaScript
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    // Vue/Uni-app
    '.vue', '.uvue', '.nvue',
    // JSON/YAML
    '.json', '.yaml', '.yml', '.toml',
    // Python
    '.py', '.pyw',
    // Java/Kotlin
    '.java', '.kt', '.kts',
    // Swift/Objective-C
    '.swift', '.m', '.h',
    // Go
    '.go',
    // Rust
    '.rs',
    // HTML/CSS
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    // Markdown/docs
    '.md', '.mdx', '.txt',
    // Shell
    '.sh', '.bash', '.zsh', '.fish',
    // SQL
    '.sql',
    // Other common source files
    '.xml', '.xaml', '.gradle', '.properties',
  ];

  function isSourceFile(filename: string): boolean {
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    return SOURCE_FILE_EXTENSIONS.includes(ext);
  }

  ipcMain.handle('filewatcher:start', (_e, cwd: string) => {
    // Stop the old one
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    watchingCwd = cwd;
    try {
      fileWatcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Ignore the .git directory and hidden files
        if (filename.startsWith('.git/') || filename.startsWith('.git\\')) return;
        if (filename.startsWith('.')) return;
        // Ignore common non-source directories
        if (filename.includes('node_modules')) return;
        if (filename.includes('dist/') || filename.includes('dist\\')) return;
        if (filename.includes('build/') || filename.includes('build\\')) return;
        if (filename.includes('out/') || filename.includes('out\\')) return;
        if (filename.includes('__pycache__')) return;
        if (filename.includes('.cache/') || filename.includes('.cache\\')) return;
        // Ignore build artifacts and temporary files
        if (/\.(map|d\.ts|tsbuildinfo|pyc|o|a|dylib|so|class|tmp|temp|swp|swo|bak|log)$/i.test(filename)) return;
        if (/~$/.test(filename)) return;
        // Only show source files (allowlist filtering)
        if (!isSourceFile(filename)) return;
        mainWindow?.webContents.send('filewatcher:change', filename, eventType);
      });
    } catch { /* silently ignore watch failures */ }
  });

  ipcMain.handle('filewatcher:stop', () => {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
      watchingCwd = null;
    }
  });

  ipcMain.handle('filewatcher:open', async (_e, filePath: string): Promise<OpenEditorResult> => {
    return openFileInEditor(filePath);
  });

  ipcMain.handle('filewatcher:select-editor', async () => {
    if (!mainWindow) return null;
    let defaultPath: string;
    let filters: { name: string; extensions: string[] }[];
    if (process.platform === 'win32') {
      defaultPath = 'C:\\Program Files';
      filters = [{ name: 'Executable files', extensions: ['exe'] }];
    } else if (process.platform === 'darwin') {
      defaultPath = '/Applications';
      filters = [{ name: 'Applications', extensions: ['app'] }];
    } else {
      defaultPath = '/usr/bin';
      filters = [];
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select editor',
      defaultPath,
      filters,
      properties: ['openFile'],
      message: 'Choose the editor to open files with',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const editorPath = result.filePaths[0];
    saveEditorPreference(editorPath);
    return editorPath;
  });

  ipcMain.handle('filewatcher:get-editor', () => {
    return loadEditorPreference();
  });

  // Open directory in Finder
  ipcMain.handle('shell:open-folder', (_e, folderPath: string) => {
    shell.showItemInFolder(folderPath);
  });

  // Read directory contents
  ipcMain.handle('fs:read-directory', async (_e, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch (error) {
      console.error('Failed to read directory:', error);
      return [];
    }
  });

  // Open file with default app
  ipcMain.handle('shell:open-file', (_e, filePath: string) => {
    shell.openPath(filePath);
  });

  // Open external link
  ipcMain.handle('shell:open-url', (_e, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('terminal-client:get-url', () => getTerminalClientUrl());

  // ========== AI config IPC ==========

  // Apply the manual config directly (saves the preference; no longer calls the removed AI service)
  ipcMain.handle('ai:apply-config', (_e, config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => {
    try {
      fs.writeFileSync(getPreferencePath(), JSON.stringify({
        providerId: '__manual__',
        model: config.model,
        manualConfig: config,
      }));
      invalidateAiPreferenceCache();
    } catch { /* ignore */ }
    return true;
  });

  // Get the currently saved config
  ipcMain.handle('ai:get-current-config', () => {
    const pref = loadAiPreferenceData();
    if (pref.manualConfig) {
      return { ...pref.manualConfig, providerId: pref.providerId };
    }
    return null;
  });

  // Test AI config connectivity
  ipcMain.handle('ai:test-config', async (_e, _config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => {
    return { ok: false, error: 'AI feature has been removed' };
  });

  // Get the model provider actually used by the CLI
  ipcMain.handle('cli:get-provider', (_e, presetCommand: string) => {
    return getCliProvider(presetCommand);
  });

  // ========== Claude provider config ==========
  const CLAUDE_PROVIDERS_PATH = path.join(app.getPath('userData'), 'claude-providers.json');

  // Auto-detect custom providers like MiniMax from ~/.claude/settings.json
  function detectClaudeProvidersFromSettings(): any[] {
    const home = os.homedir();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const detected: any[] = [];

    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';
        const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
        const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '';

        // If there is a custom baseUrl that is not the default Anthropic, add it as a provider automatically
        if (baseUrl && !baseUrl.includes('api.anthropic.com')) {
          let name = 'Custom';
          let id = 'custom';

          if (baseUrl.includes('minimaxi')) {
            name = 'MiniMax';
            id = 'minimax';
          } else if (baseUrl.includes('deepseek')) {
            name = 'DeepSeek';
            id = 'deepseek';
          } else if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) {
            name = 'GLM (Zhipu)';
            id = 'glm';
          } else if (baseUrl.includes('moonshot')) {
            name = 'Kimi (Moonshot)';
            id = 'kimi';
          } else if (baseUrl.includes('qwen') || baseUrl.includes('dashscope')) {
            name = 'QWEN (Tongyi Qianwen)';
            id = 'qwen';
          } else {
            // Extract the name from the domain
            try {
              const url = new URL(baseUrl);
              const host = url.hostname.replace(/^(api|code)\./, '');
              name = host.split('.')[0].charAt(0).toUpperCase() + host.split('.')[0].slice(1);
              id = name.toLowerCase();
            } catch { /* ignore */ }
          }

          detected.push({
            id,
            name,
            baseUrl,
            apiKey,
            model: model || '',
          });
        }
      }
    } catch { /* ignore */ }

    return detected;
  }

  ipcMain.handle('claude-providers:list', () => {
    try {
      if (fs.existsSync(CLAUDE_PROVIDERS_PATH)) {
        const saved = JSON.parse(fs.readFileSync(CLAUDE_PROVIDERS_PATH, 'utf-8'));
        // Merge auto-detected providers (saved ones take priority)
        const detected = detectClaudeProvidersFromSettings();
        const savedIds = new Set(saved.map((p: any) => p.id));

        // Add detected providers that are not saved
        for (const p of detected) {
          if (!savedIds.has(p.id)) {
            saved.push(p);
          }
        }
        return saved;
      }
    } catch { /* ignore */ }
    // When there is no saved config, return the auto-detected providers
    return detectClaudeProvidersFromSettings();
  });

  ipcMain.handle('claude-providers:save', (_e, providers: any[]) => {
    fs.writeFileSync(CLAUDE_PROVIDERS_PATH, JSON.stringify(providers, null, 2), 'utf-8');
    return true;
  });

  // ========== Devin account management ==========
  const DEVIN_ACCOUNTS_PATH = path.join(os.homedir(), '.session-sync-manager', 'accounts.json');
  const authCliPath = (() => {
    try {
      const syncPath = path.join(os.homedir(), '.local', 'bin', 'session-sync');
      const resolved = fs.realpathSync(syncPath);
      return path.join(path.dirname(resolved), 'auth-cli.mjs');
    } catch { return null; }
  })();

  function runAuthCli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      if (!authCliPath) { resolve({ code: 1, stdout: '', stderr: 'auth-cli.mjs not found' }); return; }
      const child = spawn('node', [authCliPath, ...args], { stdio: 'pipe' });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  }

  ipcMain.handle('devin-accounts:list', () => {
    try {
      if (fs.existsSync(DEVIN_ACCOUNTS_PATH)) {
        return JSON.parse(fs.readFileSync(DEVIN_ACCOUNTS_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return { accounts: [], currentIndex: 0 };
  });

  ipcMain.handle('devin-accounts:add', async (_e, email: string, password: string) => {
    const { code, stderr } = await runAuthCli(['add', email, password]);
    return { ok: code === 0, error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:add-batch', async (_e, text: string) => {
    const { code, stderr } = await runAuthCli(['add', '--batch'], text);
    // auth-cli.mjs's add --batch writes its stats to stderr
    return { ok: code === 0, output: stderr.trim(), error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:remove', async (_e, email: string) => {
    const { code, stderr } = await runAuthCli(['remove', email]);
    return { ok: code === 0, error: code !== 0 ? stderr.trim() : undefined };
  });

  ipcMain.handle('devin-accounts:switch', async (_e, opts: { email?: string; next?: boolean }) => {
    // When next is true or no email is passed, auth-cli.mjs rotates to the next account by default
    const args = opts.email ? ['switch', '--force', opts.email] : ['switch'];
    const { code, stdout, stderr } = await runAuthCli([...args, '--json']);
    // auth-cli.mjs also rotates installation_id internally; rotate once more here as a fallback
    rotateDevinInstallationId();
    if (code !== 0) return { ok: false, error: stderr.trim() };
    // Re-read the updated account state
    try {
      const updated = JSON.parse(fs.readFileSync(DEVIN_ACCOUNTS_PATH, 'utf-8'));
      const cur = updated.accounts[updated.currentIndex];
      return { ok: true, email: cur?.email, quota: cur?.quota };
    } catch {
      return { ok: true };
    }
  });

  ipcMain.handle('devin-accounts:quota', async () => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      return { ok: true, ...JSON.parse(stdout.trim()) };
    } catch {
      return { ok: false, error: 'Parse failed' };
    }
  });

  ipcMain.handle('devin-accounts:quota-all', async () => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--all', '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      const results = JSON.parse(stdout.trim());
      return { ok: true, results };
    } catch {
      return { ok: false, error: 'Parse failed' };
    }
  });

  ipcMain.handle('devin-accounts:quota-one', async (_e, email: string) => {
    const { code, stdout, stderr } = await runAuthCli(['quota', '--email', email, '--json']);
    if (code !== 0) return { ok: false, error: stderr.trim() };
    try {
      return { ok: true, ...JSON.parse(stdout.trim()) };
    } catch {
      return { ok: false, error: 'Parse failed' };
    }
  });

  ipcMain.handle('devin-accounts:rotate-device', () => {
    rotateDevinInstallationId();
    return { ok: true };
  });

  // Renderer proactively fetches remote server info (resolves the race where IPC messages arrive before the renderer loads)
  ipcMain.handle('remote:get-server-info', () => cachedRemoteServerInfo);

  // ========== Auto-continue config relay IPC ==========
  // The main process acts as a relay: remote-server API -> the renderer's sessionAutoContinue

  // Holds pending get-request callbacks
  const autoContinuePendingGets = new Map<string, (config: any) => void>();

  // The renderer replies with the config
  ipcMain.on('auto-continue:config-reply', (_e, sessionId: string, config: any) => {
    const resolve = autoContinuePendingGets.get(sessionId);
    if (resolve) {
      autoContinuePendingGets.delete(sessionId);
      resolve(config);
    }
  });

  // Called by remote-server: read the auto-continue config
  (global as any).__getAutoContinueConfig = (sessionId: string): Promise<any> => {
    return new Promise((resolve) => {
      autoContinuePendingGets.set(sessionId, resolve);
      safeSend('auto-continue:get', sessionId);
      // Timeout fallback
      setTimeout(() => {
        if (autoContinuePendingGets.has(sessionId)) {
          autoContinuePendingGets.delete(sessionId);
          resolve(null);
        }
      }, 2000);
    });
  };

  // Called by remote-server: write the auto-continue config
  (global as any).__setAutoContinueConfig = (sessionId: string, config: any): void => {
    safeSend('auto-continue:set', sessionId, config);
  };

  // Called by remote-server: read session status (busy/unread/idle)
  // The renderer syncs status here via IPC
  (global as any).__sessionStatuses = {} as Record<string, string>;
  ipcMain.on('session:sync-status', (_e, statuses: Record<string, string>) => {
    (global as any).__sessionStatuses = statuses;
  });

  // ========== Chat Session IPC ==========

  ipcMain.handle('chat:create', (_e, opts: { workspace: string; model?: string }) => {
    if (!chatSessionManager) return null;
    const session = chatSessionManager.create(opts.workspace, opts.model);
    return { id: session.id, title: session.title, model: session.model, workspace: session.workspace, createdAt: session.createdAt };
  });

  ipcMain.handle('chat:send', (_e, sessionId: string, content: string) => {
    if (!chatSessionManager) return;
    chatSessionManager.sendMessage(sessionId, content).catch(() => {});
  });

  ipcMain.handle('chat:list', () => {
    if (!chatSessionManager) return [];
    return chatSessionManager.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      model: s.model,
      workspace: s.workspace,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));
  });

  ipcMain.handle('chat:messages', (_e, sessionId: string) => {
    if (!chatSessionManager) return [];
    return chatSessionManager.getSession(sessionId)?.messages || [];
  });

  ipcMain.handle('chat:destroy', (_e, sessionId: string) => {
    // Save to the closed list before destroying
    const session = chatSessionManager?.getSession(sessionId);
    if (session && session.messages.length > 0) {
      addClosedChatSession({
        title: session.title,
        model: session.model,
        workspace: session.workspace,
        messages: session.messages,
      });
    }
    chatSessionManager?.destroy(sessionId);
    return true;
  });

  ipcMain.handle('chat:abort', (_e, sessionId: string) => {
    chatSessionManager?.abortStream(sessionId);
    return true;
  });

  ipcMain.handle('chat:rename', (_e, sessionId: string, title: string) => {
    chatSessionManager?.rename(sessionId, title);
    return true;
  });

  ipcMain.handle('chat:health', async () => {
    if (!chatSessionManager) return { ok: false, error: 'Chat manager not ready' };
    const health = await chatSessionManager.healthCheck();
    return {
      ...health,
      autoManaged: windsurfProxyManager?.isAvailable() ?? false,
      proxyDir: windsurfProxyManager?.getProxyDir() ?? null,
    };
  });

  ipcMain.handle('chat:proxy-start', async () => {
    if (!windsurfProxyManager) return { ok: false, error: 'Proxy manager not available' };
    return windsurfProxyManager.start();
  });

  ipcMain.handle('chat:models', async () => {
    if (!chatSessionManager) return [];
    return chatSessionManager.listModels();
  });
}

app.whenReady().then(async () => {
  await setupPtyManager();

  // macOS Dock icon — set before creating the window
  const appIcon = loadAppIcon();
  currentAppIcon = appIcon;
  if (appIcon) {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(appIcon);
    }
  }
  createTray();

  // Auto-start the Windsurf proxy
  windsurfProxyManager = new WindsurfProxyManager((running, error) => {
    if (running) {
      console.log('[Main] Windsurf proxy is ready');
    } else {
      console.log('[Main] Windsurf proxy down:', error || 'unknown');
    }
  });
  if (windsurfProxyManager.isAvailable()) {
    console.log('[Main] Auto-starting Windsurf proxy...');
    windsurfProxyManager.start().then((result) => {
      console.log('[Main] Windsurf proxy start result:', result.ok ? 'OK' : result.error);
    });
  } else {
    console.log('[Main] Windsurf proxy directory not found, chat features will be unavailable');
  }

  // Attach to global for use by remote-server and chat-session-manager
  (global as any).__windsurfProxyManager = windsurfProxyManager;

  // Initialize the Chat Session Manager
  chatSessionManager = new ChatSessionManager({
    onDelta: (sessionId, text) => {
      safeSend('chat:delta', sessionId, text);
    },
    onDone: (sessionId, content) => {
      safeSend('chat:done', sessionId, content);
    },
    onError: (sessionId, error) => {
      safeSend('chat:error', sessionId, error);
    },
    onTitleUpdate: (sessionId, title) => {
      safeSend('chat:title-update', sessionId, title);
    },
  }, () => loadAiPreferenceData().manualConfig || null);

  // Attach to global for use by remote-server
  (global as any).__chatSessionManager = chatSessionManager;

  registerIPC();
  cloudflaredManager = new CloudflaredManager(path.join(__dirname, '../..'));
  createWindow(appIcon);

  // Start the remote-access server (mobile)
  startRemoteServer(ptyManager, (sessionInfo) => {
    // The mobile client created a session; notify the desktop renderer to refresh
    safeSend('pty:remote-created', sessionInfo);
  }, (id) => {
    // The mobile client destroyed a session; notify the desktop renderer
    safeSend('pty:exit', id);
  }, (info) => {
    // After the server starts, send the connection info to the renderer for display
    const tunnel = cloudflaredManager?.start();
    const serverInfo: RemoteServerInfoWithTunnel = {
      ...info,
      connectedClients: trayState.connectedClients,
      subscribedSessions: trayState.subscribedSessions,
      publicUrl: tunnel?.url || undefined,
      tunnel,
    };
    cachedRemoteServerInfo = serverInfo;
    trayState.isOnline = true;
    trayState.lanUrl = serverInfo.lanUrl;
    trayState.publicUrl = serverInfo.publicUrl || null;
    trayState.port = serverInfo.port;
    updateTray();
    safeSend('remote:server-info', serverInfo);
  }, (status) => {
    updateRemoteTrayStatus(status);
    if (cachedRemoteServerInfo) {
      cachedRemoteServerInfo = {
        ...cachedRemoteServerInfo,
        ...status,
      };
    }
  });

  // The AI config is already saved in the preference file; no extra restore needed

});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(currentAppIcon);
  }
});

app.on('before-quit', async () => {
  globalShortcut.unregisterAll();
  cloudflaredManager?.stopOwnedProcess();
  windsurfProxyManager?.destroy();
  tray?.destroy();
  tray = null;
});
