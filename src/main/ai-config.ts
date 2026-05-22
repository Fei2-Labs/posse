import * as https from 'https';
import * as http from 'http';

export interface AIProvider {
  id: string;          // 唯一标识
  name: string;        // 显示名称
  apiKey: string;      // API key
  baseUrl: string;     // endpoint
  model: string;       // 当前选中模型
  availableModels: string[];  // 可选模型列表
  source: string;      // 配置来源
  apiFormat: 'anthropic' | 'openai' | 'gemini' | 'ollama';  // API 格式
  status: 'pending' | 'ok' | 'fail';
  errorMsg?: string;
}

interface TestDef {
  testPath: string;
  testMethod: string;
  authStyle: 'anthropic' | 'bearer' | 'gemini-query' | 'none';
}

// 各 provider 的测试定义
const TEST_DEFS: Record<string, TestDef> = {
  anthropic: { testPath: '/v1/messages', testMethod: 'POST', authStyle: 'anthropic' },
  codex:     { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  gemini:    { testPath: '/v1beta/models', testMethod: 'GET', authStyle: 'gemini-query' },
  deepseek:  { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  minimax:   { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  zhipu:     { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' },
  opencode:  { testPath: '/v1/messages', testMethod: 'POST', authStyle: 'anthropic' },
  ollama:    { testPath: '/api/tags', testMethod: 'GET', authStyle: 'none' },
};

export class AIConfigManager {
  private providers: AIProvider[] = [];

  // 不再自动扫描，返回空列表（由用户手工填写 baseUrl 和 apiKey）
  async scan(): Promise<AIProvider[]> {
    this.providers = [];
    return this.providers;
  }

  getProviders(): AIProvider[] {
    return this.providers;
  }

  // ========== 测试连通性 ==========

  async testProvider(provider: AIProvider): Promise<AIProvider> {
    // 没有有效 apiKey 的直接标记失败（OAuth 类型、空 key），Ollama 除外
    if (provider.apiFormat !== 'ollama' && (!provider.apiKey || provider.apiKey === '(OAuth)')) {
      provider.status = 'fail';
      provider.errorMsg = '无有效 API Key';
      return provider;
    }

    // 根据 id 找测试定义，fallback 到通用
    let def = TEST_DEFS[provider.id];
    if (!def) {
      if (provider.baseUrl.includes('anthropic') || provider.baseUrl.includes('claude')) {
        def = TEST_DEFS.anthropic;
      } else {
        def = { testPath: '/v1/models', testMethod: 'GET', authStyle: 'bearer' };
      }
    }

    try {
      const result = await this.httpTest(provider, def);
      provider.status = result.ok ? 'ok' : 'fail';
      provider.errorMsg = result.ok ? undefined : result.error;
    } catch (e: any) {
      provider.status = 'fail';
      provider.errorMsg = e.message || '连接失败';
    }
    return provider;
  }

  async testAll(): Promise<AIProvider[]> {
    await Promise.all(this.providers.map(p => this.testProvider(p)));
    return this.providers;
  }

  private httpTest(
    provider: AIProvider,
    def: TestDef
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      let baseUrl = provider.baseUrl;
      // 确保 baseUrl 是合法 URL
      if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;

      const url = new URL(baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      let testPath = def.testPath;
      if (def.authStyle === 'gemini-query' && provider.apiKey) {
        testPath += `?key=${provider.apiKey}`;
      }

      const headers: Record<string, string> = {};
      if (def.authStyle === 'anthropic' && provider.apiKey) {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['content-type'] = 'application/json';
      } else if (def.authStyle === 'bearer' && provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname === '/' ? '' : url.pathname) + testPath,
        method: def.testMethod,
        timeout: 10000,
        headers,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const code = res.statusCode || 0;
          if (code >= 200 && code < 500) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `HTTP ${code}` });
          }
        });
      });

      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时' }); });

      if (def.authStyle === 'anthropic' && def.testMethod === 'POST') {
        req.write(JSON.stringify({
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }));
      }

      req.end();
    });
  }

  static maskKey(key: string): string {
    if (!key || key === '(OAuth)') return key || '(无)';
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '****' + key.substring(key.length - 4);
  }
}
