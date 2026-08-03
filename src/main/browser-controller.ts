import {
  BrowserWindow,
  WebContentsView,
  session,
  shell,
  type Rectangle,
  type Session,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { browserSecurityState, normalizeBrowserUrl } from './browser-url';

const BROWSER_PARTITION = 'persist:posse-browser-default';
const EMPTY_URL = 'about:blank';
const ALLOWED_PERMISSIONS = new Set(['media', 'geolocation', 'notifications']);

export type EmbeddedBrowserBounds = Rectangle & { visible: boolean };

export type EmbeddedBrowserState = {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  security: 'secure' | 'local' | 'insecure' | 'neutral';
  error?: string;
};

export type EmbeddedBrowserPermission = {
  id: string;
  permission: string;
  origin: string;
};

type PendingPermission = {
  ownerId: number;
  contentId: number;
  permission: string;
  origin: string;
  callback: (allowed: boolean) => void;
};

function browserWebPreferences() {
  return {
    partition: BROWSER_PARTITION,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    safeDialogs: true,
  } as const;
}

function originFor(contents: WebContents): string {
  try { return normalizedOrigin(contents.getURL()); }
  catch { return 'Unknown origin'; }
}

function normalizedOrigin(value: string): string {
  try { return new URL(value).origin; }
  catch { return value; }
}

export class EmbeddedBrowserController {
  private readonly owner: BrowserWindow;
  private readonly manager: EmbeddedBrowserManager;
  private readonly view: WebContentsView;
  private readonly popups = new Set<BrowserWindow>();
  private isAttached = false;
  private state: EmbeddedBrowserState = {
    url: '',
    title: 'Browser',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    security: 'neutral',
  };

  constructor(owner: BrowserWindow, manager: EmbeddedBrowserManager) {
    this.owner = owner;
    this.manager = manager;
    this.view = new WebContentsView({ webPreferences: browserWebPreferences() });
    this.view.setBackgroundColor('#ffffff');
    this.manager.registerBrowserContents(this.view.webContents, this);
    this.bindEvents();
  }

  ownerId(): number { return this.owner.webContents.id; }
  contentsId(): number { return this.view.webContents.id; }

  currentState(): EmbeddedBrowserState { return { ...this.state }; }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    if (!bounds.visible || bounds.width < 1 || bounds.height < 1) {
      this.detach();
      return;
    }
    const contentBounds = this.owner.getContentBounds();
    const safeBounds: Rectangle = {
      x: Math.max(0, Math.min(Math.round(bounds.x), contentBounds.width - 1)),
      y: Math.max(0, Math.min(Math.round(bounds.y), contentBounds.height - 1)),
      width: Math.max(1, Math.min(Math.round(bounds.width), contentBounds.width - Math.max(0, Math.round(bounds.x)))),
      height: Math.max(1, Math.min(Math.round(bounds.height), contentBounds.height - Math.max(0, Math.round(bounds.y)))),
    };
    if (!this.isAttached) {
      this.owner.contentView.addChildView(this.view);
      this.isAttached = true;
    }
    this.view.setBounds(safeBounds);
  }

  async navigate(input: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeBrowserUrl(input);
    if (normalized.ok === false) return normalized;
    this.patchState({ error: undefined });
    try {
      await this.view.webContents.loadURL(normalized.url);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The page failed to load.';
      this.patchState({ error: message });
      return { ok: false, error: message };
    }
  }

  goBack(): void {
    if (this.view.webContents.navigationHistory.canGoBack()) this.view.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    if (this.view.webContents.navigationHistory.canGoForward()) this.view.webContents.navigationHistory.goForward();
  }

  reloadOrStop(): void {
    if (this.view.webContents.isLoading()) this.view.webContents.stop();
    else this.view.webContents.reload();
  }

  openDevTools(): void {
    this.view.webContents.openDevTools({ mode: 'detach', activate: true });
  }

  async openExternal(): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeBrowserUrl(this.view.webContents.getURL());
    if (normalized.ok === false) return normalized;
    try {
      await shell.openExternal(normalized.url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'The page could not be opened externally.' };
    }
  }

  sendPermission(request: EmbeddedBrowserPermission): void {
    if (this.owner.isDestroyed()) return;
    this.owner.webContents.send('browser:permission', request);
  }

  async resetToBlank(): Promise<void> {
    for (const popup of Array.from(this.popups)) {
      if (!popup.isDestroyed()) popup.close();
    }
    try { await this.view.webContents.loadURL(EMPTY_URL); }
    catch { /* closing/reset can race with teardown */ }
    this.patchState({ url: '', title: 'Browser', error: undefined, security: 'neutral' });
  }

  destroy(): void {
    this.detach();
    for (const popup of Array.from(this.popups)) {
      if (!popup.isDestroyed()) popup.close();
    }
    this.manager.unregisterBrowserContents(this.view.webContents.id);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  private detach(): void {
    if (!this.isAttached) return;
    this.owner.contentView.removeChildView(this.view);
    this.isAttached = false;
  }

  private bindEvents(): void {
    const contents = this.view.webContents;
    contents.on('did-start-loading', () => this.patchState({ isLoading: true, error: undefined }));
    contents.on('did-stop-loading', () => this.refreshNavigationState());
    contents.on('did-navigate', (_event, url) => this.patchState({ url, security: browserSecurityState(url), error: undefined }));
    contents.on('did-navigate-in-page', (_event, url) => this.patchState({ url, security: browserSecurityState(url), error: undefined }));
    contents.on('page-title-updated', (_event, title) => this.patchState({ title: title || 'Browser' }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.patchState({
        url: validatedURL || contents.getURL(),
        isLoading: false,
        error: errorDescription || `Navigation failed (${errorCode}).`,
      });
    });
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: this.owner,
        show: true,
        width: 860,
        height: 720,
        minWidth: 420,
        minHeight: 360,
        title: 'Posse Browser',
        webPreferences: browserWebPreferences(),
      },
    }));
    contents.on('did-create-window', (popup) => {
      this.popups.add(popup);
      this.manager.registerBrowserContents(popup.webContents, this);
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popup.on('closed', () => {
        this.popups.delete(popup);
        this.manager.unregisterBrowserContents(popup.webContents.id);
      });
    });
  }

  private refreshNavigationState(): void {
    const contents = this.view.webContents;
    const url = contents.getURL();
    this.patchState({
      url: url === EMPTY_URL ? '' : url,
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      security: browserSecurityState(url),
    });
  }

  private patchState(patch: Partial<EmbeddedBrowserState>): void {
    this.state = { ...this.state, ...patch };
    if (this.owner.isDestroyed()) return;
    this.owner.webContents.send('browser:state', this.state);
  }
}

