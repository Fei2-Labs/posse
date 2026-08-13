import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Writable, Readable } from 'node:stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'node:perf_hooks';
import type {
  ClientContext,
  ContentBlock,
  EnvVariable,
  McpServer,
  McpServerStdio,
  PermissionOption,
  PromptCapabilities,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';
import {
  upsertAcpSession,
  closeAcpSession,
  removeAcpSession,
  listAcpSessions,
  type AcpStoredSession,
} from './acp-session-store';

// When Posse is launched from Finder/Dock, the app inherits macOS's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — node/npx (homebrew) and user CLIs are missing.
// Augment PATH with the standard install locations (same fix as pty-manager).
function augmentedPath(basePath: string | undefined): string {
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
  ];
  const parts = (basePath || '').split(':').filter(Boolean);
  for (const p of extras) {
    if (!parts.includes(p)) parts.push(p);
  }
  return parts.join(':');
}

// ========== Adapter spawning (#82) ==========
// npx-backed adapters were spawned as `npx -y <pkg>`, which re-resolves the package on
// every launch even when it is fully cached and NPM_CONFIG_PREFER_OFFLINE is set. spawn()
// returns in ~2ms because npx is a shell script, so all of that cost landed inside the
// 'initializing-protocol' phase, making it look like protocol work. Measured here: ~3.1s
// for npx vs ~0.3-0.6s spawning the cached entry point directly — and restoring a dozen
// sessions in parallel made those npx processes contend on the npm cache, inflating the
// phase to ~15s each.
//
// So: resolve the package npx already downloaded and run it directly, falling back to npx
// when nothing is cached (first run, where npx has to install it anyway).

// Highest cached version wins; `null` means "not cached, let npx install it".
function resolveCachedNpxBin(pkg: string): string | null {
  const root = path.join(os.homedir(), '.npm', '_npx');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }

  let best: { version: string; bin: string } | null = null;
  for (const entry of entries) {
    const pkgDir = path.join(root, entry, 'node_modules', pkg);
    let manifest: { version?: string; bin?: string | Record<string, string> };
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const binField = manifest.bin;
    const relBin = typeof binField === 'string' ? binField : Object.values(binField || {})[0];
    if (!relBin) continue;
    const bin = path.join(pkgDir, relBin);
    if (!fs.existsSync(bin)) continue;
    const version = manifest.version || '0.0.0';
    if (!best || compareSemver(version, best.version) > 0) best = { version, bin };
  }
  return best?.bin ?? null;
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

// Resolution is memoized: a cold start restores many sessions at once and they would
// otherwise each walk the npx cache directory.
const npxBinCache = new Map<string, string | null>();
function cachedNpxBin(pkg: string): string | null {
  if (!npxBinCache.has(pkg)) {
    const bin = resolveCachedNpxBin(pkg);
    npxBinCache.set(pkg, bin);
    console.info(`[ACP] ${pkg}: ${bin ? `using cached adapter ${bin}` : 'not cached, falling back to npx'}`);
  }
  return npxBinCache.get(pkg) ?? null;
}

