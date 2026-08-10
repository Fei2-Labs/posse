// browser-ops-server.ts
//
// Local-loopback HTTP server that the agent MCP bridge (browser-mcp.ts) calls to
// drive the user's visible embedded browser. This is the in-process back-end; the
// MCP bridge is a separate stdio subprocess (ACP has no in-process transport — see
// the research note in this worktree). The bridge authenticates with a bearer token
// minted per app launch.
//
// Security: loopback-only (127.0.0.1), bearer-token auth, JSON body. All operations
// route through EmbeddedBrowserManager.agentController() — the live, user-facing
// browser session. Secrets (cookies/passwords/auth headers/storage) are never exposed:
// DOM snapshots are sanitized in browser-controller.ts, screenshots are pixels only,
// and input is synthesized via WebContents.sendInputEvent.
//
// Lifecycle: started once at app launch (startBrowserOpsServer) with the
// EmbeddedBrowserManager. The ACP client (acp-client.ts) reads the resulting port +
// token and passes them to the spawned browser-mcp subprocess via env.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { EmbeddedBrowserManager, EmbeddedBrowserController } from './browser-controller';
import type {
  BrowserAgentClick,
  BrowserAgentDomSnapshotOptions,
  BrowserAgentElementSelector,
  BrowserAgentTypeOptions,
} from './browser-controller';

export interface BrowserOpsServer {
  port: number;
  token: string;
  baseUrl: string;
  /** Release a session's ownership of the browser (called when the ACP session closes). */
  releaseOwner(sessionId: string): void;
  /** The session id that currently owns the browser, or null. */
  currentOwner(): string | null;
  /**
   * Acquire ownership on behalf of a session id (e.g. the ChatGPT CLI label) WITHOUT going
   * through an HTTP mutating call. Used by the ChatGPT bridge (#121) so the CLI's hold is
   * visible to ACP mutations (they get 423) and vice versa. Returns false if another session
   * currently owns. Refreshes the idle timer so the hold doesn't time out mid-stream.
   */
  acquireOwner(sessionId: string): boolean;
  /**
   * Check whether a specific session id is the current owner. Convenience for the bridge
   * to test its own label without a full currentOwner() string compare at the call site.
   */
  isOwner(sessionId: string): boolean;
  /** Subscribe to ownership changes (acquire/release). Used by the UI indicator (#109). */
  onOwnershipChange(handler: (ownerSessionId: string | null) => void): void;
  close(): void;
}

type OpResult = { ok: boolean; [key: string]: unknown };

