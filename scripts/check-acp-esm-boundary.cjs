const fs = require('node:fs');
const packageJson = require('../package.json');

const compiledPath = 'dist/main/acp-client.js';
const compiled = fs.readFileSync(compiledPath, 'utf8');
const synchronousSdkRequire = /require\(["']@agentclientprotocol\/sdk["']\)/;

if (synchronousSdkRequire.test(compiled)) {
  console.error(`${compiledPath} synchronously requires the ESM-only ACP SDK`);
  process.exit(1);
}

if (!compiled.includes('return import(specifier)')) {
  console.error(`${compiledPath} does not retain the native dynamic import boundary`);
  process.exit(1);
}

if (!packageJson.dependencies?.zod) {
  console.error('zod must be a direct production dependency for the packaged ACP SDK');
  process.exit(1);
}

console.log('ACP SDK packaging boundary is valid');
