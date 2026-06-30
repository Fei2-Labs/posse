import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { requestTitleFromConfiguredAI, TitleAIConfig } from './title-ai';

// Max bytes of ANSI output the daemon retains per session for terminal replay.
// Tradeoff: larger = more desktop scrollback survives an app restart (the daemon outlives the app and
// the renderer replays the whole buffer on reconnect); the cost is ~this many bytes of RAM per live session.
// Mobile/remote first-paint does NOT use this size directly — remote-server slices a small tail (see
// MOBILE_REPLAY_TAIL_BYTES) so weak-network first-paint stays fast regardless of this cap.
export const RAW_BUFFER_MAX_BYTES = 1024 * 1024; // 1MB

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  buffer: string;
  rawBuffer: string;          // Full ANSI output, used for remote terminal replay
  userInputs: string[];
  commandCount: number;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  summarizeScheduled: boolean;
  summarizeTimer: NodeJS.Timeout | null;
  cwd: string;
  presetCommand: string;
  themeId: string;
  provider: string | null;    // Model provider actually used (e.g. MiniMax, GLM)
  createdAt: number;          // Creation timestamp
  lastActivityMs: number;     // Timestamp of the last PTY output chunk (real last-activity). Survives app
                              // restart because the daemon outlives the app and holds this in memory; used so
                              // restored sessions keep their real sort time instead of all showing "now".
  resumeId: string | null;    // Captured resume session ID (UUID)
  resumeCommand: string | null; // Full resume command (e.g. "claude --resume xxx")
  agentSessionId: string | null; // On-disk agent session id (uuid) this live PTY corresponds to (for dedup vs history)
  autoRetryCooldown: number;    // Auto-retry cooldown deadline timestamp
  prevData: string;              // Previous PTY chunk, merged with the current chunk for rate-limit detection
  retryTimer: NodeJS.Timeout | null;  // Auto-retry / account-switch delay timer
  disposables: pty.IDisposable[];
  switchAttempts: number;        // Number of auto account-switch attempts this round
  lastAutoSwitchAt: number;      // Timestamp of the last auto account-switch
  rateLimitRetryCount: number;   // Count of consecutive rate-limit "continue" retries (reset on success)
  lastRateLimitAt: number;       // Timestamp of the last detected rate limit (used to judge continuity)
}

interface PtyManagerEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string) => void;
  onPasteInput?: (id: string, cwd: string) => void;
  onRawData?: (id: string, data: string) => void;
  onAutoSwitchStatus?: (id: string, status: string, detail?: string) => void;
}

export type TitleAIConfigProvider = () => TitleAIConfig | null;

// Command -> friendly display name mapping
const PRESET_DISPLAY_NAMES: Record<string, string> = {
  'claude --dangerously-skip-permissions': 'Claude (auto)',
  'codex --full-auto': 'Codex (auto)',
  'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"': 'Codex (auto)',
  'copilot --allow-all --autopilot': 'Copilot (auto)',
  'devin --permission-mode bypass': 'Devin (auto)',
  'opencode': 'OpenCode',
  'kiro-cli chat --trust-all-tools': 'Kiro (auto)',
};

