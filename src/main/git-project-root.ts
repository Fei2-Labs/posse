import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export type GitProjectRootResult = {
  cwd: string;
  canonicalPath: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const cache = new Map<string, { value: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

async function normalizePath(input: string): Promise<string> {
  const absolute = path.resolve(input);
  let normalized: string;
  try {
    normalized = await fs.realpath(absolute);
  } catch {
    normalized = path.normalize(absolute);
  }
  // macOS may expose the same directory as both /var/... and /private/var/....
  if (process.platform === 'darwin' && normalized.startsWith('/private/')) {
    normalized = normalized.slice('/private'.length);
  }
  return normalized;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  // Repository-selection overrides from a parent shell must not make unrelated
  // session paths resolve as that shell's repository.
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', timeout: 2500, windowsHide: true, env },
      (error, stdout) => error ? reject(error) : resolve(String(stdout || '')),
    );
  });
}

async function resolveUncached(cwd: string): Promise<string> {
  let output: string;
  let absoluteOutput = true;
  try {
    output = await runGit(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--git-common-dir',
      '--is-bare-repository',
    ]);
  } catch {
    try {
      absoluteOutput = false;
      output = await runGit(cwd, [
        'rev-parse',
        '--git-dir',
        '--git-common-dir',
        '--is-bare-repository',
      ]);
    } catch {
      return cwd;
    }
  }

  const lines = output.trim().split(/\r?\n/);
  if (lines.length < 3) return cwd;
  const bare = lines[2].trim() === 'true';
  let commonDir = lines[1].trim();
  if (!commonDir) return cwd;
  if (!absoluteOutput || !path.isAbsolute(commonDir)) commonDir = path.resolve(cwd, commonDir);
  commonDir = await normalizePath(commonDir);

  // Bare repositories have no main checkout. Submodule common dirs live beneath
  // <super>/.git/modules and must not be folded into the superproject.
  const moduleMarker = `${path.sep}.git${path.sep}modules${path.sep}`;
  if (!bare && path.basename(commonDir) === '.git' && !commonDir.includes(moduleMarker)) {
    return normalizePath(path.dirname(commonDir));
  }

  // For submodules and unusual repository layouts, Git's own worktree root is
  // the safe display root. A bare repository simply remains at the input path.
  if (!bare) {
    try {
      const top = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
      if (top) return normalizePath(path.isAbsolute(top) ? top : path.resolve(cwd, top));
    } catch {
      // Fall through to the unchanged checkout cwd.
    }
  }
  return cwd;
}

function cacheValue(key: string, value: string): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Resolve a cwd to the main checkout of its linked-worktree repository. */
export async function resolveGitProjectRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '') return '';
  const cwd = await normalizePath(input.trim());
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(cwd);
    cache.set(cwd, cached);
    return cached.value;
  }
  if (cached) cache.delete(cwd);

  const existing = inFlight.get(cwd);
  if (existing) return existing;
  const pending = resolveUncached(cwd)
    .then((value) => {
      cacheValue(cwd, value);
      return value;
    })
    .finally(() => inFlight.delete(cwd));
  inFlight.set(cwd, pending);
  return pending;
}

/** Resolve distinct paths with bounded Git subprocess concurrency. */
export async function resolveGitProjectRoots(inputs: string[], concurrency = 6): Promise<GitProjectRootResult[]> {
  const distinct = Array.from(new Set(inputs.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())));
  const results = new Array<GitProjectRootResult>(distinct.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), distinct.length) }, async () => {
    while (cursor < distinct.length) {
      const index = cursor++;
      const cwd = distinct[index];
      results[index] = { cwd, canonicalPath: await resolveGitProjectRoot(cwd) };
    }
  });
  await Promise.all(workers);
  return results;
}

/** Pure bucketing seam used by project builders and regression tests. */
export function bucketPathsByCanonicalRoot(
  paths: string[],
  resolved: GitProjectRootResult[],
): Array<{ path: string; aliases: string[] }> {
  const canonicalByPath = new Map(resolved.map((item) => [item.cwd, item.canonicalPath]));
  const buckets = new Map<string, Set<string>>();
  for (const rawPath of paths) {
    if (!rawPath) continue;
    const canonicalPath = canonicalByPath.get(rawPath) || rawPath;
    let aliases = buckets.get(canonicalPath);
    if (!aliases) {
      aliases = new Set<string>();
      buckets.set(canonicalPath, aliases);
    }
    aliases.add(rawPath);
    aliases.add(canonicalPath);
  }
  return Array.from(buckets, ([projectPath, aliases]) => ({ path: projectPath, aliases: Array.from(aliases) }));
}
