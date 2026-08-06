const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { gitStatus, gitDiff, gitDiffUntracked } = require('../dist/main/git-inspector.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-git-inspector-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('gitStatus: branch + clean tree', async () => {
  const repo = makeRepo();
  const res = await gitStatus(repo);
  assert.equal(res.ok, true);
  assert.ok(res.branch, 'branch reported');
  assert.equal(res.files.length, 0);
});

test('gitStatus: groups staged/unstaged/untracked', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n'); // unstaged M
  fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');         // untracked ??
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  git(repo, 'add', 'staged.txt');                                  // staged A
  const res = await gitStatus(repo);
  assert.equal(res.ok, true);
  const byGroup = {};
  for (const f of res.files) (byGroup[f.group] ||= []).push(f.path);
  assert.deepEqual(byGroup.unstaged, ['tracked.txt']);
  assert.deepEqual(byGroup.untracked, ['new.txt']);
  assert.deepEqual(byGroup.staged, ['staged.txt']);
});

test('gitStatus: not a repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-not-repo-'));
  const res = await gitStatus(dir);
  assert.equal(res.ok, false);
  assert.equal(res.notARepo, true);
});

test('gitDiff: unstaged change has +/- lines', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
  const res = await gitDiff(repo, 'tracked.txt', false);
  assert.equal(res.ok, true);
  assert.match(res.diff, /^\+two$/m);
  assert.equal(res.truncated, false);
});

test('gitDiff: staged uses --cached', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
  git(repo, 'add', 'tracked.txt');
  const unstaged = await gitDiff(repo, 'tracked.txt', false);
  assert.equal(unstaged.diff, '');
  const staged = await gitDiff(repo, 'tracked.txt', true);
  assert.match(staged.diff, /^\+two$/m);
});

test('gitDiffUntracked: renders all-add diff', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'hello\n');
  const res = await gitDiffUntracked(repo, 'brand-new.txt');
  assert.equal(res.ok, true);
  assert.match(res.diff, /^\+hello$/m);
});

test('gitDiffUntracked: rejects path escape', async () => {
  const repo = makeRepo();
  const res = await gitDiffUntracked(repo, '../../etc/passwd');
  assert.equal(res.ok, false);
});
