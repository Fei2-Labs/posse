const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const controller = source('src/main/browser-controller.ts');
const main = source('src/main/index.ts');
const preload = source('src/preload/index.ts');
const renderer = source('src/renderer/app.ts');
const html = source('src/renderer/index.html');

test('uses a persistent isolated WebContentsView profile', () => {
  assert.match(controller, /new WebContentsView\(\{ webPreferences: browserWebPreferences\(\) \}\)/);
  assert.match(controller, /persist:posse-browser-default/);
  assert.match(controller, /nodeIntegration: false/);
  assert.match(controller, /contextIsolation: true/);
  assert.match(controller, /sandbox: true/);
  assert.match(controller, /webSecurity: true/);
  assert.match(controller, /webviewTag: false/);
  assert.doesNotMatch(html, /<webview\b/i);
});

test('validates browser IPC against the sending BrowserWindow', () => {
  const browserIpcStart = main.indexOf("ipcMain.on('browser:set-bounds'");
  const browserIpcEnd = main.indexOf('// ========== Status-dot', browserIpcStart);
  const browserIpc = main.slice(browserIpcStart, browserIpcEnd);
  assert.match(main, /const owner = BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.doesNotMatch(browserIpc, /\|\|\s*mainWindow/);
  assert.match(browserIpc, /Number\.isFinite/);
  assert.match(browserIpc, /typeof input !== 'string'/);
});

test('exposes only narrow browser commands through preload', () => {
  assert.match(preload, /browserSetBounds: \(bounds:/);
  assert.match(preload, /browserNavigate: \(input: string\)/);
  assert.match(preload, /browserResolvePermission: \(requestId: string, allow: boolean\)/);
  assert.doesNotMatch(preload, /webContents/);
});

test('gates permissions, popups, downloads, and global profile clearing', () => {
  assert.match(controller, /setPermissionCheckHandler/);
  assert.match(controller, /setPermissionRequestHandler/);
  assert.match(controller, /ALLOWED_PERMISSIONS/);
  assert.match(controller, /setWindowOpenHandler/);
  assert.match(controller, /registerBrowserContents\(popup\.webContents, this\)/);
  assert.match(controller, /this\.popups\.add\(popup\)/);
  assert.match(controller, /setSaveDialogOptions/);
  assert.match(controller, /clearStorageData/);
  assert.match(controller, /clearCache/);
  assert.match(controller, /clearAuthCache/);
});

test('mounts the browser as an expandable Inspector tab and hides it under overlays', () => {
  assert.match(html, /id="inspector-browser-tab"/);
  assert.match(html, /id="browser-viewport"/);
  assert.match(renderer, /fileTreePanel\.classList\.toggle\('browser-expanded'/);
  assert.match(renderer, /browserOverlayOpen/);
  assert.match(renderer, /MutationObserver/);
  assert.match(renderer, /settings-dialog__overlay/);
  assert.match(renderer, /newSessionOverlay\.classList\.contains\('active'\)/);
  assert.match(renderer, /window\.posse\.browserSetBounds/);
  assert.match(renderer, /browserRetryBtn\.addEventListener\('click', async/);
  assert.match(renderer, /window\.posse\.browserNavigate\(input\)/);
});
