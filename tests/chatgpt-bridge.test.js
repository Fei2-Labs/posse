// chatgpt-bridge.test.js — focused tests for issue #121 (posse chatgpt CLI + bridge)
//
// Coverage:
//   - Selector registry: bundled keys, override precedence, path-key reduction.
//   - BrowserOpsServer ownership API: acquireOwner/isOwner/releaseOwner, idle semantics,
//     bidirectional visibility (CLI sees ACP owner, ACP mutations see CLI owner).
//   - Controller public probe/reply methods (no private view cast, no arbitrary JS to CLI).
//   - Bridge service source contract: 0600 Unix socket, scoped ops only, no token leak.
//   - Completion detection signal chain + timeout.
//   - Reply extraction sanitization (text only, no secrets/cookies/DOM tree).
//   - chatId continuation contract (explicit --chat, --continue sugar, fresh chat).
//   - Job table: ask/wait/reply/read/cancel/jobs + detached jobs.
//   - CLI: posse chatgpt dispatcher, arg parsing, exit codes, prompt guard, --json.
//   - Security: no secrets/general token exposure to the CLI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const esbuild = require('esbuild');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const selectorsSource = source('src/main/chatgpt-selectors.ts');
const bridgeSource = source('src/main/chatgpt-bridge-service.ts');
const opsServerSource = source('src/main/browser-ops-server.ts');
const controllerSource = source('src/main/browser-controller.ts');
const cliSource = source('src/cli/posse-chatgpt.ts');
const dispatcherSource = source('src/cli/posse.ts');
const acpClientSource = source('src/main/acp-client.ts');
const indexSource = source('src/main/index.ts');
const pkg = JSON.parse(source('package.json'));

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}
const bridgeCode = stripComments(bridgeSource);
const cliCode = stripComments(cliSource);
const opsServerCode = stripComments(opsServerSource);
const controllerCode = stripComments(controllerSource);
const indexCode = stripComments(indexSource);
const acpClientCode = stripComments(acpClientSource);

// ---- Transpile-load the selectors module with a mocked 'electron' ----
function loadSelectorsModule(userDataDir) {
  const filename = path.join(__dirname, '..', 'src/main/chatgpt-selectors.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const fakeApp = { getPath: () => userDataDir };
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: fakeApp };
    return origLoad.call(this, request, parent, isMain);
  };
  loaded._compile(code, filename);
  Module._load = origLoad;
  return loaded.exports;
}

// ---- Build the bridge module with a mocked electron ----
function buildBridgeModule(userDataDir) {
  const entry = path.join(__dirname, '..', 'src/main/chatgpt-bridge-service.ts');
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    write: false,
    external: ['electron'],
    outfile: 'bridge-bundle.js',
  });
  const code = result.outputFiles[0].text;
  const filename = path.join(__dirname, '..', 'src/main/chatgpt-bridge-service.ts');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const fakeApp = { getPath: () => userDataDir };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: fakeApp };
    return origLoad.call(this, request, parent, isMain);
  };
  loaded._compile(code, filename);
  Module._load = origLoad;
  return loaded.exports;
}

// ---- Build the ops-server module with a mocked electron + stub manager ----
function buildOpsServerModule() {
  const entry = path.join(__dirname, '..', 'src/main/browser-ops-server.ts');
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    write: false,
    external: ['electron'],
    outfile: 'ops-bundle.js',
  });
  const code = result.outputFiles[0].text;
  const filename = path.join(__dirname, '..', 'src/main/browser-ops-server.ts');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const fakeApp = { getPath: () => os.tmpdir() };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: fakeApp };
    return origLoad.call(this, request, parent, isMain);
  };
  loaded._compile(code, filename);
  Module._load = origLoad;
  return loaded.exports;
}

// ============================================================================
// Selector registry
// ============================================================================

test('bundled registry exposes the documented logical selector names', () => {
  assert.match(selectorsSource, /composer/);
  assert.match(selectorsSource, /send_button/);
  assert.match(selectorsSource, /stop_button/);
  assert.match(selectorsSource, /assistant_message_last/);
  assert.match(selectorsSource, /assistant_message_all/);
  assert.match(selectorsSource, /login_indicator/);
  assert.match(selectorsSource, /role:\s*'textbox'/);
  assert.match(selectorsSource, /role_name:\s*'Send'/);
  assert.match(selectorsSource, /text:\s*'Stop'/);
});

