import { ChildProcess, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';

const WINDSURF_PROXY_HOST = '127.0.0.1';
const WINDSURF_PROXY_PORT = 42100;
const PROXY_READY_TIMEOUT_MS = 30000;
const HEALTH_RETRY_INTERVAL_MS = 800;

/** 杀掉占用指定端口的进程 */
function killPortOccupants(port: number): number[] {
  try {
    const out = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const pids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`[WindsurfProxy] Killed port ${port} occupant PID ${pid}`);
      } catch {
        console.warn(`[WindsurfProxy] Failed to kill PID ${pid} (may already be gone)`);
      }
    }
    return pids;
  } catch {
    // lsof 没找到占用者，正常返回
    return [];
  }
}

function resolveProxyDir(): string | null {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'myDev', 'windsurf反代'),
    path.join(os.homedir(), 'windsurf反代'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'server', 'package.json'))) {
      return path.join(dir, 'server');
    }
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  return null;
}

function isRunning(): boolean {
  try {
    const req = http.request({
      hostname: WINDSURF_PROXY_HOST,
      port: WINDSURF_PROXY_PORT,
      path: '/health',
      method: 'GET',
      timeout: 2000,
    }, (res) => {
      res.resume();
    });
    req.on('error', () => {});
    req.end();
    // 不阻塞等结果，仅做探测
    return true;
  } catch { return false; }
}

export class WindsurfProxyManager {
  private child: ChildProcess | null = null;
  private proxyDir: string | null = null;
  private onStatusChange?: (running: boolean, error?: string) => void;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  // 重启退避：连续失败时延迟逐步加长，避免 EADDRINUSE / 启动脚本报错时的重启风暴
  private restartAttempts = 0;
  private static readonly MAX_RESTART_ATTEMPTS = 6;

  constructor(onStatusChange?: (running: boolean, error?: string) => void) {
    this.proxyDir = resolveProxyDir();
    this.onStatusChange = onStatusChange;
  }

  getProxyDir(): string | null {
    return this.proxyDir;
  }

  isAvailable(): boolean {
    return this.proxyDir !== null;
  }

  /** 健康检查（Promise 版本） */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: '/health',
        method: 'GET',
        timeout: 3000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ok: parsed.ok === true });
          } catch {
            resolve({ ok: false, error: 'Invalid response' });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
      req.end();
    });
  }

  /** 启动代理进程（如果尚未运行） */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.started && this.child && !this.child.killed) {
      // 已启动，检查是否存活
      const health = await this.healthCheck();
      if (health.ok) return health;
      // 进程在但没响应，杀掉重来
      this.killChild();
    }

    if (!this.proxyDir) {
      const err = 'Windsurf 反代目录未找到';
      this.onStatusChange?.(false, err);
      return { ok: false, error: err };
    }

    // 先检查是否已有进程在运行
    const preCheck = await this.healthCheck();
    if (preCheck.ok) {
      this.started = true;
      this.onStatusChange?.(true);
      return { ok: true };
    }

    // health check 失败 → 端口可能被不健康的旧进程占用，杀掉再启动
    const killed = killPortOccupants(WINDSURF_PROXY_PORT);
    if (killed.length > 0) {
      console.log(`[WindsurfProxy] Cleared ${killed.length} stale process(es) on port ${WINDSURF_PROXY_PORT}`);
      // 等端口释放（杀进程后 OS 需要一点时间回收）
      await new Promise(r => setTimeout(r, 2000));
    }

    return this.startProcess();
  }

  private startProcess(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const cwd = this.proxyDir!;
      const distPath = path.join(cwd, 'dist', 'index.js');

      if (!fs.existsSync(distPath)) {
        const err = 'Windsurf 反代未构建，请在反代目录运行: npm run build';
        this.onStatusChange?.(false, err);
        resolve({ ok: false, error: err });
        return;
      }

      console.log('[WindsurfProxy] Starting:', distPath);

      // 尝试用 pnpm start 或直接 node
      const useNpm = fs.existsSync(path.join(cwd, 'node_modules', '.pnpm'));
      let child: ChildProcess;

      if (useNpm) {
        const pm = fs.existsSync(path.join(cwd, '..', 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
        child = spawn(pm, ['run', 'start'], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_ENV: 'production' },
        });
      } else {
        child = spawn(process.execPath, [distPath, 'serve'], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_ENV: 'production' },
        });
      }

      this.child = child;
      this.started = true;

      child.stdout?.on('data', (data) => {
        console.log(`[WindsurfProxy] ${data.toString().trim()}`);
      });
      child.stderr?.on('data', (data) => {
        console.error(`[WindsurfProxy] ${data.toString().trim()}`);
      });

      child.on('exit', (code) => {
        console.log(`[WindsurfProxy] Exited with code ${code}`);
        const wasRunning = this.child !== null;
        this.child = null;
        if (wasRunning && this.started) {
          this.onStatusChange?.(false, `进程退出 (code ${code})`);
          // 延迟重启
          this.scheduleRestart();
        }
      });

      child.on('error', (err) => {
        console.error(`[WindsurfProxy] Error:`, err.message);
        this.child = null;
        this.onStatusChange?.(false, err.message);
        this.scheduleRestart();
      });

      // 等待代理就绪
      this.waitForReady().then((result) => {
        if (result) {
          this.onStatusChange?.(true);
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: '代理启动超时' });
        }
      });
    });
  }

  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const health = await this.healthCheck();
      if (health.ok) {
        console.log('[WindsurfProxy] Ready');
        this.resetRestartBackoff();
        return true;
      }
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_INTERVAL_MS));
    }
    return false;
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    if (this.restartAttempts >= WindsurfProxyManager.MAX_RESTART_ATTEMPTS) {
      console.warn('[WindsurfProxy] Restart attempts exhausted, giving up');
      this.onStatusChange?.(false, '反代重启次数耗尽，请检查日志');
      return;
    }
    // 5s, 15s, 60s, 120s, 300s, 600s
    const backoff = [5_000, 15_000, 60_000, 120_000, 300_000, 600_000];
    const delay = backoff[Math.min(this.restartAttempts, backoff.length - 1)];
    this.restartAttempts++;
    console.log(`[WindsurfProxy] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${WindsurfProxyManager.MAX_RESTART_ATTEMPTS})...`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // 重启前清理端口占用，防止 EADDRINUSE 循环
      killPortOccupants(WINDSURF_PROXY_PORT);
      this.start().catch(() => {});
    }, delay);
  }

  /** 启动成功后调用，让退避计数归零 */
  private resetRestartBackoff(): void {
    this.restartAttempts = 0;
  }

  private killChild(): void {
    if (this.child && !this.child.killed) {
      try {
        if (this.child.pid) process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    this.child = null;
  }

  /** 应用退出时清理 */
  destroy(): void {
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killChild();
  }
}
