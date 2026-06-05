import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { cleanGeneratedTitle, requestTitleFromConfiguredAI, TitleAIConfig } from './title-ai';

const WINDSURF_PROXY_HOST = '127.0.0.1';
const WINDSURF_PROXY_PORT = 42100;

export interface ChatSession {
  id: string;
  title: string;
  titleLocked: boolean;
  titleUpdateCount: number;
  titleGenerationInFlight: boolean;
  model: string;
  workspace: string;
  createdAt: number;
  messages: ChatMessage[];
  proxySessionId: string | null; // Windsurf proxy's session ID
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatSessionEvents {
  onDelta: (sessionId: string, text: string) => void;
  onDone: (sessionId: string, content: string) => void;
  onError: (sessionId: string, error: string) => void;
  onTitleUpdate: (sessionId: string, title: string) => void;
}

export type TitleAIConfigProvider = () => TitleAIConfig | null;

export class ChatSessionManager extends EventEmitter {
  private sessions: Map<string, ChatSession> = new Map();
  private nextId = 1;
  private events: ChatSessionEvents;
  private activeStreams: Map<string, http.ClientRequest> = new Map();
  private getTitleAIConfig?: TitleAIConfigProvider;

  constructor(events: ChatSessionEvents, getTitleAIConfig?: TitleAIConfigProvider) {
    super();
    this.events = events;
    this.getTitleAIConfig = getTitleAIConfig;
    // 桥接：emit 事件时同步调用回调
    this.on('onDelta', (sessionId: string, text: string) => events.onDelta(sessionId, text));
    this.on('onDone', (sessionId: string, content: string) => events.onDone(sessionId, content));
    this.on('onError', (sessionId: string, error: string) => events.onError(sessionId, error));
    this.on('onTitleUpdate', (sessionId: string, title: string) => events.onTitleUpdate(sessionId, title));
  }

  /** 检查 Windsurf 代理是否可用 */
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

  /** 获取可用模型列表 */
  async listModels(): Promise<Array<{ id: string; credits: string }>> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: '/v1/models',
        method: 'GET',
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve((parsed.data || []).map((m: any) => ({ id: m.id, credits: m.credits || '?' })));
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  /** 创建 Chat 会话 */
  create(workspace: string, model?: string): ChatSession {
    const id = `chat-${this.nextId++}`;
    const session: ChatSession = {
      id,
      title: '新对话',
      titleLocked: false,
      titleUpdateCount: 0,
      titleGenerationInFlight: false,
      model: model || 'windsurf-default',
      workspace: workspace || os.homedir(),
      createdAt: Date.now(),
      messages: [],
      proxySessionId: null,
    };
    this.sessions.set(id, session);

    // 异步在 Windsurf 代理中创建会话
    this.createProxySession(session).catch(() => {});

    return session;
  }

