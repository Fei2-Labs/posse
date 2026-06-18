import { TerminalManager } from './terminal-manager';
import { ChatView } from './chat-view';
import { createFilePreview, type FilePreview } from './file-preview';
import QRCode from 'qrcode';

let remoteServerInfo: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string }; tailscaleUrl?: string | null } | null = null;

// Inline Lucide-style monochrome icons (16px, stroke=currentColor). Set via innerHTML on buttons.
const ICON: Record<string, string> = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5v14"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

type OpenEditorResult = { ok: true } | { ok: false; error: string };

type PtySessionInfo = {
  id: string;
  title: string;
  themeId: string;
  cwd: string;
  displayName: string;
  provider?: string | null;
  rawBuffer?: string;
  agentSessionId?: string | null;
  resumeId?: string | null;
};

declare global {
  interface Window {
    posse: {
      setWindowTitle: (title: string) => void;
      createPty: (cwd: string, presetCommand: string, themeId: string) => Promise<PtySessionInfo>;
      writePty: (id: string, data: string) => void;
      resizePty: (id: string, cols: number, rows: number) => void;
      destroyPty: (id: string) => void;
      renamePty: (id: string, title: string) => void;
      regenerateTitle: (id: string) => Promise<void>;
      getSessions: () => Promise<PtySessionInfo[]>;
      daemonRestart: () => Promise<{ ok: boolean; error?: string }>;
      selectFolder: (currentPath?: string) => Promise<string | null>;
      fileTreeListDir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
      readFile: (filePath: string) => Promise<{ ok: boolean; content?: string; size?: number; ext?: string; error?: string }>;
      claudeSessionsList: (cwd: string) => Promise<Array<{ id: string; title: string; cwd: string; mtimeMs: number; agent: 'claude' | 'codex'; resumeCommand: string }>>;
      projectsList: (extra?: { extraFolders?: string[] }) => Promise<Array<{
        path: string;
        name: string;
        agents: Array<{
          agent: 'claude' | 'codex' | 'kiro' | 'copilot';
          sessions: Array<{ id: string; title: string; mtimeMs: number; resumeCommand: string }>;
        }>;
        lastActiveMs: number;
      }>>;
      remoteAddRecentCwd: (cwd: string) => Promise<boolean>;
      verifyResumable: (agent: string, cwd: string, sessionId: string) => Promise<{ exists: boolean }>;
      onPtyData: (cb: (id: string, data: string) => void) => void;
      onTitleUpdate: (cb: (id: string, title: string) => void) => void;
      onPtyExit: (cb: (id: string) => void) => void;
      onDaemonRestarted: (cb: () => void) => void;
      onRemoteCreated: (cb: (sessionInfo: PtySessionInfo) => void) => void;
      onRemoteServerInfo: (cb: (info: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string }; tailscaleUrl?: string | null }) => void) => void;
      getRemoteServerInfo: () => Promise<{ lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string }; tailscaleUrl?: string | null } | null>;
      clipboardSaveImage: () => Promise<string | null>;
      clipboardGetFilePath: () => Promise<string | null>;
      // File watcher API
      filewatcherStart: (cwd: string) => Promise<void>;
      filewatcherStop: () => Promise<void>;
      filewatcherOpen: (filePath: string) => Promise<OpenEditorResult>;
      filewatcherSelectEditor: () => Promise<string | null>;
      filewatcherGetEditor: () => Promise<string | null>;
      openFolder: (folderPath: string) => Promise<void>;
      openUrl: (url: string) => Promise<void>;
      getAppVersion: () => Promise<string>;
      getBuildInfo: () => Promise<{ version: string; packaged: boolean; sha: string; branch: string; dirty: boolean; builtAt: string }>;
      getTerminalClientUrl: () => Promise<string>;
      onFileChange: (cb: (filename: string, eventType: string) => void) => void;
      // AI config API
      aiApplyConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => Promise<boolean>;
      aiTestConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => Promise<{ ok: boolean; error?: string; response?: string }>;
      aiGetCurrentConfig: () => Promise<{ apiFormat: string; baseUrl: string; apiKey: string; model: string; providerId: string | null } | null>;
      getCliProvider: (presetCommand: string) => Promise<string | null>;
      // Claude provider config
      claudeProvidersList: () => Promise<Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>>;
      claudeProvidersSave: (providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model?: string }>) => Promise<boolean>;
      // Devin account management
      devinAccountsList: () => Promise<{ accounts: Array<{ email: string; enabled: boolean; addedAt: number; lastLogin?: string; lastError?: string; quota?: { daily: number; weekly: number }; planName?: string; lastSwitchAt?: number }>; currentIndex: number }>;
      devinAccountsAdd: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
      devinAccountsAddBatch: (text: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
      devinAccountsRemove: (email: string) => Promise<{ ok: boolean; error?: string }>;
      devinAccountsSwitch: (opts: { email?: string; next?: boolean }) => Promise<{ ok: boolean; error?: string; email?: string; quota?: { daily: number; weekly: number } }>;
      devinAccountsQuota: () => Promise<{ ok: boolean; daily?: number; weekly?: number; planName?: string; error?: string }>;
      devinAccountsQuotaAll: () => Promise<{ ok: boolean; results?: Array<{ email: string; ok: boolean; quota?: { daily: number; weekly: number; planName?: string }; error?: string }>; error?: string }>;
      devinAccountsQuotaOne: (email: string) => Promise<{ ok: boolean; daily?: number; weekly?: number; planName?: string; error?: string }>;
      devinAccountsRotateDevice: () => Promise<{ ok: boolean }>;
      // File operations
      openFile: (filePath: string) => Promise<void>;
      readDirectory: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
      // Session status sync
      syncSessionStatus: (statuses: Record<string, string>) => void;
      // Auto-continue config relay
      onGetAutoContinueConfig: (cb: (sessionId: string) => void) => void;
      sendAutoContinueConfig: (sessionId: string, config: any) => void;
      onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) => void;
      // Chat API
      chatCreate: (opts: { workspace: string; model?: string }) => Promise<{ id: string; title: string; model: string; workspace: string; createdAt: number } | null>;
      chatSend: (sessionId: string, content: string) => Promise<void>;
      chatList: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; createdAt: number; messageCount: number }>>;
      chatMessages: (sessionId: string) => Promise<Array<{ role: string; content: string; timestamp: number }>>;
      chatDestroy: (sessionId: string) => Promise<boolean>;
      chatAbort: (sessionId: string) => Promise<boolean>;
      chatRename: (sessionId: string, title: string) => Promise<boolean>;
      chatHealth: () => Promise<{ ok: boolean; error?: string }>;
      chatModels: () => Promise<Array<{ id: string; credits: string }>>;
      onChatDelta: (cb: (sessionId: string, text: string) => void) => void;
      onChatDone: (cb: (sessionId: string, content: string) => void) => void;
      onChatError: (cb: (sessionId: string, error: string) => void) => void;
      onChatTitleUpdate: (cb: (sessionId: string, title: string) => void) => void;
      // Closed sessions
      closedSessionsList: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsRemove: (id: string) => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsRename: (id: string, title: string) => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      closedSessionsClear: () => Promise<Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>>;
      onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>) => void) => void;
      // Closed chat sessions
      closedChatList: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      closedChatRemove: (id: string) => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      closedChatClear: () => Promise<Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>>;
      chatRestore: (closedId: string) => Promise<{ id: string; title: string; model: string; workspace: string; createdAt: number } | null>;
      onClosedChatUpdate: (cb: (sessions: Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>) => void) => void;
      // Auto account-switch status
      onAutoSwitchStatus: (cb: (id: string, status: string, detail?: string) => void) => void;
      onCloseCurrentSession: (cb: () => void) => void;
    };
  }
}

// State
const savedCwd = localStorage.getItem('posse_cwd') || '';
let currentCwd = savedCwd;
let lastPreset = localStorage.getItem('posse_preset') || '';
const sessionTitles: Map<string, string> = new Map();
const sessionThemes: Map<string, string> = new Map();
const sessionUpdateTimes: Map<string, number> = new Map();
const sessionCreateTimes: Map<string, number> = new Map();
// Session working directory
const sessionCwds: Map<string, string> = new Map();
// Session display name (e.g. Claude auto, Codex)
const sessionDisplayNames: Map<string, string> = new Map();
// Actual model provider used by the session (e.g. MiniMax, GLM, Anthropic)
const sessionProviders: Map<string, string> = new Map();
// Live PTY -> the agent's on-disk session id (uuid). Used to dedup a live session against its
// on-disk history row, and to focus (not duplicate) an already-open session on resume.
const sessionAgentId: Map<string, string> = new Map();
// Live PTY -> the agent session uuid used as the canonical dedup key across the three session
// sources (live / closed / on-disk history). Mirrors sessionAgentId but kept separately so the
// dedup survives an app reload even if sessionAgentId is repopulated lazily.
const sessionResumeId: Map<string, string> = new Map();
// Custom provider ID used by each session (to restore selection when switching terminals)
const sessionClaudeProviderIds: Map<string, string> = new Map();

// ========== Chat session state ==========
const chatViews: Map<string, ChatView> = new Map();
const chatSessionTitles: Map<string, string> = new Map(); // chat session id → title
const chatSessionCreateTimes: Map<string, number> = new Map();
let activeChatId: string | null = null;

// ========== Closed sessions (resumable) ==========
interface ClosedSessionInfo {
  id: string;
  title: string;
  cwd: string;
  presetCommand: string;
  resumeId: string;
  resumeCommand: string;
  displayName: string;
  closedAt: number;
}
let closedSessions: ClosedSessionInfo[] = [];
let closedSessionsCollapsed = false;

// Native agent session history (Claude / Codex) for the currently opened directory
type ClaudeHistorySession = { id: string; title: string; cwd: string; mtimeMs: number; agent: 'claude' | 'codex'; resumeCommand: string };
let claudeHistorySessions: ClaudeHistorySession[] = [];
let claudeHistoryCollapsed = false;
let claudeHistoryCwd = '';
// Canonical keys of history sessions confirmed gone (resume → not-found). The backend
// projects:list still lists them until the agent prunes its on-disk index, so suppress
// them in collectProjectSessions so the dead row does not reappear on the next render.
const removedHistoryKeys = new Set<string>();

// ========== Project navigator (Codex-style) ==========
interface ProjectEntry {
  path: string;
  pinned: boolean;
  addedAt: number;
  name?: string; // optional display-name override
}
const PROJECTS_STORAGE_KEY = 'posse_projects';
let projects: ProjectEntry[] = loadProjects();

// ========== Projects panel sort + search (Codex-style toolbar) ==========
type ProjectSortMode = 'recent' | 'name';
const PROJECT_SORT_STORAGE_KEY = 'posse_project_sort';
function loadProjectSort(): ProjectSortMode {
  const raw = localStorage.getItem(PROJECT_SORT_STORAGE_KEY);
  return raw === 'name' ? 'name' : 'recent';
}
let projectSortMode: ProjectSortMode = loadProjectSort();
// Live, lower-cased search query. Empty => no filtering, persisted collapse state is honored.
let projectSearchQuery = '';

// UI expand/collapse state (persisted to localStorage). DEFAULT for a never-touched project or
// agent group is COLLAPSED: a project/group is only open if its key is present in the matching
// "expanded" set. expandedProjects key = normalized project path; expandedAgentGroups key =
// `${normPath}::${agentFamily}`.
const EXPAND_STATE_STORAGE_KEY = 'posse_expand_state';
const expandedProjects: Set<string> = new Set();
const expandedAgentGroups: Set<string> = new Set();
let projectsSectionCollapsed = false;

function loadExpandState(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPAND_STATE_STORAGE_KEY) || '{}');
    if (raw && Array.isArray(raw.projects)) for (const k of raw.projects) expandedProjects.add(String(k));
    if (raw && Array.isArray(raw.agentGroups)) for (const k of raw.agentGroups) expandedAgentGroups.add(String(k));
  } catch {
    /* ignore corrupt state */
  }
}

function saveExpandState(): void {
  try {
    localStorage.setItem(EXPAND_STATE_STORAGE_KEY, JSON.stringify({
      projects: Array.from(expandedProjects),
      agentGroups: Array.from(expandedAgentGroups),
    }));
  } catch {
    /* ignore quota errors */
  }
}

loadExpandState();

function setProjectExpanded(key: string, expanded: boolean): void {
  if (expanded) expandedProjects.add(key);
  else expandedProjects.delete(key);
  saveExpandState();
}

function setAgentGroupExpanded(groupKey: string, expanded: boolean): void {
  if (expanded) expandedAgentGroups.add(groupKey);
  else expandedAgentGroups.delete(groupKey);
  saveExpandState();
}

// Currently selected project (drives the RIGHT file panel root + highlight). Independent of the
// active terminal session: selecting a project switches the file tree even with no session open.
let selectedProjectPath: string | null = null;

// ========== Multi-agent project history (backend projects:list) ==========
// Backend-discovered, multi-agent (Claude/Codex/Kiro/Copilot) session history keyed by normalized
// project path. Loaded via window.posse.projectsList({ extraFolders }) — see refreshProjectsData().
type ProjectsAgentId = 'claude' | 'codex' | 'kiro' | 'copilot';
interface BackendProjectSession { id: string; title: string; mtimeMs: number; resumeCommand: string }
interface BackendProjectAgent { agent: ProjectsAgentId; sessions: BackendProjectSession[] }
interface BackendProject { path: string; name: string; agents: BackendProjectAgent[]; lastActiveMs: number }

// Normalized-path -> backend project record (merged with user-added folders in refreshProjectsData)
const backendProjects: Map<string, BackendProject> = new Map();
let projectsDataLoading = false;

// Display label per backend agent id
const AGENT_ID_LABEL: Record<ProjectsAgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kiro: 'Kiro',
  copilot: 'Copilot',
};

// Fetch the multi-agent project list from the backend, merging in the user's added folders so they
// always appear, then refresh the navigator. Also ensures every discovered folder with sessions
// shows up in the navigator even if the user never explicitly added it.
// Pull the latest live-session snapshots and refresh the live PTY -> agent-session-id map.
// The daemon resolves agentSessionId asynchronously (a short disk scan after spawn), so a freshly
// created session may only gain its id on a later refresh. Keeping this map current is what lets
// collectProjectSessions() dedup the on-disk history row for a session that is already open.
async function syncSessionAgentIds(): Promise<void> {
  try {
    const sessions = await window.posse.getSessions();
    for (const s of sessions) {
      // Resumed sessions keep agentSessionId empty (the post-spawn scan finds no NEW
      // file) but DO carry resumeId — fall back to it so dedup still matches.
      const uuid = s.agentSessionId || s.resumeId;
      if (uuid) {
        sessionAgentId.set(s.id, uuid);
        sessionResumeId.set(s.id, uuid);
      }
    }
  } catch {
    /* ignore — best effort */
  }
}

async function refreshProjectsData(): Promise<void> {
  if (projectsDataLoading) return;
  projectsDataLoading = true;
  try {
    await syncSessionAgentIds();
    const extraFolders = projects.map(p => p.path);
    const list = await window.posse.projectsList({ extraFolders });
    backendProjects.clear();
    for (const proj of list) {
      backendProjects.set(normalizeCwd(proj.path), proj as BackendProject);
      // Auto-register discovered folders (with a real path) so they render in the Projects list.
      if (proj.path && !findProject(proj.path)) {
        projects.push({ path: proj.path, pinned: false, addedAt: proj.lastActiveMs || Date.now() });
      }
    }
    saveProjects();
  } catch (err) {
    console.error('projects:list failed', err);
  } finally {
    projectsDataLoading = false;
    renderSessionList();
  }
}

function loadProjects(): ProjectEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p: any) => p && typeof p.path === 'string')
      .map((p: any) => ({
        path: p.path,
        pinned: Boolean(p.pinned),
        addedAt: typeof p.addedAt === 'number' ? p.addedAt : Date.now(),
        name: typeof p.name === 'string' ? p.name : undefined,
      }));
  } catch {
    return [];
  }
}

function saveProjects(): void {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
}

function findProject(path: string): ProjectEntry | undefined {
  const key = normalizeCwd(path);
  return projects.find(p => normalizeCwd(p.path) === key);
}

function addProject(path: string): void {
  if (!path) return;
  if (findProject(path)) {
    // Already exists: just expand it
    setProjectExpanded(normalizeCwd(path), true);
    renderSessionList();
    return;
  }
  projects.push({ path, pinned: false, addedAt: Date.now() });
  setProjectExpanded(normalizeCwd(path), true);
  saveProjects();
  renderSessionList();
}

function removeProject(path: string): void {
  const key = normalizeCwd(path);
  projects = projects.filter(p => normalizeCwd(p.path) !== key);
  setProjectExpanded(key, false);
  if (selectedProjectPath && normalizeCwd(selectedProjectPath) === key) {
    selectedProjectPath = null;
    updateSessionTitleBar();
    void renderFileTree();
  }
  saveProjects();
  renderSessionList();
}

function togglePinProject(path: string): void {
  const p = findProject(path);
  if (!p) return;
  p.pinned = !p.pinned;
  saveProjects();
  renderSessionList();
}

function renameProject(path: string): void {
  const p = findProject(path);
  if (!p) return;
  const next = window.prompt('Project name', p.name || cwdShortName(p.path));
  if (next === null) return;
  const trimmed = next.trim();
  p.name = trimmed || undefined;
  saveProjects();
  renderSessionList();
}

function projectDisplayName(p: ProjectEntry): string {
  return p.name || cwdShortName(p.path);
}

// Most-recent activity for a project (ms): backend lastActiveMs, else any matching live/closed
// session time, else the time the project was added. Used by the "Recent" sort.
function projectLastActiveMs(p: ProjectEntry): number {
  const key = normalizeCwd(p.path);
  let latest = backendProjects.get(key)?.lastActiveMs || 0;
  for (const id of sessionTitles.keys()) {
    if (normalizeCwd(sessionCwds.get(id) || '') === key) {
      latest = Math.max(latest, sessionUpdateTimes.get(id) || 0);
    }
  }
  for (const cs of closedSessions) {
    if (normalizeCwd(cs.cwd || '') === key) latest = Math.max(latest, cs.closedAt || 0);
  }
  return latest || p.addedAt || 0;
}

// Sort a project list per the current toolbar mode (returns a new array).
function sortProjects(list: ProjectEntry[]): ProjectEntry[] {
  const arr = list.slice();
  if (projectSortMode === 'name') {
    arr.sort((a, b) =>
      projectDisplayName(a).toLowerCase().localeCompare(projectDisplayName(b).toLowerCase())
    );
  } else {
    arr.sort((a, b) => projectLastActiveMs(b) - projectLastActiveMs(a));
  }
  return arr;
}

