// chatgpt-bridge-service.ts
//
// Posse-side ChatGPT bridge service (#121). A narrow, scoped local IPC server that lets
// the `posse chatgpt` CLI (or any same-user shell-capable agent) delegate a sub-task to
// ChatGPT by driving the already-running embedded browser (persist:posse-browser-default).
//
// Design constraints (issue #121, user-confirmed non-goals):
//   - No Cavendish import/fork/launch. Completion detection re-implemented from first principles.
//   - No launching another Chrome / separate profile. Only Posse's built-in WebContentsView.
//   - No Codex / OpenAI API fallback. Web-only; failures surface as errors.
//   - The CLI never receives POSSE_BROWSER_OPS_TOKEN and cannot drive arbitrary pages.
//   - Reuses the #109 browser ownership lock so the CLI conflicts fairly with ACP agents.
//
// Ownership integration (#109): the service calls BrowserOpsServer.acquireOwner/releaseOwner
// directly with the CLI label. This means ACP mutations see the CLI owner (they get 423) and
// the CLI sees ACP owners (it gets busy). Ownership changes broadcast to the UI. The idle
// timer in BrowserOpsServer prevents a dead CLI process from holding the browser forever.
//
// Continuation semantics: each completed ask captures the chat URL's /c/<chatId> segment as
// the job's chatId. A subsequent ask with an explicit chatId navigates to that conversation
// before typing — unambiguous continuation, no reliance on "current page."
//
// IPC channel: a 0600 Unix domain socket under app.getPath('userData') (macOS/Linux) or a
// loopback TCP port + scoped 0600 token file (Windows). Protocol: newline-delimited JSON.

import { app } from 'electron';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { EmbeddedBrowserManager, EmbeddedBrowserController, ChatGptProbeResult } from './browser-controller';
import type { BrowserOpsServer } from './browser-ops-server';
import { resolveRegistry, type SelectorRegistry } from './chatgpt-selectors';

// ---- Stable error codes + exit-code mapping (CLI mirrors these) ----
export const CHATGPT_ERRORS = {
  NOT_RUNNING: 'not_running',
  SOCKET_STALE: 'socket_stale',
  NOT_LOGGED_IN: 'not_logged_in',
  SELECTORS_STALE: 'selectors_stale',
  SELECTOR_DRIFT: 'selector_drift',
  REPLY_TIMEOUT: 'reply_timeout',
  INPUT_REJECTED: 'input_rejected',
  REPLY_NOT_READABLE: 'reply_not_readable',
  BUSY: 'busy',
  PROMPT_TOO_LARGE: 'prompt_too_large',
  BAD_REQUEST: 'bad_request',
  INTERNAL: 'internal',
  UNKNOWN_OP: 'unknown_op',
  JOB_NOT_FOUND: 'job_not_found',
} as const;
export type ChatGptErrorCode = (typeof CHATGPT_ERRORS)[keyof typeof CHATGPT_ERRORS];

export const EXIT_CODES: Record<ChatGptErrorCode, number> = {
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
};

const MAX_PROMPT_BYTES = 256 * 1024;
const COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETION_POLL_MS = 400;
const COMPLETION_STABILITY_POLLS = 4;
// The #109 lock owner label for CLI usage. Distinct from any ACP session id so the service
// can tell its own hold apart from an ACP agent's.
const OWNER_SESSION_PREFIX = 'posse-chatgpt-cli:';

export interface ChatGptJob {
  id: string;
  prompt: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  reply: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  // Stable ChatGPT conversation id (the /c/<id> URL segment), captured after the first ask
  // completes. Used for explicit continuation: a later ask with this chatId navigates to
  // https://chatgpt.com/c/<chatId> before typing, so continuation is unambiguous.
  chatId?: string;
  // Unique #109 ownership id for this job. Per-job ownership prevents two detached asks
  // from treating a shared static label as re-entrant access to the same tab.
  ownerSessionId: string;
  // Hash of the last assistant turn before submission. Completion requires a different hash.
  baselineHash: string;
  baselineAssistantCount: number;
  // The controller active during streaming, so cancel can best-effort stop-generation.
  controller?: EmbeddedBrowserController;
  registry?: SelectorRegistry;
}

export interface ChatGptBridge {
  address: string;
  isLoopback: boolean;
  close(): void;
}

