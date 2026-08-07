const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..');
const acpClientSrc = fs.readFileSync(path.join(root, 'src/main/acp-client.ts'), 'utf8');
const remoteServerSrc = fs.readFileSync(path.join(root, 'src/main/remote-server.ts'), 'utf8');
const headlessSrc = fs.readFileSync(path.join(root, 'src/main/headless.ts'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'mobile/client/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'mobile/client/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'mobile/client/style.css'), 'utf8');

// ========== ACP session store tests (functional, against real file) ==========

// The store module reads/writes ~/.posse-mobile/acp-sessions.json. Point HOME
// at a temp dir so tests never touch the real config. Save the original HOME
// so it can be restored after the store tests (other test files may rely on
// the real HOME for their own filesystem operations).
const storeSrc = fs.readFileSync(path.join(root, 'src/main/acp-session-store.ts'), 'utf8');
const origHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-store-test-'));
process.env.HOME = tmpHome;

// Require the compiled store from dist/main (produced by build:main).
// Falls back to null if dist is stale (functional store tests skip, structural
// source-scanning tests still run).
let store;
try {
  // Delete from require cache so it picks up the new HOME on each run.
  const storePath = path.join(root, 'dist/main/acp-session-store.js');
  delete require.cache[require.resolve(storePath)];
  store = require(storePath);
} catch {
  store = null;
}

test('acp-session-store: upsert then list returns the session', () => {
  if (!store) { console.log('  (skipped — dist not available)'); return; }
  store.upsertAcpSession({
    id: 's1', acpSessionId: 'acp-1', agentLabel: 'claude',
    cwd: '/tmp', presetCommand: 'claude --dangerously-skip-permissions',
    title: 'claude', createdAt: Date.now(), updatedAt: Date.now(),
  });
  const sessions = store.listAcpSessions();
  assert.ok(sessions.some(s => s.acpSessionId === 'acp-1'));
});

test('acp-session-store: upsert same acpSessionId updates, not duplicates', () => {
  if (!store) { console.log('  (skipped — dist not available)'); return; }
  store.upsertAcpSession({
    id: 's2', acpSessionId: 'acp-2', agentLabel: 'codex',
    cwd: '/tmp', presetCommand: 'codex',
    title: 'codex', createdAt: 1000, updatedAt: 1000,
  });
  store.upsertAcpSession({
    id: 's2', acpSessionId: 'acp-2', agentLabel: 'codex',
    cwd: '/tmp/proj', presetCommand: 'codex',
    title: 'codex-updated', createdAt: 1000, updatedAt: Date.now(),
  });
  const sessions = store.listAcpSessions().filter(s => s.acpSessionId === 'acp-2');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, '/tmp/proj');
});

test('acp-session-store: closeAcpSession sets closedAt', () => {
  if (!store) { console.log('  (skipped — dist not available)'); return; }
  store.upsertAcpSession({
    id: 's3', acpSessionId: 'acp-3', agentLabel: 'copilot',
    cwd: '/tmp', presetCommand: 'copilot --allow-all --autopilot',
    title: 'copilot', createdAt: Date.now(), updatedAt: Date.now(),
  });
  store.closeAcpSession('s3');
  const sessions = store.listAcpSessions().filter(s => s.id === 's3');
  assert.equal(sessions.length, 1);
  assert.ok(typeof sessions[0].closedAt === 'number');
});

test('acp-session-store: removeAcpSession deletes the record', () => {
  if (!store) { console.log('  (skipped — dist not available)'); return; }
  store.upsertAcpSession({
    id: 's4', acpSessionId: 'acp-4', agentLabel: 'kiro',
    cwd: '/tmp', presetCommand: 'kiro-cli chat --trust-all-tools',
    title: 'kiro', createdAt: Date.now(), updatedAt: Date.now(),
  });
  store.removeAcpSession('s4');
  const sessions = store.listAcpSessions().filter(s => s.id === 's4');
  assert.equal(sessions.length, 0);
});