// Running from cache means we no longer pick up new adapter releases on launch, so refresh
// the cache once per app run — off the critical path, for the *next* launch to pick up.
const npxRefreshed = new Set<string>();
function refreshNpxPackageInBackground(pkg: string, env: NodeJS.ProcessEnv): void {
  if (npxRefreshed.has(pkg)) return;
  npxRefreshed.add(pkg);
  setTimeout(() => {
    try {
      const child = spawn('npx', ['-y', pkg, '--version'], {
        stdio: 'ignore',
        shell: true,
        detached: true,
        env: { ...env, NPM_CONFIG_PREFER_OFFLINE: 'false' },
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      // Best-effort only: a failed refresh just means we keep using the cached copy.
    }
  }, 30_000).unref?.();
}

// Spawn an adapter, preferring the cached entry point over npx. Electron's own binary
// doubles as node via ELECTRON_RUN_AS_NODE, so this needs no system node install.
function spawnAcpAdapter(
  acpCmd: { cmd: string; args: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  if (acpCmd.cmd === 'npx') {
    const pkg = acpCmd.args[acpCmd.args.length - 1];
    const bin = cachedNpxBin(pkg);
    if (bin) {
      refreshNpxPackageInBackground(pkg, env);
      return spawn(process.execPath, [bin], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
      });
    }
  }
  // npx is a shell script, not a binary — needs shell:true to resolve on macOS.
  // System-installed agents (copilot, kiro-cli, opencode) are real binaries but
  // shell:true is harmless for them too and ensures PATH resolution.
  return spawn(acpCmd.cmd, acpCmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env,
    shell: acpCmd.cmd === 'npx',
  });
}

// ========== Session-load concurrency (#82) ==========
// Restoring sessions fires acp:load for every persisted session at once. That was masked
// by npx, whose ~3s resolution accidentally staggered the spawns; running adapters directly
// removed the stagger and all of them hit the agent's rollout parsing simultaneously,
// pushing 'loading-session' from ~12s to ~27s on the later sessions. A small permit pool
// keeps the machine busy without letting a dozen adapters thrash it.
//
// Only restores are gated. Creating a new session is a direct user action and must never
// queue behind a background restore.
const ACP_LOAD_CONCURRENCY = 3;
let loadPermits = ACP_LOAD_CONCURRENCY;
const loadWaiters: (() => void)[] = [];

async function acquireLoadSlot(): Promise<() => void> {
  if (loadPermits > 0) {
    loadPermits--;
  } else {
    // Resolving a waiter hands the permit straight over, so the count can never drift.
    await new Promise<void>(resolve => loadWaiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = loadWaiters.shift();
    if (next) next();
    else loadPermits++;
  };
}

type AcpSdk = typeof import('@agentclientprotocol/sdk');

// TypeScript rewrites import() to require() when emitting CommonJS. Constructing
// the importer at runtime preserves native ESM loading for the ESM-only ACP SDK.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<AcpSdk>;
let acpSdkPromise: Promise<AcpSdk> | null = null;

const ACP_CREATE_TIMEOUT_MS = 30_000;
const ACP_LOAD_TIMEOUT_MS = 90_000;

// ===================== Agent browser bridge (MCP) =====================
// ACP has no in-process transport; the only universally-required transport is stdio.
// So the browser-control MCP server runs as a stdio subprocess (browser-mcp.js) that
// calls back into the Electron main process over a loopback HTTP bridge. This config
// holds the bridge's baseUrl + bearer token; index.ts sets it at launch via
// setBrowserMcpConfig after startBrowserOpsServer binds a port. When unset, no
// browser tools are offered (sessions still create with mcpServers: []).
export interface BrowserMcpConfig {
  baseUrl: string;
  token: string;
}

let browserMcpConfig: BrowserMcpConfig | null = null;

export function setBrowserMcpConfig(config: BrowserMcpConfig | null): void {
  browserMcpConfig = config;
}

// ===================== Browser-tool policy (issue #109) =====================
// Global on/off for the agent browser bridge. Defaults to ON (the issue requires
// "available to agents by default"). The user can turn it off globally via the
// settings UI; future per-session override can thread a param through create()/load().
// When OFF, buildBrowserMcpServer() returns null → sessions create with mcpServers: []
// → no browser tools surfaced to the agent. The bridge HTTP server stays up (cheap,
// token-authed, loopback-only); only the MCP injection is gated.
let browserBridgeEnabled = true;

export function setBrowserBridgeEnabled(enabled: boolean): void {
  browserBridgeEnabled = enabled;
}

export function isBrowserBridgeEnabled(): boolean {
  return browserBridgeEnabled;
}

// Resolve the bundled browser-mcp.js. In dev it lives next to this file in dist/main;
// packaged, electron-builder ships dist/** under the asar, so __dirname (inside asar)
// still reaches the sibling file. process.execPath is the Electron binary when running
// as the app (needs ELECTRON_RUN_AS_NODE=1 to behave as plain node) or plain node in
// headless mode.
function resolveBrowserMcpCommand(sessionId: string): { command: string; args: string[]; env: EnvVariable[] } | null {
  if (!browserMcpConfig) return null;
  const scriptPath = path.join(__dirname, 'browser-mcp.js');
  // ELECTRON_RUN_AS_NODE=1 makes the Electron binary run as plain node (the pty-daemon
  // pattern). In headless/standalone-node contexts process.versions.electron is undefined
  // and the flag is unnecessary (and already inherited if set).
  const env: EnvVariable[] = [
    { name: 'POSSE_BROWSER_OPS_URL', value: browserMcpConfig.baseUrl },
    { name: 'POSSE_BROWSER_OPS_TOKEN', value: browserMcpConfig.token },
    // The owning ACP session id, so the bridge can claim browser ownership on first
    // call and the server can reject conflicting control by another session (#109).
    { name: 'POSSE_BROWSER_OPS_SESSION', value: sessionId },
  ];
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    env.push({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
    return { command: process.execPath, args: [scriptPath], env };
  }
  return { command: process.execPath, args: [scriptPath], env };
}

function buildBrowserMcpServer(sessionId: string): McpServer | null {
  if (!browserBridgeEnabled) return null;
  const resolved = resolveBrowserMcpCommand(sessionId);
  if (!resolved) return null;
  const stdio: McpServerStdio = {
    name: 'posse-browser',
    command: resolved.command,
    args: resolved.args,
    env: resolved.env,
  };
  return stdio;
}

// Issue #109: the one-time instruction block prepended to a session's first user
// prompt. Only prepended when the browser bridge is enabled (see prompt()); when
// disabled, no instruction is added — the agent simply has no browser tools.
// This only GUIDES the agent (recommends the Posse built-in browser for web app
// testing + reminds it the user's login is already present). The UI does not claim
// it can force every third-party agent to invoke the tool.
function buildBrowserInstructionBlocks(): { type: 'text'; text: string }[] {
  if (!browserBridgeEnabled) return [];
  return [{
    type: 'text',
    text: [
      '[Posse environment note]',
      'A built-in web browser is available to you via the "posse-browser" MCP tools (browser_get_state, browser_navigate, browser_screenshot, browser_dom_snapshot, browser_click, browser_type, browser_keypress, browser_scroll).',
      'When you need to test or interact with a web application, prefer this built-in browser over launching any external or headless browser.',
      'The user is already logged into this browser (persist:posse-browser-default); reuse that session rather than asking the user to re-authenticate. Do not request, print, or exfiltrate cookies, passwords, MFA codes, authorization headers, or stored secrets — the tools intentionally do not expose them.',
      'Screenshots are pixel captures only; DOM snapshots are sanitized.',
      '',
      '[ChatGPT delegation (issue #121)]',
      'When the user explicitly asks to use ChatGPT (e.g. "ask ChatGPT", "get ChatGPT\'s take", "continue in ChatGPT", "second opinion from ChatGPT"), invoke the `posse chatgpt` CLI rather than opening ChatGPT yourself or falling back to any other model/API. The CLI reuses this same logged-in built-in browser (no separate Chrome/profile) over a scoped local socket.',
      'Commands: `posse chatgpt ask "<prompt>"` (sync), `posse chatgpt ask "<prompt>" --detach` then `posse chatgpt wait <jobId>` (async), `posse chatgpt doctor` (diagnostics). Use `--json` for machine-readable output and to capture exit codes.',
      'Continuation: each completed ask returns a chatId. To follow up in the same conversation, pass `--chat <chatId>` (explicit) or `--continue` (reuses the most recent chatId). Without either, a fresh chat starts.',
      'Never silently fall back to another model or an API if ChatGPT is unavailable — surface the CLI error (e.g. not_logged_in, busy, selectors_stale) to the user so they can act on it.',
      'The CLI sends context to ChatGPT at the user\'s explicit intent. Do not send secrets you were told not to send; the prompt is logged to the Posse session timeline for audit.',
      '',
    ].join('\n'),
  }];
}

function loadAcpSdk(): Promise<AcpSdk> {
  if (!acpSdkPromise) {
    // #113: never cache a rejected import — a cached rejection makes every later
    // Retry fail with the original error even once the cause is gone.
    acpSdkPromise = importEsm('@agentclientprotocol/sdk').catch((error) => {
      acpSdkPromise = null;
      throw error;
    });
  }
  return acpSdkPromise;
}

// Map agent keys to their ACP spawn commands.
// Keys are matched against the preset command's known built-in command name
// (NOT substring — see getAcpCommand for exact matching logic).
const ACP_AGENT_COMMANDS: Record<string, [string, string[]]> = {
  'claude': ['npx', ['-y', '@agentclientprotocol/claude-agent-acp']],
  'codex': ['npx', ['-y', '@agentclientprotocol/codex-acp']],
  'copilot': ['copilot', ['--acp']],
  'kiro': ['kiro-cli', ['acp']],
  'opencode': ['opencode', ['acp']],
};

// The set of built-in preset command prefixes that are ACP-eligible.
// Custom presets and ssh wrappers are NOT matched — they stay PTY in Phase 1.
const ACP_BUILTIN_PRESETS = new Set([
  'claude --dangerously-skip-permissions',
  'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"',
  'copilot --allow-all --autopilot',
  // Copilot history resume commands normalize to the bare executable after
  // Posse strips `--resume <id>` before calling session/load.
  'copilot',
  'kiro-cli chat --trust-all-tools',
  'opencode',
  // Codex history emits `codex resume <id>`; stripping the resume clause leaves this.
  'codex',
]);

// Detect whether a preset command maps to an ACP-capable agent.
// Matches only against known built-in preset command prefixes (not substrings)
// to avoid false positives on custom presets, ssh wrappers, etc.
export function getAcpCommand(presetCommand: string): { cmd: string; args: string[] } | null {
  const lower = presetCommand.toLowerCase().trim();
  // The preset command may have trailing flags (e.g. "claude --dangerously-skip-permissions");
  // match the base command word.
  const baseCmd = lower.split(/\s+/)[0];
  for (const [key, [cmd, args]] of Object.entries(ACP_AGENT_COMMANDS)) {
    // For npx-based agents (claude, codex), the base command IS the key
    if (baseCmd === key) return { cmd, args };
  }
  // For system-installed agents, the base command is the binary name
  if (baseCmd === 'copilot') return { cmd: 'copilot', args: ['--acp'] };
  if (baseCmd === 'kiro-cli') return { cmd: 'kiro-cli', args: ['acp'] };
  if (baseCmd === 'opencode') return { cmd: 'opencode', args: ['acp'] };
  return null;
}

export function canonicalAcpPresetCommand(presetCommand: string): string | null {
  const lower = presetCommand.toLowerCase().trim();
  if (ACP_BUILTIN_PRESETS.has(lower)) return lower;

  const hasResumeClause = /(?:^|\s)(?:--resume(?:-id)?|resume)\s+\S+/.test(lower);
  if (!hasResumeClause) return null;
  const withoutResume = lower
    .replace(/\s+--resume(?:-id)?\s+\S+/g, ' ')
    .replace(/\s+resume\s+\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^claude(?: --dangerously-skip-permissions)*$/.test(withoutResume)) {
    return 'claude --dangerously-skip-permissions';
  }
  if (withoutResume === 'codex') return 'codex';
  if (/^copilot(?: --allow-all| --autopilot)*$/.test(withoutResume)) {
    return 'copilot --allow-all --autopilot';
  }
  if (/^kiro-cli chat(?: --trust-all-tools)*$/.test(withoutResume)) {
    return 'kiro-cli chat --trust-all-tools';
  }
  return null;
}

// Check if a preset command is ACP-eligible (used by the acp:check IPC handler).
// This is stricter than getAcpCommand — it also validates that the preset
// command starts with a known built-in prefix, preventing custom presets
// (e.g. "claude --proxy http://my-proxy") from accidentally routing to ACP
// unless they use the exact built-in command.
export function isAcpEligible(presetCommand: string): boolean {
  return canonicalAcpPresetCommand(presetCommand) !== null;
}

export function preferredFullAccessConfig(
  configOptions: SessionConfigOption[],
): { configId: string; value: string } | null {
  const modeOption = configOptions.find(option =>
    option.type === 'select' && (option.id === 'mode' || option.category === 'mode')
  );
  if (!modeOption || modeOption.type !== 'select') return null;

  const options = modeOption.options.flatMap(option => 'group' in option ? option.options : [option]);
  const preferredValues = ['bypassPermissions', 'agent-full-access'];
  for (const value of preferredValues) {
    if (options.some(option => option.value === value)) return { configId: modeOption.id, value };
  }

  const descriptiveMatch = options.find((option) => {
    const label = `${option.value} ${option.name} ${option.description || ''}`.toLowerCase();
    return /bypass|full[ -]?access|allow[ -]?all|trust[ -]?all|unrestricted/.test(label);
  });
  return descriptiveMatch ? { configId: modeOption.id, value: descriptiveMatch.value } : null;
}

const DEFAULT_CONTEXT_WINDOW = 1_000_000;

function flattenConfigOptions(option: Extract<SessionConfigOption, { type: 'select' }>): SessionConfigSelectOption[] {
  return option.options.flatMap(item => 'group' in item ? item.options : [item]);
}

function parseContextSize(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim().toLowerCase();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(m|k)?(?:\s*tokens?)?/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1);
}

export function preferredContextWindowConfig(
  configOptions: SessionConfigOption[],
  target = DEFAULT_CONTEXT_WINDOW,
): { configId: string; value: string; size: number } | null {
  const contextOption = configOptions.find(option => {
    const haystack = `${option.id} ${option.name} ${option.category || ''} ${option.description || ''}`.toLowerCase();
    return option.type === 'select' && /context|window|token.?limit/.test(haystack);
  });
  if (!contextOption || contextOption.type !== 'select') return null;
  const candidates = flattenConfigOptions(contextOption).flatMap(option => {
    const size = parseContextSize(`${option.value} ${option.name} ${option.description || ''}`);
    return size ? [{ option, size }] : [];
  });
  if (!candidates.length) return null;
  // Never silently select a larger window than requested. If 1M is unavailable,
  // choose next lower available size; if no lower size exists, leave adapter default.
  const eligible = candidates.filter(candidate => candidate.size <= target);
  const selected = eligible.sort((a, b) => b.size - a.size)[0];
  if (!selected || selected.option.value === contextOption.currentValue) return null;
  return { configId: contextOption.id, value: selected.option.value, size: selected.size };
}

export function preferredAllowPermission(options: PermissionOption[]): PermissionOption | null {
  return options.find(option => option.kind === 'allow_always')
    || options.find(option => option.kind === 'allow_once')
    || null;
}

// ========== ACP authentication (#117) ==========
// Agents may reject session/new or session/load with the JSON-RPC `auth_required`
// error (-32000) until the client has called `authenticate` on THIS adapter process.
// The credentials themselves already live on disk (e.g. ~/.codex/auth.json), so the
// call is normally non-interactive — but because Posse never made it, every restart
// spawned a fresh adapter that refused to resume. codex-acp in particular enforces it
// on session/load while letting session/new through, which is why only resume broke.
const ACP_AUTH_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

interface AcpAuthMethod { id: string; name?: string; description?: string }

export function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === -32000) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /authentication required/i.test(message);
}