type BridgeRequest = {
  op: 'ask' | 'wait' | 'reply' | 'read' | 'cancel' | 'jobs' | 'doctor';
  prompt?: string;
  jobId?: string | null;
  chatId?: string | null;
  detach?: boolean;
  continue?: boolean;
};

type BridgeResponse = { ok: true; [key: string]: unknown } | { ok: false; code: string; error: string; [key: string]: unknown };

// Extract the /c/<chatId> segment from a ChatGPT URL. Returns null if not a conversation URL.
function extractChatId(url: string): string | null {
  const m = url.match(/chatgpt\.com\/c\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export async function startChatGptBridgeService(
  manager: EmbeddedBrowserManager,
  opsServer: BrowserOpsServer,
): Promise<ChatGptBridge | null> {
  const jobs = new Map<string, ChatGptJob>();

  const useUnix = process.platform !== 'win32';
  const socketPath = useUnix ? defaultSocketPath() : null;
  const tokenPath = useUnix ? null : path.join(app.getPath('userData'), 'posse-chatgpt.token');
  const portPath = useUnix ? null : path.join(app.getPath('userData'), 'posse-chatgpt.port');
  let loopbackToken: string | null = null;

  function writeLine(socket: net.Socket, res: BridgeResponse): void {
    try { socket.write(JSON.stringify(res) + '\n'); } catch { /* client gone */ }
  }

  async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
    switch (req.op) {
      case 'doctor':
        return doctor(manager);
      case 'ask':
        return ask(manager, opsServer, jobs, req);
      case 'wait':
        return wait(jobs, req);
      case 'reply':
        return reply(jobs, req);
      case 'read':
        return readOp(jobs, req);
      case 'cancel':
        return cancel(jobs, req);
      case 'jobs':
        return listJobs(jobs);
      default:
        return { ok: false, code: CHATGPT_ERRORS.UNKNOWN_OP, error: `Unknown operation: ${req.op}` };
    }
  }

  const onConnection = (socket: net.Socket): void => {
    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.length > 2 * MAX_PROMPT_BYTES) {
        writeLine(socket, { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'Request too large.' });
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let req: BridgeRequest;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as { op?: unknown }).op !== 'string') {
            writeLine(socket, { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'Invalid request: missing op.' });
            continue;
          }
          req = parsed as BridgeRequest;
        } catch {
          writeLine(socket, { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'Invalid JSON.' });
          continue;
        }
        if (!useUnix && loopbackToken) {
          if ((req as { token?: unknown }).token !== loopbackToken) {
            writeLine(socket, { ok: false, code: 'unauthorized', error: 'Invalid scoped token.' });
            continue;
          }
        }
        handleRequest(req).then(
          (res) => writeLine(socket, res),
          (err) => writeLine(socket, {
            ok: false,
            code: CHATGPT_ERRORS.INTERNAL,
            error: err instanceof Error ? err.message : 'Internal error.',
          }),
        );
      }
    });
    socket.on('error', () => { /* client disconnect — ignore */ });
  };

  let server: net.Server;
  let address: string;
  let isLoopback = false;

  if (useUnix && socketPath) {
    server = net.createServer(onConnection);
    try { fs.unlinkSync(socketPath); } catch { /* not present */ }
    try {
      await listen(server, socketPath);
      fs.chmodSync(socketPath, 0o600);
    } catch (err) {
      try { server.close(); } catch { /* ignore */ }
      console.error('[ChatGptBridge] failed to bind Unix socket:', err);
      return null;
    }
    address = socketPath;
  } else {
    isLoopback = true;
    server = net.createServer(onConnection);
    loopbackToken = randomBytes(24).toString('hex');
    try {
      await listen(server, 0, '127.0.0.1');
    } catch (err) {
      try { server.close(); } catch { /* ignore */ }
      console.error('[ChatGptBridge] failed to bind loopback:', err);
      return null;
    }
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      try { server.close(); } catch { /* ignore */ }
      console.error('[ChatGptBridge] loopback server bound to unexpected address');
      return null;
    }
    const port = addr.port;
    address = `127.0.0.1:${port}`;
    try {
      if (tokenPath) {
        fs.writeFileSync(tokenPath, JSON.stringify({ token: loopbackToken }), { mode: 0o600 });
        fs.chmodSync(tokenPath, 0o600);
      }
      if (portPath) {
        fs.writeFileSync(portPath, String(port), { mode: 0o600 });
        fs.chmodSync(portPath, 0o600);
      }
    } catch (err) {
      try { server.close(); } catch { /* ignore */ }
      console.error('[ChatGptBridge] failed to write scoped endpoint files:', err);
      return null;
    }
  }

  server.on('error', (err) => {
    console.error('[ChatGptBridge] server error:', err);
  });

  const handle = server;
  return {
    address,
    isLoopback,
    close(): void {
      try { handle.close(); } catch { /* ignore */ }
      // Release any lingering CLI ownership on shutdown so the #109 lock doesn't leak.
      for (const job of jobs.values()) opsServer.releaseOwner(job.ownerSessionId);
      if (useUnix && socketPath) {
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      }
      if (!useUnix && tokenPath) {
        try { fs.unlinkSync(tokenPath); } catch { /* already gone */ }
      }
      if (!useUnix && portPath) {
        try { fs.unlinkSync(portPath); } catch { /* already gone */ }
      }
    },
  };
}