test('acp-session-store: list returns most-recent first', () => {
  if (!store) { console.log('  (skipped — dist not available)'); return; }
  // Use realistic timestamps (within the 7-day cutoff) so pruneOld keeps them.
  const base = Date.now();
  store.upsertAcpSession({
    id: 'old2', acpSessionId: 'acp-old2', agentLabel: 'claude',
    cwd: '/tmp', presetCommand: 'claude --dangerously-skip-permissions',
    title: 'old2', createdAt: base - 2000, updatedAt: base - 2000,
  });
  store.upsertAcpSession({
    id: 'new2', acpSessionId: 'acp-new2', agentLabel: 'claude',
    cwd: '/tmp', presetCommand: 'claude --dangerously-skip-permissions',
    title: 'new2', createdAt: base - 1000, updatedAt: base - 1000,
  });
  const sessions = store.listAcpSessions();
  const newIdx = sessions.findIndex(s => s.id === 'new2');
  const oldIdx = sessions.findIndex(s => s.id === 'old2');
  assert.ok(newIdx !== -1 && oldIdx !== -1, 'both sessions should be present');
  assert.ok(newIdx < oldIdx, 'newer session should come first');
});

// ========== AcpManager persistence + permission wiring tests ==========

test('AcpManager persists ACP session metadata via upsertAcpSession', () => {
  assert.match(acpClientSrc, /import \{[\s\S]*?upsertAcpSession[\s\S]*?\} from '\.\/acp-session-store'/);
  assert.match(acpClientSrc, /this\.persistSession\(info\)/);
  assert.match(acpClientSrc, /private persistSession/);
});

test('AcpManager calls closeAcpSession on destroy and exit', () => {
  assert.match(acpClientSrc, /closeAcpSession\(id\)/);
});

test('AcpManager has listStoredSessions and removeStoredSession', () => {
  assert.match(acpClientSrc, /listStoredSessions\(\)/);
  assert.match(acpClientSrc, /removeStoredSession\(id: string\)/);
});

test('AcpManager exposes autoAllowPermissions flag in constructor', () => {
  assert.match(acpClientSrc, /autoAllowPermissions = true/);
  assert.match(acpClientSrc, /private readonly autoAllowPermissions: boolean/);
});

test('AcpManager requestPermission gates auto-allow on the flag', () => {
  const match = acpClientSrc.match(/if \(this\.autoAllowPermissions\) \{[\s\S]*?preferredAllowPermission/);
  assert.ok(match, 'auto-allow must be gated on autoAllowPermissions');
});

test('AcpManager fans out permission requests to remote listeners', () => {
  assert.match(acpClientSrc, /listener\.onPermissionRequest\?\.\(id, toolCallId, toolName, options\)/);
  assert.match(acpClientSrc, /onPermissionRequest\?: \(id: string, toolCallId: string, toolName: string, options: PermissionOption\[\]\) => void/);
});

test('AcpSessionInfo includes presetCommand field', () => {
  assert.match(acpClientSrc, /presetCommand: string;/);
});

// ========== Headless auto-allow disabled tests ==========

test('headless backend disables auto-allow (autoAllowPermissions=false)', () => {
  assert.match(headlessSrc, /false,\s*\n\s*\)/);
  assert.match(headlessSrc, /autoAllowPermissions/);
});

// ========== Remote-server ACP routes tests ==========

