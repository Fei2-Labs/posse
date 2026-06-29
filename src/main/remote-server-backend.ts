import WebSocket from 'ws';
import { PtyBackend, PtyBackendEvents, PtySessionSnapshot } from './pty-backend';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Shape returned by the remote-server's `/api/sessions` and `/api/sessions` create
 * endpoints. This is `mapSessionToApi()` in remote-server.ts — a SLIM projection of a
 * PtySessionSnapshot (it intentionally drops buffer/rawBuffer and several title/resume
 * fields). We widen it back into a full PtySessionSnapshot locally, filling the missing
 * fields with safe defaults, so callers see the same shape the local PtyDaemonClient
 * yields.
 */
interface RemoteSessionApi {
  id: string;
  title?: string;
  cwd?: string;
  presetCommand?: string;
  displayName?: string;
  provider?: string | null;
  status?: string;
  createdAt?: number;
  lastActivityMs?: number;
  themeId?: string;
}

export interface RemoteServerBackendOptions {
  /** Base URL of the remote Posse remote-server, e.g. `http://100.x.y.z:9800` or `https://host.tailnet.ts.net`. No trailing slash required. */
  baseUrl: string;
  /** Remote-server access token (the `token` from its config.json). */
  token: string;
  events: PtyBackendEvents;
}

/**
 * `RemoteServerBackend` is the desktop-as-rich-client counterpart to the mobile PWA: it
 * implements the SAME `PtyBackend` interface as the local `PtyDaemonClient`, but instead
 * of talking to a locally-spawned detached daemon, it proxies every call to a REMOTE
 * Posse backend over that backend's `remote-server.ts` HTTP + WS API (token-authed).
 *
 * This makes a remote 24/7 backend a drop-in alternative backend for a window's
 * connection: sessions, scrollback replay and live streaming "just work" over the same
 * protocol the mobile client already uses.
 *
 * Structure deliberately mirrors `pty-daemon-client.ts`:
 *  - a `request<T>()` helper (here using fetch, since the remote may be https/tailscale)
 *  - a synchronous `sessions` Map cache feeding `getSession`/`getAllSessions`
 *  - WS streaming feeding the `PtyBackendEvents`, with reconnect/backoff
 *
 * Protocol gaps: the remote-server has no per-session GET, no raw-buffer endpoint, and no
 * capture-resume / regenerate-title / provider endpoints. Those methods degrade to safe
 * best-effort no-ops (see each method) rather than throwing across the interface.
 *
 * WS model: remote-server binds ONE subscribed session per socket. We therefore open one
 * WS per subscribed session (keyed by id) so each session's `output` frames flow
 * independently into `events.onData`.
 */
export class RemoteServerBackend implements PtyBackend {
  private baseUrl: string;
  private token: string;
  private events: PtyBackendEvents;
  private sessions = new Map<string, PtySessionSnapshot>();
  private remoteViewers = new Map<string, number>();
  /** One WS per subscribed session (remote-server allows one subscription per socket). */
  private sockets = new Map<string, WebSocket>();
  /** Per-session reconnect timers, so dispose() can cancel them. */
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Accumulated rawBuffer per session (from replay + output frames) so getRawBuffer is answerable locally. */
  private rawBuffers = new Map<string, string>();
  private disposed = false;

  constructor(opts: RemoteServerBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.events = opts.events;
  }

  /**
   * Construct + connect: load the current remote session list into the cache and open a
   * stream for each existing session. Mirrors `PtyDaemonClient.connect()`.
   */
  static async connect(opts: RemoteServerBackendOptions): Promise<RemoteServerBackend> {
    const backend = new RemoteServerBackend(opts);
    await backend.refreshSessions().catch(() => undefined);
    for (const id of backend.sessions.keys()) backend.openSocket(id);
    return backend;
  }

