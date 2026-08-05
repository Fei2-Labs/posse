/**
 * remote-bootstrap.ts — main-process wrapper around scripts/posse-remote-bootstrap.sh.
 *
 * Runs the bootstrap script (deploy + start the headless backend on a remote SSH host) and
 * parses its two-line stdout contract into { baseUrl, token }. The script is the source of
 * truth for the recipe; this only shells out to it and never throws raw — callers get a
 * descriptive Error.
 *
 * Script path resolution:
 *   - dev / unpackaged: <repo>/scripts/posse-remote-bootstrap.sh  (__dirname = dist/main)
 *   - packaged:         process.resourcesPath/scripts/posse-remote-bootstrap.sh
 * For the packaged case to work, electron-builder must ship the script under extraResources
 * (see package.json build.extraResources). build-remote-bundle.js does NOT bundle the script —
 * the desktop app ships it; only the backend bundle is rsynced to the remote.
 */

import { execFile, spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

export interface RemoteBootstrapResult {
  baseUrl: string;
  token: string;
  /** True when baseUrl is an ssh -L tunnel to localhost (no Tailscale/LAN reachability). */
  tunneled?: boolean;
}

/**
 * Active ssh -L tunnels keyed by remote connection id. Each entry is the ssh child process
 * forwarding a local port to the remote's 127.0.0.1:9800. Cleaned up on app quit or when
 * the connection is removed.
 */
const activeTunnels = new Map<string, ChildProcess>();

/** True when the host part of a baseUrl is a Tailscale 100.64.0.0/10 address. */
function isTailscaleIp(baseUrl: string): boolean {
  const m = baseUrl.match(/^https?:\/\/(\d+\.\d+\.\d+\.\d+)/);
  if (!m) return false;
  const octets = m[1].split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Find a free localhost TCP port in the 18080–18180 range. */
function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let port = 18080;
    const tryPort = (): void => {
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(port));
      });
      srv.on('error', () => {
        port += 1;
        if (port > 18180) { reject(new Error('no free port in 18080–18180')); return; }
        tryPort();
      });
    };
    tryPort();
  });
}

/**
 * Spawn `ssh -L <localPort>:localhost:9800 -N <sshHost>` to forward a local port to the
 * remote's headless backend. Used when the remote has no Tailscale IP (off-LAN + no tailnet).
 * Returns the local baseUrl (`http://127.0.0.1:<localPort>`). The tunnel stays up until
 * `stopTunnel(connectionId)` or app quit.
 */
export async function startSshTunnel(connectionId: string, sshHost: string, remotePort = 9800): Promise<string> {
  // Reuse an existing tunnel for this connection.
  const existing = activeTunnels.get(connectionId);
  if (existing && !existing.killed) {
    // Already tunneled — return the stored local port (we stash it on the child via a hack).
    const port = (existing as ChildProcess & { __posseLocalPort?: number }).__posseLocalPort;
    if (port) return `http://127.0.0.1:${port}`;
  }
  const localPort = await findFreeLocalPort();
  const child = spawn('ssh', [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    sshHost,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  (child as ChildProcess & { __posseLocalPort?: number }).__posseLocalPort = localPort;
  child.on('exit', () => { activeTunnels.delete(connectionId); });
  activeTunnels.set(connectionId, child);
  // Wait briefly for ssh to either establish the forward or fail (ExitOnForwardFailure).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 3000); // assume success after 3s
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`ssh -L tunnel exited with code ${code} (check ssh config / reachability)`));
    });
  }).catch((err) => { throw err; });
  return `http://127.0.0.1:${localPort}`;
}

/** Stop the ssh -L tunnel for a connection (called on connection removal / app quit). */
export function stopSshTunnel(connectionId: string): void {
  const child = activeTunnels.get(connectionId);
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  activeTunnels.delete(connectionId);
}

/** Stop all active ssh -L tunnels (called on app quit). */
export function stopAllSshTunnels(): void {
  for (const child of activeTunnels.values()) {
    if (!child.killed) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
  }
  activeTunnels.clear();
}

