/**
 * git-inspector.ts — read-only Git status/diff service for the workspace inspector (Phase 4
 * of the workspace UX redesign). Uses the system `git` binary with argument arrays (never a
 * shell), only read-only subcommands, bounded output, and structured errors. Mutation is
 * intentionally impossible here: the only commands are `status`, `diff`, `rev-parse`,
 * `log` — commits/branches/stash/conflict resolution stay in the terminal (terminal-first).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';

const GIT_TIMEOUT_MS = 10_000;
const MAX_DIFF_BYTES = 200 * 1024; // 200KB cap per diff; truncated flag set when exceeded

export interface GitStatusFile {
  /** Repo-relative path. */
  path: string;
  /** 'staged' | 'unstaged' | 'untracked' | 'conflicted' */
  group: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
  /** Single-letter XY status (e.g. 'M', 'A', 'D', 'R', '??'). */
  code: string;
  /** For renames: the original path. */
  oldPath?: string;
}

export interface GitStatusResult {
  ok: boolean;
  error?: string;
  /** True when rootPath is not inside a git work tree. */
  notARepo?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files?: GitStatusFile[];
}

export interface GitDiffResult {
  ok: boolean;
  error?: string;
  notARepo?: boolean;
  diff?: string;
  truncated?: boolean;
}

function runGit(root: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code });
      },
    );
  });
}

function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** Parse `git status --porcelain=v1 -b` output into structured status. */
function parseStatusPorcelain(text: string): Omit<GitStatusResult, 'ok'> {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const out: Omit<GitStatusResult, 'ok'> = { files: [] };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      const m = header.match(/^([^ .]+(?:\.[^ .]+)*)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
      if (m) {
        out.branch = m[2] ? m[1] : `(no branch: ${m[1]})`;
        out.ahead = m[3] ? parseInt(m[3], 10) : 0;
        out.behind = m[4] ? parseInt(m[4], 10) : 0;
      }
      continue;
    }
    const x = line[0];
    const y = line[1];
    const filePart = line.slice(3);
    let filePath = filePart;
    let oldPath: string | undefined;
    const renameIdx = filePart.indexOf(' -> ');
    if (renameIdx >= 0) {
      oldPath = filePart.slice(0, renameIdx);
      filePath = filePart.slice(renameIdx + 4);
    }
    let group: GitStatusFile['group'];
    if (x === '?' && y === '?') group = 'untracked';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) group = 'conflicted';
    else if (x !== ' ' && x !== '?') group = 'staged';
    else group = 'unstaged';
    out.files!.push({ path: filePath, group, code: (x + y).trim(), oldPath });
  }
  return out;
}

/** Read-only repo status for the inspector. Never throws. */
export async function gitStatus(rootPath: string): Promise<GitStatusResult> {
  try {
    const root = path.resolve(String(rootPath || ''));
    if (!root) return { ok: false, error: 'root path is required' };
    const { stdout, stderr, code } = await runGit(root, ['status', '--porcelain=v1', '-b']);
    if (code !== 0) {
      if (isNotARepo(stderr)) return { ok: false, notARepo: true, error: 'not a git repository' };
      return { ok: false, error: stderr.trim() || `git status exited ${code}` };
    }
    return { ok: true, ...parseStatusPorcelain(stdout) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Bounded diff for one file (or the whole repo when relPath omitted). Never throws. */
export async function gitDiff(rootPath: string, relPath?: string, staged = false): Promise<GitDiffResult> {
  try {
    const root = path.resolve(String(rootPath || ''));
    if (!root) return { ok: false, error: 'root path is required' };
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (staged) args.push('--cached');
    args.push('--');
    if (relPath) args.push(relPath);
    const { stdout, stderr, code } = await runGit(root, args, MAX_DIFF_BYTES + 64 * 1024);
    if (code !== 0) {
      if (isNotARepo(stderr)) return { ok: false, notARepo: true, error: 'not a git repository' };
      return { ok: false, error: stderr.trim() || `git diff exited ${code}` };
    }
    const buf = Buffer.from(stdout, 'utf-8');
    if (buf.length > MAX_DIFF_BYTES) {
      return { ok: true, diff: buf.subarray(0, MAX_DIFF_BYTES).toString('utf-8'), truncated: true };
    }
    return { ok: true, diff: stdout, truncated: false };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Untracked files have no `git diff` — show them as an all-add diff via --no-index. */
export async function gitDiffUntracked(rootPath: string, relPath: string): Promise<GitDiffResult> {
  try {
    const root = path.resolve(String(rootPath || ''));
    const abs = path.resolve(root, relPath);
    if (!abs.startsWith(root + path.sep)) return { ok: false, error: 'invalid-path' };
    const { stdout, code } = await runGit(root, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', abs], MAX_DIFF_BYTES + 64 * 1024);
    // --no-index exits 1 when files differ — that is the success case here.
    if (code !== 0 && code !== 1) return { ok: false, error: `git diff --no-index exited ${code}` };
    const buf = Buffer.from(stdout, 'utf-8');
    if (buf.length > MAX_DIFF_BYTES) {
      return { ok: true, diff: buf.subarray(0, MAX_DIFF_BYTES).toString('utf-8'), truncated: true };
    }
    return { ok: true, diff: stdout, truncated: false };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
