import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import buildStamp from './build-stamp.json';
import { execFileSync, execSync } from 'child_process';

function resolveAdb(): string {
  try { return execSync('which adb', { encoding: 'utf8' }).trim(); } catch { return 'adb'; }
}
const ADB = resolveAdb();
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import sharp from 'sharp';
import { getDisplayName } from './pty-manager';
import { PtyBackend, PtySessionSnapshot } from './pty-backend';

// App version provider. Electron's main process sets this to `app.getVersion()`;
// the headless backend sets it to the version read from package.json. Keeping this
// injectable is what lets remote-server.ts import NOTHING from 'electron', so the whole
// backend chain can run on a GUI-less server.
let appVersionProvider: () => string = () => {
  // Fallback: read version from the nearest package.json (resolves whether running from
  // dist/main/ in the packaged app or from a bundled headless entry).
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch { /* ignore */ }
  return '0.0.0';
};

/** Override the version reported by /api/server-info. Call before startRemoteServer(). */
export function setAppVersionProvider(provider: () => string): void {
  appVersionProvider = provider;
}

export type RemoteServerInfo = {
  lanUrl: string;
  token: string;
  port: number;
};

export type RemoteConnectionStatus = RemoteServerInfo & {
  connectedClients: number;
  subscribedSessions: number;
};

// Mobile / remote first-paint replay tail size. The daemon retains a much larger rawBuffer (1MB) so desktop
// reconnect can restore full scrollback after a restart, but on weak networks the replay payload directly drives
// first-paint speed, so we only send the last ~128KB to a (re)attaching remote/mobile viewer. This keeps mobile
// first-paint identical to before regardless of how much scrollback the daemon retains.
const MOBILE_REPLAY_TAIL_BYTES = 131072; // 128KB

// Slice the last `maxBytes` of an ANSI stream, advancing the cut point to the next ESC byte so we never start
// replay in the middle of an escape sequence (xterm would otherwise treat following visible chars as broken
// sequence parameters -> torn spinners / garbled first line).
function tailRawBuffer(buf: string, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf;
  let cut = buf.length - maxBytes;
  const nextEsc = buf.indexOf('\x1b', cut);
  if (nextEsc !== -1 && nextEsc - cut < 4096) cut = nextEsc;
  return buf.slice(cut);
}

// Cache ptyManager and callbacks for remote creation (set in startRemoteServer)
let cachedPtyManager: PtyBackend | null = null;
let cachedOnRemoteCreate: ((sessionInfo: any) => void) | null = null;

