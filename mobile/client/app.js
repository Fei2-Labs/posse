// Posse Mobile PWA - 客户端逻辑 (xterm.js + WebSocket)

const API = location.origin;

// 从 URL 参数读取 token（支持带 token 直接访问）
const urlParams = new URLSearchParams(location.search);
const urlToken = urlParams.get('token');
if (urlToken) {
  localStorage.setItem('duocli_token', urlToken);
  // 清除 URL 参数，避免暴露 token
  history.replaceState({}, '', location.pathname);
}
let token = localStorage.getItem('duocli_token') || '';
let currentSessionId = null;
let sseSource = null;
// bump in lockstep with sw.js CACHE_NAME so a stale client cache is visible
const CLIENT_BUILD = 'posse-v25';
let lastServerInfo = null;

// xterm.js 相关
let term = null;
let fitAddon = null;

// Measure the real visible width (.xterm-viewport clientWidth excludes scrollbar +
// padding) instead of FitAddon's guessed geometry, which overcounts columns and clips
// the right-most glyph (ASCII "padding"->"paddi" and CJK alike). Fall back to fit().
function safeFit() {
  if (!fitAddon || !term) return;
  const rs = term._core && term._core._renderService;
  const cell = rs && rs.dimensions && rs.dimensions.css && rs.dimensions.css.cell;
  const vp = term.element && term.element.querySelector('.xterm-viewport');
  if (cell && cell.width > 0 && cell.height > 0 && vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
    const c = Math.max(2, Math.floor(vp.clientWidth / cell.width));
    const r = Math.max(1, Math.floor(vp.clientHeight / cell.height));
    if (c !== term.cols || r !== term.rows) term.resize(c, r);
    return;
  }
  fitAddon.fit();
}
let ws = null;
let wsHeartbeat = null;
let wsReconnectTimer = null;
let wsReconnectAttempt = 0;
let wsConnectTimeoutTimer = null;
let wsLastPongAt = 0;
let copyToastTimer = null;
let isUserScrolling = false;
let scrollToBottomTimer = null;
let userScrollReleaseTimer = null;
let sseReconnectTimer = null;
let sseReconnectAttempt = 0;
const WEAK_NETWORK_STORAGE_KEY = 'duocli_weak_network_mode';
const MOBILE_LAST_CWD_KEY = 'duocli_mobile_last_cwd';
const MOBILE_LAST_PRESET_KEY = 'duocli_mobile_last_preset';
let weakNetworkMode = localStorage.getItem(WEAK_NETWORK_STORAGE_KEY) === '1';
const chatHelpers = globalThis.DuoChatHelpers || {
  ensureApiSuccess(ok, status, payload) {
    if (!ok) {
      const message = payload && typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `请求失败 (${status})`;
      const err = new Error(message);
      err.status = status;
      throw err;
    }
    return payload;
  },
  mergePendingMessages(history, pendingMessages) {
    return {
      messages: Array.isArray(history) ? history : [],
      pendingMessages: Array.isArray(pendingMessages) ? pendingMessages : [],
    };
  },
  getResumeAgentLabel(agent) {
    if (agent === 'codex') return 'Codex';
    if (agent === 'claude') return 'Claude Code';
    if (agent === 'copilot') return 'GitHub Copilot';
    return 'Agent';
  },
};

// ========== 循环（自动继续）==========
// 手机端只做 UI，实际配置存在桌面端，通过 API 读写

// ========== 工具函数 ==========

function $(id) { return document.getElementById(id); }

function getNetworkProfile() {
  if (weakNetworkMode) {
    return {
      wsConnectTimeoutMs: 18000,
      wsPingIntervalMs: 20000,
      wsStaleTimeoutMs: 90000,
      wsRetryBaseMs: 2000,
      wsRetryMaxMs: 45000,
      sseRetryBaseMs: 4000,
      sseRetryMaxMs: 45000,
    };
  }
  return {
    wsConnectTimeoutMs: 8000,
    wsPingIntervalMs: 15000,
    wsStaleTimeoutMs: 45000,
    wsRetryBaseMs: 1000,
    wsRetryMaxMs: 15000,
    sseRetryBaseMs: 2000,
    sseRetryMaxMs: 15000,
  };
}

function setWeakNetworkMode(enabled) {
  weakNetworkMode = enabled;
  localStorage.setItem(WEAK_NETWORK_STORAGE_KEY, weakNetworkMode ? '1' : '0');
}

function ensureWeakNetworkPrompt() {
  const existed = $('weak-network-prompt');
  if (existed) return existed;
  const container = $('terminal-container');
  if (!container) return null;

  const prompt = document.createElement('div');
  prompt.id = 'weak-network-prompt';
  prompt.className = 'weak-network-prompt';
  prompt.style.display = 'none';
  prompt.innerHTML = `
    <div id="weak-network-prompt-text" class="weak-network-prompt-text"></div>
    <div class="weak-network-prompt-actions">
      <button id="weak-network-prompt-btn" class="weak-network-prompt-btn" type="button"></button>
    </div>
  `;

  const btn = prompt.querySelector('#weak-network-prompt-btn');
  btn.addEventListener('click', () => {
    if (!weakNetworkMode) {
      setWeakNetworkMode(true);
      showCopyToast('已切到弱网模式，正在重连');
      if (currentSessionId && $('detail-page').classList.contains('active')) {
        connectWebSocket(currentSessionId);
      }
      if ($('main-page').classList.contains('active') && token) {
        startSSE();
      }
    }
    hideWeakNetworkPrompt();
  });

  container.appendChild(prompt);
  return prompt;
}

function showWeakNetworkPrompt(message) {
  if (!$('detail-page').classList.contains('active')) return;
  const prompt = ensureWeakNetworkPrompt();
  if (!prompt) return;
  const textEl = prompt.querySelector('#weak-network-prompt-text');
  const btn = prompt.querySelector('#weak-network-prompt-btn');
  if (!textEl || !btn) return;

  textEl.textContent = message;
  if (weakNetworkMode) {
    btn.textContent = '已在弱网模式';
    btn.setAttribute('disabled', 'disabled');
  } else {
    btn.textContent = '切到弱网模式';
    btn.removeAttribute('disabled');
  }
  prompt.style.display = 'flex';
}

function hideWeakNetworkPrompt() {
  const prompt = $('weak-network-prompt');
  if (prompt) prompt.style.display = 'none';
}

// 截断长路径，优先显示最右侧目录名，如 /a/b/c/d → …/c/d
function shortenPath(p, maxLen = 30) {
  if (p.length <= maxLen) return p;
  const parts = p.split('/').filter(Boolean);
  let result = parts[parts.length - 1] || p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + result;
    if (next.length + 1 > maxLen) break; // +1 for leading …/
    result = next;
  }
  return '…/' + result;
}

// CLI 标签颜色映射 [文字色, 背景色]，与桌面端保持一致
const CLI_TAG_COLORS = {
  'Claude全自动':  ['#e5a100', '#3d3010'],
  'Codex全自动':   ['#56d4a0', '#1a3d2e'],
  'Copilot全自动': ['#3fb950', '#12351f'],
};

function getCliTagColors(name) {
  if (CLI_TAG_COLORS[name]) return CLI_TAG_COLORS[name];
  for (const key of Object.keys(CLI_TAG_COLORS)) {
    if (name.startsWith(key)) return CLI_TAG_COLORS[key];
  }
  // 未知 CLI：hash 选色
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const palette = [
    ['#e06c75', '#3d1e22'], ['#e5c07b', '#3d3520'], ['#98c379', '#253320'],
    ['#f78c6c', '#3d2518'], ['#c792ea', '#2e1e3d'], ['#ff5370', '#3d1825'],
  ];
  return palette[Math.abs(h) % palette.length];
}