// Auth methods are tried in the order the agent advertises them in `initialize`.
// That is the agent's own stated preference and needs no guessing on our part: codex-acp
// lists `api-key` before `chat-gpt`, so an API-key setup is honoured first and a
// subscription login is the fallback. Sniffing the environment to reorder was tried and
// rejected — it silently overrode what the user had actually configured. Failed methods
// are cheap (a missing key errors immediately and mutates no state), so walking the whole
// list costs nothing in the common case.
function describeAuthMethod(m: AcpAuthMethod): string {
  return m.name ? `${m.id} (${m.name})` : m.id;
}

// Human-facing recovery hint when every advertised method fails. Credentials live in
// the agent's own CLI, so the fix is always "log in with that CLI, then retry".
function authRecoveryHint(agentLabel: string): string {
  const base = agentLabel.toLowerCase().trim().split(/\s+/)[0];
  const commands: Record<string, string> = {
    codex: 'codex login',
    claude: 'claude login',
    copilot: 'copilot',
    'kiro-cli': 'kiro-cli login',
    opencode: 'opencode auth login',
  };
  const cmd = commands[base];
  return cmd
    ? `Run \`${cmd}\` in a terminal to sign in, then retry this session.`
    : 'Sign in with the agent\'s CLI, then retry this session.';
}

