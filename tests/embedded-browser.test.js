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
const sessionView = source('src/renderer/acp-session-view.ts');
const styles = source('src/renderer/styles.css');
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
  assert.match(preload, /browserOpenExternal: \(input\?: string\)/);
  assert.match(preload, /browserResolvePermission: \(requestId: string, allow: boolean\)/);
  assert.doesNotMatch(preload, /webContents/);
});

test('routes structured session links to the embedded or system browser', () => {
  assert.match(sessionView, /this\.messagesEl\.addEventListener\('click'/);
  assert.match(sessionView, /event\.ctrlKey \|\| event\.metaKey \? 'external' : 'embedded'/);
  assert.match(sessionView, /linkifyPlainUrls\(scope: HTMLElement, includeCode: boolean\)/);
  assert.match(sessionView, /private decorateMessageContent[\s\S]*this\.linkifyPlainUrls\(scope, true\)/);
  const patternLine = sessionView.split('\n').find((line) => line.includes('const urlPattern ='));
  const patternLiteral = patternLine?.match(/= (\/.*\/gi);$/)?.[1];
  assert.ok(patternLiteral, 'plain HTTP URL matcher should remain discoverable');
  const plainUrlPattern = Function(`"use strict"; return (${patternLiteral});`)();
  assert.deepEqual('Preview at `http://localhost:8000/`.'.match(plainUrlPattern), ['http://localhost:8000/']);
  assert.match(renderer, /if \(fileTreeCollapsed\) setInspectorCollapsed\(false\)/);
  assert.match(renderer, /setInspectorTab\('browser'\)/);
  assert.match(renderer, /window\.posse\.browserOpenExternal\(url\)/);
  assert.match(renderer, /await navigateEmbeddedBrowser\(url\)/);
  assert.match(controller, /normalizeBrowserUrl\(input \?\? this\.view\.webContents\.getURL\(\)\)/);
  assert.match(styles, /\.acp-thought-text a/);
  assert.match(styles, /\.acp-tool-content a/);
  assert.match(styles, /a:focus-visible/);
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

test('tears down browser ownership without touching destroyed webContents', () => {
  assert.match(controller, /this\.ownerContentsId = owner\.webContents\.id/);
  assert.match(controller, /ownerId\(\): number \{ return this\.ownerContentsId; \}/);
  assert.match(controller, /controllersByOwner = new WeakMap<BrowserWindow, EmbeddedBrowserController>/);
  assert.match(controller, /const controller = this\.controllersByOwner\.get\(owner\)/);
  assert.doesNotMatch(controller, /destroyFor\(owner: BrowserWindow\): void \{\s*const ownerId = owner\.webContents\.id/);
  assert.match(controller, /if \(!this\.owner\.isDestroyed\(\)\) \{/);
  assert.match(controller, /const popupContentsId = popup\.webContents\.id/);
  assert.match(controller, /unregisterBrowserContents\(popupContentsId\)/);
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

test('manual search is metadata-only and never retrieves secrets', () => {
  assert.match(controller, /searchRbwEntries/);
  assert.match(controller, /searchCredentialCandidates/);
  assert.match(controller, /Metadata-only manual search/);
  // Search must NOT call getRbwLogin or getRbwTotp (no secret retrieval for search).
  const searchFn = controller.slice(controller.indexOf('async searchCredentialCandidates'));
  const searchFnEnd = searchFn.indexOf('acknowledgeOffOrigin');
  const searchBody = searchFn.slice(0, searchFnEnd);
  assert.doesNotMatch(searchBody, /getRbwLogin/);
  assert.doesNotMatch(searchBody, /getRbwTotp/);
});

test('off-origin fills require explicit confirmation + main revalidation for login and TOTP', () => {
  // Both fillLogin and fillTotp gate on offItemOrigin && !acknowledged.
  const fillLoginFn = controller.slice(controller.indexOf('async fillLogin'), controller.indexOf('async fillTotp'));
  assert.match(fillLoginFn, /offItemOrigin && !target.acknowledged/);
  assert.match(fillLoginFn, /code: 'off-origin'/);
  const fillTotpFn = controller.slice(controller.indexOf('async fillTotp'), controller.indexOf('private resolveCredentialToken'));
  assert.match(fillTotpFn, /offItemOrigin && !target.acknowledged/);
  assert.match(fillTotpFn, /code: 'off-origin'/);
  // acknowledgeOffOrigin revalidates token + current origin before marking acknowledged.
  assert.match(controller, /acknowledgeOffOrigin\(token: string\)/);
  assert.match(controller, /target.acknowledged = true/);
  // Renderer confirms via confirmDangerDialog before acknowledging.
  assert.match(renderer, /confirmDangerDialog\([\s\S]*?Fill a login not listed for this origin/);
  assert.match(renderer, /browserCredentialAcknowledgeOffOrigin/);
});

test('credential tokens carry off-origin + display metadata and clear on navigation/relist', () => {
  // Token state extended with offItemOrigin + acknowledged + display metadata.
  assert.match(controller, /offItemOrigin: boolean/);
  assert.match(controller, /acknowledged: boolean/);
  // listCredentialCandidates + searchCredentialCandidates both invalidate prior tokens.
  const listFn = controller.slice(controller.indexOf('async listCredentialCandidates'), controller.indexOf('async searchCredentialCandidates'));
  assert.match(listFn, /this\.invalidateCredentialTokens\(\)/);
  const searchFn = controller.slice(controller.indexOf('async searchCredentialCandidates'), controller.indexOf('acknowledgeOffOrigin(token'));
  assert.match(searchFn, /this\.invalidateCredentialTokens\(\)/);
  // Navigation already invalidates (existing behavior preserved).
  assert.match(controller, /did-navigate[\s\S]*?invalidateCredentialTokens/);
});

test('persistent origin→item mapping stores only itemId/name/username — no secret, no token', () => {
  assert.match(controller, /credential-origin-mappings\.json/);
  assert.match(controller, /writeFileSync\(CREDENTIAL_MAPPINGS_FILE/);
  assert.match(controller, /readFileSync\(CREDENTIAL_MAPPINGS_FILE/);
  // The persisted mapping object pushed by rememberCredential must list only
  // origin/itemId/name/username — no token or password fields in the record.
  const rememberFn = controller.slice(controller.indexOf('rememberCredential(token: string)'), controller.indexOf('listCredentialMappings():'));
  const pushLine = rememberFn.match(/mappings\.push\(\{[^}]+\}\)/);
  assert.ok(pushLine, 'rememberCredential should push a mapping record');
  assert.doesNotMatch(pushLine[0], /token/i);
  assert.doesNotMatch(pushLine[0], /password/i);
  assert.match(pushLine[0], /itemId/);
  assert.match(pushLine[0], /name/);
  // loadCredentialMappings only copies origin/itemId/name/username fields.
  const loadFn = controller.slice(controller.indexOf('function loadCredentialMappings'), controller.indexOf('function saveCredentialMappings'));
  assert.match(loadFn, /origin: record\.origin/);
  assert.match(loadFn, /itemId: record\.itemId/);
  assert.doesNotMatch(loadFn, /record\.token/);
  assert.doesNotMatch(loadFn, /record\.password/);
  // Remember resolves the current token in main, not an itemId from the renderer.
  assert.match(controller, /rememberCredential\(token: string\)[\s\S]*?this\.credentialTokens\.get\(token\)/);
  // The IPC handler accepts only a token, never an itemId.
  assert.match(main, /browser:credential-remember'[\s\S]*?token: string/);
});

test('remembered mappings appear as candidates when applicable but still require off-origin confirmation', () => {
  // listCredentialCandidates surfaces a remembered mapping for the current origin.
  assert.match(controller, /loadCredentialMappings\(\)\.find\(\(mapping\) => mapping\.origin === origin\)/);
  // A remembered mapping that isn't already matched is added with offItemOrigin: true.
  assert.match(controller, /offItemOrigin: true, acknowledged: false,[\s\S]*?match: 'search'/);
});

test('renderer exposes search, remember, and mapping management through narrow preload surface', () => {
  assert.match(preload, /browserCredentialSearch: \(query: string\)/);
  assert.match(preload, /browserCredentialAcknowledgeOffOrigin: \(token: string\)/);
  assert.match(preload, /browserCredentialRemember: \(token: string\)/);
  assert.match(preload, /browserCredentialMappingsList:/);
  assert.match(preload, /browserCredentialMappingRemove: \(origin: string\)/);
  // Preload still never leaks webContents or internals.
  assert.doesNotMatch(preload, /webContents/);
  // Renderer uses confirmDangerDialog for off-origin warning + mapping delete
  // (no browser prompt/alert/confirm in the credential menu code).
  const credStart = renderer.indexOf('function credentialActionLabel');
  const credEnd = renderer.indexOf('function syncBrowserBounds');
  const credCode = renderer.slice(credStart, credEnd);
  assert.match(credCode, /confirmDangerDialog\([\s\S]*?Remove remembered mapping/);
  assert.doesNotMatch(credCode, /\balert\(/);
  assert.doesNotMatch(credCode, /\bconfirm\(/);
  assert.doesNotMatch(credCode, /\bprompt\(/);
});

test('search debounce and transient UI clear on navigation/profile reset', () => {
  assert.match(renderer, /credentialSearchTimer/);
  assert.match(renderer, /setTimeout[\s\S]*?150/);
  // Navigation clears transient UI.
  assert.match(renderer, /onBrowserState[\s\S]*?browserCredentialsSearch\.value = ''/);
  // Clear-profile clears the search + remembered section.
  const clearFn = renderer.slice(renderer.indexOf('browserClearBtn.addEventListener'), renderer.indexOf('browserCloseBtn.addEventListener'));
  assert.match(clearFn, /browserCredentialsSearch\.value = ''/);
  assert.match(clearFn, /browserCredentialsRemembered\.replaceChildren\(\)/);
});
