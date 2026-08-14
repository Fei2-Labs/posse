const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const acpClientSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/acp-client.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/app.ts'), 'utf8');
const readmeSource = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

// ========== R1: Native desktop notification delivery ==========

test('main imports Notification from electron', () => {
  assert.match(mainSource, /import\s*\{[^}]*\bNotification\b[^}]*\}\s*from\s*'electron'/);
});

test('sendDesktopNotification uses Electron Notification with silent:false', () => {
  assert.match(mainSource, /function sendDesktopNotification\(title: string, body: string\): void \{/);
  assert.match(mainSource, /Notification\.isSupported\(\)/);
  assert.match(mainSource, /new Notification\(\{/);
  assert.match(mainSource, /silent:\s*false/);
});

test('sendDesktopNotification swallows unsupported/failed notification APIs', () => {
  const fn = mainSource.match(/function sendDesktopNotification[\s\S]*?\n\}\n/);
  assert.ok(fn, 'expected sendDesktopNotification helper');
  assert.match(fn[0], /} catch \{/);
  assert.match(fn[0], /Unsupported notification APIs or creation\/show failure/);
});

test('sendUserNotification calls remote push, iMessage, and desktop notification', () => {
  const fn = mainSource.match(/function sendUserNotification[\s\S]*?\n\}\n/);
  assert.ok(fn, 'expected sendUserNotification helper');
  assert.match(fn[0], /sendRemotePush\(title, body, id\)/);
  assert.match(fn[0], /sendIMessageNotification/);
  assert.match(fn[0], /sendDesktopNotification\(title, body\)/);
});

// ========== R2: Audible alert via OS policy ==========

test('desktop notification requests OS-controlled audible delivery, not an independent audio player', () => {
  assert.match(mainSource, /silent:\s*false/);
  assert.doesNotMatch(mainSource, /new Audio\(/);
  assert.doesNotMatch(mainSource, /playSound\(/);
  assert.match(mainSource, /OS notification policy|OS-controlled audible/);
});

// ========== R3: Foreground suppression ==========

test('main tracks per-window selected session identity', () => {
  assert.match(mainSource, /const windowSelectedSessions = new Map<number, string \| null>/);
  assert.match(mainSource, /function setSelectedSessionForWindow/);
  assert.match(mainSource, /function clearSelectedSessionForWindow/);
});

test('focusedWindowShowsSession checks focused non-destroyed windows', () => {
  assert.match(mainSource, /function focusedWindowShowsSession\(identity: string\): boolean \{/);
  const fn = mainSource.match(/function focusedWindowShowsSession[\s\S]*?\n\}/);
  assert.ok(fn, 'expected focusedWindowShowsSession');
  assert.match(fn[0], /BrowserWindow\.getAllWindows\(\)/);
  assert.match(fn[0], /win\.isDestroyed\(\)/);
  assert.match(fn[0], /win\.isFocused\(\)/);
  assert.match(fn[0], /windowSelectedSessions\.get\(win\.webContents\.id\)/);
});

test('foreground suppression only blocks local desktop notification, not remote channels', () => {
  const fn = mainSource.match(/function sendUserNotification[\s\S]*?\n\}\n/);
  assert.ok(fn, 'expected sendUserNotification helper');
  // Remote push + iMessage must run BEFORE the suppression gate
  const remotePushIdx = fn[0].indexOf('sendRemotePush');
  const iMessageIdx = fn[0].indexOf('sendIMessageNotification');
  const suppressIdx = fn[0].indexOf('focusedWindowShowsSession');
  const desktopIdx = fn[0].indexOf('sendDesktopNotification');
  assert.ok(remotePushIdx > -1 && remotePushIdx < suppressIdx, 'sendRemotePush must run before suppression');
  assert.ok(iMessageIdx > -1 && iMessageIdx < suppressIdx, 'sendIMessageNotification must run before suppression');
  assert.ok(desktopIdx > suppressIdx, 'sendDesktopNotification must run after suppression');
});

test('notify:selected-session IPC handler records renderer selection', () => {
  assert.match(mainSource, /ipcMain\.on\('notify:selected-session'/);
  assert.match(mainSource, /setSelectedSessionForWindow\(sender\.webContents\.id/);
});

test('window closed handler clears selected-session tracking', () => {
  const closedHandler = mainSource.match(/win\.on\('closed', \(\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(closedHandler, 'expected win closed handler');
  assert.match(closedHandler[0], /clearSelectedSessionForWindow\(windowWebContentsId\)/);
});

test('app shutdown clears windowSelectedSessions', () => {
  const beforeQuit = mainSource.match(/app\.on\('before-quit'[\s\S]*?\n\}\);/);
  assert.ok(beforeQuit, 'expected before-quit handler');
  assert.match(beforeQuit[0], /windowSelectedSessions\.clear\(\)/);
});

// ========== R4: PTY state labels and rate limiting preserved ==========

test('PTY attention passes connection-scoped identity for suppression', () => {
  const fn = mainSource.match(/function maybeNotifyAttention[\s\S]*?\n\}/);
  assert.ok(fn, 'expected maybeNotifyAttention');
  assert.match(fn[0], /connectionSessionKey\(connectionId, id\)/);
  assert.match(fn[0], /sendUserNotification\(id, 'Your decision needed', title, ptyIdentity\)/);
  assert.match(fn[0], /sendUserNotification\(id, 'Task completed', title, ptyIdentity\)/);
  assert.match(fn[0], /sendUserNotification\(id, 'Session waiting for input', title, ptyIdentity\)/);
});

test('PTY exit notification passes connection-scoped identity', () => {
  const exitBlock = mainSource.match(/if \(!sessionUserClosed\.has\(id\)\) \{[\s\S]*?\}/);
  assert.ok(exitBlock, 'expected exit notification block');
  assert.match(exitBlock[0], /sendUserNotification\(id, 'Session ended', title, deletionKey\)/);
});

test('existing PTY cooldown, arming, and detection logic remain the sole PTY path', () => {
  const fn = mainSource.match(/function maybeNotifyAttention[\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn[0], /NOTIFY_COOLDOWN_MS/);
  assert.match(fn[0], /sessionArmedForNotify/);
  assert.match(fn[0], /sessionLastInputAt/);
  // No parallel terminal-output parser introduced
  assert.doesNotMatch(mainSource, /maybeNotifyAttention2\(|function detectCompletion\(/);
});

// ========== R5: ACP structured delivery ==========

test('AcpManager constructor accepts an onAttention callback', () => {
  assert.match(acpClientSource, /onAttention\?: AcpAttentionHandler,/);
  assert.match(acpClientSource, /this\.onAttention = onAttention;/);
});

test('AcpManager exports AcpAttentionKind and AcpAttentionHandler types', () => {
  assert.match(acpClientSource, /export type AcpAttentionKind = 'decision-needed' \| 'task-completed';/);
  assert.match(acpClientSource, /export type AcpAttentionHandler = \(id: string, kind: AcpAttentionKind\) => void;/);
});

test('requestPermission emits decision-needed only when surfacing to user', () => {
  // The emitAttention call must be AFTER onPermissionRequest fan-out (not on the auto-allow path)
  const requestPermissionFn = acpClientSource.match(/private requestPermission\([\s\S]*?\n  \}/);
  assert.ok(requestPermissionFn, 'expected requestPermission method');
  // Auto-allow returns before reaching the fan-out + emitAttention
  const autoAllowIdx = requestPermissionFn[0].indexOf('preferredAllowPermission');
  const fanOutIdx = requestPermissionFn[0].indexOf('this.onPermissionRequest(id');
  const emitIdx = requestPermissionFn[0].indexOf("this.emitAttention(id, 'decision-needed')");
  assert.ok(autoAllowIdx > -1 && emitIdx > -1, 'expected auto-allow and emitAttention');
  assert.ok(emitIdx > fanOutIdx, 'emitAttention must come after onPermissionRequest fan-out');
});

test('prompt emits task-completed only for end_turn stop reason', () => {
  const promptFn = acpClientSource.match(/async prompt\(id: string, content: string \| ContentBlock\[\]\): Promise<void> \{[\s\S]*?\n  \}/);
  assert.ok(promptFn, 'expected prompt method');
  assert.match(promptFn[0], /const response = await session\.context\.request\(acp\.methods\.agent\.session\.prompt/);
  assert.match(promptFn[0], /stopReason === 'end_turn'/);
  assert.match(promptFn[0], /this\.emitAttention\(id, 'task-completed'\)/);
});

test('ACP does NOT infer completion from idle status, tool calls, or assistant prose', () => {
  // The only emitAttention calls must be for requestPermission and end_turn
  const emitMatches = acpClientSource.match(/this\.emitAttention\(/g);
  assert.ok(emitMatches, 'expected at least one emitAttention call');
  // Ensure no emitAttention is wired into handleSessionUpdate or idle fanout
  const handleUpdateFn = acpClientSource.match(/private handleSessionUpdate[\s\S]*?\n  \}/);
  assert.ok(handleUpdateFn);
  assert.doesNotMatch(handleUpdateFn[0], /emitAttention/);
  // No emitAttention for 'idle' status fanout
  const fanoutStatusFn = acpClientSource.match(/private fanoutStatus[\s\S]*?\n  \}/);
  assert.ok(fanoutStatusFn);
  assert.doesNotMatch(fanoutStatusFn[0], /emitAttention/);
});

test('emitAttention is best-effort and cannot break the agent loop', () => {
  const fn = acpClientSource.match(/private emitAttention[\s\S]*?\n  \}/);
  assert.ok(fn, 'expected emitAttention helper');
  assert.match(fn[0], /} catch \{/);
  assert.match(fn[0], /attention sink must not break the agent loop/);
});

test('main wires AcpManager onAttention to the common delivery path', () => {
  // The constructor call must pass a 6th argument (onAttention)
  const ctor = mainSource.match(/const acpManager = new AcpManager\([\s\S]*?\n\);/);
  assert.ok(ctor, 'expected AcpManager constructor call');
  assert.match(ctor[0], /\(id: string, kind\) =>/);
  assert.match(ctor[0], /sendUserNotification\(id, label, title, id\)/);
  assert.match(ctor[0], /'Task completed'/);
  assert.match(ctor[0], /'Your decision needed'/);
});

test('ACP attention derives title from agentLabel/presetCommand, never agent text', () => {
  const ctor = mainSource.match(/const acpManager = new AcpManager\([\s\S]*?\n\);/);
  const attentionCb = ctor[0].match(/\(id: string, kind\) => \{[\s\S]*?\},\n\);/);
  assert.ok(attentionCb, 'expected onAttention callback');
  assert.match(attentionCb[0], /info\?\.agentLabel \|\| info\?\.presetCommand \|\| 'Agent'/);
  assert.doesNotMatch(attentionCb[0], /response\.|message\.|assistant\.|update\./);
});

// ========== IPC and renderer wiring ==========

test('preload exposes notifySelectedSession as a one-way send', () => {
  assert.match(preloadSource, /notifySelectedSession: \(identity: string \| null\) =>\s*ipcRenderer\.send\('notify:selected-session', identity\)/);
});

test('renderer declares notifySelectedSession in the window.posse type', () => {
  assert.match(rendererSource, /notifySelectedSession: \(identity: string \| null\) => void;/);
});

test('renderer builds connection-scoped PTY identity and passthrough ACP identity', () => {
  const fn = rendererSource.match(/function buildSelectedSessionIdentity\(\): string \| null \{[\s\S]*?\n\}/);
  assert.ok(fn, 'expected buildSelectedSessionIdentity');
  assert.match(fn[0], /if \(activeAcpId\) return activeAcpId;/);
  assert.match(fn[0], /`\$\{currentWindowConnectionId\}\\0\$\{ptyId\}`/);
  assert.match(fn[0], /if \(activeChatId\) return null;/);
});

test('renderer reports selection on session switch and connection change', () => {
  assert.match(rendererSource, /function notifySelectedSessionToMain\(\): void \{/);
  // switchSession calls it
  const switchFn = rendererSource.match(/function switchSession\(id: string\): void \{[\s\S]*?\n\}/);
  assert.ok(switchFn);
  assert.match(switchFn[0], /notifySelectedSessionToMain\(\)/);
  // switchToTerminal, switchToAcp, switchToChat all call it
  for (const fnName of ['switchToTerminal', 'switchToAcp', 'switchToChat']) {
    const fn = rendererSource.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n\\}`));
    assert.ok(fn, `expected ${fnName}`);
    assert.match(fn[0], /notifySelectedSessionToMain\(\)/, `${fnName} must notify`);
  }
  // connection:changed clears selection
  const connChanged = rendererSource.match(/window\.posse\.onConnectionChanged\(\(id\) => \{[\s\S]*?\n\}\);/);
  assert.ok(connChanged, 'expected onConnectionChanged handler');
  assert.match(connChanged[0], /currentWindowConnectionId = id \|\| null/);
  assert.match(connChanged[0], /window\.posse\.notifySelectedSession\(null\)/);
});

// ========== R6: Documentation ==========

test('README documents desktop alerts alongside push and iMessage', () => {
  assert.match(readmeSource, /desktop alert/i);
  assert.match(readmeSource, /OS-controlled sound/i);
  assert.match(readmeSource, /requestPermission/);
  assert.match(readmeSource, /end_turn/);
});
