const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  bucketPathsByCanonicalRoot,
  resolveGitProjectRoot,
  resolveGitProjectRoots,
} = require('../dist/main/git-project-root.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function normalizedRealpath(value) {
  return fs.realpathSync(value).replace(/^\/private(?=\/)/, '');
}

test('canonicalizes linked worktrees without changing unrelated paths', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse worktree roots '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const main = path.join(temp, 'normal checkout');
  const linked = path.join(temp, 'agent worktrees', 'generated name');
  const nonGit = path.join(temp, 'plain folder');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.mkdirSync(nonGit);
  git(main, 'init');
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(main, 'README.md'), 'test\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-m', 'initial');
  git(main, 'worktree', 'add', '-b', 'agent-test', linked);
  const nested = path.join(linked, 'nested', 'cwd');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(await resolveGitProjectRoot(main), normalizedRealpath(main));
  assert.equal(await resolveGitProjectRoot(linked), normalizedRealpath(main));
  assert.equal(await resolveGitProjectRoot(nested), normalizedRealpath(main));
  assert.equal(await resolveGitProjectRoot(nonGit), normalizedRealpath(nonGit));

  const resolved = await resolveGitProjectRoots([main, linked, nested, nonGit]);
  const buckets = bucketPathsByCanonicalRoot([main, linked, nested, nonGit], resolved);
  const repoBucket = buckets.find((bucket) => bucket.path === normalizedRealpath(main));
  assert.ok(repoBucket);
  assert.deepEqual(new Set(repoBucket.aliases), new Set([main, linked, nested]));
  assert.equal(buckets.length, 2);
});

test('keeps separate clones of the same repository separate', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse clone roots '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const cloneA = path.join(temp, 'clone a');
  const cloneB = path.join(temp, 'clone b');
  fs.mkdirSync(source);
  git(source, 'init');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(source, 'file.txt'), 'test\n');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-m', 'initial');
  execFileSync('git', ['clone', source, cloneA]);
  execFileSync('git', ['clone', source, cloneB]);

  assert.equal(await resolveGitProjectRoot(cloneA), normalizedRealpath(cloneA));
  assert.equal(await resolveGitProjectRoot(cloneB), normalizedRealpath(cloneB));
  assert.notEqual(await resolveGitProjectRoot(cloneA), await resolveGitProjectRoot(cloneB));
});

test('ignores inherited Git repository-selection overrides', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse git env '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const plain = path.join(temp, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, 'init');

  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(repo, '.git');
  try {
    assert.equal(await resolveGitProjectRoot(plain), normalizedRealpath(plain));
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
});
