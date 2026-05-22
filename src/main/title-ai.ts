import * as http from 'http';
import * as https from 'https';

export interface TitleAIConfig {
  apiFormat: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function cleanGeneratedTitle(title: string): string {
  return title
    .trim()
    .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/g, '')
    .replace(/[。，！？；：、\.\,\!\?\;\:]+$/, '')
    .trim();
}

export async function requestTitleFromConfiguredAI(config: TitleAIConfig, prompt: string): Promise<string> {
  const format = (config.apiFormat || '').toLowerCase();
  if (format === 'anthropic') {
    return requestAnthropicTitle(config, prompt);
  }
  if (format === 'openai') {
    return requestOpenAITitle(config, prompt);
  }
  if (format === 'gemini') {
    return requestGeminiTitle(config, prompt);
  }
  if (format === 'ollama') {
    return requestOllamaTitle(config, prompt);
  }
  throw new Error(`Unsupported title API format: ${config.apiFormat}`);
}

function requestAnthropicTitle(config: TitleAIConfig, prompt: string): Promise<string> {
  const payload = JSON.stringify({
    model: config.model,
    max_tokens: 64,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });

  return requestExternalJSON(config.baseUrl, '/v1/messages', payload, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  }).then((parsed) => {
    const title = parsed?.content
      ?.map((part: any) => part?.type === 'text' ? part.text : '')
      ?.join('')
      ?.trim() || '';
    return cleanGeneratedTitle(title);
  });
}

function requestOpenAITitle(config: TitleAIConfig, prompt: string): Promise<string> {
  const payload = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 64,
    reasoning_effort: 'minimal',
    stream: false,
  });

  return requestExternalJSON(config.baseUrl, '/v1/chat/completions', payload, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Authorization': `Bearer ${config.apiKey}`,
  }).then((parsed) => {
    const title = parsed?.choices?.[0]?.message?.content?.trim() || '';
    return cleanGeneratedTitle(title);
  });
}

function requestGeminiTitle(config: TitleAIConfig, prompt: string): Promise<string> {
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 64,
      temperature: 0.4,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const endpoint = `/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

  return requestExternalJSON(config.baseUrl, endpoint, payload, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }).then((parsed) => {
    const title = parsed?.candidates?.[0]?.content?.parts
      ?.map((part: any) => part?.text || '')
      ?.join('')
      ?.trim() || '';
    return cleanGeneratedTitle(title);
  });
}

function requestOllamaTitle(config: TitleAIConfig, prompt: string): Promise<string> {
  const payload = JSON.stringify({
    model: config.model,
    prompt,
    stream: false,
    think: false,
    options: { num_predict: 64 },
  });

  return requestExternalJSON(config.baseUrl, '/api/generate', payload, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }).then((parsed) => {
    const title = (parsed?.response || '').trim();
    return cleanGeneratedTitle(title);
  });
}

/**
 * 拼接 baseUrl 和 endpoint，避免重复路径段。
 * 例如 baseUrl='https://x/v1' + endpoint='/v1/messages' → '/v1/messages'。
 */
function joinPath(basePath: string, endpoint: string): string {
  const base = basePath.replace(/\/$/, '');
  const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (!base) return ep;

  const baseSegs = base.split('/').filter(Boolean);
  const [epPathRaw, epQuery = ''] = ep.split('?');
  const epSegs = epPathRaw.split('/').filter(Boolean);

  // 找最大重叠：base 末尾若干段 == endpoint 开头若干段
  let overlap = 0;
  const max = Math.min(baseSegs.length, epSegs.length);
  for (let n = max; n >= 1; n--) {
    let match = true;
    for (let i = 0; i < n; i++) {
      if (baseSegs[baseSegs.length - n + i] !== epSegs[i]) { match = false; break; }
    }
    if (match) { overlap = n; break; }
  }

  const merged = '/' + [...baseSegs, ...epSegs.slice(overlap)].join('/');
  return epQuery ? `${merged}?${epQuery}` : merged;
}

function requestExternalJSON(
  baseUrl: string,
  endpoint: string,
  payload: string,
  headers: Record<string, string | number>
): Promise<any> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
    } catch {
      reject(new Error('Invalid title API baseUrl'));
      return;
    }

    const fullPath = joinPath(url.pathname, endpoint);
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: fullPath,
      method: 'POST',
      headers,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(data || `HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
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
