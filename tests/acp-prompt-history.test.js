const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadModule() {
  const filename = path.join(__dirname, '..', 'src/renderer/acp-prompt-history.ts');
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

const { AcpPromptHistory, canNavigatePromptHistory } = loadModule();

test('prompt history walks older and newer entries before restoring the draft', () => {
  const history = new AcpPromptHistory(['first', 'second']);
  assert.equal(history.navigate('older', 'unfinished draft'), 'second');
  assert.equal(history.navigate('older', 'second'), 'first');
  assert.equal(history.navigate('newer', 'first'), 'second');
  assert.equal(history.navigate('newer', 'second'), 'unfinished draft');
});

test('prompt history deduplicates adjacent submissions and enforces its limit', () => {
  const history = new AcpPromptHistory([], 2);
  history.add('one');
  history.add('one');
  history.add('two');
  history.add('three');
  assert.deepEqual(history.values(), ['two', 'three']);
});

test('multiline history navigation only takes over at the first or last logical line', () => {
  const value = 'line one\nline two';
  assert.equal(canNavigatePromptHistory(value, 12, 12, 'older'), false);
  assert.equal(canNavigatePromptHistory(value, 4, 4, 'older'), true);
  assert.equal(canNavigatePromptHistory(value, 4, 4, 'newer'), false);
  assert.equal(canNavigatePromptHistory(value, value.length, value.length, 'newer'), true);
  assert.equal(canNavigatePromptHistory(value, 0, 4, 'older'), false);
});
