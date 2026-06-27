/**
 * Resumable-session discovery + title helpers (pure fs/os/path — NO electron).
 *
 * Extracted from index.ts so BOTH the Electron main process AND the headless backend
 * (which can't import electron) can list resumable Claude/Codex sessions for a cwd and
 * resolve their human-readable titles. The Electron `claude-sessions:list` IPC and the
 * remote-server `/api/resumable` route both call `listResumableSessions`.
 *
 * IMPORTANT: nothing in this file may import from 'electron'.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const PROJECTS_HEAD_BYTES = 64 * 1024;

export type AgentHistorySession = {
  id: string;
  title: string;
  cwd: string;
  mtimeMs: number;
  agent: 'claude' | 'codex';
  resumeCommand: string;
  // Backing session file path (Codex rollout jsonl). Optional: consumers that
  // need to delete/archive the session route by this; absent for callers that
  // don't populate it.
  sourcePath?: string;
};

// Read the first line of a file (up to ~16KB) for cheap parsing of the Codex session_meta
export function readFirstLine(filePath: string, maxBytes = 16 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytes).toString('utf-8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Codex's CLI-detection sends a "what's 2+2?" health-check probe, creating throwaway
// sessions. Match it so we can skip it as a title source and filter probe-only sessions.
const CODEX_PROBE_RE = /^\s*what'?s?\s+(is\s+)?2\s*\+\s*2\s*\??\s*$/i;

export function codexTitleIsDefault(title: string, id: string): boolean {
  if (!title || title === id) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title.trim());
}

// Scan a Codex rollout file's head for the first real user message and use it as a title.
// The real prompt is an `event_msg` with payload.type === 'user_message' (this skips the
// auto-injected developer/AGENTS.md/permissions context, which are plain response_items).
export function codexFirstUserPrompt(filePath: string): string {
  try {
    const head = readHead(filePath, 256 * 1024);
    for (const line of head.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { type?: string; payload?: { type?: string; message?: unknown } };
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'user_message' && typeof obj.payload.message === 'string') {
        const cleaned = cleanSessionTitle(obj.payload.message);
        if (CODEX_PROBE_RE.test(cleaned)) continue;
        if (isRealUserPrompt(cleaned)) {
          return cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned;
        }
      }
    }
  } catch { /* unreadable — fall through */ }
  return '';
}

export function listCodexSessions(targetCwd: string): AgentHistorySession[] {
  const MAX_MATCHES = 40;
  const MAX_FILES = 800;
  const results: AgentHistorySession[] = [];

  try {
    const normTarget = path.resolve(String(targetCwd || ''));
    if (!normTarget) return [];

    // 1. Read the title index (id -> thread_name); the last line wins
    const titleMap = new Map<string, string>();
    try {
      const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as { id?: string; thread_name?: string };
            if (obj.id && typeof obj.thread_name === 'string') {
              titleMap.set(obj.id, obj.thread_name);
            }
          } catch { /* skip bad line */ }
        }
      }
    } catch { /* missing index -> empty map */ }

    // 2. Walk the date directories in descending order
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsRoot)) return [];

    const listDirDesc = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir)
          .filter((n) => /^\d+$/.test(n))
          .sort((a, b) => Number(b) - Number(a));
      } catch { return []; }
    };

    let scanned = 0;
    outer:
    for (const year of listDirDesc(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      for (const month of listDirDesc(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of listDirDesc(monthDir)) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const file of files) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            if (scanned >= MAX_FILES || results.length >= MAX_MATCHES) break outer;
            scanned++;
            const full = path.join(dayDir, file);
            try {
              const st = fs.statSync(full);
              if (!st.isFile()) continue;
              const firstLine = readFirstLine(full).trim();
              if (!firstLine) continue;
              const obj = JSON.parse(firstLine) as {
                type?: string;
                payload?: { id?: string; cwd?: string };
              };
              if (obj.type !== 'session_meta' || !obj.payload) continue;
              const fileCwd = path.resolve(String(obj.payload.cwd || ''));
              if (fileCwd !== normTarget) continue;
              const id = String(obj.payload.id || '');
              if (!id) continue;
              const rawTn = titleMap.get(id);
              let codexTitle: string;
              if (rawTn && !codexTitleIsDefault(rawTn, id)) {
                codexTitle = rawTn;                 // real thread_name wins
              } else {
                codexTitle = codexFirstUserPrompt(full);   // skips probes; '' if probe-only/empty
                if (!codexTitle) continue;          // filter out detection-probe / empty sessions
              }
              results.push({
                id,
                title: codexTitle,
                cwd: normTarget,
                mtimeMs: st.mtimeMs,
                agent: 'codex',
                resumeCommand: `codex resume ${id}`,
                sourcePath: full,
              });
            } catch { /* skip unreadable / unparseable file */ }
          }
        }
      }
    }
  } catch { /* never throw */ }

  return results;
}

