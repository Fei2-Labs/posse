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

const { matchRbwEntries, searchRbwEntries, parseRbwList, parseRbwLogin } = load('src/main/browser-credentials.ts');

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
  assert.deepEqual(result.value.map((item) => [item.id, item.match, item.offItemOrigin]), [
    ['2', 'exact-origin', false],
    ['1', 'same-host', true],
  ]);
});

test('matchRbwEntries requires exact origin binding for a no-warning fill', () => {
  const result = matchRbwEntries([
    { id: '1', name: 'named', uris: [], type: 'login' },
  ], 'https://example.com/login');
  // No URI overlap → no candidate at all in matchRbwEntries (manual search covers name-only).
  assert.equal(result.ok, false);
});

test('treats subdomains and localhost ports as off-origin even when the host is related', () => {
  const subdomain = searchRbwEntries([
    { id: 'subdomain', name: 'Root account', uris: ['https://example.com/login'], type: 'login' },
    { id: 'port', name: 'Other local app', uris: ['http://localhost:3000'], type: 'login' },
  ], 'Root account', 'https://login.example.com/oauth/callback');
  assert.equal(subdomain.ok, true);
  assert.deepEqual(subdomain.value.map((item) => [item.id, item.match, item.offItemOrigin]), [
    ['subdomain', 'search', true],
  ]);

  const local = matchRbwEntries([
    { id: 'port', name: 'Other local app', uris: ['http://localhost:3000'], type: 'login' },
  ], 'http://localhost:4173/login');
  assert.deepEqual(local.ok && local.value.map((item) => [item.match, item.offItemOrigin]), [['same-host', true]]);
});

test('parses optional organization and collection labels without secret fields', () => {
  const result = parseRbwList(JSON.stringify([{
    id: '1', name: 'Work login', user: 'me', folder: 'Engineering',
    organization: { name: 'Acme' }, collections: [{ name: 'Production' }],
    uris: [], type: 'login', password: 'must-not-be-used', notes: 'private',
  }]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value[0], {
    id: '1', name: 'Work login', username: 'me', folder: 'Engineering',
    organization: 'Acme', collection: 'Production', uris: [], type: 'login',
  });
});

test('searchRbwEntries searches name, username, folder, organization, collection, and URI fields case-insensitively', () => {
  const entries = parseRbwList(JSON.stringify([
    { id: '1', name: 'GitHub', user: 'octocat@example.com', folder: 'Work', uris: ['https://github.com/login'], type: 'login' },
    { id: '2', name: 'GitLab', user: 'other', folder: 'Personal', organization: 'Acme', collection: 'Production', uris: ['https://gitlab.com'], type: 'login' },
    { id: '3', name: 'Notes', user: null, folder: null, uris: [], type: 'note' },
  ])).value;
  const result = searchRbwEntries(entries, 'octocat', 'https://github.com/login');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((item) => [item.id, item.match, item.offItemOrigin]), [
    ['1', 'exact-origin', false],
  ]);
  // Folder search.
  const folder = searchRbwEntries(entries, 'personal', 'https://example.com');
  assert.equal(folder.ok, true);
  assert.deepEqual(folder.value.map((item) => item.id), ['2']);
  assert.deepEqual(searchRbwEntries(entries, 'acme production', 'https://example.com').value.map((item) => item.id), ['2']);
  // URI fragment search.
  const uri = searchRbwEntries(entries, 'gitlab.com', 'https://example.com');
  assert.equal(uri.ok, true);
  assert.equal(uri.value[0].id, '2');
  assert.equal(uri.value[0].match, 'search');
  assert.equal(uri.value[0].offItemOrigin, true);
});

test('searchRbwEntries ranks exact-origin before same-host before search and is deterministic', () => {
  const entries = parseRbwList(JSON.stringify([
    // Exact-origin: same origin as the page.
    { id: '1', name: 'Zeta Search', user: null, folder: null, uris: ['https://example.com'], type: 'login' },
    // Same-host: different port (same hostname) → same-host, not exact-origin.
    { id: '2', name: 'Beta Search', user: null, folder: null, uris: ['https://example.com:8443'], type: 'login' },
    // Search-only: no URI overlap with the page origin.
    { id: '3', name: 'Alpha Search', user: null, folder: null, uris: ['https://unrelated.com'], type: 'login' },
  ])).value;
  // A query that matches all three names ("search") so origin ranking decides order.
  const result = searchRbwEntries(entries, 'search', 'https://example.com/login');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map((item) => [item.id, item.match, item.offItemOrigin]), [
    ['1', 'exact-origin', false],
    ['2', 'same-host', true],
    ['3', 'search', true],
  ]);
});

test('searchRbwEntries requires all whitespace-split tokens and rejects empty queries', () => {
  const entries = parseRbwList(JSON.stringify([
    { id: '1', name: 'GitHub Work', user: 'octocat', folder: 'Work', uris: [], type: 'login' },
  ])).value;
  assert.equal(searchRbwEntries(entries, '', 'https://example.com').ok, false);
  assert.equal(searchRbwEntries(entries, '   ', 'https://example.com').ok, false);
  // Both tokens must match.
  assert.equal(searchRbwEntries(entries, 'github octocat', 'https://example.com').ok, true);
  assert.equal(searchRbwEntries(entries, 'github nonexistent', 'https://example.com').ok, false);
});

test('searchRbwEntries skips non-login types and never carries secret fields', () => {
  const entries = parseRbwList(JSON.stringify([
    // A note whose name also matches "secret" — must be skipped (non-login).
    { id: '1', name: 'Secret Note', user: null, folder: null, uris: [], type: 'note', password: 'must-not-leak' },
    // The login we expect to match; its name contains "secret" too.
    { id: '2', name: 'Secret Login', user: 'me', folder: null, uris: ['https://example.com'], type: 'login', password: 'must-not-leak' },
  ])).value;
  const result = searchRbwEntries(entries, 'secret', 'https://example.com');
  assert.equal(result.ok, true);
  // Only the login matches; the note is skipped.
  assert.deepEqual(result.value.map((item) => item.id), ['2']);
  // No secret-bearing fields are echoed on candidates.
  assert.ok(!('password' in result.value[0]));
  assert.ok(!('uris' in result.value[0]));
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