function hideTerminalLoading() {
  const el = $('terminal-loading');
  if (el && !el.classList.contains('hidden')) {
    el.classList.add('hidden');
  }
}

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 全局超时：避免弱网下 fetch 永远 pending 卡住整个 UI
  // 默认 12s，弱网模式 25s；调用方可通过 opts.timeout 覆盖（0 = 无超时）
  const timeoutMs = opts.timeout != null
    ? opts.timeout
    : (weakNetworkMode ? 25000 : 12000);
  let signal = opts.signal;
  let timer = null;
  if (timeoutMs > 0 && !signal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return fetch(`${API}${path}`, { ...opts, headers, signal })
    .then(async r => {
      cleanup();
      if (r.status === 401) { logout(); throw new Error('未授权'); }
      let data = {};
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      return chatHelpers.ensureApiSuccess(r.ok, r.status, data);
    })
    .catch((err) => {
      cleanup();
      if (err && err.name === 'AbortError') {
        const e = new Error('请求超时，请检查网络');
        e.code = 'TIMEOUT';
        throw e;
      }
      throw err;
    });
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  if (id !== 'detail-page') {
    hideWeakNetworkPrompt();
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  // iOS Safari 兜底
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', 'readonly');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  document.body.removeChild(ta);
  return ok;
}

function showCopyToast(text) {
  let toast = $('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'copy-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1200);
}

// 判断终端是否滚动到底部附近（容差 2 行）
function isAtBottom() {
  if (!term) return true;
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY - 2;
}

function markUserScrolling() {
  isUserScrolling = !isAtBottom();
  if (userScrollReleaseTimer) clearTimeout(userScrollReleaseTimer);
  userScrollReleaseTimer = setTimeout(() => {
    if (term && isAtBottom()) {
      isUserScrolling = false;
    }
  }, 800);
}

function getLineTextByTouchY(clientY) {
  if (!term) return '';
  const container = $('terminal-container');
  const rect = container.getBoundingClientRect();
  const rowsEl = container.querySelector('.xterm-rows');
  const firstRow = rowsEl?.children?.[0];
  const rowHeight = firstRow?.getBoundingClientRect().height || 18;
  const yInTerminal = clientY - rect.top;
  const visualRow = Math.max(0, Math.floor(yInTerminal / rowHeight));
  const buffer = term.buffer.active;
  const lineIndex = Math.min(
    Math.max(0, buffer.viewportY + visualRow),
    Math.max(0, buffer.length - 1),
  );
  const line = buffer.getLine(lineIndex);
  return line ? line.translateToString(true).trim() : '';
}

// ========== 登录 ==========

function logout() {
  token = '';
  localStorage.removeItem('duocli_token');
  stopSSE();
  closeTerminal();
  LanSwitcher.stop();
  showPage('login-page');
}

// ============================================================
// 网络模式切换：CF Tunnel ⇄ LAN 直连
// 背景：HTTPS 页面无法在浏览器侧探测 HTTP LAN（iOS Safari Mixed Content
// 把所有子资源请求要么拦截要么强制升级到 HTTPS，<img>/<iframe>/fetch 全堵）。
// 所以放弃自动探针，改成顶部常驻按钮：
//   - CF 模式（HTTPS）：按钮显示"🟡 切局域网"，点击 → 拿 /api/lan-info →
//     选 IP（上次成功优先；否则 192.168 > 10 > 172）→ location.replace 跳过去。
//     跳过去打不开是用户自己的事（不在家就别点）。
//   - LAN 模式（HTTP + 私有 IP）：按钮显示"🟢 局域网"，点击 → 跳回 CF。
//     另外 5 秒一次 fetch /ping.png 自检，连续两次不通自动跳回 CF（HTTP→HTTP
//     不受 Mixed Content 限制，这里用 fetch 比 <img> 更准）。
// ============================================================
const LanSwitcher = (() => {
  const PROBE_INTERVAL_LAN_MS = 5 * 1000;
  const PROBE_TIMEOUT_MS = 2000;
  const STORAGE_CLOUD_URL = 'duocli_cloud_url';   // 上次的远程入口 origin（用户自定义 cloud URL；非特指 CF）
  const STORAGE_LAST_LAN_IP = 'duocli_last_lan_ip'; // 上次成功用过的 LAN IP
  const STORAGE_TS_URL = 'posse_tailscale_url';   // 本机 Tailscale 稳定入口（来自 /api/lan-info）：
                                                  // 优先 http://<100.x>:<port>（稳定、不依赖 tailscale serve），
                                                  // 否则回退 https://<dnsName>。#58: 比动态 LAN IP 更稳定。

  let probeTimer = null;

  // 私有/可信内网 IP：含回环、RFC1918，以及 Tailscale CGNAT 100.64.0.0/10（100.64.x ~ 100.127.x）
  function isPrivateIp(host) {
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
  }

  function isLocalHostname(host) {
    return host === 'localhost' || host.endsWith('.local');
  }

  function isLanMode() {
    const host = location.hostname.toLowerCase();
    return location.protocol === 'http:' && (isPrivateIp(host) || isLocalHostname(host));
  }

  function isCfMode() {
    return location.protocol === 'https:';
  }

  // 多 IP 选优：上次成功的 > 192.168 > 10 > 172 > 其它
  function pickBestIp(ips) {
    if (!ips || !ips.length) return null;
    const last = localStorage.getItem(STORAGE_LAST_LAN_IP);
    if (last && ips.includes(last)) return last;
    const score = ip => {
      if (ip.startsWith('192.168.')) return 3;
      if (ip.startsWith('10.')) return 2;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
      return 0;
    };
    return [...ips].sort((a, b) => score(b) - score(a))[0];
  }

  // LAN 自检：HTTP 页面 fetch HTTP 不受 Mixed Content 限制
  async function probeLanSelf() {
    const url = `${location.origin}/ping.png?_=${Date.now()}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function probeLanMode() {
    if (await probeLanSelf()) return;
    await new Promise(r => setTimeout(r, 1000));
    if (await probeLanSelf()) return;
    switchToCloud(true);
  }

  // CF → LAN：用户主动点
  async function switchToLan() {
    if (!token) return;
    let info;
    try {
      info = await api('/api/lan-info');
    } catch {
      showCopyToast('拿不到局域网信息（token 失效？）');
      return;
    }
    // 记下本机 Tailscale 稳定入口（供 off-LAN 时切到用户自己的节点，而非任何第三方域名）。
    // #58: 优先 http://<100.x>:<port>（tailnet 内固定可达，不依赖 tailscale serve https），
    // 否则回退 https://<dnsName>。两者都比会随 DHCP 变化的动态 LAN IP 更稳定。
    const tsStable = (info && (info.tailscaleHttpUrl || info.tailscaleUrl)) || null;
    if (tsStable) {
      localStorage.setItem(STORAGE_TS_URL, tsStable);
    }
    const ip = pickBestIp(info && info.lanIps);
    if (!ip) {
      showCopyToast('电脑暂无可用局域网 IP');
      return;
    }
    const port = info.port || 9800;
    localStorage.setItem(STORAGE_CLOUD_URL, location.origin);
    localStorage.setItem(STORAGE_LAST_LAN_IP, ip);
    showCopyToast(`🟢 切到 ${ip}:${port}`);
    setTimeout(() => location.replace(`http://${ip}:${port}/?token=${encodeURIComponent(token)}`), 200);
  }

  // LAN → 远程：用户点 或 自检失败
  // 解析顺序：用户自定义 cloud URL > 本机 Tailscale https 入口 > 无可用入口则不跳转，提示开启远程访问
  function switchToCloud(auto) {
    const cloudUrl = localStorage.getItem(STORAGE_CLOUD_URL) || localStorage.getItem(STORAGE_TS_URL);
    if (!cloudUrl) {
      showCopyToast('请在桌面端开启 Tailscale 远程访问，或手动设置 cloud URL');
      return;
    }
    showCopyToast(auto ? '局域网失联，回到远程…' : '☁️ 切到远程…');
    setTimeout(() => location.replace(`${cloudUrl}/?token=${encodeURIComponent(token)}`), 200);
  }

  function updateButton() {
    const btn = $('net-mode-btn');
    if (!btn) return;
    if (!token) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    if (isLanMode()) {
      btn.textContent = '🟢 局域网';
      btn.title = '当前局域网直连，点击切回云端';
      btn.className = 'net-mode-btn lan';
      btn.onclick = () => switchToCloud(false);
    } else if (isCfMode()) {
      btn.textContent = '🟡 切局域网';
      btn.title = '在家时点击切到局域网直连，更快';
      btn.className = 'net-mode-btn cf';
      btn.onclick = switchToLan;
    } else {
      btn.style.display = 'none';
    }
  }

  function start() {
    stop();
    updateButton();
    if (!token) return;
    if (isLanMode()) {
      setTimeout(probeLanMode, 1000);
      probeTimer = setInterval(probeLanMode, PROBE_INTERVAL_LAN_MS);
    }
  }

  function stop() {
    if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }

  return { start, stop, switchToLan, switchToCloud, isLanMode, isCfMode };
})();

$('login-btn').onclick = async () => {
  const t = $('token-input').value.trim();
  if (!t) return;
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    });
    const data = await res.json();
    if (data.ok) {
      token = t;
      localStorage.setItem('duocli_token', t);
      $('login-error').textContent = '';
      enterMain();
    } else {
      $('login-error').textContent = 'Token 错误';
    }
  } catch (e) {
    $('login-error').textContent = '连接失败: ' + e.message;
  }
};

$('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-btn').click();
});

// ========== 设备页 ==========

let remoteTapEnabled = false;
let screenshotObjectUrl = null;

function initDevicePage() {
  $('device-console-btn').onclick = async () => {
    showPage('device-page');
    await refreshAndroidDevices();
    // 设备加载完后自动截图
    if ($('device-select').value) {
      refreshAndroidScreenshot();
    }
    showCopyToast('🖱 开启后可点击操控');
  };
  // ---- 自适应帧率控制器 ----
  let autoRunning = false;
  let autoStopped = false;
  let adaptiveQuality = 60;
  let adaptiveScale = 0.5;
  const TARGET_MS = 1000; // 目标帧间隔

  async function adaptiveLoop() {
    if (autoStopped) return;
    autoRunning = true;
    const t0 = Date.now();
    try {
      await refreshAndroidScreenshot(adaptiveQuality, adaptiveScale);
      $('fullscreen-preview').src = $('device-preview').src;
    } catch {}
    const elapsed = Date.now() - t0;
    // 自适应：太慢就降质量/分辨率，够快就提升
    if (elapsed > TARGET_MS * 1.2) {
      if (adaptiveQuality > 20) { adaptiveQuality = Math.max(20, adaptiveQuality - 10); }
      else if (adaptiveScale > 0.2) { adaptiveScale = Math.max(0.2, adaptiveScale - 0.1); }
    } else if (elapsed < TARGET_MS * 0.6) {
      if (adaptiveScale < 0.5) { adaptiveScale = Math.min(0.5, adaptiveScale + 0.05); }
      else if (adaptiveQuality < 70) { adaptiveQuality = Math.min(70, adaptiveQuality + 5); }
    }
    if (!autoStopped) {
      const wait = Math.max(0, TARGET_MS - elapsed);
      setTimeout(adaptiveLoop, wait);
    }
  }

  function startAutoRefresh() {
    if (autoRunning && !autoStopped) return;
    autoStopped = false;
    adaptiveLoop();
    $('fullscreen-auto-btn').textContent = '停止刷新';
  }

  function stopAutoRefresh() {
    autoStopped = true;
    autoRunning = false;
    $('fullscreen-auto-btn').textContent = '自动刷新';
  }

  $('device-back-btn').onclick = () => { stopAutoRefresh(); showPage('main-page'); };
  $('fullscreen-back-btn').onclick = () => {
    stopAutoRefresh();
    $('fullscreen-overlay').style.display = 'none';
  };
  $('fullscreen-auto-btn').onclick = () => {
    if (autoRunning && !autoStopped) { stopAutoRefresh(); }
    else { startAutoRefresh(); }
  };
  const sendTextToDevice = async () => {
    const text = $('fullscreen-text-input').value;
    if (!text) return;
    const deviceId = $('device-select').value;
    if (!deviceId) { showCopyToast('请先选择设备'); return; }
    $('fullscreen-text-input').value = '';
    $('input-text-modal').classList.remove('active');
    showCopyToast('⚠️ 请确保手机上已点击输入框');
    await new Promise(r => setTimeout(r, 800));
    await fetch(`${API}/api/android/input-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, text }),
    }).catch(() => {});
    showCopyToast('已发送');
  };
  $('fullscreen-text-btn').onclick = () => {
    $('fullscreen-text-input').value = '';
    $('input-text-modal').classList.add('active');
    setTimeout(() => $('fullscreen-text-input').focus(), 100);
  };
  $('input-text-close').onclick = () => $('input-text-modal').classList.remove('active');
  $('fullscreen-text-send').onclick = sendTextToDevice;
  $('fullscreen-text-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendTextToDevice(); });
  $('device-fullscreen-btn').onclick = () => {
    const src = $('device-preview').src;
    if (!src) { showCopyToast('请先获取截图'); return; }
    $('fullscreen-preview').src = src;
    $('fullscreen-overlay').style.display = 'flex';
    startAutoRefresh(); // 进入全屏默认开启自动刷新
    showCopyToast('点击/拖动操控 · ⌨️ 输入文字');
  };
  $('device-shell-btn').onclick = () => {
    $('shell-output').style.display = 'none';
    $('shell-input').value = '';
    $('shell-modal').classList.add('active');
  };
  $('shell-modal-close').onclick = () => $('shell-modal').classList.remove('active');
  $('shell-run-btn').onclick = async () => {
    const command = $('shell-input').value.trim();
    const deviceId = $('device-select').value;
    if (!command) return;
    if (!deviceId) { showCopyToast('请先选择设备'); return; }
    $('shell-run-btn').textContent = '执行中...';
    $('shell-run-btn').disabled = true;
    try {
      const res = await fetch(`${API}/api/android/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, command }),
      });
      const data = await res.json();
      const out = $('shell-output');
      out.textContent = data.output || data.error || '（无输出）';
      out.style.display = 'block';
    } catch (e) {
      showCopyToast('执行失败: ' + e.message);
    } finally {
      $('shell-run-btn').textContent = '执行';
      $('shell-run-btn').disabled = false;
    }
  };
  // ---- 全屏触摸：区分点击(tap)和拖动(swipe) ----
  let touchStart = null;
  const fsImg = $('fullscreen-preview');
  function imgToDevice(clientX, clientY) {
    const rect = fsImg.getBoundingClientRect();
    return {
      x: Math.round((clientX - rect.left) * fsImg.naturalWidth / rect.width),
      y: Math.round((clientY - rect.top) * fsImg.naturalHeight / rect.height),
    };
  }
  fsImg.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStart = { cx: t.clientX, cy: t.clientY, time: Date.now() };
  }, { passive: true });
  fsImg.addEventListener('touchend', async (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.cx;
    const dy = t.clientY - touchStart.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - touchStart.time;
    const deviceId = $('device-select').value;
    if (!deviceId) { touchStart = null; return; }
    e.preventDefault();
    if (dist < 15) {
      // 点击
      const p = imgToDevice(t.clientX, t.clientY);
      fetch(`${API}/api/android/tap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, x: p.x, y: p.y }),
      }).catch(() => {});
    } else {
      // 拖动
      const p1 = imgToDevice(touchStart.cx, touchStart.cy);
      const p2 = imgToDevice(t.clientX, t.clientY);
      const swipeDur = Math.max(150, Math.min(2000, duration));
      fetch(`${API}/api/android/swipe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ deviceId, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, duration: swipeDur }),
      }).catch(() => {});
    }
    touchStart = null;
  });
  // 桌面端兜底：鼠标点击 = tap
  fsImg.onclick = async (e) => {
    const deviceId = $('device-select').value;
    if (!deviceId) return;
    const p = imgToDevice(e.clientX, e.clientY);
    fetch(`${API}/api/android/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, x: p.x, y: p.y }),
    }).catch(() => {});
  };
  $('device-refresh-btn').onclick = refreshAndroidDevices;
  $('device-shot-btn').onclick = () => {
    showCopyToast('正在刷新截图...');
    refreshAndroidScreenshot();
  };
  $('device-tap-toggle').onclick = () => {
    remoteTapEnabled = !remoteTapEnabled;
    $('device-tap-toggle').style.opacity = remoteTapEnabled ? '1' : '0.4';
    $('device-preview').style.cursor = remoteTapEnabled ? 'crosshair' : 'default';
    showCopyToast(remoteTapEnabled ? '🖱 远程控制已开启，点击截图操控手机' : '🖱 远程控制已关闭');
  };
  $('device-preview').onclick = async (e) => {
    if (!remoteTapEnabled) {
      // 非控制模式：进入全屏
      const overlay = $('fullscreen-overlay');
      $('fullscreen-preview').src = $('device-preview').src;
      overlay.style.display = 'flex';
      return;
    }
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * img.naturalWidth / rect.width);
    const y = Math.round((e.clientY - rect.top) * img.naturalHeight / rect.height);
    const deviceId = $('device-select').value;
    if (!deviceId) return;
    await fetch(`${API}/api/android/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId, x, y }),
    }).catch(() => {});
    setTimeout(() => refreshAndroidScreenshot(), 800);
  };
  $('device-select').onchange = () => {
    const id = $('device-select').value;
    if (id) localStorage.setItem('duocli_android_device', id);
  };
}