export interface AcpSessionInfo {
  id: string;
  agentLabel: string;
  cwd: string;
  sessionId: string | null;       // ACP session ID from agent
  presetCommand: string;          // canonical ACP preset (for resume + session list)
  configOptions: SessionConfigOption[];
  modes: SessionModeState | null;
  promptCapabilities: PromptCapabilities | null;
  status: 'initializing' | 'ready' | 'prompting' | 'idle' | 'error' | 'closed';
  errorMessage?: string;
  startupPhase?: AcpStartupPhase;
  startupTimingsMs?: Partial<Record<AcpStartupPhase, number>>;
  supportsPromptRollback?: boolean;
  replayUpdates?: SessionUpdate[];
}

export type AcpStartupPhase =
  | 'loading-adapter'
  | 'spawning-adapter'
  | 'connecting'
  | 'initializing-protocol'
  | 'authenticating'
  | 'creating-session'
  | 'loading-session'
  | 'applying-config'
  | 'ready';

type StartupTracker = {
  phase: AcpStartupPhase;
  phaseStartedAt: number;
  timings: Partial<Record<AcpStartupPhase, number>>;
};

type AcpUpdateHandler = (id: string, update: SessionUpdate) => void;
type AcpStatusHandler = (id: string, info: Partial<AcpSessionInfo>) => void;
type AcpPermissionRequestHandler = (
  id: string,
  toolCallId: string,
  toolName: string,
  options: PermissionOption[],
) => void;
// Called when an ACP session closes (process exit, destroy, or destroyAll). Used to
// release the browser ownership lock so another session can take over (#109).
type AcpSessionClosedHandler = (id: string) => void;

type PendingPermission = {
  resolve: (outcome: RequestPermissionOutcome) => void;
  timeout: NodeJS.Timeout;
};

// Listener interface for remote consumers (mobile/headless). These are fan-out
// mirrors of the constructor-bound desktop handlers — see AcpManager.addRemoteListener.
export interface AcpRemoteListener {
  onUpdate: (id: string, update: SessionUpdate) => void;
  onStatus: (id: string, info: Partial<AcpSessionInfo>) => void;
  // Fired when the agent requests a permission decision AND no auto-allow option
  // is available (or auto-allow is disabled for headless). The remote consumer
  // (mobile) renders a prompt and calls resolvePermission() with the outcome.
  onPermissionRequest?: (id: string, toolCallId: string, toolName: string, options: PermissionOption[]) => void;
}

export class AcpReplayBuffer {
  private updates: SessionUpdate[] = [];

  capture(update: SessionUpdate): void {
    this.updates.push(update);
  }

  take(): SessionUpdate[] {
    const updates = this.updates;
    this.updates = [];
    return updates;
  }
}

