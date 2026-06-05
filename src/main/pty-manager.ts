import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { requestTitleFromConfiguredAI, TitleAIConfig } from './title-ai';

export interface PtySession {
  id: string;
  ptyProcess: pty.IPty;
  buffer: string;
  rawBuffer: string;          // 完整 ANSI 输出，用于远程终端回放
  userInputs: string[];
  commandCount: number;
  title: string;
  titleLocked: boolean;
  titleGenerated: boolean;
  summarizeScheduled: boolean;
  summarizeTimer: NodeJS.Timeout | null;
  cwd: string;
  presetCommand: string;
  themeId: string;
  provider: string | null;    // 实际使用的模型提供商 (如 MiniMax, GLM 等)
  createdAt: number;          // 创建时间戳
  resumeId: string | null;    // 捕获的 resume session ID (UUID)
  resumeCommand: string | null; // 完整 resume 命令 (如 "claude --resume xxx")
  autoRetryCooldown: number;    // 自动重试冷却截止时间戳
  prevData: string;              // 上一个 PTY 分片，与当前分片合并检测 rate limit
  retryTimer: NodeJS.Timeout | null;  // 自动重试 / 切号延迟定时器
  disposables: pty.IDisposable[];
}

interface PtyManagerEvents {
  onData: (id: string, data: string) => void;
  onTitleUpdate: (id: string, title: string) => void;
  onExit: (id: string) => void;
  onPasteInput?: (id: string, cwd: string) => void;
  onRawData?: (id: string, data: string) => void;
}

export type TitleAIConfigProvider = () => TitleAIConfig | null;

// 命令 → 友好显示名称映射
const PRESET_DISPLAY_NAMES: Record<string, string> = {
  'claude --dangerously-skip-permissions': 'Claude全自动',
  'codex --full-auto': 'Codex全自动',
  'codex -c sandbox_mode="danger-full-access" -c approval="never" -c network="enabled"': 'Codex全自动',
  'devin --permission-mode bypass': 'Devin全自动',
  'opencode': 'OpenCode',
  'kiro-cli chat --trust-all-tools': 'Kiro全自动',
};

function stripTerminalControlSequences(text: string): string {
  return text
    // OSC: ESC ] ... BEL / ESC \
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ ... final-byte
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // DCS/PM/APC/SOS: ESC P/^/_/X ... ESC \
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Single-character ESC sequences.
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Devin 设备指纹旋转（防止跨账号限流关联）
const DEVIN_INSTALLATION_ID_PATHS = [
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli', 'installation_id'),
  path.join(os.homedir(), '.local', 'share', 'devin', 'cli-next', 'installation_id'),
];

export function rotateDevinInstallationId(): void {
  const newId = crypto.randomUUID().toUpperCase();
  for (const p of DEVIN_INSTALLATION_ID_PATHS) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, newId);
        console.log(`[PTY] Rotated installation_id: ${p} → ${newId}`);
      } else {
        const dir = path.dirname(p);
        if (fs.existsSync(dir)) {
          fs.writeFileSync(p, newId);
          console.log(`[PTY] Created installation_id: ${p} → ${newId}`);
        }
      }
    } catch (e) {
      console.warn(`[PTY] Failed to rotate installation_id ${p}:`, (e as Error).message);
    }
  }
}

// 解析 session-sync 的绝对路径（避免 Dock 启动时 PATH 缺失导致 ENOENT）
const sessionSyncPath = (() => {
  try {
    const syncSymlink = path.join(os.homedir(), '.local', 'bin', 'session-sync');
    if (fs.existsSync(syncSymlink)) return fs.realpathSync(syncSymlink);
  } catch { /* ignore */ }
  return 'session-sync'; // fallback to PATH lookup
})();

export function getDisplayName(presetCommand: string): string {
  return PRESET_DISPLAY_NAMES[presetCommand] || presetCommand || '终端';
}

export class PtyManager {
  private sessions: Map<string, PtySession> = new Map();
  private nextId = 1;
  private events: PtyManagerEvents;
  private getTitleAIConfig?: TitleAIConfigProvider;

  constructor(events: PtyManagerEvents, getTitleAIConfig?: TitleAIConfigProvider) {
    this.events = events;
    this.getTitleAIConfig = getTitleAIConfig;
  }