// Strip command/xml tags + collapse whitespace; truncate for a session title.
export function cleanSessionTitle(raw: string): string {
  return raw
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// When a user RENAMES a Claude Code session, Claude records it as a user message like:
//   The user named this session "New UI". This may indicate the ...
// Extract the quoted name (tolerate "named"/"renamed", straight or curly quotes). Match against
// the RAW message text (quotes matter, so do not run on the tag-stripped/cleaned form).
const RENAME_TITLE_RE = /the user (?:re)?named this session\s*["“”'']([^"“”'']+)["“”'']/i;
// Claude Code records a real `/rename` as a `<system-reminder>` whose body is exactly
// "The user named this session "X". This may indicate ...". Require that surrounding context
// so we don't pick up plain prose that merely quotes the phrase (e.g. a task description that
// discusses the rename marker). A real session name is a short single line; reject captures that
// carry newline escapes or are implausibly long — those are quoted-text false positives.
export function extractRenameTitle(userText: string): string | null {
  if (!/named this session/i.test(userText)) return null;
  if (!userText.includes('This may indicate')) return null; // genuine system-reminder body
  const m = RENAME_TITLE_RE.exec(userText);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  if (/\\n|\n/.test(name)) return null; // multi-line capture -> not a real name
  if (name.length > 60) return null; // names are short; long capture = mis-match
  return name.slice(0, 60);
}

// Decide whether a cleaned user-message string is a real prompt usable as a session title.
// Skips Claude Code's injected system preambles (the "Caveat:" local-command notice), empty
// strings, leftover XML/tag wrappers, and session-continuation meta lines.
export function isRealUserPrompt(cleaned: string): boolean {
  if (!cleaned) return false;
  if (cleaned.startsWith('<')) return false; // unstripped tag wrapper / tool-result echo
  if (cleaned.startsWith('Caveat:')) return false; // local-command caveat preamble
  if (cleaned.startsWith('This session is being continued')) return false;
  if (cleaned.startsWith('<command-message>')) return false;
  if (cleaned.startsWith('<local-command-stdout>')) return false;
  return true;
}

// Read up to maxBytes from the head of a file (cheap parse for large jsonl).
export function readHead(filePath: string, maxBytes = PROJECTS_HEAD_BYTES): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytes).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Read the first `maxLines` newline-delimited lines from the head of a file, streaming in
// chunks and stopping as soon as `maxLines` newlines are seen. Unlike `readHead` (byte-bounded),
// this is line-bounded: a single pathological record (e.g. a 56KB SessionStart-hook `attachment`)
// counts as ONE line and can't crowd real user/assistant messages out of the window. A generous
// `maxBytesCap` guards against a degenerate single huge line OOMing the read. Returns the joined
// lines (no trailing partial line beyond the cap is included).
export function readHeadLines(
  filePath: string,
  maxLines: number,
  maxBytesCap = 4 * 1024 * 1024,
): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK = 64 * 1024;
    const chunk = Buffer.alloc(CHUNK);
    let text = '';
    let total = 0;
    let position = 0;
    let newlines = 0;
    for (;;) {
      const want = Math.min(CHUNK, maxBytesCap - total);
      if (want <= 0) break;
      const bytes = fs.readSync(fd, chunk, 0, want, position);
      if (bytes <= 0) break;
      position += bytes;
      total += bytes;
      const slice = chunk.subarray(0, bytes).toString('utf-8');
      text += slice;
      for (let i = 0; i < slice.length; i++) {
        if (slice.charCodeAt(i) === 10 /* \n */) {
          newlines++;
          if (newlines >= maxLines) break;
        }
      }
      if (newlines >= maxLines) break;
      if (bytes < want) break; // EOF
    }
    if (newlines >= maxLines) {
      // Trim to exactly the first `maxLines` lines.
      let cut = -1;
      let seen = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
          seen++;
          if (seen >= maxLines) { cut = i; break; }
        }
      }
      if (cut >= 0) text = text.slice(0, cut);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

