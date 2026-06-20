// build-remote-bundle.js
//
// Assembles release/remote-bundle/ — the clean rsync SOURCE for posse-remote-bootstrap.sh.
// Runs AFTER build:headless (which produces dist/main/headless.js + the rest of dist/main).
//
// The bundle contains exactly what the bootstrap script rsyncs to ~/.posse-agent/<version>/:
//   - dist/                 (headless backend, built by build:headless)
//   - mobile/client/        (PWA assets; remote-server serves these as __dirname/../../mobile/client)
//   - package.json          (so `npm install --omit=dev` installs runtime deps on the remote)
//   - package-lock.json     (reproducible install)
//
// Defining a dedicated bundle dir decouples deployment from the dev working-tree layout.
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const out = path.join(repo, 'release', 'remote-bundle');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`missing source dir: ${src} (did build:headless run?)`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`missing source file: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.error('[remote-bundle] assembling', out);
rmrf(out);
fs.mkdirSync(out, { recursive: true });

copyDir(path.join(repo, 'dist'), path.join(out, 'dist'));
copyDir(path.join(repo, 'mobile', 'client'), path.join(out, 'mobile', 'client'));
copyFile(path.join(repo, 'package.json'), path.join(out, 'package.json'));
const lock = path.join(repo, 'package-lock.json');
if (fs.existsSync(lock)) copyFile(lock, path.join(out, 'package-lock.json'));

// Sanity: prove the headless entry the bootstrap launches actually exists.
const headless = path.join(out, 'dist', 'main', 'headless.js');
if (!fs.existsSync(headless)) throw new Error(`bundle missing dist/main/headless.js — run build:headless first`);

console.error('[remote-bundle] done:', out);
console.error('[remote-bundle]   dist/main/headless.js  ✓');
console.error('[remote-bundle]   mobile/client/         ✓');
console.error('[remote-bundle]   package.json           ✓');
if (fs.existsSync(path.join(out, 'package-lock.json'))) {
  console.error('[remote-bundle]   package-lock.json      ✓');
}