  /** Tear down all sockets + timers. The remote daemon keeps running (24/7); this only detaches this client. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const ws of this.sockets.values()) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
  }

  // ===== PtyBackend: lifecycle / mutation =====

  async create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): Promise<PtySessionSnapshot> {
    // remote-server create body uses `providerEnv` (not `envOverrides`) and returns a slim shape.
    const created = await this.request<RemoteSessionApi>('POST', '/api/sessions', {
      cwd,
      presetCommand,
      themeId,
      providerEnv: envOverrides ? (envOverrides as Record<string, JsonValue>) : null,
    });
    const snapshot = this.toSnapshot(created, { cwd, presetCommand, themeId });
    this.sessions.set(snapshot.id, snapshot);
    this.openSocket(snapshot.id);
    return snapshot;
  }

  async write(id: string, data: string): Promise<void> {
    // Prefer the live WS (`input_b64` preserves control chars); fall back to the /key HTTP
    // endpoint, which writes the raw key bytes without appending a newline.
    const ws = this.sockets.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input_b64', data: Buffer.from(data, 'utf-8').toString('base64') }));
      return;
    }
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/key`, { key: data });
  }

  async resize(id: string, cols: number, rows: number, source: 'local' | 'remote' = 'local'): Promise<void> {
    // Mirror PtyDaemonClient: a locally-driven resize yields to an actively-viewing remote
    // viewer so the PTY keeps that viewer's column count.
    if (source === 'local' && (this.remoteViewers.get(id) || 0) > 0) return;
    const ws = this.sockets.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
    // remote-server has no HTTP resize endpoint — resize is WS-only. If the socket isn't
    // open yet the resize is dropped; the next subscribe re-establishes sizing.
  }

  addRemoteViewer(id: string): void {
    this.remoteViewers.set(id, (this.remoteViewers.get(id) || 0) + 1);
  }

  removeRemoteViewer(id: string): void {
    const n = (this.remoteViewers.get(id) || 0) - 1;
    if (n <= 0) this.remoteViewers.delete(id);
    else this.remoteViewers.set(id, n);
  }

  async destroy(id: string): Promise<void> {
    this.closeSocket(id);
    this.sessions.delete(id);
    this.rawBuffers.delete(id);
    await this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.request('PUT', `/api/sessions/${encodeURIComponent(id)}/title`, { title });
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, title, titleLocked: true });
  }

  // ===== PtyBackend: synchronous cache reads =====

  getSession(id: string): PtySessionSnapshot | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): PtySessionSnapshot[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ===== PtyBackend: refresh / buffers =====

  async refreshSessions(): Promise<PtySessionSnapshot[]> {
    const list = await this.request<RemoteSessionApi[]>('GET', '/api/sessions');
    const next = new Map<string, PtySessionSnapshot>();
    for (const api of list) {
      const existing = this.sessions.get(api.id);
      next.set(api.id, this.toSnapshot(api, existing));
    }
    this.sessions = next;
    return this.getAllSessions();
  }

  async getRawBuffer(id: string): Promise<string> {
    // remote-server exposes no raw-buffer HTTP endpoint; the only source of scrollback is
    // the WS `replay` frame we capture on (re)subscribe plus subsequent `output` frames.
    // Return whatever we've accumulated locally. TODO: remote raw-buffer endpoint for full
    // 1MB scrollback parity with the local daemon.
    return this.rawBuffers.get(id) || '';
  }

  // ===== PtyBackend: no remote endpoint (safe best-effort) =====

  async captureResumeFromBuffer(_id: string): Promise<void> {
    // No remote-server endpoint. The remote backend manages its own resume capture; nothing
    // to do from the client side. TODO: remote capture-resume endpoint.
  }

  async regenerateTitle(_id: string): Promise<void> {
    // No remote-server endpoint. TODO: remote regenerate-title endpoint.
  }

  async setProvider(id: string, provider: string | null): Promise<void> {
    // No remote-server endpoint; reflect optimistically in the local cache only.
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, provider });
    // TODO: remote set-provider endpoint.
  }

  /**
   * For a remote backend there is no process to restart — "restart" means re-establish the
   * client view: refetch sessions and re-open all streams. Live remote sessions are
   * untouched (they're 24/7).
   */
  async restart(): Promise<void> {
    for (const id of Array.from(this.sockets.keys())) this.closeSocket(id);
    await this.refreshSessions().catch(() => undefined);
    for (const id of this.sessions.keys()) this.openSocket(id);
  }

