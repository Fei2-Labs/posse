const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadModule() {
  const filename = path.join(__dirname, '..', 'src/renderer/conversation-preferences.ts');
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

const preferences = loadModule();

test('conversation details default to collapsed', () => {
  assert.deepEqual(preferences.parseConversationPreferences(null), {
    expandThoughtsByDefault: false,
    expandToolsByDefault: false,
  });
});

test('conversation preferences tolerate malformed and partial storage', () => {
  assert.deepEqual(preferences.parseConversationPreferences('{bad json'), {
    expandThoughtsByDefault: false,
    expandToolsByDefault: false,
  });
  assert.deepEqual(preferences.parseConversationPreferences(JSON.stringify({ expandThoughtsByDefault: true })), {
    expandThoughtsByDefault: true,
    expandToolsByDefault: false,
  });
});

test('conversation preferences round-trip through storage', () => {
  let stored = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };
  const expected = { expandThoughtsByDefault: true, expandToolsByDefault: true };
  preferences.saveConversationPreferences(expected, storage);
  assert.deepEqual(preferences.loadConversationPreferences(storage), expected);
});
