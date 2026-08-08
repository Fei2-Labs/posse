const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
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

const {
  agentFamilyMatchesTab,
  projectVisibleForAgent,
  visibleAgentFamilies,
} = loadTypeScriptModule('src/renderer/sidebar-agent-filter.ts');

function group(lives = 0, closed = 0, history = 0) {
  return {
    lives: Array(lives).fill('live'),
    closed: Array(closed).fill('closed'),
    history: Array(history).fill('history'),
  };
}

test('specific agent tabs filter families while All restores every family', () => {
  const families = ['Claude', 'Codex', 'Copilot'];

  assert.equal(agentFamilyMatchesTab('Claude', 'Claude'), true);
  assert.equal(agentFamilyMatchesTab('Codex', 'Claude'), false);
  assert.deepEqual(visibleAgentFamilies(families, 'Claude'), ['Claude']);
  assert.deepEqual(visibleAgentFamilies(families, 'all'), families);
});

test('projects follow the active agent tab but sessionless projects stay available', () => {
  const mixed = new Map([
    ['Claude', group(1)],
    ['Codex', group(0, 1)],
  ]);

  assert.equal(projectVisibleForAgent(mixed, 'Claude'), true);
  assert.equal(projectVisibleForAgent(mixed, 'Codex'), true);
  assert.equal(projectVisibleForAgent(mixed, 'Copilot'), false);
  assert.equal(projectVisibleForAgent(mixed, 'all'), true);
  assert.equal(projectVisibleForAgent(new Map(), 'Copilot'), true);
});

test('sidebar search composes with the agent filter instead of bypassing it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');

  assert.match(source, /const tabFilter = \(p: ProjectEntry\) => projectVisibleUnderTab\(p\);/);
  assert.doesNotMatch(source, /projectSearchQuery\.length > 0 \|\| projectVisibleUnderTab\(p\)/);
  assert.match(source, /const families = visibleAgentFamilies\(groups\.keys\(\), activeAgentTab\);/);
  assert.match(
    source,
    /function projectMatchesSearch[\s\S]*for \(const \[family, g\] of groups\) \{[\s\S]*agentFamilyMatchesTab\(family, activeAgentTab\)/,
  );
  assert.match(
    source,
    /function projectHasMatchingChild[\s\S]*for \(const \[family, g\] of collectProjectSessions\(p\.path\)\) \{[\s\S]*agentFamilyMatchesTab\(family, activeAgentTab\)/,
  );
});

test('Pinned, Active Sessions, Recent, and Projects share the same agent predicate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  const pinnedCollector = source.match(/function collectPinnedSessionRows[\s\S]*?\n\}/)?.[0] || '';
  const activeCollector = source.match(/function collectActiveSessionRows[\s\S]*?\n\}/)?.[0] || '';
  const recentCollector = source.match(/function collectRecentSessionRows[\s\S]*?\n\}/)?.[0] || '';

  assert.match(pinnedCollector, /agentFamilyMatchesTab\(family, activeAgentTab\)/);
  assert.match(activeCollector, /agentFamilyMatchesTab\(family, activeAgentTab\)/);
  assert.match(recentCollector, /agentFamilyMatchesTab\(family, activeAgentTab\)/);
  assert.match(source, /projectVisibleForAgent\(getProjectSessions\(p\.path\), activeAgentTab\)/);
});