// Read up to tailBytes from the END of a file. Claude appends the `ai-title` line late, so for
// large jsonl files it can sit beyond the head window; scanning the tail recovers it cheaply.
export function readTail(filePath: string, size: number, tailBytes = 32 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = Math.max(0, size - tailBytes);
    const len = Math.min(tailBytes, size);
    const buf = Buffer.alloc(len);
    const bytes = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, bytes).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Above this size, scan only the tail for title-type lines instead of the whole file.
const CLAUDE_TITLE_FULL_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const CLAUDE_TITLE_TAIL_BYTES = 512 * 1024;

interface ClaudeTitleFields {
  customTitle: string; // explicit user rename via Posse UI (authoritative)
  renameTitle: string; // explicit `/rename` in the terminal ("The user named this session …")
  agentName: string; // usually mirrors customTitle
  aiTitle: string; // Claude's auto title
}

// Scan a chunk of jsonl lines for the LAST occurrence of each title-type line. Uses a cheap
// substring `.includes` filter BEFORE JSON.parse so we don't parse every line of a large file.
function scanClaudeTitleFields(chunk: string, acc: ClaudeTitleFields): void {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hasCustom = trimmed.includes('"type":"custom-title"');
    const hasAgent = trimmed.includes('"type":"agent-name"');
    const hasAi = trimmed.includes('"type":"ai-title"');
    // `/rename` in the terminal is recorded as a user message ("The user named this
    // session …"), which can sit ANYWHERE in the file — detect it in this same scan so
    // a late rename isn't missed (the head-only read used to miss it). The quoted name
    // is JSON-escaped in the raw line (\"X\"), so unescape before matching the regex.
    const hasRename = trimmed.includes('named this session');
    if (!hasCustom && !hasAgent && !hasAi && !hasRename) continue;
    if (hasRename) {
      const rt = extractRenameTitle(trimmed.replace(/\\"/g, '"'));
      if (rt) acc.renameTitle = rt; // last occurrence wins (most recent rename)
    }
    if (!hasCustom && !hasAgent && !hasAi) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        customTitle?: string;
        agentName?: string;
        aiTitle?: string;
      };
      // Last occurrence of each type wins (most recent).
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        acc.customTitle = obj.customTitle;
      } else if (obj.type === 'agent-name' && typeof obj.agentName === 'string') {
        acc.agentName = obj.agentName;
      } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        acc.aiTitle = obj.aiTitle;
      }
    } catch { /* skip partial/broken line (tail reads may start mid-line) */ }
  }
}

// Find the title-type lines (customTitle / agentName / aiTitle) for a Claude session file.
// They can appear anywhere in the file (often late), so we scan beyond the head:
//   - file <= 8MB  -> read the WHOLE file and scan (cheap substring filter before parse).
//   - file >  8MB  -> read only the LAST ~512KB (titles are typically late) and scan that.
// Returns the LAST occurrence of each type. Never throws.
export function findClaudeTitleFields(filePath: string, size: number): ClaudeTitleFields {
  const acc: ClaudeTitleFields = { customTitle: '', renameTitle: '', agentName: '', aiTitle: '' };
  try {
    if (size > CLAUDE_TITLE_FULL_SCAN_MAX_BYTES) {
      scanClaudeTitleFields(readTail(filePath, size, CLAUDE_TITLE_TAIL_BYTES), acc);
    } else {
      scanClaudeTitleFields(fs.readFileSync(filePath, 'utf-8'), acc);
    }
  } catch { /* never throw; leave acc empty -> caller falls back */ }
  return acc;
}