function stripTerminalControlSequences(text: string): string {
  return text
    // OSC: ESC ] ... BEL / ESC \
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... final-byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // DCS/PM/APC/SOS: ESC P/^/_/X ... ESC \
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Single-character ESC sequences.
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Each CLI has a different resume command format; match them one by one.
// Returns the full resume command and session ID, or null if none match.
function parseResumeCommand(text: string): { command: string; sessionId: string } | null {
  const patterns: Array<{ re: RegExp; build: (m: RegExpMatchArray) => string }> = [
    // Cursor Agent: "agent --resume=<uuid>"
    { re: /\b(agent)\s+--resume=([\w-]+)/i, build: m => `${m[1]} --resume=${m[2]}` },
    // Claude Code: "claude --resume <uuid>"
    { re: /\b(claude)\s+--resume\s+([\w-]+)/i, build: m => `${m[1]} --dangerously-skip-permissions --resume ${m[2]}` },
    // Kiro: "kiro-cli --resume-id <uuid>"
    { re: /\b(kiro[\w-]*)\s+--resume-id\s+([\w-]+)/i, build: m => `${m[1]} chat --trust-all-tools --resume-id ${m[2]}` },
    // Codex: "codex resume <id>"
    { re: /\b(codex)\s+resume\s+([\w-]+)/i, build: m => `${m[1]} resume ${m[2]}` },
    // GitHub Copilot CLI: "copilot --resume <id>"
    { re: /\b(copilot)\s+--resume(?:=|\s+)([\w-]+)/i, build: m => `${m[1]} --resume ${m[2]}` },
    // OpenCode: "opencode -s <ses_id>"
    { re: /\b(opencode)\s+-s\s+(\w+)/i, build: m => `${m[1]} -s ${m[2]}` },
    // Devin: "devin -r <session_name>"
    { re: /\b(devin)\s+-r\s+([\w-]+)/i, build: m => `${m[1]} -r ${m[2]}` },
  ];

  for (const { re, build } of patterns) {
    const match = text.match(re);
    if (match) {
      return { command: build(match), sessionId: match[2] };
    }
  }
  return null;
}

// Determine which agent family a launch command belongs to (for on-disk session correlation)
function agentKindFromCommand(command: string): 'claude' | 'codex' | 'kiro' | 'copilot' | null {
  const c = (command || '').trim().toLowerCase();
  if (/^claude\b/.test(c)) return 'claude';
  if (/^codex\b/.test(c)) return 'codex';
  if (/^kiro/.test(c)) return 'kiro';
  if (/^copilot\b/.test(c)) return 'copilot';
  return null;
}

// If the launch command is itself a resume command, extract the uuid directly (most reliable path).
function extractSessionIdFromLaunch(command: string): string | null {
  const c = (command || '').trim();
  let m: RegExpMatchArray | null;
  if ((m = c.match(/\bclaude\b[\s\S]*?--resume\s+([\w-]+)/i))) return m[1];
  if ((m = c.match(/\bcodex\b\s+resume\s+([\w-]+)/i))) return m[1];
  if ((m = c.match(/\bkiro[\w-]*\b[\s\S]*?--resume-id\s+([\w-]+)/i))) return m[1];
  if ((m = c.match(/\bcopilot\b[\s\S]*?--resume(?:=|\s+)([\w-]+)/i))) return m[1];
  return null;
}

// Encode an absolute cwd into Claude's project-dir name (every non-alphanumeric char -> '-').
function encodeClaudeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// Snapshot every claude session uuid that ALREADY exists on disk for this cwd. Called
// synchronously at spawn time for fresh runs; the deferred rescan then skips these so a
// fresh `claude` can only ever bind to a file it created itself. Best-effort, never throws.
function snapshotExistingClaudeSessionUuids(cwd: string): Set<string> {
  const set = new Set<string>();
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd));
    if (!fs.existsSync(dir)) return set;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) set.add(name.replace(/\.jsonl$/, ''));
    }
  } catch { /* best-effort */ }
  return set;
}

// Best-effort: propagate a user rename into Claude's own session file so Claude's
// session list/resume shows the same title. Claude stores a rename as two appended
// JSONL lines: a `custom-title` line and an `agent-name` line.
export function writeClaudeSessionTitle(uuid: string, title: string): void {
  const trimmed = (title || '').trim();
  if (!trimmed || !uuid) return;
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;
    const fileName = `${uuid}.jsonl`;
    let target: string | null = null;
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, fileName);
      if (fs.existsSync(candidate)) {
        target = candidate;
        break;
      }
    }
    // Closed records may store the short 8-hex prefix Claude prints in its resume hint, not the
    // full uuid the on-disk file is named after. When no exact match exists, fall back to the
    // first file whose name starts with the prefix (followed by '-' or '.jsonl').
    if (!target) {
      for (const dir of fs.readdirSync(projectsDir)) {
        const projDir = path.join(projectsDir, dir);
        let names: string[];
        try { names = fs.readdirSync(projDir); } catch { continue; }
        const match = names.find(name =>
          name.endsWith('.jsonl') && (name.startsWith(uuid + '-') || name === uuid + '.jsonl'),
        );
        if (match) {
          target = path.join(projDir, match);
          break;
        }
      }
    }
    if (!target) return;
    const lines =
      JSON.stringify({ type: 'custom-title', customTitle: trimmed, sessionId: uuid }) + '\n' +
      JSON.stringify({ type: 'agent-name', agentName: trimmed, sessionId: uuid }) + '\n';
    fs.appendFileSync(target, lines, 'utf-8');
  } catch {
    // Best-effort; never throw or block the rename.
  }
}

const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve a Codex session id to its latest non-default thread_name from the index ('' if none/unnamed).
function readCodexThreadName(codexId: string): string {
  try {
    const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
    if (!fs.existsSync(indexPath)) return '';
    let name = '';
    for (const line of fs.readFileSync(indexPath, 'utf-8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      try { const o = JSON.parse(t) as { id?: string; thread_name?: string };
        if (o.id === codexId && typeof o.thread_name === 'string') name = o.thread_name; // last wins
      } catch { /* skip */ }
    }
    if (!name || name === codexId || CODEX_UUID_RE.test(name)) return '';
    return name;
  } catch { return ''; }
}

// Best-effort: propagate a user rename into Codex's own session index so Codex's
// thread/resume picker shows the same title. Codex stores each session's editable
// title as `thread_name` in ~/.codex/session_index.jsonl (one JSON object per line,
// last line for a given id wins), so appending a fresh line applies the rename.
export function writeCodexSessionTitle(uuid: string, title: string): void {
  const trimmed = (title || '').trim();
  if (!trimmed || !uuid) return;
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return; // Codex not installed; nothing to write.
    const target = path.join(codexDir, 'session_index.jsonl');
    const line =
      JSON.stringify({ id: uuid, thread_name: trimmed, updated_at: new Date().toISOString() }) + '\n';
    fs.appendFileSync(target, line, 'utf-8');
  } catch {
    // Best-effort; never throw or block the rename.
  }
}