function listen(server: net.Server, path: string): Promise<void>;
function listen(server: net.Server, port: number, host: string): Promise<void>;
function listen(server: net.Server, target: string | number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    const done = () => {
      server.off('error', onError);
      resolve();
    };
    if (typeof target === 'string') server.listen(target, done);
    else server.listen(target, host, done);
  });
}

export function defaultSocketPath(): string {
  if (process.env.POSSE_CHATGPT_SOCKET) return process.env.POSSE_CHATGPT_SOCKET;
  return path.join(app.getPath('userData'), 'posse-chatgpt.sock');
}

// ---- doctor ----
async function doctor(manager: EmbeddedBrowserManager): Promise<BridgeResponse> {
  const controller = manager.agentController();
  if (!controller) {
    return {
      ok: true,
      posseRunning: true,
      socketReachable: true,
      chatgptLoggedIn: false,
      selectorsFresh: false,
      note: 'No embedded browser is mounted. Open the browser view in Posse.',
    };
  }
  const state = controller.agentState();
  const onChatgpt = /chatgpt\.com/.test(state.url);
  let loginProbe = false;
  let selectorResults: Record<string, boolean> = {};
  if (onChatgpt) {
    const registry = resolveRegistry(state.url);
    try {
      const probeResult = await controller.agentRunChatgptProbe({
        composer: registry.composer,
        send_button: registry.send_button,
        stop_button: registry.stop_button,
        assistant_message_last: registry.assistant_message_last,
        login_indicator: registry.login_indicator,
      });
      if (!probeResult.ok || !probeResult.probe) {
        return {
          ok: true,
          posseRunning: true,
          socketReachable: true,
          chatgptLoggedIn: false,
          selectorsFresh: false,
          url: state.url,
          error: probeResult.error,
        };
      }
      const probe = probeResult.probe;
      loginProbe = probe.loginPresent;
      selectorResults = {
        composer: probe.lastMsgPresent || probe.composerEnabled,
        send_button: probe.sendEnabled || probe.composerEnabled,
        stop_button: true,
        assistant_message_last: probe.lastMsgPresent,
        login_indicator: probe.loginPresent,
      };
    } catch (err) {
      return {
        ok: true,
        posseRunning: true,
        socketReachable: true,
        chatgptLoggedIn: false,
        selectorsFresh: false,
        url: state.url,
        error: err instanceof Error ? err.message : 'Probe failed.',
      };
    }
  }
  return {
    ok: true,
    posseRunning: true,
    socketReachable: true,
    chatgptLoggedIn: loginProbe,
    selectorsFresh: Object.values(selectorResults).some(Boolean),
    onChatgpt,
    url: state.url,
    selectors: selectorResults,
  };
}

