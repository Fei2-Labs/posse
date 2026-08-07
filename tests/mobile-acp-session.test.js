const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const acpClientSrc = fs.readFileSync(path.join(root, 'src/main/acp-client.ts'), 'utf8');
const remoteServerSrc = fs.readFileSync(path.join(root, 'src/main/remote-server.ts'), 'utf8');
const headlessSrc = fs.readFileSync(path.join(root, 'src/main/headless.ts'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'mobile/client/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'mobile/client/index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'mobile/client/sw.js'), 'utf8');
const acpHelpersSrc = fs.readFileSync(path.join(root, 'mobile/client/acp-helpers.js'), 'utf8');

// Load acp-helpers.js for functional tests (it's a UMD module)
const acpHelpersModule = { exports: {} };
const acpHelpersFactory = new Function('module', 'exports', acpHelpersSrc + '\nmodule.exports = PosseAcpHelpers || module.exports;');
acpHelpersFactory(acpHelpersModule, acpHelpersModule.exports);
const acpHelpers = acpHelpersModule.exports;

test('AcpManager exposes remote listener registration for mobile/headless consumers', () => {
  assert.match(acpClientSrc, /addRemoteListener/);
  assert.match(acpClientSrc, /removeRemoteListener/);
  assert.match(acpClientSrc, /interface AcpRemoteListener/);
  assert.match(acpClientSrc, /remoteListeners = new Set/);
  // The fan-out must call both the desktop handler and remote listeners
  assert.match(acpClientSrc, /listener\.onUpdate\(id, update\)/);
  assert.match(acpClientSrc, /listener\.onStatus\(id, info\)/);
});

test('AcpManager fan-out does not recurse into itself', () => {
  // fanoutStatus must call this.onStatus, not this.fanoutStatus
  const fanoutMatch = acpClientSrc.match(/private fanoutStatus\(id[^}]*\{[\s\S]*?\}/);
  assert.ok(fanoutMatch, 'fanoutStatus method should exist');
  assert.match(fanoutMatch[0], /this\.onStatus\(id, info\)/);
  assert.doesNotMatch(fanoutMatch[0], /this\.fanoutStatus\(id,info\)/);
});