  create(cwd: string, presetCommand: string, themeId: string, envOverrides?: Record<string, string>): PtySession {
    const id = `term-${this.nextId++}`;
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/zsh');

    // 先复制 process.env，过滤掉 undefined 值，然后应用覆盖（空字符串用于清除）
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        if (value === '') {
          // 空字符串表示清除该变量
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      // 调试日志
      console.log('[PtyManager] 设置的环境变量:', JSON.stringify(envOverrides));
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env,
    });

    const session: PtySession = {
      id,
      ptyProcess,
      buffer: '',
      rawBuffer: '',
      userInputs: [],
      commandCount: 0,
      title: '新会话',
      titleLocked: false,
      titleGenerated: false,
      summarizeScheduled: false,
      summarizeTimer: null,
      cwd,
      presetCommand,
      themeId,
      provider: null,
      createdAt: Date.now(),
      resumeId: null,
      resumeCommand: null,
      autoRetryCooldown: 0,
      prevData: '',
      retryTimer: null,
      disposables: [],
    };

    session.disposables.push(ptyProcess.onData((data: string) => {
      session.buffer += data;
      // 限制buffer大小，避免内存膨胀
      if (session.buffer.length > 5000) {
        session.buffer = session.buffer.slice(-2500);
      }
      // rawBuffer 用于远程终端回放（弱网下 replay 体积直接决定首屏速度，
      // 上限 128KB：足够覆盖几屏可视内容 + 适量回滚，再多也很难真的滚到）
      session.rawBuffer += data;
      if (session.rawBuffer.length > 131072) {
        // 直接 slice 可能把 ANSI 转义序列切成两半（半截 ESC），
        // replay 时 xterm 收到残缺序列会把后续可见字符当成参数吃掉 → spinner 撕裂多行。
        // 把切点往后推到下一个 ESC 字节，保证从一个完整序列开头处恢复。
        let cut = session.rawBuffer.length - 131072;
        const nextEsc = session.rawBuffer.indexOf('\x1b', cut);
        if (nextEsc !== -1 && nextEsc - cut < 4096) cut = nextEsc;
        session.rawBuffer = session.rawBuffer.slice(cut);
      }

      // 拦截 OSC 0/1/2 窗口/图标标题序列：ESC ] 0;<title> BEL  或 ESC ] 0;<title> ESC \
      // 仅在用户未配置 AI 时使用 — 配了 AI 就让 AI 起标题，OSC 仅作兜底
      const titleCfg = this.getTitleAIConfig?.();
      const aiConfigured = !!(titleCfg?.baseUrl && titleCfg.apiKey && titleCfg.model);
      if (!aiConfigured) {
        const oscMatch = data.match(/\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/);
        if (oscMatch && oscMatch[1]) {
          const oscTitle = oscMatch[1].trim();
          if (oscTitle && oscTitle.length >= 2 && oscTitle.length <= 80
              && !session.titleLocked && !session.titleGenerated) {
            session.title = oscTitle.length > 40 ? oscTitle.slice(0, 40) + '…' : oscTitle;
            session.titleGenerated = true;
            this.events.onTitleUpdate(id, session.title);
          }
        }
      }

      // 累积阈值首次触发：不依赖回车检测（TUI 下回车经常不是裸 \r）
      // 800 字节通常等价于一屏内容，足够 AI 判断用户意图
      if (!session.titleGenerated && !session.titleLocked && session.buffer.length >= 800) {
        if (!session.summarizeScheduled) {
          session.summarizeScheduled = true;
          // 800ms 去抖：等输出稍微稳定，避免抓到半行
          session.summarizeTimer = setTimeout(() => {
            session.summarizeTimer = null;
            void this.triggerSummarize(id);
          }, 800);
        }
      }

      // 实时捕获 resume session ID（Claude Code 退出时输出 "claude --resume <uuid>"）
      if (!session.resumeId && data.toLowerCase().includes('resume')) {
        const stripped = stripTerminalControlSequences(data);
        const resumeMatch = stripped.match(/(\S+)\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (resumeMatch) {
          session.resumeId = resumeMatch[2];
          session.resumeCommand = `${resumeMatch[1]} --resume ${resumeMatch[2]}`;
        }
      }

      // Devin 终端专属：自动重试与切号
      // 仅对 devin presetCommand 生效，其他终端不触发
      if (session.presetCommand.startsWith('devin')) {
        const combinedLower = (session.prevData + data).toLowerCase();
        session.prevData = data;

        // 统一用 ⚠ / 错误关键字检测 Devin 报错
        const hasWarningSign = combinedLower.includes('⚠')
          || combinedLower.includes('something went wrong')
          || combinedLower.includes('permission denied');

        // 1) 硬限流（需切号）→ 后台切号 + 旋转设备指纹，完成后自动发"继续"（不中断当前会话）
        //    "quota exhausted" / "usage is exhausted" — 日/周额度用完
        //    "overall message rate limit" / "permission denied" — 账号级硬限制
        if (hasWarningSign && (
          combinedLower.includes('quota exhausted') ||
          combinedLower.includes('usage is exhausted') ||
          combinedLower.includes('overall message rate limit') ||
          (combinedLower.includes('permission denied') && combinedLower.includes('rate limit'))
        )) {
          session.prevData = '';
          if (Date.now() > session.autoRetryCooldown) {
            session.autoRetryCooldown = Date.now() + 30000;
            console.log(`[PTY] 检测到 ⚠ 硬限流（需切号），后台切号 + 旋转设备指纹 (session: ${id})`);
            // 旋转 Devin 设备指纹，防止跨账号限流关联
            rotateDevinInstallationId();
            // 使用绝对路径避免 Dock 启动时 PATH 不包含 ~/.local/bin
            // stdio: 'ignore' + unref() 防止 pipe 缓冲区阻塞和进程泄漏
            const sw = spawn(sessionSyncPath, ['switch'], { stdio: 'ignore', detached: true });
            sw.unref();
            sw.on('close', (code) => {
              if (!this.sessions.has(id)) return;
              if (code === 0) {
                console.log(`[PTY] 后台切号成功，3 秒后发送"继续" (session: ${id})`);
                session.retryTimer = setTimeout(() => {
                  session.retryTimer = null;
                  if (!this.sessions.has(id)) return;
                  ptyProcess.write('继续\r');
                  session.autoRetryCooldown = 0;
                }, 3000);
              } else {
                const errMsg = `\n⚠️ [DuoCLI] 自动切号失败 (exit code: ${code})，请手动切换账号\n`;
                ptyProcess.write(errMsg);
                console.error(`[PTY] 后台切号失败 (exit code: ${code})`);
                // 失败时保持 30s 冷却，防止死循环
                session.autoRetryCooldown = Date.now() + 30000;
              }
            });
            sw.on('error', (err) => {
              if (!this.sessions.has(id)) return;
              const errMsg = `\n⚠️ [DuoCLI] 自动切号异常: ${err.message}，请手动切换账号\n`;
              ptyProcess.write(errMsg);
              console.error(`[PTY] 后台切号异常:`, err.message);
              session.autoRetryCooldown = Date.now() + 30000;
            });
          }
        }
        // 2) Rate limit → 8 秒后自动发"继续"，发完后清除冷却期以便下次报错能立即触发
        else if (hasWarningSign && combinedLower.includes('rate limit')) {
          session.prevData = '';
          if (Date.now() > session.autoRetryCooldown) {
            console.log(`[PTY] 检测到 ⚠ Rate limit，8 秒后自动发送"继续" (session: ${id})`);
            session.autoRetryCooldown = Date.now() + 10000;  // 冷却期仅防止 8s 等待期间重复排队
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (!this.sessions.has(id)) return;
              ptyProcess.write('继续\r');
              session.autoRetryCooldown = 0;  // 发完后立即解除冷却，允许下次报错立刻触发
            }, 8000);
          }
        }
      } else {
        session.prevData = data;
      }

      this.events.onData(id, data);
      this.events.onRawData?.(id, data);
    }));

    session.disposables.push(ptyProcess.onExit(() => {
      this.events.onExit(id);
      this.sessions.delete(id);
    }));

    this.sessions.set(id, session);

    // 如果有预设命令，延迟发送
    if (presetCommand) {
      setTimeout(() => {
        ptyProcess.write(presetCommand + '\r');
      }, 300);
    }

    return session;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    // 检测粘贴输入（语音输入法通过粘贴方式输入，一次性写入多个字符）
    if (data.length > 5 && data !== '\r') {
      const cleaned = data.replace(/[\r\n]/g, ' ').trim();
      if (cleaned.length > 0) {
        session.userInputs.push(cleaned);
        // 只保留最近20条
        if (session.userInputs.length > 20) {
          session.userInputs = session.userInputs.slice(-20);
        }
        this.events.onPasteInput?.(id, session.cwd);
      }
    }

    // 检测回车键，计数命令；TUI 下 \r 可能不出现，纯属补充信号
    if (data === '\r') {
      session.commandCount++;
      // 前3轮命令自动生成标题（与 buffer 阈值触发互为兜底）
      if (!session.titleGenerated && !session.titleLocked
          && !session.summarizeScheduled && session.commandCount <= 3) {
        session.summarizeScheduled = true;
        session.summarizeTimer = setTimeout(() => {
          session.summarizeTimer = null;
          void this.triggerSummarize(id);
        }, 800);
      }
      this.events.onPasteInput?.(id, session.cwd);
    }

    session.ptyProcess.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // 过滤无效尺寸，node-pty resize(0,0) 会抛异常
    if (cols > 0 && rows > 0) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.summarizeTimer) {
      clearTimeout(session.summarizeTimer);
      session.summarizeTimer = null;
    }
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
    }
    session.disposables.forEach(d => d.dispose());
    session.disposables = [];
    session.ptyProcess.kill();
    this.sessions.delete(id);
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.title = title;
    session.titleLocked = true;
    this.events.onTitleUpdate(id, title);
  }

  /**
   * 强制重新用 AI 生成标题。用户右键"重新生成标题"调用。
   * 会清掉 lock/generated 标记，再走一次 AI；失败则保持原标题。
   */
  async regenerateTitle(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.titleLocked = false;
    session.titleGenerated = false;
    session.summarizeScheduled = false;
    await this.triggerSummarize(id);
  }

  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 从 buffer 中提取 resume ID（关闭前的兜底，处理 resume 输出跨 chunk 的情况）
   */
  captureResumeFromBuffer(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.resumeId) return;
    const stripped = stripTerminalControlSequences(session.buffer);
    const match = stripped.match(/(\S+)\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) {
      session.resumeId = match[2];
      session.resumeCommand = `${match[1]} --resume ${match[2]}`;
    }
  }

  getCwd(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return os.homedir();
    try {
      const pid = session.ptyProcess.pid;
      let dir = '';
      if (process.platform === 'win32') {
        // Windows 无法可靠获取子进程 cwd，直接 fallback
      } else if (process.platform === 'linux') {
        try {
          dir = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch { /* ignore */ }
      } else {
        // macOS
        const result = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
          encoding: 'utf-8',
          timeout: 2000,
        });
        dir = result.trim().replace(/^n/, '');
      }
      if (dir) return dir;
    } catch {
      // 忽略错误
    }
    return session.cwd;
  }

  private async triggerSummarize(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.titleLocked || session.titleGenerated) return;

    const cleanBuffer = stripTerminalControlSequences(session.buffer).trim();
    const lastUserInput = session.userInputs.length > 0
      ? session.userInputs[session.userInputs.length - 1]
      : '';

    // 素材太少则不浪费 API 调用，等下一轮触发
    if (cleanBuffer.length < 20 && lastUserInput.length < 4) {
      session.summarizeScheduled = false;
      return;
    }

    const config = this.getTitleAIConfig?.();
    if (config?.baseUrl && config.apiKey && config.model) {
      try {
        const prompt = [
          '请根据以下终端会话内容，推断用户正在做什么任务，生成一个简短中文标题。',
          '要求：8-15 个字，直接输出标题，不要加引号、前缀或解释。',
          '',
          `工作目录：${session.cwd}`,
          `启动命令：${getDisplayName(session.presetCommand)}`,
          lastUserInput ? `用户最近输入：${lastUserInput.slice(0, 240)}` : '',
          `终端输出（已剥离控制符）：\n${cleanBuffer.slice(-1500)}`,
        ].filter(Boolean).join('\n');
        const title = await requestTitleFromConfiguredAI(config, prompt);
        const latest = this.sessions.get(id);
        if (latest && !latest.titleLocked && title) {
          latest.title = title.slice(0, 50);
          latest.titleGenerated = true;
          latest.summarizeScheduled = false;
          this.events.onTitleUpdate(id, latest.title);
          return;
        }
      } catch (err) {
        console.error('[PtyManager] AI 标题生成失败，走兜底:', err instanceof Error ? err.message : err);
        // 失败兜底走下面的 buffer 首行
      }
    }

    // 兜底：用 buffer 首行可读文本
    const latest = this.sessions.get(id);
    if (!latest || latest.titleLocked || latest.titleGenerated) return;
    latest.summarizeScheduled = false;
    const fallback = lastUserInput || cleanBuffer.split('\n').map(s => s.trim()).find(s => s.length >= 3) || '';
    if (!fallback) return;
    latest.title = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback;
    latest.titleGenerated = true;
    this.events.onTitleUpdate(id, latest.title);
  }
}