// Resolve the best Claude session title from scanned fields + head-derived fallbacks.
// Priority: customTitle (Posse-UI rename) > renameTitle (terminal /rename) > agentName
// > aiTitle (auto) > first real user prompt > uuid.
// renameTitle outranks agentName/aiTitle because an explicit `/rename` is user intent and
// must not be masked by an auto-generated title (#44). `renameTitle` arg = head-derived
// fallback; the scan-derived fields.renameTitle (found anywhere in the file) takes priority.
//
// #7: a terminal `/rename` writes a `custom-title` record AND a durable `<system-reminder>`
// rename marker. But when the session is later resumed, Claude Code RE-INJECTS its original
// auto-generated title back into `custom-title` (reverting it to the `ai-title` value), while
// the rename marker is never rewritten. So if the LAST `custom-title` equals the auto `ai-title`
// yet a distinct `/rename` marker exists, the `custom-title` is a stale auto-revert — the user's
// explicit `/rename` is the most recent intentional signal and must win.
export function resolveClaudeTitle(
  fields: ClaudeTitleFields,
  firstUserTitle: string,
  renameTitle: string,
  uuid: string
): string {
  const customTitle = fields.customTitle.trim();
  const rename = (fields.renameTitle || renameTitle).trim();
  // Auto-revert detection: custom-title was clobbered back to the auto ai-title on resume,
  // but the user's explicit /rename says otherwise -> trust the rename.
  const customIsAutoRevert =
    !!customTitle && customTitle === fields.aiTitle.trim() && !!rename && rename !== customTitle;
  if (customTitle && !customIsAutoRevert) return customTitle.slice(0, 60);
  if (rename) return rename.slice(0, 60);
  if (fields.agentName.trim()) return fields.agentName.trim().slice(0, 60);
  if (fields.aiTitle.trim()) return fields.aiTitle.trim().slice(0, 60);
  if (firstUserTitle) return firstUserTitle;
  return uuid;
}

// Cache resolved Claude session titles keyed by absolute file path. A cached entry is valid
// only while the file's mtimeMs AND size are unchanged — when Claude appends (rename, new
// ai-title, more messages) the mtime/size change, the lookup misses, and we re-scan for a fresh
// title. No manual invalidation needed. Capped to avoid unbounded growth.
const claudeTitleCache = new Map<string, { mtimeMs: number; size: number; title: string }>();
const CLAUDE_TITLE_CACHE_MAX_ENTRIES = 2000;

// Lookup-or-(scan-and-store). Reuses the mtimeMs/size the caller already statted (no double
// stat). On a hit (same path + mtimeMs + size) returns the cached title without reading the
// file; on a miss runs `compute()` (the head + full/tail scan) and caches the result.
export function getCachedClaudeTitle(
  filePath: string,
  mtimeMs: number,
  size: number,
  compute: () => string
): string {
  const cached = claudeTitleCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.title;
  }
  const title = compute();
  if (claudeTitleCache.size > CLAUDE_TITLE_CACHE_MAX_ENTRIES) claudeTitleCache.clear();
  claudeTitleCache.set(filePath, { mtimeMs, size, title });
  return title;
}

export function listResumableSessions(cwd: string): Array<{ id: string; title: string; cwd: string; mtimeMs: number; agent: string; resumeCommand: string }> {
  const MAX_SESSIONS = 40;

  const parseTitle = (filePath: string, size: number, mtimeMs: number, uuid: string): string =>
    getCachedClaudeTitle(filePath, mtimeMs, size, () => {
      try {
        // Head read: first-real-user-message fallback + legacy rename marker.
        const head = readHead(filePath);
        let firstUserTitle = '';
        let renameTitle = '';
        for (const line of head.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: { type?: string; message?: { content?: unknown } };
          try { obj = JSON.parse(trimmed); } catch { continue; }
          if (obj.type === 'user' && typeof obj.message?.content === 'string') {
            const r = extractRenameTitle(obj.message.content);
            if (r) renameTitle = r;
            if (!firstUserTitle) {
              const cleaned = cleanSessionTitle(obj.message.content);
              if (isRealUserPrompt(cleaned)) firstUserTitle = cleaned;
            }
          }
        }
        // Title-type lines (customTitle/agentName/aiTitle) can appear far into the file, beyond
        // the head window. Scan the whole file (or tail for huge files) to recover them.
        const titleFields = findClaudeTitleFields(filePath, size);
        return resolveClaudeTitle(titleFields, firstUserTitle, renameTitle, uuid);
      } catch { /* ignore, fall through to uuid */ }
      return uuid;
    });

  try {
    const abs = path.resolve(String(cwd || ''));
    if (!abs) return [];
    const encoded = abs.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) return null;
          return { name, full, size: st.size, mtimeMs: st.mtimeMs };
        } catch { return null; }
      })
      .filter((e): e is { name: string; full: string; size: number; mtimeMs: number } => e !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SESSIONS);

    const claudeList = entries.map((e) => {
      const uuid = e.name.replace(/\.jsonl$/, '');
      return {
        id: uuid,
        title: parseTitle(e.full, e.size, e.mtimeMs, uuid),
        cwd: abs,
        mtimeMs: e.mtimeMs,
        agent: 'claude' as const,
        resumeCommand: `claude --resume ${uuid}`,
      };
    });

    const codexList = listCodexSessions(abs);

    return [...claudeList, ...codexList]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}