  // ===== WS streaming =====

  private openSocket(id: string): void {
    if (this.disposed) return;
    if (this.sockets.has(id)) return;
    const wsUrl = `${this.wsBaseUrl()}/ws?token=${encodeURIComponent(this.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect(id);
      return;
    }
    this.sockets.set(id, ws);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
      } catch {
        // close handler will schedule a reconnect
      }
    });

    ws.on('message', (message) => {
      try {
        this.handleFrame(id, JSON.parse(message.toString()));
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.on('close', () => {
      if (this.sockets.get(id) === ws) this.sockets.delete(id);
      this.scheduleReconnect(id);
    });

    ws.on('error', () => {
      // The close handler schedules reconnects.
    });
  }

  private closeSocket(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(id);
    }
    const ws = this.sockets.get(id);
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
      this.sockets.delete(id);
    }
  }

  private scheduleReconnect(id: string): void {
    if (this.disposed) return;
    // Only reconnect if the session is still believed to exist.
    if (!this.sessions.has(id)) return;
    if (this.reconnectTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      if (this.disposed || !this.sessions.has(id)) return;
      this.openSocket(id);
    }, 1000);
    this.reconnectTimers.set(id, timer);
  }

  private handleFrame(id: string, frame: any): void {
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'replay' && typeof frame.data === 'string') {
      // Initial scrollback tail. Seed the local rawBuffer and replay to the renderer via
      // onRawData if available (so it lands in scrollback restore), else onData.
      this.rawBuffers.set(id, frame.data);
      if (this.events.onRawData) this.events.onRawData(id, frame.data);
      else this.events.onData(id, frame.data);
      return;
    }
    if (frame.type === 'output' && typeof frame.data === 'string') {
      this.appendRawBuffer(id, frame.data);
      this.events.onData(id, frame.data);
      return;
    }
    // `pong` (heartbeat ack) and any other frame types are ignored.
  }

  private appendRawBuffer(id: string, data: string): void {
    const prev = this.rawBuffers.get(id) || '';
    // Cap at the mobile replay tail size; the remote daemon retains the authoritative full
    // scrollback, this local copy is only a best-effort view.
    const MAX_BYTES = 131072;
    let merged = prev + data;
    if (merged.length > MAX_BYTES) {
      let cut = merged.length - MAX_BYTES;
      const nextEsc = merged.indexOf('\x1b', cut);
      if (nextEsc !== -1 && nextEsc - cut < 4096) cut = nextEsc;
      merged = merged.slice(cut);
    }
    this.rawBuffers.set(id, merged);
  }

  // ===== helpers =====

  /** Convert the remote-server's slim session API shape into a full PtySessionSnapshot. */
  private toSnapshot(
    api: RemoteSessionApi,
    base?: Partial<PtySessionSnapshot>,
  ): PtySessionSnapshot {
    return {
      id: api.id,
      buffer: base?.buffer ?? '',
      rawBuffer: this.rawBuffers.get(api.id) ?? base?.rawBuffer ?? '',
      title: api.title ?? base?.title ?? '',
      titleLocked: base?.titleLocked ?? false,
      titleGenerated: base?.titleGenerated ?? false,
      cwd: api.cwd ?? base?.cwd ?? '',
      presetCommand: api.presetCommand ?? base?.presetCommand ?? '',
      themeId: api.themeId ?? base?.themeId ?? 'default',
      provider: api.provider ?? base?.provider ?? null,
      createdAt: api.createdAt ?? base?.createdAt ?? Date.now(),
      lastActivityMs: api.lastActivityMs ?? base?.lastActivityMs ?? api.createdAt ?? base?.createdAt ?? Date.now(),
      resumeId: base?.resumeId ?? null,
      resumeCommand: base?.resumeCommand ?? null,
      agentSessionId: base?.agentSessionId ?? null,
      exitState: base?.exitState,
    };
  }

  // ===== Navigator / filesystem proxying (D2) =====
  // These back the desktop's `projects:list` + `file-tree:*` / `fs:*` IPC when the active
  // connection is THIS remote. They GET/POST the remote-server's `/api/resumable` and
  // `/api/fs/*` routes (token-authed via `request()`), returning the SAME shapes the local
  // IPC handlers return so the renderer renders remote content unchanged.

  /** Remote resumable session history (GET /api/resumable). Mirrors `listResumableSessions`. */
  async listResumable(cwd = ''): Promise<Array<{ id: string; title: string; cwd: string; mtimeMs: number; agent: string; resumeCommand: string }>> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    try {
      return await this.request<Array<{ id: string; title: string; cwd: string; mtimeMs: number; agent: string; resumeCommand: string }>>('GET', `/api/resumable${q}`);
    } catch {
      return [];
    }
  }

