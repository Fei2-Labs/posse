import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CloudflaredStatus {
  installed: boolean;
  running: boolean;
  url: string;
  configPath: string;
  message?: string;
}

const PUBLIC_URL = 'https://duocli.guixian.fun';

export class CloudflaredManager {
  private child: ChildProcess | null = null;
  private readonly configPath: string;
  private readonly logPath: string;

  constructor(projectRoot: string) {
    this.configPath = this.resolveConfigPath(projectRoot);
    this.logPath = path.join(path.dirname(this.configPath), 'cloudflared.log');
  }

  getStatus(): CloudflaredStatus {
    const installed = Boolean(this.resolveBinary());
    const running = this.isRunning();
    return {
      installed,
      running,
      url: PUBLIC_URL,
      configPath: this.configPath,
      message: installed ? undefined : 'cloudflared 未安装，请先运行: brew install cloudflared',
    };
  }

  start(): CloudflaredStatus {
    const bin = this.resolveBinary();
    if (!bin) return this.getStatus();
    if (!fs.existsSync(this.configPath)) {
      return {
        installed: true,
        running: false,
        url: PUBLIC_URL,
        configPath: this.configPath,
        message: `找不到 cloudflared 配置: ${this.configPath}`,
      };
    }
    if (this.isRunning()) return this.getStatus();

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const out = fs.openSync(this.logPath, 'a');
    const child = spawn(bin, ['tunnel', '--config', this.configPath, 'run'], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    this.child = child;
    child.unref();
    child.on('exit', () => {
      this.child = null;
    });
    return {
      installed: true,
      running: true,
      url: PUBLIC_URL,
      configPath: this.configPath,
    };
  }

  stopOwnedProcess(): void {
    if (!this.child || this.child.killed) return;
    try {
      if (this.child.pid) process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = null;
  }

  private resolveConfigPath(projectRoot: string): string {
    const resourcePath = process.resourcesPath
      ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.yml')
      : '';
    if (resourcePath && fs.existsSync(resourcePath)) return resourcePath;

    const devPath = path.join(projectRoot, 'frp', 'cloudflared-config.yml');
    return devPath;
  }

  private resolveBinary(): string | null {
    const candidates = [
      process.env.DUOCLI_CLOUDFLARED_BIN || '',
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      'cloudflared',
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      try {
        execFileSync('/usr/bin/which', [candidate], { stdio: 'ignore' });
        return candidate;
      } catch { /* try next */ }
    }
    return null;
  }

  private isRunning(): boolean {
    if (this.child && !this.child.killed) return true;
    try {
      execFileSync('/usr/bin/pgrep', ['-f', 'cloudflared.*cloudflared-config.yml'], { stdio: 'ignore' });
      return true;
    } catch { /* not running */ }
    return false;
  }
}
