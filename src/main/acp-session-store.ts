// ACP session metadata persistence.
//
// The desktop records closed PTY sessions into closed-sessions.json (Electron
// userData). ACP sessions have no equivalent — they vanish when the adapter
// process exits, so a mobile client that backgrounded the app loses the only
// handle (the ACP sessionId) needed to resume. This store mirrors that pattern
// for ACP: a JSON file under the remote-server's ~/.posse-mobile config dir
// (shared by both the Electron and headless backends) records enough to
// reconnect: the agent label, cwd, preset command, and the agent-side
// sessionId that session/load needs.
//
// The store is best-effort: reads tolerate missing/corrupt files, writes are
// atomic-rename, and entries age out after 7 days (same cutoff as PTY
// closed-sessions.json). It is NOT a conversation transcript — only the
// metadata needed to relaunch the adapter.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AcpStoredSession {
  id: string;            // posse session id (the renderer/mobile key)
  acpSessionId: string;  // agent-side sessionId (what session/load needs)
  agentLabel: string;
  cwd: string;
  presetCommand: string; // canonical ACP preset (e.g. "claude --dangerously-skip-permissions")
  title: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;     // set when the session closes; entries past cutoff are pruned
}

const STORE_DIR = path.join(process.env.HOME || os.homedir(), '.posse-mobile');
const STORE_FILE = path.join(STORE_DIR, 'acp-sessions.json');
const MAX_STORED_SESSIONS = 40;
const CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

function readStore(): AcpStoredSession[] {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as AcpStoredSession[] : [];
  } catch {
    return [];
  }
}

function writeStore(sessions: AcpStoredSession[]): void {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch {
    // best-effort: a failed write must not crash the adapter loop
  }
}

function pruneOld(sessions: AcpStoredSession[]): AcpStoredSession[] {
  const cutoff = Date.now() - CUTOFF_MS;
  return sessions
    .filter(s => (s.closedAt ?? s.updatedAt) > cutoff)
    .slice(-MAX_STORED_SESSIONS);
}

/** Upsert an ACP session record (called on create/load and status changes). */
export function upsertAcpSession(session: AcpStoredSession): AcpStoredSession[] {
  const sessions = readStore().filter(s => s.acpSessionId !== session.acpSessionId || s.id === session.id);
  const existingIdx = sessions.findIndex(s => s.id === session.id);
  const record: AcpStoredSession = {
    ...session,
    updatedAt: session.updatedAt || Date.now(),
  };
  if (existingIdx >= 0) {
    sessions[existingIdx] = { ...sessions[existingIdx], ...record };
  } else {
    sessions.push({ ...record, createdAt: record.createdAt || Date.now() });
  }
  const pruned = pruneOld(sessions);
  writeStore(pruned);
  return pruned;
}

/** Mark a session closed (keeps the record for the recent list until it ages out). */
export function closeAcpSession(id: string): AcpStoredSession[] {
  const sessions = readStore();
  const idx = sessions.findIndex(s => s.id === id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], closedAt: Date.now(), updatedAt: Date.now() };
  }
  const pruned = pruneOld(sessions);
  writeStore(pruned);
  return pruned;
}

/** Remove a session record entirely (used when the user deletes a session). */
export function removeAcpSession(id: string): AcpStoredSession[] {
  const sessions = readStore().filter(s => s.id !== id);
  writeStore(sessions);
  return sessions;
}

/** Read all stored ACP sessions (most-recent first). */
export function listAcpSessions(): AcpStoredSession[] {
  return pruneOld(readStore())
    .sort((a, b) => (b.updatedAt) - (a.updatedAt));
}
