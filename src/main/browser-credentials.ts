import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 512 * 1024;
const RBW_TIMEOUT_MS = 8_000;

export type CredentialErrorCode =
  | 'missing' | 'not-configured' | 'locked' | 'auth-failed' | 'timeout'
  | 'no-match' | 'multiple-match' | 'invalid-output' | 'failed';

export type CredentialFailure = { ok: false; code: CredentialErrorCode };

export type RbwEntryMetadata = {
  id: string;
  name: string;
  username?: string;
  folder?: string;
  uris: string[];
  type: string;
};

export type RbwLoginSecret = {
  id: string;
  username?: string;
  password: string;
};

export type CredentialCandidate = {
  id: string;
  name: string;
  username?: string;
  folder?: string;
  match: 'exact-origin' | 'same-host';
};

export type CredentialResult<T> = { ok: true; value: T } | CredentialFailure;

function classifyFailure(error: unknown): CredentialErrorCode {
  const value = error as { code?: string; killed?: boolean; signal?: string; stderr?: string };
  const stderr = typeof value.stderr === 'string' ? value.stderr.toLowerCase() : '';
  if (value.code === 'ENOENT') return 'missing';
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'invalid-output';
  if (value.killed || value.signal === 'SIGTERM') return 'timeout';
  if (stderr.includes('locked') || stderr.includes('unlock')) return 'locked';
  if (stderr.includes('not configured') || stderr.includes('config')) return 'not-configured';
  if (stderr.includes('auth') || stderr.includes('credential')) return 'auth-failed';
  return 'failed';
}

export function findRbwExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    ...(env.PATH || '').split(delimiter).filter(Boolean).map((entry) => `${entry}/rbw`),
    '/opt/homebrew/bin/rbw',
    '/usr/local/bin/rbw',
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch { /* try the next stable location */ }
  }
  return null;
}

async function runRbw(args: string[], executable = findRbwExecutable()): Promise<CredentialResult<string>> {
  if (!executable) return { ok: false, code: 'missing' };
  try {
    const result = await execFileAsync(executable, args, {
      shell: false,
      timeout: RBW_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '',
        LANG: 'C',
      },
      encoding: 'utf8',
    });
    return { ok: true, value: result.stdout };
  } catch (error) {
    return { ok: false, code: classifyFailure(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRbwList(raw: string): CredentialResult<RbwEntryMetadata[]> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 2_000) return { ok: false, code: 'invalid-output' };
    const entries: RbwEntryMetadata[] = [];
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
        return { ok: false, code: 'invalid-output' };
      }
      if (item.uris !== null && item.uris !== undefined && !Array.isArray(item.uris)) {
        return { ok: false, code: 'invalid-output' };
      }
      const rawUris = Array.isArray(item.uris) ? item.uris : [];
      const uris = rawUris.filter((uri): uri is string => typeof uri === 'string');
      if (uris.length !== rawUris.length || uris.length > 100) return { ok: false, code: 'invalid-output' };
      entries.push({
        id: item.id,
        name: item.name,
        username: typeof item.user === 'string' ? item.user : undefined,
        folder: typeof item.folder === 'string' ? item.folder : undefined,
        uris,
        type: typeof item.type === 'string' ? item.type.toLowerCase() : 'login',
      });
    }
    return { ok: true, value: entries };
  } catch {
    return { ok: false, code: 'invalid-output' };
  }
}

function originAndHost(value: string): { origin: string; host: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return { origin: url.origin, host: url.hostname.toLowerCase() };
  } catch { return null; }
}

export function matchRbwEntries(entries: RbwEntryMetadata[], pageUrl: string): CredentialResult<CredentialCandidate[]> {
  const page = originAndHost(pageUrl);
  if (!page) return { ok: false, code: 'no-match' };
  const candidates: CredentialCandidate[] = [];
  for (const entry of entries) {
    if (entry.type !== 'login') continue;
    let best: CredentialCandidate['match'] | null = null;
    for (const uri of entry.uris) {
      const target = originAndHost(uri);
      if (!target || target.host !== page.host) continue;
      if (target.origin === page.origin) best = 'exact-origin';
      else if (!best) best = 'same-host';
    }
    if (best) candidates.push({ id: entry.id, name: entry.name, username: entry.username, folder: entry.folder, match: best });
  }
  candidates.sort((a, b) => Number(b.match === 'exact-origin') - Number(a.match === 'exact-origin') || a.name.localeCompare(b.name));
  return candidates.length ? { ok: true, value: candidates } : { ok: false, code: 'no-match' };
}

export function parseRbwLogin(raw: string, expectedId: string): CredentialResult<RbwLoginSecret> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.id !== expectedId) {
      return { ok: false, code: 'invalid-output' };
    }
    const login = isRecord(value.data) ? value.data : value.login;
    if (!isRecord(login) || typeof login.password !== 'string') return { ok: false, code: 'invalid-output' };
    return {
      ok: true,
      value: { id: expectedId, username: typeof login.username === 'string' ? login.username : undefined, password: login.password },
    };
  } catch { return { ok: false, code: 'invalid-output' }; }
}

export async function listRbwCredentials(): Promise<CredentialResult<RbwEntryMetadata[]>> {
  const result = await runRbw(['list', '--raw']);
  return result.ok ? parseRbwList(result.value) : result;
}

export async function getRbwLogin(id: string): Promise<CredentialResult<RbwLoginSecret>> {
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return { ok: false, code: 'invalid-output' };
  const result = await runRbw(['get', id, '--raw']);
  return result.ok ? parseRbwLogin(result.value, id) : result;
}

export async function getRbwTotp(id: string): Promise<CredentialResult<string>> {
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return { ok: false, code: 'invalid-output' };
  const result = await runRbw(['code', id]);
  if (!result.ok) return result;
  const code = result.value.trim();
  return /^\d{6,8}$/.test(code) ? { ok: true, value: code } : { ok: false, code: 'invalid-output' };
}
