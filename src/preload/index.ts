import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('posse', {
  // Set window title
  setWindowTitle: (title: string) => ipcRenderer.send('window:set-title', title),
  onCloseCurrentSession: (cb: () => void) =>
    ipcRenderer.on('app:close-current-session', () => cb()),

  // Create terminal
  createPty: (cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>, useSubscription?: boolean) =>
    ipcRenderer.invoke('pty:create', cwd, presetCommand, themeId, providerEnv, useSubscription),

  // Write data (changed to invoke to await completion)
  writePty: (id: string, data: string) =>
    ipcRenderer.invoke('pty:write', id, data),

  // Resize (changed to invoke to await completion)
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),

  // Destroy terminal
  destroyPty: (id: string) =>
    ipcRenderer.send('pty:destroy', id),

  // Rename terminal
  renamePty: (id: string, title: string) =>
    ipcRenderer.send('pty:rename', id, title),

  // Regenerate title with AI
  regenerateTitle: (id: string) =>
    ipcRenderer.invoke('pty:regenerate-title', id),

  // Get all sessions
  getSessions: () => ipcRenderer.invoke('pty:sessions'),

  // Gracefully restart the background PTY daemon (saves live sessions as resumable first)
  daemonRestart: () => ipcRenderer.invoke('daemon:restart'),

  // Select folder
  selectFolder: (currentPath?: string) => ipcRenderer.invoke('dialog:select-folder', currentPath),
  // Create a new GitHub repo via `gh repo create --clone` and return its local clone path
  projectCreateGithubRepo: (opts: { name: string; visibility: 'private' | 'public'; parentDir: string }) =>
    ipcRenderer.invoke('project:create-github-repo', opts) as Promise<{ ok: boolean; path?: string; error?: string }>,
  // List SSH host aliases from ~/.ssh/config (Phase 1 SSH terminal picker)
  sshListHosts: () => ipcRenderer.invoke('ssh:list-hosts'),
  // Read directory tree (for the left-side file tree)
  fileTreeListDir: (dirPath: string) => ipcRenderer.invoke('file-tree:list-dir', dirPath),
  // Move a file/folder to the OS trash (recoverable)
  fileTreeTrash: (p: string) => ipcRenderer.invoke('file-tree:trash', p),
  // Read file contents (for the right-side read-only preview panel)
  readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
  // Write file contents (for the in-app editable preview)
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:write-file', filePath, content),
  // Read a (binary) file as a base64 data URL — used for image previews
  readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:read-file-base64', filePath),
  // Desktop -> remote upload: native multi-select dialog, then write the picked file(s)
  // into destDir on the active connection (remote over HTTP, or local copy). 50MB/file cap.
  remoteUploadFiles: (args: { destDir: string }) =>
    ipcRenderer.invoke('remote:upload-files', args) as Promise<{ ok: boolean; uploaded: string[]; skipped?: string[]; error?: string }>,
  // Remote -> desktop download: read the file from the active connection, then native save dialog.
  remoteDownloadFile: (args: { remotePath: string }) =>
    ipcRenderer.invoke('remote:download-file', args) as Promise<{ ok: boolean; savedTo?: string; error?: string }>,
  // Resolve the git branch for a cwd (used to annotate the window title). '' when not a git repo.
  gitBranch: (cwd: string) => ipcRenderer.invoke('git:branch', cwd) as Promise<string>,
  // List a directory's native session history in Claude Code
  claudeSessionsList: (cwd: string) => ipcRenderer.invoke('claude-sessions:list', cwd),
  // Projects-first discovery: every AI-CLI session bucketed by project folder
  projectsList: (extra?: { extraFolders?: string[] }) => ipcRenderer.invoke('projects:list', extra),
  // Verify a session id is resumable in the given cwd (warn before a wrong-folder resume)
  verifyResumable: (agent: string, cwd: string, sessionId: string) =>
    ipcRenderer.invoke('session:verify-resumable', agent, cwd, sessionId),
  // Sync recent directories to the mobile remote service
  remoteAddRecentCwd: (cwd: string) => ipcRenderer.invoke('remote:add-recent-cwd', cwd),

  // ========== Session archive / delete (sidebar management) ==========
  // Archive: Posse-internal soft-hide, reversible, does NOT touch agent data.
  sessionSetArchived: (id: string, archived: boolean) =>
    ipcRenderer.invoke('session:set-archived', id, archived),
  sessionListArchived: () => ipcRenderer.invoke('session:list-archived') as Promise<string[]>,
  // Delete: PERMANENT, removes the session from the agent's own backing store.
  sessionDelete: (meta: { id: string; agent: string; sourcePath?: string }) =>
    ipcRenderer.invoke('session:delete', meta) as Promise<{ ok: boolean; error?: string }>,

  // ========== Project path remap (renamed/moved folder → re-attach historical sessions) ==========
  // Map an old recorded cwd → a new folder path so historical sessions re-bucket under the new
  // location. Posse-internal, reversible, never touches agent data.
  projectRemap: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('project:remap', oldPath, newPath) as Promise<{ ok: boolean; error?: string }>,
  projectRemapsList: () =>
    ipcRenderer.invoke('project:remaps:list') as Promise<Record<string, string>>,
  projectRemapRemove: (oldPath: string) =>
    ipcRenderer.invoke('project:remap:remove', oldPath) as Promise<{ ok: boolean; error?: string }>,

  // Event listeners
  onPtyData: (cb: (id: string, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),

  onTitleUpdate: (cb: (id: string, title: string) => void) =>
    ipcRenderer.on('pty:title-update', (_e, id, title) => cb(id, title)),

  onPtyExit: (cb: (id: string) => void) =>
    ipcRenderer.on('pty:exit', (_e, id) => cb(id)),

  onDaemonRestarted: (cb: () => void) =>
    ipcRenderer.on('daemon:restarted', () => cb()),

  onRemoteCreated: (cb: (sessionInfo: any) => void) =>
    ipcRenderer.on('pty:remote-created', (_e, info) => cb(info)),

  // Remote server connection info
  onRemoteServerInfo: (cb: (info: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string }; tailscaleUrl?: string | null; tailscaleHttpUrl?: string | null }) => void) =>
    ipcRenderer.on('remote:server-info', (_e, info) => cb(info)),
  // Renderer proactively fetches remote server info (resolves a race condition)
  getRemoteServerInfo: () => ipcRenderer.invoke('remote:get-server-info'),

  // Clipboard image
  clipboardSaveImage: () => ipcRenderer.invoke('clipboard:save-image'),
  // Clipboard file path
  clipboardGetFilePath: () => ipcRenderer.invoke('clipboard:get-file-path'),

  // File watching
  filewatcherStart: (cwd: string) => ipcRenderer.invoke('filewatcher:start', cwd),
  filewatcherStop: () => ipcRenderer.invoke('filewatcher:stop'),
  filewatcherOpen: (filePath: string) => ipcRenderer.invoke('filewatcher:open', filePath),
  filewatcherSelectEditor: () => ipcRenderer.invoke('filewatcher:select-editor'),
  filewatcherGetEditor: () => ipcRenderer.invoke('filewatcher:get-editor'),
  onFileChange: (cb: (filename: string, eventType: string) => void) =>
    ipcRenderer.on('filewatcher:change', (_e, filename, eventType) => cb(filename, eventType)),

  // Open directory in Finder
  openFolder: (folderPath: string) => ipcRenderer.invoke('shell:open-folder', folderPath),

  // Read directory contents
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:read-directory', dirPath),

  // Open file with default app
  openFile: (filePath: string) => ipcRenderer.invoke('shell:open-file', filePath),

  // Open external link
  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getBuildInfo: () => ipcRenderer.invoke('app:get-build-info'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getTerminalClientUrl: () => ipcRenderer.invoke('terminal-client:get-url'),

  // AI config API
  aiApplyConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:apply-config', config),
  aiTestConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:test-config', config),
  aiGetCurrentConfig: () => ipcRenderer.invoke('ai:get-current-config'),
  // Get the model provider actually used by the CLI
  getCliProvider: (presetCommand: string) => ipcRenderer.invoke('cli:get-provider', presetCommand),

  // Claude provider config
  claudeProvidersList: () => ipcRenderer.invoke('claude-providers:list'),
  claudeProvidersSave: (providers: any[]) => ipcRenderer.invoke('claude-providers:save', providers),

  // Devin account management
  devinAccountsList: () => ipcRenderer.invoke('devin-accounts:list'),
  devinAccountsAdd: (email: string, password: string) => ipcRenderer.invoke('devin-accounts:add', email, password),
  devinAccountsAddBatch: (text: string) => ipcRenderer.invoke('devin-accounts:add-batch', text),
  devinAccountsRemove: (email: string) => ipcRenderer.invoke('devin-accounts:remove', email),
  devinAccountsSwitch: (opts: { email?: string; next?: boolean }) => ipcRenderer.invoke('devin-accounts:switch', opts),
  devinAccountsQuota: () => ipcRenderer.invoke('devin-accounts:quota'),
  devinAccountsQuotaAll: () => ipcRenderer.invoke('devin-accounts:quota-all'),
  devinAccountsQuotaOne: (email: string) => ipcRenderer.invoke('devin-accounts:quota-one', email),
  devinAccountsRotateDevice: () => ipcRenderer.invoke('devin-accounts:rotate-device'),

  // Session status sync: renderer -> main (read by mobile)
  syncSessionStatus: (statuses: Record<string, string>) =>
    ipcRenderer.send('session:sync-status', statuses),

  // Auto-continue config: read/written by the main process from the renderer
  onGetAutoContinueConfig: (cb: (sessionId: string) => void) =>
    ipcRenderer.on('auto-continue:get', (_e, sessionId) => cb(sessionId)),
  sendAutoContinueConfig: (sessionId: string, config: any) =>
    ipcRenderer.send('auto-continue:config-reply', sessionId, config),
  onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) =>
    ipcRenderer.on('auto-continue:set', (_e, sessionId, config) => cb(sessionId, config)),

  // ========== Closed sessions ==========
  closedSessionsList: () => ipcRenderer.invoke('closed-sessions:list'),
  closedSessionsRemove: (id: string) => ipcRenderer.invoke('closed-sessions:remove', id),
  closedSessionsRename: (id: string, title: string) => ipcRenderer.invoke('closed-sessions:rename', id, title),
  closedSessionsClear: () => ipcRenderer.invoke('closed-sessions:clear'),
  onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>) => void) =>
    ipcRenderer.on('closed-sessions:update', (_e, sessions) => cb(sessions)),

  // Chat API (removed — stubs to prevent renderer crash)
  chatCreate: () => Promise.resolve(null),
  chatSend: () => Promise.resolve(),
  chatList: () => Promise.resolve([]),
  chatMessages: () => Promise.resolve([]),
  chatDestroy: () => Promise.resolve(true),
  chatAbort: () => Promise.resolve(true),
  chatRename: () => Promise.resolve(true),
  chatHealth: () => Promise.resolve({ ok: false, error: 'removed' }),
  chatProxyStart: () => Promise.resolve({ ok: false, error: 'removed' }),
  chatModels: () => Promise.resolve([]),
  onChatDelta: () => {},
  onChatDone: () => {},
  onChatError: () => {},
  onChatTitleUpdate: () => {},
  closedChatList: () => Promise.resolve([]),
  closedChatRemove: () => Promise.resolve([]),
  closedChatClear: () => Promise.resolve([]),
  chatRestore: () => Promise.resolve(null),
  onClosedChatUpdate: () => {},

  // Auto account-switch status
  onAutoSwitchStatus: (cb: (id: string, status: string, detail?: string) => void) =>
    ipcRenderer.on('pty:auto-switch-status', (_e, id, status, detail) => cb(id, status, detail)),

  // ========== Connections (D2: remote host add/switch) ==========
  connectionsList: () => ipcRenderer.invoke('connections:list'),
  connectionsAdd: (opts: { label?: string; baseUrl: string; token: string }) =>
    ipcRenderer.invoke('connections:add', opts),
  connectionsBootstrapSshHost: (host: string) =>
    ipcRenderer.invoke('connections:bootstrap-ssh-host', host),
  connectionsRemove: (id: string) => ipcRenderer.invoke('connections:remove', id),
  connectionsSetActive: (id: string) => ipcRenderer.invoke('connections:set-active', id),
  // D3: bind THIS window to a connection (in-window host switch).
  connectionsBindWindow: (id: string) => ipcRenderer.invoke('connections:bind-window', id),
  // D3: open a NEW window bound to a connection ("open host in new window").
  windowOpenWithConnection: (id: string) => ipcRenderer.invoke('window:open-with-connection', id),

  // Claude subscription token (for "use my subscription" remote agent sessions).
  // status never returns the full token — only { set, maskedSuffix }.
  subscriptionTokenStatus: () =>
    ipcRenderer.invoke('subscription-token:status') as Promise<{ set: boolean; maskedSuffix?: string }>,
  subscriptionTokenSet: (token: string) =>
    ipcRenderer.invoke('subscription-token:set', token) as Promise<{ ok: boolean; error?: string; status?: { set: boolean; maskedSuffix?: string } }>,
  subscriptionTokenClear: () =>
    ipcRenderer.invoke('subscription-token:clear') as Promise<{ ok: boolean; error?: string; status?: { set: boolean; maskedSuffix?: string } }>,
  onConnectionChanged: (cb: (id: string) => void) =>
    ipcRenderer.on('connection:changed', (_e, id) => cb(id)),
});