test('urlPathKey reduces a URL to host + leading path segment', () => {
  const mod = loadSelectorsModule(os.tmpdir());
  assert.equal(mod.urlPathKey('https://chatgpt.com/'), 'chatgpt.com');
  assert.equal(mod.urlPathKey('https://chatgpt.com/c/abc123'), 'chatgpt.com/c');
  assert.equal(mod.urlPathKey('https://chatgpt.com/g/g-xyz'), 'chatgpt.com/g');
  assert.equal(mod.urlPathKey('https://www.chatgpt.com/?foo=bar'), 'chatgpt.com');
  assert.equal(mod.urlPathKey('about:blank'), 'default');
  assert.equal(mod.urlPathKey('not a url'), 'default');
});

test('resolveRegistry merges bundled + user overrides with override precedence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-sel-'));
  const overrideFile = path.join(tmp, 'chatgpt-selectors.json');
  fs.writeFileSync(overrideFile, JSON.stringify({
    default: { composer: { css: '#my-override-composer', role: 'textbox' } },
    'chatgpt.com/c': { send_button: { css: '[data-testid="custom-send"]' } },
  }), { mode: 0o600 });
  const mod = loadSelectorsModule(tmp);
  const root = mod.resolveRegistry('https://chatgpt.com/');
  assert.equal(root.composer.css, '#my-override-composer');
  assert.match(root.send_button.css, /data-testid="send-button"/);
  const chat = mod.resolveRegistry('https://chatgpt.com/c/abc');
  assert.equal(chat.send_button.css, '[data-testid="custom-send"]');
  assert.match(chat.stop_button.css, /data-testid="stop-button"/);
});

