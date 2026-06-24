import { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell, globalShortcut, Tray, Menu } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getDisplayName, rotateDevinInstallationId, writeClaudeSessionTitle, writeCodexSessionTitle } from './pty-manager';
import { PtyBackend } from './pty-backend';
import { PtyDaemonClient } from './pty-daemon-client';
import { ConnectionRegistry, LOCAL_CONNECTION_ID } from './connection-registry';
import { RemoteServerBackend } from './remote-server-backend';
import { loadOrCreatePtyDaemonConfig } from './pty-daemon-config';
import { loadSubscriptionToken, saveSubscriptionToken, clearSubscriptionToken, subscriptionTokenStatus } from './subscription-token';
import { AIConfigManager } from './ai-config';
import { startRemoteServer, setAppVersionProvider, pushRawDataToRemote, sendRemotePush, addRemoteRecentCwd, getTailscaleInfo, type RemoteConnectionStatus } from './remote-server';
import { CloudflaredManager } from './cloudflared-manager';
import { ChatSessionManager } from './chat-session-manager';
import { WindsurfProxyManager } from './windsurf-proxy-manager';
import { bootstrapRemoteHost } from './remote-bootstrap';
import { autoUpdater } from 'electron-updater';
import buildStamp from './build-stamp.json';
import {
  type AgentHistorySession,
  readFirstLine,
  codexTitleIsDefault,
  codexFirstUserPrompt,
  listCodexSessions,
  cleanSessionTitle,
  extractRenameTitle,
  isRealUserPrompt,
  readHead,
  findClaudeTitleFields,
  resolveClaudeTitle,
  getCachedClaudeTitle,
  listResumableSessions,
} from './resumable-sessions';

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

// ========== Archived session persistence (Posse-internal soft-hide) ==========
// Archive is independent of agent data: it only records session ids we hide from the
// default project list. Reversible, never touches the agent's backing store.
const ARCHIVED_SESSIONS_FILE = path.join(app.getPath('userData'), 'archived-sessions.json');

function loadArchivedSessionIds(): Set<string> {
  try {
    const raw = fs.readFileSync(ARCHIVED_SESSIONS_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.map((x) => String(x)));
  } catch { /* missing / corrupt -> empty */ }
  return new Set();
}

function saveArchivedSessionIds(ids: Set<string>): void {
  try {
    fs.writeFileSync(ARCHIVED_SESSIONS_FILE, JSON.stringify([...ids], null, 2));
  } catch { /* ignore */ }
}

function setSessionArchived(id: string, archived: boolean): void {
  const sid = String(id || '').trim();
  if (!sid) return;
  const ids = loadArchivedSessionIds();
  if (archived) ids.add(sid); else ids.delete(sid);
  saveArchivedSessionIds(ids);
}

// ========== Project path remap (rename/moved folder → re-attach historical sessions) ==========
// When a project folder is renamed/moved, historical agent sessions keep the OLD cwd recorded
// in their jsonl, so the navigator buckets them under the dead old path. A remap maps an old
// recorded cwd → a new folder path; buildProjectsList() honors it so those sessions re-attach
// to the new location and the dead old entry disappears. Posse-internal, reversible, never
// touches agent data.
const PATH_REMAPS_FILE = path.join(app.getPath('userData'), 'path-remaps.json');

// Normalize a cwd for stable comparison. Mirrors the renderer's normalizeCwd:
// strips the macOS /private prefix and trailing slashes.
function normalizeRemapCwd(cwd: string): string {
  if (!cwd) return '';
  let p = String(cwd).trim();
  if (p.startsWith('/private/')) p = p.slice('/private'.length);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

function loadPathRemaps(): Record<string, string> {
  try {
    const raw = fs.readFileSync(PATH_REMAPS_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v) out[String(k)] = v;
      }
      return out;
    }
  } catch { /* missing / corrupt -> empty */ }
  return {};
}

function savePathRemaps(map: Record<string, string>): void {
  try {
    fs.writeFileSync(PATH_REMAPS_FILE, JSON.stringify(map, null, 2));
  } catch { /* ignore */ }
}

// Add/replace a remap: old recorded cwd → new folder path. Both normalized.
// A self-mapping (old === new) is treated as a removal.
function setPathRemap(oldPath: string, newPath: string): void {
  const oldKey = normalizeRemapCwd(oldPath);
  const newVal = normalizeRemapCwd(newPath);
  if (!oldKey || !newVal) return;
  const map = loadPathRemaps();
  if (oldKey === newVal) { delete map[oldKey]; }
  else { map[oldKey] = newVal; }
  savePathRemaps(map);
}

function removePathRemap(oldPath: string): void {
  const oldKey = normalizeRemapCwd(oldPath);
  if (!oldKey) return;
  const map = loadPathRemaps();
  if (oldKey in map) { delete map[oldKey]; savePathRemaps(map); }
}

