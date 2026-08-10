#!/usr/bin/env node
// posse-chatgpt.ts — `posse chatgpt` CLI (#121)
//
// Self-contained, esbuild-bundled CLI (dist/cli/posse-chatgpt.js) that any shell-capable
// agent can invoke to delegate a sub-task to ChatGPT. Talks to a running Posse instance
// over a narrow, scoped local interface (0600 Unix socket on macOS/Linux; loopback TCP +
// scoped token on Windows). Posse drives ChatGPT in its already-running built-in
// WebContentsView (persist:posse-browser-default) and returns structured output.
//
// Non-goals (issue #121, user-confirmed):
//   - No launching Chrome / a separate browser profile.
//   - No Playwright / Cavendish / Codex / OpenAI API fallback. Web-only; failures surface.
//   - The CLI never receives POSSE_BROWSER_OPS_TOKEN and cannot drive arbitrary pages.
//
// Exit codes mirror CHATGPT_ERRORS / EXIT_CODES in chatgpt-bridge-service.ts.

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---- error code <-> exit code (kept in sync with the service) ----
const EXIT = {
  ok: 0,
  not_running: 3,
  socket_stale: 4,
  not_logged_in: 5,
  selectors_stale: 6,
  selector_drift: 7,
  reply_timeout: 8,
  input_rejected: 9,
  reply_not_readable: 10,
  busy: 11,
  prompt_too_large: 12,
  bad_request: 13,
  internal: 14,
  unknown_op: 14,
  job_not_found: 15,
  unauthorized: 16,
} as const;

const MAX_PROMPT_BYTES = 256 * 1024;
const CLI_USAGE = `posse chatgpt — delegate a sub-task to ChatGPT via Posse's built-in browser

Usage:
  posse chatgpt ask <prompt>              Send a prompt; block for the reply (default).
  posse chatgpt ask <prompt> --detach      Start a detached job; returns a jobId immediately.
  posse chatgpt ask <prompt> --chat <id>   Continue a specific ChatGPT conversation by chatId.
  posse chatgpt ask <prompt> --continue    Continue the most recent conversation (implies --chat <last chatId>).
  posse chatgpt wait <jobId>               Block until a detached job completes; print the reply.
  posse chatgpt reply <jobId>              Print the latest reply for a job (non-blocking).
  posse chatgpt read <jobId>               Print the full transcript (prompt + reply + chatId) for a job.
  posse chatgpt cancel <jobId>             Cancel a running job (best-effort stop-generation).
  posse chatgpt doctor                      Diagnostics: Posse running? socket? logged in? selectors?
  posse chatgpt jobs                        List detached jobs and statuses.

Continuation contract:
  Each completed ask returns a chatId (the /c/<id> from the ChatGPT URL). To follow up
  in the SAME conversation, pass --chat <chatId> (explicit, unambiguous) or --continue
  (sugar: reuses the most recent done job's chatId). Without either, a fresh chat starts.

Flags:
  --json          Emit machine-readable JSON (one object) to stdout.
  --detach        (ask only) Return a jobId immediately; poll with wait/reply.
  --chat <id>     (ask only) Continue the conversation with this chatId.
  --continue      (ask only) Continue the most recent conversation (equivalent to --chat <last chatId>).

Exit codes:
  0 ok · 3 not_running · 4 socket_stale · 5 not_logged_in · 6 selectors_stale ·
  7 selector_drift · 8 reply_timeout · 9 input_rejected · 10 reply_not_readable ·
  11 busy · 12 prompt_too_large · 13 bad_request · 14 internal · 15 job_not_found ·
  16 unauthorized

Notes:
  - Posse must be running and logged into ChatGPT in its built-in browser.
  - The CLI sends context to ChatGPT at the user's explicit intent. Do not send secrets
    you were told not to send — the prompt is logged to the Posse session timeline.
  - No API/Codex fallback exists; web-only. Failures surface as errors.
`;

