const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeLegacySessions,
  normalizeSessionSnapshot,
} = require('./session-list-helpers.js');

test('normalizes active and recent sessions and removes live duplicates', () => {
  const snapshot = normalizeSessionSnapshot({
    version: 1,
    live: [{ id: 'live-1', resumeId: 'resume-live' }],
    recent: [
      { id: 'recent-live', agent: 'codex', resumeId: 'resume-live', resumeCommand: 'codex resume resume-live', updatedAt: 3 },
      { id: 'recent-1', agent: 'codex', resumeId: 'resume-1', resumeCommand: 'codex resume resume-1', updatedAt: 2 },
      { id: 'recent-1-copy', agent: 'codex', resumeId: 'resume-1', resumeCommand: 'codex resume resume-1', updatedAt: 1 },
    ],
  });

  assert.equal(snapshot.live.length, 1);
  assert.deepEqual(snapshot.recent.map((session) => session.id), ['recent-1']);
});

test('rejects malformed responses instead of rendering them as empty', () => {
  assert.throws(() => normalizeSessionSnapshot({ version: 1, live: [], recent: null }), /最近会话列表/);
  assert.throws(() => normalizeLegacySessions({ sessions: [] }), /活动会话列表/);
});

test('supports the legacy live-only endpoint during rolling upgrades', () => {
  assert.deepEqual(normalizeLegacySessions([{ id: 'live-1' }]), {
    version: 0,
    live: [{ id: 'live-1' }],
    recent: [],
  });
});
