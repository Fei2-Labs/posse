const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadAcpClientModule() {
  const filename = path.join(__dirname, '..', 'src/main/acp-client.ts');
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
  AcpReplayBuffer,
  getAcpCommand,
  isAcpEligible,
  preferredFullAccessConfig,
  preferredAllowPermission,
} = loadAcpClientModule();
const acpClientSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/acp-client.ts'), 'utf8');

test('routes exact built-in presets to ACP', () => {
  const presets = [
    'claude --dangerously-skip-permissions',
    'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"',
    'copilot --allow-all --autopilot',
    'copilot',
    'kiro-cli chat --trust-all-tools',
    'opencode',
    'codex',
  ];

  for (const preset of presets) {
    assert.equal(isAcpEligible(preset), true, preset);
    assert.ok(getAcpCommand(preset), preset);
  }
});

test('routes noisy built-in history resume commands to ACP', () => {
  const commands = [
    'claude --dangerously-skip-permissions --dangerously-skip-permissions --resume 82694dd5 --resume 82694dd5 --resume 82694dd5',
    'claude --resume 82694dd5',
    'codex resume 82694dd5',
    'copilot --allow-all --autopilot --resume 82694dd5',
    'kiro-cli chat --trust-all-tools --resume-id 82694dd5',
  ];
  for (const command of commands) assert.equal(isAcpEligible(command), true, command);
});

test('keeps custom presets and wrappers on the PTY path', () => {
  const presets = [
    'claude --proxy http://localhost:8080',
    'codex --custom-profile work',
    'ssh host claude --dangerously-skip-permissions',
    'claude --proxy http://localhost:8080 --resume 82694dd5',
    'copilot --allow-all --resume 82694dd5 --custom-profile work',
    '/usr/local/bin/opencode acp',
    'devin --permission-mode dangerous',
    '',
  ];

  for (const preset of presets) {
    assert.equal(isAcpEligible(preset), false, preset);
  }
});

test('maps built-in presets to the verified ACP adapter commands', () => {
  assert.deepEqual(getAcpCommand('claude --dangerously-skip-permissions'), {
    cmd: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  });
  assert.deepEqual(getAcpCommand('copilot --allow-all --autopilot'), {
    cmd: 'copilot',
    args: ['--acp'],
  });
});

test('selects each adapter\'s highest supported access mode', () => {
  assert.deepEqual(preferredFullAccessConfig([{
    id: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default' },
      { value: 'bypassPermissions', name: 'Bypass permissions' },
    ],
  }]), { configId: 'mode', value: 'bypassPermissions' });

  assert.deepEqual(preferredFullAccessConfig([{
    id: 'mode', type: 'select', currentValue: 'agent', options: [
      { value: 'read-only', name: 'Read-only' },
      { value: 'agent', name: 'Agent' },
      { value: 'agent-full-access', name: 'Agent (full access)' },
    ],
  }]), { configId: 'mode', value: 'agent-full-access' });

  assert.deepEqual(preferredFullAccessConfig([{
    id: 'mode', type: 'select', currentValue: 'agent', options: [
      { value: 'agent', name: 'Agent' },
      { value: 'autopilot', name: 'Autopilot', description: 'Enables allow-all' },
    ],
  }]), { configId: 'mode', value: 'autopilot' });

  assert.equal(preferredFullAccessConfig([]), null);
});

test('defaults permission fallbacks to always allow, then allow once', () => {
  assert.equal(preferredAllowPermission([
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  ])?.optionId, 'always');
  assert.equal(preferredAllowPermission([
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
  ])?.optionId, 'once');
});

test('applies default full access to both new and resumed ACP sessions', () => {
  const calls = acpClientSource.match(/await this\.applyDefaultFullAccess\(id, info\);/g) || [];
  assert.equal(calls.length, 2);
});

test('ACP replay buffer preserves update order across incremental drains', () => {
  const buffer = new AcpReplayBuffer();
  const first = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } };
  const second = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } };
  const third = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'third' } };

  buffer.capture(first);
  buffer.capture(second);
  assert.deepEqual(buffer.take(), [first, second]);
  assert.deepEqual(buffer.take(), []);

  buffer.capture(third);
  assert.deepEqual(buffer.take(), [third]);
});

test('app shutdown destroys ACP processes without reporting user-initiated closes', () => {
  const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/acp-client.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(managerSource, /destroyAll\(notify = true\)/);
  assert.match(managerSource, /this\.destroy\(id, notify\)/);
  assert.match(mainSource, /acpManager\.destroyAll\(false\)/);
});