export class AcpManager {
  private sessions = new Map<string, {
    process: ChildProcess;
    context: ClientContext | null;
    info: AcpSessionInfo;
    replayBuffer: AcpReplayBuffer | null;
    browserInstructionsSent: boolean;
  }>();
  private onUpdate: AcpUpdateHandler;
  private onStatus: AcpStatusHandler;
  private onPermissionRequest: AcpPermissionRequestHandler;
  private readonly onSessionClosed: AcpSessionClosedHandler | undefined;
  private pendingPermissions = new Map<string, PendingPermission>();
  // Remote (mobile/headless) listeners. Each receives the same update/status
  // events as the desktop owner, so a mobile client can render structured
  // ACP sessions while the desktop keeps its IPC path.
  private remoteListeners = new Set<AcpRemoteListener>();
  // When false (headless), preferredAllowPermission auto-allow is suppressed so
  // permission requests surface to mobile via onPermissionRequest fan-out instead
  // of being silently approved. Desktop keeps true to preserve its safe default
  // (bypass-mode presets never reach requestPermission; normal-mode agents get
  // their offered allow_always option auto-selected, matching the desktop renderer
  // which only prompts when no allow option exists).
  private readonly autoAllowPermissions: boolean;

  private handleSessionUpdate(id: string, update: SessionUpdate): void {
    const replayBuffer = this.sessions.get(id)?.replayBuffer;
    if (replayBuffer) {
      replayBuffer.capture(update);
      return;
    }
    this.onUpdate(id, update);
    for (const listener of this.remoteListeners) {
      try { listener.onUpdate(id, update); } catch { /* listener must not throw the agent loop */ }
    }
  }

  private fanoutStatus(id: string, info: Partial<AcpSessionInfo>): void {
    this.onStatus(id, info);
    for (const listener of this.remoteListeners) {
      try { listener.onStatus(id, info); } catch { /* listener must not throw the agent loop */ }
    }
  }

  /** Register a remote listener that receives every ACP update/status event. */
  addRemoteListener(listener: AcpRemoteListener): AcpRemoteListener {
    this.remoteListeners.add(listener);
    return listener;
  }

  /** Unregister a previously-added remote listener. */
  removeRemoteListener(listener: AcpRemoteListener): void {
    this.remoteListeners.delete(listener);
  }

