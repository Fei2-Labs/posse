// ACP (Agent Client Protocol) helpers for the mobile PWA.
// Provides structured-message rendering for ACP sessions: markdown, agent/user
// message bubbles, tool-call cards, and status indicators. Mirrors the desktop
// AcpSessionView (src/renderer/acp-session-view.ts) at a mobile-appropriate
// fidelity. Loaded as a plain script tag (UMD), same pattern as chat-helpers.js.
(function (root, factory) {
  const exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  root.PosseAcpHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Minimal markdown renderer — a subset of the desktop AcpSessionView renderer.
  // Handles code blocks, inline code, bold, headers, lists, blockquotes, and links.
  // Not a full CommonMark parser; sufficient for agent prose on mobile.
  function renderMarkdown(text) {
    let html = escapeHtml(String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const langLabel = lang ? `<span class="acp-code-lang">${escapeHtml(lang)}</span>` : '';
      return `<div class="acp-code-block"><div class="acp-code-header">${langLabel}</div><pre><code>${code}</code></pre></div>`;
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="acp-inline-code">$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Links
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    // Headers
    html = html.replace(/^#### (.+)$/gm, '<div class="acp-md-h4">$1</div>');
    html = html.replace(/^### (.+)$/gm, '<div class="acp-md-h3">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="acp-md-h2">$1</div>');
    html = html.replace(/^# (.+)$/gm, '<div class="acp-md-h1">$1</div>');
    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<div class="acp-md-li">$1</div>');
    // Bullet lists
    html = html.replace(/^[-*] (.+)$/gm, '<div class="acp-md-li">• $1</div>');
    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<div class="acp-md-quote">$1</div>');
    // Strip separator-only chunks (internal adapter artifacts)
    html = html.replace(/^(-{3,}|\*{3,})$/gm, '');
    // Newlines
    html = html.replace(/\n/g, '<br>');
    // Clean up trailing <br> after block elements
    html = html.replace(/(<\/div>)<br>/g, '$1');
    html = html.replace(/<br>(<div class="acp-md-)/g, '$1');
    return html;
  }

  function toolStatusLabel(status) {
    switch (status) {
      case 'pending': return 'Queued';
      case 'in_progress': return 'Running';
      case 'completed': return 'Done';
      case 'failed': return 'Failed';
      default: return '';
    }
  }

  function toolStatusIcon(status) {
    switch (status) {
      case 'pending': return '○';
      case 'in_progress': return '◐';
      case 'completed': return '✓';
      case 'failed': return '✕';
      default: return '';
    }
  }

  function guessToolKind(title) {
    const t = String(title || '').toLowerCase();
    if (t.includes('bash') || t.includes('shell') || t.includes('exec')) return 'bash';
    if (t.includes('read') || t.includes('file')) return 'file';
    if (t.includes('write') || t.includes('edit') || t.includes('create')) return 'edit';
    if (t.includes('search') || t.includes('grep') || t.includes('find')) return 'search';
    if (t.includes('web') || t.includes('fetch') || t.includes('browse')) return 'web';
    return 'other';
  }

  function toolKindEmoji(kind) {
    switch (kind) {
      case 'bash': return '⚙';
      case 'file': return '📄';
      case 'edit': return '✎';
      case 'search': return '🔍';
      case 'web': return '🌐';
      default: return '🔧';
    }
  }

  // Build a compact tool-call content summary for the collapsed card.
  function toolContentPreview(content) {
    if (!content || !content.length) return '';
    for (const c of content) {
      if (c.type === 'content' && c.content && c.content.type === 'text') {
        const t = (c.content.text || '').trim();
        if (t) {
          const single = t.replace(/\s+/g, ' ');
          return single.length > 100 ? single.slice(0, 100) + '…' : single;
        }
      }
    }
    return '';
  }

  // Check whether a raw agent_message_chunk text is an internal task notification
  // that should be suppressed from the UI (mirrors desktop isInternalTaskNotification).
  function isInternalTaskNotification(raw) {
    const text = String(raw || '').trimStart();
    return text.startsWith('<task-notification>')
      || text.startsWith('&lt;task-notification&gt;')
      || text.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]');
  }

  return {
    escapeHtml,
    renderMarkdown,
    toolStatusLabel,
    toolStatusIcon,
    guessToolKind,
    toolKindEmoji,
    toolContentPreview,
    isInternalTaskNotification,
  };
});
