import express from 'express';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { PtyManager } from './pty-manager';
import { loadOrCreatePtyDaemonConfig, savePtyDaemonConfig } from './pty-daemon-config';
import { toPtySessionSnapshot } from './pty-session-snapshot';
import { PtySessionSnapshot } from './pty-backend';

type DaemonEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'rawData'; id: string; data: string }
  | { type: 'titleUpdate'; id: string; title: string }
  | { type: 'exit'; id: string; session?: PtySessionSnapshot }
  | { type: 'pasteInput'; id: string; cwd: string }
  | { type: 'autoSwitchStatus'; id: string; status: string; detail?: string };

const config = loadOrCreatePtyDaemonConfig();
config.pid = process.pid;
savePtyDaemonConfig(config);

const eventClients = new Set<WebSocket>();

function broadcast(event: DaemonEvent): void {
  const payload = JSON.stringify(event);
  for (const ws of eventClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

const ptyManager = new PtyManager({
  onData: (id, data) => {
    broadcast({ type: 'data', id, data });
  },
  onRawData: (id, data) => {
    broadcast({ type: 'rawData', id, data });
  },
  onTitleUpdate: (id, title) => {
    broadcast({ type: 'titleUpdate', id, title });
  },
  onExit: (id) => {
    ptyManager.captureResumeFromBuffer(id);
    const session = ptyManager.getSession(id);
    broadcast({ type: 'exit', id, session: session ? toPtySessionSnapshot(session) : undefined });
  },
  onPasteInput: (id, cwd) => {
    broadcast({ type: 'pasteInput', id, cwd });
  },
  onAutoSwitchStatus: (id, status, detail) => {
    broadcast({ type: 'autoSwitchStatus', id, status, detail });
  },
});

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  if (token !== config.token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function getSessionSnapshot(id: string): PtySessionSnapshot | undefined {
  const session = ptyManager.getSession(id);
  return session ? toPtySessionSnapshot(session) : undefined;
}

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, pid: process.pid, port: config.port });
});

app.post('/shutdown', requireAuth, (_req, res) => {
  // Capture resume info for every active session BEFORE exiting so they are
  // recoverable: each session's resumeId/resumeCommand is written into its
  // snapshot, and the resulting exit events let the main app persist
  // closed-session records on respawn.
  for (const session of ptyManager.getAllSessions()) {
    try {
      ptyManager.captureResumeFromBuffer(session.id);
    } catch {
      // ignore per-session capture failures; keep shutting down cleanly
    }
  }
  res.json({ ok: true });
  // Respond first, then exit after a short delay so the HTTP response flushes
  // and the client can observe a clean 200 before the process goes away.
  setTimeout(() => {
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  }, 200);
});

app.get('/terminal/config', (_req, res) => {
  res.json({
    token: config.token,
    port: config.port,
    homeDir: os.homedir(),
  });
});

const terminalClientDir = path.join(__dirname, '../terminal-client');
app.get('/terminal', (req, res, next) => {
  if (req.originalUrl !== '/terminal') {
    next();
    return;
  }
  res.redirect('/terminal/');
});
app.use('/terminal', express.static(terminalClientDir));

app.use('/api', requireAuth);

app.get('/api/sessions', (_req, res) => {
  res.json(ptyManager.getAllSessions().map(toPtySessionSnapshot));
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSessionSnapshot(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session);
});

app.get('/api/sessions/:id/raw-buffer', (req, res) => {
  const session = ptyManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ rawBuffer: session.rawBuffer });
});

app.post('/api/sessions', (req, res) => {
  const body = req.body || {};
  const session = ptyManager.create(
    String(body.cwd || process.env.HOME || process.cwd()),
    String(body.presetCommand || ''),
    typeof body.themeId === 'string' && body.themeId ? body.themeId : 'default',
    body.envOverrides && typeof body.envOverrides === 'object' ? body.envOverrides : undefined,
  );
  res.json(toPtySessionSnapshot(session));
});

app.post('/api/sessions/:id/write', (req, res) => {
  if (typeof req.body?.data !== 'string') {
    res.status(400).json({ error: 'Missing data' });
    return;
  }
  ptyManager.write(req.params.id, req.body.data);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/resize', (req, res) => {
  ptyManager.resize(req.params.id, Number(req.body?.cols), Number(req.body?.rows));
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  ptyManager.destroy(req.params.id);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/capture-resume', (req, res) => {
  ptyManager.captureResumeFromBuffer(req.params.id);
  res.json({ ok: true });
});

app.put('/api/sessions/:id/title', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    res.status(400).json({ error: 'Missing title' });
    return;
  }
  ptyManager.rename(req.params.id, title);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/regenerate-title', async (req, res) => {
  await ptyManager.regenerateTitle(req.params.id);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/provider', (req, res) => {
  const provider = typeof req.body?.provider === 'string' ? req.body.provider : null;
  ptyManager.setProvider(req.params.id, provider);
  res.json({ ok: true });
});

const wss = new WebSocketServer({ server, path: '/events' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://127.0.0.1');
  if (url.searchParams.get('token') !== config.token) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  eventClients.add(ws);
  ws.on('close', () => eventClients.delete(ws));
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[PtyDaemon] listening on 127.0.0.1:${config.port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('[PtyDaemon] failed to start:', error.code, error.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
