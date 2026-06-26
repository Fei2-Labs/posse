const { execSync } = require('child_process');
const ver = execSync('node scripts/derive-version.js', { encoding: 'utf8' }).trim();
console.log(`[build:win] version ${ver}`);
execSync(`electron-builder --win --config.extraMetadata.version=${ver} --config.npmRebuild=false`, { stdio: 'inherit' });
