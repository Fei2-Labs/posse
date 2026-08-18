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

const { extractCodexSubagentMetadata, codexSessionIsCompleted } = load('src/main/resumable-sessions.ts');

test('extracts Codex ACP parent and subagent metadata from a large session header', () => {
  const parent = '019fcc15-86ab-7bc1-891f-1b743367a462';
  const header = JSON.stringify({
    type: 'session_meta',
    payload: {
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parent,
            agent_role: 'trellis-implement',
            agent_path: '/root/parent/implement',
          },
        },
      },
    },
  });

  assert.deepEqual(extractCodexSubagentMetadata(header), {
    parentSessionId: parent,
    subagentRole: 'trellis-implement',
    subagentPath: '/root/parent/implement',
  });
});

test('does not invent parent metadata for ordinary Codex sessions', () => {
  assert.deepEqual(extractCodexSubagentMetadata(JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp' } })), {});
});

test('detects terminal task_complete events without treating ordinary output as finished', () => {
  const filename = path.join(require('node:os').tmpdir(), `posse-codex-status-${process.pid}.jsonl`);
  fs.writeFileSync(filename, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
  assert.equal(codexSessionIsCompleted(filename), true);
  fs.writeFileSync(filename, '{"type":"event_msg","payload":{"type":"agent_message"}}\n');
  assert.equal(codexSessionIsCompleted(filename), false);
  fs.writeFileSync(filename, '{"type":"response_item","payload":{"text":"the string task_complete is only mentioned here"}}\n');
  assert.equal(codexSessionIsCompleted(filename), false);
  fs.unlinkSync(filename);
});

test('renderer nests children and preserves full UUID identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
  assert.match(source, /function buildHistorySessionTree\(s: ClaudeHistorySession\)/);
  assert.match(source, /parentSessionId: session\.parentSessionId/);
  assert.match(source, /filter\(\(child\) => !child\.completed\)/);
  assert.match(source, /return `uuid:\$\{u\}`/);
  assert.doesNotMatch(source, /const m = u\.match\(\/\^\[0-9a-f\]\{8\}\//);
});

test('main project discovery removes terminal children before nesting', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(source, /agentMap\.get\('codex'\)\?\.filter\(\(session\) => !session\.parentSessionId \|\| !session\.completed\)/);
});
