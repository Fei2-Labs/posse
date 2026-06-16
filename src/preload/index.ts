import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('duocli', {
  // 设置窗口标题
  setWindowTitle: (title: string) => ipcRenderer.send('window:set-title', title),
  onCloseCurrentSession: (cb: () => void) =>
    ipcRenderer.on('app:close-current-session', () => cb()),

  // 创建终端
  createPty: (cwd: string, presetCommand: string, themeId: string, providerEnv?: Record<string, string>) =>
    ipcRenderer.invoke('pty:create', cwd, presetCommand, themeId, providerEnv),

  // 写入数据 (改成 invoke 等待完成)
  writePty: (id: string, data: string) =>
    ipcRenderer.invoke('pty:write', id, data),

  // 调整大小 (改成 invoke 等待完成)
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),

  // 销毁终端
  destroyPty: (id: string) =>
    ipcRenderer.send('pty:destroy', id),

  // 重命名终端
  renamePty: (id: string, title: string) =>
    ipcRenderer.send('pty:rename', id, title),

  // 重新用 AI 生成标题
  regenerateTitle: (id: string) =>
    ipcRenderer.invoke('pty:regenerate-title', id),

  // 获取所有会话
  getSessions: () => ipcRenderer.invoke('pty:sessions'),

  // 选择文件夹
  selectFolder: (currentPath?: string) => ipcRenderer.invoke('dialog:select-folder', currentPath),
  // 读取目录树（用于左侧文件树）
  fileTreeListDir: (dirPath: string) => ipcRenderer.invoke('file-tree:list-dir', dirPath),
  // 读取文件内容（用于右侧只读预览面板）
  readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
  // 同步最近目录到手机端远程服务
  remoteAddRecentCwd: (cwd: string) => ipcRenderer.invoke('remote:add-recent-cwd', cwd),

  // 监听事件
  onPtyData: (cb: (id: string, data: string) => void) =>
    ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),

  onTitleUpdate: (cb: (id: string, title: string) => void) =>
    ipcRenderer.on('pty:title-update', (_e, id, title) => cb(id, title)),

  onPtyExit: (cb: (id: string) => void) =>
    ipcRenderer.on('pty:exit', (_e, id) => cb(id)),

  onRemoteCreated: (cb: (sessionInfo: any) => void) =>
    ipcRenderer.on('pty:remote-created', (_e, info) => cb(info)),

  // 远程服务器连接信息
  onRemoteServerInfo: (cb: (info: { lanUrl: string; token: string; port: number; publicUrl?: string; tunnel?: { running: boolean; url: string; message?: string } }) => void) =>
    ipcRenderer.on('remote:server-info', (_e, info) => cb(info)),
  // 渲染进程主动获取远程服务器信息（解决竞态问题）
  getRemoteServerInfo: () => ipcRenderer.invoke('remote:get-server-info'),

  // 剪贴板图片
  clipboardSaveImage: () => ipcRenderer.invoke('clipboard:save-image'),
  // 剪贴板文件路径
  clipboardGetFilePath: () => ipcRenderer.invoke('clipboard:get-file-path'),

  // 文件监听
  filewatcherStart: (cwd: string) => ipcRenderer.invoke('filewatcher:start', cwd),
  filewatcherStop: () => ipcRenderer.invoke('filewatcher:stop'),
  filewatcherOpen: (filePath: string) => ipcRenderer.invoke('filewatcher:open', filePath),
  filewatcherSelectEditor: () => ipcRenderer.invoke('filewatcher:select-editor'),
  filewatcherGetEditor: () => ipcRenderer.invoke('filewatcher:get-editor'),
  onFileChange: (cb: (filename: string, eventType: string) => void) =>
    ipcRenderer.on('filewatcher:change', (_e, filename, eventType) => cb(filename, eventType)),

  // 在 Finder 中打开目录
  openFolder: (folderPath: string) => ipcRenderer.invoke('shell:open-folder', folderPath),

  // 读取目录内容
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:read-directory', dirPath),

  // 用默认应用打开文件
  openFile: (filePath: string) => ipcRenderer.invoke('shell:open-file', filePath),

  // 打开外部链接
  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getTerminalClientUrl: () => ipcRenderer.invoke('terminal-client:get-url'),

  // AI 配置 API
  aiApplyConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:apply-config', config),
  aiTestConfig: (config: { apiFormat: string; baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:test-config', config),
  aiGetCurrentConfig: () => ipcRenderer.invoke('ai:get-current-config'),
  // 获取 CLI 实际使用的模型提供商
  getCliProvider: (presetCommand: string) => ipcRenderer.invoke('cli:get-provider', presetCommand),

  // Claude 供应商配置
  claudeProvidersList: () => ipcRenderer.invoke('claude-providers:list'),
  claudeProvidersSave: (providers: any[]) => ipcRenderer.invoke('claude-providers:save', providers),

  // Devin 账号管理
  devinAccountsList: () => ipcRenderer.invoke('devin-accounts:list'),
  devinAccountsAdd: (email: string, password: string) => ipcRenderer.invoke('devin-accounts:add', email, password),
  devinAccountsAddBatch: (text: string) => ipcRenderer.invoke('devin-accounts:add-batch', text),
  devinAccountsRemove: (email: string) => ipcRenderer.invoke('devin-accounts:remove', email),
  devinAccountsSwitch: (opts: { email?: string; next?: boolean }) => ipcRenderer.invoke('devin-accounts:switch', opts),
  devinAccountsQuota: () => ipcRenderer.invoke('devin-accounts:quota'),
  devinAccountsQuotaAll: () => ipcRenderer.invoke('devin-accounts:quota-all'),
  devinAccountsQuotaOne: (email: string) => ipcRenderer.invoke('devin-accounts:quota-one', email),
  devinAccountsRotateDevice: () => ipcRenderer.invoke('devin-accounts:rotate-device'),

  // 会话状态同步：renderer → main（供手机端读取）
  syncSessionStatus: (statuses: Record<string, string>) =>
    ipcRenderer.send('session:sync-status', statuses),

  // 催工配置：供 main 进程从 renderer 读写
  onGetAutoContinueConfig: (cb: (sessionId: string) => void) =>
    ipcRenderer.on('auto-continue:get', (_e, sessionId) => cb(sessionId)),
  sendAutoContinueConfig: (sessionId: string, config: any) =>
    ipcRenderer.send('auto-continue:config-reply', sessionId, config),
  onSetAutoContinueConfig: (cb: (sessionId: string, config: any) => void) =>
    ipcRenderer.on('auto-continue:set', (_e, sessionId, config) => cb(sessionId, config)),

  // ========== Chat API ==========
  chatCreate: (opts: { workspace: string; model?: string }) =>
    ipcRenderer.invoke('chat:create', opts),
  chatSend: (sessionId: string, content: string) =>
    ipcRenderer.invoke('chat:send', sessionId, content),
  chatList: () => ipcRenderer.invoke('chat:list'),
  chatMessages: (sessionId: string) =>
    ipcRenderer.invoke('chat:messages', sessionId),
  chatDestroy: (sessionId: string) =>
    ipcRenderer.invoke('chat:destroy', sessionId),
  chatAbort: (sessionId: string) =>
    ipcRenderer.invoke('chat:abort', sessionId),
  chatRename: (sessionId: string, title: string) =>
    ipcRenderer.invoke('chat:rename', sessionId, title),
  chatHealth: () => ipcRenderer.invoke('chat:health'),
  chatProxyStart: () => ipcRenderer.invoke('chat:proxy-start'),
  chatModels: () => ipcRenderer.invoke('chat:models'),
  onChatDelta: (cb: (sessionId: string, text: string) => void) =>
    ipcRenderer.on('chat:delta', (_e, sessionId, text) => cb(sessionId, text)),
  onChatDone: (cb: (sessionId: string, content: string) => void) =>
    ipcRenderer.on('chat:done', (_e, sessionId, content) => cb(sessionId, content)),
  onChatError: (cb: (sessionId: string, error: string) => void) =>
    ipcRenderer.on('chat:error', (_e, sessionId, error) => cb(sessionId, error)),
  onChatTitleUpdate: (cb: (sessionId: string, title: string) => void) =>
    ipcRenderer.on('chat:title-update', (_e, sessionId, title) => cb(sessionId, title)),

  // ========== 已关闭会话 ==========
  closedSessionsList: () => ipcRenderer.invoke('closed-sessions:list'),
  closedSessionsRemove: (id: string) => ipcRenderer.invoke('closed-sessions:remove', id),
  closedSessionsRename: (id: string, title: string) => ipcRenderer.invoke('closed-sessions:rename', id, title),
  closedSessionsClear: () => ipcRenderer.invoke('closed-sessions:clear'),
  onClosedSessionsUpdate: (cb: (sessions: Array<{ id: string; title: string; cwd: string; presetCommand: string; resumeId: string; resumeCommand: string; displayName: string; closedAt: number }>) => void) =>
    ipcRenderer.on('closed-sessions:update', (_e, sessions) => cb(sessions)),

  // ========== 已关闭 Chat 会话 ==========
  closedChatList: () => ipcRenderer.invoke('closed-chat:list'),
  closedChatRemove: (id: string) => ipcRenderer.invoke('closed-chat:remove', id),
  closedChatClear: () => ipcRenderer.invoke('closed-chat:clear'),
  chatRestore: (closedId: string) => ipcRenderer.invoke('chat:restore', closedId),
  onClosedChatUpdate: (cb: (sessions: Array<{ id: string; title: string; model: string; workspace: string; messages: Array<{ role: string; content: string; timestamp: number }>; closedAt: number }>) => void) =>
    ipcRenderer.on('closed-chat-sessions:update', (_e, sessions) => cb(sessions)),

  // 自动切号状态
  onAutoSwitchStatus: (cb: (id: string, status: string, detail?: string) => void) =>
    ipcRenderer.on('pty:auto-switch-status', (_e, id, status, detail) => cb(id, status, detail)),
});
