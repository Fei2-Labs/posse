const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', output)(mod, mod.exports, require);
  return mod.exports;
}

const { matchRbwEntries, parseRbwList, parseRbwLogin } = load('src/main/browser-credentials.ts');

test('parses only non-secret rbw list metadata', () => {
  const result = parseRbwList(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', name: 'Example', user: 'me@example.com', folder: 'Work', uris: ['https://example.com/login'], type: 'login', password: 'must-not-be-used' }]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value[0], {
    id: '11111111-1111-1111-1111-111111111111', name: 'Example', username: 'me@example.com', folder: 'Work', uris: ['https://example.com/login'], type: 'login',
  });
});

test('accepts rbw 1.15 null URI lists and normalizes entry types', () => {
  const result = parseRbwList(JSON.stringify([
    { id: '11111111-1111-1111-1111-111111111111', name: 'Login', user: null, folder: null, uris: null, type: 'Login' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Note', user: null, folder: null, uris: [], type: 'Note' },
  ]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((entry) => ({ uris: entry.uris, type: entry.type })), [
    { uris: [], type: 'login' },
    { uris: [], type: 'note' },
  ]);
});

test('matches exact origin before same-host candidates and rejects unrelated hosts', () => {
  const result = matchRbwEntries([
    { id: '1', name: 'same', uris: ['https://example.com/account'], type: 'login' },
    { id: '2', name: 'exact', uris: ['https://example.com:8443/login'], type: 'login' },
    { id: '3', name: 'other', uris: ['https://not-example.com'], type: 'login' },
  ], 'https://example.com:8443/login?next=1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((item) => [item.id, item.match]), [['2', 'exact-origin'], ['1', 'same-host']]);
});

test('requires the selected rbw id and login password', () => {
  assert.equal(parseRbwLogin(JSON.stringify({ id: 'different', login: { username: 'a', password: 'b' } }), 'expected').ok, false);
  const result = parseRbwLogin(JSON.stringify({ id: 'expected', login: { username: 'a', password: 'b' } }), 'expected');
  assert.deepEqual(result, { ok: true, value: { id: 'expected', username: 'a', password: 'b' } });
});

test('parses rbw 1.15 login fields from the data object', () => {
  const result = parseRbwLogin(JSON.stringify({
    id: 'expected',
    data: { username: 'a', password: 'b', totp: null, uris: [] },
    fields: [],
  }), 'expected');
  assert.deepEqual(result, { ok: true, value: { id: 'expected', username: 'a', password: 'b' } });
});