export class EmbeddedBrowserManager {
  private readonly browserSession: Session;
  private readonly controllers = new Map<number, EmbeddedBrowserController>();
  private readonly controllersByContents = new Map<number, EmbeddedBrowserController>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly permissionGrants = new Set<string>();

  constructor() {
    this.browserSession = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.configureSession();
  }

  controllerFor(owner: BrowserWindow): EmbeddedBrowserController {
    const ownerId = owner.webContents.id;
    const existing = this.controllers.get(ownerId);
    if (existing) return existing;
    const controller = new EmbeddedBrowserController(owner, this);
    this.controllers.set(ownerId, controller);
    return controller;
  }

  destroyFor(owner: BrowserWindow): void {
    const ownerId = owner.webContents.id;
    const controller = this.controllers.get(ownerId);
    if (!controller) return;
    this.denyPermissionsForOwner(ownerId);
    controller.destroy();
    this.controllers.delete(ownerId);
  }

  resolvePermission(owner: BrowserWindow, requestId: string, allow: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.ownerId !== owner.webContents.id) return false;
    this.pendingPermissions.delete(requestId);
    if (allow) this.permissionGrants.add(this.permissionKey(pending.origin, pending.permission));
    pending.callback(allow);
    return true;
  }

  async clearProfile(): Promise<void> {
    for (const pending of this.pendingPermissions.values()) pending.callback(false);
    this.pendingPermissions.clear();
    this.permissionGrants.clear();
    await Promise.all(Array.from(this.controllers.values(), controller => controller.resetToBlank()));
    await Promise.all([
      this.browserSession.clearStorageData(),
      this.browserSession.clearCache(),
      this.browserSession.clearAuthCache(),
    ]);
  }

  registerBrowserContents(contents: WebContents, controller: EmbeddedBrowserController): void {
    this.controllersByContents.set(contents.id, controller);
  }

  unregisterBrowserContents(contentsId: number): void {
    this.controllersByContents.delete(contentsId);
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.contentId !== contentsId) continue;
      pending.callback(false);
      this.pendingPermissions.delete(id);
    }
  }

  private configureSession(): void {
    this.browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      if (!contents || !this.controllersByContents.has(contents.id)) return false;
      return this.permissionGrants.has(this.permissionKey(normalizedOrigin(requestingOrigin), permission));
    });
    this.browserSession.setPermissionRequestHandler((contents, permission, callback) => {
      const controller = this.controllersByContents.get(contents.id);
      if (!controller || !ALLOWED_PERMISSIONS.has(permission)) {
        callback(false);
        return;
      }
      const origin = originFor(contents);
      const id = randomUUID();
      this.pendingPermissions.set(id, {
        ownerId: controller.ownerId(),
        contentId: contents.id,
        permission,
        origin,
        callback,
      });
      controller.sendPermission({ id, permission, origin });
    });
    this.browserSession.on('will-download', (_event, item, contents) => {
      if (!this.controllersByContents.has(contents.id)) return;
      item.setSaveDialogOptions({ title: 'Save browser download', defaultPath: item.getFilename() });
    });
  }

  private denyPermissionsForOwner(ownerId: number): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.ownerId !== ownerId) continue;
      pending.callback(false);
      this.pendingPermissions.delete(id);
    }
  }

  private permissionKey(origin: string, permission: string): string {
    return `${origin}\n${permission}`;
  }
}

export { BROWSER_PARTITION };
