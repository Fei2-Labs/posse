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
import { scaleAndClampBrowserBounds, type BrowserRawBounds } from './browser-geometry';
import {
  getRbwLogin,
  getRbwTotp,
  listRbwCredentials,
  matchRbwEntries,
  type CredentialCandidate,
} from './browser-credentials';

const BROWSER_PARTITION = 'persist:posse-browser-default';
const EMPTY_URL = 'about:blank';
const ALLOWED_PERMISSIONS = new Set(['media', 'geolocation', 'notifications']);

export type EmbeddedBrowserBounds = BrowserRawBounds;

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

export type EmbeddedBrowserCredentialCandidate = CredentialCandidate & { token: string };
export type EmbeddedBrowserCredentialList =
  | { ok: true; candidates: EmbeddedBrowserCredentialCandidate[] }
  | { ok: false; code: string };
export type EmbeddedBrowserCredentialAction =
  | { ok: true; status: 'filled' | 'submitted' | 'site-submitted' }
  | { ok: false; code: string };

type PendingPermission = {
  ownerId: number;
  contentId: number;
  permission: string;
  origin: string;
  callback: (allowed: boolean) => void;
};

type CredentialToken = { id: string; origin: string };

const CREDENTIAL_WORLD_ID = 42;

function credentialOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function buildCredentialFillScript(username: string | undefined, password: string | undefined, totp: string | undefined, submit: boolean): string {
  const payload = JSON.stringify({ username, password, totp, submit });
  return `(async () => {
    const payload = ${payload};
    const visible = (node) => {
      if (!(node instanceof HTMLElement) || node.disabled || node.readOnly || (node instanceof HTMLInputElement && node.type === 'hidden')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const byAutocomplete = (value) => inputs.filter((node) => node.autocomplete === value);
    const usernameFields = byAutocomplete('username').concat(inputs.filter((node) => /user|email|login/i.test(node.name + ' ' + node.id + ' ' + node.type)));
    const passwordFields = byAutocomplete('current-password').concat(inputs.filter((node) => node.type === 'password'));
    const otpFields = byAutocomplete('one-time-code').concat(inputs.filter((node) => /otp|one.time|verification|auth/i.test(node.name + ' ' + node.id + ' ' + node.inputMode)));
    const otpField = otpFields.length === 1 ? otpFields[0] : null;
    const otpForm = otpField ? otpField.form : null;
    let siteSubmitted = false;
    const onSubmit = () => { siteSubmitted = true; };
    if (payload.totp !== undefined && otpField && otpForm) otpForm.addEventListener('submit', onSubmit, { capture: true, once: true });
    const setValue = (node, value) => {
      if (!node || value === undefined) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(node, value); else node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    let filled = 0;
    if (payload.username !== undefined && usernameFields[0]) filled += Number(setValue(usernameFields[0], payload.username));
    if (payload.password !== undefined && passwordFields[0]) filled += Number(setValue(passwordFields[0], payload.password));
    if (payload.totp !== undefined && otpFields.length === 1) filled += Number(setValue(otpFields[0], payload.totp));
    if (payload.totp === undefined || otpFields.length !== 1 || !payload.submit) return { status: 'filled', filled };
    await Promise.resolve();
    if (siteSubmitted) return { status: 'site-submitted', filled };
    const form = otpForm;
    const submitButtons = (form ? Array.from(form.querySelectorAll('button,input')) : []).filter((node) => {
      if (!visible(node)) return false;
      const type = node instanceof HTMLButtonElement ? node.type : node.type;
      return type === 'submit' || /verify|continue|sign.?in|log.?in/i.test(node.textContent || node.value || '');
    });
    if (submitButtons.length !== 1) return { status: 'filled', filled };
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit(submitButtons[0]);
    else submitButtons[0].click();
    return { status: siteSubmitted ? 'site-submitted' : 'submitted', filled };
  })()`;
}

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
  private readonly credentialTokens = new Map<string, CredentialToken>();
  private isAttached = false;
  private rawBounds: EmbeddedBrowserBounds | null = null;
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
    this.rawBounds = { ...bounds };
    this.applyRawBounds();
  }

  private applyRawBounds(): void {
    const bounds = this.rawBounds;
    if (!bounds) return;
    const safeBounds = scaleAndClampBrowserBounds(
      bounds,
      this.owner.webContents.getZoomFactor(),
      this.owner.getContentBounds(),
    );
    if (!safeBounds) {
      this.detach();
      return;
    }
    if (!this.isAttached) {
      this.owner.contentView.addChildView(this.view);
      this.isAttached = true;
    }
    this.view.setBounds(safeBounds);
  }

  async navigate(input: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeBrowserUrl(input);
    if (normalized.ok === false) return normalized;
    this.invalidateCredentialTokens();
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
    this.invalidateCredentialTokens();
    for (const popup of Array.from(this.popups)) {
      if (!popup.isDestroyed()) popup.close();
    }
    try { await this.view.webContents.loadURL(EMPTY_URL); }
    catch { /* closing/reset can race with teardown */ }
    this.patchState({ url: '', title: 'Browser', error: undefined, security: 'neutral' });
  }

  destroy(): void {
    this.invalidateCredentialTokens();
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
    this.owner.webContents.on('zoom-changed', () => this.applyRawBounds());
    contents.on('did-start-loading', () => this.patchState({ isLoading: true, error: undefined }));
    contents.on('did-stop-loading', () => this.refreshNavigationState());
    contents.on('did-navigate', (_event, url) => {
      this.invalidateCredentialTokens();
      this.patchState({ url, security: browserSecurityState(url), error: undefined });
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.invalidateCredentialTokens();
      this.patchState({ url, security: browserSecurityState(url), error: undefined });
    });
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

  async listCredentialCandidates(): Promise<EmbeddedBrowserCredentialList> {
    const origin = credentialOrigin(this.view.webContents.getURL());
    if (!origin) return { ok: false, code: 'no-match' };
    const listed = await listRbwCredentials();
    if (!listed.ok) return listed;
    const matched = matchRbwEntries(listed.value, this.view.webContents.getURL());
    if (!matched.ok) return matched;
    this.invalidateCredentialTokens();
    const candidates = matched.value.map((candidate) => {
      const token = randomUUID();
      this.credentialTokens.set(token, { id: candidate.id, origin });
      return { ...candidate, token };
    });
    return { ok: true, candidates };
  }

  async fillLogin(token: string): Promise<EmbeddedBrowserCredentialAction> {
    const target = this.resolveCredentialToken(token);
    if (!target) return { ok: false, code: 'no-match' };
    const secret = await getRbwLogin(target.id);
    if (!secret.ok) return secret;
    const result = await this.executeCredentialFill(secret.value.username, secret.value.password, undefined, false);
    return result;
  }

  async fillTotp(token: string, autoSubmit: boolean): Promise<EmbeddedBrowserCredentialAction> {
    const target = this.resolveCredentialToken(token);
    if (!target) return { ok: false, code: 'no-match' };
    const secret = await getRbwTotp(target.id);
    if (!secret.ok) return secret;
    const result = await this.executeCredentialFill(undefined, undefined, secret.value, autoSubmit);
    const currentOrigin = credentialOrigin(this.view.webContents.getURL());
    if (currentOrigin !== target.origin) return { ok: true, status: 'filled' };
    return result;
  }

  private resolveCredentialToken(token: string): CredentialToken | null {
    if (typeof token !== 'string') return null;
    const target = this.credentialTokens.get(token);
    if (!target || credentialOrigin(this.view.webContents.getURL()) !== target.origin) return null;
    return target;
  }

  private async executeCredentialFill(username: string | undefined, password: string | undefined, totp: string | undefined, submit: boolean): Promise<EmbeddedBrowserCredentialAction> {
    try {
      const result = await this.view.webContents.executeJavaScriptInIsolatedWorld(CREDENTIAL_WORLD_ID, [{
        code: buildCredentialFillScript(username, password, totp, submit),
        url: 'posse://browser-credentials',
      }], true) as { status?: string } | undefined;
      if (result?.status === 'submitted' || result?.status === 'site-submitted') {
        return { ok: true, status: result.status };
      }
      return { ok: true, status: 'filled' };
    } catch {
      return { ok: false, code: 'failed' };
    }
  }

  private invalidateCredentialTokens(): void {
    this.credentialTokens.clear();
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
