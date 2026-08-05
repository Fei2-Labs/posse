(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  root.PosseSessionListHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateLiveSessions(value) {
    if (!Array.isArray(value)) throw new Error('服务器返回了无效的活动会话列表');
    for (const session of value) {
      if (!isObject(session) || typeof session.id !== 'string' || !session.id) {
        throw new Error('服务器返回了无效的活动会话');
      }
    }
    return value;
  }

  function normalizeRecentSessions(live, value) {
    if (!Array.isArray(value)) throw new Error('服务器返回了无效的最近会话列表');
    const liveResumeIds = new Set();
    for (const session of live) {
      if (session.resumeId) liveResumeIds.add(session.resumeId);
      if (session.agentSessionId) liveResumeIds.add(session.agentSessionId);
    }

    const seen = new Set();
    return value
      .filter((session) => {
        if (!isObject(session) || typeof session.id !== 'string' || !session.id) {
          throw new Error('服务器返回了无效的最近会话');
        }
        if (typeof session.resumeCommand !== 'string' || !session.resumeCommand) return false;
        if (session.resumeId && liveResumeIds.has(session.resumeId)) return false;
        const key = `${session.agent || ''}:${session.resumeId || session.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function normalizeSessionSnapshot(payload) {
    if (!isObject(payload) || payload.version !== 1) {
      throw new Error('服务器返回了不兼容的会话列表');
    }
    const live = validateLiveSessions(payload.live);
    return {
      version: 1,
      live,
      recent: normalizeRecentSessions(live, payload.recent),
    };
  }

  function normalizeLegacySessions(payload) {
    return {
      version: 0,
      live: validateLiveSessions(payload),
      recent: [],
    };
  }

  return {
    normalizeLegacySessions,
    normalizeSessionSnapshot,
  };
});
