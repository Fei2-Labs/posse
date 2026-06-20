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

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RemoteBootstrapResult {
  baseUrl: string;
  token: string;
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
  opts?: { version?: string; sourceDir?: string },
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
  return { baseUrl, token };
}