// Resolve a recorded cwd through the remap chain (handles a remap whose target was itself
// later remapped). Returns the final destination path, or the input if unmapped.
function resolveRemappedCwd(cwd: string, map: Record<string, string>): string {
  let cur = normalizeRemapCwd(cwd);
  if (!cur) return cwd;
  const seen = new Set<string>();
  while (map[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = normalizeRemapCwd(map[cur]);
  }
  return cur;
}

// ========== Permanent session deletion (targets the agent's OWN store) ==========
// Routes by agent type to the correct backing store. NEVER throws across IPC.
function deleteSessionFromStore(
  agent: string,
  id: string,
  sourcePath: string
): { ok: boolean; error?: string } {
  try {
    const a = String(agent || '').trim().toLowerCase();
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'missing session id' };

    if (a === 'claude' || a === 'kiro') {
      // Single backing file (Claude: <uuid>.jsonl ; Kiro: <uuid>.json).
      if (sourcePath && fs.existsSync(sourcePath)) {
        fs.rmSync(sourcePath, { force: true });
      }
      return { ok: true };
    }

    if (a === 'codex') {
      // Remove the rollout file AND its line in ~/.codex/session_index.jsonl.
      if (sourcePath && fs.existsSync(sourcePath)) {
        fs.rmSync(sourcePath, { force: true });
      }
      try {
        const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, 'utf-8');
          const kept = content.split('\n').filter((line) => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            try {
              const obj = JSON.parse(trimmed) as { id?: string };
              return obj.id !== sid;
            } catch { return true; } // keep unparseable lines untouched
          });
          fs.writeFileSync(indexPath, kept.length ? kept.join('\n') + '\n' : '');
        }
      } catch { /* index cleanup best-effort */ }
      return { ok: true };
    }

    if (a === 'copilot') {
      // sqlite-backed: DELETE the row by id, mirroring discoverCopilotSessions access.
      const dbPath = path.join(os.homedir(), '.copilot', 'session-store.db');
      if (!fs.existsSync(dbPath)) return { ok: true };
      let done = false;
      try {
        const sqlite = require('node:sqlite') as {
          DatabaseSync?: new (p: string) => {
            prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
            close: () => void;
          };
        };
        if (sqlite?.DatabaseSync) {
          const db = new sqlite.DatabaseSync(dbPath);
          try {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
            done = true;
          } finally {
            db.close();
          }
        }
      } catch { /* node:sqlite unavailable -> fall through to binary */ }
      if (!done) {
        const { execFileSync } = require('child_process') as typeof import('child_process');
        const escaped = sid.replace(/'/g, "''");
        execFileSync('sqlite3', [dbPath, `DELETE FROM sessions WHERE id = '${escaped}';`], {
          encoding: 'utf-8',
          timeout: 5000,
        });
      }
      return { ok: true };
    }

    return { ok: false, error: `unknown agent: ${a}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

export interface SshHostEntry {
  host: string;
  hostName?: string;
  user?: string;
}

// Parse an OpenSSH config file into a list of connectable Host aliases.
// - Collects every pattern on each `Host` line; wildcard-only patterns (containing
//   `*` or `?`) are skipped since they aren't connectable targets.
// - HostName/User from the block are attached as display-only hints.
// - Best-effort follows `Include` directives (one level, relative to ~/.ssh).
// Pure parsing; the caller wraps in try/catch.
function parseSshConfig(content: string, seen: Set<string>, out: SshHostEntry[], depth: number): void {
  // Hosts declared in the current block, awaiting HostName/User hints.
  let pending: SshHostEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Tokens are separated by whitespace or `=` (e.g. `HostName=example.com`).
    const eq = line.replace(/=/g, ' ');
    const parts = eq.split(/\s+/);
    const keyword = (parts.shift() || '').toLowerCase();
    const args = parts.filter(Boolean);
    if (keyword === 'host') {
      pending = [];
      for (const pattern of args) {
        if (pattern.includes('*') || pattern.includes('?')) continue;
        if (pattern.startsWith('!')) continue; // negated pattern, not a target
        if (seen.has(pattern)) continue;
        seen.add(pattern);
        const entry: SshHostEntry = { host: pattern };
        out.push(entry);
        pending.push(entry);
      }
    } else if (keyword === 'hostname' && args[0]) {
      for (const e of pending) if (!e.hostName) e.hostName = args[0];
    } else if (keyword === 'user' && args[0]) {
      for (const e of pending) if (!e.user) e.user = args[0];
    } else if (keyword === 'include' && depth < 3) {
      for (const inc of args) {
        try {
          const base = expandUserPath(inc);
          const resolved = path.isAbsolute(base) ? base : path.join(os.homedir(), '.ssh', base);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            parseSshConfig(fs.readFileSync(resolved, 'utf8'), seen, out, depth + 1);
          }
        } catch { /* ignore unreadable include */ }
      }
    }
  }
}

function listSshHosts(): SshHostEntry[] {
  try {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) return [];
    const content = fs.readFileSync(configPath, 'utf8');
    const out: SshHostEntry[] = [];
    parseSshConfig(content, new Set<string>(), out, 0);
    return out;
  } catch {
    return [];
  }
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

// Connection registry — the seam for multi-host. Holds connections keyed by id
// (only 'local' today) and tracks the active one. Populated in setupPtyManager()
// before anything reads from it (setupPtyManager is awaited at app startup).
const connectionRegistry = new ConnectionRegistry();

// ========== Window <-> connection binding (D3: per-window host) ==========
// Each window binds to exactly ONE connection. The PRIMARY window (mainWindow) defaults
// to 'local' and behaves exactly as before. Secondary windows ("open host in new window")
// bind to a different connection so multiple hosts run in parallel.
//
// `activeConnectionId` is retained as the PRIMARY-window binding + the fallback for any
// code path that has no originating window (timers, tray, the mobile relay). Per-window
// IPC handlers resolve the calling window via BrowserWindow.fromWebContents(event.sender)
// and use that window's bound connection instead.
interface WindowBinding {
  window: BrowserWindow;
  connectionId: string;
}
const windowBindings = new Map<number /* webContents.id */, WindowBinding>();

/** The primary window's bound connection. Fallback when no event window is available. */
let activeConnectionId: string = LOCAL_CONNECTION_ID;

/** Register/update a window's bound connection. Keyed by webContents.id. */
function bindWindowConnection(window: BrowserWindow, connectionId: string): void {
  windowBindings.set(window.webContents.id, { window, connectionId });
  if (window === mainWindow) activeConnectionId = connectionId;
}

/** Remove a window's binding (on 'closed'). Never touches the connection itself. */
function unbindWindow(window: BrowserWindow): void {
  windowBindings.delete(window.webContents.id);
}

/** The connection id bound to a given window, or the primary fallback. */
function connectionIdForWindow(window: BrowserWindow | null): string {
  if (window) {
    const binding = windowBindings.get(window.webContents.id);
    if (binding) return binding.connectionId;
  }
  return activeConnectionId;
}

/** Resolve the connection id for the window that sent an IPC event (primary fallback). */
function connectionIdForEvent(event?: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): string {
  if (event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) return connectionIdForWindow(window);
  }
  return activeConnectionId;
}

/**
 * The PtyBackend for a given connection id (defaults to the primary/active connection).
 * Resolves from the registry every call so it always reflects the current binding.
 */
function backendFor(connectionId: string = activeConnectionId): PtyBackend {
  return connectionRegistry.get(connectionId)?.backend ?? connectionRegistry.getActive().backend;
}

/** The PtyBackend for the window that sent an IPC event (primary fallback). */
function backendForEvent(event?: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): PtyBackend {
  return backendFor(connectionIdForEvent(event));
}

/**
 * The active connection's backend (primary fallback). Retained for the non-event code
 * paths (timers/notifications) that historically read the single global backend.
 */
function activeBackend(): PtyBackend {
  return backendFor(activeConnectionId);
}
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
  tailscaleUrl?: string | null;
  tailscaleHttpUrl?: string | null;
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

/**
 * Create a window bound to `connectionId` (defaults to 'local'). The FIRST window created becomes
 * the primary (`mainWindow`); subsequent windows are secondary and bind to their own connection.
 * Returns the window so callers ("open host in new window") can act on it.
 */
function createWindow(appIcon?: Electron.NativeImage, connectionId: string = LOCAL_CONNECTION_ID): BrowserWindow {
  const isPrimary = mainWindow === null;
  const win = new BrowserWindow({
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

  if (isPrimary) mainWindow = win;

  // Register the window <-> connection binding BEFORE loading so connection-scoped events route
  // correctly from first paint.
  bindWindowConnection(win, connectionId);

  win.maximize();

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      win.webContents.send('app:close-current-session');
    }
    // Block Cmd+R / Ctrl+R refresh ONLY inside Posse's own window. Using a
    // window-scoped before-input-event (not globalShortcut.register, which would
    // register an OS-level hotkey and swallow Cmd+R for every other app too).
    if ((input.meta || input.control) && input.key.toLowerCase() === 'r') {
      event.preventDefault();
    }
  });

  win.on('closed', () => {
    // Closing a window NEVER kills its connection (remote daemons keep running 24/7). Just drop
    // the binding so its frames stop routing here.
    unbindWindow(win);
    if (win === mainWindow) {
      mainWindow = null;
      // Promote another open window (if any) to primary so non-window code paths keep a target.
      const next = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (next) {
        mainWindow = next;
        activeConnectionId = connectionIdForWindow(next);
      }
    }
  });

  return win;
}

function sendToWindow(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    try {
      window.webContents.send(channel, ...args);
    } catch {
      // render frame disposed during GPU crash/restart
    }
  }
}

/**
 * Broadcast an app-wide (non-connection-scoped) event to EVERY open window — theme changes,
 * closed-session lists, chat deltas, etc. The primary window always receives these.
 */
function safeSend(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToWindow(win, channel, ...args);
  }
}

/**
 * Route a CONNECTION-SCOPED event (pty:data / title / exit / remote-created / auto-switch)
 * ONLY to the window(s) bound to that connection. This is the multi-window crux: each
 * connection's pty output reaches only its own window(s), so `term-N` ids never collide
 * across windows. Falls back to the primary window when no window is bound to the connection
 * yet (e.g. the local connection before any secondary window exists — preserves today's
 * single-window behavior).
 */
function sendToConnection(connectionId: string, channel: string, ...args: unknown[]): void {
  let delivered = false;
  for (const { window, connectionId: boundId } of windowBindings.values()) {
    if (boundId === connectionId) {
      sendToWindow(window, channel, ...args);
      delivered = true;
    }
  }
  // Safety net: if no window is bound (binding not yet registered, e.g. during early startup
  // before the primary window's binding lands), deliver to the primary window when it is the
  // active connection. Keeps the single-window path identical to before.
  if (!delivered && connectionId === activeConnectionId && mainWindow) {
    sendToWindow(mainWindow, channel, ...args);
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

function maybeNotifyAttention(id: string, data: string, connectionId: string = activeConnectionId): void {
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

  const session = backendFor(connectionId).getSession(id);
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

/**
 * Build the PtyBackendEvents for a given connection. Each renderer-bound callback routes via
 * `sendToConnection(connId, ...)`, so a connection's `pty:data` / title / exit / auto-switch
 * frames reach ONLY the window(s) bound to THAT connection. Multiple windows can therefore view
 * different hosts in parallel: each window's renderer only ever receives its own connection's
 * events, so local + remote `term-N` ids never interleave or collide in the UI. A connection
 * with no bound window (a 24/7 remote nobody is viewing) keeps running but its frames fall on the
 * floor (sendToConnection finds no target) — reopening a window bound to it resurfaces it.
 * `onRawData` (mobile push) mirrors only the LOCAL backend regardless of which host any desktop
 * window is viewing.
 */
function buildConnectionEvents(connId: string): import('./pty-backend').PtyBackendEvents {
  return {
    onData: (id, data) => {
      sendToConnection(connId, 'pty:data', id, data);
      maybeNotifyAttention(id, data, connId);
    },
    onRawData: (id, data) => {
      // The mobile relay mirrors the LOCAL backend's raw output regardless of the desktop's
      // active connection. Remote connections have no separate relay, so only push for local.
      if (connId === LOCAL_CONNECTION_ID) pushRawDataToRemote(id, data);
    },
    onTitleUpdate: (id, title) => {
      sendToConnection(connId, 'pty:title-update', id, title);
    },
    onExit: (id, exitedSession) => {
      // Save sessions that have a resume ID to the closed list
      const session = exitedSession || backendFor(connId).getSession(id);
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

      sendToConnection(connId, 'pty:exit', id);
    },
    onPasteInput: (id, _cwd) => {
      sessionLastInputAt.set(id, Date.now());
      sessionArmedForNotify.add(id);
    },
    onAutoSwitchStatus: (id, status, detail) => {
      sendToConnection(connId, 'pty:auto-switch-status', id, status, detail);
    },
  };
}

async function setupPtyManager(): Promise<void> {
  const localBackend = await PtyDaemonClient.connect(buildConnectionEvents(LOCAL_CONNECTION_ID));

  // Register the local connection and make it active. Remote connections are added on
  // demand by addRemoteConnection() (the connections:add IPC).
  connectionRegistry.register({
    id: LOCAL_CONNECTION_ID,
    label: 'Local',
    kind: 'local',
    backend: localBackend,
  });
  connectionRegistry.setActive(LOCAL_CONNECTION_ID);
  activeConnectionId = LOCAL_CONNECTION_ID;
}

/** Stable connection id for a remote host derived from its base URL. */
function remoteConnectionId(baseUrl: string): string {
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/[^a-zA-Z0-9.:_-]/g, '_');
  return `remote:${host}`;
}

/**
 * Connect to a remote Posse backend and register it as a connection. The remote keeps running
 * 24/7 independent of this client; this only attaches a viewer. Returns the new connection id.
 */
async function addRemoteConnection(opts: { label: string; baseUrl: string; token: string }): Promise<{ id: string; label: string }> {
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  const token = String(opts.token || '').trim();
  if (!baseUrl) throw new Error('Base URL is required');
  if (!token) throw new Error('Token is required');
  const id = remoteConnectionId(baseUrl);
  // If this host is already registered, dispose the old client and replace it (re-pair).
  const existing = connectionRegistry.get(id);
  if (existing && existing.kind === 'remote') {
    try { (existing.backend as RemoteServerBackend).dispose?.(); } catch { /* ignore */ }
    connectionRegistry.unregister(id);
  }
  const label = String(opts.label || '').trim() || baseUrl.replace(/^https?:\/\//, '');
  const backend = await RemoteServerBackend.connect({ baseUrl, token, events: buildConnectionEvents(id) });
  connectionRegistry.register({ id, label, kind: 'remote', backend });
  return { id, label };
}

/**
 * Bind a window to a connection (the in-window host switch). Rebinds the given window — or the
 * primary window when none is supplied (the historical "set active" path / non-window callers).
 * Tells that window's renderer to refresh its navigator/file tree. Only the rebound window is
 * notified, so other windows keep viewing their own hosts.
 */
function bindConnectionToWindow(id: string, window: BrowserWindow | null): void {
  // Keep the registry's "active" pointer following the primary window for the non-window code
  // paths (mobile relay / timers) that still read connectionRegistry / activeConnectionId.
  const target = window ?? mainWindow;
  if (target) {
    bindWindowConnection(target, id);
    if (target === mainWindow) connectionRegistry.setActive(id);
    sendToWindow(target, 'connection:changed', id);
  } else {
    // No window at all (shouldn't happen post-startup) — just track the active pointer.
    connectionRegistry.setActive(id);
    activeConnectionId = id;
  }
}

/** Remove a remote connection (never 'local'); disposes its client. The remote keeps running. */
function removeConnection(id: string): void {
  if (id === LOCAL_CONNECTION_ID) return;
  const removed = connectionRegistry.unregister(id);
  if (removed) {
    try { (removed.backend as RemoteServerBackend).dispose?.(); } catch { /* ignore */ }
  }
  // Any window still bound to the removed connection falls back to local and is told to refresh.
  for (const binding of windowBindings.values()) {
    if (binding.connectionId === id) {
      bindWindowConnection(binding.window, LOCAL_CONNECTION_ID);
      sendToWindow(binding.window, 'connection:changed', LOCAL_CONNECTION_ID);
    }
  }
  // unregister() falls registry active back to local when needed; keep the global in sync.
  const active = connectionRegistry.getActiveId() ?? LOCAL_CONNECTION_ID;
  activeConnectionId = active;
}

/**
 * Open a NEW window bound to the given connection. The window's renderer resolves its session
 * list / file tree from that connection via the per-window backend resolution. The remote keeps
 * running 24/7 independent of this window.
 */
function openWindowWithConnection(connectionId: string): BrowserWindow {
  const win = createWindow(currentAppIcon, connectionId);
  return win;
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
  // Routing info for archive/delete actions (added so the renderer + delete IPC can
  // locate each session's backing store). `sourcePath` is the agent's own session file
  // (Claude/Codex/Kiro jsonl/json) or '' for sqlite-backed agents (Copilot).
  agent: ProjectsAgentId;
  sourcePath: string;
  archived?: boolean;
};

// Internal flat record before bucketing
type DiscoveredSession = ProjectSession & {
  cwd: string; // absolute project folder (may be '' / '/' when unknown)
};

type ProjectEntry = {
  path: string;
  name: string;
  agents: Array<{ agent: ProjectsAgentId; sessions: ProjectSession[] }>;
  lastActiveMs: number;
};

const PROJECTS_MAX_SESSIONS_PER_AGENT = 50;


// Build one Claude DiscoveredSession from a jsonl file. Shared by the global
// discovery pass and the per-folder fill-in pass so both resolve titles/cwd the
// same way. `forceCwd`, when set, buckets the session under that folder regardless
// of the in-file cwd (used by the per-folder pass to bucket under the tracked folder).
function buildClaudeSessionFromFile(
  full: string,
  uuid: string,
  mtimeMs: number,
  size: number,
  forceCwd?: string,
): DiscoveredSession | null {
  try {
    // Head read: recover real cwd + first-real-user-message fallback (titles handled below).
    const head = readHead(full);
    const lines = head.split('\n');
    let cwd = '';
    let firstUserTitle = '';
    let renameTitle = '';
    let hasConversation = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { type?: string; cwd?: string; message?: { content?: unknown } };
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
      // A real transcript carries user/assistant messages. Files that hold only Claude Code's
      // sidecar records (type:"bridge-session", "queue-operation", …) are not resumable
      // sessions; without this they show as phantom "id 不存在" rows under a folder.
      if (obj.type === 'user' || obj.type === 'assistant') hasConversation = true;
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
    // Skip non-conversation stub files (no user/assistant message anywhere in the head).
    if (!hasConversation) return null;
    // Title-type lines (customTitle/agentName/aiTitle) can appear far into the file, beyond
    // the head window. Scan the whole file (or tail for huge files) to recover them.
    const title = getCachedClaudeTitle(full, mtimeMs, size, () => {
      const titleFields = findClaudeTitleFields(full, size);
      return resolveClaudeTitle(titleFields, firstUserTitle, renameTitle, uuid);
    });
    const resolvedCwd = forceCwd !== undefined ? forceCwd : (cwd ? path.resolve(cwd) : '');
    return {
      agent: 'claude',
      cwd: resolvedCwd,
      id: uuid,
      title,
      mtimeMs,
      resumeCommand: `claude --resume ${uuid}`,
      sourcePath: full,
    };
  } catch {
    return null;
  }
}

// Scan ONE folder's Claude project dir directly (~/.claude/projects/<encoded>/*.jsonl),
// newest first, up to `limit`. Used by the per-folder fill-in pass so a tracked folder's
// sessions appear even when they're older than the global newest-300 cap.
function scanClaudeSessionsForFolder(abs: string, limit: number): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  try {
    const encoded = abs.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
    if (!fs.existsSync(dir)) return [];
    const files: Array<{ full: string; uuid: string; mtimeMs: number; size: number }> = [];
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        files.push({ full, uuid: name.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* skip */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of files.slice(0, limit)) {
      const s = buildClaudeSessionFromFile(f.full, f.uuid, f.mtimeMs, f.size, abs);
      if (s) out.push(s);
    }
  } catch { /* never throw */ }
  return out;
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
      const s = buildClaudeSessionFromFile(f.full, f.uuid, f.mtimeMs, f.size);
      if (s) out.push(s);
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
        const rawTn = titleMap.get(id);
        let codexTitle: string;
        if (rawTn && !codexTitleIsDefault(rawTn, id)) {
          codexTitle = rawTn;                 // real thread_name wins
        } else {
          codexTitle = codexFirstUserPrompt(f.full);   // skips probes; '' if probe-only/empty
          if (!codexTitle) continue;          // filter out detection-probe / empty sessions
        }
        out.push({
          agent: 'codex',
          cwd: cwdRaw ? path.resolve(cwdRaw) : '',
          id,
          title: codexTitle,
          mtimeMs: f.mtimeMs,
          resumeCommand: `codex resume ${id}`,
          sourcePath: f.full,
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
          sourcePath: f.full,
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
        sourcePath: '', // sqlite-backed: delete routes by id, not a file path
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

  const archivedIds = loadArchivedSessionIds();
  const pathRemaps = loadPathRemaps();

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
      // Honor a path remap: a session whose recorded cwd matches a remap key is bucketed
      // under the NEW folder. This re-attaches historical sessions to a renamed/moved folder
      // and makes the dead old entry disappear (it no longer produces a bucket).
      const effectiveCwd = resolveRemappedCwd(s.cwd, pathRemaps);
      key = effectiveCwd;
      displayPath = effectiveCwd;
      name = path.basename(effectiveCwd) || effectiveCwd;
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
    arr.push({
      id: s.id,
      title: s.title,
      mtimeMs: s.mtimeMs,
      resumeCommand: s.resumeCommand,
      agent: s.agent,
      sourcePath: s.sourcePath,
      archived: archivedIds.has(s.id),
    });
  }

  // Ensure explicitly-added folders appear even with no sessions, and FILL IN their
  // Claude + Codex sessions via a targeted per-folder scan. The global discovery above
  // only keeps the newest 300 files GLOBALLY, so a tracked folder whose sessions are
  // older than that cap would otherwise render empty. This pass pulls that folder's own
  // sessions directly, deduping (agent + id) against anything already discovered globally.
  for (const folder of extraFolders) {
    try {
      const rawAbs = path.resolve(String(folder || ''));
      if (!rawAbs) continue;
      // If this tracked folder's path was remapped (renamed/moved), fold it into the new path
      // so we don't resurrect the dead old bucket. The per-folder scan still reads the OLD
      // on-disk location (rawAbs) where the sessions physically live.
      const abs = resolveRemappedCwd(rawAbs, pathRemaps);
      const bucket = getBucket(abs, abs, path.basename(abs) || abs);

      const mergeIntoBucket = (sessions: DiscoveredSession[]) => {
        for (const s of sessions) {
          let arr = bucket.agentMap.get(s.agent);
          if (!arr) { arr = []; bucket.agentMap.set(s.agent, arr); }
          // Dedupe by agent + id: a session already added by the global pass for this
          // bucket must not produce a duplicate row.
          if (arr.some((existing) => existing.id === s.id)) continue;
          arr.push({
            id: s.id,
            title: s.title,
            mtimeMs: s.mtimeMs,
            resumeCommand: s.resumeCommand,
            agent: s.agent,
            sourcePath: s.sourcePath,
            archived: archivedIds.has(s.id),
          });
        }
      };

      // Scan the physical on-disk session stores. After a remap, historical sessions still live
      // under the OLD path (rawAbs); the renamed folder on disk is the NEW path (abs). Scan both
      // (deduped by mergeIntoBucket) so old + new sessions all land in this single bucket.
      const scanPaths = abs === rawAbs ? [abs] : [rawAbs, abs];
      for (const scanPath of scanPaths) {
        // Claude: scan ~/.claude/projects/<encoded>/ directly, bucketed under this folder.
        mergeIntoBucket(scanClaudeSessionsForFolder(scanPath, PROJECTS_MAX_SESSIONS_PER_AGENT));

        // Codex: reuse the per-cwd reader (cwd matched from session_meta; uncapped at 300).
        const codex = listCodexSessions(scanPath);
        mergeIntoBucket(codex.slice(0, PROJECTS_MAX_SESSIONS_PER_AGENT).map((c) => ({
          agent: 'codex' as ProjectsAgentId,
          cwd: abs,
          id: c.id,
          title: c.title,
          mtimeMs: c.mtimeMs,
          resumeCommand: c.resumeCommand,
          sourcePath: c.sourcePath || '',
        })));
      }
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


/**
 * The active connection's backend IFF it is a remote one, else null. Lets navigator/file IPC
 * branch "remote vs local fs" without leaking the registry into every handler.
 */
function activeRemoteBackend(connectionId: string = activeConnectionId): RemoteServerBackend | null {
  const conn = connectionRegistry.get(connectionId);
  if (conn && conn.kind === 'remote') return conn.backend as RemoteServerBackend;
  return null;
}

/** The remote backend (or null) for the window that sent an IPC event (primary fallback). */
function remoteBackendForEvent(event?: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): RemoteServerBackend | null {
  return activeRemoteBackend(connectionIdForEvent(event));
}

/**
 * Shape a remote backend's live + resumable sessions into the SAME ProjectEntry[] the local
 * `projects:list` returns. Live sessions bucket by their reported cwd (matching local grouping);
 * resumable sessions bucket by their own cwd. Sessions with no cwd fall under one "<label>"
 * node so they stay visible + clickable (acceptable MVP per the task).
 */
async function buildRemoteProjectsList(remote: RemoteServerBackend): Promise<ProjectEntry[]> {
  const conn = connectionRegistry.get(activeConnectionId);
  const label = conn?.label || 'Remote';
  const FALLBACK_KEY = `__remote_${activeConnectionId}__`;

  const buckets = new Map<string, { path: string; name: string; agentMap: Map<ProjectsAgentId, ProjectSession[]> }>();
  const getBucket = (key: string, displayPath: string, name: string) => {
    let b = buckets.get(key);
    if (!b) { b = { path: displayPath, name, agentMap: new Map() }; buckets.set(key, b); }
    return b;
  };
  const normAgent = (a: string): ProjectsAgentId => {
    const v = (a || '').toLowerCase();
    return v === 'codex' || v === 'kiro' || v === 'copilot' ? (v as ProjectsAgentId) : 'claude';
  };
  const addSession = (cwd: string, s: ProjectSession) => {
    let key: string; let displayPath: string; let name: string;
    if (cwd) { key = cwd; displayPath = cwd; name = path.basename(cwd) || cwd; }
    else { key = FALLBACK_KEY; displayPath = ''; name = label; }
    const bucket = getBucket(key, displayPath, name);
    let arr = bucket.agentMap.get(s.agent);
    if (!arr) { arr = []; bucket.agentMap.set(s.agent, arr); }
    arr.push(s);
  };

  // Live sessions (running on the remote right now).
  try {
    await remote.refreshSessions().catch(() => undefined);
    for (const live of remote.getAllSessions()) {
      addSession(live.cwd, {
        id: live.id,
        title: live.title || live.presetCommand || 'Session',
        mtimeMs: live.createdAt || Date.now(),
        resumeCommand: live.resumeCommand || '',
        agent: normAgent(live.provider || 'claude'),
        sourcePath: '',
      });
    }
  } catch { /* ignore */ }

  // Resumable history from the remote.
  try {
    const resumable = await remote.listResumable('');
    for (const r of resumable) {
      addSession(r.cwd || '', {
        id: r.id,
        title: r.title || 'Session',
        mtimeMs: r.mtimeMs || Date.now(),
        resumeCommand: r.resumeCommand || '',
        agent: normAgent(r.agent),
        sourcePath: '',
      });
    }
  } catch { /* ignore */ }

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
  // Set window title — for the CALLING window (each window titles itself with its own host/branch).
  ipcMain.on('window:set-title', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setTitle(title);
    else if (mainWindow) mainWindow.setTitle(title);
  });

  // Create terminal
  ipcMain.handle('pty:create', async (_e, cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>, useSubscription?: boolean) => {
    const backend = backendForEvent(_e);
    // "Use my Claude subscription" (chunk F): for a REMOTE connection only, inject the
    // stored CLAUDE_CODE_OAUTH_TOKEN so the remote claude agent uses the user's Claude
    // subscription (truly 24/7, independent of the Mac). Skipped for LOCAL (the Mac already
    // has the login) and for remote-native sessions (the default — inject nothing LLM-related).
    let effectiveProviderEnv = providerEnv;
    if (useSubscription && remoteBackendForEvent(_e)) {
      const subToken = loadSubscriptionToken();
      if (subToken) {
        effectiveProviderEnv = { ...(providerEnv || {}), CLAUDE_CODE_OAUTH_TOKEN: subToken };
      }
    }
    const session = await backend.create(cwd, presetCommand, themeId, effectiveProviderEnv);
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
    await backend.setProvider(session.id, provider);
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
    await backendForEvent(_e).write(id, data);
    return true;
  });

  // Resize
  ipcMain.handle('pty:resize', async (_e, id: string, cols: number, rows: number) => {
    await backendForEvent(_e).resize(id, cols, rows, 'local');
    return true;
  });

  // Destroy terminal
  ipcMain.on('pty:destroy', async (_e, id: string) => {
    const backend = backendForEvent(_e);
    // Fallback: extract the resume ID from the buffer and save to the closed list
    await backend.captureResumeFromBuffer(id);
    const session = backend.getSession(id);
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
    await backend.destroy(id);
    sessionOutputTail.delete(id);
    sessionLastInputAt.delete(id);
    sessionArmedForNotify.delete(id);
    sessionLastNotifyAt.delete(id);
    sessionUserClosed.delete(id);
  });

  // Rename terminal
  ipcMain.on('pty:rename', (_e, id: string, title: string) => {
    backendForEvent(_e).rename(id, title).catch((error) => {
      console.error('[Main] Failed to rename PTY session:', error);
    });
  });

  // Regenerate title with AI
  ipcMain.handle('pty:regenerate-title', async (_e, id: string) => {
    await backendForEvent(_e).regenerateTitle(id);
  });

  // Get info for all sessions
  ipcMain.handle('pty:sessions', async (_e) => {
    const sessions = await backendForEvent(_e).refreshSessions();
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
  ipcMain.handle('daemon:restart', async (_e): Promise<{ ok: boolean; error?: string }> => {
    try {
      const backend = backendForEvent(_e);
      const connId = connectionIdForEvent(_e);
      // 1. Persist every live session as resumable before stopping the daemon.
      const liveSessions = backend.getAllSessions();
      for (const live of liveSessions) {
        try {
          await backend.captureResumeFromBuffer(live.id);
        } catch {
          // Best-effort: keep going even if one capture fails.
        }
        const session = backend.getSession(live.id) || live;
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
      await backend.restart();

      // 5. Tell the window(s) bound to this connection the live list is now empty so they refresh.
      sendToConnection(connId, 'daemon:restarted');
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
    // Propagate into the agent's own session file for closed Claude / Codex sessions.
    const target = sessions.find(s => s.id === id);
    const cmd = (target?.presetCommand || '').trim();
    if (target && target.resumeId) {
      if (/^claude\b/i.test(cmd)) {
        writeClaudeSessionTitle(target.resumeId, newTitle);
      } else if (/^codex\b/i.test(cmd)) {
        writeCodexSessionTitle(target.resumeId, newTitle);
      }
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

  // Create a NEW GitHub repo via the `gh` CLI and clone it locally ("Start from scratch").
  // Returns { ok, path? , error? } — never throws across IPC.
  // gh may not be on the GUI app's PATH (Electron inherits a minimal launchd env), so we probe
  // common install locations before giving up.
  ipcMain.handle(
    'project:create-github-repo',
    async (
      _e,
      opts: { name: string; visibility: 'private' | 'public'; parentDir: string }
    ): Promise<{ ok: boolean; path?: string; error?: string }> => {
      try {
        const name = String(opts?.name || '').trim();
        const visibility = opts?.visibility === 'public' ? 'public' : 'private';
        const parentDir = String(opts?.parentDir || '').trim();

        // Light validation — gh does the authoritative check, but reject obvious breakage early.
        if (!name) return { ok: false, error: 'Repository name is required' };
        if (/[\s/\\]/.test(name)) {
          return { ok: false, error: 'Repository name cannot contain spaces or slashes' };
        }
        if (!parentDir || !fs.existsSync(parentDir)) {
          return { ok: false, error: 'Parent folder does not exist' };
        }
        const clonePath = path.join(parentDir, name);
        if (fs.existsSync(clonePath)) {
          return { ok: false, error: `"${name}" already exists in this folder` };
        }

        // Resolve the gh binary: rely on PATH first, then common Homebrew locations.
        const ghCandidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
        const ghBin = ghCandidates.find((c) => c === 'gh' || fs.existsSync(c));
        if (!ghBin) {
          return { ok: false, error: 'gh CLI not found — install GitHub CLI' };
        }

        const { execFile } = require('child_process') as typeof import('child_process');
        const result = await new Promise<{ ok: boolean; path?: string; error?: string }>(
          (resolve) => {
            execFile(
              ghBin,
              ['repo', 'create', name, `--${visibility}`, '--clone'],
              { cwd: parentDir, timeout: 60000, windowsHide: true },
              (err, _stdout, stderr) => {
                if (err) {
                  // gh exits non-zero on auth failure / name conflict / etc. Surface its message
                  // so the UI can show hints like "run gh auth login".
                  const msg = String(stderr || (err as Error).message || '').trim();
                  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    return resolve({ ok: false, error: 'gh CLI not found — install GitHub CLI' });
                  }
                  return resolve({ ok: false, error: msg || 'gh repo create failed' });
                }
                resolve({ ok: true });
              }
            );
          }
        );
        if (!result.ok) return result;

        if (!fs.existsSync(clonePath)) {
          return { ok: false, error: 'Repo created but clone not found locally' };
        }
        return { ok: true, path: clonePath };
      } catch (e) {
        return { ok: false, error: (e as Error).message || 'Failed to create repository' };
      }
    }
  );

  // List SSH hosts from ~/.ssh/config (Phase 1: SSH terminal host picker).
  // Returns connectable Host aliases (wildcard-only patterns excluded). HostName/User
  // are display-only hints. Never throws across IPC: returns [] on any failure.
  ipcMain.handle('ssh:list-hosts', () => {
    return listSshHosts();
  });

  // Read directory (left-side file tree)
  ipcMain.handle('file-tree:list-dir', async (_e, dirPath: string) => {
    const remote = remoteBackendForEvent(_e);
    if (remote) {
      try { return await remote.fsList(String(dirPath || '')); } catch { return []; }
    }
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

  // Move a file/folder to the OS trash (recoverable). Used by the file-tree context menu.
  ipcMain.handle('file-tree:trash', async (_e, targetPath: string) => {
    try {
      if (typeof targetPath !== 'string' || !targetPath.trim()) {
        return { ok: false, error: 'invalid-path' };
      }
      const abs = path.resolve(targetPath);
      await shell.trashItem(abs);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Read file contents for the right-side preview panel (read-only, with size/binary guards)
  ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
    const remote = remoteBackendForEvent(_e);
    if (remote) return remote.fsRead(String(filePath || ''));
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

  // Write a text file (utf8) for the in-app editable preview. Never throws across IPC.
  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) => {
    const remote = remoteBackendForEvent(_e);
    if (remote) {
      if (typeof filePath !== 'string' || filePath.trim() === '') return { ok: false, error: 'invalid-path' };
      if (typeof content !== 'string') return { ok: false, error: 'invalid-content' };
      return remote.fsWrite(filePath, content);
    }
    try {
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return { ok: false, error: 'invalid-path' };
      }
      if (typeof content !== 'string') {
        return { ok: false, error: 'invalid-content' };
      }
      const abs = path.resolve(filePath);
      fs.writeFileSync(abs, content, 'utf-8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Resolve the git branch for a cwd (for the macOS window title). Fast + cheap.
  // Returns the branch name string, or '' for: empty/non-string cwd, not a git repo,
  // detached HEAD (git prints 'HEAD'), or any error. Never throws across IPC.
  ipcMain.handle('git:branch', async (_e, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.trim() === '') return '';
    try {
      const { execFile } = require('child_process') as typeof import('child_process');
      const branch = await new Promise<string>((resolve) => {
        execFile(
          'git',
          ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { timeout: 2000, windowsHide: true },
          (err, stdout) => {
            if (err) return resolve('');
            resolve(String(stdout || '').trim());
          }
        );
      });
      // Detached HEAD reports 'HEAD' — treat as no branch name.
      return branch === 'HEAD' ? '' : branch;
    } catch {
      return '';
    }
  });

  // Read a file as a base64 data URL (for image previews). Never throws.
  ipcMain.handle('fs:read-file-base64', async (_e, filePath: string) => {
    const remote = remoteBackendForEvent(_e);
    if (remote) return remote.fsReadBase64(String(filePath || ''));
    const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16MB cap
    try {
      const abs = path.resolve(String(filePath || ''));
      const st = fs.statSync(abs);
      if (!st.isFile()) return { ok: false, error: 'not-a-file' };
      if (st.size > MAX_IMAGE_BYTES) return { ok: false, error: 'too-large', size: st.size };
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mimeByExt: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
      };
      const mime = mimeByExt[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(abs);
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, ext };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // List a directory's native session history in Claude Code (~/.claude/projects/<encoded>/<uuid>.jsonl)
  ipcMain.handle('claude-sessions:list', (_e, cwd: string) => listResumableSessions(cwd));

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

  // Projects-first discovery: bucket every AI-CLI session by project folder.
  // LOCAL active connection -> scan local AI-CLI stores (unchanged). REMOTE active connection ->
  // fetch the remote's live + resumable sessions and shape them into the same ProjectEntry[] so
  // the renderer's navigator renders them unchanged (see buildRemoteProjectsList()).
  ipcMain.handle('projects:list', async (_e, opts?: { extraFolders?: string[] }) => {
    try {
      const remote = remoteBackendForEvent(_e);
      if (remote) return await buildRemoteProjectsList(remote);
      return buildProjectsList(opts?.extraFolders ?? []);
    } catch {
      return [];
    }
  });

  // Archive (soft-hide, reversible, does NOT touch agent data).
  // ========== Connection registry (D2: add/switch remote hosts) ==========
  // All wrapped to never throw across IPC.
  // `active` is reported relative to the CALLING window's binding, so each window's host switcher
  // highlights the host THAT window is viewing (not a single global active host).
  ipcMain.handle('connections:list', (event) => {
    try {
      const boundId = connectionIdForEvent(event);
      return connectionRegistry.list().map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        active: c.id === boundId,
      }));
    } catch {
      return [{ id: LOCAL_CONNECTION_ID, label: 'Local', kind: 'local', active: true }];
    }
  });

  ipcMain.handle('connections:add', async (event, opts: { label?: string; baseUrl?: string; token?: string }) => {
    try {
      const { id, label } = await addRemoteConnection({
        label: String(opts?.label || ''),
        baseUrl: String(opts?.baseUrl || ''),
        token: String(opts?.token || ''),
      });
      // Bind the CALLING window to the newly added host (in-place switch).
      bindConnectionToWindow(id, BrowserWindow.fromWebContents(event.sender));
      return { ok: true, id, label };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Bootstrap a remote SSH host: deploy + start the headless backend, then connect to it.
  // Reuses addRemoteConnection so the resulting connection behaves identically to a manual add.
  ipcMain.handle('connections:bootstrap-ssh-host', async (event, host: string) => {
    try {
      const sshHost = String(host || '').trim();
      if (!sshHost) return { ok: false, error: 'ssh host is required' };
      const { baseUrl, token } = await bootstrapRemoteHost(sshHost);
      const { id, label } = await addRemoteConnection({ label: sshHost, baseUrl, token });
      bindConnectionToWindow(id, BrowserWindow.fromWebContents(event.sender));
      return { ok: true, id, label, baseUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('connections:remove', (_e, id: string) => {
    try {
      removeConnection(String(id || ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Bind the CALLING window to a connection (the in-window host switch). Replaces the global
  // "set active" for that window; other windows keep their own binding untouched.
  ipcMain.handle('connections:bind-window', (event, id: string) => {
    try {
      const target = String(id || '');
      if (!connectionRegistry.get(target)) return { ok: false, error: 'no-such-connection' };
      bindConnectionToWindow(target, BrowserWindow.fromWebContents(event.sender));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Back-compat alias: behaves like bind-window (binds the calling window).
  ipcMain.handle('connections:set-active', (event, id: string) => {
    try {
      const target = String(id || '');
      if (!connectionRegistry.get(target)) return { ok: false, error: 'no-such-connection' };
      bindConnectionToWindow(target, BrowserWindow.fromWebContents(event.sender));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Open a NEW window bound to the given connection ("open host in new window"). The remote keeps
  // running 24/7; the new window resolves its sessions/file tree from that connection.
  ipcMain.handle('window:open-with-connection', (_e, id: string) => {
    try {
      const target = String(id || '') || LOCAL_CONNECTION_ID;
      if (!connectionRegistry.get(target)) return { ok: false, error: 'no-such-connection' };
      openWindowWithConnection(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Claude subscription OAuth token (chunk F: "use my subscription" for remote agents).
  // status returns ONLY { set, maskedSuffix } — never the full token to the renderer.
  ipcMain.handle('subscription-token:status', () => {
    return subscriptionTokenStatus();
  });

  ipcMain.handle('subscription-token:set', (_e, token: string) => {
    const trimmed = String(token || '').trim();
    if (!trimmed) return { ok: false, error: 'empty-token' };
    try {
      saveSubscriptionToken(trimmed);
      return { ok: true, status: subscriptionTokenStatus() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('subscription-token:clear', () => {
    try {
      clearSubscriptionToken();
      return { ok: true, status: subscriptionTokenStatus() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('session:set-archived', (_e, id: string, archived: boolean) => {
    try {
      setSessionArchived(id, !!archived);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // List currently-archived session ids (for renderer filtering on demand).
  ipcMain.handle('session:list-archived', () => {
    try { return [...loadArchivedSessionIds()]; } catch { return []; }
  });

  // PERMANENT delete: routes to the agent's own backing store. Never throws.
  ipcMain.handle('session:delete', (_e, meta: { id: string; agent: string; sourcePath?: string }) => {
    try {
      const id = String(meta?.id || '');
      const agent = String(meta?.agent || '');
      const sourcePath = String(meta?.sourcePath || '');
      const result = deleteSessionFromStore(agent, id, sourcePath);
      // Once the source is gone, drop any stale archived flag for that id.
      if (result.ok) { try { setSessionArchived(id, false); } catch { /* ignore */ } }
      return result;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('remote:add-recent-cwd', (_e, cwd: string) => {
    try { addRemoteRecentCwd(cwd); } catch { /* ignore */ }
    return true;
  });

  // ========== Project path remap (renamed/moved folder → re-attach historical sessions) ==========
  ipcMain.handle('project:remap', (_e, oldPath: string, newPath: string) => {
    try {
      setPathRemap(String(oldPath || ''), String(newPath || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('project:remaps:list', () => {
    try { return loadPathRemaps(); } catch { return {}; }
  });

  ipcMain.handle('project:remap:remove', (_e, oldPath: string) => {
    try {
      removePathRemap(String(oldPath || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
  ipcMain.handle('app:get-build-info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    sha: buildStamp.sha,
    branch: buildStamp.branch,
    dirty: buildStamp.dirty,
    builtAt: buildStamp.builtAt,
  }));
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

// Auto-update via electron-updater. Reads the GitHub Releases channel files
// (latest-mac.yml / latest.yml) configured in electron-builder.yml's `publish`.
//
// IMPORTANT CAVEAT — macOS signing requirement:
// macOS auto-update (Squirrel.Mac) REQUIRES the app to be code-signed AND
// notarized. An UNSIGNED build (the current state — no certs configured) will
// download the update, but the relaunch fails / Gatekeeper blocks it, so the
// update does not actually apply on mac. The wiring below is correct and is a
// no-op-safe in that case; mac auto-update only becomes functional once
// signing + notarization is set up. Windows (NSIS) auto-update does not need
// signing to function (users just see a SmartScreen prompt).
function initAutoUpdater(): void {
  // Only in packaged builds — dev runs have no release artifacts to update to.
  if (!app.isPackaged) {
    return;
  }
  try {
    autoUpdater.logger = {
      info: (...args: unknown[]) => console.log('[AutoUpdate]', ...args),
      warn: (...args: unknown[]) => console.warn('[AutoUpdate]', ...args),
      error: (...args: unknown[]) => console.error('[AutoUpdate]', ...args),
      debug: () => {},
    } as unknown as typeof autoUpdater.logger;
    // Downloads the update (if any) and notifies the user; never throws into
    // startup — wrapped in try/catch + .catch() so a missing release / offline
    // machine cannot crash or block app launch.
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[AutoUpdate] check failed:', err);
    });
  } catch (err) {
    console.warn('[AutoUpdate] init failed:', err);
  }
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

  // Check for app updates (packaged builds only; never blocks/crashes startup).
  initAutoUpdater();

  // Start the remote-access server (mobile)
  setAppVersionProvider(() => app.getVersion());
  // The mobile remote-server always serves the LOCAL connection's sessions.
  startRemoteServer(connectionRegistry.local().backend, (sessionInfo) => {
    // The mobile client created a LOCAL session; notify only local-bound desktop windows.
    sendToConnection(LOCAL_CONNECTION_ID, 'pty:remote-created', sessionInfo);
  }, (id) => {
    // The mobile client destroyed a LOCAL session; notify only local-bound desktop windows.
    sendToConnection(LOCAL_CONNECTION_ID, 'pty:exit', id);
  }, (info) => {
    // After the server starts, send the connection info to the renderer for display
    const tunnel = cloudflaredManager?.start();
    const ts = getTailscaleInfo();
    const tailscaleUrl = ts && ts.dnsName ? `https://${ts.dnsName}` : null;
    // Stable Tailscale address: http://<100.x>:<port> (WireGuard-encrypted underneath).
    // Preferred over the dynamic LAN IP and does not depend on `tailscale serve` https.
    const tailscaleHttpUrl = ts && ts.ip ? `http://${ts.ip}:${info.port}` : null;
    const serverInfo: RemoteServerInfoWithTunnel = {
      ...info,
      connectedClients: trayState.connectedClients,
      subscribedSessions: trayState.subscribedSessions,
      publicUrl: tunnel?.url || undefined,
      tunnel,
      tailscaleUrl,
      tailscaleHttpUrl,
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
  }, listResumableSessions);

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