// Resolve the model provider actually used from the preset command (kept consistent with index.ts)
function getCliProvider(presetCommand: string): string | null {
  const home = os.homedir();

  if (presetCommand.startsWith('claude')) {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = settings.env || {};
        const baseUrl = env.ANTHROPIC_BASE_URL || '';

        if (baseUrl.includes('minimaxi')) return 'MiniMax';
        if (baseUrl.includes('deepseek')) return 'DeepSeek';
        if (baseUrl.includes('zhipu') || baseUrl.includes('bigmodel')) return 'GLM';
        if (baseUrl.includes('cloudflare')) return 'Cloudflare';
        if (baseUrl.includes('anthropic') || !baseUrl) return 'Anthropic';

        if (baseUrl) {
          try {
            const url = new URL(baseUrl);
            return url.hostname.replace(/^api\./, '').split('.')[0].toUpperCase();
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

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

    return 'Anthropic';
  }

  if (presetCommand.startsWith('codex')) {
    return 'OpenAI';
  }

  if (presetCommand.startsWith('copilot')) {
    return 'GitHub Copilot';
  }

  if (presetCommand.startsWith('kimi')) {
    return 'Moonshot';
  }

  if (presetCommand.startsWith('gemini')) {
    return 'Google';
  }

  if (presetCommand.startsWith('opencode')) {
    return 'OpenCode';
  }

  if (presetCommand.startsWith('devin')) {
    return 'Devin';
  }

  if (presetCommand.startsWith('kiro-cli')) {
    return 'Kiro';
  }

  if (presetCommand.startsWith('agent') || presetCommand.includes('cursor')) {
    return 'Cursor';
  }

  return null;
}

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

function resolveSessionDisplayName(presetCommand: string, customPresets: CustomPreset[]): string {
  const displayName = getDisplayName(presetCommand);
  const customPreset = customPresets.find(p =>
    presetCommand === p.command || (p.autoFlag && presetCommand === p.command + ' ' + p.autoFlag)
  );
  return customPreset
    ? (presetCommand === customPreset.command + ' ' + customPreset.autoFlag
        ? customPreset.name + ' (auto)' : customPreset.name)
    : displayName;
}

const PORT = parseInt(process.env.POSSE_REMOTE_PORT || '9800');

/** Kill leftover processes occupying the given port (left over from a crashed old Posse instance) */
function killPortOccupants(port: number): void {
  try {
    const out = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const pids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[RemoteServer] Killed port ${port} occupant PID ${pid}`);
      } catch {
        // Process may no longer exist
      }
    }
  } catch {
    // lsof failed, ignore
  }
}

// ========== Tailscale integration ==========
// Off-LAN mobile access uses the user's OWN Tailscale node over https (tailscale serve + MagicDNS),
// 不再硬编码任何第三方域名。Tailscale 未安装/未运行属正常情况，全部 try/catch 静默降级。

// 定位 Tailscale CLI：先 PATH，再 GUI bundle 与常见 Homebrew 路径
function resolveTailscaleCli(): string | null {
  const candidates = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ];
  for (const cli of candidates) {
    try {
      execFileSync(cli, ['version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return cli;
    } catch {
      // 该路径不可用，尝试下一个
    }
  }
  return null;
}

// 读取本机 Tailscale 节点信息（MagicDNS 名 + 100.x IPv4），失败返回 null
export function getTailscaleInfo(): { dnsName: string; ip: string } | null {
  const cli = resolveTailscaleCli();
  if (!cli) return null;
  try {
    const out = execFileSync(cli, ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(out);
    const self = status?.Self;
    if (!self) return null;
    // DNSName 形如 "host.tailnet.ts.net."，去掉末尾单个点
    const rawDns = typeof self.DNSName === 'string' ? self.DNSName : '';
    const dnsName = rawDns.replace(/\.$/, '');
    if (!dnsName) return null;
    // TailscaleIPs 里挑 IPv4（100.x，不含冒号）
    const ips: string[] = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
    const ip = ips.find(a => typeof a === 'string' && !a.includes(':')) || '';
    return { dnsName, ip };
  } catch {
    return null;
  }
}

// 确保 tailscale serve 把 https://443 反代到本机端口，幂等且永不抛错（不能阻塞 server 启动）
function ensureTailscaleServe(cli: string, port: number): void {
  try {
    const serveStatus = execFileSync(cli, ['serve', 'status'], { encoding: 'utf8', timeout: 5000 });
    // 已经代理到本端口则跳过
    if (serveStatus.includes(`127.0.0.1:${port}`) || serveStatus.includes(`localhost:${port}`)) {
      return;
    }
  } catch {
    // serve status 失败（如 "No serve config"）时继续尝试配置
  }
  try {
    execFileSync(cli, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], { encoding: 'utf8', timeout: 10000 });
    console.log('[RemoteServer] tailscale serve configured: https://443 ->', `127.0.0.1:${port}`);
  } catch (e: any) {
    console.warn('[RemoteServer] tailscale serve setup failed (ignored):', e?.message || e);
  }
}

// Get this machine's LAN IP
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ========== Config persistence ==========

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), '.posse-mobile');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface CustomPreset {
  id: string;
  name: string;
  command: string;
  autoFlag: string;
}

interface RemoteConfig {
  token: string;
  vapidPublic: string;
  vapidPrivate: string;
  pushSubscriptions: webpush.PushSubscription[];
  recentCwds: string[];
  customPresets: CustomPreset[];
  tailscaleServe?: boolean; // 是否自动配置 tailscale serve，默认 ON（仅当显式设为 false 时关闭）
}

function generateAccessToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function loadOrCreateConfig(): RemoteConfig {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Partial<RemoteConfig>;
      const fallbackKeys = webpush.generateVAPIDKeys();
      return {
        token: typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : generateAccessToken(),
        vapidPublic: raw.vapidPublic || fallbackKeys.publicKey,
        vapidPrivate: raw.vapidPrivate || fallbackKeys.privateKey,
        pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? raw.pushSubscriptions : [],
        recentCwds: Array.isArray(raw.recentCwds) ? raw.recentCwds.filter(Boolean).slice(0, 20) : [],
        customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : [],
        tailscaleServe: raw.tailscaleServe,
      };
    } catch {}
  }
  const vapidKeys = webpush.generateVAPIDKeys();
  const config: RemoteConfig = {
    token: generateAccessToken(),
    vapidPublic: vapidKeys.publicKey,
    vapidPrivate: vapidKeys.privateKey,
    pushSubscriptions: [],
    recentCwds: [],
    customPresets: [],
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

const MAX_RECENT_CWDS = 20;

function normalizeCwd(cwd: string): string {
  return (cwd || '').trim().replace(/\/+$/, '');
}

function addRecentCwdInConfig(config: RemoteConfig, cwd: string): void {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return;
  const next = [normalized, ...config.recentCwds.filter(x => x !== normalized)];
  config.recentCwds = next.slice(0, MAX_RECENT_CWDS);
}

/**
 * Start the remote-access server, reusing the desktop ptyManager.
 * @param ptyManager The desktop terminal manager instance.
 * @param onRemoteCreate Callback after the mobile client creates a session, to refresh the desktop renderer.
 * @param onRemoteDestroy Callback after the mobile client destroys a session.
 * @param onServerStarted Callback after the server starts, returning connection info (IP, port, token).
 */
export function startRemoteServer(
  ptyManager: PtyBackend,
  onRemoteCreate?: (sessionInfo: any) => void,
  onRemoteDestroy?: (id: string) => void,
  onServerStarted?: (info: RemoteServerInfo) => void,
  onConnectionStatusChanged?: (status: RemoteConnectionStatus) => void,
  listResumableSessions?: (cwd: string) => Array<{ id: string; title: string; cwd: string; mtimeMs: number; agent: string; resumeCommand: string }>,
): void {
  // Cache for use by Bridge events
  cachedPtyManager = ptyManager;
  cachedOnRemoteCreate = onRemoteCreate || null;

  const config = loadOrCreateConfig();
  const LOCAL_IP = getLocalIP();

  console.log('[RemoteServer] Starting server, IP:', LOCAL_IP, 'PORT:', PORT);

  webpush.setVapidDetails('mailto:posse@localhost', config.vapidPublic, config.vapidPrivate);

  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // Static files: serve the mobile/client directory
  const clientDir = path.join(__dirname, '../../mobile/client');
  app.use(express.static(clientDir));

  // Auth middleware
  function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (req.path === '/auth' || req.path === '/server-info' || req.path === '/vapid-public-key') return next();
    const t = req.headers['authorization']?.replace('Bearer ', '') || req.query.token as string;
    if (t !== config.token) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  }

  app.use('/api', authMiddleware);

  // ========== WebSocket ==========

  // Enable permessage-deflate: terminal ANSI text typically compresses 5-10x,
  // a key win for first-paint replay on weak networks and for screen-flooding output. Below the threshold, do not compress to avoid small messages getting larger.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 6, memLevel: 7 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 10,
    },
  });
  const wsClients = new Map<string, Set<WebSocket>>();
  type AliveWebSocket = WebSocket & { isAlive?: boolean };

  const getConnectionStatus = (): RemoteConnectionStatus => {
    let connectedClients = 0;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) connectedClients += 1;
    }
    let subscribedSessions = 0;
    for (const clients of wsClients.values()) {
      if (clients.size > 0) subscribedSessions += 1;
    }
    return {
      lanUrl: `http://${LOCAL_IP}:${PORT}`,
      token: config.token,
      port: PORT,
      connectedClients,
      subscribedSessions,
    };
  };

  const notifyConnectionStatusChanged = (): void => {
    if (onConnectionStatusChanged) {
      onConnectionStatusChanged(getConnectionStatus());
    }
  };

  // WS-level heartbeat: clean up half-open connections to avoid "fake online" on weak networks keeping clients stuck reconnecting
  const wsHeartbeatTimer = setInterval(() => {
    wss.clients.forEach((client) => {
      const wsClient = client as AliveWebSocket;
      if (wsClient.isAlive === false) {
        wsClient.terminate();
        return;
      }
      wsClient.isAlive = false;
      try {
        wsClient.ping();
      } catch { /* ignore */ }
    });
  }, 20000);
  server.on('close', () => {
    clearInterval(wsHeartbeatTimer);
  });

  wss.on('connection', (ws, req) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    ws.on('pong', () => {
      aliveWs.isAlive = true;
    });

    const url = new URL(req.url || '', 'http://localhost');
    if (url.searchParams.get('token') !== config.token) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    notifyConnectionStatusChanged();

    let subscribedSession: string | null = null;

    ws.on('message', (msg) => {
      void (async () => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.type === 'subscribe' && data.sessionId) {
          if (subscribedSession) { wsClients.get(subscribedSession)?.delete(ws); ptyManager.removeRemoteViewer(subscribedSession); }
          subscribedSession = data.sessionId;
          ptyManager.addRemoteViewer(data.sessionId);
          if (!wsClients.has(data.sessionId)) wsClients.set(data.sessionId, new Set());
          const sessionClients = wsClients.get(data.sessionId);
          if (sessionClients) sessionClients.add(ws);
          notifyConnectionStatusChanged();

          // Replay the historical buffer (always send replay, even if rawBuffer is empty, so the client knows the subscription took effect).
          // Only send a bounded tail: the daemon may retain up to 1MB of scrollback for desktop, but on weak networks
          // first-paint speed scales with payload size, so cap the mobile replay at MOBILE_REPLAY_TAIL_BYTES.
          const rawBuffer = await ptyManager.getRawBuffer(data.sessionId).catch(() => '');
          ws.send(JSON.stringify({ type: 'replay', data: tailRawBuffer(rawBuffer, MOBILE_REPLAY_TAIL_BYTES) }));
        }

        if (data.type === 'input' && subscribedSession) {
          await ptyManager.write(subscribedSession, data.data);
        }

        // base64-encoded input, decoded before writing to pty (avoids losing control characters during JSON transport)
        if (data.type === 'input_b64' && subscribedSession && typeof data.data === 'string') {
          const decoded = Buffer.from(data.data, 'base64').toString('utf-8');
          await ptyManager.write(subscribedSession, decoded);
        }

        // Mobile resize — adjust pty size in sync so output is laid out to the phone's column count
        if (data.type === 'resize' && subscribedSession && data.cols && data.rows) {
          await ptyManager.resize(subscribedSession, data.cols, data.rows, 'remote');
        }

        // Heartbeat ping, just ignore
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
      } catch {}
      })();
    });

    ws.on('close', () => {
      if (subscribedSession) { wsClients.get(subscribedSession)?.delete(ws); ptyManager.removeRemoteViewer(subscribedSession); }
      notifyConnectionStatusChanged();
    });
  });

  // pty rawData -> push to WebSocket clients (triggered by the onRawData callback in index.ts)
  // Micro-batching: multiple onData within 8ms are combined into one frame before send, reducing ws frame count and JSON header overhead.
  // 8ms is barely perceptible to the eye, yet it cuts npm install / compile screen-flooding from hundreds of frames to tens.
  const pendingChunks = new Map<string, string>();
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const FLUSH_DELAY_MS = 8;
  const FLUSH_MAX_BYTES = 32768; // Flush immediately once accumulation exceeds 32KB to avoid long-term backlog
  // Weak-network backpressure: if a single connection's socket buffer exceeds 1MB, treat it as backlog and terminate it directly.
  // On reconnect the client gets the latest 128KB of rawBuffer via replay, neatly skipping all the piled-up old frames.
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

  const flushChunks = (id: string) => {
    const data = pendingChunks.get(id);
    pendingChunks.delete(id);
    const t = pendingTimers.get(id);
    if (t) { clearTimeout(t); pendingTimers.delete(id); }
    if (!data) return;
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        // Weak-network backlog: drop this connection, triggering a client reconnect + replay
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.send(msg);
    }
  };

  (startRemoteServer as any)._pushRawData = (id: string, data: string) => {
    const clients = wsClients.get(id);
    if (!clients || clients.size === 0) return;
    const prev = pendingChunks.get(id) || '';
    const merged = prev + data;
    pendingChunks.set(id, merged);
    if (merged.length >= FLUSH_MAX_BYTES) {
      flushChunks(id);
      return;
    }
    if (!pendingTimers.has(id)) {
      pendingTimers.set(id, setTimeout(() => flushChunks(id), FLUSH_DELAY_MS));
    }
  };

  // ========== API routes ==========

  app.get('/api/server-info', (_req, res) => {
    res.json({
      ip: LOCAL_IP, port: PORT, hostname: os.hostname(),
      version: appVersionProvider(),
      sha: buildStamp.sha,
      builtAt: buildStamp.builtAt,
    });
  });

  // Return all currently available LAN IPv4 addresses (multiple NICs / subnets)
  // The mobile client uses this in CF Tunnel mode to probe whether it can connect to the LAN directly
  // Note: this endpoint requires token auth (under the /api prefix) to avoid leaking the internal network topology
  app.get('/api/lan-info', (_req, res) => {
    const interfaces = os.networkInterfaces();
    const lanIps: string[] = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIps.push(iface.address);
        }
      }
    }
    // Tailscale 节点信息（供 off-LAN 移动端走自己的 *.ts.net https 入口，而非任何第三方域名）
    const ts = getTailscaleInfo();
    const tailscaleUrl = ts && ts.dnsName ? `https://${ts.dnsName}` : null;
    const tailscaleIp = ts && ts.ip ? ts.ip : null;
    // 稳定地址：100.x 的 Tailscale IP + 端口的明文 http（WireGuard 在下层加密）。
    // 不依赖 `tailscale serve` 的 https 反代（常未配置而失效），且 IP 在 tailnet 内固定不变，
    // 是移动端首选的稳定/重连地址（优于会随 DHCP 变化的 LAN IP）。
    const tailscaleHttpUrl = tailscaleIp ? `http://${tailscaleIp}:${PORT}` : null;
    res.json({ lanIps, port: PORT, hostname: os.hostname(), tailscaleUrl, tailscaleHttpUrl, tailscaleIp });
  });

  // 1x1 transparent PNG for the mobile <img> probe (on an HTTPS page, fetching HTTP is blocked
  // by Mixed Content, but <img> cross-protocol loads are not, so onload can be used to test connectivity)
  // Note: not mounted under /api to avoid the token restriction — this is a public probe endpoint
  const PING_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
  app.get('/ping.png', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('png').send(PING_PNG);
  });

  app.post('/api/auth', (req, res) => {
    if (req.body.token === config.token) {
      res.json({ ok: true, ip: LOCAL_IP, port: PORT });
    } else {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  app.get('/api/vapid-public-key', (_req, res) => {
    res.json({ key: config.vapidPublic });
  });

  // ========== Custom preset sync API ==========

  app.get('/api/custom-presets', (_req, res) => {
    res.json(config.customPresets || []);
  });

  app.put('/api/custom-presets', (req, res) => {
    const list = req.body;
    if (!Array.isArray(list)) { res.status(400).json({ error: 'Array required' }); return; }
    config.customPresets = list;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ ok: true });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body.subscription as webpush.PushSubscription;
    if (!subscription) { res.status(400).json({ error: 'Missing subscription' }); return; }
    const exists = config.pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      config.pushSubscriptions.push(subscription);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
    res.json({ ok: true });
  });

  // Get the session UI state (busy/unread/idle), synced from the renderer to main
  function getSessionStatus(id: string, exitState?: unknown): string {
    if (exitState) return 'exited';
    const statuses = (global as any).__sessionStatuses || {};
    return statuses[id] || 'idle';
  }

  function mapSessionToApi(s: PtySessionSnapshot) {
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      presetCommand: s.presetCommand,
      displayName: resolveSessionDisplayName(s.presetCommand, config.customPresets),
      provider: s.provider || getCliProvider(s.presetCommand),
      status: getSessionStatus(s.id, s.exitState),
      createdAt: s.createdAt || Date.now(),
    };
  }

  // Session list — read directly from ptyManager
  app.get('/api/sessions', (_req, res) => {
    const sessions = ptyManager.getAllSessions().map(s => mapSessionToApi(s));
    res.json(sessions);
  });

  // Recent working directories (desktop-synced + running-session cwds, deduplicated and merged)
  app.get('/api/recent-cwds', (_req, res) => {
    const fromSessions = ptyManager.getAllSessions().map(s => normalizeCwd(s.cwd)).filter(Boolean);
    const merged = [...fromSessions, ...config.recentCwds];
    const uniq: string[] = [];
    for (const p of merged) {
      if (p && !uniq.includes(p)) uniq.push(p);
      if (uniq.length >= MAX_RECENT_CWDS) break;
    }
    res.json({ items: uniq });
  });

  // Resumable native sessions (Claude + Codex) for a given cwd
  app.get('/api/resumable', (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    try { res.json(listResumableSessions ? listResumableSessions(cwd) : []); }
    catch { res.json([]); }
  });

  // ========== Filesystem access (REMOTE clients) ==========
  // SECURITY: these expose filesystem read/list/write to any TOKEN-AUTHENTICATED client.
  // They sit under `/api`, so the `authMiddleware` above already gates every request on the
  // server token (Bearer header or ?token=). They mirror the Electron `fs:*` / `file-tree:*`
  // IPC handlers in src/main/index.ts 1:1 (same path resolution, encoding, and size limits) so
  // a headless backend serves files exactly like the desktop does locally. Each handler is
  // wrapped to return a JSON error + proper HTTP status instead of crashing the server.

  // List a directory's entries. Mirrors `file-tree:list-dir`.
  app.get('/api/fs/list', (req, res) => {
    try {
      const dirPath = typeof req.query.path === 'string' ? req.query.path : '';
      const abs = path.resolve(String(dirPath || ''));
      const st = fs.statSync(abs);
      if (!st.isDirectory()) { res.json([]); return; }
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
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Read a text file for preview (read-only, size + binary guards). Mirrors `fs:read-file`.
  app.get('/api/fs/read', (req, res) => {
    const MAX_PREVIEW_BYTES = 1024 * 1024; // 1MB cap to avoid lag
    try {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const abs = path.resolve(String(filePath || ''));
      const st = fs.statSync(abs);
      if (!st.isFile()) { res.status(400).json({ error: 'not-a-file' }); return; }
      if (st.size > MAX_PREVIEW_BYTES) {
        res.status(413).json({ error: 'too-large', size: st.size }); return;
      }
      const buf = fs.readFileSync(abs);
      // Simple binary detection: treat NUL in the first 8000 bytes as binary
      const sniff = buf.subarray(0, 8000);
      if (sniff.includes(0)) {
        res.status(415).json({ error: 'binary', size: st.size }); return;
      }
      res.json({
        content: buf.toString('utf-8'),
        size: st.size,
        ext: path.extname(abs).slice(1).toLowerCase(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Read a file as a base64 data URL (image previews). Mirrors `fs:read-file-base64`.
  app.get('/api/fs/read-base64', (req, res) => {
    const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16MB cap
    try {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const abs = path.resolve(String(filePath || ''));
      const st = fs.statSync(abs);
      if (!st.isFile()) { res.status(400).json({ error: 'not-a-file' }); return; }
      if (st.size > MAX_IMAGE_BYTES) { res.status(413).json({ error: 'too-large', size: st.size }); return; }
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mimeByExt: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
      };
      const mime = mimeByExt[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(abs);
      res.json({ dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, ext });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Write a text file (utf8) for the in-app editable preview. Mirrors `fs:write-file`.
  app.post('/api/fs/write', (req, res) => {
    try {
      const { path: filePath, content } = req.body || {};
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        res.status(400).json({ ok: false, error: 'invalid-path' }); return;
      }
      if (typeof content !== 'string') {
        res.status(400).json({ ok: false, error: 'invalid-content' }); return;
      }
      const abs = path.resolve(filePath);
      fs.writeFileSync(abs, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Write a BINARY file from a base64 payload (desktop->remote upload / file transfer).
  // The global `express.json()` parser caps bodies at ~100kb, so this route uses a dedicated
  // 50mb json parser (base64 of a 50MB file is ~67MB). Mirrors `remote:upload-files`' write
  // step: decode -> Buffer -> mkdir -p parent -> write. Same auth (authMiddleware) + path
  // resolution as `/api/fs/write`.
  app.post('/api/fs/write-base64', express.json({ limit: '70mb' }), (req, res) => {
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB cap on the decoded file
    try {
      const { path: filePath, dataBase64 } = req.body || {};
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        res.status(400).json({ ok: false, error: 'invalid-path' }); return;
      }
      if (typeof dataBase64 !== 'string') {
        res.status(400).json({ ok: false, error: 'invalid-content' }); return;
      }
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length > MAX_BYTES) {
        res.status(413).json({ ok: false, error: 'too-large', size: buf.length }); return;
      }
      const abs = path.resolve(filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // Create a session — created via ptyManager, notifying the desktop
  app.post('/api/sessions', async (req, res) => {
    const { cwd, presetCommand, themeId, providerEnv } = req.body;
    const targetCwd = cwd || process.env.HOME || os.homedir();
    try {
      const session = await ptyManager.create(
        targetCwd,
        presetCommand || '',
        typeof themeId === 'string' && themeId ? themeId : 'default',
        providerEnv && typeof providerEnv === 'object' ? providerEnv : undefined,
      );
      const info = {
        id: session.id,
        title: session.title,
        themeId: session.themeId,
        cwd: session.cwd,
        displayName: getDisplayName(session.presetCommand),
      };
      addRecentCwdInConfig(config, session.cwd);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      onRemoteCreate?.(info);
      res.json(info);
    } catch (e: any) {
      res.status(500).json({ error: 'Creation failed: ' + (e.message || e) });
    }
  });

  // Input
  app.post('/api/sessions/:id/input', async (req, res) => {
    const { input } = req.body;
    if (typeof input !== 'string') { res.status(400).json({ error: 'Missing input' }); return; }
    const data = input.endsWith('\r') || input.endsWith('\n') ? input : input + '\r';
    await ptyManager.write(req.params.id, data);
    res.json({ ok: true });
  });

  // Raw key code
  app.post('/api/sessions/:id/key', async (req, res) => {
    const { key } = req.body;
    if (typeof key !== 'string') { res.status(400).json({ error: 'Missing key' }); return; }
    await ptyManager.write(req.params.id, key);
    res.json({ ok: true });
  });

  // File upload — saved to the session's cwd
  app.post('/api/sessions/:id/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    const rawName = (req.headers['x-filename'] as string) || `upload_${Date.now()}`;
    // Path-traversal protection: take only the basename, then verify the target lands under cwd
    const filename = path.basename(rawName);
    if (!filename || filename === '.' || filename === '..') {
      res.status(400).json({ error: 'Invalid filename' }); return;
    }
    const decoded = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const dest = path.resolve(session.cwd, filename);
    const cwdReal = path.resolve(session.cwd);
    if (!dest.startsWith(cwdReal + path.sep) && dest !== cwdReal) {
      res.status(400).json({ error: 'Invalid path' }); return;
    }
    try {
      fs.writeFileSync(dest, decoded);
      res.json({ ok: true, path: dest, size: decoded.length });
    } catch (e: any) {
      res.status(500).json({ error: 'Write failed: ' + (e.message || e) });
    }
  });

  // Rename session title
  app.put('/api/sessions/:id/title', async (req, res) => {
    const { title } = req.body;
    if (typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'Missing title' });
      return;
    }
    const session = ptyManager.getSession(req.params.id);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    await ptyManager.rename(req.params.id, title.trim());
    res.json({ ok: true });
  });

  // Delete session
  app.delete('/api/sessions/:id', async (req, res) => {
    await ptyManager.destroy(req.params.id);
    onRemoteDestroy?.(req.params.id);
    res.json({ ok: true });
  });

  // ========== Android device API ==========

  app.get('/api/android/devices', (_req, res) => {
    try {
      const out = execFileSync(ADB, ['devices', '-l'], { encoding: 'utf8' });
      const devices = out.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*')).map(l => {
        const [id, ...rest] = l.trim().split(/\s+/);
        return { id, info: rest.join(' ') };
      });
      res.json({ devices });
    } catch (e: any) {
      res.status(500).json({ error: 'Failed to get devices: ' + (e.message || e) });
    }
  });

  app.get('/api/android/screenshot', async (req, res) => {
    try {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const quality = Math.min(100, Math.max(1, parseInt(req.query.quality as string) || 80));
      const scale = Math.min(1, Math.max(0.1, parseFloat(req.query.scale as string) || 1));
      const args: string[] = [];
      if (deviceId) args.push('-s', deviceId);
      args.push('exec-out', 'screencap', '-p');
      const png = execFileSync(ADB, args, { maxBuffer: 8 * 1024 * 1024 });
      let pipeline = sharp(png);
      if (scale < 1) {
        const meta = await sharp(png).metadata();
        if (meta.width && meta.height) {
          pipeline = pipeline.resize(Math.round(meta.width * scale), Math.round(meta.height * scale));
        }
      }
      const jpeg = await pipeline.jpeg({ quality }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(jpeg);
    } catch (e: any) {
      res.status(500).json({ error: 'Screenshot failed: ' + (e.message || e) });
    }
  });

  app.post('/api/android/tap', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x = Math.round(Number(req.body.x));
      const y = Math.round(Number(req.body.y));
      if (!deviceId || isNaN(x) || isNaN(y)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
      execFileSync(ADB, ['-s', deviceId, 'shell', 'input', 'tap', String(x), String(y)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: 'Tap failed: ' + (e.message || e) });
    }
  });

  app.post('/api/android/swipe', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const x1 = Math.round(Number(req.body.x1));
      const y1 = Math.round(Number(req.body.y1));
      const x2 = Math.round(Number(req.body.x2));
      const y2 = Math.round(Number(req.body.y2));
      const duration = Math.max(100, Math.min(3000, Math.round(Number(req.body.duration) || 300)));
      if (!deviceId || [x1, y1, x2, y2].some(isNaN)) { res.status(400).json({ error: 'Invalid parameters' }); return; }
      execFileSync(ADB, ['-s', deviceId, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)]);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: 'Swipe failed: ' + (e.message || e) });
    }
  });

  app.post('/api/android/shell', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const command = typeof req.body.command === 'string' ? req.body.command.trim() : '';
      if (!deviceId || !command) { res.status(400).json({ error: 'Invalid parameters' }); return; }
      const out = execSync(`${ADB} -s ${deviceId} shell ${command}`, { encoding: 'utf8', timeout: 30000 });
      res.json({ output: out });
    } catch (e: any) {
      res.json({ output: e.stdout || e.message || String(e) });
    }
  });

  app.post('/api/android/input-text', (req, res) => {
    try {
      const deviceId = typeof req.body.deviceId === 'string' ? req.body.deviceId.trim() : '';
      const text = typeof req.body.text === 'string' ? req.body.text : '';
      if (!deviceId || !text) { res.status(400).json({ error: 'Invalid parameters' }); return; }
      // Switch to ADBKeyboard to send the text, then switch back to Sogou
      execFileSync(ADB, ['-s', deviceId, 'shell', 'ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
      execFileSync(ADB, ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', text]);
      execFileSync(ADB, ['-s', deviceId, 'shell', 'ime', 'set', 'com.sohu.inputmethod.sogouoem/.SogouIME']);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // ========== Auto-continue config API ==========

  // Read the auto-continue config (from the desktop renderer)
  app.get('/api/sessions/:id/auto-continue', async (req, res) => {
    const getConfig = (global as any).__getAutoContinueConfig;
    if (!getConfig) { res.json(null); return; }
    const config = await getConfig(req.params.id);
    res.json(config);
  });

  // Write the auto-continue config (synced to the desktop renderer)
  app.put('/api/sessions/:id/auto-continue', (req, res) => {
    const setConfig = (global as any).__setAutoContinueConfig;
    if (!setConfig) { res.status(500).json({ error: 'Desktop not ready' }); return; }
    setConfig(req.params.id, req.body);
    res.json({ ok: true });
  });

  // SSE event stream
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sendSessions = () => {
      const sessions = ptyManager.getAllSessions().map(s => mapSessionToApi(s));
      res.write(`event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
    };
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 3000);
    const statusInterval = setInterval(sendSessions, 2000);
    req.on('close', () => { clearInterval(heartbeat); clearInterval(statusInterval); });
  });

  // ========== Push notifications ==========

  // Export the push method for external callers
  (startRemoteServer as any)._sendPush = (title: string, body: string, sessionId: string) => {
    const payload = JSON.stringify({ title, body, sessionId });
    for (const sub of config.pushSubscriptions) {
      webpush.sendNotification(sub, payload).catch((err: any) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          config.pushSubscriptions = config.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        }
      });
    }
  };

  // ========== Startup ==========

  // server 监听成功后，尝试配置 tailscale serve（默认 ON，config.tailscaleServe === false 时关闭）
  const maybeSetupTailscaleServe = (): void => {
    if (config.tailscaleServe === false) return;
    const cli = resolveTailscaleCli();
    if (!cli || !getTailscaleInfo()) return; // Tailscale 未安装/未运行，跳过
    ensureTailscaleServe(cli, PORT);
  };

  // Cleanup before start: kill the port-9800 process left over from an old Posse instance
  killPortOccupants(PORT);

  server.on('error', (err: any) => {
    console.error('[RemoteServer] Server error:', err.code, err.message);
    // Port is in use (left over from a crashed old instance); kill the occupant and retry once
    if (err.code === 'EADDRINUSE') {
      console.log('[RemoteServer] Port in use, killing occupant and retrying...');
      killPortOccupants(PORT);
      setTimeout(() => {
        server.listen(PORT, '0.0.0.0', () => {
          const lanUrl = `http://${LOCAL_IP}:${PORT}`;
          console.log('[RemoteServer] Server started (retry), URL:', lanUrl);
          maybeSetupTailscaleServe();
          if (onServerStarted) {
            const serverInfo = { lanUrl, token: config.token, port: PORT };
            onServerStarted(serverInfo);
            notifyConnectionStatusChanged();
          }
        });
      }, 500);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    const lanUrl = `http://${LOCAL_IP}:${PORT}`;
    console.log('[RemoteServer] Server started, URL:', lanUrl);
    maybeSetupTailscaleServe();
    // Return connection info via callback, no longer printed to the terminal
    if (onServerStarted) {
      const serverInfo = { lanUrl, token: config.token, port: PORT };
      onServerStarted(serverInfo);
      notifyConnectionStatusChanged();
    }
  });
}

/** Push raw pty data to remote WebSocket clients */
export function pushRawDataToRemote(id: string, data: string): void {
  (startRemoteServer as any)._pushRawData?.(id, data);
}

/** Send a push notification */
export function sendRemotePush(title: string, body: string, sessionId: string): void {
  (startRemoteServer as any)._sendPush?.(title, body, sessionId);
}

/** Sync recent directories from desktop into the remote config (used by the mobile client's new-session dropdown) */
export function addRemoteRecentCwd(cwd: string): void {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return;
  const config = loadOrCreateConfig();
  const prev = config.recentCwds.join('\n');
  addRecentCwdInConfig(config, normalized);
  if (config.recentCwds.join('\n') !== prev) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
}