test('saveSelectorOverrides writes a 0600 file and loadSelectorOverrides is defensive', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-sel-'));
  const mod = loadSelectorsModule(tmp);
  mod.saveSelectorOverrides({ default: { composer: { css: '#x' } } });
  const stat = fs.statSync(path.join(tmp, 'chatgpt-selectors.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  fs.writeFileSync(path.join(tmp, 'chatgpt-selectors.json'), '{ not json', { mode: 0o600 });
  assert.deepEqual(mod.loadSelectorOverrides(), {});
});

// ============================================================================
// BrowserOpsServer ownership API (#109 integration)
// ============================================================================

test('BrowserOpsServer exposes acquireOwner, isOwner, releaseOwner, currentOwner', () => {
  assert.match(opsServerSource, /acquireOwner\(sessionId: string\): boolean/);
  assert.match(opsServerSource, /isOwner\(sessionId: string\): boolean/);
  assert.match(opsServerSource, /releaseOwner\(sessionId: string\): void/);
  assert.match(opsServerSource, /currentOwner\(\): string \| null/);
});

test('acquireOwner refuses when another session holds the lock; succeeds when free or same', () => {
  // Source-level: acquireOwnerInternal checks ownerSessionId !== sessionId => false.
  const acquireFn = opsServerSource.slice(
    opsServerSource.indexOf('const acquireOwnerInternal'),
    opsServerSource.indexOf('let server: http.Server'),
  );
  assert.match(acquireFn, /if \(ownerSessionId && ownerSessionId !== sessionId\) return false/);
  assert.match(acquireFn, /refreshOwnerTimer\(\)/);
  assert.match(acquireFn, /notifyOwnership\(\)/);
});

test('acquireOwner refreshes the idle timer so the CLI hold does not time out immediately', () => {
  const acquireFn = opsServerSource.slice(
    opsServerSource.indexOf('const acquireOwnerInternal'),
    opsServerSource.indexOf('let server: http.Server'),
  );
  assert.match(acquireFn, /refreshOwnerTimer\(\)/);
  // refreshOwnerTimer is the shared helper used by both the HTTP path and acquireOwner.
  assert.match(opsServerSource, /const refreshOwnerTimer = \(\) =>/);
  assert.match(opsServerSource, /Refresh the idle timer on every mutating call/);
});

test('bridge calls acquireOwner/releaseOwner directly on BrowserOpsServer (no shallow probe)', () => {
  assert.match(bridgeSource, /opsServer\.acquireOwner\(ownerSessionId\)/);
  assert.match(bridgeSource, /opsServer\.releaseOwner\(job\.ownerSessionId\)/);
  assert.match(bridgeSource, /opsServer\.currentOwner\(\)/);
  assert.match(bridgeSource, /OWNER_SESSION_PREFIX \+ jobId/);
  // No OwnershipProbe indirection remains.
  assert.doesNotMatch(bridgeSource, /OwnershipProbe/);
  assert.doesNotMatch(bridgeSource, /acquireForCli/);
});

test('index.ts passes browserOpsServer directly to startChatGptBridgeService', () => {
  assert.match(indexSource, /startChatGptBridgeService\(embeddedBrowserManager, browserOpsServer\)/);
  // No OwnershipProbe / chatgptOwnershipProbe.
  assert.doesNotMatch(indexSource, /OwnershipProbe/);
  assert.doesNotMatch(indexSource, /chatgptOwnershipProbe/);
});

test('real ops server: acquireOwner/isOwner/releaseOwner bidirectional visibility', async () => {
  const mod = buildOpsServerModule();
  const stubManager = { agentController: () => null };
  const server = await mod.startBrowserOpsServer(stubManager);
  assert.ok(server, 'ops server should start');

  // Initially free.
  assert.equal(server.currentOwner(), null);
  assert.equal(server.isOwner('posse-chatgpt-cli'), false);

  // CLI acquires.
  assert.equal(server.acquireOwner('posse-chatgpt-cli'), true);
  assert.equal(server.isOwner('posse-chatgpt-cli'), true);
  assert.equal(server.currentOwner(), 'posse-chatgpt-cli');

  // An ACP session cannot acquire while CLI holds.
  assert.equal(server.acquireOwner('acp-session-1'), false);
  assert.equal(server.currentOwner(), 'posse-chatgpt-cli');

  // CLI releases; ACP can now acquire.
  server.releaseOwner('posse-chatgpt-cli');
  assert.equal(server.currentOwner(), null);
  assert.equal(server.acquireOwner('acp-session-1'), true);
  assert.equal(server.currentOwner(), 'acp-session-1');

  // CLI cannot acquire while ACP holds.
  assert.equal(server.acquireOwner('posse-chatgpt-cli'), false);

  server.close();
});

test('real ops server: ownership change broadcasts on acquire and release', async () => {
  const mod = buildOpsServerModule();
  const stubManager = { agentController: () => null };
  const server = await mod.startBrowserOpsServer(stubManager);
  const events = [];
  server.onOwnershipChange((owner) => events.push(owner));

  server.acquireOwner('posse-chatgpt-cli');
  server.releaseOwner('posse-chatgpt-cli');

  // Should have broadcast the CLI label then null.
  assert.ok(events.includes('posse-chatgpt-cli'));
  assert.ok(events.includes(null));

  server.close();
});

// ============================================================================
// Controller public methods (no private view cast)
// ============================================================================

test('controller exposes agentRunChatgptProbe and agentExtractChatgptReply as public methods', () => {
  assert.match(controllerSource, /async agentRunChatgptProbe\(/);
  assert.match(controllerSource, /async agentExtractChatgptReply\(/);
  // Both return sanitized results: probe returns booleans/hashes; reply returns text only.
  assert.match(controllerSource, /ChatGptProbeResult/);
  assert.match(controllerSource, /text\?: string/);
});

test('bridge uses the public controller methods, not a private view cast', () => {
  assert.match(bridgeSource, /controller\.agentRunChatgptProbe\(/);
  assert.match(bridgeSource, /controller\.agentExtractChatgptReply\(/);
  // No private view/webContents cast remains.
  assert.doesNotMatch(bridgeCode, /as unknown as \{ view\?/);
  assert.doesNotMatch(bridgeCode, /executeJavaScriptInIsolatedWorld/);
});

test('the probe/reply scripts are FIXED in the controller — the CLI passes selector DATA not code', () => {
  // The script builders take selector entries (data) and JSON.stringify them — no code path
  // lets the CLI inject arbitrary JS.
  assert.match(controllerSource, /buildChatgptProbeScript\(selectors\)/);
  assert.match(controllerSource, /buildChatgptReplyScript\(selector\)/);
  assert.match(controllerSource, /const payload = JSON\.stringify\(selectors\)/);
  assert.match(controllerSource, /JSON\.stringify\(selector\)/);
  // The methods only accept selector entry objects, not strings.
  assert.match(controllerSource, /css\?: string; role\?: string/);
});

test('reply extraction script strips script/style and secret-attribute nodes', () => {
  assert.match(controllerSource, /tag === 'script' \|\| tag === 'style'/);
  assert.match(controllerSource, /SECRET_ATTR = \/secret\|token\|csrf\|nonce\/i/);
  assert.match(controllerSource, /NodeFilter\.SHOW_TEXT/);
});

// ============================================================================
// Bridge service source contract (security + scoping)
// ============================================================================

test('bridge uses a 0600 Unix domain socket on macOS/Linux, no bearer token for clients', () => {
  assert.match(bridgeSource, /net\.createServer/);
  assert.match(bridgeSource, /fs\.chmodSync\(socketPath, 0o600\)/);
  assert.match(bridgeSource, /POSSE_CHATGPT_SOCKET/);
  assert.match(bridgeSource, /posse-chatgpt\.sock/);
  assert.doesNotMatch(bridgeCode, /POSSE_BROWSER_OPS_TOKEN/);
  assert.doesNotMatch(bridgeCode, /require\(['"]\.\/browser-ops-server/);
});

test('bridge exposes ONLY ChatGPT ops — no general browser control to the CLI', () => {
  assert.match(bridgeSource, /op:\s*'ask'\s*\|\s*'wait'\s*\|\s*'reply'\s*\|\s*'read'\s*\|\s*'cancel'\s*\|\s*'jobs'\s*\|\s*'doctor'/);
  assert.match(bridgeSource, /'https:\/\/chatgpt\.com\/'/);
  assert.match(bridgeSource, /controller\.agentNavigate\(targetUrl\)/);
  assert.doesNotMatch(bridgeCode, /agentScreenshot/);
  assert.doesNotMatch(bridgeCode, /agentScroll/);
  assert.doesNotMatch(bridgeCode, /agentClick/);
});

test('no API / Codex / OpenAI / Playwright / Cavendish fallback exists in code', () => {
  assert.doesNotMatch(bridgeCode, /require\(['"]openai|from ['"]openai|api\.openai\.com/i);
  assert.doesNotMatch(bridgeCode, /require\(['"]playwright|from ['"]playwright/i);
  assert.doesNotMatch(cliCode, /require\(['"]openai|from ['"]openai|api\.openai\.com/i);
  assert.doesNotMatch(cliCode, /require\(['"]playwright|from ['"]playwright/i);
  assert.match(cliSource, /No API\/Codex fallback exists; web-only/);
  assert.doesNotMatch(bridgeCode, /fetch\(['"]https?:\/\/(api\.openai|chatgpt\.com\/api|codex)/i);
});

test('no other Chrome / separate browser profile is launched', () => {
  assert.doesNotMatch(bridgeSource, /puppeteer|chrome\.launch|chromium|new BrowserWindow/i);
  assert.doesNotMatch(cliSource, /puppeteer|chrome\.launch|chromium/i);
  assert.doesNotMatch(bridgeSource, /session\.fromPartition/);
});

test('reply extraction is text-only and sanitized — no DOM tree, cookies, or secrets', () => {
  assert.doesNotMatch(cliCode, /cookie|authorization|Bearer|localStorage|sessionStorage/i);
  assert.doesNotMatch(cliCode, /process\.env\.POSSE_BROWSER_OPS/);
  assert.doesNotMatch(cliCode, /POSSE_BROWSER_OPS_TOKEN/);
  const tokenAssigns = cliCode.match(/req\.token\s*=\s*[^;]+/g) || [];
  for (const a of tokenAssigns) {
    assert.match(a, /lb\.token/, `CLI assigns req.token from a non-loopback source: ${a}`);
  }
});

// ============================================================================
// Completion detection signal chain
// ============================================================================

test('completion detection uses new-turn, copy-button, stability, and streaming signals', () => {
  assert.match(bridgeSource, /probe\.stopVisible/);
  assert.match(bridgeSource, /probe\.composerEnabled/);
  assert.match(bridgeSource, /probe\.sendEnabled/);
  assert.match(bridgeSource, /probe\.copyVisible/);
  assert.match(bridgeSource, /probe\.assistantCount > job\.baselineAssistantCount/);
  assert.match(bridgeSource, /probe\.lastTextHash !== job\.baselineHash/);
  assert.match(bridgeSource, /COMPLETION_STABILITY_POLLS/);
  assert.match(bridgeSource, /stablePolls/);
  assert.match(bridgeSource, /COMPLETION_TIMEOUT_MS/);
  assert.match(bridgeSource, /reply_timeout/);
});

test('each ChatGPT job owns the shared browser under a unique lock id and renews its lease', () => {
  assert.match(bridgeSource, /const ownerSessionId = OWNER_SESSION_PREFIX \+ jobId/);
  assert.match(bridgeSource, /ownerSessionId,/);
  assert.match(bridgeSource, /opsServer\.acquireOwner\(job\.ownerSessionId\)/);
  assert.match(bridgeSource, /opsServer\.releaseOwner\(job\.ownerSessionId\)/);
});

test('login detection uses positive authenticated indicators, never the Log in affordance', () => {
  const loginBlock = selectorsSource.slice(selectorsSource.indexOf('login_indicator:'), selectorsSource.indexOf('\n    },', selectorsSource.indexOf('login_indicator:')));
  assert.match(loginBlock, /New chat|profile-button/);
  assert.doesNotMatch(loginBlock, /text:\s*'Log in'/);
});

// ============================================================================
// chatId continuation contract
// ============================================================================

test('ask captures chatId from the URL after completion and returns it', () => {
  assert.match(bridgeSource, /extractChatId/);
  assert.match(bridgeSource, /job\.chatId = extractChatId\(controller\.agentState\(\)\.url\) \|\| job\.chatId/);
  // The ask response includes chatId.
  assert.match(bridgeSource, /return \{ ok: true, jobId, reply: job\.reply, status: job\.status, chatId: job\.chatId \}/);
});

test('ask with explicit chatId navigates to that conversation; --continue reuses last chatId', () => {
  // Explicit chatId -> navigate to /c/<chatId>.
  assert.match(bridgeSource, /targetChatId = req\.chatId/);
  assert.match(bridgeSource, /targetUrl = targetChatId \? `https:\/\/chatgpt\.com\/c\/\$\{targetChatId\}` : 'https:\/\/chatgpt\.com\/'/);
  // --continue finds the most recent done job's chatId.
  assert.match(bridgeSource, /req\.continue/);
  assert.match(bridgeSource, /j\.status === 'done' && j\.chatId/);
});

test('wait/reply/read/jobs all surface chatId in their responses', () => {
  assert.match(bridgeSource, /return \{ ok: true, jobId, status: 'done', reply: job\.reply, chatId: job\.chatId \}/);
  const replyFn = bridgeSource.slice(bridgeSource.indexOf('async function reply('), bridgeSource.indexOf('async function readOp'));
  assert.match(replyFn, /chatId: job\.chatId/);
  const readFn = bridgeSource.slice(bridgeSource.indexOf('async function readOp'), bridgeSource.indexOf('async function cancel'));
  assert.match(readFn, /chatId: job\.chatId/);
  const jobsFn = bridgeSource.slice(bridgeSource.indexOf('async function listJobs'), bridgeSource.indexOf('function sleep'));
  assert.match(jobsFn, /chatId: j\.chatId/);
});

test('CLI parses --chat <id> and --continue and passes chatId in the request', () => {
  assert.match(cliSource, /'--chat'/);
  assert.match(cliSource, /req\.chatId = args\.chatId/);
  assert.match(cliSource, /chatId = rest\[chatIdx \+ 1\]/);
  // Usage documents the continuation contract.
  assert.match(cliSource, /--chat <id>\s+\(ask only\) Continue the conversation with this chatId/);
  assert.match(cliSource, /Continuation contract:/);
});

// ============================================================================
// Job table + commands
// ============================================================================

test('job table supports ask/wait/reply/read/cancel/jobs with detached jobs', () => {
  assert.match(bridgeSource, /interface ChatGptJob/);
  assert.match(bridgeSource, /status: 'streaming' \| 'done' \| 'cancelled' \| 'error'/);
  assert.match(bridgeSource, /if \(req\.detach\)/);
  assert.match(bridgeSource, /return \{ ok: true, jobId, status: 'streaming'/);
});

test('cancel best-effort stop-generation probes for the stop button before sending Escape', () => {
  const cancelFn = bridgeSource.slice(bridgeSource.indexOf('async function cancel('), bridgeSource.indexOf('async function listJobs'));
  assert.match(cancelFn, /job\.controller\.agentRunChatgptProbe/);
  assert.match(cancelFn, /probeResult\.probe\?\.stopVisible/);
  assert.match(cancelFn, /agentKeypress\('Escape'\)/);
});

// ============================================================================
// CLI dispatcher + arg parsing + exit codes
// ============================================================================

test('posse dispatcher routes chatgpt subcommand to posse-chatgpt.js', () => {
  assert.match(dispatcherSource, /if \(sub === 'chatgpt'\)/);
  assert.match(dispatcherSource, /path\.join\(__dirname, 'posse-chatgpt\.js'\)/);
  assert.match(dispatcherSource, /spawn\(process\.execPath, \[cliPath/);
});

test('package.json registers both posse and posse-chatgpt bins', () => {
  assert.equal(pkg.bin.posse, 'dist/cli/posse.js');
  assert.equal(pkg.bin['posse-chatgpt'], 'dist/cli/posse-chatgpt.js');
  assert.equal(pkg.scripts['build:chatgpt-cli'], 'esbuild src/cli/posse-chatgpt.ts --bundle --outfile=dist/cli/posse-chatgpt.js --platform=node --target=node20');
  assert.equal(pkg.scripts['build:posse-cli'], 'esbuild src/cli/posse.ts --bundle --outfile=dist/cli/posse.js --platform=node --target=node20');
  assert.match(pkg.scripts['build:ts'], /build:chatgpt-cli/);
  assert.match(pkg.scripts['build:ts'], /build:posse-cli/);
  assert.equal(pkg.scripts['test'], 'node --test tests/');
  assert.match(dispatcherSource, /^#!\/usr\/bin\/env node/);
  assert.match(cliSource, /^#!\/usr\/bin\/env node/);
});

test('mac installer exposes packaged posse CLI without a separate Node runtime', () => {
  const installer = source('scripts/install-to-applications.sh');
  assert.match(installer, /\.local\/bin/);
  assert.match(installer, /ELECTRON_RUN_AS_NODE=1 exec/);
  assert.match(installer, /app\.asar\/dist\/cli\/posse\.js/);
  assert.match(installer, /preserving existing non-Posse command/);
});

test('app pre-creates and recreates the built-in browser controller for CLI use', () => {
  assert.match(indexSource, /embeddedBrowserManager\.controllerFor\(mainWindow\)/);
  assert.match(indexSource, /embeddedBrowserManager\?\.controllerFor\(win\)/);
});

test('CLI exit codes map to documented values', () => {
  const exitBlock = cliSource.slice(cliSource.indexOf('const EXIT = {'), cliSource.indexOf('} as const;', cliSource.indexOf('const EXIT = {')));
  assert.match(exitBlock, /not_running: 3/);
  assert.match(exitBlock, /not_logged_in: 5/);
  assert.match(exitBlock, /selectors_stale: 6/);
  assert.match(exitBlock, /reply_timeout: 8/);
  assert.match(exitBlock, /busy: 11/);
  assert.match(exitBlock, /prompt_too_large: 12/);
  assert.match(exitBlock, /job_not_found: 15/);
});

test('CLI prompt-too-large guard fires before connecting', () => {
  assert.match(cliSource, /MAX_PROMPT_BYTES = 256 \* 1024/);
  assert.match(cliSource, /code: 'prompt_too_large'/);
  assert.match(cliSource, /process\.exit\(EXIT\.prompt_too_large\)/);
});

test('CLI blocking ops use a longer socket timeout than non-blocking', () => {
  assert.match(cliSource, /isBlocking = req\.op === 'ask' \|\| req\.op === 'wait'/);
  assert.match(cliSource, /timeoutMs = isBlocking \? 6 \* 60 \* 1000 : 10_000/);
});

test('all-agent guidance injects ChatGPT CLI instructions + continuation + no-silent-fallback', () => {
  const block = acpClientSource.slice(acpClientSource.indexOf('[ChatGPT delegation (issue #121)]'), acpClientSource.indexOf('function loadAcpSdk'));
  assert.match(block, /posse chatgpt ask/);
  assert.match(block, /posse chatgpt doctor/);
  assert.match(block, /--json/);
  assert.match(block, /--chat <chatId>/);
  assert.match(block, /Never silently fall back to another model or an API/);
});

// ============================================================================
// Real socket protocol integration tests
// ============================================================================

test('real Unix socket: doctor op returns a structured response over the line protocol', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubManager = { agentController: () => null };
    const stubOps = { currentOwner: () => null, acquireOwner: () => true, releaseOwner: () => {}, isOwner: () => false, onOwnershipChange: () => {}, close: () => {} };
    const bridge = await mod.startChatGptBridgeService(stubManager, stubOps);
    assert.ok(bridge);
    assert.equal(bridge.address, sockPath);

    const response = await sendOne(sockPath, { op: 'doctor' });
    assert.equal(response.ok, true);
    assert.equal(response.posseRunning, true);
    assert.equal(response.chatgptLoggedIn, false);

    bridge.close();
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('real Unix socket: ask with no browser returns not_running; unknown op returns unknown_op', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubManager = { agentController: () => null };
    const stubOps = { currentOwner: () => null, acquireOwner: () => true, releaseOwner: () => {}, isOwner: () => false, onOwnershipChange: () => {}, close: () => {} };
    const bridge = await mod.startChatGptBridgeService(stubManager, stubOps);
    assert.ok(bridge);

    const askResp = await sendOne(sockPath, { op: 'ask', prompt: 'hello' });
    assert.equal(askResp.ok, false);
    assert.equal(askResp.code, 'not_running');

    const unknownResp = await sendOne(sockPath, { op: 'bogus' });
    assert.equal(unknownResp.ok, false);
    assert.equal(unknownResp.code, 'unknown_op');

    const badJsonResp = await sendOne(sockPath, { op: 'ask' });
    assert.equal(badJsonResp.ok, false);
    assert.equal(badJsonResp.code, 'bad_request');

    bridge.close();
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('real Unix socket: ownership conflict returns busy when another session holds the browser', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubController = {
      agentState: () => ({ url: 'https://chatgpt.com/', title: 'ChatGPT', isLoading: false, canGoBack: false, canGoForward: false, security: 'secure' }),
      agentNavigate: async () => ({ ok: true }),
      agentType: async () => ({ ok: true }),
      agentKeypress: async () => ({ ok: true }),
    };
    const stubManager = { agentController: () => stubController };
    const heldOps = {
      currentOwner: () => 'acp-session-abc',
      acquireOwner: () => false,
      releaseOwner: () => {},
      isOwner: () => false,
      onOwnershipChange: () => {},
      close: () => {},
    };
    const bridge = await mod.startChatGptBridgeService(stubManager, heldOps);
    assert.ok(bridge);

    const resp = await sendOne(sockPath, { op: 'ask', prompt: 'hi' });
    assert.equal(resp.ok, false);
    assert.equal(resp.code, 'busy');
    assert.match(resp.error, /acp-session-abc/);

    bridge.close();
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('real Unix socket: jobs/list + wait/reply/read/cancel on a non-existent job', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubManager = { agentController: () => null };
    const stubOps = { currentOwner: () => null, acquireOwner: () => true, releaseOwner: () => {}, isOwner: () => false, onOwnershipChange: () => {}, close: () => {} };
    const bridge = await mod.startChatGptBridgeService(stubManager, stubOps);
    assert.ok(bridge);

    const jobsResp = await sendOne(sockPath, { op: 'jobs' });
    assert.equal(jobsResp.ok, true);
    assert.deepEqual(jobsResp.jobs, []);

    const waitResp = await sendOne(sockPath, { op: 'wait', jobId: 'nope' });
    assert.equal(waitResp.ok, false);
    assert.equal(waitResp.code, 'job_not_found');

    const cancelResp = await sendOne(sockPath, { op: 'cancel', jobId: 'nope' });
    assert.equal(cancelResp.ok, false);
    assert.equal(cancelResp.code, 'job_not_found');

    bridge.close();
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('socket file is created with 0600 perms and removed on close', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubManager = { agentController: () => null };
    const stubOps = { currentOwner: () => null, acquireOwner: () => true, releaseOwner: () => {}, isOwner: () => false, onOwnershipChange: () => {}, close: () => {} };
    const bridge = await mod.startChatGptBridgeService(stubManager, stubOps);
    assert.ok(bridge);

    const stat = fs.statSync(sockPath);
    assert.equal(stat.mode & 0o777, 0o600);

    bridge.close();
    assert.ok(!fs.existsSync(sockPath));
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('line buffer bounds a misbehaving client and rejects oversized prompts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posse-bridge-'));
  const sockPath = path.join(tmp, 'posse-chatgpt.sock');
  process.env.POSSE_CHATGPT_SOCKET = sockPath;
  try {
    const mod = buildBridgeModule(tmp);
    const stubManager = { agentController: () => null };
    const stubOps = { currentOwner: () => null, acquireOwner: () => true, releaseOwner: () => {}, isOwner: () => false, onOwnershipChange: () => {}, close: () => {} };
    const bridge = await mod.startChatGptBridgeService(stubManager, stubOps);
    assert.ok(bridge);

    const big = 'x'.repeat(300000);
    const resp = await sendOne(sockPath, { op: 'ask', prompt: big });
    assert.equal(resp.ok, false);
    assert.equal(resp.code, 'prompt_too_large');

    bridge.close();
  } finally {
    delete process.env.POSSE_CHATGPT_SOCKET;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ============================================================================
// CLI smoke tests (bundled output)
// ============================================================================

test('posse chatgpt help via dispatcher exits 0', () => {
  const { spawnSync } = require('node:child_process');
  const dispatcherPath = path.join(__dirname, '..', 'dist', 'cli', 'posse.js');
  if (!fs.existsSync(dispatcherPath)) return;
  const res = spawnSync(process.execPath, [dispatcherPath, 'chatgpt', 'help'], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /posse chatgpt — delegate a sub-task to ChatGPT/);
  assert.match(res.stderr, /posse chatgpt ask/);
  assert.match(res.stderr, /--chat <id>/);
});

test('posse chatgpt doctor via dispatcher exits 3 when Posse not running', () => {
  const { spawnSync } = require('node:child_process');
  const dispatcherPath = path.join(__dirname, '..', 'dist', 'cli', 'posse.js');
  if (!fs.existsSync(dispatcherPath)) return;
  const res = spawnSync(process.execPath, [dispatcherPath, 'chatgpt', 'doctor'], {
    encoding: 'utf-8',
    env: { ...process.env, POSSE_CHATGPT_SOCKET: '/tmp/posse-not-here-' + Date.now() + '.sock' },
  });
  assert.equal(res.status, 3);
  const combined = res.stdout + res.stderr;
  assert.match(combined, /Posse is not running/);
});

test('posse-chatgpt alias still works directly', () => {
  const { spawnSync } = require('node:child_process');
  const cliPath = path.join(__dirname, '..', 'dist', 'cli', 'posse-chatgpt.js');
  if (!fs.existsSync(cliPath)) return;
  const res = spawnSync(process.execPath, [cliPath, 'help'], { encoding: 'utf-8' });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /posse chatgpt — delegate a sub-task to ChatGPT/);
});

// ---- helper ----

function sendOne(sockPath, req) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let resolved = false;
    socket.setEncoding('utf-8');
    socket.setTimeout(5000);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl >= 0 && !resolved) {
        const line = buffer.slice(0, nl);
        resolved = true;
        try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
        socket.destroy();
      }
    });
    socket.on('error', (err) => { if (!resolved) { resolved = true; reject(err); } });
    socket.on('timeout', () => { if (!resolved) { resolved = true; reject(new Error('timeout')); socket.destroy(); } });
    socket.connect(sockPath, () => { socket.write(JSON.stringify(req) + '\n'); });
  });
}