// Best-effort: find the on-disk agent session id for a session whose PTY was spawned at `spawnedAt`.
// Returns the newest matching session file's uuid for that agent in that cwd, created/updated after spawn.
function findAgentSessionIdOnDisk(
  agent: 'claude' | 'codex' | 'kiro' | 'copilot',
  cwd: string,
  spawnedAt: number,
  excludeUuids?: Set<string>,
  // Uuids of session files that ALREADY existed at spawn time. A fresh run can only ever
  // own a file IT created, so any pre-existing uuid is skipped — this is a deterministic
  // guard independent of birthtime/mtime reliability.
  preexistingUuids?: Set<string>,
): string | null {
  // Allow a small clock skew window: accept files touched a little before the recorded spawn time.
  const minMtime = spawnedAt - 5000;
  try {
    if (agent === 'claude') {
      const dir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd));
      if (!fs.existsSync(dir)) return null;
      let best: { uuid: string; mtimeMs: number } | null = null;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const uuid = name.replace(/\.jsonl$/, '');
        if (excludeUuids?.has(uuid)) continue;
        // A fresh run must never bind to a file that already existed at spawn (i.e. another
        // session's file). This snapshot-based skip is the primary guard; the created/mtime
        // checks below are kept as defense in depth.
        if (preexistingUuids?.has(uuid)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          if (!st.isFile()) continue;
          // Require the file to be CREATED after spawn: a fresh `claude` writes a brand-new
          // session file born after spawn; an already-live session's file was born earlier
          // (its mtime is fresh only because it's still being written) and must be excluded.
          // Fall back to mtime if birthtime is unavailable.
          const created = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
          if (created < minMtime) continue;
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { uuid, mtimeMs: st.mtimeMs };
          }
        } catch { /* skip */ }
      }
      return best?.uuid ?? null;
    }
    if (agent === 'codex') {
      const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
      if (!fs.existsSync(sessionsRoot)) return null;
      const normTarget = path.resolve(cwd);
      const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
      const listDesc = (d: string): string[] => {
        try { return fs.readdirSync(d).filter(n => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a)); }
        catch { return []; }
      };
      let best: { uuid: string; mtimeMs: number } | null = null;
      let walked = 0;
      const WALK_CAP = 400;
      outer:
      for (const year of listDesc(sessionsRoot)) {
        const yearDir = path.join(sessionsRoot, year);
        for (const month of listDesc(yearDir)) {
          const monthDir = path.join(yearDir, month);
          for (const day of listDesc(monthDir)) {
            const dayDir = path.join(monthDir, day);
            let names: string[];
            try { names = fs.readdirSync(dayDir); } catch { continue; }
            for (const name of names) {
              if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
              if (walked++ >= WALK_CAP) break outer;
              const full = path.join(dayDir, name);
              try {
                const idMatch = name.match(uuidRe);
                if (!idMatch) continue;
                if (excludeUuids?.has(idMatch[1])) continue;
                const st = fs.statSync(full);
                if (!st.isFile() || st.mtimeMs < minMtime) continue;
                if (best && st.mtimeMs <= best.mtimeMs) continue;
                // Confirm cwd from the session_meta head before accepting.
                const fd = fs.openSync(full, 'r');
                let head = '';
                try {
                  const buf = Buffer.alloc(64 * 1024);
                  const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
                  head = buf.subarray(0, bytes).toString('utf-8');
                } finally { fs.closeSync(fd); }
                const cwdMatch = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                const fileCwd = cwdMatch ? path.resolve(cwdMatch[1].replace(/\\(.)/g, '$1')) : '';
                if (fileCwd !== normTarget) continue;
                best = { uuid: idMatch[1], mtimeMs: st.mtimeMs };
              } catch { /* skip */ }
            }
            // Date dirs descend; once we've found a recent match and walked the freshest day, good enough.
            if (best) break outer;
          }
        }
      }
      return best?.uuid ?? null;
    }
  } catch { /* never throw */ }
  return null;
}

// Read the number of available Devin accounts (used to cap auto account-switch rounds)
function getDevinAccountCount(): number {
  try {
    const accountsPath = path.join(os.homedir(), '.session-sync-manager', 'accounts.json');
    if (fs.existsSync(accountsPath)) {
      const data = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      return (data.accounts || []).filter((a: any) => a.enabled !== false).length || 1;
    }
  } catch { /* ignore */ }
  return 1;
}

// Devin device fingerprint rotation (prevents cross-account rate-limit correlation)
const DEVIN_INSTALLATION_ID_PATHS = [
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'installation_id'),
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli-next', 'installation_id'),
];

// Windsurf Electron device ID (the Devin binary reads the Windsurf config path)
const WINDSURF_MACHINEID_PATHS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'machineid'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf - Next', 'machineid'),
];