// Does a project match the active search query (by project name OR any session title)?
function projectMatchesSearch(p: ProjectEntry): boolean {
  const q = projectSearchQuery;
  if (!q) return true;
  if (projectDisplayName(p).toLowerCase().includes(q)) return true;
  const groups = collectProjectSessions(p.path);
  for (const g of groups.values()) {
    for (const id of g.lives) {
      if ((sessionTitles.get(id) || '').toLowerCase().includes(q)) return true;
    }
    for (const cs of g.closed) {
      if ((cs.title || cs.displayName || '').toLowerCase().includes(q)) return true;
    }
    for (const s of g.history) {
      if ((s.title || '').toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

// Does a specific agent group contain a session title matching the query?
function agentGroupMatchesSearch(g: ProjectAgentGroup): boolean {
  const q = projectSearchQuery;
  if (!q) return false;
  for (const id of g.lives) if ((sessionTitles.get(id) || '').toLowerCase().includes(q)) return true;
  for (const cs of g.closed) if ((cs.title || cs.displayName || '').toLowerCase().includes(q)) return true;
  for (const s of g.history) if ((s.title || '').toLowerCase().includes(q)) return true;
  return false;
}

// Map a session displayName / preset family to a coarse agent group label
function agentFamilyFromDisplayName(displayName: string): string {
  const d = (displayName || '').toLowerCase();
  if (d.includes('claude')) return 'Claude';
  if (d.includes('codex')) return 'Codex';
  if (d.includes('copilot')) return 'Copilot';
  if (d.includes('kiro')) return 'Kiro';
  if (d.includes('devin')) return 'Devin';
  if (d.includes('opencode')) return 'OpenCode';
  if (!displayName) return 'Terminal';
  return displayName;
}

// Compact relative time: <n>m / <n>h / <n>d / <n>w
function relativeTimeShort(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  return `${wk}w`;
}

// ========== Closed chat sessions (resumable) ==========
interface ClosedChatSessionInfo {
  id: string;
  title: string;
  model: string;
  workspace: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  closedAt: number;
}
let closedChatSessions: ClosedChatSessionInfo[] = [];

// Auto account-switch status: sessionId → { status, detail }
const sessionAutoSwitchStatus: Map<string, { status: string; detail?: string }> = new Map();

// Auto-continue config
const sessionAutoContinue: Map<string, { enabled: boolean; messages: string[]; intervalMs: number; commandIntervalMs: number; lastSendTime: number; autoAgree: boolean; autoAgreeDelaySec: number; sendDelaySec: number; maxDurationMs: number; enabledAt: number }> = new Map();
const AUTO_CONTINUE_DEFAULT_MESSAGES = ['continue'];
const AUTO_CONTINUE_DEFAULT_INTERVAL = 10 * 60 * 1000; // 10 minutes
const AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL = 2000; // 2-second command interval
const AUTO_AGREE_DEFAULT_DELAY_SEC = 5; // auto-approve default delay: 5 seconds
const AUTO_CONTINUE_SEND_DELAY_SEC = 2; // default delay before sending Enter: 2 seconds
const AUTO_CONTINUE_DEFAULT_MAX_DURATION = 0; // 0 means no limit
const AUTO_CONTINUE_STORAGE_KEY = 'posse_auto_continue';

function hasSessionInUI(sessionId: string): boolean {
  return sessionTitles.has(sessionId);
}

function getSessionCreateTime(id: string): number {
  const exists = sessionCreateTimes.get(id);
  if (exists != null) return exists;
  const fallback = sessionUpdateTimes.get(id) || Date.now();
  sessionCreateTimes.set(id, fallback);
  return fallback;
}

// Persist auto-continue config to localStorage
function saveAutoContinueToStorage(): void {
  const data: Record<string, any> = {};
  sessionAutoContinue.forEach((config, sessionId) => {
    // lastSendTime / enabledAt are runtime state, not persisted
    data[sessionId] = {
      enabled: config.enabled,
      messages: config.messages,
      intervalMs: config.intervalMs,
      commandIntervalMs: config.commandIntervalMs,
      autoAgree: config.autoAgree,
      autoAgreeDelaySec: config.autoAgreeDelaySec,
      sendDelaySec: config.sendDelaySec,
      maxDurationMs: config.maxDurationMs,
    };
  });
  localStorage.setItem(AUTO_CONTINUE_STORAGE_KEY, JSON.stringify(data));
}

// Restore auto-continue config from localStorage
function loadAutoContinueFromStorage(): void {
  try {
    const raw = localStorage.getItem(AUTO_CONTINUE_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, any>;
    for (const [sessionId, config] of Object.entries(data)) {
      // Migrate legacy message → messages
      const msgs = Array.isArray(config.messages)
        ? config.messages
        : (config.message ? [config.message] : [...AUTO_CONTINUE_DEFAULT_MESSAGES]);
      sessionAutoContinue.set(sessionId, {
        enabled: config.enabled ?? false,
        messages: msgs,
        intervalMs: config.intervalMs ?? AUTO_CONTINUE_DEFAULT_INTERVAL,
        commandIntervalMs: config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
        lastSendTime: Date.now(),
        autoAgree: config.autoAgree ?? true,
        autoAgreeDelaySec: config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC,
        sendDelaySec: config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC,
        maxDurationMs: config.maxDurationMs ?? AUTO_CONTINUE_DEFAULT_MAX_DURATION,
        enabledAt: Date.now(),
      });
    }
  } catch {}
}

// Restore auto-continue config and start the timer on launch
loadAutoContinueFromStorage();
// The old logic unconditionally wiped the on-disk config, permanently losing the user's auto-continue settings.
// Current behavior: on cold start sessionTitles is empty → the old session-id configs written by
// loadAutoContinueFromStorage match no current session, so the timer is a no-op. When onRemoteCreated/createPty
// creates a new session, onSetAutoContinueConfig pushes the new config and overrides the old entries.
// Check whether any config is enabled, and start the timer if so
const hasEnabledConfig = Array.from(sessionAutoContinue.values()).some(c => c.enabled);
if (hasEnabledConfig) initAutoContinueTimer();

// Auto-continue timer
let autoContinueTimer: ReturnType<typeof setInterval> | null = null;

// Write to the PTY and reset the auto-continue timer
function writePtyWithAutoReset(id: string, data: string): void {
  termManager.notifyInput(id);
  window.posse.writePty(id, data);
  // Reset this session's auto-continue timer
  const config = sessionAutoContinue.get(id);
  if (config && config.enabled) {
    config.lastSendTime = Date.now();
  }
}

// Initialize the auto-continue timer
function initAutoContinueTimer(): void {
  if (autoContinueTimer) {
    clearInterval(autoContinueTimer);
  }
  autoContinueTimer = setInterval(() => {
    const now = Date.now();
    const staleSessionIds: string[] = [];
    sessionAutoContinue.forEach((config, sessionId) => {
      if (!config.enabled) return;
      if (!hasSessionInUI(sessionId)) {
        staleSessionIds.push(sessionId);
        return;
      }
      // Check max duration; auto-stop the loop on timeout
      if (config.maxDurationMs > 0 && config.enabledAt > 0 && (now - config.enabledAt >= config.maxDurationMs)) {
        console.log(`[Loop] Session ${sessionId} reached max duration ${config.maxDurationMs}ms, auto-stopping loop`);
        config.enabled = false;
        saveAutoContinueToStorage();
        renderSessionList();
        return;
      }
      // Check whether the interval has elapsed
      if (now - config.lastSendTime >= config.intervalMs) {
        const messages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
        const cmdInterval = config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL;
        const sendDelay = (config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC) * 1000;
        console.log(`[Loop] Sending ${messages.length} command(s) to session ${sessionId}`);

        // Send each command in order, with an interval between commands
        let cmdIdx = 0;
        const sendNextCommand = () => {
          if (cmdIdx >= messages.length) {
            console.log(`[Loop] Sent all ${messages.length} command(s)`);
            return;
          }
          const msg = messages[cmdIdx];
          cmdIdx++;
          window.posse.writePty(sessionId, msg);
          // Send Enter after a delay
          setTimeout(() => {
            const enterKeys = [
              '\r', '\n', '\r\n', '\x0d', '\x0a', '\x1b\n', '\x1b\r',
            ];
            let ei = 0;
            const sendNextEnter = () => {
              if (ei < enterKeys.length) {
                window.posse.writePty(sessionId, enterKeys[ei]);
                ei++;
                setTimeout(sendNextEnter, 15);
              } else {
                // Enter sent for this command; move to the next command
                setTimeout(sendNextCommand, cmdInterval);
              }
            };
            sendNextEnter();
          }, sendDelay);
        };
        sendNextCommand();
        config.lastSendTime = now;
      }
    });
    if (staleSessionIds.length > 0) {
      staleSessionIds.forEach((id) => sessionAutoContinue.delete(id));
      saveAutoContinueToStorage();
      renderSessionList();
    }
  }, 1000); // Check once per second
}

// Toggle the auto-continue switch
function toggleAutoContinue(sessionId: string, enabled: boolean): void {
  let config = sessionAutoContinue.get(sessionId);
  if (!config) {
    config = {
      enabled: false,
      messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
      intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
      commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
      lastSendTime: Date.now(),
      autoAgree: true,
      autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
      sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
      maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
      enabledAt: 0,
    };
    sessionAutoContinue.set(sessionId, config);
  }
  config.enabled = enabled;
  config.lastSendTime = Date.now();
  if (enabled) {
    config.enabledAt = Date.now();
  }
  saveAutoContinueToStorage();

  // Start the timer (if not already running)
  initAutoContinueTimer();

  // Re-render the session list to reflect the switch state
  renderSessionList();
}

// Show the auto-continue config dialog
function showAutoContinueConfigDialog(sessionId: string): void {
  const config = sessionAutoContinue.get(sessionId) || {
    enabled: false,
    messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
    intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
    commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
    lastSendTime: Date.now(),
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
    enabledAt: 0,
  };

  const currentMessages = config.messages || AUTO_CONTINUE_DEFAULT_MESSAGES;
  const currentInterval = config.intervalMs || AUTO_CONTINUE_DEFAULT_INTERVAL;
  const currentIntervalMinutes = Math.round(currentInterval / 60000);
  const currentCommandInterval = Math.round((config.commandIntervalMs ?? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL) / 1000);
  const currentAutoAgree = config.autoAgree ?? true;
  const currentAutoAgreeDelay = config.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC;
  const currentSendDelay = config.sendDelaySec ?? AUTO_CONTINUE_SEND_DELAY_SEC;
  const currentMaxDuration = config.maxDurationMs ?? AUTO_CONTINUE_DEFAULT_MAX_DURATION;
  const currentMaxDurationMinutes = currentMaxDuration > 0 ? Math.round(currentMaxDuration / 60000) : 0;

  const overlay = document.getElementById('auto-continue-overlay')!;
  const messageInput = document.getElementById('auto-continue-message') as HTMLTextAreaElement;
  const intervalInput = document.getElementById('auto-continue-interval') as HTMLInputElement;
  const commandIntervalInput = document.getElementById('auto-continue-command-interval') as HTMLInputElement;
  const autoAgreeCheckbox = document.getElementById('auto-continue-auto-agree') as HTMLInputElement;
  const autoAgreeDelayInput = document.getElementById('auto-continue-agree-delay') as HTMLInputElement;
  const autoAgreeDelayRow = document.getElementById('auto-agree-delay-row')!;
  const sendDelayInput = document.getElementById('auto-continue-send-delay') as HTMLInputElement;
  const maxDurationInput = document.getElementById('auto-continue-max-duration') as HTMLInputElement;
  const saveBtn = document.getElementById('auto-continue-save')!;
  const stopBtn = document.getElementById('auto-continue-stop')!;
  const cancelBtn = document.getElementById('auto-continue-cancel')!;
  const closeBtn = document.getElementById('auto-continue-dialog-close')!;

  messageInput.value = currentMessages.join('\n');
  messageInput.placeholder = 'One command per line, sent in order';
  intervalInput.value = String(currentIntervalMinutes);
  if (commandIntervalInput) commandIntervalInput.value = String(currentCommandInterval);
  autoAgreeCheckbox.checked = currentAutoAgree;
  autoAgreeDelayInput.value = String(currentAutoAgreeDelay);
  autoAgreeDelayRow.style.display = currentAutoAgree ? '' : 'none';
  sendDelayInput.value = String(currentSendDelay);
  maxDurationInput.value = String(currentMaxDurationMinutes);

  // Set the button label and visibility based on current state
  if (config.enabled) {
    saveBtn.textContent = 'Save';
    stopBtn.style.display = '';
  } else {
    saveBtn.textContent = 'Save and Start';
    stopBtn.style.display = 'none';
  }

  autoAgreeCheckbox.onchange = () => {
    autoAgreeDelayRow.style.display = autoAgreeCheckbox.checked ? '' : 'none';
  };

  overlay.classList.add('active');
  messageInput.focus();

  function close(): void {
    overlay.classList.remove('active');
    saveBtn.removeEventListener('click', onSave);
    stopBtn.removeEventListener('click', onStop);
    cancelBtn.removeEventListener('click', close);
    closeBtn.removeEventListener('click', close);
    autoAgreeCheckbox.onchange = null;
  }

  function onSave(): void {
    const messages = messageInput.value.split('\n').map(m => m.trim()).filter(Boolean);
    if (!messages.length) { messageInput.focus(); return; }
    const intervalMinutes = parseInt(intervalInput.value, 10);
    if (isNaN(intervalMinutes) || intervalMinutes < 1) { intervalInput.focus(); return; }

    const agreeDelay = parseInt(autoAgreeDelayInput.value, 10);
    if (autoAgreeCheckbox.checked && (isNaN(agreeDelay) || agreeDelay < 0)) { autoAgreeDelayInput.focus(); return; }

    const sendDelay = parseInt(sendDelayInput.value, 10);
    if (isNaN(sendDelay) || sendDelay < 0) { sendDelayInput.focus(); return; }

    const maxDurationMinutes = parseInt(maxDurationInput.value, 10);
    if (isNaN(maxDurationMinutes) || maxDurationMinutes < 0) { maxDurationInput.focus(); return; }

    config.messages = messages;
    config.intervalMs = intervalMinutes * 60000;
    if (commandIntervalInput) {
      const cmdIntervalSec = parseInt(commandIntervalInput.value, 10);
      config.commandIntervalMs = isNaN(cmdIntervalSec) || cmdIntervalSec < 0 ? AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL : cmdIntervalSec * 1000;
    }
    config.lastSendTime = Date.now();
    config.autoAgree = autoAgreeCheckbox.checked;
    config.autoAgreeDelaySec = isNaN(agreeDelay) ? AUTO_AGREE_DEFAULT_DELAY_SEC : agreeDelay;
    config.sendDelaySec = sendDelay;
    config.maxDurationMs = maxDurationMinutes > 0 ? maxDurationMinutes * 60000 : 0;
    sessionAutoContinue.set(sessionId, config);

    if (!config.enabled) {
      config.enabled = true;
      config.enabledAt = Date.now();
      initAutoContinueTimer();
    }

    saveAutoContinueToStorage();
    close();
    renderSessionList();
  }

  function onStop(): void {
    config.enabled = false;
    config.lastSendTime = Date.now();
    sessionAutoContinue.set(sessionId, config);
    saveAutoContinueToStorage();
    initAutoContinueTimer();
    close();
    renderSessionList();
  }

  saveBtn.addEventListener('click', onSave);
  stopBtn.addEventListener('click', onStop);
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
}

// ID of the session whose title is currently being edited
let editingTitleId: string | null = null;

// ========== Custom presets ==========

interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
}

interface FileTreeItem {
  name: string;
  path: string;
  isDir: boolean;
}

const CUSTOM_PRESETS_KEY = 'posse_custom_presets';
const PRESET_SYNC_INTERVAL_MS = 30 * 1000;
let customPresetNextId = 1;
let presetSyncInFlight = false;
let presetSyncTimer: ReturnType<typeof setInterval> | null = null;

function getCustomPresets(): CustomPreset[] {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveCustomPresets(list: CustomPreset[]): void {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  // Sync to the remote server so mobile clients can read it
  syncPresetsToServer(list);
}

async function syncPresetsToServer(list: CustomPreset[]): Promise<void> {
  if (!remoteServerInfo) {
    console.log('[Preset Sync] Remote server not ready, skipping sync');
    return;
  }
  
  console.log('[Preset Sync] Syncing presets to server:', list.length, 'items');
  
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(`http://127.0.0.1:${remoteServerInfo.port}/api/custom-presets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${remoteServerInfo.token}` },
        body: JSON.stringify(list),
      });
      
      if (response.ok) {
        console.log('[Preset Sync] Successfully synced presets to server');
        return;
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      retries--;
      console.warn(`[Preset Sync] Failed to sync presets (${3 - retries}/3):`, error);
      
      if (retries > 0) {
        // Wait 1 second before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  console.error('[Preset Sync] Failed to sync presets after 3 attempts');
}

async function pullPresetsFromServer(): Promise<CustomPreset[] | null> {
  if (!remoteServerInfo) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${remoteServerInfo.port}/api/custom-presets`, {
      headers: { 'Authorization': `Bearer ${remoteServerInfo.token}` },
    });
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return null;
}

function arePresetListsEqual(a: CustomPreset[], b: CustomPreset[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function reconcilePresetsWithServer(reason: string): Promise<void> {
  if (!remoteServerInfo || presetSyncInFlight) return;
  presetSyncInFlight = true;
  try {
    const localPresets = getCustomPresets();
    const serverPresets = await pullPresetsFromServer();
    if (!serverPresets) return;

    const merged = new Map<string, CustomPreset>();
    for (const p of localPresets) merged.set(p.id, p);
    for (const p of serverPresets) merged.set(p.id, p);
    const list = Array.from(merged.values());

    if (!arePresetListsEqual(localPresets, list)) {
      console.log('[Preset Sync] Updating local presets from server:', reason);
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
      renderPresetSelect();
    }

    if (!arePresetListsEqual(serverPresets, list)) {
      console.log('[Preset Sync] Updating server presets from local:', reason);
      await syncPresetsToServer(list);
    }
  } finally {
    presetSyncInFlight = false;
  }
}

function startPresetSyncTimer(): void {
  if (presetSyncTimer) return;
  presetSyncTimer = setInterval(() => {
    void reconcilePresetsWithServer('timer');
  }, PRESET_SYNC_INTERVAL_MS);
}

// Built-in option list (mirrors the options in index.html, used as the base for renderPresetSelect)
const BUILTIN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Empty Terminal' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude (auto)' },
  { value: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"', label: 'Codex (auto)' },
  { value: 'copilot --allow-all --autopilot', label: 'Copilot (auto)' },
  { value: 'devin --permission-mode bypass', label: 'Devin (auto)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kiro-cli chat --trust-all-tools', label: 'Kiro (auto)' },
];

// Append the auth token as a ?token= query so scanning the QR auto-authenticates
function withToken(base: string, token: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

// Track the last URL we rendered a QR for, to avoid redundant async regeneration
let lastQrUrl = '';

// Render remote server connection info: QR (priority Tailscale > LAN) + connect URL + token
function renderRemoteServerInfo(): void {
  if (!remoteServerInfo) {
    remoteServerInfoEl.style.display = 'none';
    return;
  }
  remoteServerInfoEl.style.display = 'block';

  const qrWrapEl = remoteServerInfoEl.querySelector('.remote-info-qr') as HTMLElement;
  const qrImgEl = remoteServerInfoEl.querySelector('.remote-info-qr-img') as HTMLImageElement;
  const scanHintEl = remoteServerInfoEl.querySelector('.remote-info-scan-hint') as HTMLElement;
  const urlEl = remoteServerInfoEl.querySelector('.remote-info-url') as HTMLElement;
  const lanEl = remoteServerInfoEl.querySelector('.remote-info-lan') as HTMLElement;
  const tokenEl = remoteServerInfoEl.querySelector('.remote-info-token') as HTMLElement;
  const setupHintEl = remoteServerInfoEl.querySelector('.remote-info-setup-hint') as HTMLElement;

  const token = remoteServerInfo.token;
  const tailscaleUrl = remoteServerInfo.tailscaleUrl || null;
  const lanUrl = remoteServerInfo.lanUrl || null;

  // URL priority: Tailscale (reachable on AND off LAN) > LAN. Both carry the embedded token.
  const bestBase = tailscaleUrl || lanUrl;
  const bestConnectUrl = bestBase ? withToken(`${bestBase}/`, token) : null;

  // Primary connect URL (selectable, tap-to-copy). Show base without token for readability.
  if (bestBase) {
    urlEl.textContent = bestBase;
    urlEl.dataset.copy = bestConnectUrl || '';
    urlEl.style.display = 'block';
  } else {
    urlEl.textContent = '';
    urlEl.style.display = 'none';
  }

  // If Tailscale is the QR target, still surface the LAN URL as a secondary text line.
  if (tailscaleUrl && lanUrl) {
    lanEl.textContent = `LAN: ${lanUrl}`;
    lanEl.style.display = 'block';
  } else {
    lanEl.textContent = '';
    lanEl.style.display = 'none';
  }

  // Token as fallback for manual entry
  tokenEl.textContent = `Token: ${token}`;

  // Setup hint only when NO reachable URL exists at all — and make it Tailscale-oriented.
  if (!bestConnectUrl) {
    setupHintEl.textContent = 'No reachable address. Connect this Mac to a network, or install Tailscale + enable MagicDNS/HTTPS for off-LAN access.';
    setupHintEl.style.display = 'block';
  } else {
    setupHintEl.textContent = '';
    setupHintEl.style.display = 'none';
  }

  // QR code: encode the best connect URL with embedded token. Regenerate only on change.
  if (bestConnectUrl) {
    qrWrapEl.style.display = 'block';
    scanHintEl.style.display = 'block';
    if (bestConnectUrl !== lastQrUrl) {
      lastQrUrl = bestConnectUrl;
      QRCode.toDataURL(bestConnectUrl, { margin: 1, width: 320 })
        .then((dataUrl) => {
          // Guard against a later info update having changed the target URL
          if (lastQrUrl === bestConnectUrl) qrImgEl.src = dataUrl;
        })
        .catch((err) => {
          console.warn('[Renderer] QR generation failed:', err);
        });
    }
  } else {
    qrWrapEl.style.display = 'none';
    scanHintEl.style.display = 'none';
    qrImgEl.removeAttribute('src');
    lastQrUrl = '';
  }
}

function renderPresetSelect(): void {
  const prev = presetSelect.value;
  presetSelect.innerHTML = '';

  // Built-in options
  for (const opt of BUILTIN_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    presetSelect.appendChild(el);
  }

  // Custom presets
  const customs = getCustomPresets();
  if (customs.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '── Custom ──';
    presetSelect.appendChild(sep);

    for (const p of customs) {
      const el = document.createElement('option');
      el.value = p.autoFlag ? p.command + ' ' + p.autoFlag : p.command;
      el.textContent = p.autoFlag ? p.name + ' (auto)' : p.name;
      presetSelect.appendChild(el);
    }
  }

  // Restore the previously selected value
  presetSelect.value = prev;
  // Fall back to the empty terminal if the previous value no longer exists
  if (presetSelect.selectedIndex === -1) presetSelect.value = '';

  // Only sync to the server when the remote server is available
  if (remoteServerInfo) {
    console.log('[Preset Sync] Remote server available, syncing presets');
    syncPresetsToServer(customs);
  } else {
    console.log('[Preset Sync] Remote server not available, will sync when ready');
  }
}

function showPresetDialog(preset?: CustomPreset): Promise<CustomPreset | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const isEdit = !!preset;
    dialog.innerHTML = `
      <h3>${isEdit ? 'Edit' : 'New'} Custom CLI Preset</h3>
      <div class="preset-form">
        <div class="preset-form-field">
          <label>Name</label>
          <input type="text" id="preset-name-input" placeholder="e.g. Aider, custom CLI" value="${preset?.name || ''}" />
        </div>
        <div class="preset-form-field">
          <label>Command</label>
          <input type="text" id="preset-cmd-input" placeholder="e.g. aider, my-cli" value="${preset?.command || ''}" />
        </div>
        <div class="preset-form-field">
          <label>Auto flag (optional)</label>
          <input type="text" id="preset-auto-input" placeholder="e.g. --yes, --yolo; leave empty for no auto mode" value="${preset?.autoFlag || ''}" />
        </div>
      </div>
      <div class="confirm-buttons" style="margin-top:16px">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-close-confirm" style="background:var(--accent)">Save</button>
      </div>`;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#preset-name-input') as HTMLInputElement;
    const cmdInput = dialog.querySelector('#preset-cmd-input') as HTMLInputElement;
    const autoInput = dialog.querySelector('#preset-auto-input') as HTMLInputElement;

    nameInput.focus();

    const cleanup = (result: CustomPreset | null) => { overlay.remove(); resolve(result); };

    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    dialog.querySelector('.btn-close-confirm')!.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const command = cmdInput.value.trim();
      if (!name || !command) {
        nameInput.style.borderColor = name ? '' : 'var(--danger)';
        cmdInput.style.borderColor = command ? '' : 'var(--danger)';
        return;
      }
      const id = preset?.id || `custom-${customPresetNextId++}`;
      cleanup({ id, name, command, autoFlag: autoInput.value.trim() });
    });

    // Enter key saves
    const handleEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('.btn-close-confirm')!.click();
      if (e.key === 'Escape') cleanup(null);
    };
    nameInput.addEventListener('keydown', handleEnter);
    cmdInput.addEventListener('keydown', handleEnter);
    autoInput.addEventListener('keydown', handleEnter);
  });
}

function showPresetManageDialog(): void {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog';
  dialog.style.minWidth = '360px';

  function render() {
    const customs = getCustomPresets();
    dialog.innerHTML = `<h3>Manage Custom Presets</h3>`;

    const listEl = document.createElement('div');
    listEl.className = 'preset-manage-list';

    if (customs.length === 0) {
      listEl.innerHTML = '<div class="preset-manage-empty">No custom presets yet. Click the "+" button in the toolbar to create one.</div>';
    } else {
      for (const p of customs) {
        const item = document.createElement('div');
        item.className = 'preset-manage-item';

        const info = document.createElement('div');
        info.className = 'preset-manage-item-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'preset-manage-item-name';
        nameEl.textContent = p.name;
        const cmdEl = document.createElement('div');
        cmdEl.className = 'preset-manage-item-cmd';
        cmdEl.textContent = p.command + (p.autoFlag ? ` (auto: ${p.autoFlag})` : '');
        info.appendChild(nameEl);
        info.appendChild(cmdEl);

        const actions = document.createElement('div');
        actions.className = 'preset-manage-item-actions';

        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', async () => {
          const edited = await showPresetDialog(p);
          if (edited) {
            const list = getCustomPresets();
            const idx = list.findIndex(x => x.id === p.id);
            if (idx !== -1) { list[idx] = edited; saveCustomPresets(list); }
            renderPresetSelect();
            render();
          }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
          const list = getCustomPresets().filter(x => x.id !== p.id);
          saveCustomPresets(list);
          renderPresetSelect();
          render();
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        item.appendChild(info);
        item.appendChild(actions);
        listEl.appendChild(item);
      }
    }

    dialog.appendChild(listEl);

    const btns = document.createElement('div');
    btns.className = 'confirm-buttons';
    btns.style.marginTop = '16px';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => overlay.remove());
    btns.appendChild(closeBtn);
    dialog.appendChild(btns);
  }

  render();
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Initialize the custom-preset ID counter
(function initCustomPresetId() {
  const customs = getCustomPresets();
  for (const p of customs) {
    const m = p.id.match(/^custom-(\d+)$/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
})();

// Recent working directories
const RECENT_CWD_KEY = 'posse_recent_cwds';
const MAX_RECENT_CWDS = 8;

function getRecentCwds(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_CWD_KEY) || '[]'); } catch { return []; }
}

function addRecentCwd(cwd: string): void {
  const list = getRecentCwds().filter(p => p !== cwd);
  list.unshift(cwd);
  if (list.length > MAX_RECENT_CWDS) list.length = MAX_RECENT_CWDS;
  localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list));
  // Sync to the main-process remote service config so mobile clients can reuse it when creating sessions
  window.posse.remoteAddRecentCwd(cwd).catch(() => { /* ignore */ });
}

function syncRecentCwdsToRemote(): void {
  const list = getRecentCwds();
  // Replay in old -> new order so the remote ends up in the same order as the desktop
  list.slice().reverse().forEach((cwd) => {
    window.posse.remoteAddRecentCwd(cwd).catch(() => { /* ignore */ });
  });
}

// DOM elements
const cwdInput = document.getElementById('cwd-input') as HTMLInputElement;
const cwdBrowseBtn = document.getElementById('cwd-browse-btn')!;
const cwdOpenBtn = document.getElementById('cwd-open-btn')!;
const cwdRecentBtn = document.getElementById('cwd-recent-btn')!;
const cwdRecentDropdown = document.getElementById('cwd-recent-dropdown')!;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const presetAddBtn = document.getElementById('preset-add-btn')!;
const presetManageBtn = document.getElementById('preset-manage-btn')!;
const themeSelect = document.getElementById('theme-select')!;
const themeDisplay = document.getElementById('theme-display')!;
const themeDropdown = document.getElementById('theme-dropdown')!;
const toolbarTerminalClientBtn = document.getElementById('toolbar-terminal-client-btn')!;
const toolbarRestartDaemonBtn = document.getElementById('toolbar-restart-daemon-btn') as HTMLButtonElement | null;
const remoteServerInfoEl = document.getElementById('remote-server-info')!;
// Tap the connect URL to copy the full token-embedded link to the clipboard
remoteServerInfoEl.querySelector('.remote-info-url')?.addEventListener('click', (e) => {
  const el = e.currentTarget as HTMLElement;
  const link = el.dataset.copy;
  if (!link) return;
  void navigator.clipboard.writeText(link).then(() => {
    const prev = el.textContent;
    el.textContent = 'Copied link!';
    setTimeout(() => { el.textContent = prev; }, 1200);
  }).catch(() => { /* clipboard unavailable, ignore */ });
});
const newSessionOverlay = document.getElementById('new-session-overlay')!;
const newSessionCloseBtn = document.getElementById('new-session-close')!;
const newSessionCancelBtn = document.getElementById('new-session-cancel')!;
const newSessionCreateBtn = document.getElementById('new-session-create')!;
const fileTreeList = document.getElementById('file-tree-list')!;
const fileTreeRefreshBtn = document.getElementById('file-tree-refresh-btn')!;

// File preview panel
const filePreviewPanel = document.getElementById('file-preview-panel')! as HTMLElement;
const filePreviewName = document.getElementById('file-preview-name')!;
const filePreviewMeta = document.getElementById('file-preview-meta')!;
const filePreviewBody = document.getElementById('file-preview-body')!;
const filePreviewCloseBtn = document.getElementById('file-preview-close')!;
const filePreviewExternalBtn = document.getElementById('file-preview-external')!;
let filePreview: FilePreview | null = null;
let filePreviewPath = '';

function closeFilePreview(): void {
  filePreviewPanel.hidden = true;
  filePreviewPath = '';
}

async function openFilePreview(filePath: string, name: string): Promise<void> {
  let res: { ok: boolean; content?: string; size?: number; ext?: string; error?: string };
  try {
    res = await window.posse.readFile(filePath);
  } catch (err) {
    // IPC failed → fall back to opening in an external editor
    console.error('readFile failed', err);
    window.posse.openFile(filePath);
    return;
  }
  if (!res.ok) {
    // Binary / too large / read failure → fall back to opening in an external editor
    window.posse.openFile(filePath);
    return;
  }
  filePreviewPath = filePath;
  filePreviewName.textContent = name;
  filePreviewName.title = filePath;
  const kb = res.size ? (res.size / 1024).toFixed(1) : '0';
  filePreviewMeta.textContent = `${res.ext || 'txt'} · ${kb} KB`;
  filePreviewPanel.hidden = false;
  if (!filePreview) filePreview = createFilePreview(filePreviewBody);
  filePreview.show(res.content || '', res.ext || '');
}

filePreviewCloseBtn.addEventListener('click', closeFilePreview);
filePreviewExternalBtn.addEventListener('click', () => {
  if (filePreviewPath) window.posse.openFile(filePreviewPath);
});

const fileTreePath = document.getElementById('file-tree-path')!;
const fileTreePanel = document.getElementById('file-tree-panel')!;
const fileTreeToggle = document.getElementById('file-tree-toggle')!;
const fileTreeResizer = document.getElementById('file-tree-resizer')!;
const terminalArea = document.getElementById('terminal-area')!;
const terminalContent = document.getElementById('terminal-content')!;
const emptyState = document.getElementById('empty-state')!;
// The Sessions tab now renders the Codex-style project navigator into this container.
const sessionList = document.getElementById('project-nav')!;
const chatContent = document.getElementById('chat-content')!;
const chatEmptyState = document.getElementById('chat-empty-state')!;
const sidebar = document.getElementById('sidebar')!;;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarResizer = document.getElementById('sidebar-resizer')!;

// ========== Projects panel toolbar: search + sort ==========
(function initProjectToolbar() {
  const searchInput = document.getElementById('project-search') as HTMLInputElement | null;
  const searchClear = document.getElementById('project-search-clear');
  const sortBtn = document.getElementById('project-sort') as HTMLButtonElement | null;

  const toggleSearchClear = (): void => {
    if (!searchClear || !searchInput) return;
    if (searchInput.value.length > 0) searchClear.removeAttribute('hidden');
    else searchClear.setAttribute('hidden', '');
  };
  toggleSearchClear();

  const updateSortLabel = (): void => {
    if (sortBtn) sortBtn.textContent = projectSortMode === 'name' ? 'Name' : 'Recent';
  };
  updateSortLabel();

  if (searchInput) {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    searchInput.addEventListener('input', () => {
      toggleSearchClear();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        projectSearchQuery = searchInput.value.trim().toLowerCase();
        renderSessionList();
      }, 120);
    });
  }

  searchClear?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    projectSearchQuery = '';
    searchClear.setAttribute('hidden', '');
    renderSessionList();
    searchInput.focus();
  });

  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      projectSortMode = projectSortMode === 'recent' ? 'name' : 'recent';
      try { localStorage.setItem(PROJECT_SORT_STORAGE_KEY, projectSortMode); } catch { /* ignore */ }
      updateSortLabel();
      renderSessionList();
    });
  }
})();

// File statusbar DOM
const fileStatusbar = document.getElementById('file-statusbar')!;
const fileStatusbarFiles = document.getElementById('file-statusbar-files')!;
const appVersionEl = document.getElementById('app-version')!;

// File watcher state (global)
let globalRecentFiles: string[] = [];
const MAX_RECENT_FILES = 5;
let currentEditorName: string | null = null;
let fileTreeRootCwd: string | null = null;
const fileTreeExpandedDirs: Set<string> = new Set();
const fileTreeChildrenCache: Map<string, FileTreeItem[]> = new Map();

// Unread state (green dot: AI finished, waiting for input)
const sessionUnread: Set<string> = new Set();
// Busy state (yellow dot: AI is producing output)
const sessionBusy: Set<string> = new Set();
// Waiting state (red warning triangle: AI paused, waiting for the user's decision)
const sessionWaiting: Set<string> = new Set();
// Unread delay timer (idle-timeout detection)
const unreadTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
// Recently received data buffer (used for prompt detection)
const recentDataBuffer: Map<string, string> = new Map();
// Sessions with a manually edited title (no longer auto-updated)
const sessionTitleLocked: Set<string> = new Set();
// Pinned sessions
const pinnedSessions: Set<string> = new Set();

// Sync session status to the main process (read by the mobile remote-server)
function syncSessionStatusToMain(): void {
  const statuses: Record<string, string> = {};
  for (const id of sessionTitles.keys()) {
    if (sessionBusy.has(id)) {
      statuses[id] = 'running';   // Yellow: AI is working
    } else if (sessionUnread.has(id)) {
      statuses[id] = 'idle';      // Green: waiting for input
    } else {
      statuses[id] = 'inactive';  // Gray: already viewed
    }
  }
  window.posse.syncSessionStatus(statuses);
}

// Terminal manager
const termManager = new TerminalManager(terminalContent, (id, cols, rows) => {
  window.posse.resizePty(id, cols, rows);
});

// Restore the last working directory and preset command
if (savedCwd) {
  cwdInput.value = savedCwd;
}
syncRecentCwdsToRemote();
// Initialize the preset select (including custom presets), then restore the last selection
renderPresetSelect();
if (lastPreset) {
  presetSelect.value = lastPreset;
}

// Custom color-scheme dropdown component
const themeColorMap: Record<string, string> = {
  'auto': '',
  'vscode-dark': '#0078d4',
  'monokai': '#a6e22e',
  'dracula': '#bd93f9',
  'solarized-dark': '#268bd2',
  'one-dark': '#61afef',
  'nord': '#88c0d0',
};
let currentThemeId = 'auto';

function setThemeValue(value: string): void {
  currentThemeId = value;
  const opt = themeDropdown.querySelector(`[data-value="${value}"]`);
  if (opt) {
    themeDisplay.innerHTML = opt.innerHTML;
  }
  themeDropdown.querySelectorAll('.custom-select-option').forEach((el) => {
    el.classList.toggle('selected', el.getAttribute('data-value') === value);
  });
}

themeDisplay.addEventListener('click', (e) => {
  e.stopPropagation();
  themeSelect.classList.toggle('open');
});

themeDropdown.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('.custom-select-option') as HTMLElement | null;
  if (!target) return;
  const value = target.getAttribute('data-value');
  if (value) setThemeValue(value);
  themeSelect.classList.remove('open');
});

document.addEventListener('click', () => {
  themeSelect.classList.remove('open');
});

// Restore the saved color scheme on launch
setThemeValue(currentThemeId);

// ========== CLI tag colors ==========

// Known CLI → fixed colors (text color, background color)
// NOTE: keys ending with " (auto)" are the displayName values produced by the backend (pty-manager). Keep them in sync.
const CLI_TAG_COLORS: Record<string, [string, string]> = {
  'Claude':        ['#d4a574', '#3d2e1e'],
  'Claude (auto)':  ['#e5a100', '#3d3010'],
  'Codex':         ['#73c991', '#1e3328'],
  'Codex (auto)':   ['#56d4a0', '#1a3d2e'],
  'Copilot':       ['#7ee787', '#17361f'],
  'Copilot (auto)': ['#3fb950', '#12351f'],
};

function getCliTagColors(displayName: string): [string, string] {
  // Exact match
  if (CLI_TAG_COLORS[displayName]) return CLI_TAG_COLORS[displayName];
  // Prefix match (custom-preset "auto" variants)
  for (const key of Object.keys(CLI_TAG_COLORS)) {
    if (displayName.startsWith(key)) return CLI_TAG_COLORS[key];
  }
  // Unknown CLI: pick one from the palette via hash
  let h = 0;
  for (let i = 0; i < displayName.length; i++) {
    h = ((h << 5) - h + displayName.charCodeAt(i)) | 0;
  }
  const palette: Array<[string, string]> = [
    ['#e06c75', '#3d1e22'], ['#e5c07b', '#3d3520'], ['#98c379', '#253320'],
    ['#f78c6c', '#3d2518'], ['#c792ea', '#2e1e3d'], ['#ff5370', '#3d1825'],
  ];
  return palette[Math.abs(h) % palette.length];
}

// ========== Automatic path colors ==========

// High-contrast palette (12 colors, evenly distributed in HSL, high saturation)
const PATH_COLORS = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
  '#61afef', '#c678dd', '#f78c6c', '#d19a66',
  '#7ec699', '#82aaff', '#c792ea', '#ff5370',
];

function cwdToColor(cwd: string): string {
  const key = normalizeCwd(cwd);
  if (!key) return PATH_COLORS[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return PATH_COLORS[Math.abs(hash) % PATH_COLORS.length];
}

// Normalize a directory path so the same directory isn't split into multiple groups due to a trailing slash or the macOS /private prefix
function normalizeCwd(cwd: string): string {
  if (!cwd) return '';
  let p = cwd.trim();
  if (p.startsWith('/private/')) p = p.slice('/private'.length);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

// Use the last path segment as the project name
function cwdShortName(cwd: string): string {
  if (!cwd) return 'Unknown Project';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

// Auto color scheme: map a cwd to an actual theme, trying to give different projects different themes
const AUTO_THEME_LIST = ['vscode-dark', 'monokai', 'dracula', 'solarized-dark', 'one-dark', 'nord'];
const autoThemeCache: Map<string, string> = new Map(); // cwd → themeId

function cwdHash(cwd: string): number {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cwdToThemeId(cwd: string): string {
  if (!cwd) return AUTO_THEME_LIST[0];
  const cached = autoThemeCache.get(cwd);
  if (cached) return cached;

  // Themes already taken
  const usedThemes = new Set(autoThemeCache.values());
  // Prefer an unused theme
  const available = AUTO_THEME_LIST.filter(t => !usedThemes.has(t));
  const hash = cwdHash(cwd);
  let theme: string;
  if (available.length > 0) {
    theme = available[hash % available.length];
  } else {
    theme = AUTO_THEME_LIST[hash % AUTO_THEME_LIST.length];
  }
  autoThemeCache.set(cwd, theme);
  return theme;
}

// Resolve the actual themeId: when auto, decide based on cwd
function resolveThemeId(themeId: string, cwd: string): string {
  return themeId === 'auto' ? cwdToThemeId(cwd) : themeId;
}

// ========== Utility functions ==========

function friendlyTime(ts: number): string {
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function updateEmptyState(): void {
  emptyState.style.display = termManager.hasInstances() ? 'none' : 'flex';
}

function updateSessionTitleBar(): void {
  const activeId = termManager.getActiveId();
  if (activeId) {
    const cwd = sessionCwds.get(activeId) || '';
    // Top of the left file tree: show the last directory name
    const cwdDisplay = cwd ? cwd.split('/').filter(Boolean).pop() : '';
    fileTreePath.textContent = cwdDisplay || 'Directory';
    fileTreePath.title = cwd || '';
    // macOS window title: keep full information
    const title = sessionTitles.get(activeId) || '';
    const displayName = sessionDisplayNames.get(activeId) || '';
    const parts = ['Posse'];
    if (displayName) parts.push(displayName);
    // 'New session' / 'New conversation' are default titles produced by the backend (kept for the comparison to work)
    if (title && title !== 'New session' && title !== 'New conversation') parts.push(title);
    window.posse.setWindowTitle(parts.join('-'));
  } else if (selectedProjectPath) {
    // No active session but a project is selected: label the file panel with the project folder.
    const cwdDisplay = selectedProjectPath.split('/').filter(Boolean).pop() || '';
    fileTreePath.textContent = cwdDisplay || 'Directory';
    fileTreePath.title = selectedProjectPath;
    window.posse.setWindowTitle(cwdDisplay ? `Posse-${cwdDisplay}` : 'Posse');
  } else {
    fileTreePath.textContent = 'Directory';
    fileTreePath.title = '';
    window.posse.setWindowTitle('Posse');
  }
}

function getActiveSessionId(): string | null {
  return termManager.getActiveId();
}

function getActiveSessionCwd(): string {
  // An explicitly selected project takes precedence so the RIGHT file panel follows the project
  // the user clicked, even when no terminal session is open in it yet.
  if (selectedProjectPath) return selectedProjectPath;
  const activeId = getActiveSessionId();
  if (activeId) return sessionCwds.get(activeId) || currentCwd;
  return currentCwd;
}

// Select a project: drives the RIGHT file panel root + highlight, and expands it in the navigator.
function selectProject(projPath: string): void {
  if (!projPath) return;
  selectedProjectPath = projPath;
  const key = normalizeCwd(projPath);
  // Note: selecting a project drives the RIGHT file panel only; it must NOT force-expand the
  // project's session list (default-collapsed per project). Lazily load its multi-agent history
  // so the data is ready when the user does expand it.
  if (!backendProjects.has(key) && !projectsDataLoading) void refreshProjectsData();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

function quotePathForShell(filePath: string): string {
  // Windows/cmd uses double quotes; Unix-like shells use single quotes
  if (/^[a-zA-Z]:\\/.test(filePath)) return `"${filePath.replace(/"/g, '\\"')}"`;
  return `'${filePath.replace(/'/g, `'\"'\"'`)}'`;
}

function insertPathToActiveTerminal(filePath: string): void {
  const activeId = getActiveSessionId();
  if (!activeId) return;
  writePtyWithAutoReset(activeId, quotePathForShell(filePath) + ' ');
}

function showTreeContextMenu(e: MouseEvent, itemPath: string, isDir: boolean): void {
  // Remove any existing menu
  document.querySelectorAll('.term-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';

  const items: Array<{ label: string; action: () => void }> = [];

  if (isDir) {
    items.push(
      { label: 'Copy absolute path', action: () => { navigator.clipboard.writeText(itemPath); } },
      { label: 'Reveal in Finder', action: () => window.posse.openFolder(itemPath) },
      { label: 'Insert path into terminal', action: () => insertPathToActiveTerminal(itemPath) },
    );
  } else {
    items.push(
      { label: 'Copy absolute path', action: () => { navigator.clipboard.writeText(itemPath); } },
      { label: 'Open with default app', action: () => window.posse.openFile(itemPath) },
      { label: 'Open in editor', action: () => window.posse.filewatcherOpen(itemPath) },
      { label: 'Insert path into terminal', action: () => insertPathToActiveTerminal(itemPath) },
    );
  }

  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

async function loadDirItems(dirPath: string): Promise<FileTreeItem[]> {
  if (fileTreeChildrenCache.has(dirPath)) return fileTreeChildrenCache.get(dirPath)!;
  const items = await window.posse.fileTreeListDir(dirPath);
  fileTreeChildrenCache.set(dirPath, items);
  return items;
}

async function renderFileTree(): Promise<void> {
  const rootCwd = getActiveSessionCwd();
  if (!rootCwd) {
    fileTreeList.innerHTML = '<div class="file-tree-empty">Select a session to show the current directory</div>';
    return;
  }

  if (fileTreeRootCwd !== rootCwd) {
    fileTreeRootCwd = rootCwd;
    fileTreeChildrenCache.clear();
    fileTreeExpandedDirs.clear();
    fileTreeExpandedDirs.add(rootCwd);
    void loadClaudeHistory(rootCwd);
  }

  fileTreeList.innerHTML = '';

  // Render the root directory row first
  const rootRow = document.createElement('div');
  rootRow.className = 'file-tree-row dir active-dir';
  rootRow.style.paddingLeft = '6px';

  const rootArrow = document.createElement('span');
  rootArrow.className = 'file-tree-arrow';
  rootArrow.innerHTML = ICON.chevron; rootArrow.classList.add('expanded');
  rootRow.appendChild(rootArrow);

  const rootName = document.createElement('span');
  rootName.className = 'file-tree-name';
  rootName.textContent = rootCwd.split(/[/\\]/).pop() || rootCwd;
  rootName.title = rootCwd;
  rootRow.appendChild(rootName);

  const rootOpenBtn = document.createElement('span');
  rootOpenBtn.className = 'file-tree-open-folder';
  rootOpenBtn.innerHTML = ICON.folder;
  rootOpenBtn.title = 'Reveal in Finder';
  rootOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.posse.openFolder(rootCwd);
  });
  rootRow.appendChild(rootOpenBtn);

  rootRow.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTreeContextMenu(e as MouseEvent, rootCwd, true);
  });

  fileTreeList.appendChild(rootRow);

  const rootItems = await loadDirItems(rootCwd);

  const appendRows = async (items: FileTreeItem[], level: number): Promise<void> => {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `file-tree-row ${item.isDir ? 'dir' : 'file'}`;
      row.style.paddingLeft = `${6 + level * 14}px`;
      if (item.isDir && fileTreeExpandedDirs.has(item.path)) row.classList.add('active-dir');

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      if (item.isDir) {
        arrow.innerHTML = ICON.chevron;
        if (fileTreeExpandedDirs.has(item.path)) arrow.classList.add('expanded');
      }
      row.appendChild(arrow);

      const name = document.createElement('span');
      name.className = 'file-tree-name';
      name.textContent = item.name;
      name.title = item.path;
      row.appendChild(name);

      // Directory row: add a "Reveal in Finder" icon button
      if (item.isDir) {
        const openFolderBtn = document.createElement('span');
        openFolderBtn.className = 'file-tree-open-folder';
        openFolderBtn.innerHTML = ICON.folder;
        openFolderBtn.title = 'Reveal in Finder';
        openFolderBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.posse.openFolder(item.path);
        });
        row.appendChild(openFolderBtn);
      }

      row.addEventListener('click', async () => {
        if (item.isDir) {
          const wasExpanded = fileTreeExpandedDirs.has(item.path);
          if (wasExpanded) fileTreeExpandedDirs.delete(item.path);
          else fileTreeExpandedDirs.add(item.path);
          await renderFileTree();
          // After expanding, scroll to this directory
          if (!wasExpanded) {
            requestAnimationFrame(() => {
              row.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
          }
        } else {
          void openFilePreview(item.path, item.name);
        }
      });

      // Context menu: supported for both files and directories
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e as MouseEvent, item.path, item.isDir);
      });

      fileTreeList.appendChild(row);

      if (item.isDir && fileTreeExpandedDirs.has(item.path)) {
        const children = await loadDirItems(item.path);
        await appendRows(children, level + 1);
      }
    }
  };

  await appendRows(rootItems, 0);
  if (!fileTreeList.children.length) {
    fileTreeList.innerHTML = '<div class="file-tree-empty">Directory is empty</div>';
  }
}