// ---- ask ----
async function ask(
  manager: EmbeddedBrowserManager,
  opsServer: BrowserOpsServer,
  jobs: Map<string, ChatGptJob>,
  req: BridgeRequest,
): Promise<BridgeResponse> {
  const prompt = typeof req.prompt === 'string' ? req.prompt : '';
  if (!prompt) {
    return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'prompt is required.' };
  }
  if (Buffer.byteLength(prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      code: CHATGPT_ERRORS.PROMPT_TOO_LARGE,
      error: `Prompt exceeds ${MAX_PROMPT_BYTES} bytes. Summarize before sending.`,
    };
  }

  const controller = manager.agentController();
  if (!controller) {
    return { ok: false, code: CHATGPT_ERRORS.NOT_RUNNING, error: 'No embedded browser is available. Open the browser view in Posse.' };
  }

  // Ownership via the real #109 lock. Use a unique owner per job: a second detached CLI
  // request must conflict rather than sharing a static, re-entrant label and corrupting the tab.
  const jobId = randomUUID();
  const ownerSessionId = OWNER_SESSION_PREFIX + jobId;
  if (!opsServer.acquireOwner(ownerSessionId)) {
    const owner = opsServer.currentOwner();
    return {
      ok: false,
      code: CHATGPT_ERRORS.BUSY,
      error: owner
        ? `Browser is currently controlled by another session (${owner}). Wait for it to finish or have the user release control.`
        : 'Browser is currently controlled by another session.',
    };
  }

  // Resolve the target conversation URL. Continuation is explicit + unambiguous:
  //   - chatId given: navigate to https://chatgpt.com/c/<chatId> (that exact conversation)
  //   - continue flag (no chatId): reuse the chatId from the most recent done job
  //   - neither: navigate to https://chatgpt.com/ for a fresh new chat
  let targetChatId: string | null = null;
  if (typeof req.chatId === 'string' && req.chatId) {
    if (!/^[A-Za-z0-9_-]+$/.test(req.chatId)) {
      opsServer.releaseOwner(ownerSessionId);
      return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'Invalid chatId.' };
    }
    targetChatId = req.chatId;
  } else if (req.continue) {
    // Find the most recent done job with a chatId.
    for (const j of Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt)) {
      if (j.status === 'done' && j.chatId) { targetChatId = j.chatId; break; }
    }
    if (!targetChatId) {
      // No prior chat to continue — start fresh but tell the caller.
      // (Not an error; --continue with no prior chat is equivalent to a new chat.)
    }
  }

  const state = controller.agentState();
  const onChatgpt = /chatgpt\.com/.test(state.url);
  const targetUrl = targetChatId ? `https://chatgpt.com/c/${targetChatId}` : 'https://chatgpt.com/';
  // Navigate if: not on ChatGPT, OR targeting a specific chat that isn't the current URL,
  // OR (fresh chat requested but not already at root). Avoid needless reloads.
  const atTarget = state.url === targetUrl || (targetChatId === null && /^https:\/\/chatgpt\.com\/?$/.test(state.url));
  const shouldNavigate = !onChatgpt || !atTarget;
  if (shouldNavigate) {
    const nav = await controller.agentNavigate(targetUrl);
    if (!nav.ok) {
      opsServer.releaseOwner(ownerSessionId);
      return { ok: false, code: CHATGPT_ERRORS.INTERNAL, error: nav.error || 'Navigation failed.' };
    }
  }

  const registry = resolveRegistry(controller.agentState().url);

  // Login check before sending input.
  const loginProbeResult = await controller.agentRunChatgptProbe({
    composer: registry.composer,
    send_button: registry.send_button,
    stop_button: registry.stop_button,
    assistant_message_last: registry.assistant_message_last,
    login_indicator: registry.login_indicator,
  });
  if (!loginProbeResult.ok || !loginProbeResult.probe) {
    opsServer.releaseOwner(ownerSessionId);
    return { ok: false, code: CHATGPT_ERRORS.INTERNAL, error: loginProbeResult.error || 'Login probe failed.' };
  }
  if (!loginProbeResult.probe.loginPresent) {
    opsServer.releaseOwner(ownerSessionId);
    return {
      ok: false,
      code: CHATGPT_ERRORS.NOT_LOGGED_IN,
      error: 'Not logged into ChatGPT. Log in manually in the Posse browser, then retry.',
    };
  }

  // Capture the pre-submit last assistant turn so completion cannot mistake an existing
  // stable reply for the response to this prompt (especially when continuing a chat).
  const baselineHash = loginProbeResult.probe.lastTextHash;

  // Type the prompt + submit. agentType uses sendInputEvent (real events).
  const typeResult = await controller.agentType({ text: prompt, element: { css: registry.composer?.css || '' }, submit: false });
  if (!typeResult.ok) {
    opsServer.releaseOwner(ownerSessionId);
    return { ok: false, code: CHATGPT_ERRORS.INPUT_REJECTED, error: typeResult.error || 'Typing into the composer failed.' };
  }
  const submitResult = await controller.agentKeypress('Return');
  if (!submitResult.ok) {
    opsServer.releaseOwner(ownerSessionId);
    return { ok: false, code: CHATGPT_ERRORS.INPUT_REJECTED, error: submitResult.error || 'Submit failed.' };
  }

  const job: ChatGptJob = {
    id: jobId,
    prompt,
    status: 'streaming',
    reply: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chatId: targetChatId || undefined,
    ownerSessionId,
    controller,
    registry,
    baselineHash,
    baselineAssistantCount: loginProbeResult.probe.assistantCount,
  };
  jobs.set(jobId, job);

  if (req.detach) {
    runCompletionLoop(controller, registry, job, opsServer).catch((err) => {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : 'Completion loop failed.';
      job.updatedAt = Date.now();
    });
    return { ok: true, jobId, status: 'streaming', chatId: targetChatId || undefined };
  }

  try {
    await runCompletionLoop(controller, registry, job, opsServer);
  } catch (err) {
    return {
      ok: false,
      code: job.error === 'reply_timeout' ? CHATGPT_ERRORS.REPLY_TIMEOUT : CHATGPT_ERRORS.INTERNAL,
      error: err instanceof Error ? err.message : 'Completion failed.',
      jobId,
    };
  }
  if (job.status === 'error') {
    return { ok: false, code: CHATGPT_ERRORS.REPLY_TIMEOUT, error: job.error || 'Reply timed out.', jobId };
  }
  if (job.status === 'cancelled') {
    return { ok: false, code: CHATGPT_ERRORS.REPLY_TIMEOUT, error: 'Job was cancelled.', jobId };
  }
  return { ok: true, jobId, reply: job.reply, status: job.status, chatId: job.chatId };
}