/**
 * Resolve the local remote-bundle dir (the rsync SOURCE for the bootstrap script).
 * Mirrors resolveScriptPath()'s packaged-vs-dev detection:
 *   - packaged: extraResources copies release/remote-bundle -> process.resourcesPath/remote-bundle
 *   - dev:      <repo>/release/remote-bundle  (__dirname = dist/main -> ../../release/remote-bundle)
 * Returns the first candidate that exists; if neither exists, returns the dev path so the
 * caller can decide to omit sourceDir (letting the script use its own default).
 */
export function resolveRemoteBundleDir(): string {
  const candidates = [
    // packaged: extraResources copies release/remote-bundle next to the asar
    path.join(process.resourcesPath || '', 'remote-bundle'),
    // dev: dist/main -> ../../release/remote-bundle
    path.join(__dirname, '..', '..', 'release', 'remote-bundle'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[1];
}

function resolveScriptPath(): string {
  const candidates = [
    // packaged: extraResources copies scripts/ next to the asar
    path.join(process.resourcesPath || '', 'scripts', 'posse-remote-bootstrap.sh'),
    // dev: dist/main -> ../../scripts
    path.join(__dirname, '..', '..', 'scripts', 'posse-remote-bootstrap.sh'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  // Return the dev path so the error message is actionable even if neither exists.
  return candidates[1];
}

/**
 * Bootstrap a remote SSH host: deploy + start the headless Posse backend, returning its
 * connect URL + token. `sshHost` is used verbatim with the system ssh (honors ~/.ssh/config).
 * Optionally pin a `version` (defaults to the script's derive-version).
 */
export async function bootstrapRemoteHost(
  sshHost: string,
  opts?: { version?: string; sourceDir?: string; connectionId?: string },
): Promise<RemoteBootstrapResult> {
  const host = String(sshHost || '').trim();
  if (!host) throw new Error('Bootstrap: ssh host is required');

  const scriptPath = resolveScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Bootstrap script not found at ${scriptPath}`);
  }

  const args: string[] = [scriptPath, host];
  if (opts?.version) args.push(opts.version);
  if (opts?.sourceDir) {
    if (!opts.version) args.push(''); // keep positional slot for source-dir
    args.push(opts.sourceDir);
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'bash',
      args,
      { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, out, errOut) => {
        if (err) {
          // Surface the script's stderr tail — that's where the real failure reason is.
          const tail = String(errOut || '').trim().split('\n').slice(-8).join('\n');
          reject(new Error(`Bootstrap failed: ${err.message}${tail ? `\n${tail}` : ''}`));
          return;
        }
        resolve(String(out || ''));
      },
    );
  });

  let baseUrl = '';
  let token = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('POSSE_REMOTE_URL=')) baseUrl = t.slice('POSSE_REMOTE_URL='.length).trim();
    else if (t.startsWith('POSSE_REMOTE_TOKEN=')) token = t.slice('POSSE_REMOTE_TOKEN='.length).trim();
  }

  if (!baseUrl || !token) {
    throw new Error('Bootstrap produced no connect info (missing URL or token in script output)');
  }

  // ssh -L fallback: when the remote has no Tailscale IP (off-LAN + no tailnet), the script
  // returns a LAN IP / hostname that may not be reachable from this client. Spin up an ssh -L
  // tunnel to the remote's 127.0.0.1:9800 and use localhost as the baseUrl instead.
  if (!isTailscaleIp(baseUrl) && opts?.connectionId) {
    try {
      const tunneledUrl = await startSshTunnel(opts.connectionId, host);
      return { baseUrl: tunneledUrl, token, tunneled: true };
    } catch {
      // Tunnel failed — fall through to the script's baseUrl (LAN/hostname). If that's also
      // unreachable the user will see a connection error on first request; they can retry.
    }
  }
  return { baseUrl, token };
}