interface CliArgs {
  command: string;
  prompt?: string;
  jobId?: string;
  chatId?: string;
  json: boolean;
  detach: boolean;
  continue: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // drop node + script
  if (args.length === 0) {
    process.stderr.write(CLI_USAGE);
    process.exit(EXIT.bad_request);
  }
  const command = args[0];
  const rest = args.slice(1);
  const json = rest.includes('--json');
  const detach = rest.includes('--detach');
  const cont = rest.includes('--continue');
  // --chat takes a value: find '--chat' then the next arg is the chatId.
  let chatId: string | undefined;
  const chatIdx = rest.indexOf('--chat');
  if (chatIdx >= 0 && chatIdx + 1 < rest.length) {
    chatId = rest[chatIdx + 1];
  }
  // Positional args = non-flag tokens (exclude --chat's value too).
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1] === '--chat'));

  switch (command) {
    case 'ask': {
      if (positional.length === 0) {
        error('ask requires a prompt argument.', EXIT.bad_request);
      }
      return { command, prompt: positional.join(' '), chatId, json, detach, continue: cont };
    }
    case 'wait':
    case 'reply':
    case 'read':
    case 'cancel': {
      if (positional.length === 0) {
        error(`${command} requires a jobId argument.`, EXIT.bad_request);
      }
      return { command, jobId: positional[0], chatId, json, detach, continue: cont };
    }
    case 'doctor':
    case 'jobs':
      return { command, json, detach, continue: cont };
    case 'help':
    case '--help':
    case '-h':
      process.stderr.write(CLI_USAGE);
      process.exit(EXIT.ok);
    default:
      error(`Unknown command: ${command}\n\n${CLI_USAGE}`, EXIT.unknown_op);
  }
  return null;
}

function error(message: string, code: number): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

// ---- socket resolution ----
function resolveSocketPath(): string {
  if (process.env.POSSE_CHATGPT_SOCKET) return process.env.POSSE_CHATGPT_SOCKET;
  // The service binds under app.getPath('userData'). The CLI must resolve the same path.
  // On macOS (packaged) userData is ~/Library/Application Support/Posse; in dev it is
  // ~/.config/Posse (Electron default on Linux) or the platform equivalent. We mirror the
  // Electron default so the CLI works without the app being on PATH.
  return defaultUserDataFile('posse-chatgpt.sock');
}

function resolveTokenPath(): string | null {
  if (process.platform === 'win32') {
    if (process.env.POSSE_CHATGPT_TOKEN) return process.env.POSSE_CHATGPT_TOKEN;
    return defaultUserDataFile('posse-chatgpt.token');
  }
  return null;
}

function defaultUserDataFile(name: string): string {
  // Mirror Electron's app.getPath('userData') default per platform, since the CLI runs
  // outside Electron and cannot call it. Packaged app name is "Posse".
  const appName = 'Posse';
  let dir: string;
  switch (process.platform) {
    case 'darwin':
      dir = path.join(os.homedir(), 'Library', 'Application Support', appName);
      break;
    case 'win32': {
      const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      dir = path.join(appdata, appName);
      break;
    }
    default:
      dir = path.join(os.homedir(), '.config', appName);
  }
  return path.join(dir, name);
}

// ---- loopback fallback (Windows): resolve host:port + token ----
function resolveLoopback(): { host: string; port: number; token: string } | null {
  // The service writes the port into the socket-path env var slot? No — on Windows the
  // service listens on 127.0.0.1:<random>. The CLI discovers it via the token file's
  // sibling `posse-chatgpt.port` written by the service. (Service writes both in fallback.)
  const portFile = defaultUserDataFile('posse-chatgpt.port');
  const tokenFile = defaultUserDataFile('posse-chatgpt.token');
  try {
    const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
    const tokenJson = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as { token?: string };
    if (Number.isFinite(port) && typeof tokenJson.token === 'string') {
      return { host: '127.0.0.1', port, token: tokenJson.token };
    }
  } catch {
    // fall through
  }
  return null;
}

