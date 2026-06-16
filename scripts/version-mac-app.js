const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release', 'mac-arm64');
const appName = 'DuoCLI';
const sourceApp = path.join(releaseDir, `${appName}.app`);
const applicationsDirs = ['/Applications'];
const legacyVersionedReleaseApp = path.join(releaseDir, `${appName}-${version}.app`);
const legacyVersionedInstalledApps = [
  path.join('/Applications', `${appName}-${version}.app`),
  path.join(os.homedir(), 'Applications', `${appName}.app`),
  path.join(os.homedir(), 'Applications', `${appName}-${version}.app`),
];

if (!fs.existsSync(sourceApp)) {
  throw new Error(`Source app bundle not found: ${sourceApp}`);
}

if (fs.existsSync(legacyVersionedReleaseApp)) {
  fs.rmSync(legacyVersionedReleaseApp, { recursive: true, force: true });
}

for (const installedApp of legacyVersionedInstalledApps) {
  if (fs.existsSync(installedApp)) {
    fs.rmSync(installedApp, { recursive: true, force: true });
  }
}

for (const applicationsDir of applicationsDirs) {
  const installedApp = path.join(applicationsDir, `${appName}.app`);
  try {
    if (fs.existsSync(installedApp)) {
      fs.rmSync(installedApp, { recursive: true, force: true });
    }
    execFileSync('ditto', [sourceApp, installedApp], { stdio: 'inherit' });
    console.log(`Installed mac app bundle: ${installedApp}`);
  } catch (error) {
    console.warn(`Could not install app bundle to ${installedApp}: ${error.message}`);
  }
}