function setDeviceHint(msg) {
  showCopyToast(msg);
}

async function refreshAndroidDevices() {
  setDeviceHint('正在加载设备...');
  try {
    const data = await api('/api/android/devices');
    const sel = $('device-select');
    const saved = localStorage.getItem('duocli_android_device');
    sel.innerHTML = '';
    if (data.devices.length) {
      for (const d of data.devices) {
        // 用 DOM API 而非 innerHTML 拼接，避免 adb 输出里的 OEM 设备名注入 HTML
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.info ? `${d.id} ${d.info}` : d.id;
        if (d.id === saved) opt.selected = true;
        sel.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未找到设备';
      sel.appendChild(opt);
    }
    setDeviceHint(data.devices.length ? '' : '未找到已连接的 Android 设备');
  } catch (e) {
    setDeviceHint('获取设备失败: ' + (e.message || e));
  }
}

async function refreshAndroidScreenshot(quality, scale) {
  const deviceId = $('device-select').value;
  if (!deviceId) { setDeviceHint('请先选择设备'); return; }
  try {
    let url = `${API}/api/android/screenshot?deviceId=${encodeURIComponent(deviceId)}`;
    if (quality) url += `&quality=${quality}`;
    if (scale) url += `&scale=${scale}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
    screenshotObjectUrl = URL.createObjectURL(blob);
    const img = $('device-preview');
    img.src = screenshotObjectUrl;
    img.style.display = 'block';
    $('device-preview-empty').style.display = 'none';
    setDeviceHint('截图更新于 ' + new Date().toLocaleTimeString());
  } catch (e) {
    setDeviceHint('截图失败: ' + (e.message || e));
  }
}

// ========== 主页面 ==========

async function renderAppVersionLine() {
  const el = $('app-version-line');
  if (!el) return;
  try {
    let info = lastServerInfo;
    if (!info) {
      const res = await fetch(`${API}/api/server-info`);
      info = await res.json();
      lastServerInfo = info;
    }
    el.textContent = `Posse v${info.version || '?'} · ${(info.sha || '').slice(0, 7)} · client ${CLIENT_BUILD}`;
  } catch {
    el.textContent = `Posse · client ${CLIENT_BUILD}`;
  }
}

async function enterMain() {
  showPage('main-page');
  initDevicePage();
  renderAppVersionLine();
  await refreshSessions();
  await refreshRecentCwdOptions();
  await pullCustomPresetsFromServer(); // 从服务端同步预设
  renderPresetSelect();
  startSSE();
  subscribePush();
  // 预加载 chat 会话列表
  chatSessionsLastFetch = 0;
  fetchChatSessions().then(list => { cachedChatSessions = list || []; });
  // 启动局域网探测（CF 模式提示切换；LAN 模式监控失联回退）
  LanSwitcher.start();
}

async function refreshSessions() {
  try {
    const sessions = await api('/api/sessions');
    renderSessionList(sessions);
  } catch (e) {
    console.error('刷新会话失败', e);
  }
}

async function refreshRecentCwdOptions() {
  const select = $('new-cwd');
  if (!select) return;
  try {
    const res = await api('/api/recent-cwds');
    const items = Array.isArray(res?.items) ? res.items : [];
    // 保留第一个默认选项
    const defaultOpt = select.querySelector('option');
    select.innerHTML = '';
    if (defaultOpt) select.appendChild(defaultOpt);
    for (const p of items) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = shortenPath(p);
      select.appendChild(opt);
    }
  } catch {
    // 保留默认选项
  }
}

// Cache of the most recent live-session array so handlers (e.g. dropping a dead
// card on a not-found open) can re-render without an extra fetch.
let lastSessions = [];

// ---- 按项目文件夹分组（与桌面端侧栏一致）----
// 分组键 = 规范化后的 cwd（去尾部斜杠）；显示标签 = cwd 的最后一段路径。
// 无 cwd / 未知归入兜底分组「其它」。
const FOLDER_COLLAPSE_KEY = 'duocli_collapsed_folders';

function normalizeSessionCwd(cwd) {
  return (cwd || '').trim().replace(/\/+$/, '');
}

function folderLabelFromCwd(cwd) {
  const norm = normalizeSessionCwd(cwd);
  if (!norm) return '其它';
  return norm.split('/').filter(Boolean).pop() || norm;
}

function getCollapsedFolders() {
  try {
    const raw = localStorage.getItem(FOLDER_COLLAPSE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function toggleFolderCollapsed(key) {
  const set = getCollapsedFolders();
  if (set.has(key)) set.delete(key);
  else set.add(key);
  try {
    localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {}
}

// 把扁平 session 列表分组为 [{ key, label, sessions, lastActivity }]，
// 按组内最近活动时间倒序（活跃项目浮在最上），组内保持原有顺序。
function groupSessionsByFolder(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = normalizeSessionCwd(s.cwd) || '__other__';
    let g = groups.get(key);
    if (!g) {
      g = { key, label: folderLabelFromCwd(s.cwd), sessions: [], lastActivity: 0 };
      groups.set(key, g);
    }
    g.sessions.push(s);
    const ts = s.createdAt || 0;
    if (ts > g.lastActivity) g.lastActivity = ts;
  }
  return [...groups.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

function sessionCardHtml(s) {
  const dn = s.displayName || '';
  const [tagColor, tagBg] = dn ? getCliTagColors(dn) : ['', ''];
  const tagHtml = dn
    ? `<span class="cli-tag" style="--cli-c:${tagColor};--cli-bg:${tagBg}">${escHtml(dn)}</span>`
    : '';
  return `
  <div class="session-card" data-id="${s.id}">
    <div class="status-dot ${s.status}"></div>
    <div class="session-info">
      <div class="session-title-row">
        <div class="session-title">${escHtml(s.title || s.presetCommand || '终端')}</div>
        ${tagHtml}
      </div>
      <div class="session-meta">
        <span class="session-time">${formatTime(s.createdAt)}</span>
        <span class="session-cwd">${escHtml((s.cwd || '').split('/').pop() || s.cwd || '')}</span>
      </div>
    </div>
    <div class="session-arrow">›</div>
  </div>`;
}

function renderSessionList(sessions) {
  lastSessions = Array.isArray(sessions) ? sessions : [];
  const list = $('session-list');
  const empty = $('empty-state');

  if (!sessions.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  const collapsed = getCollapsedFolders();
  const groups = groupSessionsByFolder(sessions);
  const html = groups.map(g => {
    const isCollapsed = collapsed.has(g.key);
    const cards = isCollapsed ? '' : g.sessions.map(sessionCardHtml).join('');
    return `
    <div class="folder-group${isCollapsed ? ' collapsed' : ''}" data-folder-key="${escHtml(g.key)}">
      <div class="folder-header" data-folder-key="${escHtml(g.key)}">
        <span class="folder-caret">▾</span>
        <span class="folder-name">${escHtml(g.label)}</span>
        <span class="folder-count">${g.sessions.length}</span>
      </div>
      <div class="folder-sessions">${cards}</div>
    </div>`;
  }).join('');

  list.innerHTML = html;

  list.querySelectorAll('.folder-header').forEach(header => {
    header.onclick = () => {
      toggleFolderCollapsed(header.dataset.folderKey);
      renderSessionList(lastSessions);
    };
  });

  list.querySelectorAll('.session-card').forEach(card => {
    const id = card.dataset.id;
    card.onclick = () => openSession(id);
  });
}

// ========== SSE 实时更新 ==========

function startSSE() {
  stopSSE();
  const profile = getNetworkProfile();
  sseSource = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
  sseSource.onopen = () => {
    sseReconnectAttempt = 0;
  };
  sseSource.addEventListener('sessions', e => {
    try {
      const sessions = JSON.parse(e.data);
      if ($('main-page').classList.contains('active')) {
        renderSessionList(sessions);
      }
      if (currentSessionId) {
        const s = sessions.find(x => x.id === currentSessionId);
        if (s) {
          $('detail-status').className = `status-dot ${s.status}`;
        }
      }
    } catch {}
  });
  sseSource.onerror = () => {
    stopSSE();
    if (navigator.onLine === false) return;
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    const delay = Math.min(profile.sseRetryBaseMs * Math.pow(2, sseReconnectAttempt), profile.sseRetryMaxMs) + Math.floor(Math.random() * 600);
    sseReconnectAttempt++;
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      // 只在主页面时维持 SSE，减少弱网反复连接抖动
      if ($('main-page').classList.contains('active')) {
        startSSE();
      }
    }, delay);
  };
}

function stopSSE() {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
}

// 发送输入：普通文本走 input_b64；回车统一补发 hex(0d)，避免仅靠字符串换行不执行
function sendInputWithHexEnter(raw) {
  if (!raw) return;
  let chunk = '';
  const flushChunk = () => {
    if (!chunk) return;
    wsSend({ type: 'input', data: chunk });
    chunk = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\r' || ch === '\n') {
      flushChunk();
      // CRLF 只发一次回车
      if (ch === '\n' && i > 0 && raw[i - 1] === '\r') continue;
      wsSendHex('0d');
    } else {
      chunk += ch;
    }
  }
  flushChunk();
}

// ========== xterm.js 终端 ==========

function createTerminal() {
  closeTerminal();

  term = new Terminal({
    fontSize: 14,
    fontFamily: "'SF Mono', 'Menlo', 'Courier New', monospace",
    theme: {
      background: '#0d1117',
      foreground: '#c9d1d1',
      cursor: '#3fb950',
      selectionBackground: 'rgba(63, 185, 80, 0.30)',
      black: '#0d1117',
      red: '#f85149',
      green: '#3fb950',
      yellow: '#e5c07b',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#56d4dd',
      white: '#c9d1d1',
      brightBlack: '#484f58',
      brightRed: '#ff7b72',
      brightGreen: '#56d364',
      brightYellow: '#f0c674',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#76e3ea',
      brightWhite: '#ffffff',
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    // 禁用光标样式同步，减少渲染
    cursorStyle: 'block',
    cursorInactiveStyle: 'none',
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // 启用 unicode v11 字宽表，让 Braille spinner / emoji / CJK 等字符
  // 在手机端按和 PC 端 PTY 一致的列宽计算光标位置，避免 wrap 撕裂多行
  try {
    if (typeof Unicode11Addon !== 'undefined') {
      term.loadAddon(new Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    }
  } catch {}

  // 自动识别 URL，点按在新标签页打开（移动端无修饰键，直接 tap 打开）
  try {
    if (typeof WebLinksAddon !== 'undefined') {
      term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }));
    }
  } catch {}

  const container = $('terminal-container');
  // 清除旧终端 DOM，但保留 loading 遮罩
  const loading = $('terminal-loading');
  container.innerHTML = '';
  if (loading) container.appendChild(loading);
  // 显示 loading
  if (loading) loading.classList.remove('hidden');
  term.open(container);

  // 终端键盘输入 → WebSocket
  term.onData((data) => {
    sendInputWithHexEnter(data);
  });

  // 窗口大小变化 → resize
  window.addEventListener('resize', handleResize);

  // 返回 Promise，确保终端完全 ready 后再做后续操作（如连接 WebSocket）
  // 双重 rAF 确保页面切换后 DOM 布局完成，避免 fit 算出 0 列 0 行
  return new Promise((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => {
      safeFit();
      // 移动端：禁止点击终端区域弹出键盘
      const xtermTextarea = container.querySelector('.xterm-helper-textarea');
      if (xtermTextarea) {
        xtermTextarea.setAttribute('readonly', 'readonly');
      }

      // 移动端触摸滚动：xterm.js 的 .xterm-screen 覆盖在 .xterm-viewport 上层，
      // 手指实际触摸到的是 screen，所以监听必须挂在 screen（或同时挂 viewport 兜底），
      // 然后直接操作 viewport.scrollTop，让 xterm 内部 onScroll 同步渲染。
      const screen = container.querySelector('.xterm-screen');
      const viewport = container.querySelector('.xterm-viewport');
      term.onScroll(() => {
        markUserScrolling();
      });

      // 测量实际行高（像素 → 行数换算用），取不到时退回到经验值 17px
      const getCellHeight = () => {
        const rows = container.querySelector('.xterm-rows');
        const h = rows && rows.children[0] ? rows.children[0].getBoundingClientRect().height : 0;
        return h > 0 ? h : 17;
      };

      let touchLastY = 0;
      let touchActive = false;
      let touchAccum = 0;
      const onTouchStart = (e) => {
        if (e.touches.length !== 1) { touchActive = false; return; }
        touchLastY = e.touches[0].clientY;
        touchAccum = 0;
        touchActive = true;
      };
      const onTouchMove = (e) => {
        if (!touchActive || e.touches.length !== 1) return;
        const currentY = e.touches[0].clientY;
        const deltaY = touchLastY - currentY;
        touchLastY = currentY;
        if (deltaY === 0) return;
        // 直接操作 xterm 视口（scrollLines），避免 viewport.scrollTop 被 xterm 渲染时回弹
        // 手指下滑 currentY>touchLastY → deltaY<0 → lines<0 → 向上看更早的内容
        const cellH = getCellHeight();
        touchAccum += deltaY;
        const lines = Math.trunc(touchAccum / cellH);
        if (lines !== 0) {
          touchAccum -= lines * cellH;
          term.scrollLines(lines);
          markUserScrolling();
          if (e.cancelable) e.preventDefault();
        }
      };
      const onTouchEnd = () => {
        touchActive = false;
        if (term && viewport && viewport.scrollTop >= (viewport.scrollHeight - viewport.clientHeight - 2)) isUserScrolling = false;
      };

      // screen 必须监听（用户手指实际接触的层），viewport 也监听以兜底滚动条区域
      [screen, viewport].forEach((el) => {
        if (!el) return;
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        el.addEventListener('touchcancel', onTouchEnd, { passive: true });
      });

      // 兜底：部分设备/版本 .xterm-screen 内层 canvas 会吃掉触摸事件，
      // 在最外层 container 上再挂一份滚动逻辑，同样操作 viewport.scrollTop 做像素级滚动。
      // 命中内层 screen/viewport 时跳过，避免和上面那套一起触发导致滑动距离翻倍
      if (!container.dataset.scrollFallbackBound) {
        container.dataset.scrollFallbackBound = '1';
        let fbLastY = 0;
        let fbActive = false;
        let fbAccum = 0;
        const isHandledByInner = (e) => {
          const t = e.target;
          if (!t || !t.closest) return false;
          return !!(t.closest('.xterm-screen') || t.closest('.xterm-viewport'));
        };
        container.addEventListener('touchstart', (e) => {
          if (isHandledByInner(e)) { fbActive = false; return; }
          if (e.touches.length !== 1) { fbActive = false; return; }
          fbLastY = e.touches[0].clientY;
          fbAccum = 0;
          fbActive = true;
        }, { passive: true });
        container.addEventListener('touchmove', (e) => {
          if (!fbActive || !term || e.touches.length !== 1) return;
          if (isHandledByInner(e)) return;
          const currentY = e.touches[0].clientY;
          const deltaY = fbLastY - currentY;
          fbLastY = currentY;
          if (deltaY === 0) return;
          // 同上：用 scrollLines 滚动 xterm 视口，避免 scrollTop 回弹
          const cellH = getCellHeight();
          fbAccum += deltaY;
          const lines = Math.trunc(fbAccum / cellH);
          if (lines !== 0) {
            fbAccum -= lines * cellH;
            term.scrollLines(lines);
            markUserScrolling();
            if (e.cancelable) e.preventDefault();
          }
        }, { passive: false });
        const fbEnd = () => {
          fbActive = false;
          if (term && viewport && viewport.scrollTop >= (viewport.scrollHeight - viewport.clientHeight - 2)) isUserScrolling = false;
        };
        container.addEventListener('touchend', fbEnd, { passive: true });
        container.addEventListener('touchcancel', fbEnd, { passive: true });
      }

      if (!container.dataset.copyBound) {
        // 长按复制：优先复制已选中文本；未选择时复制当前按住行
        let copyPressTimer = null;
        let copyStartX = 0;
        let copyStartY = 0;
        let copyLineY = 0;
        const cancelCopyPress = () => {
          if (copyPressTimer) {
            clearTimeout(copyPressTimer);
            copyPressTimer = null;
          }
        };
        container.addEventListener('touchstart', (e) => {
          if (!term || e.touches.length !== 1) return;
          const t = e.touches[0];
          copyStartX = t.clientX;
          copyStartY = t.clientY;
          copyLineY = t.clientY;
          cancelCopyPress();
          copyPressTimer = setTimeout(async () => {
            let text = term.hasSelection() ? term.getSelection().trim() : '';
            if (!text) text = getLineTextByTouchY(copyLineY);
            if (!text) {
              showCopyToast('当前无可复制内容');
              return;
            }
            const ok = await copyTextToClipboard(text);
            showCopyToast(ok ? '已复制到剪贴板' : '复制失败');
          }, 520);
        }, { passive: true });
        container.addEventListener('touchmove', (e) => {
          if (!copyPressTimer || e.touches.length !== 1) return;
          const t = e.touches[0];
          if (Math.abs(t.clientX - copyStartX) > 10 || Math.abs(t.clientY - copyStartY) > 10) {
            cancelCopyPress();
          }
        }, { passive: true });
        container.addEventListener('touchend', cancelCopyPress, { passive: true });
        container.addEventListener('touchcancel', cancelCopyPress, { passive: true });
        container.dataset.copyBound = '1';
      }

      // 绑定 canvas context lost 监听（黑屏修复）
      if (typeof bindCanvasContextLost === 'function') {
        setTimeout(bindCanvasContextLost, 100);
      }

      resolve(term);
    }); });
  });
}

function handleResize() {
  if (!fitAddon || !term) return;
  // fit() 会改变终端行列数，可能导致 viewport 意外跳到顶部。
  // 记录 fit 前是否在底部，fit 后恢复。
  const wasAtBottom = isAtBottom();
  safeFit();
  if (wasAtBottom) {
    term.scrollToBottom();
  }
  if (ws && ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
    wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
  }
}

function closeTerminal() {
  window.removeEventListener('resize', handleResize);
  closeWebSocket();
  // 重置 spinner 拦截状态
  resetSpinnerState();
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
}

// ========== Spinner 拦截（手机窄屏优化） ==========

// 手机端列数少（40-50），CLI spinner（如 ⠋⠙⠹ braille 动画或逐字变色）
// 用 \r 覆盖同一行，但内容超宽 wrap 后 \r 无法清除上方残留行，导致重复多行。
// 此模块在 term.write 前拦截 spinner 帧，替换为截断的静态文本。

const spinnerState = {
  active: false,          // 当前是否处于 spinner 拦截模式
  consecutiveCRFrames: 0, // 连续只含 \r 不含 \n 的帧计数
  spinnerLine: '',        // 当前拦截到的 spinner 纯文本
  cooldownUntil: 0,       // 冷却期截止时间（避免 spinner 结束后误拦截）
  lastRefreshTime: 0,     // 上次刷新终端显示的时间戳（限频用）
};

/** 重置 spinner 拦截状态（退出 spinner 模式或关闭终端时调用） */
function resetSpinnerState(cooldownMs) {
  spinnerState.active = false;
  spinnerState.consecutiveCRFrames = 0;
  spinnerState.spinnerLine = '';
  spinnerState.cooldownUntil = cooldownMs ? Date.now() + cooldownMs : 0;
  spinnerState.lastRefreshTime = 0;
}

/** 去除 ANSI escape sequences，返回纯文本 */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI 序列 (含 ? 私有参数, 如 \x1b[?25l)
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC + BEL
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')      // OSC + ST
    .replace(/\x1b\([B0UK]/g, '')               // 字符集指定
    .replace(/\x1b[()][B0UK]/g, '');           // 字符集指定 (另一形式)
}

/** 从 spinner 原始数据中提取纯文本 */
function extractSpinnerText(rawData) {
  let text = rawData;
  text = text.replace(/^\r+/, '');  // 去掉开头的 \r
  text = stripAnsi(text);
  text = text.trimEnd();
  return text;
}

/** 将 braille spinner 等动画字符替换为简化的省略号 */
function simplifySpinnerText(text) {
  // Braille spinner 字符
  text = text.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+/g, '…');
  // 旋转线 spinner（至少 3 个连续字符才匹配，避免误伤 |- 或 -- 等短组合）
  text = text.replace(/[|/\\-]{3,}/g, '…');
  // 合并连续省略号
  text = text.replace(/…{2,}/g, '…');
  return text;
}

/**
 * 判断 output 帧类型
 * 返回: 'spinner' | 'spinner-final' | 'normal'
 */
function classifyOutputFrame(data) {
  if (!data || data.length === 0) return 'normal';

  const hasCR = data.includes('\r');
  const hasNewline = data.includes('\n');

  // 含 \n 不含 \r：正常输出
  if (hasNewline && !hasCR) return 'normal';

  // 含 \n 且含 \r：
  //   - spinner 模式下：视为 spinner 最终帧
  //   - 非 spinner 模式：正常输出
  if (hasNewline && hasCR) {
    if (spinnerState.active) return 'spinner-final';
    return 'normal';
  }

  // 只含 \r 不含 \n：spinner 的典型特征
  if (hasCR) {
    const strippedLen = stripAnsi(data).length;
    // 内容太长（> 300）不太可能是典型 spinner，保守放行
    if (strippedLen > 300) return 'normal';
    return 'spinner';
  }

  // 没有 \r 也没有 \n：正常输出分片
  return 'normal';
}

/**
 * 核心：拦截处理 spinner 帧
 * 返回应写入 term 的数据；返回 null 表示丢弃该帧
 */
function interceptSpinnerData(rawData) {
  const classification = classifyOutputFrame(rawData);
  const now = Date.now();

  // 冷却期内非 spinner 帧直接放行
  if (spinnerState.cooldownUntil > now && classification !== 'spinner') {
    return rawData;
  }

  // --- normal：如果正在 spinner 模式则退出，否则直接放行 ---
  if (classification === 'normal') {
    if (spinnerState.active) {
      // spinner 模式结束，清行退出
      resetSpinnerState(300);
      // 先清掉之前写到终端的 spinner 行
      return '\r\x1b[K' + rawData;
    }
    return rawData;
  }

  // --- spinner-final：spinner 结束帧 ---
  if (classification === 'spinner-final') {
    if (spinnerState.active) {
      resetSpinnerState(300);
      // 清行后写最终内容
      return '\r\x1b[K' + rawData;
    }
    return rawData;
  }

  // --- spinner：含 \r 不含 \n 的帧 ---
  if (classification === 'spinner') {
    spinnerState.consecutiveCRFrames++;

    // 连续 2 帧 \r-only 才激活拦截（避免单次 \r 误触）
    if (!spinnerState.active && spinnerState.consecutiveCRFrames < 2) {
      return rawData; // 还在确认阶段，先正常输出
    }

    // 激活 spinner 模式
    if (!spinnerState.active) {
      spinnerState.active = true;
      spinnerState.spinnerLine = '';
    }

    // 提取并简化文本
    const newText = simplifySpinnerText(extractSpinnerText(rawData));

    // 内容没变化就不刷新
    if (newText === spinnerState.spinnerLine) {
      return null;
    }
    spinnerState.spinnerLine = newText;

    // 200ms 限频，避免高频渲染
    if (spinnerState.lastRefreshTime && now - spinnerState.lastRefreshTime < 200) {
      return null;
    }
    spinnerState.lastRefreshTime = now;

    // 截断到终端列宽 - 4，防止再次 wrap
    const maxLen = (term ? term.cols : 40) - 4;
    let display = newText;
    if (display.length > maxLen) {
      display = display.substring(0, maxLen) + '…';
    }

    // \r 回到行首，\x1b[K 清除整行，然后写简化文本
    return '\r\x1b[K' + display;
  }

  return rawData;
}

// ========== WebSocket ==========

function connectWebSocket(sessionId) {
  closeWebSocket();
  hideWeakNetworkPrompt();
  const profile = getNetworkProfile();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[ws] onopen, term exists=', !!term);
    hideWeakNetworkPrompt();
    wsReconnectAttempt = 0;
    wsLastPongAt = Date.now();
    // 重连时清空终端，避免 replay 叠加
    if (term) term.reset();
    // 订阅会话
    wsSend({ type: 'subscribe', sessionId });
    // 发送当前终端尺寸（过滤无效值，避免 pty resize(0,0) 异常）
    if (term && term.cols > 0 && term.rows > 0) {
      console.log('[ws] sending resize', term.cols, term.rows);
      wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
    } else {
      console.log('[ws] skipping resize, cols=', term?.cols, 'rows=', term?.rows);
    }
    // 心跳保活，防止 iOS Safari 后台杀连接
    clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(() => {
      wsSend({ type: 'ping' });
      // 超过 45 秒未收到任何服务端消息（含 pong）则主动断开并重连
      if (Date.now() - wsLastPongAt > profile.wsStaleTimeoutMs && ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, profile.wsPingIntervalMs);
  };

  let replayReceived = false;
  let replayRetryTimer = null;
  let replayRetryCount = 0;

  // 8秒内未收到 replay，显示重连提示
  if (wsConnectTimeoutTimer) clearTimeout(wsConnectTimeoutTimer);
  wsConnectTimeoutTimer = setTimeout(() => {
    if (!replayReceived && term) {
      hideTerminalLoading();
      term.write('\r\n\x1b[33m⚠ 连接超时，正在重连...\x1b[0m\r\n');
      showWeakNetworkPrompt('连接超时，正在重试');
    }
  }, profile.wsConnectTimeoutMs);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (!term) return;
      wsLastPongAt = Date.now();

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'replay') {
        replayReceived = true;
        if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
        hideWeakNetworkPrompt();
        console.log('[ws] replay received, data length=', (msg.data || '').length);
        // 先彻底清空，再写入 replay 内容，避免残留
        term.reset();
        if (msg.data) {
          // 有内容，隐藏 loading 并写入
          hideTerminalLoading();
          term.write(msg.data, () => {
            if (!isUserScrolling) {
              term.scrollToBottom();
            }
          });
        } else {
          // replay 为空（新建会话，pty 刚启动）：也隐藏 loading，连接已成功
          hideTerminalLoading();
          // 延迟重新订阅以获取最新 buffer，最多重试 3 次
          if (!replayRetryTimer && replayRetryCount < 3) {
            replayRetryCount++;
            replayRetryTimer = setTimeout(() => {
              replayRetryTimer = null;
              if (ws && ws.readyState === WebSocket.OPEN && currentSessionId === sessionId) {
                wsSend({ type: 'subscribe', sessionId });
              }
            }, 800);
          }
        }
      } else if (msg.type === 'output') {
        hideTerminalLoading();
        hideWeakNetworkPrompt();

        // 手机窄屏 spinner 拦截：避免 \r 覆盖帧 wrap 后产生多行残留
        let writeData = msg.data;
        if (term && term.cols <= 60) {
          writeData = interceptSpinnerData(msg.data);
        }

        if (writeData !== null) {
          const shouldStickToBottom = !isUserScrolling && isAtBottom();
          term.write(writeData);
          if (shouldStickToBottom) {
            if (scrollToBottomTimer) clearTimeout(scrollToBottomTimer);
            scrollToBottomTimer = setTimeout(() => {
              term.scrollToBottom();
            }, 50);
          }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    clearInterval(wsHeartbeat);
    if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
    if (navigator.onLine === false) return;
    // 如果还在详情页，尝试重连
    if (currentSessionId === sessionId && $('detail-page').classList.contains('active')) {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      const delay = Math.min(profile.wsRetryBaseMs * Math.pow(2, wsReconnectAttempt), profile.wsRetryMaxMs) + Math.floor(Math.random() * 500);
      wsReconnectAttempt++;
      showWeakNetworkPrompt('连接中断，正在重试');
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        if (currentSessionId === sessionId && $('detail-page').classList.contains('active')) {
          connectWebSocket(sessionId);
        }
      }, delay);
    }
  };

  ws.onerror = () => {
    // 某些浏览器弱网下只触发 onerror 不触发 onclose，主动 close 统一走重连逻辑
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  };
}

function closeWebSocket() {
  clearInterval(wsHeartbeat);
  hideWeakNetworkPrompt();
  if (wsConnectTimeoutTimer) { clearTimeout(wsConnectTimeoutTimer); wsConnectTimeoutTimer = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) {
    // close() 是异步的，关闭过程中已在路上的帧仍会调用旧 ws 的 onmessage，
    // 全置 null 避免会话切换时旧 session 的输出写入新 term
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onopen = null;
    ws.close();
    ws = null;
  }
}

// 将 Uint8Array 或普通数组安全转为 base64（避免 spread 栈溢出）
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // 对 input 类型的数据，用 base64 编码传输，避免控制字符在 JSON 中丢失
    if (data.type === 'input' && data.data) {
      const bytes = new TextEncoder().encode(data.data);
      const b64 = uint8ToBase64(bytes);
      ws.send(JSON.stringify({ type: 'input_b64', data: b64 }));
    } else {
      ws.send(JSON.stringify(data));
    }
  }
}

// ========== 会话详情 ==========

async function openSession(id) {
  console.log('[openSession] start, id=', id);

  // 定向校验：打开前确认该 live 会话仍存在。若服务端已无此会话（且不可恢复），
  // 说明这是一张失效的死卡片——移除它并提示，避免进入一个永远连不上的终端。
  // 失败安全：只有在服务端明确返回会话列表且其中没有该 id 时才移除；
  // 网络/超时等不确定情况一律放行（不删卡）。
  try {
    const sessions = await api('/api/sessions');
    if (Array.isArray(sessions) && !sessions.find(x => x.id === id)) {
      console.warn('[openSession] session no longer exists, removing dead card:', id);
      lastSessions = sessions.filter(x => x.id !== id);
      renderSessionList(lastSessions);
      showCopyToast('会话已不存在，已从列表移除');
      return;
    }
  } catch (e) {
    // 不确定会话是否存在（网络/超时）→ 不删卡，继续按原流程打开
    console.warn('[openSession] existence check failed, opening anyway', e);
  }

  currentSessionId = id;
  showPage('detail-page');

  // 更新标题（不阻塞 WebSocket 连接）
  api('/api/sessions').then(sessions => {
    const s = sessions.find(x => x.id === id);
    if (s && currentSessionId === id) {
      $('detail-name').textContent = s.title || s.presetCommand || '终端';
      $('detail-status').className = `status-dot ${s.status}`;
      lastKnownSessionCwd = s.cwd || '';
    }
  }).catch(() => {});

  // 创建终端并连接 WebSocket（等终端 ready 后再连，避免 replay 数据丢失）
  console.log('[openSession] creating terminal...');
  await createTerminal();
  console.log('[openSession] terminal ready, cols=', term?.cols, 'rows=', term?.rows);
  connectWebSocket(id);
  console.log('[openSession] connectWebSocket called');
}

// 点击标题编辑
$('detail-name').onclick = async () => {
  if (!currentSessionId) return;
  const current = $('detail-name').textContent || '';
  const newTitle = prompt('修改标题', current);
  if (newTitle === null || newTitle.trim() === '' || newTitle.trim() === current) return;
  try {
    const res = await api(`/api/sessions/${currentSessionId}/title`, {
      method: 'PUT',
      body: JSON.stringify({ title: newTitle.trim() }),
    });
    if (res.ok) {
      $('detail-name').textContent = newTitle.trim();
    }
  } catch (e) {
    console.error('修改标题失败', e);
  }
};

// 返回按钮
$('back-btn').onclick = () => {
  currentSessionId = null;
  closeTerminal();
  showPage('main-page');
  refreshSessions();
};

// 发送消息 — 点击发送按钮
// 用 touchend 替代 onclick，避免手机端 textarea 失焦吞掉第一次点击
$('send-btn').addEventListener('touchend', (e) => {
  e.preventDefault();
  sendMessage();
});
$('send-btn').onclick = sendMessage; // 桌面端兜底

// iOS 键盘"发送"在 textarea 上会插入换行符，用轮询检测并发送
// 保存换行前的文本，防止纯换行时丢失内容
let pendingText = '';
setInterval(() => {
  const input = $('msg-input');
  if (!input || !currentSessionId) return;
  const val = input.value;
  if (val && (val.includes('\n') || val.includes('\r'))) {
    const cleaned = val.replace(/[\r\n]/g, '');
    input.value = '';
    const textToSend = cleaned || pendingText;
    pendingText = '';
    if (textToSend) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendInputWithHexEnter(textToSend);
        wsSendHex('0d');
      } else {
        api(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          body: JSON.stringify({ input: textToSend }),
        }).catch(() => {});
      }
    }
    if (term) term.scrollToBottom();
  } else if (val) {
    pendingText = val;
  } else {
    // val 为空说明用户清空了输入，立即重置 pendingText，
    // 避免下次纯换行时把上一次残留内容重复发送
    pendingText = '';
  }
}, 50);

function sendMessage() {
  const input = $('msg-input');
  const text = input.value.replace(/[\r\n]/g, '');
  if (!currentSessionId) return;
  input.value = '';
  pendingText = '';

  if (text) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendInputWithHexEnter(text);
      wsSendHex('0d');
    } else {
      // WebSocket 不可用时走 HTTP API 兜底
      api(`/api/sessions/${currentSessionId}/input`, {
        method: 'POST',
        body: JSON.stringify({ input: text }),
      }).catch(() => showCopyToast('发送失败，连接已断开'));
    }
  } else {
    // 空消息只发回车
    wsSendHex('0d');
  }
  if (term) term.scrollToBottom();
}

// 发送 hex 编码的原始字节（用于回车、控制字符等）
function wsSendHex(hexStr) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const bytes = hexStr.match(/.{2}/g).map(h => parseInt(h, 16));
    const b64 = uint8ToBase64(bytes);
    ws.send(JSON.stringify({ type: 'input_b64', data: b64 }));
  }
}

// ========== iOS 键盘弹出时输入框紧贴键盘 ==========
if (window.visualViewport) {
  const vv = window.visualViewport;
  // 记住上一次键盘是否打开。adjustForKeyboard 同时挂在 vv 的 resize + scroll 上，
  // 而 iOS 在终端触摸滑动时也会持续派发 vv 'scroll' 事件 → 该函数会在滑动过程中反复触发。
  // 早先版本（d62d608）每次触发都会 requestAnimationFrame(() => safeFit())，即 term.resize()，
  // 滑动中途 resize 会把 xterm 视口弹回底部 → 终端表现为“无法触摸滚动”（#61 回归）。
  // 修复：只有键盘“开/关状态真正切换”时才重排页面 + 重新 fit；键盘开着时的 vv scroll
  // 仍维持顶栏吸附（cheap：top/height/scrollTo），但绝不再 fit，从而放行触摸滚动。
  let keyboardOpen = false;
  function adjustForKeyboard() {
    // Whichever input-bearing page is active (terminal detail or chat detail).
    const page = ['detail-page', 'chat-detail-page'].map(id => $(id)).find(p => p && p.classList.contains('active'));
    if (!page) return;

    const inputArea = $('input-area');
    const shortcutBar = $('shortcut-bar');

    const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const nowOpen = keyboardHeight > 50;
    const transitioned = nowOpen !== keyboardOpen;
    keyboardOpen = nowOpen;

    if (nowOpen) {
      // Keyboard open. Pin the page to the VISUAL viewport: top = vv.offsetTop and
      // height = vv.height. Earlier this used top:0 + bottom:keyboardHeight, but iOS
      // also SCROLLS the layout viewport up to reveal the focused input, which carried
      // the position:fixed header off-screen (#40). Anchoring to offsetTop + forcing the
      // layout viewport back to 0 keeps the header pinned at the visible top.
      // 这一段每次都跑（即便没切换状态），保证键盘开着时顶栏持续吸附在可视顶部（#40）。
      page.style.top = vv.offsetTop + 'px';
      page.style.bottom = 'auto';
      page.style.height = vv.height + 'px';
      if (inputArea) inputArea.style.paddingBottom = '6px';
      if (shortcutBar) shortcutBar.style.paddingBottom = '0';
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    } else if (transitioned) {
      page.style.top = '';
      page.style.bottom = '';
      page.style.height = '';
      if (inputArea) inputArea.style.paddingBottom = '';
      if (shortcutBar) shortcutBar.style.paddingBottom = '';
    }

    // 仅在键盘开/关切换时重新 fit 终端。键盘未变（典型：终端触摸滑动触发的 vv scroll）
    // 时不能 resize，否则会打断/弹回正在进行的触摸滚动（#61）。
    if (transitioned && fitAddon && term) {
      requestAnimationFrame(() => safeFit());
    }
  }

  vv.addEventListener('resize', adjustForKeyboard);
  vv.addEventListener('scroll', adjustForKeyboard);
}

// ===== Swipe-right to go back to the session list (#39) =====
// Mobile has no persistent sidebar — pages are full-screen swaps. An edge-swipe
// from the LEFT margin navigates back to the main list, the standard drawer/back
// gesture. Starting at the edge avoids hijacking terminal horizontal interactions.
(function setupSwipeBack() {
  const EDGE = 32;        // px from left where a back-swipe may start
  const DIST = 70;        // min horizontal travel
  let sx = 0, sy = 0, tracking = false;
  function backFor(pageId) {
    if (pageId === 'detail-page') { const b = $('back-btn'); if (b) b.click(); return true; }
    if (pageId === 'chat-detail-page') { const b = $('chat-back-btn'); if (b) b.click(); return true; }
    return false;
  }
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    tracking = t.clientX <= EDGE;
    sx = t.clientX; sy = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (dx > DIST && Math.abs(dx) > Math.abs(dy) * 2) {
      const page = ['detail-page', 'chat-detail-page'].find(id => $(id) && $(id).classList.contains('active'));
      if (page) backFor(page);
    }
  }, { passive: true });
})();

// 快捷键按钮 — 通过 WebSocket 发送原始键码（不弹键盘）

// ========== 快捷命令栏 ==========

const QCMD_STORAGE_KEY = 'duocli_quick_commands';
const QCMD_DEFAULTS = ['/new', '/help', '/compact', '/unicloud-log-viewer', '/uniapp-dev'];

function loadQuickCommands() {
  try {
    const saved = localStorage.getItem(QCMD_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return [...QCMD_DEFAULTS];
}

function saveQuickCommands(cmds) {
  localStorage.setItem(QCMD_STORAGE_KEY, JSON.stringify(cmds));
}

function renderQuickCommands() {
  const bar = $('quick-commands');
  if (!bar) return;
  bar.innerHTML = '';
  const cmds = loadQuickCommands();

  cmds.forEach((cmd, idx) => {
    const btn = document.createElement('button');
    btn.className = 'qcmd-btn';
    btn.textContent = cmd;
    // 点击 → 填入输入框（不自动发送，由用户审阅后点发送）
    btn.onclick = () => {
      if (!currentSessionId) return;
      const input = $('msg-input');
      if (input) {
        const prev = input.value;
        input.value = prev ? prev + cmd : cmd;
        pendingText = input.value;
        input.focus();
      }
    };
    // 长按 → 删除
    let longTimer = null;
    btn.addEventListener('touchstart', (e) => {
      longTimer = setTimeout(() => {
        longTimer = null;
        if (confirm(`删除快捷命令「${cmd}」？`)) {
          const list = loadQuickCommands();
          list.splice(idx, 1);
          saveQuickCommands(list);
          renderQuickCommands();
        }
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', () => { if (longTimer) clearTimeout(longTimer); });
    btn.addEventListener('touchmove', () => { if (longTimer) clearTimeout(longTimer); });
    bar.appendChild(btn);
  });

  // 添加按钮
  const addBtn = document.createElement('button');
  addBtn.className = 'qcmd-btn qcmd-add';
  addBtn.textContent = '+ 添加';
  addBtn.onclick = () => {
    const cmd = prompt('输入快捷命令：');
    if (cmd && cmd.trim()) {
      const list = loadQuickCommands();
      list.push(cmd.trim());
      saveQuickCommands(list);
      renderQuickCommands();
    }
  };
  bar.appendChild(addBtn);
}

renderQuickCommands();

// ========== 文件上传 ==========
$('upload-btn').onclick = () => {
  $('file-input').click();
};

$('file-input').onchange = async (e) => {
  const files = e.target.files;
  if (!files || !files.length || !currentSessionId) return;

  const btn = $('upload-btn');
  btn.classList.add('uploading');

  for (const file of files) {
    try {
      const res = await fetch(`${API}/api/sessions/${currentSessionId}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const data = await res.json();
      if (data.ok) {
        // 在终端显示上传成功提示
        if (term) term.write(`\r\n\x1b[32m✓ 已上传: ${file.name} (${formatSize(data.size)})\x1b[0m\r\n`);
        // 把文件路径填入输入框，方便用户直接发送给 AI
        if (data.path) {
          const input = $('msg-input');
          const prev = input.value.trim();
          input.value = prev ? prev + ' ' + data.path : data.path;
        }
      } else {
        if (term) term.write(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${data.error}\x1b[0m\r\n`);
      }
    } catch (err) {
      if (term) term.write(`\r\n\x1b[31m✗ 上传失败: ${file.name} - ${err.message}\x1b[0m\r\n`);
    }
  }

  btn.classList.remove('uploading');
  e.target.value = ''; // 清空，允许重复选同一文件
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// 危险按键：需要两步确认（先点亮「武装」，2s 内再点才触发）
const DANGEROUS_KEYS = new Set(['\\r', 'y\\r', '\\x03']);
let armedKeyBtn = null;
let armedKeyTimer = null;

function disarmKey() {
  if (armedKeyTimer) { clearTimeout(armedKeyTimer); armedKeyTimer = null; }
  if (armedKeyBtn) {
    armedKeyBtn.classList.remove('armed');
    if (armedKeyBtn.dataset.origLabel != null) {
      armedKeyBtn.textContent = armedKeyBtn.dataset.origLabel;
    }
    armedKeyBtn = null;
  }
}

document.querySelectorAll('.key-btn').forEach(btn => {
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!currentSessionId) return;
    const key = btn.dataset.key;

    const fire = () => {
      const parsed = key.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\n/g, '\n');
      sendInputWithHexEnter(parsed);
    };

    if (DANGEROUS_KEYS.has(key)) {
      if (armedKeyBtn === btn) {
        // 第二次点击 → 触发
        disarmKey();
        fire();
      } else {
        // 第一次点击 → 武装
        disarmKey();
        armedKeyBtn = btn;
        btn.dataset.origLabel = btn.textContent;
        btn.classList.add('armed');
        btn.textContent = '确认?';
        armedKeyTimer = setTimeout(disarmKey, 2000);
      }
      return;
    }

    // 非危险按键：立即触发，并解除任何已武装状态
    disarmKey();
    fire();
  });
});

// 删除会话
$('delete-btn').onclick = async () => {
  if (!currentSessionId) return;
  if (!confirm('确定终止此会话？')) return;
  try {
    await api(`/api/sessions/${currentSessionId}`, { method: 'DELETE' });
    currentSessionId = null;
    closeTerminal();
    showPage('main-page');
    refreshSessions();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
};

// ========== 自定义预设 ==========

const CUSTOM_PRESETS_KEY = 'duocli_custom_presets';
const MOBILE_THEME_KEY = 'duocli_mobile_new_theme';

const BUILTIN_OPTIONS = [
  { value: '', label: '纯终端 (shell)' },
  { value: 'claude --dangerously-skip-permissions', label: 'Claude 全自动' },
  { value: 'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"', label: 'Codex 全自动' },
  { value: 'copilot --allow-all --autopilot', label: 'Copilot 全自动' },
];

let customPresetNextId = 1;

function getCustomPresets() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '[]'); } catch { return []; }
}

function saveCustomPresets(list) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  // 同步到服务端
  if (token && API) {
    fetch(`${API}/api/custom-presets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(list),
    }).catch(() => {});
  }
}

async function pullCustomPresetsFromServer() {
  if (!token || !API) {
    console.log('[Mobile Preset] No token or API, skipping server sync');
    return;
  }
  
  console.log('[Mobile Preset] Pulling presets from server...');
  
  try {
    const serverPresets = await api('/api/custom-presets');
    console.log('[Mobile Preset] Server response:', serverPresets);
    
    if (Array.isArray(serverPresets)) {
      const localPresets = getCustomPresets();
      console.log('[Mobile Preset] Local presets:', localPresets.length, 'items');
      console.log('[Mobile Preset] Server presets:', serverPresets.length, 'items');
      
      if (serverPresets.length > 0) {
        // 服务端有预设，进行合并（服务端优先）
        const merged = new Map();
        for (const p of localPresets) merged.set(p.id, p);
        for (const p of serverPresets) merged.set(p.id, p);
        const list = Array.from(merged.values());
        
        console.log('[Mobile Preset] Merged presets:', list.length, 'items');
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
      } else if (localPresets.length > 0) {
        // 服务端没有预设，把本地的推上去
        console.log('[Mobile Preset] No server presets, pushing local presets to server');
        fetch(`${API}/api/custom-presets`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(localPresets),
        }).catch(err => {
          console.error('[Mobile Preset] Failed to push local presets:', err);
        });
      } else {
        console.log('[Mobile Preset] No presets on either side');
      }
    } else {
      console.warn('[Mobile Preset] Invalid server response format:', typeof serverPresets);
    }
  } catch (e) {
    console.error('[Mobile Preset] Failed to pull presets from server:', e);
  }
}

// 初始化自定义预设 ID 计数器
(function initCustomPresetId() {
  const customs = getCustomPresets();
  for (const p of customs) {
    const m = p.id && p.id.match(/custom-(\d+)/);
    if (m) customPresetNextId = Math.max(customPresetNextId, parseInt(m[1]) + 1);
  }
})();

function renderPresetSelect() {
  const presetSelect = $('new-preset');
  if (!presetSelect) return;
  const prev = presetSelect.value;
  presetSelect.innerHTML = '';

  // 内置选项
  for (const opt of BUILTIN_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    presetSelect.appendChild(el);
  }

  // 自定义预设
  const customs = getCustomPresets();
  console.log('[Mobile Preset] Rendering preset select with', customs.length, 'custom presets');
  
  if (customs.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '── 自定义 ──';
    presetSelect.appendChild(sep);

    for (const p of customs) {
      console.log('[Mobile Preset] Adding custom preset:', p.name, '→', p.command);
      const el = document.createElement('option');
      el.value = p.autoFlag ? p.command + ' ' + p.autoFlag : p.command;
      el.textContent = p.autoFlag ? p.name + ' (全自动)' : p.name;
      presetSelect.appendChild(el);
    }
  }

  // 恢复之前的选中值
  if (prev) presetSelect.value = prev;
  if (presetSelect.selectedIndex === -1) presetSelect.value = '';
}

function showPresetDialog(preset) {
  return new Promise((resolve) => {
    const isEdit = !!preset;
    const overlay = document.createElement('div');
    overlay.className = 'modal active';
    overlay.style.zIndex = '1001';
    const dialog = document.createElement('div');
    dialog.className = 'modal-content';
    dialog.innerHTML = `
      <h3>${isEdit ? '编辑' : '新建'}自定义预设</h3>
      <label>名称</label>
      <input type="text" id="preset-name-input" placeholder="如 Aider、自定义 CLI 等" value="${preset ? preset.name : ''}" />
      <label>启动命令</label>
      <input type="text" id="preset-cmd-input" placeholder="如 aider、my-cli 等" value="${preset ? preset.command : ''}" />
      <label>全自动参数（可选）</label>
      <input type="text" id="preset-auto-input" placeholder="如 --yes、--yolo 等" value="${preset ? preset.autoFlag : ''}" />
      <div class="modal-actions">
        <button id="preset-dialog-cancel" class="btn-secondary">取消</button>
        <button id="preset-dialog-ok" class="btn-primary">确定</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('#preset-name-input');
    const cmdInput = dialog.querySelector('#preset-cmd-input');
    const autoInput = dialog.querySelector('#preset-auto-input');

    const cleanup = (result) => { overlay.remove(); resolve(result); };

    dialog.querySelector('#preset-dialog-cancel').onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };

    dialog.querySelector('#preset-dialog-ok').onclick = () => {
      const name = nameInput.value.trim();
      const cmd = cmdInput.value.trim();
      const autoFlag = autoInput.value.trim();
      if (!name || !cmd) { alert('名称和命令不能为空'); return; }
      const id = preset ? preset.id : `custom-${customPresetNextId++}`;
      cleanup({ id, name, command: cmd, autoFlag });
    };
  });
}

function showPresetManageDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal active';
  overlay.style.zIndex = '1001';
  const dialog = document.createElement('div');
  dialog.className = 'modal-content preset-manage-dialog';

  dialog.innerHTML = '<h3>管理自定义预设</h3>';
  const listEl = document.createElement('div');
  listEl.className = 'preset-manage-list';

  const customs = getCustomPresets();
  if (customs.length === 0) {
    listEl.innerHTML = '<div class="preset-manage-empty">暂无自定义预设，点击上方 ＋ 按钮新建</div>';
  } else {
    for (const p of customs) {
      const item = document.createElement('div');
      item.className = 'preset-manage-item';

      const info = document.createElement('div');
      info.className = 'preset-manage-item-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'preset-manage-item-name';
      nameEl.textContent = p.name;
      const cmdEl = document.createElement('div');
      cmdEl.className = 'preset-manage-item-cmd';
      cmdEl.textContent = p.command + (p.autoFlag ? ' ' + p.autoFlag : '');
      info.appendChild(nameEl);
      info.appendChild(cmdEl);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'preset-manage-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'preset-manage-btn';
      editBtn.textContent = '✎';
      editBtn.onclick = async () => {
        const edited = await showPresetDialog(p);
        if (edited) {
          const list = getCustomPresets();
          const idx = list.findIndex(x => x.id === p.id);
          if (idx !== -1) { list[idx] = edited; saveCustomPresets(list); }
          renderPresetSelect();
          overlay.remove();
          showPresetManageDialog(); // 刷新管理列表
        }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'preset-manage-btn preset-manage-btn-del';
      delBtn.textContent = '✕';
      delBtn.onclick = () => {
        if (!confirm(`确定删除预设「${p.name}」？`)) return;
        const list = getCustomPresets().filter(x => x.id !== p.id);
        saveCustomPresets(list);
        renderPresetSelect();
        overlay.remove();
        showPresetManageDialog(); // 刷新管理列表
      };

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      listEl.appendChild(item);
    }
  }

  dialog.appendChild(listEl);

  const actionsBar = document.createElement('div');
  actionsBar.className = 'modal-actions';
  actionsBar.innerHTML = '<button id="preset-manage-close" class="btn-secondary">关闭</button>';
  dialog.appendChild(actionsBar);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  dialog.querySelector('#preset-manage-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// 自定义预设按钮事件
const presetAddBtn = $('preset-add-btn');
const presetManageBtn = $('preset-manage-btn');
if (presetAddBtn) {
  presetAddBtn.addEventListener('click', async () => {
    const result = await showPresetDialog();
    if (result) {
      const list = getCustomPresets();
      list.push(result);
      saveCustomPresets(list);
      renderPresetSelect();
      const presetSelect = $('new-preset');
      if (presetSelect) presetSelect.value = result.autoFlag ? result.command + ' ' + result.autoFlag : result.command;
    }
  });
}
if (presetManageBtn) {
  presetManageBtn.addEventListener('click', () => {
    showPresetManageDialog();
  });
}

// 初始化渲染预设下拉
renderPresetSelect();

// ========== 新建会话 ==========

let lastKnownSessionCwd = '';


$('new-session-btn').onclick = async () => {
  await Promise.all([refreshRecentCwdOptions(), pullCustomPresetsFromServer()]);
  renderPresetSelect();
  const select = $('new-cwd');
  if (select) {
    const lastCwd = localStorage.getItem(MOBILE_LAST_CWD_KEY) || '';
    select.value = lastCwd;
    if (lastCwd && select.value !== lastCwd) select.value = '';
  }
  const presetSelect = $('new-preset');
  if (presetSelect) {
    const lastPreset = localStorage.getItem(MOBILE_LAST_PRESET_KEY) || '';
    presetSelect.value = lastPreset;
    if (lastPreset && presetSelect.value !== lastPreset) presetSelect.value = '';
  }
  $('new-session-modal').classList.add('active');
  loadResumableForCwd($('new-cwd').value);
};

async function loadResumableForCwd(cwd) {
  const section = $('resumable-section');
  const listEl = $('resumable-list');
  if (!cwd) { if (section) section.style.display = 'none'; return; }
  let items = [];
  try { items = await api(`/api/resumable?cwd=${encodeURIComponent(cwd)}`); } catch { items = []; }
  if (!Array.isArray(items) || !items.length) { if (section) section.style.display = 'none'; if (listEl) listEl.innerHTML=''; return; }
  if (section) section.style.display = 'block';
  listEl.innerHTML = items.map(it => `
    <button type="button" class="resumable-item" data-cmd="${escHtml(it.resumeCommand)}" data-cwd="${escHtml(it.cwd)}">
      <span class="resumable-title">${escHtml(it.title || it.id)}</span>
      <span class="resumable-agent">${escHtml(it.agent || '')}</span>
    </button>`).join('');
  listEl.querySelectorAll('.resumable-item').forEach(btn => {
    btn.onclick = () => resumeSession(btn.dataset.cwd, btn.dataset.cmd);
  });
}

$('new-cwd').addEventListener('change', () => loadResumableForCwd($('new-cwd').value));

async function resumeSession(cwd, cmd) {
  $('new-session-modal').classList.remove('active');
  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || undefined, presetCommand: cmd, themeId: 'default' }),
    });
    if (cwd) localStorage.setItem(MOBILE_LAST_CWD_KEY, cwd);
    await refreshSessions();
    openSession(session.id);
  } catch (e) {
    alert('恢复失败: ' + e.message);
  }
}

$('modal-cancel').onclick = () => {
  $('new-session-modal').classList.remove('active');
};

$('modal-create').onclick = async () => {
  const cwd = $('new-cwd').value.trim() || '';
  const preset = $('new-preset').value;
  const themeId = 'default';
  $('new-session-modal').classList.remove('active');

  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || undefined, presetCommand: preset, themeId }),
    });
    localStorage.setItem(MOBILE_LAST_CWD_KEY, cwd);
    localStorage.setItem(MOBILE_LAST_PRESET_KEY, preset);
    await refreshSessions();
    openSession(session.id);
  } catch (e) {
    alert('创建失败: ' + e.message);
  }
};

$('new-session-modal').onclick = (e) => {
  if (e.target === $('new-session-modal')) {
    $('new-session-modal').classList.remove('active');
  }
};

// ========== Web Push ==========

async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    const { key } = await api('/api/vapid-public-key');
    const vapidKey = urlBase64ToUint8Array(key);

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
    }

    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub }),
    });
  } catch (e) {
    console.warn('推送注册失败:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ========== iOS PWA 黑屏修复 ==========
// iOS standalone 模式下切换输入法/app 后 canvas 上下文被系统回收，
// term.refresh() 无法恢复，必须销毁终端重建 + 重连 WebSocket 拿 replay

let repaintDebounce = null;
let isRecreating = false;

async function forceTerminalRecreate() {
  // 只在会话详情页且有当前会话时才重建
  if (!currentSessionId || !$('detail-page').classList.contains('active')) return;
  if (isRecreating) return;
  isRecreating = true;
  console.log('[黑屏修复] 重建终端, session=', currentSessionId);
  const sid = currentSessionId;
  try {
    await createTerminal();
    connectWebSocket(sid);
  } finally {
    isRecreating = false;
  }
}

function scheduleRepaint() {
  if (repaintDebounce) return; // 防抖，避免多个事件重复触发
  repaintDebounce = setTimeout(() => {
    repaintDebounce = null;
    forceTerminalRecreate();
  }, 300);
}

// 检测终端 canvas 是否黑屏（WebGL 上下文丢失）
function isCanvasContextLost() {
  if (!term) return false;
  const container = $('terminal-container');
  if (!container) return false;
  const canvas = container.querySelector('canvas');
  if (!canvas) return false;
  // 检查 WebGL 上下文
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (gl && gl.isContextLost()) return true;
  // 兜底：检查 canvas 尺寸是否为 0（被系统回收后可能出现）
  if (canvas.width === 0 || canvas.height === 0) return true;
  return false;
}

// 页面从后台恢复可见时重建终端
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleRepaint();
  }
});

// iOS Safari/PWA 的 BFCache 恢复
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    scheduleRepaint();
  }
});

// focus 事件兜底：语音输入法跳转回来时可能不触发 visibilitychange
// 只在 canvas 上下文确实丢失时才重建，避免正常打字时频繁触发
window.addEventListener('focus', () => {
  if (!currentSessionId || !$('detail-page').classList.contains('active')) return;
  // 延迟检测，等 iOS 完成页面恢复
  setTimeout(() => {
    if (isCanvasContextLost()) {
      console.log('[黑屏修复] focus 检测到 canvas 上下文丢失');
      scheduleRepaint();
    }
  }, 200);
});

// 监听 canvas 的 WebGL context lost 事件（最精准的检测）
function bindCanvasContextLost() {
  const container = $('terminal-container');
  if (!container) return;
  const canvas = container.querySelector('canvas');
  if (!canvas || canvas.dataset.ctxBound) return;
  canvas.addEventListener('webglcontextlost', (e) => {
    console.log('[黑屏修复] webglcontextlost 事件触发');
    e.preventDefault(); // 允许上下文恢复
    // 上下文丢失后，等页面恢复可见时重建
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible);
        scheduleRepaint();
      }
    };
    // 如果当前已经可见（语音输入法场景），直接重建
    if (document.visibilityState === 'visible') {
      scheduleRepaint();
    } else {
      document.addEventListener('visibilitychange', onVisible);
    }
  });
  canvas.dataset.ctxBound = '1';
}

// ========== 初始化 ==========

// 屏蔽 Cmd+R / F5 刷新，避免丢失所有对话
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
    e.preventDefault();
    showCopyToast('已阻止刷新，对话不会丢失');
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    showCopyToast('已阻止刷新，对话不会丢失');
  }
}, { capture: true });

async function loadServerInfo() {
  try {
    const res = await fetch(`${API}/api/server-info`);
    const info = await res.json();
    lastServerInfo = info;
    const el = $('server-info');
    el.innerHTML = `
      <div><span class="label">主机: </span><span class="value">${info.hostname}</span></div>
      <div><span class="label">局域网: </span><span class="value">http://${info.ip}:${info.port}</span></div>
      <div><span class="label">版本: </span><span class="value">v${info.version || '?'} · ${(info.sha||'').slice(0,7)} · client ${CLIENT_BUILD}</span></div>
    `;
  } catch {
    $('server-info').innerHTML = '<div style="color:var(--accent)">无法连接服务器</div>';
  }
}

loadServerInfo();

if (token) {
  api('/api/sessions').then(() => enterMain()).catch(() => showPage('login-page'));
} else {
  showPage('login-page');
}

window.addEventListener('online', () => {
  if ($('main-page').classList.contains('active') && token && !sseSource) {
    startSSE();
  }
  if (currentSessionId && $('detail-page').classList.contains('active') && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connectWebSocket(currentSessionId);
  }
});

window.addEventListener('offline', () => {
  showCopyToast('网络已断开，恢复后将自动重连');
});

// ========== 初始化：自动验证 token 并进入主页 ==========

async function init() {
  const savedToken = localStorage.getItem('duocli_token');
  if (!savedToken) {
    showPage('login-page');
    return;
  }

  // 验证 token 是否有效
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: savedToken }),
    });
    const data = await res.json();
    if (data.ok) {
      token = savedToken;
      enterMain();
    } else {
      localStorage.removeItem('duocli_token');
      showPage('login-page');
    }
  } catch (e) {
    // 网络错误时仍显示登录页
    showPage('login-page');
  }
}

// ========== Chat 功能 ==========

let activeChatId = null;
let chatStreamController = null;

async function fetchChatSessions() {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions`, { headers });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/** 创建 Chat 会话（支持指定工作目录） */
async function createChatSession(workspace) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace: workspace || '' }),
    });
    if (!r.ok) throw new Error('创建失败');
    const session = await r.json();
    chatSessionsLastFetch = 0; // 失效缓存
    openChatSession(session.id);
  } catch (e) {
    alert('创建聊天失败: ' + (e.message || '网络错误'));
  }
}

