const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', output)(mod, mod.exports, require);
  return mod.exports;
}

const { normalizeBrowserUrl, browserSecurityState } = loadTypeScriptModule('src/main/browser-url.ts');

test('normalizes local development addresses to HTTP', () => {
  assert.deepEqual(normalizeBrowserUrl('localhost:3000/test'), { ok: true, url: 'http://localhost:3000/test' });
  assert.deepEqual(normalizeBrowserUrl('127.0.0.1:5173'), { ok: true, url: 'http://127.0.0.1:5173/' });
  assert.deepEqual(normalizeBrowserUrl('10.20.30.40:8080'), { ok: true, url: 'http://10.20.30.40:8080/' });
  assert.deepEqual(normalizeBrowserUrl('192.168.1.20/app'), { ok: true, url: 'http://192.168.1.20/app' });
  assert.deepEqual(normalizeBrowserUrl('172.20.1.4'), { ok: true, url: 'http://172.20.1.4/' });
});

test('normalizes public hosts to HTTPS and preserves explicit HTTP(S) URLs', () => {
  assert.deepEqual(normalizeBrowserUrl('example.com/path?q=1'), { ok: true, url: 'https://example.com/path?q=1' });
  assert.deepEqual(normalizeBrowserUrl('https://example.com/a'), { ok: true, url: 'https://example.com/a' });
  assert.deepEqual(normalizeBrowserUrl('http://example.com'), { ok: true, url: 'http://example.com/' });
});

test('rejects unsupported, credential-bearing, empty, and invalid URLs', () => {
  for (const input of ['', 'javascript:alert(1)', 'file:///tmp/test', 'ftp://example.com', 'https://user:pass@example.com']) {
    assert.equal(normalizeBrowserUrl(input).ok, false, input);
  }
});

test('reports secure, local, insecure, and neutral page states', () => {
  assert.equal(browserSecurityState('https://example.com'), 'secure');
  assert.equal(browserSecurityState('http://localhost:3000'), 'local');
  assert.equal(browserSecurityState('http://10.1.2.3'), 'local');
  assert.equal(browserSecurityState('http://192.168.1.20'), 'local');
  assert.equal(browserSecurityState('http://172.16.4.2'), 'local');
  assert.equal(browserSecurityState('http://example.com'), 'insecure');
  assert.equal(browserSecurityState('about:blank'), 'neutral');
  assert.equal(browserSecurityState('not a url'), 'neutral');
});