export function rotateDevinInstallationId(): void {
  const newId = crypto.randomUUID().toUpperCase();

  // 1) Devin CLI installation_id
  for (const p of DEVIN_INSTALLATION_ID_PATHS) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, newId);
        console.log(`[PTY] Rotated installation_id: ${p} → ${newId}`);
      } else {
        const dir = path.dirname(p);
        if (fs.existsSync(dir)) {
          fs.writeFileSync(p, newId);
          console.log(`[PTY] Created installation_id: ${p} → ${newId}`);
        }
      }
    } catch (e) {
      console.warn(`[PTY] Failed to rotate installation_id ${p}:`, (e as Error).message);
    }
  }

  // 2) Windsurf machineid (use a different UUID so the two IDs are not identical and correlatable)
  const newMachineId = crypto.randomUUID().toUpperCase();
  for (const p of WINDSURF_MACHINEID_PATHS) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, newMachineId);
        console.log(`[PTY] Rotated machineid: ${p} → ${newMachineId}`);
      }
    } catch (e) {
      console.warn(`[PTY] Failed to rotate machineid ${p}:`, (e as Error).message);
    }
  }
}

// Resolve the absolute path of session-sync (avoids ENOENT when PATH is missing on Dock launch)
const sessionSyncPath = (() => {
  try {
    const syncSymlink = path.join(os.homedir(), '.local', 'bin', 'session-sync');
    if (fs.existsSync(syncSymlink)) return fs.realpathSync(syncSymlink);
  } catch { /* ignore */ }
  return 'session-sync'; // fallback to PATH lookup
})();

