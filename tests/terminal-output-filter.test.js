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

const FOREGROUND = '10;rgb:d8d8/dede/e9e9';
const BACKGROUND = '11;rgb:2e2e/3434/4040';

test('removes complete bare OSC color responses while preserving surrounding output', () => {
  const { BareOscColorResponseFilter } = loadTypeScriptModule('src/renderer/terminal-output-filter.ts');
  const filter = new BareOscColorResponseFilter();

  assert.equal(
    filter.write(`before${FOREGROUND}${BACKGROUND}after`),
    'beforeafter',
  );
  assert.equal(filter.drain(), '');
});

test('reassembles bare OSC color responses across every chunk boundary', () => {
  const { BareOscColorResponseFilter } = loadTypeScriptModule('src/renderer/terminal-output-filter.ts');

  for (const token of [FOREGROUND, BACKGROUND]) {
    for (let split = 1; split < token.length; split += 1) {
      const filter = new BareOscColorResponseFilter();
      const output = filter.write(`before${token.slice(0, split)}`)
        + filter.write(`${token.slice(split)}after`)
        + filter.drain();
      assert.equal(output, 'beforeafter', `${token.slice(0, 2)} split at ${split}`);
    }
  }

  const oneCharacterChunks = [...`${FOREGROUND}${BACKGROUND}`];
  const filter = new BareOscColorResponseFilter();
  assert.equal(oneCharacterChunks.map(chunk => filter.write(chunk)).join('') + filter.drain(), '');
});

test('preserves malformed lookalikes and drains incomplete candidates', () => {
  const { BareOscColorResponseFilter } = loadTypeScriptModule('src/renderer/terminal-output-filter.ts');
  const filter = new BareOscColorResponseFilter();

  assert.equal(filter.write('normal rgb:abcd and 10;rgb:zzzz/0000/1111X'), 'normal rgb:abcd and 10;rgb:zzzz/0000/1111X');
  assert.equal(filter.write(' tail 10;rgb:d8d8/dede'), ' tail ');
  assert.equal(filter.drain(), '10;rgb:d8d8/dede');
});

test('preserves wrapped OSC color responses for xterm to parse', () => {
  const { BareOscColorResponseFilter } = loadTypeScriptModule('src/renderer/terminal-output-filter.ts');
  const sequences = [
    `\x1b]${FOREGROUND}\x07`,
    `\x1b]${BACKGROUND}\x1b\\`,
    `\x9d${FOREGROUND}\x9c`,
  ];

  for (const sequence of sequences) {
    for (let split = 1; split < sequence.length; split += 1) {
      const filter = new BareOscColorResponseFilter();
      const output = filter.write(sequence.slice(0, split))
        + filter.write(sequence.slice(split))
        + filter.drain();
      assert.equal(output, sequence, `wrapped sequence split at ${split}`);
    }
  }
});