// Single-session ownership of the agent-driven browser (#109 acceptance criterion 5:
// two simultaneous agents cannot unknowingly control the same tab). The first session
// to call a tool becomes the owner; a different session's calls are rejected with 423
// until the owner releases (session close) or times out. A idle timeout prevents a
// dead session from holding the browser forever.
const OWNER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    // Local-only; never cached.
    'cache-control': 'no-store',
  });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Bound the body so a misbehaving client can't exhaust memory.
      if (data.length > 1_000_000) { data = ''; req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export async function startBrowserOpsServer(manager: EmbeddedBrowserManager): Promise<BrowserOpsServer | null> {
  const token = randomUUID();
  let ownerSessionId: string | null = null;
  let ownerTimer: NodeJS.Timeout | null = null;
  const ownershipHandlers = new Set<(owner: string | null) => void>();

  const notifyOwnership = () => {
    for (const h of ownershipHandlers) {
      try { h(ownerSessionId); } catch { /* handler must not crash the request path */ }
    }
  };
  const clearOwnerTimer = () => {
    if (ownerTimer) { clearTimeout(ownerTimer); ownerTimer = null; }
  };
  // (Re)start the idle timer that drops ownership after OWNER_IDLE_TIMEOUT_MS of no
  // mutating calls. Called on every mutating HTTP call from the owner AND on
  // acquireOwner (ChatGPT CLI). The timer prevents a dead session/process from holding
  // the browser forever.
  const refreshOwnerTimer = () => {
    clearOwnerTimer();
    ownerTimer = setTimeout(() => {
      if (ownerSessionId) {
        ownerSessionId = null;
        ownerTimer = null;
        notifyOwnership();
      }
    }, OWNER_IDLE_TIMEOUT_MS);
  };
  const releaseOwnerInternal = (sessionId: string) => {
    if (ownerSessionId !== sessionId) return;
    clearOwnerTimer();
    ownerSessionId = null;
    notifyOwnership();
  };
  // Acquire ownership on behalf of a session id without an HTTP call. Used by the
  // ChatGPT bridge (#121). Returns false if another session currently owns. On success,
  // sets the owner, broadcasts, and starts the idle timer.
  const acquireOwnerInternal = (sessionId: string): boolean => {
    if (!sessionId) return false;
    if (ownerSessionId && ownerSessionId !== sessionId) return false;
    if (ownerSessionId !== sessionId) {
      ownerSessionId = sessionId;
      notifyOwnership();
    }
    refreshOwnerTimer();
    return true;
  };

  let server: http.Server | null = null;
  try {
    server = http.createServer(async (req, res) => {
      // Auth + method guard first.
      const authHeader = req.headers['authorization'];
      const bearer = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';
      if (bearer !== token) { send(res, 401, { ok: false, error: 'Unauthorized' }); return; }
      if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'Method not allowed' }); return; }

      const url = req.url || '';
      // Read-only state/screenshot are allowed WITHOUT ownership so an agent can
      // inspect without grabbing control from another. Everything else requires
      // ownership (acquire on first mutating call).
      const sessionHeader = req.headers['x-posse-session'];
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader : '';
      const isReadonly = url === '/state' || url === '/screenshot' || url === '/dom-snapshot';

      if (!isReadonly) {
        if (ownerSessionId && sessionId && ownerSessionId !== sessionId) {
          send(res, 423, { ok: false, error: 'Browser is currently controlled by another agent session.' });
          return;
        }
        if (sessionId && ownerSessionId !== sessionId) {
          // Acquire ownership for this session.
          ownerSessionId = sessionId;
          notifyOwnership();
        }
        // Refresh the idle timer on every mutating call from the owner.
        refreshOwnerTimer();
      }

      const controller = manager.agentController();
      if (!controller) { send(res, 503, { ok: false, error: 'No embedded browser is available. Open the browser view first.' }); return; }

      const body = await readBody(req);
      if (body === null) { send(res, 400, { ok: false, error: 'Invalid JSON body.' }); return; }

      let result: OpResult;
      try {
        result = await route(url, body, controller);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : 'Operation failed.' };
      }
      send(res, 200, result);
    });
    // 0 = let the OS pick a free port on loopback. Wait for the listening event:
    // server.address() is not guaranteed to be populated synchronously after listen().
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    try { server?.close(); } catch { /* ignore */ }
    console.error('[BrowserOps] failed to start server:', error);
    return null;
  }

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    console.error('[BrowserOps] server bound to unexpected address');
    return null;
  }
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const handle = server;
  return {
    port,
    token,
    baseUrl,
    releaseOwner(sessionId: string): void {
      releaseOwnerInternal(sessionId);
    },
    currentOwner(): string | null {
      return ownerSessionId;
    },
    acquireOwner(sessionId: string): boolean {
      return acquireOwnerInternal(sessionId);
    },
    isOwner(sessionId: string): boolean {
      return ownerSessionId === sessionId;
    },
    onOwnershipChange(handler: (ownerSessionId: string | null) => void): void {
      ownershipHandlers.add(handler);
    },
    close(): void {
      clearOwnerTimer();
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}

async function route(url: string, body: unknown, controller: EmbeddedBrowserController): Promise<OpResult> {
  switch (url) {
    case '/state':
      return { ok: true, ...controller.agentState() };

    case '/navigate': {
      const input = (body as { url?: unknown }).url;
      if (typeof input !== 'string') return { ok: false, error: 'url is required.' };
      return controller.agentNavigate(input);
    }

    case '/screenshot':
      return controller.agentScreenshot();

    case '/dom-snapshot': {
      const opts = (body as { selector?: BrowserAgentElementSelector; maxDepth?: number }) || {};
      return controller.agentDomSnapshot({ selector: opts.selector, maxDepth: opts.maxDepth });
    }

    case '/click': {
      const click = body as BrowserAgentClick | undefined;
      if (!click || typeof click.x !== 'number' || typeof click.y !== 'number') {
        return { ok: false, error: 'x and y are required.' };
      }
      return controller.agentClick(click);
    }

    case '/type': {
      const opts = body as BrowserAgentTypeOptions | undefined;
      if (!opts || typeof opts.text !== 'string') return { ok: false, error: 'text is required.' };
      return controller.agentType(opts);
    }

    case '/keypress': {
      const key = (body as { key?: unknown }).key;
      if (typeof key !== 'string') return { ok: false, error: 'key is required.' };
      return controller.agentKeypress(key);
    }

    case '/scroll': {
      const opts = (body as { selector?: BrowserAgentElementSelector; x?: number; y?: number }) || {};
      return controller.agentScroll(opts);
    }

    default:
      return { ok: false, error: `Unknown operation: ${url}` };
  }
}
