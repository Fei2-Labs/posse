// Generates src/main/build-stamp.json with git + time identity for the current build.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; }
}

const stamp = {
  sha: sh('git rev-parse --short HEAD') || 'nogit',
  branch: sh('git rev-parse --abbrev-ref HEAD') || 'unknown',
  dirty: sh('git status --porcelain').length > 0,
  builtAt: new Date().toISOString(),
};

const out = path.join(__dirname, '..', 'src', 'main', 'build-stamp.json');
fs.writeFileSync(out, JSON.stringify(stamp, null, 2) + '\n');
console.log('[build-stamp]', stamp.sha, stamp.dirty ? '(dirty)' : '', stamp.builtAt);