// ---- send one request, get one response (newline-delimited JSON) ----
function sendRequest(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const useUnix = process.platform !== 'win32';
    let socket: net.Socket;
    let connected = false;
    let buffer = '';
    // Blocking ops (ask sync, wait) can hold up to the completion timeout (5 min). Use a
    // generous idle timeout so the socket doesn't die before the service responds; non-
    // blocking ops return immediately so this doesn't slow them down.
    const isBlocking = req.op === 'ask' || req.op === 'wait';
    const timeoutMs = isBlocking ? 6 * 60 * 1000 : 10_000;
    const cleanup = (err?: Error): void => {
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
    };

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        cleanup(new Error(`Invalid JSON response: ${line.slice(0, 200)}`));
        return;
      }
      resolve(parsed);
      cleanup();
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    };

    const connectError = (msg: string): never => {
      cleanup(new Error(msg));
      // unreachable but for TS
      throw new Error(msg);
    };

    try {
      socket = new net.Socket();
      socket.setEncoding('utf-8');
      socket.setTimeout(timeoutMs);
      socket.on('data', onData);
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (!connected) {
          if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
            cleanup(new Error('Posse is not running. Start Posse and retry.'));
          } else {
            cleanup(err);
          }
        } else {
          cleanup(err);
        }
      });
      socket.on('timeout', () => connectError('Timed out connecting to Posse.'));
      socket.on('close', () => {
        if (!buffer.trim()) cleanup(new Error('Connection closed before a response.'));
      });

      if (useUnix) {
        const sockPath = resolveSocketPath();
        // Stale-socket detection: if the file exists but no one is listening, ENOENT/
        // ECONNREFUSED surfaces above. We do a separate doctor-style check first.
        socket.connect(sockPath, () => {
          connected = true;
          socket.write(JSON.stringify(req) + '\n');
        });
      } else {
        const lb = resolveLoopback();
        if (!lb) {
          cleanup(new Error('Posse is not running. Start Posse and retry.'));
          return;
        }
        req.token = lb.token; // scoped token (NOT the browser-ops token)
        socket.connect(lb.port, lb.host, () => {
          connected = true;
          socket.write(JSON.stringify(req) + '\n');
        });
      }
    } catch (err) {
      cleanup(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---- output ----
function print(result: Record<string, unknown>, json: boolean, humanFormatter: (r: Record<string, unknown>) => string): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(humanFormatter(result) + '\n');
  }
}

function codeOf(result: Record<string, unknown>): string | undefined {
  return typeof result.code === 'string' ? result.code : undefined;
}