  constructor(
    onUpdate: AcpUpdateHandler,
    onStatus: AcpStatusHandler,
    onPermissionRequest: AcpPermissionRequestHandler,
    autoAllowPermissions = true,
    onSessionClosed?: (id: string) => void,
  ) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.onPermissionRequest = onPermissionRequest;
    this.autoAllowPermissions = autoAllowPermissions;
    this.onSessionClosed = onSessionClosed;
  }

  private startStartup(id: string): StartupTracker {
    const now = performance.now();
    const tracker: StartupTracker = { phase: 'loading-adapter', phaseStartedAt: now, timings: {} };
    this.fanoutStatus(id, { status: 'initializing', startupPhase: tracker.phase, startupTimingsMs: {} });
    return tracker;
  }

  private advanceStartup(
    id: string,
    tracker: StartupTracker,
    phase: AcpStartupPhase,
    info?: AcpSessionInfo,
  ): void {
    const now = performance.now();
    tracker.timings[tracker.phase] = Math.round(now - tracker.phaseStartedAt);
    tracker.phase = phase;
    tracker.phaseStartedAt = now;
    if (info) {
      info.startupPhase = phase;
      info.startupTimingsMs = { ...tracker.timings };
    }
    this.fanoutStatus(id, {
      status: phase === 'ready' ? 'idle' : 'initializing',
      startupPhase: phase,
      startupTimingsMs: { ...tracker.timings },
    });
  }

  private requestPermission(
    id: string,
    toolCallId: string,
    toolName: string,
    options: PermissionOption[],
  ): Promise<RequestPermissionOutcome> {
    // Desktop preserves its safe default: auto-select an offered allow_always/allow_once
    // option so the renderer only prompts when no allow choice exists. Headless
    // (autoAllowPermissions=false) must NOT auto-allow — surface to mobile instead.
    if (this.autoAllowPermissions) {
      const defaultAllow = preferredAllowPermission(options);
      if (defaultAllow) {
        return Promise.resolve({ outcome: 'selected', optionId: defaultAllow.optionId });
      }
    }

    const key = `${id}:${toolCallId}`;
    const previous = this.pendingPermissions.get(key);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.resolve({ outcome: 'cancelled' });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingPermissions.get(key)?.resolve !== resolve) return;
        this.pendingPermissions.delete(key);
        resolve({ outcome: 'cancelled' });
      }, 300000);
      this.pendingPermissions.set(key, { resolve, timeout });
      // Fan out to the desktop renderer (no-op in headless) AND to remote/mobile
      // listeners so a mobile client can render a permission prompt.
      this.onPermissionRequest(id, toolCallId, toolName, options);
      for (const listener of this.remoteListeners) {
        try { listener.onPermissionRequest?.(id, toolCallId, toolName, options); }
        catch { /* listener must not throw the agent loop */ }
      }
    });
  }

  /** Resolve a pending permission request from the renderer. */
  resolvePermission(id: string, toolCallId: string, outcome: string, optionId?: string): boolean {
    const key = `${id}:${toolCallId}`;
    const pending = this.pendingPermissions.get(key);
    if (!pending) return false;

    const result: RequestPermissionOutcome = outcome === 'selected' && optionId
      ? { outcome: 'selected', optionId }
      : { outcome: 'cancelled' };
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(key);
    pending.resolve(result);
    return true;
  }

  private cancelPendingPermissions(id: string): void {
    const prefix = `${id}:`;
    for (const [key, pending] of this.pendingPermissions) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(pending.timeout);
      this.pendingPermissions.delete(key);
      pending.resolve({ outcome: 'cancelled' });
    }
  }

  private async applyDefaultFullAccess(id: string, info: AcpSessionInfo): Promise<void> {
    const preferred = preferredFullAccessConfig(info.configOptions);
    if (!preferred) return;
    try {
      await this.setConfigOption(id, preferred.configId, preferred.value);
    } catch (error) {
      console.warn(`[ACP ${id}] Unable to apply default full-access mode:`, error);
    }
  }

  private async applyDefaultContextWindow(id: string, info: AcpSessionInfo): Promise<void> {
    const preferred = preferredContextWindowConfig(info.configOptions);
    if (!preferred) return;
    try {
      await this.setConfigOption(id, preferred.configId, preferred.value);
      console.info(`[ACP ${id}] selected context window ${preferred.size} tokens`);
    } catch (error) {
      console.warn(`[ACP ${id}] Unable to apply default 1M context window:`, error);
    }
  }

  // #117: run `request`, and if the agent answers auth_required, authenticate with the
  // methods it advertised at initialize and run it once more. The credentials are already
  // on disk, so this is normally a silent round trip; it only becomes visible if every
  // method fails, in which case the error names the CLI command that fixes it.
  private async withAcpAuth<T>(
    id: string,
    agentLabel: string,
    acp: AcpSdk,
    ctx: ClientContext,
    authMethods: AcpAuthMethod[],
    startup: StartupTracker,
    info: AcpSessionInfo,
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;

      const candidates = authMethods;
      if (candidates.length === 0) {
        throw new Error(`Authentication required. ${authRecoveryHint(agentLabel)}`);
      }

      this.advanceStartup(id, startup, 'authenticating', info);
      const failures: string[] = [];
      for (const method of candidates) {
        try {
          await withTimeout(
            ctx.request(acp.methods.agent.authenticate, { methodId: method.id }),
            ACP_AUTH_TIMEOUT_MS,
            `authenticate(${method.id}) timed out`,
          );
          console.info(`[ACP ${id}] authenticated via ${describeAuthMethod(method)}`);
        } catch (authErr) {
          const message = authErr instanceof Error ? authErr.message : String(authErr);
          failures.push(`${method.id}: ${message}`);
          console.warn(`[ACP ${id}] auth method "${method.id}" failed:`, message);
          continue;
        }
        try {
          return await request();
        } catch (retryErr) {
          // Auth went through but the agent still refuses — try the next method.
          // Anything else is a genuine failure and must not be masked as an auth problem.
          if (!isAuthRequiredError(retryErr)) throw retryErr;
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          failures.push(`${method.id}: still rejected after authenticate (${message})`);
        }
      }
      console.error(`[ACP ${id}] all auth methods failed:`, failures);
      throw new Error(`Authentication required. ${authRecoveryHint(agentLabel)}`);
    }
  }

  async create(id: string, agentLabel: string, cwd: string, providerEnv?: Record<string, string>): Promise<AcpSessionInfo> {
    const startup = this.startStartup(id);
    const acp = await loadAcpSdk();
    this.advanceStartup(id, startup, 'spawning-adapter');
    const acpCmd = getAcpCommand(agentLabel);
    if (!acpCmd) {
      throw new Error(`No ACP command for agent: ${agentLabel}`);
    }

    const env = {
      ...process.env,
      ...providerEnv,
      PATH: augmentedPath(process.env.PATH),
      // npx-backed adapters should use an already-populated npm cache immediately and
      // only contact the registry when the package is absent.
      NPM_CONFIG_PREFER_OFFLINE: 'true',
    };
    const childProcess = spawnAcpAdapter(acpCmd, cwd, env);
    // Surface adapter stderr in the app log for diagnostics (was 'inherit' — invisible)
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[ACP ${id}] stderr:`, chunk.toString().trim());
    });

    const info: AcpSessionInfo = {
      id,
      agentLabel,
      cwd,
      sessionId: null,
      presetCommand: canonicalAcpPresetCommand(agentLabel) || agentLabel,
      configOptions: [],
      modes: null,
      promptCapabilities: null,
      status: 'initializing',
      startupPhase: 'spawning-adapter',
      startupTimingsMs: { ...startup.timings },
      supportsPromptRollback: false,
    };

    this.sessions.set(id, {
      process: childProcess,
      context: null,
      info,
      replayBuffer: null,
      browserInstructionsSent: false,
    });
    this.advanceStartup(id, startup, 'connecting', info);

    // Set up the ACP client and connect
    const input = Writable.toWeb(childProcess.stdin!);
    const output = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    // Build the client with handlers
    const client = acp.client({ name: 'posse' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const options = ctx.params.options || [];
        const toolCall = ctx.params.toolCall;
        const toolCallId = toolCall?.toolCallId || '';
        const toolName = toolCall?.title || toolCall?.kind || 'tool';

        const outcome = await this.requestPermission(id, toolCallId, toolName, options);
        return { outcome };
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.handleSessionUpdate(id, ctx.params.update);
      });

    // Start the connection in the background — connectWith's callback runs
    // for the lifetime of the child process. We resolve create() as soon as
    // session/new succeeds, NOT when connectWith resolves.
    const sessionReady = new Promise<AcpSessionInfo>((resolve, reject) => {
      // Timeout: if the agent doesn't initialize within 30s, fail
      const timeout = setTimeout(() => {
        const error = new Error('ACP agent initialization timed out (30s)');
        info.status = 'error';
        info.errorMessage = error.message;
        this.sessions.delete(id);
        try { childProcess.kill(); } catch { /* process may already be dead */ }
        this.fanoutStatus(id, { status: 'error', errorMessage: error.message });
        reject(error);
      }, ACP_CREATE_TIMEOUT_MS);

      client.connectWith(stream, async (ctx) => {
        try {
          // Initialize
          this.advanceStartup(id, startup, 'initializing-protocol', info);
          const initialized = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          });
          info.promptCapabilities = initialized.agentCapabilities?.promptCapabilities || null;
          const authMethods = (initialized.authMethods || []) as AcpAuthMethod[];

          // Create a new session
          this.advanceStartup(id, startup, 'creating-session', info);
          const browserServer = buildBrowserMcpServer(id);
          const session = await this.withAcpAuth(
            id, agentLabel, acp, ctx, authMethods, startup, info,
            () => ctx.request(acp.methods.agent.session.new, {
              cwd,
              mcpServers: browserServer ? [browserServer] : [],
            }),
          );
          const entry = this.sessions.get(id);
          if (!entry) {
            return;
          }
          entry.context = ctx;

          info.sessionId = session.sessionId;
          info.configOptions = session.configOptions || [];
          info.modes = session.modes || null;
          info.status = 'idle';

          this.advanceStartup(id, startup, 'applying-config', info);
          await this.applyDefaultFullAccess(id, info);
          await this.applyDefaultContextWindow(id, info);
          this.advanceStartup(id, startup, 'ready', info);
          clearTimeout(timeout);
          console.info(`[ACP ${id}] startup timings`, info.startupTimingsMs);

          this.persistSession(info);
          this.fanoutStatus(id, {
            sessionId: session.sessionId,
            configOptions: info.configOptions,
            modes: info.modes,
            promptCapabilities: info.promptCapabilities,
            supportsPromptRollback: false,
            startupPhase: info.startupPhase,
            startupTimingsMs: info.startupTimingsMs,
            status: 'idle',
          });

          resolve(info);

          // Keep the connection alive — wait for process exit.
          // This promise resolves when the child process exits, which
          // lets connectWith complete its cleanup.
          return new Promise<void>((resolveExit) => {
            childProcess.on('exit', () => {
              if (this.sessions.get(id)?.process !== childProcess) {
                resolveExit();
                return;
              }
              this.cancelPendingPermissions(id);
              this.sessions.delete(id);
              info.status = 'closed';
              closeAcpSession(id);
              this.releaseSessionResources(id);
              this.fanoutStatus(id, { status: 'closed' });
              resolveExit();
            });
          });
        } catch (err) {
          clearTimeout(timeout);
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.sessions.delete(id);
          try { childProcess.kill(); } catch { /* process may already be dead */ }
          this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
          reject(err);
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (info.status !== 'closed' && info.status !== 'error') {
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
        }
        reject(err);
      });
    });

    // Handle child process errors (e.g. npx not found)
    childProcess.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = `Failed to spawn ACP agent: ${err.message}`;
      this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
    });

    return sessionReady;
  }

  async prompt(id: string, content: string | ContentBlock[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.context || !session.info.sessionId) {
      throw new Error(`ACP session ${id} not ready`);
    }

    session.info.status = 'prompting';
    this.fanoutStatus(id, { status: 'prompting' });

    try {
      const acp = await loadAcpSdk();
      // Issue #109: once per session, prepend a short system instruction telling the
      // agent that a Posse built-in browser is available (when the bridge is enabled),
      // so it prefers that for web testing instead of launching an external browser.
      // ACP has no dedicated instructions field, so it is prepended to the first user
      // prompt as a leading text block. This only GUIDES the agent — availability is
      // determined by whether the browser MCP tool is actually registered.
      const blocks = typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : content;
      const promptBlocks = session.browserInstructionsSent ? blocks
        : [...buildBrowserInstructionBlocks(), ...blocks];
      session.browserInstructionsSent = true;
      await session.context.request(acp.methods.agent.session.prompt, {
        sessionId: session.info.sessionId,
        prompt: promptBlocks,
      });
      session.info.status = 'idle';
      this.fanoutStatus(id, { status: 'idle' });
    } catch (err) {
      session.info.status = 'error';
      session.info.errorMessage = err instanceof Error ? err.message : String(err);
      this.fanoutStatus(id, { status: 'error', errorMessage: session.info.errorMessage });
      throw err;
    }
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.context || !session.info.sessionId) return;

    const acp = await loadAcpSdk();
    await session.context.notify(acp.methods.agent.session.cancel, {
      sessionId: session.info.sessionId,
    });
  }

  async setConfigOption(id: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const session = this.sessions.get(id);
    if (!session?.context || !session.info.sessionId) {
      throw new Error(`ACP session ${id} not ready`);
    }

    const acp = await loadAcpSdk();
    const result: SetSessionConfigOptionResponse = await session.context.request(
      acp.methods.agent.session.setConfigOption,
      {
      sessionId: session.info.sessionId,
      configId,
      value,
      },
    );

    session.info.configOptions = result?.configOptions || [];
    this.fanoutStatus(id, { configOptions: session.info.configOptions });
    return session.info.configOptions;
  }

  getSession(id: string): AcpSessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  drainReplay(id: string): SessionUpdate[] {
    const entry = this.sessions.get(id);
    if (!entry?.replayBuffer) return [];
    const updates = entry.replayBuffer.take();
    if (updates.length === 0) entry.replayBuffer = null;
    return updates;
  }

  /** List ACP sessions persisted to disk (for the mobile recent list + resume). */
  listStoredSessions(): AcpStoredSession[] {
    return listAcpSessions();
  }

  /** Remove a stored ACP session record (used when the user deletes a session). */
  removeStoredSession(id: string): void {
    removeAcpSession(id);
  }

  private persistSession(info: AcpSessionInfo): void {
    if (!info.sessionId) return;
    upsertAcpSession({
      id: info.id,
      acpSessionId: info.sessionId,
      agentLabel: info.agentLabel,
      cwd: info.cwd,
      presetCommand: info.presetCommand,
      title: info.agentLabel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** Load an existing ACP session by sessionId (for resume). */
  async load(id: string, agentLabel: string, cwd: string, acpSessionId: string, providerEnv?: Record<string, string>): Promise<AcpSessionInfo> {
    const releaseLoadSlot = await acquireLoadSlot();
    try {
      return await this.loadInternal(id, agentLabel, cwd, acpSessionId, providerEnv);
    } finally {
      releaseLoadSlot();
    }
  }

  private async loadInternal(id: string, agentLabel: string, cwd: string, acpSessionId: string, providerEnv?: Record<string, string>): Promise<AcpSessionInfo> {
    // A retry reuses the renderer session id. Silently retire any previous adapter attempt so
    // its exit/status callbacks cannot replace the retry's state.
    this.destroy(id, false);
    const startup = this.startStartup(id);
    const acp = await loadAcpSdk();
    this.advanceStartup(id, startup, 'spawning-adapter');
    const acpCmd = getAcpCommand(agentLabel);
    if (!acpCmd) {
      throw new Error(`No ACP command for agent: ${agentLabel}`);
    }

    const env = {
      ...process.env,
      ...providerEnv,
      PATH: augmentedPath(process.env.PATH),
      NPM_CONFIG_PREFER_OFFLINE: 'true',
    };
    const childProcess = spawnAcpAdapter(acpCmd, cwd, env);
    // Surface adapter stderr in the app log for diagnostics (was 'inherit' — invisible)
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[ACP ${id}] stderr:`, chunk.toString().trim());
    });

    const info: AcpSessionInfo = {
      id,
      agentLabel,
      cwd,
      sessionId: null,
      presetCommand: canonicalAcpPresetCommand(agentLabel) || agentLabel,
      configOptions: [],
      modes: null,
      promptCapabilities: null,
      status: 'initializing',
      startupPhase: 'spawning-adapter',
      startupTimingsMs: { ...startup.timings },
      supportsPromptRollback: false,
    };

    const replayBuffer = new AcpReplayBuffer();
    this.sessions.set(id, {
      process: childProcess,
      context: null,
      info,
      replayBuffer,
      browserInstructionsSent: false,
    });
    this.advanceStartup(id, startup, 'connecting', info);

    const input = Writable.toWeb(childProcess.stdin!);
    const output = Readable.toWeb(childProcess.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client = acp.client({ name: 'posse' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const options = ctx.params.options || [];
        const toolCallId = ctx.params.toolCall?.toolCallId || '';
        const toolName = ctx.params.toolCall?.title || ctx.params.toolCall?.kind || 'tool';
        const outcome = await this.requestPermission(id, toolCallId, toolName, options);
        return { outcome };
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        this.handleSessionUpdate(id, ctx.params.update);
      });

    const sessionReady = new Promise<AcpSessionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Loading this session timed out after 90 seconds. Retry to start a clean load attempt.');
        info.status = 'error';
        info.errorMessage = error.message;
        if (this.sessions.get(id)?.process === childProcess) this.sessions.delete(id);
        try { childProcess.kill(); } catch { /* process may already be dead */ }
        this.fanoutStatus(id, {
          status: 'error',
          errorMessage: error.message,
          startupPhase: info.startupPhase,
          startupTimingsMs: info.startupTimingsMs,
        });
        reject(error);
      }, ACP_LOAD_TIMEOUT_MS);

      client.connectWith(stream, async (ctx) => {
        try {
          this.advanceStartup(id, startup, 'initializing-protocol', info);
          const initialized = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });
          info.promptCapabilities = initialized.agentCapabilities?.promptCapabilities || null;
          const authMethods = (initialized.authMethods || []) as AcpAuthMethod[];

          // Load the existing session. #117: codex-acp enforces authentication here even
          // though session/new passes, so this MUST go through the auth-retry wrapper —
          // otherwise every app restart spawns a fresh adapter that refuses to resume.
          this.advanceStartup(id, startup, 'loading-session', info);
          const loadBrowserServer = buildBrowserMcpServer(id);
          const loadResp = await this.withAcpAuth(
            id, agentLabel, acp, ctx, authMethods, startup, info,
            () => ctx.request(acp.methods.agent.session.load, {
              sessionId: acpSessionId,
              mcpServers: loadBrowserServer ? [loadBrowserServer] : [],
              cwd,
            }),
          );

          const entry = this.sessions.get(id);
          if (!entry) return;
          entry.context = ctx;

          info.sessionId = acpSessionId;
          info.configOptions = loadResp.configOptions || [];
          info.modes = loadResp.modes || null;
          info.status = 'idle';

          this.advanceStartup(id, startup, 'applying-config', info);
          await this.applyDefaultFullAccess(id, info);
          await this.applyDefaultContextWindow(id, info);
          this.advanceStartup(id, startup, 'ready', info);
          clearTimeout(timeout);
          console.info(`[ACP ${id}] load timings`, info.startupTimingsMs);

          this.persistSession(info);
          resolve({ ...info, replayUpdates: replayBuffer.take() });

          return new Promise<void>((resolveExit) => {
            childProcess.on('exit', () => {
              if (this.sessions.get(id)?.process !== childProcess) {
                resolveExit();
                return;
              }
              this.cancelPendingPermissions(id);
              this.sessions.delete(id);
              info.status = 'closed';
              closeAcpSession(id);
              this.releaseSessionResources(id);
              this.fanoutStatus(id, { status: 'closed' });
              resolveExit();
            });
          });
        } catch (err) {
          clearTimeout(timeout);
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          if (this.sessions.get(id)?.process === childProcess) this.sessions.delete(id);
          try { childProcess.kill(); } catch { /* process may already be dead */ }
          this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
          reject(err);
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (info.status !== 'closed' && info.status !== 'error') {
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
        }
        reject(err);
      });
    });

    childProcess.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = `Failed to spawn ACP agent: ${err.message}`;
      this.fanoutStatus(id, { status: 'error', errorMessage: info.errorMessage });
    });

    return sessionReady;
  }

  destroy(id: string, notify = true): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.cancelPendingPermissions(id);
    this.sessions.delete(id);
    try { session.process.kill(); } catch { /* already exited */ }
    session.info.status = 'closed';
    closeAcpSession(id);
    this.releaseSessionResources(id);
    if (notify) {
      this.onStatus(id, { status: 'closed' });
      for (const listener of this.remoteListeners) {
        try { listener.onStatus(id, { status: 'closed' }); } catch { /* listener must not throw */ }
      }
    }
  }

  // Central hook for resources bound to a session by id — currently the browser
  // ownership lock (#109). Safe to call multiple times; a session can only own the
  // browser once, so releaseOwner is a no-op when this session wasn't the owner.
  private releaseSessionResources(id: string): void {
    try { this.onSessionClosed?.(id); } catch { /* handler must not throw the close path */ }
  }

  destroyAll(notify = true): void {
    for (const id of this.sessions.keys()) {
      this.destroy(id, notify);
    }
  }
}
