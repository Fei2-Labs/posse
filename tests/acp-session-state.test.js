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

test('ACP context usage derives active occupancy and remaining capacity', () => {
  const { normalizeContextUsage } = loadModule();
  assert.deepEqual(normalizeContextUsage(50_000, 200_000), {
    kind: 'active',
    used: 50_000,
    size: 200_000,
    remaining: 150_000,
    percentage: 25,
  });
  assert.deepEqual(normalizeContextUsage(0, 200_000), {
    kind: 'active',
    used: 0,
    size: 200_000,
    remaining: 200_000,
    percentage: 0,
  });
});

test('ACP context usage rejects cumulative and malformed reports', () => {
  const { normalizeContextUsage } = loadModule();
  assert.deepEqual(normalizeContextUsage(345_000, 200_000), {
    kind: 'unknown', reason: 'over-capacity',
  });
  for (const values of [
    [-1, 200_000],
    [1, 0],
    [1.5, 200_000],
    [Number.NaN, 200_000],
    [1, Number.POSITIVE_INFINITY],
    ['100', 200_000],
  ]) {
    assert.deepEqual(normalizeContextUsage(values[0], values[1]), {
      kind: 'unknown', reason: 'invalid',
    });
  }
});

test('ACP context snapshots replace rather than accumulate across compaction and resume', () => {
  const { normalizeContextUsage } = loadModule();
  let current = normalizeContextUsage(160_000, 200_000);
  current = normalizeContextUsage(42_000, 200_000);
  assert.equal(current.kind, 'active');
  assert.equal(current.used, 42_000);
  assert.equal(current.remaining, 158_000);

  current = normalizeContextUsage(18_000, 128_000);
  assert.equal(current.kind, 'active');
  assert.equal(current.used, 18_000);
  assert.equal(current.size, 128_000);
});

