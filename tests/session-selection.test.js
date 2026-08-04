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