async function createNewChat() {
  return createChatSession('');
}

async function openChatSession(id) {
  activeChatId = id;
  showPage('chat-detail-page');

  const msgEl = $('chat-messages');
  msgEl.innerHTML = '';

  // 加载历史消息
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${API}/api/chat/sessions/${encodeURIComponent(id)}/messages`, { headers });
    if (r.ok) {
      const data = await r.json();
      const messages = data.messages || [];
      for (const m of messages) {
        addChatBubble(m.role, m.content);
      }
      msgEl.scrollTop = msgEl.scrollHeight;
    }
  } catch {}

  $('chat-msg-input').focus();
}

function addChatBubble(role, content, isStreaming) {
  const msgEl = $('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-bubble-mobile ' + role + (isStreaming ? ' streaming' : '');

  const label = document.createElement('div');
  label.className = 'chat-label-mobile';
  if (role === 'user') {
    label.textContent = 'YOU';
  } else if (role === 'assistant') {
    label.textContent = 'AI';
  } else if (role === 'system') {
    label.textContent = 'SYS';
    label.classList.add('system');
  }
  el.appendChild(label);

  const body = document.createElement('div');
  body.className = 'chat-body-mobile';
  body.textContent = content;
  el.appendChild(body);

  msgEl.appendChild(el);
  msgEl.scrollTop = msgEl.scrollHeight;
  return el;
}

async function sendChatMessage() {
  if (!activeChatId) return;
  const inputEl = $('chat-msg-input');
  const content = inputEl.value.trim();
  if (!content) return;

  // 显示用户消息
  addChatBubble('user', content);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // 通过 SSE 发送并接收流式响应
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // 中断之前的流
  if (chatStreamController) {
    chatStreamController.abort();
    chatStreamController = null;
  }
  chatStreamController = new AbortController();

  try {
    const r = await fetch(`${API}/api/chat/sessions/${encodeURIComponent(activeChatId)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content }),
      signal: chatStreamController.signal,
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }

    // SSE 流式读取
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamBubble = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'delta') {
            if (!streamBubble) {
              streamBubble = addChatBubble('assistant', '', true);
            }
            const body = streamBubble.querySelector('.chat-body-mobile');
            body.textContent += parsed.text;
            $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
          } else if (parsed.type === 'done') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
            }
            streamBubble = null;
          } else if (parsed.type === 'error') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
              streamBubble.querySelector('.chat-body-mobile').textContent += '\n\n❌ ' + parsed.error;
            } else {
              addChatBubble('system', '❌ ' + parsed.error);
            }
            streamBubble = null;
          } else if (parsed.type === 'system') {
            if (streamBubble) {
              streamBubble.classList.remove('streaming');
              streamBubble = null;
            }
            addChatBubble('system', parsed.message);
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      addChatBubble('system', '❌ ' + (e.message || '请求失败'));
    }
  } finally {
    chatStreamController = null;
  }
}

