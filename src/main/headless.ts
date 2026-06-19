/**
 * Headless backend entry point.
 *
 * Boots Posse's backend WITHOUT Electron so a GUI-less 24/7 server can run it:
 *   - PtyDaemonClient (spawns / re-attaches the self-detaching pty-daemon),
 *   - the remote-server (token-auth HTTP + WS that the desktop / mobile client speaks to),
 *   - a ChatSessionManager (optional chat proxy, parity with the desktop wiring).
 *
 * The desktop app connects to this process later (a separate chunk). This entry only
 * makes the existing backend runnable headless and proves it boots + serves the
 * endpoints remote-server already exposes.
 *
 * IMPORTANT: nothing in this file's dependency graph may import from 'electron'.
 * The only former electron use (app.getVersion in remote-server.ts) is now injected
 * via setAppVersionProvider().
 */

import * as path from 'path';
import { PtyDaemonClient } from './pty-daemon-client';
import { PtyBackend } from './pty-backend';
import {
  startRemoteServer,
  setAppVersionProvider,
  pushRawDataToRemote,
  type RemoteServerInfo,
  type RemoteConnectionStatus,
} from './remote-server';
import { ChatSessionManager } from './chat-session-manager';

function readPackageVersion(): string {
  try {
    // dist/main/headless.js -> ../../package.json
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  const version = readPackageVersion();
  console.log(`[headless] Posse headless backend v${version} starting...`);

  // Report a real version on /api/server-info without importing electron.
  setAppVersionProvider(() => version);

  // Connect to the pty-daemon. PtyDaemonClient.connect spawns the daemon detached if it
  // isn't already running, then re-attaches via the daemon config file. The daemon outlives
  // this process, which is exactly the 24/7 persistence the remote host needs.
  const ptyManager: PtyBackend = await PtyDaemonClient.connect({
    onData: () => {
      // No local renderer in headless mode; raw data is forwarded to remote viewers below.
    },
    onRawData: (id, data) => {
      pushRawDataToRemote(id, data);
    },
    onTitleUpdate: (id, title) => {
      console.log(`[headless] session ${id} title: ${title}`);
    },
    onExit: (id) => {
      console.log(`[headless] session ${id} exited`);
    },
  });
  console.log('[headless] pty-daemon connected.');

  // Chat session manager: remote-server reads this off global.__chatSessionManager.
  // Headless has no AI-preference store, so title-AI config is null (chat title generation
  // is simply skipped) — chat endpoints still respond.
  const chatSessionManager = new ChatSessionManager(
    {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onTitleUpdate: () => {},
    },
    () => null,
  );
  (global as any).__chatSessionManager = chatSessionManager;

  // Start the token-auth remote server. Same wiring as the Electron main, minus all
  // BrowserWindow / tray / cloudflared callbacks (no-ops here).
  // listResumableSessions is intentionally omitted in headless (the title-discovery helpers
  // still live inline in index.ts); /api/resumable then returns []. See follow-up notes.
  startRemoteServer(
    ptyManager,
    (sessionInfo) => {
      console.log('[headless] remote created session:', sessionInfo?.id ?? sessionInfo);
    },
    (id) => {
      console.log('[headless] remote destroyed session:', id);
    },
    (info: RemoteServerInfo) => {
      console.log('[headless] ============================================');
      console.log(`[headless] Server listening: ${info.lanUrl}`);
      console.log(`[headless] Port:  ${info.port}`);
      console.log(`[headless] Token: ${info.token}`);
      console.log('[headless] ============================================');
    },
    (status: RemoteConnectionStatus) => {
      console.log(
        `[headless] clients=${status.connectedClients} subscribedSessions=${status.subscribedSessions}`,
      );
    },
  );

  const shutdown = (signal: string): void => {
    console.log(`[headless] received ${signal}, shutting down (pty-daemon keeps running).`);
    // The pty-daemon is detached on purpose: leaving it alive is what makes remote sessions
    // survive this process restarting. We exit without killing it.
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[headless] backend ready.');
}

main().catch((err) => {
  console.error('[headless] fatal:', err);
  process.exit(1);
});