  private async createProxySession(session: ChatSession): Promise<void> {
    const payload = JSON.stringify({
      model: session.model,
      title: session.title,
      workspace: session.workspace,
    });

    return new Promise((resolve) => {
      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: '/api/chat/sessions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.id) {
              session.proxySessionId = parsed.id;
            }
          } catch {}
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(payload);
      req.end();
    });
  }

  /** 发送消息到 Chat 会话 */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    // 检查自定义命令
    if (content.startsWith('/')) {
      await this.handleCustomCommand(session, content);
      return;
    }

    // 添加用户消息
    session.messages.push({ role: 'user', content, timestamp: Date.now() });

    // 如果还没有代理会话，先创建
    if (!session.proxySessionId) {
      await this.createProxySession(session);
    }

    // 发送到 Windsurf 代理
    await this.sendToProxy(session, content);
  }

  private sendToProxy(session: ChatSession, content: string): Promise<void> {
    // Prefer the stateful chat-engine path: /api/chat/sessions/{id}/send
    // This reuses cascade_id for multi-turn, avoids <anthropic> tag issues,
    // and doesn't require packing history into each request.
    if (session.proxySessionId) {
      return this.sendViaChatEngine(session, content);
    }

    // Fallback: stateless /v1/chat/completions (only if proxy session not created yet)
    return this.sendViaCompletions(session, content);
  }

  /** Send via chat-engine SSE endpoint — preferred path */
  private sendViaChatEngine(session: ChatSession, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ content });

      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: `/api/chat/sessions/${session.proxySessionId}/send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 120000,
      }, (res) => {
        if ((res.statusCode || 500) >= 400) {
          let errData = '';
          res.on('data', (chunk) => { errData += chunk; });
          res.on('end', () => {
            this.activeStreams.delete(session.id);
            // If chat-engine fails, fall back to completions
            if (!session.proxySessionId) {
              this.sendViaCompletions(session, content).then(resolve).catch(reject);
              return;
            }
            this.emit('onError', session.id, errData || `HTTP ${res.statusCode}`);
            reject(new Error(errData));
          });
          return;
        }

        let buffer = '';
        let fullText = '';
        let doneEmitted = false;
        const finalize = (text: string) => {
          if (doneEmitted) return;
          doneEmitted = true;
          if (!session.messages.some(m => m.role === 'assistant' && m.content === text)) {
            session.messages.push({ role: 'assistant', content: text, timestamp: Date.now() });
          }
          this.emit('onDone', session.id, text);
          this.maybeGenerateTitle(session);
        };

        res.on('data', (chunk: Buffer) => {
          // 跨 chunk 缓冲：单个 SSE event 可能被切到两次 data 里，
          // 直接 split 会让后半截 JSON 进 try/catch 被吞 → token 丢字
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'delta' && evt.text) {
                fullText += evt.text;
                this.emit('onDelta', session.id, evt.text);
              } else if (evt.type === 'done') {
                finalize(fullText || evt.content || '');
              } else if (evt.type === 'error') {
                this.emit('onError', session.id, evt.message || 'Unknown error');
              }
            } catch {}
          }
        });

        res.on('end', () => {
          this.activeStreams.delete(session.id);
          // 如果上游没发 done，用累积文本兜底
          finalize(fullText);
          resolve();
        });
      });

      req.on('error', (err) => {
        this.activeStreams.delete(session.id);
        this.emit('onError', session.id, err.message);
        reject(err);
      });

      req.on('timeout', () => {
        this.activeStreams.delete(session.id);
        req.destroy();
        this.emit('onError', session.id, '请求超时');
        reject(new Error('Timeout'));
      });

      this.activeStreams.set(session.id, req);
      req.write(payload);
      req.end();
    });
  }

  /** Fallback: stateless /v1/chat/completions path */
  private sendViaCompletions(session: ChatSession, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: session.model,
        messages: [
          ...session.messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
        ],
        stream: true,
      });

      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 120000,
      }, (res) => {
        if ((res.statusCode || 500) >= 400) {
          let errData = '';
          res.on('data', (chunk) => { errData += chunk; });
          res.on('end', () => {
            this.emit('onError', session.id, errData || `HTTP ${res.statusCode}`);
            reject(new Error(errData));
          });
          return;
        }

        let buffer = '';
        let fullText = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullText += delta;
                this.emit('onDelta', session.id, delta);
              }
            } catch {}
          }
        });

        res.on('end', () => {
          this.activeStreams.delete(session.id);
          session.messages.push({ role: 'assistant', content: fullText, timestamp: Date.now() });
          this.emit('onDone', session.id, fullText);

          this.maybeGenerateTitle(session);

          resolve();
        });
      });

      req.on('error', (err) => {
        this.activeStreams.delete(session.id);
        this.emit('onError', session.id, err.message);
        reject(err);
      });

      req.on('timeout', () => {
        this.activeStreams.delete(session.id);
        req.destroy();
        this.emit('onError', session.id, '请求超时');
        reject(new Error('Timeout'));
      });

      this.activeStreams.set(session.id, req);
      req.write(payload);
      req.end();
    });
  }

  /** 停止活跃的流 */
  abortStream(sessionId: string): void {
    const req = this.activeStreams.get(sessionId);
    if (req) {
      req.destroy();
      this.activeStreams.delete(sessionId);
    }
  }

  // ========== 自定义命令 ==========

  private async handleCustomCommand(session: ChatSession, command: string): Promise<void> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/auto-login':
        await this.cmdAutoLogin(session);
        break;
      case '/switch':
        await this.cmdSwitchAccount(session);
        break;
      case '/models':
        await this.cmdListModels(session);
        break;
      case '/health':
        await this.cmdHealthCheck(session);
        break;
      case '/clear':
        this.cmdClear(session);
        break;
      default:
        // 未知命令，发送给 AI
        session.messages.push({ role: 'user', content: command, timestamp: Date.now() });
        await this.sendToProxy(session, command);
        break;
    }
  }

  /** /auto-login - 通过代理服务器 API 切换到下一个账号 */
  private async cmdAutoLogin(session: ChatSession): Promise<void> {
    const resultMsg: ChatMessage = {
      role: 'system',
      content: '',
      timestamp: Date.now(),
    };

    try {
      // 先检查代理服务器是否在运行
      const health = await this.healthCheck();
      if (!health.ok) {
        resultMsg.content = '❌ Windsurf 代理服务器未运行，无法切号';
        session.messages.push(resultMsg);
        this.emit('onDone', session.id, resultMsg.content);
        return;
      }

      // 调用代理服务器的 rotate-account API，让服务器内部正确地切换账号
      const rotateResult = await this.callProxyApi('/api/admin/rotate-account', 'POST');

      if (!rotateResult.ok) {
        resultMsg.content = `❌ 切号失败: ${rotateResult.error || rotateResult.message || '未知错误'}`;
        session.messages.push(resultMsg);
        this.emit('onDone', session.id, resultMsg.content);
        return;
      }

      // 同步更新插件账号状态文件
      try {
        const accountsPath = path.join(
          os.homedir(), 'Documents', 'myDev', 'windsurf反代', 'server', 'windsurf-accounts.txt'
        );
        const statePath = path.join(
          os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage',
          'session-sync-profiles.json'
        );

        if (fs.existsSync(accountsPath)) {
          const content = fs.readFileSync(accountsPath, 'utf8');
          const accounts = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;

          if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.currentIndex = (rotateResult.currentIndex ?? 1) - 1;
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
          }
        }
      } catch (syncErr: any) {
        console.warn('[ChatSession] Failed to sync plugin state:', syncErr.message);
      }

      const total = rotateResult.total || '?';
      const idx = rotateResult.currentIndex || '?';
      const accounts = rotateResult.accounts || [];
      const currentAcc = accounts.find((a: any) => a.index === (idx as number) - 1);
      const email = currentAcc?.email || '?';

      resultMsg.content = `✅ 已切换到账号 #${idx}/${total} (${email})\n代理服务器账号池已更新，后续请求将使用新账号`;
    } catch (err: any) {
      resultMsg.content = `❌ 切号失败: ${err.message}`;
    }

    session.messages.push(resultMsg);
    this.emit('onDone', session.id, resultMsg.content);
  }

  /** 调用 Windsurf 代理服务器 API */
  private callProxyApi(path: string, method: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = method === 'POST' ? '{}' : undefined;
      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path,
        method,
        headers: payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {},
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: data });
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Proxy API timeout')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** /switch - 切换到指定账号 */
  private async cmdSwitchAccount(session: ChatSession): Promise<void> {
    const resultMsg: ChatMessage = {
      role: 'system',
      content: '请使用 /auto-login 自动切换到下一个可用账号',
      timestamp: Date.now(),
    };
    session.messages.push(resultMsg);
    this.emit('onDone',session.id, resultMsg.content);
  }

  /** /models - 列出可用模型 */
  private async cmdListModels(session: ChatSession): Promise<void> {
    const models = await this.listModels();
    const resultMsg: ChatMessage = {
      role: 'system',
      content: models.length > 0
        ? '可用模型:\n' + models.map(m => `  • ${m.id} (${m.credits})`).join('\n')
        : '❌ 无法获取模型列表，请检查 Windsurf 是否运行',
      timestamp: Date.now(),
    };
    session.messages.push(resultMsg);
    this.emit('onDone',session.id, resultMsg.content);
  }

  /** /health - 健康检查 */
  private async cmdHealthCheck(session: ChatSession): Promise<void> {
    const health = await this.healthCheck();
    const resultMsg: ChatMessage = {
      role: 'system',
      content: health.ok
        ? '✅ Windsurf 代理运行正常'
        : `❌ Windsurf 代理不可用: ${health.error || '未知错误'}`,
      timestamp: Date.now(),
    };
    session.messages.push(resultMsg);
    this.emit('onDone',session.id, resultMsg.content);
  }

  /** /clear - 清空对话历史 */
  private cmdClear(session: ChatSession): void {
    session.messages = [];
    const resultMsg: ChatMessage = {
      role: 'system',
      content: '✅ 对话历史已清空',
      timestamp: Date.now(),
    };
    session.messages.push(resultMsg);
    this.emit('onDone',session.id, resultMsg.content);
  }

  // ========== 管理方法 ==========

  getSession(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): ChatSession[] {
    return Array.from(this.sessions.values());
  }

  private maybeGenerateTitle(session: ChatSession): void {
    if (session.titleLocked || session.titleGenerationInFlight) return;

    const userMsgs = session.messages.filter(m => m.role === 'user');
    if (userMsgs.length < 2 || userMsgs.length > 5) return;

    this.generateTitle(session).catch(() => {});
  }

  /** 让 AI 根据累积对话历史生成标题（第 2-5 轮持续更新） */
  private async generateTitle(session: ChatSession): Promise<void> {
    session.titleGenerationInFlight = true;
    console.log('[Chat Title] Generating title for session:', session.id,
      'with', session.messages.length, 'messages');

    try {
      // 只用用户发送的消息来起标题（每条截断到 200 字，避免 token 爆炸）
      const history = session.messages
        .filter(m => m.role === 'user')
        .map(m => m.content.slice(0, 200))
        .join('\n');

      const prompt = `请为以下对话生成一个简短标题（不超过15个字，直接输出标题，不要加引号或任何解释）：\n\n${history}`;

      const title = await this.requestTitleFromAI(session.model, prompt);
      if (title) {
        console.log('[Chat Title] Generated title:', title);
        if (!session.titleLocked) {
          session.title = title.slice(0, 50);
          session.titleUpdateCount++;
          this.emit('onTitleUpdate', session.id, session.title);
        }
      } else {
        console.log('[Chat Title] No title returned from AI, using fallback');
        const firstUser = session.messages.find(m => m.role === 'user');
        if (!session.titleLocked) {
          session.title = firstUser ? firstUser.content.slice(0, 30) : '新对话';
          session.titleUpdateCount++;
          this.emit('onTitleUpdate', session.id, session.title);
        }
      }
    } catch (error) {
      console.error('[Chat Title] Title generation failed:', error);
      const firstUser = session.messages.find(m => m.role === 'user');
      if (!session.titleLocked) {
        session.title = firstUser ? firstUser.content.slice(0, 30) : '新对话';
        session.titleUpdateCount++;
        this.emit('onTitleUpdate', session.id, session.title);
      }
    } finally {
      session.titleGenerationInFlight = false;
    }
  }

  /** 通过 /v1/chat/completions 发一个轻量请求让 AI 起标题 */
  private requestTitleFromAI(model: string, prompt: string): Promise<string> {
    const config = this.getTitleAIConfig?.();
    console.log('[Chat Title] AI config available:', !!config);
    
    if (config?.baseUrl && config.apiKey && config.model) {
      console.log('[Chat Title] Using configured AI service:', config.apiFormat, config.model);
      return requestTitleFromConfiguredAI(config, prompt);
    }

    console.log('[Chat Title] Using Windsurf proxy for title generation');
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 64,
        reasoning_effort: 'minimal',
        stream: false,
      });

      const req = http.request({
        hostname: WINDSURF_PROXY_HOST,
        port: WINDSURF_PROXY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': 'Bearer duocli',
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const title = parsed?.choices?.[0]?.message?.content?.trim() || '';
            resolve(cleanGeneratedTitle(title));
          } catch {
            reject(new Error('Failed to parse title response'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Title request timeout')); });
      req.write(payload);
      req.end();
    });
  }

  destroy(id: string): void {
    this.abortStream(id);
    this.sessions.delete(id);
  }

  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.title = title;
      session.titleLocked = true;
    }
  }
}