test('remote-server registers ACP session API routes', () => {
  assert.match(remoteServerSrc, /app\.get\('\/api\/acp\/eligible'/);
  assert.match(remoteServerSrc, /app\.post\('\/api\/acp\/sessions'/);
  assert.match(remoteServerSrc, /app\.post\('\/api\/acp\/sessions\/:id\/prompt'/);
  assert.match(remoteServerSrc, /app\.post\('\/api\/acp\/sessions\/:id\/cancel'/);
  assert.match(remoteServerSrc, /app\.delete\('\/api\/acp\/sessions\/:id'/);
  assert.match(remoteServerSrc, /app\.get\('\/api\/acp\/sessions\/:id'/);
  assert.match(remoteServerSrc, /app\.get\('\/api\/acp\/sessions\/:id\/events'/);
});

test('remote-server accepts AcpManager in startRemoteServer signature', () => {
  assert.match(remoteServerSrc, /acpManager\?: AcpManager \| null/);
  assert.match(remoteServerSrc, /cachedAcpManager = acpManager \?\? null/);
});

test('remote-server ACP SSE stream uses named events and a remote listener', () => {
  assert.match(remoteServerSrc, /event: acp:replay/);
  assert.match(remoteServerSrc, /event: acp:update/);
  assert.match(remoteServerSrc, /event: acp:status/);
  assert.match(remoteServerSrc, /addRemoteListener\(listener\)/);
  assert.match(remoteServerSrc, /removeRemoteListener\(listener\)/);
});

test('headless backend creates an AcpManager and passes it to startRemoteServer', () => {
  assert.match(headlessSrc, /import \{ AcpManager \} from '\.\/acp-client'/);
  assert.match(headlessSrc, /new AcpManager/);
  assert.match(headlessSrc, /acpManager,\s*\)/);
});

test('desktop index.ts passes the existing acpManager to startRemoteServer', () => {
  assert.match(indexSrc, /listResumableSessions, loadClosedSessions, acpManager\)/);
});

test('mobile index.html includes the ACP detail page and acp-helpers script', () => {
  assert.match(indexHtml, /id="acp-detail-page"/);
  assert.match(indexHtml, /id="acp-messages"/);
  assert.match(indexHtml, /id="acp-msg-input"/);
  assert.match(indexHtml, /id="acp-send-btn"/);
  assert.match(indexHtml, /id="acp-cancel-btn"/);
  assert.match(indexHtml, /<script src="acp-helpers\.js"><\/script>/);
});

test('mobile app.js has ACP session functions and routes via openAcpOrTerminalSession', () => {
  assert.match(appJs, /function openAcpOrTerminalSession/);
  assert.match(appJs, /function openAcpSession/);
  assert.match(appJs, /function connectAcpSse/);
  assert.match(appJs, /function handleAcpUpdate/);
  assert.match(appJs, /function handleAcpAgentMessageChunk/);
  assert.match(appJs, /function handleAcpUserMessageChunk/);
  assert.match(appJs, /function handleAcpToolCall/);
  assert.match(appJs, /function handleAcpToolCallUpdate/);
  assert.match(appJs, /function sendAcpPrompt/);
  assert.match(appJs, /function cancelAcpPrompt/);
  assert.match(appJs, /function closeAcpSession/);
  // session creation routes through openAcpOrTerminalSession
  assert.match(appJs, /await openAcpOrTerminalSession\(cmd, cwd\)/);
  assert.match(appJs, /await openAcpOrTerminalSession\(preset, cwd\)/);
});

test('mobile app.js handles ACP SSE event types', () => {
  assert.match(appJs, /'acp:replay'/);
  assert.match(appJs, /'acp:update'/);
  assert.match(appJs, /'acp:status'/);
});

test('mobile app.js handles all ACP SessionUpdate types without crashing', () => {
  // All these sessionUpdate types must appear in the dispatch switch
  assert.match(appJs, /case 'agent_message_chunk'/);
  assert.match(appJs, /case 'user_message_chunk'/);
  assert.match(appJs, /case 'tool_call'/);
  assert.match(appJs, /case 'tool_call_update'/);
  assert.match(appJs, /case 'agent_thought_chunk'/);
  assert.match(appJs, /case 'usage_update'/);
  assert.match(appJs, /case 'config_option_update'/);
  assert.match(appJs, /case 'plan'/);
});

test('acp-helpers renders markdown with code blocks, bold, and headers', () => {
  const html = acpHelpers.renderMarkdown('# Title\n\n**bold** and `code`');
  assert.match(html, /<div class="acp-md-h1">Title<\/div>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="acp-inline-code">code<\/code>/);
});

test('acp-helpers escapes HTML to prevent injection', () => {
  const html = acpHelpers.renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), 'script tag must be escaped');
  assert.match(html, /&lt;script&gt;/);
});

test('acp-helpers classifies tool kinds from titles', () => {
  assert.equal(acpHelpers.guessToolKind('Bash command'), 'bash');
  assert.equal(acpHelpers.guessToolKind('Read file'), 'file');
  assert.equal(acpHelpers.guessToolKind('Write to source'), 'edit');
  assert.equal(acpHelpers.guessToolKind('Search results'), 'search');
  assert.equal(acpHelpers.guessToolKind('Web fetch'), 'web');
  assert.equal(acpHelpers.guessToolKind('Some other tool'), 'other');
});

test('acp-helpers provides tool status labels and icons', () => {
  assert.equal(acpHelpers.toolStatusLabel('completed'), 'Done');
  assert.equal(acpHelpers.toolStatusLabel('failed'), 'Failed');
  assert.equal(acpHelpers.toolStatusIcon('completed'), '✓');
  assert.equal(acpHelpers.toolStatusIcon('failed'), '✕');
});

test('acp-helpers detects internal task notifications', () => {
  assert.ok(acpHelpers.isInternalTaskNotification('<task-notification>foo</task-notification>'));
  assert.ok(acpHelpers.isInternalTaskNotification('[SYSTEM NOTIFICATION - NOT USER INPUT]'));
  assert.ok(!acpHelpers.isInternalTaskNotification('Hello, how can I help?'));
});

test('acp-helpers extracts a tool content preview', () => {
  const content = [{ type: 'content', content: { type: 'text', text: 'Reading file foo.ts' } }];
  assert.equal(acpHelpers.toolContentPreview(content), 'Reading file foo.ts');
  assert.equal(acpHelpers.toolContentPreview([]), '');
  assert.equal(acpHelpers.toolContentPreview(null), '');
});

test('service worker and app.js cache versions are bumped and include acp-helpers', () => {
  const clientBuild = appJs.match(/CLIENT_BUILD = '([^']+)'/)?.[1];
  const cacheName = swJs.match(/CACHE_NAME = '([^']+)'/)?.[1];
  assert.equal(clientBuild, cacheName, 'CLIENT_BUILD must match CACHE_NAME');
  assert.match(swJs, /\/acp-helpers\.js/);
});

test('PTY fallback is preserved for non-ACP presets', () => {
  // openAcpOrTerminalSession must fall back to creating a /api/sessions PTY session
  assert.match(appJs, /\/api\/sessions'/);
  assert.match(appJs, /openSession\(session\.id\)/);
  // The existing PTY terminal path must remain intact
  assert.match(appJs, /function connectWebSocket/);
  assert.match(appJs, /function openSession/);
  assert.match(appJs, /msg\.type === 'replay'/);
  assert.match(appJs, /msg\.type === 'output'/);
});
