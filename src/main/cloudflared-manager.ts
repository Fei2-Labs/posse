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

const TEMPLATE_MARKERS = [
  'YOUR_TUNNEL_NAME',
  'YOUR_TUNNEL_ID',
  '/ABSOLUTE/PATH/TO/',
  'duocli.example.com',
];

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
    const config = this.readConfig();
    const publicUrl = config.hostname ? `https://${config.hostname}` : '';
    const configReady = this.isConfigReady(config.raw);
    const message = this.getStatusMessage(installed, configReady, config);
    return {
      installed,
      running,
      url: publicUrl,
      configPath: this.configPath,
      message,
    };
  }

  start(): CloudflaredStatus {
    const bin = this.resolveBinary();
    if (!bin) return this.getStatus();
    const config = this.readConfig();
    const publicUrl = config.hostname ? `https://${config.hostname}` : '';
    if (!config.exists) {
      return {
        installed: true,
        running: false,
        url: publicUrl,
        configPath: this.configPath,
        message: `找不到 cloudflared 配置: ${this.configPath}`,
      };
    }
    if (!this.isConfigReady(config.raw)) {
      return {
        installed: true,
        running: false,
        url: publicUrl,
        configPath: this.configPath,
        message: `Cloudflare 配置未完成，请填写本机私有配置: ${this.configPath}`,
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
      url: publicUrl,
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
    const candidates = [
      path.join(projectRoot, 'frp', 'cloudflared-config.local.yml'),
      path.join(projectRoot, 'frp', 'cloudflared-config.private.yml'),
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.local.yml') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.private.yml') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'frp', 'cloudflared-config.yml') : '',
      path.join(projectRoot, 'frp', 'cloudflared-config.yml'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    return path.join(projectRoot, 'frp', 'cloudflared-config.local.yml');
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
      execFileSync('/usr/bin/pgrep', ['-f', 'cloudflared.*cloudflared-config'], { stdio: 'ignore' });
      return true;
    } catch { /* not running */ }
    return false;
  }

  private readConfig(): { exists: boolean; raw: string; hostname: string | null } {
    if (!fs.existsSync(this.configPath)) {
      return { exists: false, raw: '', hostname: null };
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const hostnameMatch = raw.match(/^\s*-\s*hostname:\s*([^\s#]+)\s*$/m);
    return {
      exists: true,
      raw,
      hostname: hostnameMatch ? hostnameMatch[1].trim() : null,
    };
  }

  private isConfigReady(raw: string): boolean {
    if (!raw.trim()) return false;
    return !TEMPLATE_MARKERS.some(marker => raw.includes(marker));
  }

  private getStatusMessage(
    installed: boolean,
    configReady: boolean,
    config: { exists: boolean; hostname: string | null },
  ): string | undefined {
    if (!installed) return 'cloudflared 未安装，请先运行: brew install cloudflared';
    if (!config.exists) return `找不到 cloudflared 配置: ${this.configPath}`;
    if (!configReady) return `Cloudflare 配置未完成，请填写本机私有配置: ${this.configPath}`;
    if (!config.hostname) return `Cloudflare 配置缺少 hostname: ${this.configPath}`;
    return undefined;
  }
}