function closeChatSession() {
  if (chatStreamController) {
    chatStreamController.abort();
    chatStreamController = null;
  }
  activeChatId = null;
  showPage('main-page');
  refreshSessions(); // 刷新以显示新建的 chat 会话
}

async function deleteChatSession() {
  if (!activeChatId) return;
  if (!confirm('确定删除此对话？')) return;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`${API}/api/chat/sessions/${encodeURIComponent(activeChatId)}`, {
      method: 'DELETE',
      headers,
    });
    chatSessionsLastFetch = 0; // 失效缓存
  } catch {}

  closeChatSession();
}

// Chat 事件绑定
function initChatEvents() {
  $('new-chat-btn').addEventListener('click', createNewChat);
  $('chat-back-btn').addEventListener('click', closeChatSession);
  $('chat-delete-btn').addEventListener('click', deleteChatSession);
  $('chat-send-btn').addEventListener('click', sendChatMessage);

  $('chat-msg-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // iOS/部分 Agent 键盘点发送时不触发 keydown Enter，而是直接插入换行符
  // 用轮询检测换行并自动发送，与终端输入区保持一致
  let chatPending = '';
  setInterval(() => {
    const input = $('chat-msg-input');
    if (!input || !activeChatId) return;
    const val = input.value;
    if (val && (val.includes('\n') || val.includes('\r'))) {
      const cleaned = val.replace(/[\r\n]/g, '').trim();
      input.value = '';
      input.style.height = 'auto';
      const textToSend = cleaned || chatPending;
      chatPending = '';
      if (textToSend) {
        input.value = textToSend;
        sendChatMessage();
      }
    } else if (val) {
      chatPending = val;
    } else {
      chatPending = '';
    }
  }, 50);

  $('chat-msg-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
}

// 在会话列表加载时合并 chat 会话
let cachedChatSessions = [];
let chatSessionsLastFetch = 0;
const origRenderSessionList = renderSessionList;
renderSessionList = function(sessions) {
  origRenderSessionList(sessions);

  // 缓存 chat 会话列表，避免每次 SSE 刷新都请求
  const now = Date.now();
  if (now - chatSessionsLastFetch > 10000) {
    chatSessionsLastFetch = now;
    fetchChatSessions().then(list => {
      cachedChatSessions = list || [];
      appendChatCards(sessions);
    });
  } else {
    appendChatCards(sessions);
  }
};

function appendChatCards(sessions) {
  if (!cachedChatSessions.length) return;
  const list = $('session-list');
  const empty = $('empty-state');

  const divider = document.createElement('div');
  divider.className = 'chat-sessions-divider';
  divider.textContent = '💬 Chat 对话';
  divider.style.cssText = 'padding:12px 14px 4px;font-size:12px;color:#888;font-weight:600;';
  list.appendChild(divider);

  for (const s of cachedChatSessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="status-dot" style="background:#a78bfa;"></div>
      <div class="session-info">
        <div class="session-title-row">
          <div class="session-title">${escHtml(s.title || 'Chat')}</div>
        </div>
        <div class="session-meta">
          <span class="session-time">${formatTime(s.createdAt)}</span>
          <span class="session-cwd">${s.messageCount || 0} 条消息</span>
        </div>
      </div>
      <div class="session-arrow">›</div>
    `;
    card.onclick = () => openChatSession(s.id);
    list.appendChild(card);
  }

  if (!sessions.length) {
    empty.style.display = 'none';
  }
}

initChatEvents();

init();