test('ACP context meter exposes active, remaining, unknown and model-switch states', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  assert.match(source, /this\.contextUsage = normalizeContextUsage\(update\.used, update\.size\)/);
  assert.match(source, /Active context:.*remaining/);
  assert.match(source, />Context unknown<\/span>/);
  assert.match(source, /const isModelChange = opt\.id === 'model'/);
  assert.match(source, /if \(isModelChange\) \{\s*this\.contextUsage = undefined;/);
  assert.doesNotMatch(source, /Math\.min\(100, \(this\.usage\.used \/ this\.usage\.size\)/);
});

test('image data URLs become ACP image content blocks', () => {
  const { imageContentFromDataUrl } = loadModule();
  assert.deepEqual(imageContentFromDataUrl('data:image/png;base64,QUJD'), {
    type: 'image', mimeType: 'image/png', data: 'QUJD',
  });
  assert.equal(imageContentFromDataUrl('data:text/plain;base64,QUJD'), null);
});

test('ACP slash commands filter dynamically and complete without executing', () => {
  const { availableSlashCommands, slashCommandCompletion, slashCommandQuery } = loadModule();
  const commands = [
    { name: 'plan', description: 'Create an implementation plan', input: { hint: 'task to plan' } },
    { name: 'skills', description: 'Browse available skills' },
    { name: 'duplicate', description: 'First' },
    { name: 'DUPLICATE', description: 'Second' },
    { name: 'bad command', description: 'Invalid whitespace' },
  ];

  assert.equal(slashCommandQuery('/PL'), 'pl');
  assert.equal(slashCommandQuery('/plan arguments'), null);
  assert.deepEqual(availableSlashCommands(commands, '/impl').map(command => command.name), ['plan']);
  assert.deepEqual(availableSlashCommands(commands, '/browse').map(command => command.name), ['skills']);
  assert.deepEqual(availableSlashCommands(commands, '/').map(command => command.name), [
    'plan', 'skills', 'duplicate',
  ]);
  assert.equal(slashCommandCompletion(commands[0]), '/plan ');
  assert.equal(slashCommandCompletion(commands[1]), '/skills');
});

test('ACP slash command list handles protocol updates and accessible completion controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /case 'available_commands_update':\s*this\.availableCommands = update\.availableCommands \|\| \[\]/);
  assert.match(source, /role="listbox" aria-label="Available agent commands"/);
  assert.match(source, /aria-autocomplete="list"/);
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === 'Tab'/);
  assert.match(source, /this\.completeSlashCommand\(this\.filteredCommands\[this\.activeCommandIndex\]\)/);
  assert.match(source, /option\.addEventListener\('mousedown', \(event\) => event\.preventDefault\(\)\)/);
  assert.match(source, /slashCommandCompletion\(command\)/);
  assert.match(styles, /\.acp-slash-commands \{[\s\S]*scrollbar-gutter: stable;/);
  assert.match(styles, /\.acp-slash-command:focus-visible/);
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
  assert.match(source, /class="acp-sb-scroll"[\s\S]*?<\/div>\s*<div class="acp-sb-trailing">\s*\$\{contextHtml\}/);
  assert.match(source, /class="acp-sb-item acp-sb-ctx"/);
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
  // #82: the foreground session is restored first so it isn't queued behind background
  // restores, but the order still covers every persisted session exactly once.
  assert.match(source, /const restoreOrder = \[target, \.\.\.sessions\.filter\(saved => saved !== target\)\];/);
  assert.match(source, /for \(const saved of restoreOrder\)/);
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
  // Theme definitions live in the shared canonical list (src/shared/app-themes.ts) since the
  // theme/editor unification — both the desktop renderer and the terminal client import it.
  const themes = fs.readFileSync(path.join(__dirname, '..', 'src/shared/app-themes.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
  assert.match(source, /document\.documentElement\.dataset\.appTheme = theme\.id/);
  assert.match(source, /new CustomEvent\('posse:theme-changed'/);
  assert.match(source, /import \{ APP_THEMES \} from '\.\.\/shared\/app-themes'/);
  assert.match(themes, /'--bg-tertiary': '#f6f8fa'/);
  assert.match(themes, /'--border-default': '#d0d7de'/);
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

test('ACP replay hides internal task-notification envelopes from assistant prose', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  assert.match(view, /private isInternalTaskNotification\(raw: string\): boolean/);
  assert.match(view, /text\.startsWith\('\<task-notification\>'\)/);
  assert.match(view, /dataset\.internalNotification = 'true'/);
  assert.match(view, /currentMessage\.remove\(\)/);
  assert.match(view, /!messageId && !currentMessage\?\.dataset\.messageId/);
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

test('ACP resume restores local user prompts when adapter replay omits user chunks', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');

  assert.match(view, /restoreMissingUserPrompts\(stableSessionId: string, updates: SessionUpdate\[]\)/);
  assert.match(view, /updates\.some\(update => update\.sessionUpdate === 'user_message_chunk'\)/);
  assert.match(view, /AcpPromptHistory\.load\(key\)/);
  assert.match(view, /for \(const prompt of prompts\) this\.addUserMessage\(prompt\)/);
  assert.match(view, /replayUserFallbackRendered = true/);
  assert.match(app, /view\.restoreMissingUserPrompts\(acpSessionId, replayUpdates\)/);
});

test('ACP resume returns deterministic replay and drains it before entering live mode', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'src/main/acp-client.ts'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');

  assert.match(client, /const replayBuffer = new AcpReplayBuffer\(\)/);
  assert.match(client, /resolve\(\{ \.\.\.info, replayUpdates: replayBuffer\.take\(\) \}\)/);
  assert.match(client, /if \(updates\.length === 0\) entry\.replayBuffer = null/);
  assert.match(main, /const acpOwners = new Map<string, WebContents>\(\)/);
  assert.match(main, /sendToAcpOwner\('acp:update', id, update\)/);
  assert.match(main, /ipcMain\.handle\('acp:drain-replay'/);
  assert.match(preload, /acpDrainReplay: \(id: string\)/);
  assert.match(app, /const replayUpdates = \[\.\.\.\(info\.replayUpdates \|\| \[\]\)\]/);
  assert.match(app, /const pending = await window\.posse\.acpDrainReplay\(acpId\)/);
  assert.match(app, /if \(pending\.length === 0\) break/);
  assert.match(app, /replayUpdates\.push\(\.\.\.pending\)/);
  assert.match(app, /view\.restoreMissingUserPrompts\(acpSessionId, replayUpdates\)/);
  assert.match(app, /await view\.replayUpdates\(replayUpdates\)/);
  assert.match(view, /async replayUpdates\(updates: SessionUpdate\[], batchSize = 100\)/);
  assert.match(view, /const timeout = window\.setTimeout\(finish, 50\)/);
  assert.match(view, /requestAnimationFrame\(finish\)/);
});