export function getDisplayName(presetCommand: string): string {
  if (PRESET_DISPLAY_NAMES[presetCommand]) return PRESET_DISPLAY_NAMES[presetCommand];
  if (!presetCommand) return 'Terminal';
  const cmd = presetCommand.trim().toLowerCase();
  // Recognize the CLI by its leading token so variants like `claude --resume <uuid>`
  // collapse to a short provider tag instead of echoing the whole command.
  if (cmd.startsWith('claude')) return 'Claude';
  if (cmd.startsWith('codex')) return 'Codex';
  if (cmd.startsWith('copilot')) return 'Copilot';
  if (cmd.startsWith('gemini')) return 'Gemini';
  if (cmd.startsWith('opencode')) return 'OpenCode';
  if (cmd.startsWith('devin')) return 'Devin';
  if (cmd.startsWith('kiro')) return 'Kiro';
  if (cmd.startsWith('kimi')) return 'Kimi';
  if (cmd.startsWith('cursor') || cmd.startsWith('agent')) return 'Cursor';
  // Generic fallback: capitalized first token.
  const first = presetCommand.trim().split(/\s+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Terminal';
}

export class PtyManager {
  private sessions: Map<string, PtySession> = new Map();
  private nextId = 1;
  private events: PtyManagerEvents;
  private getTitleAIConfig?: TitleAIConfigProvider;

  constructor(events: PtyManagerEvents, getTitleAIConfig?: TitleAIConfigProvider) {
    this.events = events;
    this.getTitleAIConfig = getTitleAIConfig;
  }

  create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): PtySession {
    const id = `term-${this.nextId++}`;
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh');

    // First copy process.env, filtering out undefined values, then apply overrides (empty string clears)
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Force a UTF-8 locale for the pty.
    //
    // When Posse is launched from Finder/Dock (not from a terminal), it inherits NO LANG/LC_*.
    // Without a UTF-8 locale, the shell and many CLI programs fall back to the C/POSIX locale and
    // stop treating their byte stream as UTF-8 — so multibyte text (e.g. Chinese) gets emitted/handled
    // as single bytes. That stream then lands in xterm's buffer as one-codepoint-per-UTF-8-byte, and
    // copying the selection produces mojibake like `ÁêÜËÆ∫‰∏äÊõ¥` when pasted elsewhere (UTF-8 bytes
    // read as Mac Roman). Forcing UTF-8 keeps the pty byte stream UTF-8 end to end so the copy is clean.
    //
    // Only fill in when the user hasn't deliberately set a locale (do not override an explicit LC_ALL/LANG).
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
      env.LANG = 'en_US.UTF-8';
    }
    if (!env.LC_CTYPE && !env.LC_ALL) {
      env.LC_CTYPE = 'UTF-8';
    }
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        if (value === '') {
          // An empty string means clear the variable
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      // Debug log
      console.log('[PtyManager] Environment variables set:', JSON.stringify(envOverrides));
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env,
      // Decode pty bytes as UTF-8 explicitly. node-pty defaults to 'utf8', but pin it so onData always
      // emits proper UTF-8 strings (the native reader holds back partial multibyte sequences so a
      // character is never split across two onData chunks). This is the byte->string boundary; getting
      // it right here keeps the whole path (onData -> JSON/IPC -> xterm -> selection -> copy) UTF-8 clean.
      // It does not touch ANSI/control bytes (those are 7-bit ASCII, unaffected by UTF-8 decoding) and is
      // independent of the base64 INPUT path (input is encoded/decoded separately before pty.write).
      encoding: 'utf8',
    });

    const session: PtySession = {
      id,
      ptyProcess,
      buffer: '',
      rawBuffer: '',
      userInputs: [],
      commandCount: 0,
      title: 'New session',
      titleLocked: false,
      titleGenerated: false,
      summarizeScheduled: false,
      summarizeTimer: null,
      cwd,
      presetCommand,
      themeId,
      provider: null,
      createdAt: Date.now(),
      lastActivityMs: Date.now(),
      resumeId: null,
      resumeCommand: null,
      agentSessionId: null,
      autoRetryCooldown: 0,
      prevData: '',
      retryTimer: null,
      switchAttempts: 0,
      lastAutoSwitchAt: 0,
      rateLimitRetryCount: 0,
      lastRateLimitAt: 0,
      disposables: [],
    };

    session.disposables.push(ptyProcess.onData((data: string) => {
      session.buffer += data;
      // Cap the buffer size to avoid memory growth
      if (session.buffer.length > 5000) {
        session.buffer = session.buffer.slice(-2500);
      }
      // rawBuffer is the full ANSI output retained by the daemon (which survives app restart).
      // It serves TWO consumers with opposite needs:
      //   1. Desktop renderer reconnect (after app restart) replays the WHOLE rawBuffer -> wants as much
      //      scrollback as possible so users can scroll back to pre-restart output.
      //   2. Mobile / remote first-paint replays only a BOUNDED TAIL (sliced in remote-server.ts) -> on weak
      //      networks replay size drives first-paint speed, so it must stay small.
      // The daemon therefore retains a large cap (desktop scrollback), and the mobile path slices a tail at send time.
      // Memory cost is ~RAW_BUFFER_MAX_BYTES per live session, negligible on desktop.
      session.rawBuffer += data;
      // Track real last-activity time from live output. Survives app restart (held in the detached
      // daemon's memory) so a reconnecting app can sort restored sessions by their true last activity.
      session.lastActivityMs = Date.now();
      if (session.rawBuffer.length > RAW_BUFFER_MAX_BYTES) {
        // A direct slice may cut an ANSI escape sequence in half (a truncated ESC),
        // and on replay xterm would treat following visible chars as parameters of the broken sequence -> spinner torn across lines.
        // Push the cut point forward to the next ESC byte to ensure recovery starts at the beginning of a complete sequence.
        let cut = session.rawBuffer.length - RAW_BUFFER_MAX_BYTES;
        const nextEsc = session.rawBuffer.indexOf('\x1b', cut);
        if (nextEsc !== -1 && nextEsc - cut < 4096) cut = nextEsc;
        session.rawBuffer = session.rawBuffer.slice(cut);
      }

      // Intercept OSC 0/1/2 window/icon title sequences: ESC ] 0;<title> BEL  or  ESC ] 0;<title> ESC \
      // Only used when the user has not configured AI — with AI configured, let the AI build the title; OSC is just a fallback.
      // Note: an OSC title may be set automatically on shell startup (e.g. the current directory) and is not user intent,
      //       so do not set titleGenerated, allowing a later AI-generated title to override it.
      const titleCfg = this.getTitleAIConfig?.();
      const aiConfigured = !!(titleCfg?.baseUrl && titleCfg.apiKey && titleCfg.model);
      if (!aiConfigured) {
        const oscMatch = data.match(/\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/);
        if (oscMatch && oscMatch[1]) {
          const oscTitle = oscMatch[1].trim();
          if (oscTitle && oscTitle.length >= 2 && oscTitle.length <= 80
              && !session.titleLocked) {
            let candidate = oscTitle;
            if (CODEX_UUID_RE.test(candidate)) {
              // Codex sets the terminal title to its session UUID; resolve the real name instead.
              candidate = readCodexThreadName(candidate);
            }
            if (candidate && !CODEX_UUID_RE.test(candidate)) {
              session.title = candidate.length > 40 ? candidate.slice(0, 40) + '…' : candidate;
              // Do not set titleGenerated — OSC may just be shell startup info; confirm after the user provides input
              this.events.onTitleUpdate(id, session.title);
            }
            // else: unnamed codex UUID title — leave the existing title untouched (don't show a raw UUID)
          }
        }
      }

      // First trigger on accumulated threshold: does not rely on Enter detection (in TUIs, Enter is often not a bare \r)
      // 800 bytes is typically about one screen of content, enough for the AI to infer user intent
      if (!session.titleGenerated && !session.titleLocked && session.buffer.length >= 800) {
        if (!session.summarizeScheduled) {
          session.summarizeScheduled = true;
          // 800ms debounce: wait for output to stabilize a bit to avoid capturing a half line
          session.summarizeTimer = setTimeout(() => {
            session.summarizeTimer = null;
            void this.triggerSummarize(id);
          }, 800);
        }
      }

      // Capture each CLI's resume command in real time (formats vary)
      if (!session.resumeId) {
        const stripped = stripTerminalControlSequences(data);
        const result = parseResumeCommand(stripped);
        if (result) {
          session.resumeId = result.sessionId;
          session.resumeCommand = result.command;
        }
      }

      // Devin terminal only: auto-retry and account switching
      // Applies only to the devin presetCommand; other terminals are not affected
      if (session.presetCommand.startsWith('devin')) {
        const combinedLower = (session.prevData + data).toLowerCase();
        session.prevData = data;

        // Detect rate-limit-related errors (covers hard and soft rate limiting)
        // Typical signature: "Permission denied: Reached overall message rate limit"
        const isRateLimit = combinedLower.includes('rate limit')
          || combinedLower.includes('quota exhausted')
          || combinedLower.includes('usage is exhausted');

        // Strict matching: threshold for treating consecutive rate-limit errors as one round
        const RATE_LIMIT_RETRY_MAX = 3;       // Max number of "continue" attempts
        const RATE_LIMIT_WINDOW = 15000;      // Window: only rate limits within 15s count as one round

        if (isRateLimit) {
          session.prevData = '';
          const now = Date.now();

          // Prevent duplicate triggers from PTY chunking: if a retryTimer is already running, skip this one
          if (session.retryTimer) return;

          // Reset the count if outside the window (the previous rate limit was long ago, not consecutive)
          if (now - session.lastRateLimitAt > RATE_LIMIT_WINDOW) {
            session.rateLimitRetryCount = 0;
          }
          session.lastRateLimitAt = now;
          session.rateLimitRetryCount++;

          const maxAccounts = getDevinAccountCount();

          if (session.rateLimitRetryCount <= RATE_LIMIT_RETRY_MAX) {
            // Phase 1: send "continue" within the session to try to recover
            console.log(`[PTY] Rate limit detected (${session.rateLimitRetryCount}/${RATE_LIMIT_RETRY_MAX}); sending "continue" in ${session.rateLimitRetryCount < RATE_LIMIT_RETRY_MAX ? '5' : 8}s (session: ${id})`);
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              ptyProcess.write('continue\r');
              console.log(`[PTY] Sent "continue" (${session.rateLimitRetryCount}/${RATE_LIMIT_RETRY_MAX}) (session: ${id})`);
            }, session.rateLimitRetryCount < RATE_LIMIT_RETRY_MAX ? 5000 : 8000);
          } else if (session.switchAttempts >= maxAccounts) {
            // Phase 3: all accounts have been tried, give up
            const errMsg = `\n⚠️ [Posse] All ${maxAccounts} accounts are exhausted; please try again later\n`;
            ptyProcess.write(errMsg);
            this.events.onAutoSwitchStatus?.(id, 'exhausted', `All ${maxAccounts} accounts exhausted`);
            console.log(`[PTY] All ${maxAccounts} accounts exhausted (session: ${id})`);
            session.switchAttempts = 0;
            session.rateLimitRetryCount = 0;
            session.autoRetryCooldown = now + 60000;
          } else if (now > session.autoRetryCooldown) {
            // Phase 2: repeated "continue" attempts failed, proceed to account switching
            session.switchAttempts++;
            session.rateLimitRetryCount = 0;
            session.lastAutoSwitchAt = now;
            session.autoRetryCooldown = now + 30000;

            this.events.onAutoSwitchStatus?.(id, 'switching', `Switching account (${session.switchAttempts}/${maxAccounts})`);
            console.log(`[PTY] ${RATE_LIMIT_RETRY_MAX} consecutive rate limits without recovery; switching account ${session.switchAttempts}/${maxAccounts} (session: ${id})`);

            // 1) Gracefully exit the current Devin
            ptyProcess.write('/exit\r');

            // 2) Wait 3s for Devin to fully exit, then run session-sync go (switch account + start a new Devin)
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              session.buffer = '';
              session.rawBuffer = '';
              session.prevData = '';
              rotateDevinInstallationId();
              ptyProcess.write('session-sync go\r');
              this.events.onAutoSwitchStatus?.(id, 'switched', `Switched (${session.switchAttempts}/${maxAccounts})`);
              console.log(`[PTY] Sent session-sync go (session: ${id})`);

              session.autoRetryCooldown = 0;
              // If no rate limit is triggered again within 15s, reset the count
              session.retryTimer = setTimeout(() => {
                session.retryTimer = null;
                if (this.sessions.has(id)) {
                  session.switchAttempts = 0;
                  this.events.onAutoSwitchStatus?.(id, 'idle');
                }
              }, 15000);
            }, 3000);
          }
        }
        // Non-rate-limit ordinary warning -> send "continue" after 8s
        else if (combinedLower.includes('⚠') || combinedLower.includes('something went wrong')) {
          session.prevData = '';
          if (Date.now() > session.autoRetryCooldown) {
            console.log(`[PTY] ⚠ warning detected; sending "continue" after 8s (session: ${id})`);
            session.autoRetryCooldown = Date.now() + 10000;
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              ptyProcess.write('continue\r');
              session.autoRetryCooldown = 0;
            }, 8000);
          }
        }
      } else {
        session.prevData = data;
      }

      this.events.onData(id, data);
      this.events.onRawData?.(id, data);
    }));

    session.disposables.push(ptyProcess.onExit(() => {
      this.events.onExit(id);
      this.sessions.delete(id);
    }));

    this.sessions.set(id, session);

    // If there is a preset command, send it after a delay
    if (presetCommand) {
      setTimeout(() => {
        ptyProcess.write(presetCommand + '\r');
      }, 300);
    }

    // Correlate this live PTY with the agent's on-disk session id (uuid) so the renderer can
    // dedup it against on-disk history and focus (instead of duplicating) an already-open session.
    // 1) Most reliable: WE launched it via a resume command -> parse the uuid directly, set now.
    const launchedId = extractSessionIdFromLaunch(presetCommand);
    if (launchedId) {
      session.agentSessionId = launchedId;
      session.resumeId = launchedId;
      const launchedResume = parseResumeCommand(presetCommand);
      session.resumeCommand = launchedResume?.command || session.resumeCommand;
    } else {
      // 2) Best-effort: a fresh agent run writes a new session file shortly after spawn.
      //    Re-scan a few times after create; never block creation, never throw.
      const agent = agentKindFromCommand(presetCommand);
      if (agent === 'claude' || agent === 'codex') {
        const spawnedAt = Date.now();
        // Synchronously snapshot the session files that already exist for this agent+cwd,
        // BEFORE the fresh run has a chance to write its own. The deferred rescan skips
        // these so a fresh `claude` can only bind to a file born after spawn — deterministic,
        // independent of birthtime/mtime reliability. (Claude is the hardened path; codex
        // still relies on the existing exclude/mtime logic via an empty snapshot.)
        const preexisting = agent === 'claude'
          ? snapshotExistingClaudeSessionUuids(cwd)
          : new Set<string>();
        const attempts = [2500, 6000, 12000];
        for (const delay of attempts) {
          setTimeout(() => {
            const live = this.sessions.get(id);
            if (!live || live.agentSessionId) return;
            // Build the exclusion set fresh so it reflects the uuids bound to OTHER live
            // sessions right now — a discovered uuid must never collide with another live PTY.
            const exclude = new Set<string>();
            for (const [otherId, other] of this.sessions) {
              if (otherId === id) continue;
              if (other.agentSessionId) exclude.add(other.agentSessionId);
              if (other.resumeId) exclude.add(other.resumeId);
            }
            const found = findAgentSessionIdOnDisk(agent, cwd, spawnedAt, exclude, preexisting);
            if (found) live.agentSessionId = found;
          }, delay);
        }
      }
    }

    return session;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    // User manual input -> reset the auto account-switch count (the user has taken over)
    session.switchAttempts = 0;

    // Detect pasted input (voice input methods paste, writing many characters at once)
    if (data.length > 5 && data !== '\r') {
      const cleaned = data.replace(/[\r\n]/g, ' ').trim();
      if (cleaned.length > 0) {
        session.userInputs.push(cleaned);
        // Keep only the most recent 20
        if (session.userInputs.length > 20) {
          session.userInputs = session.userInputs.slice(-20);
        }
        this.events.onPasteInput?.(id, session.cwd);
      }
    }

    // Detect the Enter key to count commands; in TUIs \r may not appear, this is just a supplementary signal
    if (data === '\r') {
      session.commandCount++;
      // Auto-generate a title for the first 3 commands (a fallback paired with the buffer-threshold trigger)
      // If the title is not finalized yet (titleGenerated=false), reschedule even if it was scheduled before this input,
      // because there is now user input, making the generated result more accurate
      if (!session.titleGenerated && !session.titleLocked && session.commandCount <= 3) {
        // Clear the previous schedule and reschedule
        if (session.summarizeTimer) {
          clearTimeout(session.summarizeTimer);
          session.summarizeTimer = null;
        }
        session.summarizeScheduled = true;
        session.summarizeTimer = setTimeout(() => {
          session.summarizeTimer = null;
          void this.triggerSummarize(id);
        }, 800);
      }
      this.events.onPasteInput?.(id, session.cwd);
    }

    session.ptyProcess.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Filter out invalid sizes; node-pty resize(0,0) throws
    if (cols > 0 && rows > 0) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.summarizeTimer) {
      clearTimeout(session.summarizeTimer);
      session.summarizeTimer = null;
    }
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    session.disposables.forEach(d => d.dispose());
    session.disposables = [];
    session.ptyProcess.kill();
    this.sessions.delete(id);
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title;
    session.titleLocked = true;
    this.events.onTitleUpdate(id, title);
    // Forward the rename into the agent's OWN session file so its resume/history list matches.
    // RESUMED sessions keep agentSessionId empty by design and carry only resumeId, so fall back
    // to resumeId — mirroring the closed-sessions:rename path (index.ts) which resolves the same way.
    // Copilot/Kiro have no writable session-title format, so propagation is intentionally skipped
    // for them (Posse's own session.title still updates so the sidebar reflects the rename).
    const writeId = session.agentSessionId || session.resumeId;
    if (writeId) {
      const kind = agentKindFromCommand(session.presetCommand);
      if (kind === 'claude') {
        writeClaudeSessionTitle(writeId, title);
      } else if (kind === 'codex') {
        writeCodexSessionTitle(writeId, title);
      }
    }
  }

  setProvider(id: string, provider: string | null): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.provider = provider;
  }

  /**
   * Force regenerating the title with AI. Invoked by the user via the right-click "Regenerate title".
   * Clears the lock/generated flags and runs the AI again; keeps the original title on failure.
   */
  async regenerateTitle(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.titleLocked = false;
    session.titleGenerated = false;
    session.summarizeScheduled = false;
    await this.triggerSummarize(id);
  }

  getAllSessions(): PtySession[] {
    // Lazily resolve agentSessionId for any agent session that hasn't been correlated yet
    // (covers the case where the on-disk session file appeared after the create-time scans).
    for (const session of this.sessions.values()) {
      if (session.agentSessionId) continue;
      const agent = agentKindFromCommand(session.presetCommand);
      if (agent === 'claude' || agent === 'codex') {
        const found = findAgentSessionIdOnDisk(agent, session.cwd, session.createdAt);
        if (found) session.agentSessionId = found;
      }
    }
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Extract the resume command from the buffer (a fallback before close, handling resume output split across chunks)
   */
  captureResumeFromBuffer(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.resumeId) return;
    const stripped = stripTerminalControlSequences(session.buffer);
    const result = parseResumeCommand(stripped);
    if (result) {
      session.resumeId = result.sessionId;
      session.resumeCommand = result.command;
    }
  }

  getCwd(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return os.homedir();
    try {
      const pid = session.ptyProcess.pid;
      let dir = '';
      if (process.platform === 'win32') {
        // Windows cannot reliably get the child process cwd; just fall back
      } else if (process.platform === 'linux') {
        try {
          dir = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch { /* ignore */ }
      } else {
        // macOS
        const result = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
          encoding: 'utf-8',
          timeout: 2000,
        });
        dir = result.trim().replace(/^n/, '');
      }
      if (dir) return dir;
    } catch {
      // Ignore errors
    }
    return session.cwd;
  }

  private async triggerSummarize(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.titleLocked || session.titleGenerated) return;

    const cleanBuffer = stripTerminalControlSequences(session.buffer).trim();
    const lastUserInput = session.userInputs.length > 0
      ? session.userInputs[session.userInputs.length - 1]
      : '';
    const hasUserInput = session.userInputs.length > 0 || session.commandCount > 0;

    // Too little material; do not waste an API call, wait for the next round
    if (cleanBuffer.length < 20 && lastUserInput.length < 4) {
      session.summarizeScheduled = false;
      return;
    }

    // If the user has not actually typed anything yet, set only a temporary title and do not lock titleGenerated,
    // so a more accurate title can be regenerated after the user provides input
    const config = this.getTitleAIConfig?.();
    if (config?.baseUrl && config.apiKey && config.model) {
      try {
        const prompt = [
          'Based on the following terminal session content, infer what task the user is doing and generate a short English title.',
          'Requirements: 3-6 words; output the title directly, without quotes, prefixes, or explanations.',
          '',
          `Working directory: ${session.cwd}`,
          `Launch command: ${getDisplayName(session.presetCommand)}`,
          lastUserInput ? `Latest user input: ${lastUserInput.slice(0, 240)}` : '',
          `Terminal output (control chars stripped):\n${cleanBuffer.slice(-1500)}`,
        ].filter(Boolean).join('\n');
        const title = await requestTitleFromConfiguredAI(config, prompt);
        const latest = this.sessions.get(id);
        if (latest && !latest.titleLocked && title) {
          latest.title = title.slice(0, 50);
          // Only lock the title when the user has actually typed something; otherwise it is just a temporary title
          latest.titleGenerated = hasUserInput;
          latest.summarizeScheduled = false;
          this.events.onTitleUpdate(id, latest.title);
          return;
        }
      } catch (err) {
        console.error('[PtyManager] AI title generation failed, using fallback:', err instanceof Error ? err.message : err);
        // On failure, fall back to the first buffer line below
      }
    }

    // Fallback: use the first readable line of the buffer
    const latest = this.sessions.get(id);
    if (!latest || latest.titleLocked || latest.titleGenerated) return;
    latest.summarizeScheduled = false;
    const fallback = lastUserInput || cleanBuffer.split('\n').map(s => s.trim()).find(s => s.length >= 3) || '';
    if (!fallback) return;
    latest.title = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback;
    // Only lock the title when the user has actually typed something
    latest.titleGenerated = hasUserInput;
    this.events.onTitleUpdate(id, latest.title);
  }
}
