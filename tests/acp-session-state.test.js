const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadModule() {
  const filename = path.join(__dirname, '..', 'src/renderer/acp-session-state.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}

test('interrupt message dispatches before messages already in the queue', () => {
  const { AcpPromptQueue } = loadModule();
  const queue = new AcpPromptQueue();
  queue.enqueue('queued-1');
  queue.enqueue('queued-2');
  queue.setInterruptNext('interrupt');
  assert.equal(queue.next(), 'interrupt');
  assert.equal(queue.next(), 'queued-1');
  assert.equal(queue.next(), 'queued-2');
  assert.equal(queue.next(), null);
});

test('status controls expose model, effort, speed and access in stable order', () => {
  const { statusConfigOptions } = loadModule();
  const options = [
    { id: 'mode', type: 'select', currentValue: 'agent', options: [] },
    { id: 'agent', type: 'select', currentValue: 'default', options: [] },
    { id: 'fast-mode', type: 'select', currentValue: 'off', options: [] },
    { id: 'model', type: 'select', currentValue: 'gpt', options: [] },
    { id: 'reasoning_effort', type: 'select', currentValue: 'medium', options: [] },
    { id: 'collaboration_mode', type: 'select', currentValue: 'default', options: [] },
  ];
  assert.deepEqual(statusConfigOptions(options).map(option => option.id), [
    'model', 'reasoning_effort', 'fast-mode', 'mode',
  ]);
});

test('image data URLs become ACP image content blocks', () => {
  const { imageContentFromDataUrl } = loadModule();
  assert.deepEqual(imageContentFromDataUrl('data:image/png;base64,QUJD'), {
    type: 'image', mimeType: 'image/png', data: 'QUJD',
  });
  assert.equal(imageContentFromDataUrl('data:text/plain;base64,QUJD'), null);
});

test('persisted ACP foreground metadata rejects incomplete or corrupt state', () => {
  const { parsePersistedAcpForeground } = loadModule();
  const valid = {
    kind: 'acp', presetCommand: 'codex', sessionId: 'session-1', cwd: '/repo',
    displayName: 'Codex', title: 'Work',
  };
  assert.deepEqual(parsePersistedAcpForeground(JSON.stringify(valid)), valid);
  assert.equal(parsePersistedAcpForeground('{bad json'), null);
  assert.equal(parsePersistedAcpForeground(JSON.stringify({ kind: 'acp', cwd: '/repo' })), null);
});

test('persisted active ACP sessions keep valid timestamps and drop corrupt rows', () => {
  const { parsePersistedActiveAcpSessions } = loadModule();
  const valid = {
    kind: 'acp', presetCommand: 'codex', sessionId: 'session-1', cwd: '/repo',
    displayName: 'Codex', title: 'Work', createdAt: 100, updatedAt: 200,
  };
  assert.deepEqual(parsePersistedActiveAcpSessions(JSON.stringify([valid, { kind: 'acp' }])), [valid]);
  assert.deepEqual(parsePersistedActiveAcpSessions('{bad json'), []);
});

test('ACP composer wires queue, interrupt, paste and structured prompt content', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /addEventListener\('paste', \(event\) => this\.handleImagePaste\(event\)\)/);
  assert.match(source, /submitComposer\('queue'\)/);
  assert.match(source, /submitComposer\('interrupt'\)/);
  assert.match(source, /acpPrompt\(this\.sessionId, message\.blocks\)/);
  assert.match(source, /getAgentLogo\(agentName\)/);
  assert.match(source, /do not render them as horizontal rules/);
  assert.match(styles, /\.acp-attachment-chip img \{[\s\S]*object-fit: contain;/);
  assert.match(styles, /\.acp-input::\-webkit-scrollbar \{ display: none; \}/);
});

test('ACP sessions expose a jump-to-latest control without forcing readers back to the bottom', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /class="acp-jump-bottom"/);
  assert.match(source, /aria-label="Jump to latest message"/);
  assert.match(source, /this\.scrollEl\.addEventListener\('scroll'/);
  assert.match(source, /if \(!force && !this\.followsLatest\)/);
  assert.match(source, /this\.jumpToBottomBtn\.addEventListener\('click', \(\) => this\.scrollToBottom\(true\)\)/);
  assert.match(source, /this\.messagesResizeObserver\.disconnect\(\)/);
  assert.match(styles, /\.acp-scroll-shell \{[\s\S]*position: relative;[\s\S]*min-height: 0;/);
  assert.match(styles, /\.acp-jump-bottom \{[\s\S]*width: 40px;[\s\S]*height: 40px;/);
  assert.match(styles, /\.acp-jump-bottom:focus-visible/);
});

test('ACP context usage stays outside the scrollable status controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /class="acp-sb-scroll"[\s\S]*?<\/div>\s*<div class="acp-sb-trailing">[\s\S]*?acp-sb-ctx/);
  assert.match(styles, /\.acp-sb-scroll \{[\s\S]*?min-width: 0;[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.acp-sb-trailing \{ flex: 0 0 auto; \}/);
  assert.match(styles, /\.acp-sb-ctx \{ flex-shrink: 0;/);
});

test('ACP status controls keep compact values with accessible labels', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /const accessibleLabel = `\$\{controlLabel\}: \$\{valueLabel\}`;/);
  assert.match(source, /aria-label="\$\{this\.escapeHtml\(accessibleLabel\)\}"/);
  assert.doesNotMatch(source, /class="acp-sb-label">\$\{this\.escapeHtml\(configControlLabel\(option\)\)\}/);
  assert.match(source, /class="acp-sb-status"[\s\S]*role="status"[\s\S]*aria-label="\$\{statusLabel\}"/);
  assert.match(styles, /\.acp-statusbar \.acp-sb-value \{[\s\S]*opacity: 0\.78;/);
  assert.match(styles, /\.acp-sb-clickable:focus-visible/);
});

test('ACP tool calls render as compact rows without card borders', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  const toolCallRule = styles.match(/\.acp-tool-call \{([\s\S]*?)\}/)?.[1] || '';
  assert.match(toolCallRule, /border:\s*0;/);
  assert.doesNotMatch(toolCallRule, /border:\s*1px/);
});

test('ACP prose wraps naturally while long tokens and code stay contained', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  const messageBodyRule = styles.match(/\.acp-msg-body \{([\s\S]*?)\}/)?.[1] || '';
  const codeRule = styles.match(/\.acp-msg-body pre \{([\s\S]*?)\}/)?.[1] || '';
  assert.match(messageBodyRule, /word-break:\s*normal;/);
  assert.match(messageBodyRule, /overflow-wrap:\s*break-word;/);
  assert.match(messageBodyRule, /hyphens:\s*none;/);
  assert.doesNotMatch(messageBodyRule, /break-all/);
  assert.match(styles, /\.acp-inline-code \{[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(styles, /\.acp-msg-body a \{[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(codeRule, /overflow-x:\s*auto;/);
  assert.match(codeRule, /white-space:\s*pre;/);
  assert.match(codeRule, /overflow-wrap:\s*normal;/);
});

test('ACP activity is grouped into a single collapsible summary', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /class="acp-activity-summary"/);
  assert.match(source, /appendActivityNode\(thought\)/);
  assert.match(source, /appendActivityNode\(el, state\.activityGroup\)/);
  assert.match(styles, /\.acp-activity-content \{[\s\S]*flex-direction: column;/);
});

test('renderer starts on All and restores every persisted active ACP session', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  assert.match(source, /let activeAgentTab = 'all';/);
  assert.match(source, /async function restoreActiveAcpSessions\(\)/);
  assert.match(source, /for \(const saved of sessions\)/);
  assert.match(source, /await restoreDaemonSessions\(\);[\s\S]*await restoreActiveAcpSessions\(\);/);
  assert.match(source, /await restoreActiveAcpSessions\(\);[\s\S]*await refreshProjectsData\(\);/);
});

test('restored recovery sections reopen and close rendering yields a paint first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  assert.match(source, /if \(key === 'pinned' \|\| key === 'projects'\) collapsedSections\.add\(key\)/);
  assert.match(source, /function scheduleSessionChromeRender\([\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*window\.setTimeout/);
  assert.match(source, /removeSessionRowsInPlace\(\[id\]\);[\s\S]*scheduleSessionChromeRender\(wasActive\)/);
});

test('app theme changes are explicit and structured sessions consume live tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /document\.documentElement\.dataset\.appTheme = theme\.id/);
  assert.match(source, /new CustomEvent\('posse:theme-changed'/);
  assert.match(source, /'--bg-tertiary': '#f6f8fa'/);
  assert.match(source, /'--border-default': '#d0d7de'/);
  assert.match(styles, /\.acp-session-view \{[\s\S]*background: var\(--bg-primary/);
  assert.match(styles, /\.acp-session-view \{[\s\S]*color: var\(--text-primary/);
  assert.match(styles, /\.acp-msg-images img \{[\s\S]*background: var\(--bg-tertiary, var\(--bg-primary/);
});

test('ACP startup reports measured phases and does not advertise fake rollback', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'src/main/acp-client.ts'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(client, /startupTimingsMs/);
  assert.match(client, /'initializing-protocol'/);
  assert.match(client, /'loading-session'/);
  assert.match(client, /supportsPromptRollback: false/);
  assert.match(client, /const ACP_LOAD_TIMEOUT_MS = 90_000/);
  assert.match(client, /this\.destroy\(id, false\)/);
  assert.match(client, /this\.sessions\.get\(id\)\?\.process === childProcess/);
  assert.match(view, /'loading-session': 'Loading history'/);
  assert.match(view, /className = 'acp-session-retry'/);
  assert.match(view, /this\.startupPhase !== 'ready'/);
  assert.match(app, /function mountLoadedAcpSessionView\(/);
  assert.match(app, /previousElement\.replaceWith\(view\.getElement\(\)\)/);
  assert.match(app, /if \(acpViews\.get\(acpId\) === view\) view\.handleStatus\(info\)/);
  assert.match(styles, /\.acp-session-retry:focus-visible/);
});

test('ACP history replay renders user message chunks without duplicating live prompts', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  assert.match(view, /case 'user_message_chunk':\s*this\.handleUserMessageChunk\(update\)/);
  assert.match(view, /if \(this\.isPrompting \|\| !update\.content\) return/);
  assert.match(view, /!messageId && !current\?\.dataset\.messageId/);
  assert.match(view, /this\.currentUserMessageEl = null/);
  assert.match(view, /className = 'acp-user-text'/);
  assert.match(view, /data:\$\{update\.content\.mimeType\};base64/);
  assert.doesNotMatch(view, /case 'user_message_chunk':\s*break;/);
});
