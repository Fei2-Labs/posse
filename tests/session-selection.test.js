const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadSessionSelectionModule() {
  const filename = path.join(__dirname, '..', 'src/renderer/session-selection.ts');
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

const { resolveActiveLiveSessionId } = loadSessionSelectionModule();
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');

test('ACP resume owns sidebar selection over a still-active background PTY', () => {
  assert.equal(resolveActiveLiveSessionId(null, 'acp-codex-resume', 'pty-previous'), 'acp-codex-resume');
});

test('switching back to a PTY transfers sidebar selection', () => {
  assert.equal(resolveActiveLiveSessionId(null, null, 'pty-current'), 'pty-current');
});

test('opening Chat prevents a background live session from also being highlighted', () => {
  assert.equal(resolveActiveLiveSessionId('chat-current', 'acp-background', 'pty-background'), null);
});

test('ACP activity schedules a sidebar refresh after advancing session recency', () => {
  assert.match(
    appSource,
    /onAcpUpdate\(\(id, update\) => \{[\s\S]*sessionUpdateTimes\.set\(id, Date\.now\(\)\);[\s\S]*scheduleAcpSidebarRender\(\);[\s\S]*\}\);/,
  );
});

test('Recent mixes live and closed conversations and limits the result to nine', () => {
  const collector = appSource.match(
    /function collectRecentSessionRows\(\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(collector, 'expected Recent collector');
  assert.match(collector, /for \(const id of sessionTitles\.keys\(\)\)/);
  assert.match(collector, /out\.sort\(\(a, b\) => b\.time - a\.time\)/);
  assert.match(collector, /return out\.slice\(0, 9\)/);
});

test('closing ACP sessions persists resumable metadata before clearing live state', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(appSource, /function acpClosedSessionMetadata\(id: string\)/);
  assert.match(appSource, /window\.posse\.acpDestroy\(id, acpClosedSessionMetadata\(id\)\);\s*removePersistedActiveAcpSession\(id\)/);
  assert.match(preloadSource, /acpDestroy: \(id: string, closedSession\?: AcpClosedSessionMetadata\)/);
  assert.match(mainSource, /ipcMain\.on\('acp:destroy', \(_e, id: string, closedSession\?: unknown\)/);
  assert.match(mainSource, /existing\.resumeId !== session\.resumeId/);
});

test('resuming a closed session redraws Recent after its persisted row is removed', () => {
  const acpResumeBranch = appSource.match(
    /if \(hasResume && cs\.resumeId && cs\.presetCommand\) \{[\s\S]*?\n  \}\n\n  if \(hasResume\)/,
  )?.[0];
  assert.ok(acpResumeBranch, 'expected restoreClosedSession ACP resume branch');
  const removeAt = acpResumeBranch.indexOf('closedSessions = await window.posse.closedSessionsRemove(cs.id)');
  const redrawAt = acpResumeBranch.indexOf('renderSessionList()', removeAt);
  const returnAt = acpResumeBranch.indexOf('return;', removeAt);
  assert.ok(removeAt >= 0, 'expected persisted Recent row removal');
  assert.ok(redrawAt > removeAt && redrawAt < returnAt, 'expected redraw after removal and before return');
});

test('Active and Recent session rows share the compact sidebar grid', () => {
  const rowRule = stylesSource.match(/\.nav-session \{([\s\S]*?)\}/)?.[1] || '';
  const titleRule = stylesSource.match(/(?:^|\n)\.nav-session-title \{([\s\S]*?)\}/)?.[1] || '';
  assert.match(rowRule, /gap:\s*5px;/);
  assert.match(rowRule, /height:\s*28px;/);
  assert.match(rowRule, /padding:\s*0 7px 0 8px;/);
  assert.match(rowRule, /margin:\s*1px 6px;/);
  assert.match(titleRule, /font-size:\s*11\.5px;/);
  assert.match(titleRule, /text-overflow:\s*ellipsis;/);
});

test('session row actions use one icon system and stable metrics', () => {
  const actionRule = stylesSource.match(/\.nav-session-action \{([\s\S]*?)\}/)?.[1] || '';
  const iconRule = stylesSource.match(/\.nav-session-action svg \{([\s\S]*?)\}/)?.[1] || '';
  const timeRule = stylesSource.match(/\.nav-session-time \{([\s\S]*?)\}/)?.[1] || '';
  const compactRows = appSource.slice(
    appSource.indexOf('function buildLiveSessionRow'),
    appSource.indexOf('interface ProjectAgentGroup'),
  );

  assert.match(appSource, /trash: '<svg/);
  assert.match(appSource, /makeSessionActionButton\(ICON\.x, 'Close'\)/);
  assert.match(appSource, /makeSessionActionButton\(ICON\.trash, 'Delete permanently', true\)/);
  assert.doesNotMatch(compactRows, /(?:closeBtn|delBtn)\.textContent = ['"](?:×|🗑)['"]/);
  assert.match(actionRule, /width:\s*20px;/);
  assert.match(actionRule, /height:\s*20px;/);
  assert.match(iconRule, /width:\s*13px;/);
  assert.match(iconRule, /height:\s*13px;/);
  assert.match(timeRule, /font-size:\s*10px;/);
  assert.match(timeRule, /font-variant-numeric:\s*tabular-nums;/);
});

test('direct delete terminates live sessions without creating resumable records', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const acpViewSource = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/acp-session-view.ts'), 'utf8');

  assert.match(preloadSource, /deletePty: \(id: string\)[\s\S]*ipcRenderer\.invoke\('pty:delete', id\)/);
  assert.match(preloadSource, /acpDelete: \(id: string\)[\s\S]*ipcRenderer\.invoke\('acp:delete', id\)/);
  assert.match(mainSource, /const sessionUserDeleted: Set<string> = new Set\(\)/);
  assert.match(mainSource, /session\?\.resumeId && !sessionUserDeleted\.has\(deletionKey\)/);
  assert.match(mainSource, /ipcMain\.handle\('pty:delete'[\s\S]*sessionUserDeleted\.add\(deletionKey\)[\s\S]*await backend\.destroy\(id\)/);
  assert.match(mainSource, /ipcMain\.handle\('acp:delete'[\s\S]*acpManager\.destroy\(id\)/);
  assert.match(appSource, /confirmDangerDialog\([\s\S]*Delete session permanently\?/);
  assert.match(appSource, /result\.terminated[\s\S]*removeLiveSessionFromRenderer\(id\)/);
  assert.match(acpViewSource, /destroy\(notifyMain = true\)[\s\S]*if \(notifyMain\) window\.posse\.acpDestroy/);
});

test('permanent store deletion resolves only agent-owned source paths', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(mainSource, /function isPathInside\(root: string, candidate: string\)/);
  assert.match(mainSource, /function resolveSessionSourcePath\(agent: DeletableAgent/);
  assert.match(mainSource, /supplied && isPathInside\(root, supplied\) && fs\.existsSync\(supplied\)/);
  assert.match(mainSource, /sid\.includes\('\.\.'\)[\s\S]*invalid session id/);
  assert.doesNotMatch(mainSource, /fs\.rmSync\(sourcePath,/);
});

test('workspace toolbar independently controls persistent left and right sidebars', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');

  assert.match(html, /id="workspace-topbar" role="toolbar" aria-label="Workspace layout controls"[\s\S]*id="sidebar-toggle"[\s\S]*title="Toggle left sidebar"[\s\S]*aria-pressed="true"/);
  assert.match(html, /id="file-tree-toggle"[\s\S]*title="Toggle right sidebar"[\s\S]*aria-pressed="true"/);
  assert.match(appSource, /function setSidebarCollapsed\(collapsed: boolean, persist = true\)/);
  assert.match(appSource, /function setInspectorCollapsed\(collapsed: boolean, persist = true\)/);
  assert.match(appSource, /button\.setAttribute\('aria-pressed', String\(visible\)\)/);
  assert.match(appSource, /sidebarResizer\.hidden = collapsed/);
  assert.match(appSource, /fileTreeResizer\.hidden = collapsed/);
  assert.match(appSource, /setInspectorCollapsed\(savedFileTreeCollapsed === 'true', false\)/);
  assert.match(appSource, /setSidebarCollapsed\(savedSidebarCollapsed === 'true', false\)/);
  assert.match(stylesSource, /\.workspace-panel-toggle:focus-visible/);
  assert.match(stylesSource, /#file-tree-toggle \{ margin-left: auto; \}/);
  assert.match(stylesSource, /@media \(max-width: 1000px\)[\s\S]*#sidebar\.collapsed[\s\S]*translateX\(-100%\)/);
});

test('session viewports clip unnecessary horizontal overflow', () => {
  assert.match(stylesSource, /#terminal-area \{[\s\S]*overflow: hidden;/);
  assert.match(stylesSource, /\.terminal-container \.xterm-viewport \{[\s\S]*overflow-x: hidden !important;/);
  assert.match(stylesSource, /\.chat-messages \{[\s\S]*overflow-x: hidden;/);
  assert.match(stylesSource, /\.acp-scroll \{[\s\S]*overflow-x: hidden;/);
  assert.match(stylesSource, /\.fp-markdown\.markdown-body pre \{[\s\S]*overflow: auto;/);
});