// ---- completion loop ----
async function runCompletionLoop(
  controller: EmbeddedBrowserController,
  registry: SelectorRegistry,
  job: ChatGptJob,
  opsServer: BrowserOpsServer,
): Promise<void> {
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let stablePolls = 0;
  let lastHash = '';

  try {
    while (Date.now() < deadline) {
      if (job.status === 'cancelled') return;
      // Renew the shared #109 idle lease while work is active. Without this, a long
      // ChatGPT response could lose ownership at five minutes and race an ACP mutation.
      if (!opsServer.acquireOwner(job.ownerSessionId)) {
        job.status = 'error';
        job.error = 'browser ownership was lost';
        job.updatedAt = Date.now();
        return;
      }
      await sleep(COMPLETION_POLL_MS);
      let probe: ChatGptProbeResult;
      try {
        const probeResult = await controller.agentRunChatgptProbe({
          composer: registry.composer,
          send_button: registry.send_button,
          stop_button: registry.stop_button,
          assistant_message_last: registry.assistant_message_last,
          login_indicator: registry.login_indicator,
        });
        if (!probeResult.ok || !probeResult.probe) continue;
        probe = probeResult.probe;
      } catch {
        continue;
      }

      // Signal #1: stop button visible => still generating.
      if (probe.stopVisible) {
        stablePolls = 0;
        lastHash = probe.lastTextHash;
        continue;
      }

      // Signal #2 + #3: composer re-enabled AND last-bubble text stable across N polls.
      if (probe.lastTextHash === lastHash && probe.lastTextHash !== '') {
        stablePolls += 1;
      } else {
        stablePolls = 0;
        lastHash = probe.lastTextHash;
      }

      const hasNewReply = probe.lastTextHash !== ''
        && probe.lastTextHash !== job.baselineHash
        && probe.assistantCount > job.baselineAssistantCount;
      const generationFinished = probe.copyVisible || probe.composerEnabled || probe.sendEnabled;
      if (generationFinished && stablePolls >= COMPLETION_STABILITY_POLLS && probe.lastMsgPresent && hasNewReply) {
        // Done — extract the reply text via the public sanitized method.
        const replyResult = await controller.agentExtractChatgptReply(registry.assistant_message_last || {});
        if (!replyResult.ok) {
          job.status = 'error';
          job.error = replyResult.error || 'Reply not extractable from DOM (possible canvas/iframe).';
          job.updatedAt = Date.now();
          return;
        }
        job.reply = replyResult.text || '';
        job.status = 'done';
        // Capture the chatId from the current URL so the caller can continue explicitly.
        job.chatId = extractChatId(controller.agentState().url) || job.chatId;
        job.updatedAt = Date.now();
        return;
      }
    }
    job.status = 'error';
    job.error = 'reply_timeout';
    job.updatedAt = Date.now();
  } finally {
    // Always release the CLI's hold on the browser — the #109 lock must not leak.
    opsServer.releaseOwner(job.ownerSessionId);
  }
}

