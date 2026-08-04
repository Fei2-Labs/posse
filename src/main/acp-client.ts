import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Writable, Readable } from 'node:stream';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'node:perf_hooks';
import type {
  ClientContext,
  ContentBlock,
  PermissionOption,
  PromptCapabilities,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';

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

type AcpSdk = typeof import('@agentclientprotocol/sdk');

// TypeScript rewrites import() to require() when emitting CommonJS. Constructing
// the importer at runtime preserves native ESM loading for the ESM-only ACP SDK.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<AcpSdk>;
let acpSdkPromise: Promise<AcpSdk> | null = null;

const ACP_CREATE_TIMEOUT_MS = 30_000;
const ACP_LOAD_TIMEOUT_MS = 90_000;

function loadAcpSdk(): Promise<AcpSdk> {
  if (!acpSdkPromise) {
    acpSdkPromise = importEsm('@agentclientprotocol/sdk');
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

export function preferredAllowPermission(options: PermissionOption[]): PermissionOption | null {
  return options.find(option => option.kind === 'allow_always')
    || options.find(option => option.kind === 'allow_once')
    || null;
}

export interface AcpSessionInfo {
  id: string;
  agentLabel: string;
  cwd: string;
  sessionId: string | null;       // ACP session ID from agent
  configOptions: SessionConfigOption[];
  modes: SessionModeState | null;
  promptCapabilities: PromptCapabilities | null;
  status: 'initializing' | 'ready' | 'prompting' | 'idle' | 'error' | 'closed';
  errorMessage?: string;
  startupPhase?: AcpStartupPhase;
  startupTimingsMs?: Partial<Record<AcpStartupPhase, number>>;
  supportsPromptRollback?: boolean;
}

export type AcpStartupPhase =
  | 'loading-adapter'
  | 'spawning-adapter'
  | 'connecting'
  | 'initializing-protocol'
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

type PendingPermission = {
  resolve: (outcome: RequestPermissionOutcome) => void;
  timeout: NodeJS.Timeout;
};

export class AcpManager {
  private sessions = new Map<string, {
    process: ChildProcess;
    context: ClientContext | null;
    info: AcpSessionInfo;
  }>();
  private onUpdate: AcpUpdateHandler;
  private onStatus: AcpStatusHandler;
  private onPermissionRequest: AcpPermissionRequestHandler;
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    onUpdate: AcpUpdateHandler,
    onStatus: AcpStatusHandler,
    onPermissionRequest: AcpPermissionRequestHandler,
  ) {
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.onPermissionRequest = onPermissionRequest;
  }

  private startStartup(id: string): StartupTracker {
    const now = performance.now();
    const tracker: StartupTracker = { phase: 'loading-adapter', phaseStartedAt: now, timings: {} };
    this.onStatus(id, { status: 'initializing', startupPhase: tracker.phase, startupTimingsMs: {} });
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
    this.onStatus(id, {
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
    const defaultAllow = preferredAllowPermission(options);
    if (defaultAllow) {
      return Promise.resolve({ outcome: 'selected', optionId: defaultAllow.optionId });
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
      this.onPermissionRequest(id, toolCallId, toolName, options);
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
    // npx is a shell script, not a binary — needs shell:true to resolve on macOS.
    // System-installed agents (copilot, kiro-cli, opencode) are real binaries but
    // shell:true is harmless for them too and ensures PATH resolution.
    const childProcess = spawn(acpCmd.cmd, acpCmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      shell: acpCmd.cmd === 'npx',
    });
    // Surface adapter stderr in the app log for diagnostics (was 'inherit' — invisible)
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[ACP ${id}] stderr:`, chunk.toString().trim());
    });

    const info: AcpSessionInfo = {
      id,
      agentLabel,
      cwd,
      sessionId: null,
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
        this.onUpdate(id, ctx.params.update);
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
        this.onStatus(id, { status: 'error', errorMessage: error.message });
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

          // Create a new session
          this.advanceStartup(id, startup, 'creating-session', info);
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
          });
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
          this.advanceStartup(id, startup, 'ready', info);
          clearTimeout(timeout);
          console.info(`[ACP ${id}] startup timings`, info.startupTimingsMs);

          this.onStatus(id, {
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
              this.onStatus(id, { status: 'closed' });
              resolveExit();
            });
          });
        } catch (err) {
          clearTimeout(timeout);
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.sessions.delete(id);
          try { childProcess.kill(); } catch { /* process may already be dead */ }
          this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
          reject(err);
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (info.status !== 'closed' && info.status !== 'error') {
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
        }
        reject(err);
      });
    });

    // Handle child process errors (e.g. npx not found)
    childProcess.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = `Failed to spawn ACP agent: ${err.message}`;
      this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
    });

    return sessionReady;
  }

  async prompt(id: string, content: string | ContentBlock[]): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.context || !session.info.sessionId) {
      throw new Error(`ACP session ${id} not ready`);
    }

    session.info.status = 'prompting';
    this.onStatus(id, { status: 'prompting' });

    try {
      const acp = await loadAcpSdk();
      await session.context.request(acp.methods.agent.session.prompt, {
        sessionId: session.info.sessionId,
        prompt: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      });
      session.info.status = 'idle';
      this.onStatus(id, { status: 'idle' });
    } catch (err) {
      session.info.status = 'error';
      session.info.errorMessage = err instanceof Error ? err.message : String(err);
      this.onStatus(id, { status: 'error', errorMessage: session.info.errorMessage });
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
    this.onStatus(id, { configOptions: session.info.configOptions });
    return session.info.configOptions;
  }

  getSession(id: string): AcpSessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** Load an existing ACP session by sessionId (for resume). */
  async load(id: string, agentLabel: string, cwd: string, acpSessionId: string, providerEnv?: Record<string, string>): Promise<AcpSessionInfo> {
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
    // npx is a shell script, not a binary — needs shell:true to resolve on macOS.
    // System-installed agents (copilot, kiro-cli, opencode) are real binaries but
    // shell:true is harmless for them too and ensures PATH resolution.
    const childProcess = spawn(acpCmd.cmd, acpCmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      shell: acpCmd.cmd === 'npx',
    });
    // Surface adapter stderr in the app log for diagnostics (was 'inherit' — invisible)
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[ACP ${id}] stderr:`, chunk.toString().trim());
    });

    const info: AcpSessionInfo = {
      id,
      agentLabel,
      cwd,
      sessionId: null,
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
        this.onUpdate(id, ctx.params.update);
      });

    const sessionReady = new Promise<AcpSessionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Loading this session timed out after 90 seconds. Retry to start a clean load attempt.');
        info.status = 'error';
        info.errorMessage = error.message;
        if (this.sessions.get(id)?.process === childProcess) this.sessions.delete(id);
        try { childProcess.kill(); } catch { /* process may already be dead */ }
        this.onStatus(id, {
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

          // Load the existing session
          this.advanceStartup(id, startup, 'loading-session', info);
          const loadResp = await ctx.request(acp.methods.agent.session.load, {
            sessionId: acpSessionId,
            mcpServers: [],
            cwd,
          });

          const entry = this.sessions.get(id);
          if (!entry) return;
          entry.context = ctx;

          info.sessionId = acpSessionId;
          info.configOptions = loadResp.configOptions || [];
          info.modes = loadResp.modes || null;
          info.status = 'idle';

          this.advanceStartup(id, startup, 'applying-config', info);
          await this.applyDefaultFullAccess(id, info);
          this.advanceStartup(id, startup, 'ready', info);
          clearTimeout(timeout);
          console.info(`[ACP ${id}] load timings`, info.startupTimingsMs);

          this.onStatus(id, {
            sessionId: info.sessionId,
            configOptions: info.configOptions,
            modes: info.modes,
            promptCapabilities: info.promptCapabilities,
            supportsPromptRollback: false,
            startupPhase: info.startupPhase,
            startupTimingsMs: info.startupTimingsMs,
            status: 'idle',
          });

          resolve(info);

          return new Promise<void>((resolveExit) => {
            childProcess.on('exit', () => {
              if (this.sessions.get(id)?.process !== childProcess) {
                resolveExit();
                return;
              }
              this.cancelPendingPermissions(id);
              this.sessions.delete(id);
              info.status = 'closed';
              this.onStatus(id, { status: 'closed' });
              resolveExit();
            });
          });
        } catch (err) {
          clearTimeout(timeout);
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          if (this.sessions.get(id)?.process === childProcess) this.sessions.delete(id);
          try { childProcess.kill(); } catch { /* process may already be dead */ }
          this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
          reject(err);
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (info.status !== 'closed' && info.status !== 'error') {
          info.status = 'error';
          info.errorMessage = err instanceof Error ? err.message : String(err);
          this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
        }
        reject(err);
      });
    });

    childProcess.on('error', (err) => {
      info.status = 'error';
      info.errorMessage = `Failed to spawn ACP agent: ${err.message}`;
      this.onStatus(id, { status: 'error', errorMessage: info.errorMessage });
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
    if (notify) this.onStatus(id, { status: 'closed' });
  }

  destroyAll(notify = true): void {
    for (const id of this.sessions.keys()) {
      this.destroy(id, notify);
    }
  }
}
