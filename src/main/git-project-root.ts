import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export type GitProjectRootResult = {
  cwd: string;
  canonicalPath: string;
};

export type CanonicalProjectPathChoice = {
  inputPath: string;
  gitCanonicalPath: string;
  explicitFallback?: ExplicitProjectPathMapping;
  /** @deprecated Use explicitFallback for mappings that carry provenance. */
  explicitFallbackPath?: string;
  inputExists: boolean;
};

export type ExplicitProjectPathMapping = {
  canonicalPath: string;
  /** Only collection-container metadata may opt an existing non-Git path into fallback. */
  allowExistingNonGit?: boolean;
};

export type CopilotCollectionBindingRow = {
  workspace_id?: unknown;
  container_kind?: unknown;
  main_repo_path?: unknown;
  checkout_path?: unknown;
};

export type EphemeralCopilotHistoryPathChoice = {
  cwd: string;
  agent: string;
  inputExists: boolean;
  hasExplicitMapping: boolean;
  tempRoot: string;
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

/**
 * Git remains authoritative for paths that still exist. Explicit provider
 * metadata may identify a deleted checkout after Git can no longer inspect it.
 */
export function chooseCanonicalProjectPath(choice: CanonicalProjectPathChoice): string {
  const normalizedInput = path.resolve(choice.inputPath);
  const normalizedGitResult = path.resolve(choice.gitCanonicalPath || choice.inputPath);
  const gitResolvedInputUnchanged = process.platform === 'win32'
    ? normalizedGitResult.toLowerCase() === normalizedInput.toLowerCase()
    : normalizedGitResult === normalizedInput;
  const explicitFallback = choice.explicitFallback || (
    choice.explicitFallbackPath
      ? { canonicalPath: choice.explicitFallbackPath }
      : undefined
  );
  const existingNonGitCollection = choice.inputExists
    && explicitFallback?.allowExistingNonGit === true
    && gitResolvedInputUnchanged;
  if ((!existingNonGitCollection && choice.inputExists) || !explicitFallback || !gitResolvedInputUnchanged) {
    return choice.gitCanonicalPath || choice.inputPath;
  }
  return explicitFallback.canonicalPath;
}

/**
 * Apply the same Git-first fallback pipeline to every source of project paths.
 * The caller supplies existence checks so this helper remains deterministic in
 * tests and usable by the main-process project builder.
 */
export function applyExplicitProjectPathFallbacks(
  resolved: GitProjectRootResult[],
  explicitFallbacks: ReadonlyMap<string, string | ExplicitProjectPathMapping>,
  inputExists: (inputPath: string) => boolean,
): GitProjectRootResult[] {
  const toMapping = (value: string | ExplicitProjectPathMapping | undefined): ExplicitProjectPathMapping | undefined =>
    typeof value === 'string' ? { canonicalPath: value } : value;
  return resolved.map((item) => ({
    cwd: item.cwd,
    canonicalPath: chooseCanonicalProjectPath({
      inputPath: item.cwd,
      gitCanonicalPath: item.canonicalPath,
      explicitFallback: toMapping(explicitFallbacks.get(item.cwd)),
      inputExists: inputExists(item.cwd),
    }),
  }));
}

function pathEquals(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isStrictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function commonPath(paths: string[]): string {
  if (paths.length === 0) return '';
  let candidate = path.dirname(path.resolve(paths[0]));
  for (const value of paths.slice(1)) {
    const resolved = path.resolve(value);
    while (!pathEquals(candidate, path.parse(candidate).root) && !isStrictDescendant(candidate, resolved)) {
      candidate = path.dirname(candidate);
    }
    if (!isStrictDescendant(candidate, resolved)) return '';
  }
  return candidate;
}

function pathDepth(value: string): number {
  const resolved = path.resolve(value);
  const relative = path.relative(path.parse(resolved).root, resolved);
  return relative.split(path.sep).filter(Boolean).length;
}

/**
 * Collection workspaces have multiple sibling child checkouts. Their common,
 * immediate parent is the workspace container and may safely map to the
 * collection project's registered root even though the container itself exists.
 */
export function deriveCopilotCollectionProjectMappings(
  rows: CopilotCollectionBindingRow[],
): Map<string, ExplicitProjectPathMapping> {
  const grouped = new Map<string, { mainRepoPath: string; checkoutPaths: Set<string> }>();
  for (const row of rows) {
    const workspaceId = typeof row.workspace_id === 'string' ? row.workspace_id.trim() : '';
    const containerKind = typeof row.container_kind === 'string' ? row.container_kind.trim() : '';
    const mainRepoPath = typeof row.main_repo_path === 'string' ? row.main_repo_path.trim() : '';
    const checkoutPath = typeof row.checkout_path === 'string' ? row.checkout_path.trim() : '';
    if (!workspaceId || containerKind !== 'collection' || !mainRepoPath || !checkoutPath) continue;
    const key = `${workspaceId}\0${path.resolve(mainRepoPath)}`;
    let group = grouped.get(key);
    if (!group) {
      group = { mainRepoPath: path.resolve(mainRepoPath), checkoutPaths: new Set() };
      grouped.set(key, group);
    }
    group.checkoutPaths.add(path.resolve(checkoutPath));
  }

  const mappings = new Map<string, ExplicitProjectPathMapping>();
  for (const group of grouped.values()) {
    const checkoutPaths = Array.from(group.checkoutPaths);
    if (checkoutPaths.length < 2) continue;
    const container = commonPath(checkoutPaths);
    if (!container || pathDepth(container) < 2 || pathDepth(group.mainRepoPath) < 1) continue;
    // Requiring direct children prevents an unrelated broad ancestor from
    // becoming a collection mapping when binding rows are malformed.
    if (!checkoutPaths.every((checkout) =>
      isStrictDescendant(container, checkout) && pathEquals(path.dirname(checkout), container)
    )) continue;
    mappings.set(container, {
      canonicalPath: group.mainRepoPath,
      allowExistingNonGit: true,
    });
  }
  return mappings;
}

/** Narrow classification for stale, unmapped Copilot history under the host temp root. */
export function isStaleEphemeralCopilotHistoryPath(
  choice: EphemeralCopilotHistoryPathChoice,
): boolean {
  if (
    choice.agent !== 'copilot'
    || choice.inputExists
    || choice.hasExplicitMapping
    || !choice.cwd
    || !choice.tempRoot
  ) return false;
  return isStrictDescendant(choice.tempRoot, choice.cwd);
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
