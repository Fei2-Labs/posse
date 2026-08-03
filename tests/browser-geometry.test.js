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

const { scaleAndClampBrowserBounds } = load('src/main/browser-geometry.ts');

test('scales CSS bounds by page zoom and clamps edges', () => {
  assert.deepEqual(scaleAndClampBrowserBounds({ x: 10, y: 20, width: 100, height: 50, visible: true }, 1.5, { width: 300, height: 200 }), {
    x: 15, y: 30, width: 150, height: 75,
  });
  assert.deepEqual(scaleAndClampBrowserBounds({ x: -10, y: 20, width: 260, height: 200, visible: true }, 2, { width: 300, height: 200 }), {
    x: 0, y: 40, width: 300, height: 160,
  });
});

test('hides empty or zero-sized native views', () => {
  assert.equal(scaleAndClampBrowserBounds({ x: 0, y: 0, width: 0, height: 20, visible: true }, 1, { width: 100, height: 100 }), null);
  assert.equal(scaleAndClampBrowserBounds({ x: 0, y: 0, width: 20, height: 20, visible: false }, 1, { width: 100, height: 100 }), null);
});