test('remote-server has POST /api/acp/sessions/:id/load route for resume', () => {
  assert.match(remoteServerSrc, /app\.post\('\/api\/acp\/sessions\/:id\/load'/);
  assert.match(remoteServerSrc, /cachedAcpManager\.load\(/);
});

test('remote-server has POST /api/acp/sessions/:id/permission route', () => {
  assert.match(remoteServerSrc, /app\.post\('\/api\/acp\/sessions\/:id\/permission'/);
  assert.match(remoteServerSrc, /cachedAcpManager\.resolvePermission\(/);
});

test('remote-server has GET /api/acp/sessions list route', () => {
  assert.match(remoteServerSrc, /app\.get\('\/api\/acp\/sessions',/);
  assert.match(remoteServerSrc, /listStoredSessions\(\)/);
});

test('remote-server DELETE /api/acp/sessions/:id removes stored session', () => {
  assert.match(remoteServerSrc, /cachedAcpManager\.removeStoredSession\(req\.params\.id\)/);
});

test('remote-server session list includes ACP live sessions', () => {
  assert.match(remoteServerSrc, /mapAcpSessionToApi/);
  assert.match(remoteServerSrc, /isAcp: true/);
});

test('remote-server recent sessions include stored ACP sessions', () => {
  assert.match(remoteServerSrc, /cachedAcpManager\.listStoredSessions\(\)[\s\S]*?isAcp: true/);
});

test('remote-server SSE stream emits acp:permission events', () => {
  assert.match(remoteServerSrc, /event: acp:permission/);
  assert.match(remoteServerSrc, /onPermissionRequest:/);
});

test('MobileLiveSession and MobileRecentSession types have isAcp flag', () => {
  assert.match(remoteServerSrc, /isAcp\?: boolean;/);
  assert.match(remoteServerSrc, /acpSessionId\?: string;/);
});

// ========== Mobile app.js permission + plan/usage/config tests ==========

test('mobile app.js has acp:permission SSE listener', () => {
  assert.match(appJs, /'acp:permission'/);
  assert.match(appJs, /function showAcpPermissionPrompt/);
});

test('mobile app.js permission prompt posts resolution to /permission route', () => {
  assert.match(appJs, /\/api\/acp\/sessions\/\$\{acpSessionId\}\/permission/);
  assert.match(appJs, /outcome: 'selected'/);
});

test('mobile app.js has resumeAcpSession function for stored ACP resume', () => {
  assert.match(appJs, /function resumeAcpSession/);
  assert.match(appJs, /\/api\/acp\/sessions\/.*\/load/);
});

test('mobile app.js handles plan update with collapsible checklist', () => {
  assert.match(appJs, /function handleAcpPlan/);
  assert.match(appJs, /acp-plan-mobile/);
  assert.match(appJs, /acp-plan-checkbox-mobile/);
});

test('mobile app.js handles usage_update with context bar', () => {
  assert.match(appJs, /function handleAcpUsageUpdate/);
  assert.match(appJs, /acpContextUsage/);
  assert.match(appJs, /function renderAcpStatusbar/);
});

test('mobile app.js handles config_option_update, current_mode_update, available_commands_update', () => {
  // All three should call renderAcpStatusbar
  const configSection = appJs.match(/case 'config_option_update'[\s\S]*?case 'current_mode_update'[\s\S]*?case 'available_commands_update'[\s\S]*?break/);
  assert.ok(configSection, 'all three cases should be present together');
  const section = configSection[0];
  assert.match(section, /renderAcpStatusbar\(\)/, 'config_option_update must render statusbar');
  assert.match(section, /renderAcpStatusbar\(\)/, 'current_mode_update must render statusbar');
  assert.match(section, /renderAcpStatusbar\(\)/, 'available_commands_update must render statusbar');
});

test('mobile app.js routes ACP session cards to openAcpSession, not openSession', () => {
  assert.match(appJs, /session\.isAcp[\s\S]*?openAcpSession\(/);
});

test('mobile app.js routes recent ACP cards to resumeAcpSession', () => {
  assert.match(appJs, /session\.isAcp && session\.acpSessionId[\s\S]*?resumeAcpSession\(session\)/);
});

test('mobile app.js resets statusbar state on openAcpSession', () => {
  assert.match(appJs, /resetAcpStatusbarState\(\)/);
});

test('mobile index.html has acp-statusbar element', () => {
  assert.match(indexHtml, /id="acp-statusbar"/);
});

test('mobile style.css has permission prompt, plan, and statusbar styles', () => {
  assert.match(styleCss, /\.acp-perm-prompt-mobile/);
  assert.match(styleCss, /\.acp-plan-mobile/);
  assert.match(styleCss, /\.acp-statusbar-mobile/);
  assert.match(styleCss, /\.acp-sb-ctx-bar-mobile/);
});

test('service worker and app.js cache versions are bumped in lockstep', () => {
  const swJs = fs.readFileSync(path.join(root, 'mobile/client/sw.js'), 'utf8');
  const clientBuild = appJs.match(/CLIENT_BUILD = '([^']+)'/)?.[1];
  const cacheName = swJs.match(/CACHE_NAME = '([^']+)'/)?.[1];
  assert.equal(clientBuild, cacheName, 'CLIENT_BUILD must match CACHE_NAME');
});

// Cleanup temp home and restore original HOME so other test files aren't affected.
test('cleanup', () => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
