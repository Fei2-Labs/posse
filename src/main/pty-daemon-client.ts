import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { PtyBackend, PtyBackendEvents, PtySessionSnapshot } from './pty-backend';
import { getPtyDaemonConfigPath, loadOrCreatePtyDaemonConfig, PtyDaemonConfig } from './pty-daemon-config';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class PtyDaemonClient implements PtyBackend {
  private config: PtyDaemonConfig;
  private events: PtyBackendEvents;
  private sessions = new Map<string, PtySessionSnapshot>();
  private ws: WebSocket | null = null;

  private constructor(config: PtyDaemonConfig, events: PtyBackendEvents) {
    this.config = config;
    this.events = events;
  }

  static async connect(events: PtyBackendEvents): Promise<PtyDaemonClient> {
    const config = loadOrCreatePtyDaemonConfig();
    const client = new PtyDaemonClient(config, events);
    if (!await client.isHealthy()) {
      client.startDaemon();
      await client.waitForHealthy();
    }
    await client.refreshSessions();
    client.connectEvents();
    return client;
  }

  async create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): Promise<PtySessionSnapshot> {
    const session = await this.request<PtySessionSnapshot>('POST', '/api/sessions', {
      cwd,
      presetCommand,
      themeId,
      envOverrides: envOverrides || null,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async write(id: string, data: string): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/write`, { data });
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/resize`, { cols, rows });
  }

  async destroy(id: string): Promise<void> {
    await this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
    this.sessions.delete(id);
  }

  getSession(id: string): PtySessionSnapshot | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): PtySessionSnapshot[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async captureResumeFromBuffer(id: string): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/capture-resume`);
    await this.refreshSession(id);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.request('PUT', `/api/sessions/${encodeURIComponent(id)}/title`, { title });
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, title, titleLocked: true });
  }

  async regenerateTitle(id: string): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/regenerate-title`);
    await this.refreshSession(id);
  }

  async setProvider(id: string, provider: string | null): Promise<void> {
    await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/provider`, { provider });
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, provider });
  }

  /**
   * Gracefully restart the daemon: stop the old instance, wait for the port to
   * free, spawn a fresh daemon (new code), then re-establish the event stream.
   * Callers are responsible for persisting resumable session metadata BEFORE
   * calling this, since all live PTY sessions are terminated.
   */
  async restart(): Promise<void> {
    // Tear down the current event stream so reconnect logic doesn't race us.
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.sessions.clear();

    // Ask the old daemon to exit cleanly. It responds 200 then exits shortly.
    try {
      await this.request('POST', '/shutdown');
    } catch {
      // If the daemon is already gone, proceed to wait-for-down.
    }

    await this.waitForDown();
    this.startDaemon();
    await this.waitForHealthy();
    await this.refreshSessions().catch(() => undefined);
    this.connectEvents();
  }

  private async waitForDown(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10000) {
      if (!await this.isHealthy()) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    // Proceed anyway; startDaemon will fail loudly if the port is still bound.
  }

  async refreshSessions(): Promise<PtySessionSnapshot[]> {
    const sessions = await this.request<PtySessionSnapshot[]>('GET', '/api/sessions');
    this.sessions.clear();
    for (const session of sessions) this.sessions.set(session.id, session);
    return sessions;
  }

  async getRawBuffer(id: string): Promise<string> {
    const result = await this.request<{ rawBuffer: string }>('GET', `/api/sessions/${encodeURIComponent(id)}/raw-buffer`);
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, rawBuffer: result.rawBuffer });
    return result.rawBuffer;
  }

  private async refreshSession(id: string): Promise<void> {
    try {
      const session = await this.request<PtySessionSnapshot>('GET', `/api/sessions/${encodeURIComponent(id)}`);
      this.sessions.set(session.id, session);
    } catch {
      this.sessions.delete(id);
    }
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const result = await this.request<{ ok: boolean }>('GET', '/health', undefined, false);
      return result.ok === true;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10000) {
      if (await this.isHealthy()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('PTY daemon did not become ready');
  }

  private startDaemon(): void {
    const daemonScript = path.join(__dirname, 'pty-daemon.js');
    if (!fs.existsSync(daemonScript)) {
      throw new Error(`PTY daemon script not found: ${daemonScript}`);
    }
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        POSSE_PTY_DAEMON_CONFIG: getPtyDaemonConfigPath(),
      },
    });
    child.unref();
  }

  private connectEvents(): void {
    const wsUrl = `ws://127.0.0.1:${this.config.port}/events?token=${encodeURIComponent(this.config.token)}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', (message) => {
      try {
        this.handleEvent(JSON.parse(message.toString()));
      } catch {
        // Ignore malformed daemon events.
      }
    });
    this.ws.on('close', () => {
      this.ws = null;
      setTimeout(() => this.reconnectEvents(), 1000);
    });
    this.ws.on('error', () => {
      // The close handler schedules reconnects.
    });
  }

  private async reconnectEvents(): Promise<void> {
    if (this.ws) return;
    if (!await this.isHealthy()) {
      try {
        this.startDaemon();
        await this.waitForHealthy();
      } catch {
        setTimeout(() => this.reconnectEvents(), 1000);
        return;
      }
    }
    await this.refreshSessions().catch(() => undefined);
    this.connectEvents();
  }

  private handleEvent(event: any): void {
    if (!event || typeof event.type !== 'string' || typeof event.id !== 'string') return;
    if (event.type === 'data' && typeof event.data === 'string') {
      this.events.onData(event.id, event.data);
      return;
    }
    if (event.type === 'rawData' && typeof event.data === 'string') {
      const session = this.sessions.get(event.id);
      if (session) {
        let rawBuffer = session.rawBuffer + event.data;
        if (rawBuffer.length > 131072) rawBuffer = rawBuffer.slice(-131072);
        this.sessions.set(event.id, { ...session, rawBuffer });
      }
      this.events.onRawData?.(event.id, event.data);
      return;
    }
    if (event.type === 'titleUpdate' && typeof event.title === 'string') {
      const session = this.sessions.get(event.id);
      if (session) this.sessions.set(event.id, { ...session, title: event.title });
      this.events.onTitleUpdate(event.id, event.title);
      return;
    }
    if (event.type === 'exit') {
      const session = event.session as PtySessionSnapshot | undefined;
      if (session) this.sessions.set(event.id, session);
      this.events.onExit(event.id, session);
      this.sessions.delete(event.id);
      return;
    }
    if (event.type === 'pasteInput' && typeof event.cwd === 'string') {
      this.events.onPasteInput?.(event.id, event.cwd);
      return;
    }
    if (event.type === 'autoSwitchStatus' && typeof event.status === 'string') {
      this.events.onAutoSwitchStatus?.(event.id, event.status, event.detail);
    }
  }

  private request<T = unknown>(
    method: string,
    pathname: string,
    body?: JsonValue | undefined,
    auth = true,
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.config.port,
        method,
        path: pathname,
        headers: {
          ...(auth ? { Authorization: `Bearer ${this.config.token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`PTY daemon ${method} ${pathname} failed: ${res.statusCode} ${data}`));
            return;
          }
          if (!data) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error(`PTY daemon ${method} ${pathname} timed out`));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