async function refreshFileTree(force = false): Promise<void> {
  if (force) {
    fileTreeChildrenCache.clear();
  }
  await renderFileTree();
}

// Confirmation dialog
function showConfirmDialog(title: string, kind = 'Terminal'): Promise<'close' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.innerHTML = `
      <h3>Close ${kind}</h3>
      <p>Are you sure you want to close "${title}"?</p>
      <div class="confirm-buttons">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-close-confirm" autofocus>Close</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const cleanup = (r: 'close' | 'cancel') => { overlay.remove(); resolve(r); };
    dialog.querySelector('.btn-cancel')!.addEventListener('click', () => cleanup('cancel'));
    const closeBtn = dialog.querySelector<HTMLButtonElement>('.btn-close-confirm')!;
    closeBtn.addEventListener('click', () => cleanup('close'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup('cancel'); });
    // Keyboard: Enter closes, Escape cancels
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup('close'); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup('cancel'); }
    };
    overlay.addEventListener('keydown', handleKey);
    closeBtn.focus();
  });
}

// ========== Rendering ==========

function startTitleEdit(id: string, titleSpan: HTMLElement): void {
  // If another session's title is being edited, cancel it first
  if (editingTitleId && editingTitleId !== id) {
    renderSessionList();
  }
  editingTitleId = id;
  const current = sessionTitles.get(id) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = current;
  input.dataset.sessionId = id;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    editingTitleId = null;
    const val = input.value.trim();
    if (val && val !== current) {
      sessionTitles.set(id, val);
      sessionTitleLocked.add(id);
      window.posse.renamePty(id, val);
    }
    renderSessionList();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { editingTitleId = null; input.value = current; input.blur(); }
  });
}

function showSessionContextMenu(e: MouseEvent, targetId: string): void {
  document.querySelectorAll('.term-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'term-context-menu';
  const targetCwd = sessionCwds.get(targetId) || '';
  const targetCwdKey = normalizeCwd(targetCwd);

  const items: Array<{ label: string; action: () => void }> = [
    {
      label: 'Regenerate title',
      action: () => {
        void window.posse.regenerateTitle(targetId);
      },
    },
    {
      label: 'Close other sessions',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()).filter(id => id !== targetId));
      },
    },
    {
      label: 'Close other sessions in this project',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()).filter(id =>
          id !== targetId && normalizeCwd(sessionCwds.get(id) || '') === targetCwdKey
        ));
      },
    },
    {
      label: 'Close all sessions',
      action: () => {
        destroySessions(Array.from(sessionTitles.keys()));
      },
    },
  ];

  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(el);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

// ========== Project navigator rendering ==========

// Status dot color for a live session
function sessionStatusColor(id: string): string {
  if (sessionWaiting.has(id)) return '#ff5c4d';   // waiting for user decision
  if (sessionBusy.has(id)) return '#e5a100';      // AI working
  if (sessionUnread.has(id)) return '#73c991';    // new unread output
  return '#8a93a6';                                // idle / viewed (slate, distinct from green & history grey)
}

// Build a session row for a LIVE PTY session inside a project (compact: title + relative time)
function buildLiveSessionRow(id: string, activeId: string | null): HTMLElement {
  const title = sessionTitles.get(id) || '';
  const isPinned = pinnedSessions.has(id);
  const item = document.createElement('div');
  item.className = 'nav-session' + (id === activeId ? ' active' : '');
  item.dataset.sessionId = id;
  item.dataset.sessionType = 'pty';

  const dot = document.createElement('span');
  dot.className = 'nav-session-dot';
  if (sessionWaiting.has(id)) {
    // Waiting for user decision → render a pulsing warning triangle instead of a filled circle
    dot.textContent = '⚠';
    dot.classList.add('nav-session-dot-warn');
    dot.style.color = '#ff5c4d';
    dot.style.backgroundColor = 'transparent';
  } else {
    dot.style.backgroundColor = sessionStatusColor(id);
    if (sessionBusy.has(id)) dot.classList.add('nav-session-dot-busy');
  }

  const titleSpan = document.createElement('span');
  titleSpan.className = 'nav-session-title';
  titleSpan.textContent = title || 'Terminal';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'nav-session-time';
  timeSpan.textContent = relativeTimeShort(sessionUpdateTimes.get(id) || Date.now());

  const editBtn = document.createElement('button');
  editBtn.className = 'nav-session-action';
  editBtn.innerHTML = ICON.pencil;
  editBtn.title = 'Rename';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startTitleEdit(id, titleSpan);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'nav-session-action';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); void handleCloseClick(id); });

  if (isPinned) item.classList.add('pinned');

  item.appendChild(dot);
  item.appendChild(titleSpan);
  item.appendChild(timeSpan);
  item.appendChild(editBtn);
  item.appendChild(closeBtn);

  item.addEventListener('click', () => switchSession(id));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showSessionContextMenu(e, id);
  });
  return item;
}

// Build a session row for a CLOSED (resumable) DuoCLI session
function buildClosedSessionRow(cs: ClosedSessionInfo): HTMLElement {
  const item = document.createElement('div');
  item.className = 'nav-session nav-session-closed';

  const dot = document.createElement('span');
  dot.className = 'nav-session-dot';
  dot.style.backgroundColor = '#666';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'nav-session-title';
  titleSpan.textContent = cs.title || 'Session';
  titleSpan.style.opacity = cs.title ? '1' : '0.6';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'nav-session-time';
  timeSpan.textContent = relativeTimeShort(cs.closedAt);

  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'nav-session-action';
  resumeBtn.textContent = '↩';
  resumeBtn.title = 'Resume session';
  resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); void restoreClosedSession(cs); });

  const delBtn = document.createElement('button');
  delBtn.className = 'nav-session-action';
  delBtn.textContent = '×';
  delBtn.title = 'Delete record';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closedSessions = await window.posse.closedSessionsRemove(cs.id);
    renderSessionList();
  });

  item.appendChild(dot);
  item.appendChild(titleSpan);
  item.appendChild(timeSpan);
  item.appendChild(resumeBtn);
  item.appendChild(delBtn);
  item.addEventListener('click', () => { void restoreClosedSession(cs); });
  return item;
}

// Build a session row for a native Claude/Codex history session
function buildHistorySessionRow(s: ClaudeHistorySession): HTMLElement {
  const item = document.createElement('div');
  item.className = 'nav-session nav-session-closed';

  const dot = document.createElement('span');
  dot.className = 'nav-session-dot';
  dot.style.backgroundColor = '#666';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'nav-session-title';
  titleSpan.textContent = s.title || s.id;
  titleSpan.style.opacity = s.title ? '1' : '0.6';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'nav-session-time';
  timeSpan.textContent = relativeTimeShort(s.mtimeMs);

  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'nav-session-action';
  resumeBtn.textContent = '↩';
  resumeBtn.title = 'Resume history session';
  resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); void resumeAgentSession(s); });

  item.appendChild(dot);
  item.appendChild(titleSpan);
  item.appendChild(timeSpan);
  item.appendChild(resumeBtn);
  item.addEventListener('click', () => { void resumeAgentSession(s); });
  return item;
}

// Collect & group a project's sessions by agent family.
// Returns Map<agentFamily, { lives, closed, history }> with time-desc ordering applied per group.
interface ProjectAgentGroup {
  lives: string[];
  closed: ClosedSessionInfo[];
  history: ClaudeHistorySession[];
  latest: number;
}

// Claude/Codex print a short 8-hex prefix in their resume hints, while the on-disk session file
// uses the full uuid (8-4-4-4-12). Collapse both forms to the shared 8-hex prefix so the same
// conversation dedups across the live / closed / history sources regardless of which form a
// source captured. Non-hex ids (rare) fall back to the lowercased full string.
function conversationKey(uuid: string): string {
  const u = uuid.toLowerCase();
  const m = u.match(/^[0-9a-f]{8}/);
  return m ? m[0] : u;
}

function collectProjectSessions(projPath: string): Map<string, ProjectAgentGroup> {
  const key = normalizeCwd(projPath);
  const groups = new Map<string, ProjectAgentGroup>();
  const ensure = (family: string): ProjectAgentGroup => {
    let g = groups.get(family);
    if (!g) { g = { lives: [], closed: [], history: [], latest: 0 }; groups.set(family, g); }
    return g;
  };

  // Canonical dedup: each conversation is identified by its agent session uuid. The same uuid can
  // appear as a LIVE PTY (resumeId), a CLOSED DuoCLI record (cs.resumeId), and an on-disk HISTORY
  // row (s.id). Sources capture the uuid in different forms (short 8-hex prefix vs full uuid), so
  // every uuid is routed through conversationKey() to a canonical key before matching. Preference
  // order is live > closed > history: once a key is shown by a higher-priority source,
  // lower-priority duplicates are skipped.
  const shownUuids = new Set<string>();

  // Belt-and-suspenders: agent uuids already OPEN as a live PTY (any cwd), via either tracking map.
  // Stored as canonical keys to match the on-disk history form. The resumeId-based shownUuids set
  // below is the primary mechanism.
  const openAgentIds = new Set<string>();
  for (const uuid of sessionResumeId.values()) if (uuid) openAgentIds.add(conversationKey(uuid));
  for (const uuid of sessionAgentId.values()) if (uuid) openAgentIds.add(conversationKey(uuid));

  // 1. Live PTY sessions in this cwd (highest priority)
  for (const id of sessionTitles.keys()) {
    if (normalizeCwd(sessionCwds.get(id) || '') !== key) continue;
    const uuid = sessionResumeId.get(id) || sessionAgentId.get(id);
    // Live↔live dedup: two live PTYs can share one uuid if discovery mis-bound a fresh
    // run to an already-active session's file. Skip the duplicate so the sidebar never
    // shows two rows for the same conversation. The first live PTY for a uuid wins.
    // A session with no resolvable uuid is always shown.
    if (uuid && shownUuids.has(conversationKey(uuid))) continue;
    const family = agentFamilyFromDisplayName(sessionDisplayNames.get(id) || '');
    const g = ensure(family);
    g.lives.push(id);
    g.latest = Math.max(g.latest, sessionUpdateTimes.get(id) || 0);
    if (uuid) shownUuids.add(conversationKey(uuid));
  }

  // 2. Closed DuoCLI sessions in this cwd — skip any already shown as a live PTY.
  for (const cs of closedSessions) {
    if (normalizeCwd(cs.cwd || '') !== key) continue;
    if (cs.resumeId && shownUuids.has(conversationKey(cs.resumeId))) continue;
    const family = agentFamilyFromDisplayName(cs.displayName || '');
    const g = ensure(family);
    g.closed.push(cs);
    g.latest = Math.max(g.latest, cs.closedAt || 0);
    if (cs.resumeId) shownUuids.add(conversationKey(cs.resumeId));
  }

  // 3. Native multi-agent history from the backend projects:list (Claude/Codex/Kiro/Copilot)
  const backend = backendProjects.get(key);
  if (backend) {
    for (const agentGroup of backend.agents) {
      const family = AGENT_ID_LABEL[agentGroup.agent] || agentFamilyFromDisplayName(agentGroup.agent);
      const g = ensure(family);
      for (const s of agentGroup.sessions) {
        // Dedup: skip if this on-disk session is already shown as a live PTY or a closed record.
        if (shownUuids.has(conversationKey(s.id)) || openAgentIds.has(conversationKey(s.id))) continue;
        // Skip rows confirmed gone by a failed resume (not-found), so the dead row does not reappear.
        if (removedHistoryKeys.has(conversationKey(s.id))) continue;
        shownUuids.add(conversationKey(s.id));
        g.history.push({
          id: s.id,
          title: s.title,
          cwd: backend.path,
          mtimeMs: s.mtimeMs,
          // ClaudeHistorySession.agent is a narrow union; only claude/codex are typed there.
          agent: agentGroup.agent === 'codex' ? 'codex' : 'claude',
          resumeCommand: s.resumeCommand,
        });
        g.latest = Math.max(g.latest, s.mtimeMs || 0);
      }
    }
  }

  // Sort each group's entries time-desc
  for (const g of groups.values()) {
    g.lives.sort((a, b) => (sessionUpdateTimes.get(b) || 0) - (sessionUpdateTimes.get(a) || 0));
    g.closed.sort((a, b) => b.closedAt - a.closedAt);
    g.history.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  return groups;
}

// Render a single project entry (collapsed by default)
function renderProjectEntry(p: ProjectEntry, activeId: string | null): void {
  const key = normalizeCwd(p.path);
  // While searching, force-expand matching projects to reveal hits (without mutating persisted
  // collapse state). Clearing the query restores the user's saved expand/collapse state.
  const searching = projectSearchQuery.length > 0;
  const isExpanded = searching ? true : expandedProjects.has(key);

  const isSelected = selectedProjectPath != null && normalizeCwd(selectedProjectPath) === key;
  const row = document.createElement('div');
  row.className = 'nav-project-row' + (isExpanded ? ' expanded' : '') + (isSelected ? ' selected' : '');

  const chevron = document.createElement('span');
  chevron.className = 'nav-project-chevron';
  chevron.textContent = isExpanded ? '▾' : '▸';

  const icon = document.createElement('span');
  icon.className = 'nav-project-icon';
  icon.innerHTML = ICON.folder;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'nav-project-name';
  nameSpan.textContent = projectDisplayName(p);
  nameSpan.title = p.path;

  const actions = document.createElement('span');
  actions.className = 'nav-project-actions';

  const pinBtn = document.createElement('button');
  pinBtn.className = 'nav-project-action' + (p.pinned ? ' active' : '');
  pinBtn.innerHTML = ICON.pin;
  pinBtn.title = p.pinned ? 'Unpin' : 'Pin';
  pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePinProject(p.path); });

  const moreBtn = document.createElement('button');
  moreBtn.className = 'nav-project-action';
  moreBtn.innerHTML = ICON.more;
  moreBtn.title = 'More';
  moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showProjectMenu(e, p); });

  const editBtn = document.createElement('button');
  editBtn.className = 'nav-project-action';
  editBtn.innerHTML = ICON.pencil;
  editBtn.title = 'Rename project';
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); renameProject(p.path); });

  const newBtn = document.createElement('button');
  newBtn.className = 'nav-project-action';
  newBtn.innerHTML = ICON.plus;
  newBtn.title = 'New conversation';
  newBtn.addEventListener('click', (e) => { e.stopPropagation(); showAgentPicker(e, p.path); });

  actions.appendChild(pinBtn);
  actions.appendChild(moreBtn);
  actions.appendChild(editBtn);
  actions.appendChild(newBtn);

  row.appendChild(chevron);
  row.appendChild(icon);
  row.appendChild(nameSpan);
  row.appendChild(actions);

  // Chevron toggles collapse/expand only (without changing selection)
  chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expandedProjects.has(key)) {
      setProjectExpanded(key, false);
    } else {
      setProjectExpanded(key, true);
      if (!backendProjects.has(key) && !projectsDataLoading) void refreshProjectsData();
    }
    renderSessionList();
  });

  // Clicking the row selects the project (drives the RIGHT file panel) and expands it.
  row.addEventListener('click', () => {
    selectProject(p.path);
  });

  sessionList.appendChild(row);

  if (!isExpanded) return;

  // Expanded: sessions grouped by agent
  const groups = collectProjectSessions(p.path);
  if (groups.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'nav-project-empty';
    empty.textContent = 'No conversations yet';
    sessionList.appendChild(empty);
    return;
  }

  // Order agent groups by most-recent activity desc
  const sortedFamilies = Array.from(groups.keys()).sort(
    (a, b) => (groups.get(b)!.latest) - (groups.get(a)!.latest)
  );

  for (const family of sortedFamilies) {
    const g = groups.get(family)!;
    const groupKey = `${key}::${family}`;
    // Agent groups are COLLAPSED by default: only expanded if explicitly opened by the user.
    // While searching, auto-expand groups that contain a matching session title.
    const groupCollapsed =
      searching && agentGroupMatchesSearch(g) ? false : !expandedAgentGroups.has(groupKey);
    const count = g.lives.length + g.closed.length + g.history.length;

    const groupHeader = document.createElement('div');
    groupHeader.className = 'nav-agent-header';
    const [tagColor] = getCliTagColors(family);
    groupHeader.style.borderLeftColor = tagColor;

    const gChevron = document.createElement('span');
    gChevron.className = 'nav-agent-chevron';
    gChevron.textContent = groupCollapsed ? '▸' : '▾';

    const gName = document.createElement('span');
    gName.className = 'nav-agent-name';
    gName.textContent = family;

    const gCount = document.createElement('span');
    gCount.className = 'nav-agent-count';
    gCount.textContent = String(count);

    groupHeader.appendChild(gChevron);
    groupHeader.appendChild(gName);
    groupHeader.appendChild(gCount);
    groupHeader.addEventListener('click', () => {
      setAgentGroupExpanded(groupKey, !expandedAgentGroups.has(groupKey));
      renderSessionList();
    });
    sessionList.appendChild(groupHeader);

    if (groupCollapsed) continue;

    for (const id of g.lives) sessionList.appendChild(buildLiveSessionRow(id, activeId));
    for (const cs of g.closed) sessionList.appendChild(buildClosedSessionRow(cs));
    for (const s of g.history) sessionList.appendChild(buildHistorySessionRow(s));
  }
}

function renderSessionList(): void {
  const activeId = termManager.getActiveId();

  // Sync session status to the main process (read by the mobile client)
  syncSessionStatusToMain();

  // If a title is being edited, check whether the input is still in the DOM
  if (editingTitleId) {
    const existingInput = sessionList.querySelector(`input[data-session-id="${editingTitleId}"]`) as HTMLInputElement | null;
    if (existingInput && document.activeElement === existingInput) {
      // Currently editing; skip rendering to preserve the edit state
      return;
    }
    editingTitleId = null;
  }
  sessionList.innerHTML = '';

  const pinned = sortProjects(projects.filter(p => p.pinned && projectMatchesSearch(p)));
  const rest = sortProjects(projects.filter(p => !p.pinned && projectMatchesSearch(p)));

  // ========== Pinned section ==========
  if (pinned.length > 0) {
    const header = document.createElement('div');
    header.className = 'nav-section-header';
    const label = document.createElement('span');
    label.className = 'nav-section-label';
    label.textContent = 'Pinned';
    header.appendChild(label);
    sessionList.appendChild(header);
    for (const p of pinned) renderProjectEntry(p, activeId);
  }

  // ========== Projects section ==========
  const header = document.createElement('div');
  header.className = 'nav-section-header';
  const label = document.createElement('span');
  label.className = 'nav-section-label';
  label.textContent = 'Projects';

  const actions = document.createElement('span');
  actions.className = 'nav-section-actions';

  const collapseAllBtn = document.createElement('button');
  collapseAllBtn.className = 'nav-section-action';
  collapseAllBtn.innerHTML = ICON.collapse;
  collapseAllBtn.title = 'Collapse all';
  collapseAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    expandedProjects.clear();
    expandedAgentGroups.clear();
    saveExpandState();
    renderSessionList();
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'nav-section-action';
  refreshBtn.innerHTML = ICON.refresh;
  refreshBtn.title = 'Refresh projects';
  refreshBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void refreshProjectsData();
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'nav-section-action';
  addBtn.innerHTML = ICON.plus;
  addBtn.title = 'Add project';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showAddProjectMenu(e as MouseEvent);
  });

  actions.appendChild(collapseAllBtn);
  actions.appendChild(refreshBtn);
  actions.appendChild(addBtn);
  header.appendChild(label);
  header.appendChild(actions);
  sessionList.appendChild(header);

  if (rest.length === 0 && pinned.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nav-project-empty';
    empty.textContent = projectSearchQuery ? 'No matching projects' : 'Add a project folder to get started';
    sessionList.appendChild(empty);
  } else {
    for (const p of rest) renderProjectEntry(p, activeId);
  }

  // ========== Chat sessions (project-independent) ==========
  if (chatSessionTitles.size > 0) {
    const chatHeader = document.createElement('div');
    chatHeader.className = 'nav-section-header';
    const chatLabel = document.createElement('span');
    chatLabel.className = 'nav-section-label';
    chatLabel.textContent = '💬 Chat';
    chatHeader.appendChild(chatLabel);
    sessionList.appendChild(chatHeader);

    const sortedChatIds = Array.from(chatSessionTitles.keys()).sort((a, b) =>
      (chatSessionCreateTimes.get(b) || 0) - (chatSessionCreateTimes.get(a) || 0)
    );

    for (const id of sortedChatIds) {
      const title = chatSessionTitles.get(id)! || '';
      const item = document.createElement('div');
      item.className = 'nav-session' + (id === activeChatId ? ' active' : '');
      item.dataset.sessionId = id;
      item.dataset.sessionType = 'chat';

      const dot = document.createElement('span');
      dot.className = 'nav-session-dot';
      dot.style.backgroundColor = '#a78bfa';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'nav-session-title';
      titleSpan.textContent = title || 'New Chat';
      titleSpan.style.opacity = title ? '1' : '0.6';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'nav-session-time';
      timeSpan.textContent = relativeTimeShort(chatSessionCreateTimes.get(id) || Date.now());

      const delBtn = document.createElement('button');
      delBtn.className = 'nav-session-action';
      delBtn.textContent = '×';
      delBtn.title = 'Delete chat';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); void handleChatCloseClick(id); });

      item.appendChild(dot);
      item.appendChild(titleSpan);
      item.appendChild(timeSpan);
      item.appendChild(delBtn);
      item.addEventListener('click', () => { switchToTerminal(); switchToChat(id); });
      sessionList.appendChild(item);
    }
  }

  // ========== Closed chat sessions (resumable) ==========
  if (closedChatSessions.length > 0) {
    const header2 = document.createElement('div');
    header2.className = 'nav-section-header';
    const label2 = document.createElement('span');
    label2.className = 'nav-section-label';
    label2.textContent = `💬 Closed Chats (${closedChatSessions.length})`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'nav-section-action';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear all';
    clearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      closedChatSessions = await window.posse.closedChatClear();
      renderSessionList();
    });
    header2.appendChild(label2);
    header2.appendChild(clearBtn);
    sessionList.appendChild(header2);

    const sorted = [...closedChatSessions].sort((a, b) => b.closedAt - a.closedAt);
    for (const cs of sorted) {
      const item = document.createElement('div');
      item.className = 'nav-session nav-session-closed';

      const dot = document.createElement('span');
      dot.className = 'nav-session-dot';
      dot.style.backgroundColor = '#a78bfa';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'nav-session-title';
      titleSpan.textContent = cs.title || 'New Chat';
      titleSpan.style.opacity = cs.title ? '1' : '0.6';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'nav-session-time';
      timeSpan.textContent = relativeTimeShort(cs.closedAt);

      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'nav-session-action';
      resumeBtn.textContent = '↩';
      resumeBtn.title = 'Resume chat';
      resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); restoreClosedChatSession(cs); });

      const delBtn = document.createElement('button');
      delBtn.className = 'nav-session-action';
      delBtn.textContent = '×';
      delBtn.title = 'Delete record';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closedChatSessions = await window.posse.closedChatRemove(cs.id);
        renderSessionList();
      });

      item.appendChild(dot);
      item.appendChild(titleSpan);
      item.appendChild(timeSpan);
      item.appendChild(resumeBtn);
      item.appendChild(delBtn);
      item.addEventListener('click', () => { restoreClosedChatSession(cs); });
      sessionList.appendChild(item);
    }
  }
}

// ========== Project / agent-picker menus ==========

function dismissNavMenus(): void {
  document.querySelectorAll('.nav-popup-menu').forEach(m => m.remove());
}

function showProjectMenu(e: MouseEvent, p: ProjectEntry): void {
  dismissNavMenus();
  const menu = document.createElement('div');
  menu.className = 'term-context-menu nav-popup-menu';
  const items: Array<{ label: string; action: () => void }> = [
    { label: 'New conversation', action: () => showAgentPicker(e, p.path) },
    { label: p.pinned ? 'Unpin' : 'Pin', action: () => togglePinProject(p.path) },
    { label: 'Rename', action: () => renameProject(p.path) },
    { label: 'Reveal in Finder', action: () => window.posse.openFolder(p.path) },
    { label: 'Remove project', action: () => removeProject(p.path) },
  ];
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); it.action(); });
    menu.appendChild(el);
  }
  positionNavMenu(menu, e);
}

// "+" on the Projects header → dropdown to add a project. Both options open the native folder
// picker; "Start from scratch" is intended for a fresh empty folder, "Use an existing folder"
// for one with existing work. Both add the picked folder to the persisted project list.
function showAddProjectMenu(e: MouseEvent): void {
  dismissNavMenus();
  const menu = document.createElement('div');
  menu.className = 'term-context-menu nav-popup-menu';
  const items: Array<{ label: string; action: () => Promise<void> }> = [
    {
      label: 'Start from scratch',
      action: async () => {
        const folder = await window.posse.selectFolder(currentCwd || undefined);
        if (folder) { addProject(folder); selectProject(folder); void refreshProjectsData(); }
      },
    },
    {
      label: 'Use an existing folder',
      action: async () => {
        const folder = await window.posse.selectFolder(currentCwd || undefined);
        if (folder) { addProject(folder); selectProject(folder); void refreshProjectsData(); }
      },
    },
  ];
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = it.label;
    el.addEventListener('click', () => { menu.remove(); void it.action(); });
    menu.appendChild(el);
  }
  positionNavMenu(menu, e);
}

// Build the agent option list (built-ins + custom presets) for the new-conversation picker
function getAgentPickerOptions(): Array<{ label: string; command: string }> {
  const opts: Array<{ label: string; command: string }> = [
    { label: 'Claude Code', command: 'claude --dangerously-skip-permissions' },
    { label: 'Codex', command: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"' },
    { label: 'Copilot', command: 'copilot --allow-all --autopilot' },
    { label: 'Kiro', command: 'kiro-cli chat --trust-all-tools' },
  ];
  for (const cp of getCustomPresets()) {
    const command = cp.autoFlag ? `${cp.command} ${cp.autoFlag}` : cp.command;
    const label = cp.autoFlag ? `${cp.name} (auto)` : cp.name;
    opts.push({ label, command });
  }
  opts.push({ label: 'Empty Terminal', command: '' });
  return opts;
}

function showAgentPicker(e: MouseEvent, projPath: string): void {
  dismissNavMenus();
  const menu = document.createElement('div');
  menu.className = 'term-context-menu nav-popup-menu';
  for (const opt of getAgentPickerOptions()) {
    const el = document.createElement('div');
    el.className = 'term-context-item';
    el.textContent = opt.label;
    el.addEventListener('click', () => {
      menu.remove();
      void createSessionInProject(projPath, opt.command);
    });
    menu.appendChild(el);
  }
  positionNavMenu(menu, e);
}

function positionNavMenu(menu: HTMLElement, e: MouseEvent): void {
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);
  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

// Create a new terminal in a project's cwd with the given preset command (mirrors createSession bookkeeping)
async function createSessionInProject(cwd: string, presetCommand: string): Promise<void> {
  if (!cwd) return;
  addRecentCwd(cwd);
  const themeId = resolveThemeId(currentThemeId, cwd);
  const result = await window.posse.createPty(cwd, presetCommand, themeId);
  const now = Date.now();
  attachPtySession(result, now);

  // Custom preset: override the backend fallback with the user-defined name
  const customPreset = getCustomPresets().find(p =>
    presetCommand === p.command || (p.autoFlag && presetCommand === p.command + ' ' + p.autoFlag)
  );
  if (customPreset) {
    const isAuto = customPreset.autoFlag && presetCommand === customPreset.command + ' ' + customPreset.autoFlag;
    sessionDisplayNames.set(result.id, isAuto ? customPreset.name + ' auto' : customPreset.name);
  }

  // Ensure the project is registered, selected & expanded so the new session is visible
  if (!findProject(cwd)) {
    projects.push({ path: cwd, pinned: false, addedAt: now });
    saveProjects();
  }
  setProjectExpanded(normalizeCwd(cwd), true);
  selectedProjectPath = cwd;

  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.posse.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
  // A fresh agent run writes its on-disk session file shortly after spawn; the daemon resolves the
  // uuid asynchronously. Re-sync the live -> agent-id map a few seconds later so the new live session
  // dedups against its own (now-discoverable) history row instead of showing twice.
  setTimeout(() => { void refreshProjectsData(); }, 7000);
}


// ========== Core operations ==========

function attachPtySession(info: PtySessionInfo, createdAt: number, replayRawBuffer = false): void {
  sessionTitles.set(info.id, info.title);
  sessionThemes.set(info.id, info.themeId);
  sessionUpdateTimes.set(info.id, createdAt);
  sessionCreateTimes.set(info.id, createdAt);
  sessionCwds.set(info.id, info.cwd);
  sessionDisplayNames.set(info.id, info.displayName);
  if (info.provider) sessionProviders.set(info.id, info.provider);
  const attachUuid = info.agentSessionId || info.resumeId;
  if (attachUuid) {
    sessionAgentId.set(info.id, attachUuid);
    sessionResumeId.set(info.id, attachUuid);
  }
  termManager.create(info.id, info.themeId, info.cwd, (data) => { writePtyWithAutoReset(info.id, data); });
  if (replayRawBuffer && info.rawBuffer) {
    termManager.write(info.id, info.rawBuffer);
  }
}

// Extract the agent + session id from a captured resume command, so we can
// verify the on-disk session exists before resuming.
function parseResumeCommand(cmd: string): { agent: string; id: string } | null {
  const c = String(cmd || '').trim();
  let m: RegExpMatchArray | null;
  if ((m = c.match(/\bclaude\b.*?--resume\s+(\S+)/))) return { agent: 'claude', id: m[1] };
  if ((m = c.match(/\bcodex\b\s+resume\s+(\S+)/))) return { agent: 'codex', id: m[1] };
  if ((m = c.match(/\bcopilot\b.*?--resume\s+(\S+)/))) return { agent: 'copilot', id: m[1] };
  if ((m = c.match(/\bkiro-cli\b.*?--resume-id\s+(\S+)/))) return { agent: 'kiro', id: m[1] };
  return null;
}

// Brief, non-blocking inline notice (bottom-center). Auto-dismisses; used for
// fail-safe events like "this session no longer exists, removed from the list".
let staleToastEl: HTMLDivElement | null = null;
let staleToastTimer: number | null = null;
function showBriefNotice(message: string): void {
  if (!staleToastEl) {
    staleToastEl = document.createElement('div');
    staleToastEl.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'max-width:80vw;padding:8px 14px;border-radius:8px;z-index:99999;' +
      'background:rgba(30,30,30,0.92);color:#eee;font-size:13px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;' +
      'transition:opacity 0.2s;opacity:0;';
    document.body.appendChild(staleToastEl);
  }
  staleToastEl.textContent = message;
  staleToastEl.style.opacity = '1';
  if (staleToastTimer !== null) clearTimeout(staleToastTimer);
  staleToastTimer = window.setTimeout(() => {
    if (staleToastEl) staleToastEl.style.opacity = '0';
  }, 3200);
}

// Returns true if the session is resumable in cwd, OR if it can't be verified
// (fail-open). Only returns false when the agent confirms the session is absent.
async function verifyResumableSession(agent: string, cwd: string, sessionId: string): Promise<boolean> {
  try {
    const res = await window.posse.verifyResumable(agent, cwd, sessionId);
    return res.exists !== false;
  } catch {
    return true;
  }
}

// Resume a closed session
// A title is "meaningful" (worth locking on the daemon) when it is a real, user-recognizable
// label — not empty, not a generic placeholder, and not Claude's replayed "Caveat:" preamble
// (which the daemon's title-ai would otherwise pick up from the resumed buffer).
function isMeaningfulTitle(t: string | undefined | null): boolean {
  if (!t) return false;
  const trimmed = t.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('Caveat:')) return false;
  // A bare session UUID is a fallback id (history/closed rows use the uuid as title when no real
  // label exists), not a real, user-recognizable label — never lock it on the daemon.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return false;
  const placeholders = new Set(['New session', 'New conversation', 'Terminal']);
  return !placeholders.has(trimmed);
}

// Find a live PTY already bound to this agent-session uuid (checks both maps;
// resumed sessions land in sessionResumeId via resumeId fallback). Returns ptyId or null.
function findLivePtyForUuid(uuid: string): string | null {
  if (!uuid) return null;
  for (const [ptyId, agentId] of sessionAgentId) {
    if (agentId === uuid && sessionTitles.has(ptyId)) return ptyId;
  }
  for (const [ptyId, rid] of sessionResumeId) {
    if (rid === uuid && sessionTitles.has(ptyId)) return ptyId;
  }
  return null;
}

async function restoreClosedSession(cs: ClosedSessionInfo): Promise<void> {
  // If this agent conversation is already open as a live PTY, just focus it — never spawn a duplicate.
  if (cs.resumeId) {
    const existing = findLivePtyForUuid(cs.resumeId);
    if (existing) { switchSession(existing); return; }
  }

  const cwd = cs.cwd || sessionCwds.get(termManager.getActiveId() || '') || '';
  const themeId = resolveThemeId(currentThemeId, cwd);

  // Decide between a true resume vs a fresh re-open in the original folder.
  let command: string;
  const hasResume = Boolean(cs.resumeId || cs.resumeCommand);
  if (hasResume) {
    // Prefer the full resume command captured from terminal output, fall back to building one
    command = cs.resumeCommand
      || (cs.presetCommand
        ? `${cs.presetCommand} --resume ${cs.resumeId}`
        : `claude --resume ${cs.resumeId}`);

    // Validate the session still exists in this cwd before resuming, else warn
    // instead of silently spawning a fresh empty session.
    const parsed = parseResumeCommand(command);
    if (parsed && !(await verifyResumableSession(parsed.agent, cwd, parsed.id))) {
      // Definitive not-found: the backing conversation no longer exists. Drop the
      // dead row from the closed list + store instead of leaving it around.
      console.warn(`[posse] Closed session ${cs.id} (resume ${parsed.id}) no longer exists in ${cwd}; removing row.`);
      try { closedSessions = await window.posse.closedSessionsRemove(cs.id); } catch { /* ignore */ }
      renderSessionList();
      showBriefNotice('Session no longer exists — removed from the list.');
      return;
    }
  } else {
    // No resume id: re-open a fresh terminal in the original folder running the
    // original command (or a plain shell when no preset was recorded).
    command = cs.presetCommand || '';
  }

  const result = await window.posse.createPty(cwd, command, themeId);
  const now = Date.now();
  // Pick a displayName that always carries the agent name so the rail shows the agent immediately,
  // before runtime provider detection: prefer the captured displayName, else the spawned command's
  // displayName, else the resume/preset command (which contains 'claude'/'codex'/...).
  const restoredDisplayName =
    cs.displayName || result.displayName || command || cs.resumeCommand || cs.presetCommand || '';
  attachPtySession({ ...result, title: isMeaningfulTitle(cs.title) ? cs.title : result.title, displayName: restoredDisplayName }, now);
  // Record the correlation so a future click on this same conversation dedups to this live PTY.
  if (cs.resumeId) { sessionAgentId.set(result.id, cs.resumeId); sessionResumeId.set(result.id, cs.resumeId); }
  // For a true resume, lock the known-good title on the daemon so its title-ai cannot
  // overwrite it from the replayed buffer (which starts with Claude's "Caveat:" preamble).
  if (cs.resumeId && isMeaningfulTitle(cs.title)) {
    window.posse.renamePty(result.id, cs.title);
  }
  if (cwd) { selectedProjectPath = cwd; setProjectExpanded(normalizeCwd(cwd), true); }

  // Remove from the closed list
  closedSessions = await window.posse.closedSessionsRemove(cs.id);

  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.posse.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
}

// Load the native Claude Code session history for the currently opened directory
async function loadClaudeHistory(cwd: string): Promise<void> {
  if (!cwd) {
    claudeHistorySessions = [];
    claudeHistoryCwd = '';
    renderSessionList();
    return;
  }
  try {
    const list = await window.posse.claudeSessionsList(cwd);
    claudeHistorySessions = list;
    claudeHistoryCwd = cwd;
  } catch {
    claudeHistorySessions = [];
    claudeHistoryCwd = cwd;
  }
  renderSessionList();
}

// One-click resume of a native agent history session (Claude / Codex)
async function resumeAgentSession(s: ClaudeHistorySession): Promise<void> {
  // If this on-disk session is already open as a live PTY, just focus it — never spawn a duplicate.
  const existing = findLivePtyForUuid(s.id);
  if (existing) { switchSession(existing); return; }

  // Validate the on-disk session exists in this cwd before resuming, else warn
  // instead of silently launching a fresh empty session.
  if (!(await verifyResumableSession(s.agent, s.cwd, s.id))) {
    // Definitive not-found: drop this id from the history cache so the dead row
    // disappears instead of being clickable into a failing resume.
    console.warn(`[posse] History session ${s.id} no longer exists in ${s.cwd}; removing row.`);
    claudeHistorySessions = claudeHistorySessions.filter(h => h.id !== s.id);
    removedHistoryKeys.add(conversationKey(s.id));
    renderSessionList();
    showBriefNotice('Session no longer exists — removed from the list.');
    return;
  }

  const themeId = resolveThemeId(currentThemeId, s.cwd);
  const result = await window.posse.createPty(s.cwd, s.resumeCommand, themeId);
  const now = Date.now();
  // Ensure the rail shows the agent immediately: fall back to the resume command (contains the agent
  // name) / s.agent if the spawned displayName is missing, before runtime provider detection.
  const resumedDisplayName = result.displayName || s.resumeCommand || s.agent || '';
  attachPtySession({ ...result, title: isMeaningfulTitle(s.title) ? s.title : result.title, displayName: resumedDisplayName }, now);
  // Record the correlation immediately (we launched via a resume command for s.id) so a second
  // click focuses this session and the history row dedups right away.
  sessionAgentId.set(result.id, s.id);
  sessionResumeId.set(result.id, s.id);
  // Lock the known-good history title on the daemon so its title-ai cannot overwrite it from
  // the replayed buffer (which starts with Claude's "Caveat:" preamble).
  if (isMeaningfulTitle(s.title)) {
    window.posse.renamePty(result.id, s.title);
  }
  if (s.cwd) { selectedProjectPath = s.cwd; setProjectExpanded(normalizeCwd(s.cwd), true); }

  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.posse.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
}

// Resume a closed chat session
async function restoreClosedChatSession(cs: ClosedChatSessionInfo): Promise<void> {
  try {
    const result = await window.posse.chatRestore(cs.id);
    if (!result) return;
    const now = Date.now();
    chatSessionTitles.set(result.id, result.title);
    chatSessionCreateTimes.set(result.id, now);
    // Remove from the closed list
    closedChatSessions = await window.posse.closedChatRemove(cs.id);
    switchToTerminal();
    switchToChat(result.id);
    renderSessionList();
  } catch (e) {
    console.error('Failed to resume chat session:', e);
  }
}

async function createSession(): Promise<boolean> {
  if (!currentCwd) {
    await browseCwd();
    if (!currentCwd) {
      newSessionCreateBtn.textContent = 'Please select a working directory';
      setTimeout(() => { newSessionCreateBtn.textContent = 'Create Terminal'; }, 1500);
      return false;
    }
  }

  addRecentCwd(currentCwd);
  const preset = presetSelect.value;
  const themeId = resolveThemeId(currentThemeId, currentCwd);
  lastPreset = preset;
  localStorage.setItem('posse_preset', preset);
  const result = await window.posse.createPty(currentCwd, preset, themeId);
  const now = Date.now();
  attachPtySession(result, now);
  // Custom preset: override the backend fallback with the user-defined name
  const customPreset = getCustomPresets().find(p =>
    preset === p.command || (p.autoFlag && preset === p.command + ' ' + p.autoFlag)
  );
  if (customPreset) {
    const isAuto = customPreset.autoFlag && preset === customPreset.command + ' ' + customPreset.autoFlag;
    const displayName = isAuto ? customPreset.name + ' auto' : customPreset.name;
    sessionDisplayNames.set(result.id, displayName);
  }
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.posse.resizePty(result.id, dims.cols, dims.rows);
  }, 100);
  return true;
}

function switchSession(id: string): void {
  // Ensure we switch back from the chat view to the terminal view
  switchToTerminal();

  const prev = termManager.getActiveId();
  termManager.switchTo(id);

  // Follow the session's project: align the selected project so the RIGHT file panel + highlight
  // track the terminal the user just switched to.
  const sessCwd = sessionCwds.get(id);
  if (sessCwd) selectedProjectPath = sessCwd;

  // User switched to this session → clear all status indicators (yellow/green → gray)
  const hadUnread = sessionUnread.delete(id);
  const hadBusy = sessionBusy.delete(id);
  const hadWaiting = sessionWaiting.delete(id);
  // Only re-render the list when switching to a different session, to avoid rebuilding the DOM and breaking dblclick
  if (prev !== id || hadUnread || hadBusy || hadWaiting) renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  renderFileStatusbar();
  const dims = termManager.getActiveDimensions();
  if (dims) window.posse.resizePty(id, dims.cols, dims.rows);
}

// Show confirmation when clicking ×
async function handleCloseClick(id: string): Promise<void> {
  const title = sessionTitles.get(id) || 'Terminal';
  const action = await showConfirmDialog(title);
  if (action === 'cancel') return;
  destroySession(id);
}

async function handleChatCloseClick(id: string): Promise<void> {
  const title = chatSessionTitles.get(id) || 'New Chat';
  const action = await showConfirmDialog(title, 'Chat');
  if (action === 'cancel') return;
  destroyChatSession(id);
}

async function closeCurrentSession(): Promise<void> {
  if (document.querySelector('.confirm-overlay')) return;

  if (activeChatId) {
    await handleChatCloseClick(activeChatId);
    return;
  }

  const activeId = termManager.getActiveId();
  if (activeId) await handleCloseClick(activeId);
}

// Fully close the terminal
function clearSessionState(id: string): void {
  sessionTitles.delete(id);
  sessionThemes.delete(id);
  sessionUpdateTimes.delete(id);
  sessionCreateTimes.delete(id);
  sessionUnread.delete(id);
  sessionBusy.delete(id);
  sessionWaiting.delete(id);
  clearTimeout(unreadTimers.get(id));
  unreadTimers.delete(id);
  recentDataBuffer.delete(id);
  sessionTitleLocked.delete(id);
  pinnedSessions.delete(id);
  sessionCwds.delete(id);
  sessionDisplayNames.delete(id);
  sessionProviders.delete(id);
  sessionAgentId.delete(id);
  sessionResumeId.delete(id);
  sessionClaudeProviderIds.delete(id);
  sessionAutoContinue.delete(id);
  sessionAutoSwitchStatus.delete(id);
}

function destroySession(id: string): void {
  window.posse.destroyPty(id);
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

function destroySessions(ids: string[]): void {
  const uniqIds = Array.from(new Set(ids)).filter(id => sessionTitles.has(id));
  if (uniqIds.length === 0) return;
  for (const id of uniqIds) {
    window.posse.destroyPty(id);
    clearSessionState(id);
    termManager.destroy(id);
  }
  saveAutoContinueToStorage();
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

// ========== Chat session management ==========

async function createChatSession(workspace?: string): Promise<void> {
  const ws = workspace || currentCwd || '';
  try {
    const result = await window.posse.chatCreate({ workspace: ws });
    if (!result) return;
    const now = Date.now();
    chatSessionTitles.set(result.id, result.title);
    chatSessionCreateTimes.set(result.id, now);
    switchToChat(result.id);
    renderSessionList();
  } catch (e) {
    console.error('Failed to create chat session:', e);
  }
}

function switchToChat(id: string): void {
  // Hide the terminal area, show the chat area
  terminalContent.style.display = 'none';
  chatContent.style.display = 'flex';
  chatContent.style.flexDirection = 'column';
  chatContent.style.height = '100%';
  chatEmptyState.style.display = 'none';

  // Destroy the old chat view
  if (activeChatId && activeChatId !== id) {
    const oldView = chatViews.get(activeChatId);
    oldView?.destroy();
    chatViews.delete(activeChatId);
  }

  activeChatId = id;

  // Create or restore the chat view
  let view = chatViews.get(id);
  if (!view) {
    view = new ChatView(chatContent, id, {
      onTitleChange: (sessionId, title) => {
        chatSessionTitles.set(sessionId, title);
        renderSessionList();
      },
    });
    chatViews.set(id, view);
  }
  view.focus();
}

function switchToTerminal(): void {
  chatContent.style.display = 'none';
  terminalContent.style.display = '';
  activeChatId = null;
  updateEmptyState();
}

function destroyChatSession(id: string): void {
  window.posse.chatDestroy(id);
  const view = chatViews.get(id);
  view?.destroy();
  chatViews.delete(id);
  chatSessionTitles.delete(id);
  chatSessionCreateTimes.delete(id);
  if (activeChatId === id) {
    activeChatId = null;
    switchToTerminal();
  }
  renderSessionList();
}

async function browseCwd(): Promise<void> {
  cwdBrowseBtn.textContent = 'Selecting...';
  cwdBrowseBtn.setAttribute('disabled', 'true');
  try {
    const folder = await window.posse.selectFolder(currentCwd || undefined);
    if (folder) {
      currentCwd = folder;
      cwdInput.value = folder;
      localStorage.setItem('posse_cwd', folder);
      addRecentCwd(folder);
      startFileWatcher(folder);
      void renderFileTree();
    }
  } catch (error) {
    console.error('Failed to select working directory:', error);
    cwdBrowseBtn.textContent = 'Selection failed';
    setTimeout(() => { cwdBrowseBtn.textContent = 'Browse'; }, 1500);
    return;
  } finally {
    cwdBrowseBtn.removeAttribute('disabled');
    if (cwdBrowseBtn.textContent === 'Selecting...') cwdBrowseBtn.textContent = 'Browse';
  }
}

// ========== File watcher ==========

function startFileWatcher(cwd: string): void {
  globalRecentFiles = [];
  renderFileStatusbar();
  window.posse.filewatcherStart(cwd);
}

// ========== Event bindings ==========

cwdBrowseBtn.addEventListener('click', browseCwd);
cwdOpenBtn.addEventListener('click', () => { if (currentCwd) window.posse.openFolder(currentCwd); });

// Recent working directories dropdown
function renderRecentCwdDropdown(): void {
  cwdRecentDropdown.innerHTML = '';
  const list = getRecentCwds();
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cwd-recent-empty';
    empty.textContent = 'No recent directories';
    cwdRecentDropdown.appendChild(empty);
    return;
  }
  for (const path of list) {
    const item = document.createElement('div');
    item.className = 'cwd-recent-item';
    item.textContent = path;
    item.title = path;
    item.addEventListener('click', () => {
      currentCwd = path;
      cwdInput.value = path;
      localStorage.setItem('posse_cwd', path);
      addRecentCwd(path);
      startFileWatcher(path);
      void renderFileTree();
      cwdRecentDropdown.classList.remove('open');
    });
    cwdRecentDropdown.appendChild(item);
  }
}

cwdRecentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = cwdRecentDropdown.classList.contains('open');
  if (isOpen) {
    cwdRecentDropdown.classList.remove('open');
  } else {
    renderRecentCwdDropdown();
    cwdRecentDropdown.classList.add('open');
  }
});

document.addEventListener('click', () => {
  cwdRecentDropdown.classList.remove('open');
});
cwdRecentDropdown.addEventListener('click', (e) => { e.stopPropagation(); });
cwdInput.addEventListener('change', () => {
  const v = cwdInput.value.trim();
  if (v) {
    currentCwd = v;
    localStorage.setItem('posse_cwd', v);
    addRecentCwd(v);
    startFileWatcher(v);
    void renderFileTree();
  }
});
cwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cwdInput.blur(); });

// ========== Panel collapse/expand and resizing ==========

// Left file-tree collapse/expand
let fileTreeCollapsed = false;
let fileTreeLastWidth = 220;

fileTreeToggle.addEventListener('click', () => {
  fileTreeCollapsed = !fileTreeCollapsed;
  if (fileTreeCollapsed) {
    fileTreeLastWidth = fileTreePanel.offsetWidth;
    fileTreePanel.classList.add('collapsed');
    fileTreeToggle.classList.add('collapsed');
    // File tree is on the right: collapsed \u2192 point left (expand), expanded \u2192 point right (collapse)
    fileTreeToggle.textContent = '\u25C0';
  } else {
    fileTreePanel.style.width = fileTreeLastWidth + 'px';
    fileTreePanel.classList.remove('collapsed');
    fileTreeToggle.classList.remove('collapsed');
    fileTreeToggle.textContent = '\u25B6';
  }
  localStorage.setItem('posse_filetree_collapsed', String(fileTreeCollapsed));
});

// Right sidebar collapse/expand
let sidebarCollapsed = false;
let sidebarLastWidth = 260;

sidebarToggle.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebarLastWidth = sidebar.offsetWidth;
    sidebar.classList.add('collapsed');
    sidebarToggle.classList.add('collapsed');
    // Sessions sidebar is on the left: collapsed \u2192 point right (expand), expanded \u2192 point left (collapse)
    sidebarToggle.textContent = '\u25B6';
  } else {
    sidebar.style.width = sidebarLastWidth + 'px';
    sidebar.classList.remove('collapsed');
    sidebarToggle.classList.remove('collapsed');
    sidebarToggle.textContent = '\u25C0';
  }
  localStorage.setItem('posse_sidebar_collapsed', String(sidebarCollapsed));
});

// Drag to resize width
interface DragState {
  isDragging: boolean;
  panel: HTMLElement | null;
  startX: number;
  startWidth: number;
  minWidth: number;
  maxWidth: number;
}

const dragState: DragState = {
  isDragging: false,
  panel: null,
  startX: 0,
  startWidth: 0,
  minWidth: 0,
  maxWidth: 0
};

// Left file-tree drag
fileTreeResizer.addEventListener('mousedown', (e) => {
  if (fileTreeCollapsed) return;
  e.preventDefault();
  dragState.isDragging = true;
  dragState.panel = fileTreePanel;
  dragState.startX = e.clientX;
  dragState.startWidth = fileTreePanel.offsetWidth;
  dragState.minWidth = 160;
  dragState.maxWidth = 500;
  fileTreeResizer.classList.add('active');
});

// Right sidebar drag
sidebarResizer.addEventListener('mousedown', (e) => {
  if (sidebarCollapsed) return;
  e.preventDefault();
  dragState.isDragging = true;
  dragState.panel = sidebar;
  dragState.startX = e.clientX;
  dragState.startWidth = sidebar.offsetWidth;
  dragState.minWidth = 180;
  dragState.maxWidth = 500;
  sidebarResizer.classList.add('active');
});

document.addEventListener('mousemove', (e) => {
  if (!dragState.isDragging || !dragState.panel) return;
  const deltaX = e.clientX - dragState.startX;
  let newWidth;
  if (dragState.panel === fileTreePanel) {
    // File tree is on the RIGHT, its resizer is on its left edge → drag right shrinks it
    newWidth = dragState.startWidth - deltaX;
  } else {
    // Sessions sidebar is on the LEFT, its resizer is on its right edge → drag right grows it
    newWidth = dragState.startWidth + deltaX;
  }
  newWidth = Math.max(dragState.minWidth, Math.min(dragState.maxWidth, newWidth));
  dragState.panel.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (dragState.isDragging) {
    dragState.isDragging = false;
    fileTreeResizer.classList.remove('active');
    sidebarResizer.classList.remove('active');
    if (dragState.panel === fileTreePanel) {
      localStorage.setItem('posse_filetree_width', String(fileTreePanel.offsetWidth));
    } else if (dragState.panel === sidebar) {
      localStorage.setItem('posse_sidebar_width', String(sidebar.offsetWidth));
    }
    dragState.panel = null;
  }
});

// Restore saved panel state
(function restorePanelStates() {
  const savedFileTreeWidth = localStorage.getItem('posse_filetree_width');
  if (savedFileTreeWidth) {
    fileTreePanel.style.width = savedFileTreeWidth + 'px';
    fileTreeLastWidth = parseInt(savedFileTreeWidth);
  }
  const savedSidebarWidth = localStorage.getItem('posse_sidebar_width');
  if (savedSidebarWidth) {
    sidebar.style.width = savedSidebarWidth + 'px';
    sidebarLastWidth = parseInt(savedSidebarWidth);
  }
  const savedFileTreeCollapsed = localStorage.getItem('posse_filetree_collapsed');
  if (savedFileTreeCollapsed === 'true') {
    fileTreeCollapsed = true;
    fileTreePanel.classList.add('collapsed');
    fileTreeToggle.classList.add('collapsed');
    fileTreeToggle.textContent = '\u25C0';
  }
  const savedSidebarCollapsed = localStorage.getItem('posse_sidebar_collapsed');
  if (savedSidebarCollapsed === 'true') {
    sidebarCollapsed = true;
    sidebar.classList.add('collapsed');
    sidebarToggle.classList.add('collapsed');
    sidebarToggle.textContent = '\u25B6';
  }
})();

fileTreeRefreshBtn.addEventListener('click', () => { void refreshFileTree(true); });

// Directory auto-refresh - refresh every 30 seconds
let fileTreeAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
function startFileTreeAutoRefresh(): void {
  if (fileTreeAutoRefreshTimer) return;
  fileTreeAutoRefreshTimer = setInterval(() => {
    const activeId = termManager.getActiveId();
    if (activeId) {
      void refreshFileTree(true);
    }
  }, 30000);
}
function stopFileTreeAutoRefresh(): void {
  if (fileTreeAutoRefreshTimer) {
    clearInterval(fileTreeAutoRefreshTimer);
    fileTreeAutoRefreshTimer = null;
  }
}
// Start auto-refresh
startFileTreeAutoRefresh();

// Desktop: dragging files onto the terminal area auto-pastes their paths
// Listen at the document level so drops inside xterm are captured too
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer) return;
  // Only handle data that comes from external files
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    terminalArea.classList.add('drag-over');
  }
});

document.addEventListener('dragleave', (e) => {
  if (e.target === document && !terminalArea.contains(e.relatedTarget as Node)) {
    terminalArea.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  terminalArea.classList.remove('drag-over');
  // Only handle data that comes from external files
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const activeId = getActiveSessionId();
  if (!activeId) {
    alert('Please select a terminal session first');
    return;
  }
  const payload = files.map((f) => quotePathForShell(f.path)).join(' ') + ' ';
  writePtyWithAutoReset(activeId, payload);
});

function openNewSessionDialog(cwd?: string): void {
  const targetCwd = (cwd || currentCwd || '').trim();
  cwdInput.value = targetCwd;
  // Setting the value programmatically doesn't fire a change event, so sync currentCwd manually;
  // otherwise terminals created via the group-header "+" would still use the old currentCwd
  if (targetCwd && targetCwd !== currentCwd) {
    currentCwd = targetCwd;
    localStorage.setItem('posse_cwd', targetCwd);
    addRecentCwd(targetCwd);
    startFileWatcher(targetCwd);
    void renderFileTree();
  }
  presetSelect.value = lastPreset || presetSelect.value || '';
  setThemeValue(currentThemeId);
  newSessionOverlay.classList.add('active');
  setTimeout(() => cwdInput.focus(), 0);
}

function closeNewSessionDialog(): void {
  newSessionOverlay.classList.remove('active');
  cwdRecentDropdown.classList.remove('open');
  themeSelect.classList.remove('open');
}

toolbarTerminalClientBtn.addEventListener('click', async () => {
  const url = await window.posse.getTerminalClientUrl();
  await window.posse.openUrl(url);
});

// Remove every locally-attached terminal session (used after a daemon restart,
// when all live PTYs are gone but saved as resumable history).
function clearAllLocalSessions(): void {
  for (const id of Array.from(sessionTitles.keys())) {
    clearSessionState(id);
    termManager.destroy(id);
  }
  saveAutoContinueToStorage();
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
}

// Graceful daemon restart: confirm inline, save+restart, then refresh navigator.
if (toolbarRestartDaemonBtn) {
  let restartConfirmArmed = false;
  let restartConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  const restartDefaultLabel = 'Restart daemon';

  const disarmRestartConfirm = (): void => {
    restartConfirmArmed = false;
    if (restartConfirmTimer) { clearTimeout(restartConfirmTimer); restartConfirmTimer = null; }
    if (toolbarRestartDaemonBtn) toolbarRestartDaemonBtn.textContent = restartDefaultLabel;
  };

  toolbarRestartDaemonBtn.addEventListener('click', async () => {
    if (!restartConfirmArmed) {
      // First click: arm an inline confirm (live terminals close but are saved as resumable).
      restartConfirmArmed = true;
      toolbarRestartDaemonBtn.textContent = 'Click again to restart';
      restartConfirmTimer = setTimeout(disarmRestartConfirm, 4000);
      return;
    }
    disarmRestartConfirm();

    toolbarRestartDaemonBtn.disabled = true;
    toolbarRestartDaemonBtn.textContent = 'Restarting…';
    try {
      const result = await window.posse.daemonRestart();
      if (result.ok) {
        // Live sessions are gone; drop their terminals locally, then re-pull
        // daemon sessions (now empty) and refresh the saved-session history.
        clearAllLocalSessions();
        await restoreDaemonSessions();
        await refreshProjectsData();
      } else {
        console.error('[Renderer] Daemon restart failed:', result.error);
        toolbarRestartDaemonBtn.textContent = 'Restart failed';
        setTimeout(() => { if (toolbarRestartDaemonBtn) toolbarRestartDaemonBtn.textContent = restartDefaultLabel; }, 3000);
        return;
      }
    } catch (error) {
      console.error('[Renderer] Daemon restart error:', error);
      toolbarRestartDaemonBtn.textContent = 'Restart failed';
      setTimeout(() => { if (toolbarRestartDaemonBtn) toolbarRestartDaemonBtn.textContent = restartDefaultLabel; }, 3000);
      return;
    } finally {
      toolbarRestartDaemonBtn.disabled = false;
    }
    toolbarRestartDaemonBtn.textContent = restartDefaultLabel;
  });
}

// Main process signals a completed daemon restart (e.g. triggered elsewhere):
// drop stale local terminals and re-pull the now-empty live session list.
window.posse.onDaemonRestarted(() => {
  clearAllLocalSessions();
  void restoreDaemonSessions();
  void refreshProjectsData();
});
newSessionCloseBtn.addEventListener('click', () => { closeNewSessionDialog(); });
newSessionCancelBtn.addEventListener('click', () => { closeNewSessionDialog(); });
newSessionOverlay.addEventListener('click', (e) => {
  if (e.target === newSessionOverlay) closeNewSessionDialog();
});
newSessionCreateBtn.addEventListener('click', async () => {
  const ok = await createSession();
  if (ok) closeNewSessionDialog();
});

// Custom preset buttons
presetAddBtn.addEventListener('click', async () => {
  const result = await showPresetDialog();
  if (result) {
    const list = getCustomPresets();
    list.push(result);
    saveCustomPresets(list);
    renderPresetSelect();
    // Auto-select the newly created preset
    presetSelect.value = result.autoFlag ? result.command + ' ' + result.autoFlag : result.command;
  }
});

presetManageBtn.addEventListener('click', () => {
  showPresetManageDialog();
});

// ========== IPC listeners ==========

window.posse.onPtyData((id, data) => {
  termManager.write(id, data);
  if (sessionTitles.has(id)) {
    sessionUpdateTimes.set(id, Date.now());
  }
  // Track status for all sessions (busy/waiting), so the state survives switching away and back
  const activeId = termManager.getActiveId();
  if (sessionTitles.has(id)) {
    // On new output, prefer showing "busy" (yellow dot) and clear the old "pending" (green dot)
    const prevBusy = sessionBusy.has(id);
    const prevUnread = sessionUnread.has(id);
    sessionBusy.add(id);
    sessionUnread.delete(id);
    if (!prevBusy || prevUnread) renderSessionList();

    // Accumulate recent data for prompt detection (keep the last 500 chars)
    const prev = recentDataBuffer.get(id) || '';
    recentDataBuffer.set(id, (prev + data).slice(-500));

    // Detect the AI CLI prompt after stripping ANSI escapes
    // Improvement: only match real prompts, excluding false positives like HTML tags
    const plain = recentDataBuffer.get(id)!.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    // When the loop is on, auto-confirm the CLI's various confirmation prompts (proceed / make this edit / etc.)
    const acConfig = sessionAutoContinue.get(id);
    let autoAgreeFired = false;
    if (acConfig?.enabled && (acConfig.autoAgree ?? true) && /Do you want to .*\?/.test(plain)) {
      autoAgreeFired = true;
      // Count the option lines (format: "  1. xxx", "  2. xxx"...)
      const optionCount = (plain.match(/^\s+\d+\.\s/gm) || []).length;
      // 3 options: 1=Yes, 2=Yes (always), 3=No → choose 2
      // 2 options: 1=Yes, 2=No → choose 1
      const choice = optionCount >= 3 ? '2' : '1';
      const delayMs = (acConfig.autoAgreeDelaySec ?? AUTO_AGREE_DEFAULT_DELAY_SEC) * 1000;
      setTimeout(() => {
        window.posse.writePty(id, choice);
        window.posse.writePty(id, String.fromCharCode(0x0d));
        console.log(`[AutoConfirm] Session ${id} detected ${optionCount} options, choosing ${choice}, delayed ${delayMs}ms`);
      }, delayMs);
      // Clear the buffer to avoid re-triggering
      recentDataBuffer.delete(id);
    }

    // Prompt detection: split by line and check whether the last few lines contain a prompt
    const lines = plain.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    const lastLines = lines.slice(-3).join('\n');

    // Detect "waiting for user decision": the AI paused on an interactive choice (e.g.
    // "Do you want to proceed? 1. Yes 2. No"). Best-effort heuristic — can have false
    // positives/negatives across different CLIs.
    const recentLines = lines.slice(-6).join('\n');
    const decisionPrompt =
      /Do you want to .*\?/.test(plain) ||
      (/^\s*❯?\s*\d+\.\s/m.test(recentLines) && /\?/.test(recentLines));
    if (decisionPrompt && !autoAgreeFired) {
      // Awaiting the user's decision (and NOT being auto-handled). Waiting takes priority
      // over busy/unread.
      clearTimeout(unreadTimers.get(id));
      unreadTimers.delete(id);
      const wasWaiting = sessionWaiting.has(id);
      sessionWaiting.add(id);
      const wasBusy = sessionBusy.delete(id);
      const wasUnread = sessionUnread.delete(id);
      if (!wasWaiting || wasBusy || wasUnread) renderSessionList();
      return;
    }
    // New output that is not a decision prompt → leave the waiting state before normal logic runs
    sessionWaiting.delete(id);
    // Exclude Claude Code's busy state: spinner patterns like xxx… (xxx)
    const cliWorking = /\w+…\s*\(/.test(lastLines);
    // Shell prompt
    const promptLike = /(^|[\s\n])(❯|›|▷|\$|>|%|➜)\s*$/.test(lastLines) && !/>\s*[a-zA-Z]/.test(lastLines);
    const shellPrompt = /[\]#$%>❯›]\s*$/.test(lastLines);
    const hasPrompt = (promptLike || shellPrompt) && !cliWorking;

    if (hasPrompt) {
      // Prompt detected → move from busy to waiting-for-input (yellow → green/gray)
      clearTimeout(unreadTimers.get(id));
      unreadTimers.delete(id);
      recentDataBuffer.delete(id);
      const wasBusy = sessionBusy.delete(id);
      const hadUnread = sessionUnread.has(id);
      // The active session goes straight to gray (the user is watching it); inactive sessions are marked pending (green dot)
      if (id !== activeId && !sessionUnread.has(id)) {
        sessionUnread.add(id);
      }
      const nowUnread = sessionUnread.has(id);
      if (wasBusy || hadUnread !== nowUnread) renderSessionList();
    } else {
      // No prompt detected: fall back to an idle timeout (no new output for 15s → yellow → green/gray)
      // Avoids being stuck on the yellow dot forever when the prompt isn't matched
      clearTimeout(unreadTimers.get(id));
      unreadTimers.set(id, setTimeout(() => {
        unreadTimers.delete(id);
        recentDataBuffer.delete(id);
        // Timeout fallback: if still on the yellow dot, switch to green or gray
        if (sessionBusy.has(id)) {
          sessionBusy.delete(id);
          const currentActiveId = termManager.getActiveId();
          if (id !== currentActiveId) {
            sessionUnread.add(id);
          }
          renderSessionList();
        }
      }, 3000));
    }
  }
});

window.posse.onTitleUpdate((id, title) => {
  if (sessionTitleLocked.has(id)) return;
  if (sessionTitles.has(id)) {
    sessionTitles.set(id, title);
    sessionUpdateTimes.set(id, Date.now());
    renderSessionList();
    updateSessionTitleBar();
  }
});

// Chat session title updates (handled globally so they aren't lost when only ChatView listens)
window.posse.onChatTitleUpdate((id, title) => {
  if (chatSessionTitles.has(id)) {
    chatSessionTitles.set(id, title);
    renderSessionList();
  }
});

window.posse.onPtyExit((id) => {
  clearSessionState(id);
  saveAutoContinueToStorage();
  termManager.destroy(id);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
});

// A session was created remotely from mobile; mirror it on the desktop
window.posse.onRemoteCreated((info) => {
  if (sessionTitles.has(info.id)) return;
  const now = Date.now();
  attachPtySession(info, now);
  updateEmptyState();
  renderSessionList();
  updateSessionTitleBar();
  void renderFileTree();
  setTimeout(() => {
    const dims = termManager.getActiveDimensions();
    if (dims) window.posse.resizePty(info.id, dims.cols, dims.rows);
  }, 100);
});

async function restoreDaemonSessions(): Promise<void> {
  try {
    const sessions = await window.posse.getSessions();
    const now = Date.now();
    for (const info of sessions) {
      if (sessionTitles.has(info.id)) continue;
      attachPtySession(info, now, true);
    }
    updateEmptyState();
    renderSessionList();
    updateSessionTitleBar();
    void renderFileTree();
    setTimeout(() => {
      const activeId = termManager.getActiveId();
      const dims = termManager.getActiveDimensions();
      if (activeId && dims) window.posse.resizePty(activeId, dims.cols, dims.rows);
    }, 100);
  } catch (error) {
    console.error('[Renderer] Failed to restore PTY daemon sessions:', error);
  }
}

void restoreDaemonSessions();

// Load the multi-agent project list (Claude/Codex/Kiro/Copilot history + user-added folders) so the
// Projects navigator is populated on launch even before any session is opened.
void refreshProjectsData();

// Remote server info handling: merge pushed/pulled presets
async function handleRemoteServerInfo(info: typeof remoteServerInfo) {
  if (!info) return;
  console.log('[Renderer] Remote server info:', info);
  remoteServerInfo = info;
  renderRemoteServerInfo();
  startPresetSyncTimer();
  
  console.log('[Preset Sync] Remote server started, initiating preset sync');
  await reconcilePresetsWithServer('remote-ready');
}

// Method 1: IPC push (may be lost to a race)
window.posse.onRemoteServerInfo(handleRemoteServerInfo);

// Method 2: the renderer actively pulls after load; server startup and page load both race, so retry briefly.
async function waitForRemoteServerInfo(): Promise<void> {
  for (let i = 0; i < 40 && !remoteServerInfo; i++) {
    const info = await window.posse.getRemoteServerInfo();
    if (info && !remoteServerInfo) {
      await handleRemoteServerInfo(info);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!remoteServerInfo) {
    console.warn('[Preset Sync] Remote server info unavailable after retry, presets may not sync to mobile');
  }
}

void waitForRemoteServerInfo();

// ========== Closed sessions: load on startup + live updates ==========
window.posse.closedSessionsList().then(sessions => {
  closedSessions = sessions;
  renderSessionList();
});
window.posse.onClosedSessionsUpdate((sessions) => {
  closedSessions = sessions;
  renderSessionList();
});

// ========== Closed chat sessions: load on startup + live updates ==========
window.posse.closedChatList().then(sessions => {
  closedChatSessions = sessions;
  renderSessionList();
});
window.posse.onClosedChatUpdate((sessions) => {
  closedChatSessions = sessions;
  renderSessionList();
});

// Auto account-switch status listener
window.posse.onAutoSwitchStatus((id, status, detail) => {
  if (status === 'idle') {
    sessionAutoSwitchStatus.delete(id);
  } else {
    sessionAutoSwitchStatus.set(id, { status, detail });
  }
  renderSessionList();
});

// Auto-continue config: mobile reads the desktop config via the main process
window.posse.onGetAutoContinueConfig((sessionId) => {
  const config = sessionAutoContinue.get(sessionId);
  window.posse.sendAutoContinueConfig(sessionId, config || null);
});

// Auto-continue config: mobile writes the desktop config via the main process
window.posse.onSetAutoContinueConfig((sessionId, config) => {
  if (!config || !hasSessionInUI(sessionId)) return;
  const existing = sessionAutoContinue.get(sessionId) || {
    enabled: false,
    messages: [...AUTO_CONTINUE_DEFAULT_MESSAGES],
    intervalMs: AUTO_CONTINUE_DEFAULT_INTERVAL,
    commandIntervalMs: AUTO_CONTINUE_DEFAULT_COMMAND_INTERVAL,
    lastSendTime: Date.now(),
    autoAgree: true,
    autoAgreeDelaySec: AUTO_AGREE_DEFAULT_DELAY_SEC,
    sendDelaySec: AUTO_CONTINUE_SEND_DELAY_SEC,
    maxDurationMs: AUTO_CONTINUE_DEFAULT_MAX_DURATION,
    enabledAt: 0,
  };
  Object.assign(existing, config);
  existing.lastSendTime = Date.now();
  if (config.enabled && !existing.enabledAt) {
    existing.enabledAt = Date.now();
  }
  sessionAutoContinue.set(sessionId, existing);
  saveAutoContinueToStorage();
  if (existing.enabled) initAutoContinueTimer();
  renderSessionList();
});

// Listen for file changes (attributed to the currently active session)
window.posse.onFileChange((filename) => {
  const idx = globalRecentFiles.indexOf(filename);
  if (idx !== -1) globalRecentFiles.splice(idx, 1);
  globalRecentFiles.unshift(filename);
  if (globalRecentFiles.length > MAX_RECENT_FILES) {
    globalRecentFiles.length = MAX_RECENT_FILES;
  }
  renderFileStatusbar();
});

// Right-click the statusbar → switch editor
fileStatusbar.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  await selectEditor();
});

async function selectEditor(): Promise<void> {
  const editorPath = await window.posse.filewatcherSelectEditor();
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
}

function updateEditorStatusbar(): void {
  const icon = document.getElementById('file-statusbar-icon')!;
  if (currentEditorName) {
    icon.title = `Editor: ${currentEditorName} (right-click to change)`;
  } else {
    icon.title = 'Click to select an editor';
  }
}

function renderFileStatusbar(): void {
  fileStatusbarFiles.innerHTML = '';
  const files = globalRecentFiles;
  if (files.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'file-statusbar-placeholder';
    placeholder.textContent = 'Waiting for file changes...';
    fileStatusbarFiles.appendChild(placeholder);
    return;
  }
  for (const filePath of files) {
    const item = document.createElement('span');
    item.className = 'file-statusbar-item';
    item.textContent = filePath;
    item.title = filePath;
    item.addEventListener('click', async () => {
      if (!currentCwd) return;
      if (!currentEditorName) {
        await selectEditor();
        if (!currentEditorName) return;
      }
      window.posse.filewatcherOpen(currentCwd + '/' + filePath);
    });
    fileStatusbarFiles.appendChild(item);
  }
}

// On startup, if a working directory already exists, start watching it
if (currentCwd) {
  startFileWatcher(currentCwd);
}
void renderFileTree();

// On startup, load the saved editor preference
window.posse.filewatcherGetEditor().then((editorPath) => {
  if (editorPath) {
    currentEditorName = editorPath.split(/[/\\]/).pop()?.replace(/\.(app|exe)$/, '') || editorPath;
    updateEditorStatusbar();
  }
});

// Refresh the relative time display every 60 seconds
setInterval(() => {
  if (sessionTitles.size > 0) renderSessionList();
}, 60000);

// ========== Sidebar arrow-key session switching ==========

// Switch to the previous/next session relative to the active one (skipping non-navigable items like closed ones)
function navigateSession(direction: 'up' | 'down'): void {
  const items = sessionList.querySelectorAll<HTMLElement>('.nav-session');
  if (items.length === 0) return;

  // Collect only navigable items (those with data-session-id; closed/history rows are skipped)
  const navigable = Array.from(items).filter(el => el.dataset.sessionId);
  if (navigable.length === 0) return;

  // Find the active item's index in the navigable list
  let activeIdx = -1;
  for (let i = 0; i < navigable.length; i++) {
    if (navigable[i].classList.contains('active')) {
      activeIdx = i;
      break;
    }
  }

  // Compute the target index
  let targetIdx: number;
  if (activeIdx === -1) {
    targetIdx = direction === 'down' ? 0 : navigable.length - 1;
  } else {
    targetIdx = direction === 'down' ? activeIdx + 1 : activeIdx - 1;
  }

  if (targetIdx < 0 || targetIdx >= navigable.length) return;

  const targetItem = navigable[targetIdx];
  const sessionId = targetItem.dataset.sessionId!;
  const sessionType = targetItem.dataset.sessionType;

  // Trigger the switch
  if (sessionType === 'chat') {
    switchToTerminal();
    switchToChat(sessionId);
  } else {
    switchSession(sessionId);
  }

  // Scroll into view
  targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// renderSessionList tags each session-item with data attributes
// (the PTY and Chat rendering at the end of renderSessionList already wire click handlers;
//  sessionId and sessionType are marked when the DOM is created)

// Global keyboard listener: intercept up/down arrows when the sidebar has focus
sessionList.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateSession(e.key === 'ArrowUp' ? 'up' : 'down');
  }
});

// Make sessionList focusable (required for arrow navigation)
sessionList.setAttribute('tabindex', '0');

window.posse.onCloseCurrentSession(() => {
  void closeCurrentSession();
});

// ========== Mobile Access collapse toggle ==========

const MOBILE_ACCESS_EXPANDED_KEY = 'posse_mobile_access_expanded';
const remoteInfoToggleEl = document.getElementById('remote-info-toggle');
const remoteInfoBodyEl = document.getElementById('remote-info-body');

function applyMobileAccessExpanded(expanded: boolean): void {
  if (!remoteInfoToggleEl || !remoteInfoBodyEl) return;
  remoteInfoToggleEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  remoteInfoBodyEl.hidden = !expanded;
}

if (remoteInfoToggleEl && remoteInfoBodyEl) {
  const stored = localStorage.getItem(MOBILE_ACCESS_EXPANDED_KEY) === 'true';
  applyMobileAccessExpanded(stored);

  remoteInfoToggleEl.addEventListener('click', () => {
    const next = remoteInfoToggleEl.getAttribute('aria-expanded') !== 'true';
    applyMobileAccessExpanded(next);
    localStorage.setItem(MOBILE_ACCESS_EXPANDED_KEY, next ? 'true' : 'false');
    // Re-render so the QR is (re)generated if server info arrived while collapsed.
    if (next) renderRemoteServerInfo();
  });
}

// ========== Footer interactions ==========

// GitHub link
document.getElementById('footer-github')!.addEventListener('click', (e) => {
  e.preventDefault();
  window.posse.openUrl('https://github.com/Fei2-Labs/posse');
});

const appBuildEl = document.getElementById('app-build');
window.posse.getBuildInfo().then((info) => {
  appVersionEl.textContent = `v${info.version} ${info.packaged ? '(release)' : '(dev)'}`;
  if (appBuildEl) {
    let when = info.builtAt;
    try {
      const d = new Date(info.builtAt);
      const p = (n: number) => String(n).padStart(2, '0');
      when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { /* keep ISO */ }
    appBuildEl.textContent = `${info.sha}${info.dirty ? '*' : ''} · ${when}`;
  }
}).catch(() => {
  appVersionEl.textContent = 'v?';
});

// ===== App-wide mood color themes (chrome only; terminal xterm colors are separate) =====
(function initAppThemePicker() {
  type AppTheme = { id: string; name: string; vars: Record<string, string>; term: Record<string, string> };
  const THEMES: AppTheme[] = [
    { id: 'midnight', name: 'Midnight', vars: {
      '--bg-primary': '#0d1117', '--bg-panel': '#11171a', '--bg-sidebar': '#11171a', '--bg-toolbar': '#0f1418',
      '--bg-secondary': '#161d20', '--bg-active': '#16221b', '--text-primary': '#c9d1d1', '--text-secondary': '#6e7a73',
      '--text-muted': '#6e7a73', '--accent-green': '#3fb950', '--accent-green-dim': '#2ea043', '--accent': '#3fb950',
      '--accent-color': '#3fb950', '--border-color': '#1f2a24', '--border-subtle': '#182019', '--hover-bg': '#161d20',
      '--active-bg': '#16221b', '--row-selected': '#16221b', '--danger': '#f85149', '--input-bg': '#161d20', '--text-color': '#c9d1d1' },
      term: { background:'#0d1117', foreground:'#c9d1d1', cursor:'#3fb950', cursorAccent:'#0d1117', selectionBackground:'#264f78',
        black:'#484f58', red:'#ff7b72', green:'#3fb950', yellow:'#d29922', blue:'#58a6ff', magenta:'#bc8cff', cyan:'#39c5cf', white:'#b1bac4',
        brightBlack:'#6e7681', brightRed:'#ffa198', brightGreen:'#56d364', brightYellow:'#e3b341', brightBlue:'#79c0ff', brightMagenta:'#d2a8ff', brightCyan:'#56d4dd', brightWhite:'#f0f6fc' } },
    { id: 'dracula', name: 'Dracula', vars: {
      '--bg-primary': '#1e1f29', '--bg-panel': '#21222c', '--bg-sidebar': '#21222c', '--bg-toolbar': '#191a21',
      '--bg-secondary': '#2a2c38', '--bg-active': '#343746', '--text-primary': '#f8f8f2', '--text-secondary': '#9aa0b5',
      '--text-muted': '#9aa0b5', '--accent-green': '#bd93f9', '--accent-green-dim': '#a87ef0', '--accent': '#bd93f9',
      '--accent-color': '#bd93f9', '--border-color': '#343746', '--border-subtle': '#2a2c38', '--hover-bg': '#2a2c38',
      '--active-bg': '#343746', '--row-selected': '#343746', '--danger': '#ff5555', '--input-bg': '#2a2c38', '--text-color': '#f8f8f2' },
      term: { background:'#282a36', foreground:'#f8f8f2', cursor:'#f8f8f2', cursorAccent:'#282a36', selectionBackground:'#44475a',
        black:'#21222c', red:'#ff5555', green:'#50fa7b', yellow:'#f1fa8c', blue:'#bd93f9', magenta:'#ff79c6', cyan:'#8be9fd', white:'#f8f8f2',
        brightBlack:'#6272a4', brightRed:'#ff6e6e', brightGreen:'#69ff94', brightYellow:'#ffffa5', brightBlue:'#d6acff', brightMagenta:'#ff92df', brightCyan:'#a4ffff', brightWhite:'#ffffff' } },
    { id: 'nord', name: 'Nord', vars: {
      '--bg-primary': '#2e3440', '--bg-panel': '#2b303b', '--bg-sidebar': '#2b303b', '--bg-toolbar': '#272c36',
      '--bg-secondary': '#3b4252', '--bg-active': '#434c5e', '--text-primary': '#eceff4', '--text-secondary': '#a3adbf',
      '--text-muted': '#a3adbf', '--accent-green': '#88c0d0', '--accent-green-dim': '#6fa8b8', '--accent': '#88c0d0',
      '--accent-color': '#88c0d0', '--border-color': '#3b4252', '--border-subtle': '#353b47', '--hover-bg': '#3b4252',
      '--active-bg': '#434c5e', '--row-selected': '#434c5e', '--danger': '#bf616a', '--input-bg': '#3b4252', '--text-color': '#eceff4' },
      term: { background:'#2e3440', foreground:'#d8dee9', cursor:'#88c0d0', cursorAccent:'#2e3440', selectionBackground:'#434c5e',
        black:'#3b4252', red:'#bf616a', green:'#a3be8c', yellow:'#ebcb8b', blue:'#81a1c1', magenta:'#b48ead', cyan:'#88c0d0', white:'#e5e9f0',
        brightBlack:'#4c566a', brightRed:'#bf616a', brightGreen:'#a3be8c', brightYellow:'#ebcb8b', brightBlue:'#81a1c1', brightMagenta:'#b48ead', brightCyan:'#8fbcbb', brightWhite:'#eceff4' } },
    { id: 'solarized', name: 'Solarized', vars: {
      '--bg-primary': '#002b36', '--bg-panel': '#073642', '--bg-sidebar': '#073642', '--bg-toolbar': '#00242e',
      '--bg-secondary': '#0a4250', '--bg-active': '#0d4d5c', '--text-primary': '#eee8d5', '--text-secondary': '#93a1a1',
      '--text-muted': '#93a1a1', '--accent-green': '#2aa198', '--accent-green-dim': '#1f8c84', '--accent': '#2aa198',
      '--accent-color': '#2aa198', '--border-color': '#0f5562', '--border-subtle': '#0a4250', '--hover-bg': '#0a4250',
      '--active-bg': '#0d4d5c', '--row-selected': '#0d4d5c', '--danger': '#dc322f', '--input-bg': '#0a4250', '--text-color': '#eee8d5' },
      term: { background:'#002b36', foreground:'#839496', cursor:'#93a1a1', cursorAccent:'#002b36', selectionBackground:'#073642',
        black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5',
        brightBlack:'#586e75', brightRed:'#cb4b16', brightGreen:'#586e75', brightYellow:'#657b83', brightBlue:'#839496', brightMagenta:'#6c71c4', brightCyan:'#93a1a1', brightWhite:'#fdf6e3' } },
    { id: 'monokai', name: 'Monokai', vars: {
      '--bg-primary': '#1e1f1c', '--bg-panel': '#272822', '--bg-sidebar': '#272822', '--bg-toolbar': '#1a1b16',
      '--bg-secondary': '#34352e', '--bg-active': '#3e3f37', '--text-primary': '#f8f8f2', '--text-secondary': '#a6a28c',
      '--text-muted': '#a6a28c', '--accent-green': '#a6e22e', '--accent-green-dim': '#8fbf28', '--accent': '#a6e22e',
      '--accent-color': '#a6e22e', '--border-color': '#49483e', '--border-subtle': '#34352e', '--hover-bg': '#34352e',
      '--active-bg': '#3e3f37', '--row-selected': '#3e3f37', '--danger': '#f92672', '--input-bg': '#34352e', '--text-color': '#f8f8f2' },
      term: { background:'#272822', foreground:'#f8f8f2', cursor:'#f8f8f2', cursorAccent:'#272822', selectionBackground:'#49483e',
        black:'#272822', red:'#f92672', green:'#a6e22e', yellow:'#f4bf75', blue:'#66d9ef', magenta:'#ae81ff', cyan:'#a1efe4', white:'#f8f8f2',
        brightBlack:'#75715e', brightRed:'#f92672', brightGreen:'#a6e22e', brightYellow:'#f4bf75', brightBlue:'#66d9ef', brightMagenta:'#ae81ff', brightCyan:'#a1efe4', brightWhite:'#f9f8f5' } },
    { id: 'daylight', name: 'Daylight', vars: {
      '--bg-primary': '#ffffff', '--bg-panel': '#f5f6f8', '--bg-sidebar': '#f5f6f8', '--bg-toolbar': '#eceef1',
      '--bg-secondary': '#eceef1', '--bg-active': '#ddf4e3', '--text-primary': '#1f2328', '--text-secondary': '#6e7781',
      '--text-muted': '#6e7781', '--accent-green': '#1a7f37', '--accent-green-dim': '#116329', '--accent': '#1a7f37',
      '--accent-color': '#1a7f37', '--border-color': '#d0d7de', '--border-subtle': '#e1e4e8', '--hover-bg': '#eceef1',
      '--active-bg': '#ddf4e3', '--row-selected': '#ddf4e3', '--danger': '#cf222e', '--input-bg': '#ffffff', '--text-color': '#1f2328' },
      term: { background:'#ffffff', foreground:'#1f2328', cursor:'#1a7f37', cursorAccent:'#ffffff', selectionBackground:'#b6e3ff',
        black:'#24292f', red:'#cf222e', green:'#1a7f37', yellow:'#9a6700', blue:'#0969da', magenta:'#8250df', cyan:'#1b7c83', white:'#6e7781',
        brightBlack:'#57606a', brightRed:'#a40e26', brightGreen:'#1a7f37', brightYellow:'#633c01', brightBlue:'#218bff', brightMagenta:'#a475f9', brightCyan:'#3192aa', brightWhite:'#8c959f' } },
  ];
  const KEY = 'posse_app_theme';
  const select = document.getElementById('app-theme-select') as HTMLSelectElement | null;
  const getStored = (): string => { try { return localStorage.getItem(KEY) || 'midnight'; } catch { return 'midnight'; } };
  const apply = (id: string): void => {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(theme.vars)) root.setProperty(k, v);
    try { termManager.applyTerminalTheme(theme.term); } catch { /* terminals may not exist yet */ }
    try { localStorage.setItem(KEY, theme.id); } catch { /* ignore */ }
    if (select && select.value !== theme.id) select.value = theme.id;
  };
  if (select) {
    select.innerHTML = '';
    for (const t of THEMES) {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      select.appendChild(opt);
    }
    select.value = getStored();
    select.addEventListener('change', () => apply(select.value));
  }
  apply(getStored());
})();