// ---- wait / reply / read / cancel / jobs ----
async function wait(jobs: Map<string, ChatGptJob>, req: BridgeRequest): Promise<BridgeResponse> {
  const jobId = req.jobId;
  if (!jobId) return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'jobId is required.' };
  const job = jobs.get(jobId);
  if (!job) return { ok: false, code: CHATGPT_ERRORS.JOB_NOT_FOUND, error: `No job with id ${jobId}.` };
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (job.status === 'done') return { ok: true, jobId, status: 'done', reply: job.reply, chatId: job.chatId };
    if (job.status === 'error') return { ok: false, code: job.error === 'reply_timeout' ? CHATGPT_ERRORS.REPLY_TIMEOUT : CHATGPT_ERRORS.INTERNAL, error: job.error || 'Job errored.', jobId };
    if (job.status === 'cancelled') return { ok: false, code: CHATGPT_ERRORS.REPLY_TIMEOUT, error: 'Job was cancelled.', jobId };
    await sleep(500);
  }
  return { ok: false, code: CHATGPT_ERRORS.REPLY_TIMEOUT, error: 'wait timed out.', jobId };
}

async function reply(jobs: Map<string, ChatGptJob>, req: BridgeRequest): Promise<BridgeResponse> {
  const jobId = req.jobId;
  if (!jobId) return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'jobId is required.' };
  const job = jobs.get(jobId);
  if (!job) return { ok: false, code: CHATGPT_ERRORS.JOB_NOT_FOUND, error: `No job with id ${jobId}.` };
  return { ok: true, jobId, status: job.status, reply: job.reply, chatId: job.chatId, error: job.error };
}

async function readOp(jobs: Map<string, ChatGptJob>, req: BridgeRequest): Promise<BridgeResponse> {
  const jobId = req.jobId;
  if (!jobId) return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'jobId is required.' };
  const job = jobs.get(jobId);
  if (!job) return { ok: false, code: CHATGPT_ERRORS.JOB_NOT_FOUND, error: `No job with id ${jobId}.` };
  return {
    ok: true,
    jobId,
    status: job.status,
    prompt: job.prompt,
    reply: job.reply,
    chatId: job.chatId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function cancel(jobs: Map<string, ChatGptJob>, req: BridgeRequest): Promise<BridgeResponse> {
  const jobId = req.jobId;
  if (!jobId) return { ok: false, code: CHATGPT_ERRORS.BAD_REQUEST, error: 'jobId is required.' };
  const job = jobs.get(jobId);
  if (!job) return { ok: false, code: CHATGPT_ERRORS.JOB_NOT_FOUND, error: `No job with id ${jobId}.` };
  if (job.status === 'streaming') {
    job.status = 'cancelled';
    job.updatedAt = Date.now();
    // Best-effort stop-generation: probe for the stop button; if present, send Escape
    // (the documented ChatGPT stop shortcut). Cannot mid-generation abort ChatGPT itself.
    if (job.controller && job.registry) {
      try {
        const probeResult = await job.controller.agentRunChatgptProbe({
          composer: job.registry.composer,
          send_button: job.registry.send_button,
          stop_button: job.registry.stop_button,
          assistant_message_last: job.registry.assistant_message_last,
          login_indicator: job.registry.login_indicator,
        });
        if (probeResult.ok && probeResult.probe?.stopVisible) {
          await job.controller.agentKeypress('Escape');
        }
      } catch {
        // best-effort — the loop will exit on cancelled status regardless.
      }
    }
  }
  return { ok: true, jobId, status: job.status };
}

async function listJobs(jobs: Map<string, ChatGptJob>): Promise<BridgeResponse> {
  const list = Array.from(jobs.values()).map((j) => ({
    jobId: j.id,
    status: j.status,
    chatId: j.chatId,
    createdAt: j.createdAt,
    replyLength: j.reply.length,
  }));
  return { ok: true, jobs: list };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