function exitForResult(result: Record<string, unknown>): void {
  if (result.ok === true) { process.exit(EXIT.ok); }
  const code = codeOf(result);
  if (code && code in EXIT) {
    process.exit((EXIT as Record<string, number>)[code]);
  }
  process.exit(EXIT.internal);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args) return;

  // Prompt size guard (happens client-side before connecting, per issue #121).
  if (args.prompt && Buffer.byteLength(args.prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    const msg = `Prompt exceeds ${MAX_PROMPT_BYTES} bytes. Summarize before sending.`;
    const out = { ok: false, code: 'prompt_too_large', error: msg };
    print(out, args.json, () => msg);
    process.exit(EXIT.prompt_too_large);
  }

  // For non-ask commands on Unix, do a quick stale-socket check before connecting so
  // the doctor error is crisp.
  const opMap: Record<string, string> = {
    ask: 'ask', wait: 'wait', reply: 'reply', read: 'read', cancel: 'cancel', doctor: 'doctor', jobs: 'jobs',
  };
  const op = opMap[args.command];
  const req: Record<string, unknown> = { op };
  if (args.command === 'ask') {
    req.prompt = args.prompt;
    req.detach = args.detach;
    req.continue = args.continue;
    if (args.chatId) req.chatId = args.chatId;
  } else if (['wait', 'reply', 'read', 'cancel'].includes(args.command)) {
    req.jobId = args.jobId;
  }

  let result: Record<string, unknown>;
  try {
    result = await sendRequest(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the failure looks like "Posse is not running", emit the not_running code.
    const code = /not running|ECONNREFUSED|ENOENT/i.test(message) ? 'not_running' : 'internal';
    const out = { ok: false, code, error: message };
    print(out, args.json, () => message);
    process.exit((EXIT as Record<string, number>)[code] ?? EXIT.internal);
  }

  switch (args.command) {
    case 'ask':
      print(result, args.json, (r) => {
        if (r.ok === true) {
          if (args.detach) {
            const chat = typeof r.chatId === 'string' ? `  chat=${r.chatId}` : '';
            return `Job started: ${r.jobId}${chat}`;
          }
          const chat = typeof r.chatId === 'string' ? `\n[chatId: ${r.chatId}]` : '';
          return typeof r.reply === 'string' ? r.reply + chat : JSON.stringify(r);
        }
        return `Error: ${r.error || 'ask failed.'}`;
      });
      break;
    case 'wait':
      print(result, args.json, (r) => {
        if (r.ok === true) {
          const chat = typeof r.chatId === 'string' ? `\n[chatId: ${r.chatId}]` : '';
          return typeof r.reply === 'string' ? r.reply + chat : JSON.stringify(r);
        }
        return `Error: ${r.error || 'wait failed.'}`;
      });
      break;
    case 'reply':
      print(result, args.json, (r) => {
        if (r.ok === true) return typeof r.reply === 'string' ? r.reply : JSON.stringify(r);
        return `Error: ${r.error || 'reply failed.'}`;
      });
      break;
    case 'read':
      print(result, args.json, (r) => {
        if (r.ok === true) {
          const lines: string[] = [];
          if (typeof r.chatId === 'string') lines.push(`[chatId: ${r.chatId}]`);
          if (typeof r.prompt === 'string') lines.push(`>>> ${r.prompt}`);
          if (typeof r.reply === 'string' && r.reply) lines.push(r.reply);
          return lines.length ? lines.join('\n\n') : '(no transcript)';
        }
        return `Error: ${r.error || 'read failed.'}`;
      });
      break;
    case 'cancel':
      print(result, args.json, (r) => {
        if (r.ok === true) return `Job ${r.jobId}: ${r.status}`;
        return `Error: ${r.error || 'cancel failed.'}`;
      });
      break;
    case 'doctor':
      print(result, args.json, (r) => {
        if (r.ok !== true) return `Error: ${r.error || 'doctor failed.'}`;
        const lines: string[] = [];
        lines.push(`Posse running:    ${r.posseRunning}`);
        lines.push(`Socket reachable: ${r.socketReachable}`);
        lines.push(`ChatGPT logged in: ${r.chatgptLoggedIn}`);
        lines.push(`Selectors fresh:  ${r.selectorsFresh}`);
        if (typeof r.url === 'string') lines.push(`Current URL: ${r.url}`);
        if (typeof r.error === 'string') lines.push(`Note: ${r.error}`);
        return lines.join('\n');
      });
      break;
    case 'jobs':
      print(result, args.json, (r) => {
        if (r.ok !== true) return `Error: ${r.error || 'jobs failed.'}`;
        const jobs = Array.isArray(r.jobs) ? r.jobs : [];
        if (jobs.length === 0) return '(no jobs)';
        return jobs.map((j: Record<string, unknown>) => {
          const chat = typeof j.chatId === 'string' ? `  chat=${j.chatId}` : '';
          return `${j.jobId}  ${j.status}${chat}  ${new Date(Number(j.createdAt)).toISOString()}  reply=${j.replyLength}b`;
        }).join('\n');
      });
      break;
    default:
      print(result, args.json, () => JSON.stringify(result));
  }

  exitForResult(result);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT.internal);
});
