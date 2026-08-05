const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'mobile/client/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'mobile/client/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'mobile/client/sw.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/main/remote-server.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');

test('mobile session list exposes a combined versioned contract without removing legacy clients', () => {
  assert.match(server, /app\.get\('\/api\/session-list'/);
  assert.match(server, /event: session-list/);
  assert.match(server, /event: sessions/);
  assert.match(main, /listResumableSessions, loadClosedSessions/);
});

test('mobile renders loading and actionable error states', () => {
  assert.match(html, /id="session-state-title"/);
  assert.match(html, /id="session-retry-btn"/);
  assert.match(app, /renderSessionListState\('error'/);
  assert.match(app, /refreshSessions\(\{ fresh: true \}\)/);
});

test('mobile boot has one authenticated entry path and cache versions stay aligned', () => {
  assert.doesNotMatch(app, /api\('\/api\/sessions'\)\.then\(\(\) => enterMain\(\)\)/);
  const clientBuild = app.match(/CLIENT_BUILD = '([^']+)'/)?.[1];
  const cacheName = sw.match(/CACHE_NAME = '([^']+)'/)?.[1];
  assert.equal(clientBuild, cacheName);
  assert.match(sw, /session-list-helpers\.js/);
});
