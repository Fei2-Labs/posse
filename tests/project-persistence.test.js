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

test('cleanup removes a stale project and all path-keyed sidebar state', () => {
  const { cleanupStaleProjectPersistence } = loadTypeScriptModule('src/renderer/project-persistence.ts');
  const stale = '/tmp/stale-copilot-history';
  const keep = '/projects/keep';
  const result = cleanupStaleProjectPersistence({
    projects: [
      { path: stale, pinned: true, addedAt: 1 },
      { path: keep, pinned: false, addedAt: 2 },
    ],
    stalePaths: [stale],
    expandedProjects: new Set([stale, keep]),
    searchCollapsedProjects: new Set([stale]),
    showArchivedProjects: new Set([stale]),
    expandedAgentGroups: new Set([`${stale}::copilot`, `${keep}::claude`]),
    normalizePath: (value) => value,
  });

  assert.deepEqual(result.projects.map((project) => project.path), [keep]);
  assert.deepEqual([...result.expandedProjects], [keep]);
  assert.deepEqual([...result.searchCollapsedProjects], []);
  assert.deepEqual([...result.showArchivedProjects], []);
  assert.deepEqual([...result.expandedAgentGroups], [`${keep}::claude`]);
});

test('projects-list payload normalization supports explicit and legacy responses', () => {
  const { normalizeProjectsListPayload } = loadTypeScriptModule('src/renderer/project-persistence.ts');
  const project = { path: '/projects/keep' };

  assert.deepEqual(normalizeProjectsListPayload({
    projects: [project],
    staleProjectPaths: ['/tmp/stale'],
  }), {
    projects: [project],
    staleProjectPaths: ['/tmp/stale'],
  });
  assert.deepEqual(normalizeProjectsListPayload([project]), {
    projects: [project],
    staleProjectPaths: [],
  });
});