  /** List a remote directory (GET /api/fs/list). Mirrors `file-tree:list-dir`. */
  async fsList(dirPath: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
    try {
      return await this.request<Array<{ name: string; path: string; isDir: boolean }>>('GET', `/api/fs/list?path=${encodeURIComponent(dirPath)}`);
    } catch {
      return [];
    }
  }

  /** Read a remote text file (GET /api/fs/read). Mirrors `fs:read-file`'s `{ ok, ... }` shape. */
  async fsRead(filePath: string): Promise<{ ok: boolean; content?: string; size?: number; ext?: string; error?: string }> {
    try {
      const data = await this.request<{ content: string; size: number; ext: string }>('GET', `/api/fs/read?path=${encodeURIComponent(filePath)}`);
      return { ok: true, content: data.content, size: data.size, ext: data.ext };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Read a remote file as a base64 data URL (GET /api/fs/read-base64). Mirrors `fs:read-file-base64`. */
  async fsReadBase64(filePath: string): Promise<{ ok: boolean; dataUrl?: string; size?: number; ext?: string; error?: string }> {
    try {
      const data = await this.request<{ dataUrl: string; size: number; ext: string }>('GET', `/api/fs/read-base64?path=${encodeURIComponent(filePath)}`);
      return { ok: true, dataUrl: data.dataUrl, size: data.size, ext: data.ext };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Write a remote text file (POST /api/fs/write). Mirrors `fs:write-file`. */
  async fsWrite(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.request<{ ok: boolean; error?: string }>('POST', '/api/fs/write', { path: filePath, content });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Write a remote BINARY file from base64 (POST /api/fs/write-base64). Backs the
   * `remote:upload-files` desktop->remote transfer. Uses a long (2min) timeout since a
   * ~50MB upload would exceed the default 10s `request()` budget over Tailscale/ssh -L.
   */
  async fsWriteBase64(filePath: string, dataBase64: string): Promise<{ ok: boolean; error?: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${this.baseUrl}/api/fs/write-base64`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: filePath, dataBase64 }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `write-base64 failed: ${res.status} ${text.slice(0, 200)}` };
      }
      try {
        return JSON.parse(text) as { ok: boolean; error?: string };
      } catch {
        return { ok: false, error: 'write-base64 returned non-JSON' };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** ws:// or wss:// origin derived from the http(s) baseUrl. */
  private wsBaseUrl(): string {
    if (this.baseUrl.startsWith('https://')) return 'wss://' + this.baseUrl.slice('https://'.length);
    if (this.baseUrl.startsWith('http://')) return 'ws://' + this.baseUrl.slice('http://'.length);
    return this.baseUrl;
  }

  private async request<T = unknown>(method: string, pathname: string, body?: Record<string, JsonValue> | undefined): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Remote backend ${method} ${pathname} failed: ${res.status} ${text}`);
      }
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Remote backend ${method} ${pathname} returned non-JSON: ${text.slice(0, 120)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
