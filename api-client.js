/** Optional OpenAI-compatible API channel. Importing/configuring never sends a request. */
import { buildMessages, isModelPayload, normalizeGeneratedText } from './llm-prompt.js';

export const API_PRESETS = Object.freeze({
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
});

const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeApiConfig(config = {}) {
  const baseUrl = String(config.baseUrl ?? '').trim();
  const model = String(config.model ?? '').trim();
  const apiKey = String(config.apiKey ?? '').trim();
  if (!baseUrl) throw new Error('请填写 API 地址，例如 https://api.example.com/v1。');
  if (baseUrl.length > 2048 || CONTROL.test(baseUrl)) throw new Error('API 地址包含非法字符。');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('API 地址不是有效的 URL。'); }
  if (url.protocol !== 'https:') throw new Error('为保护密钥，API 地址必须使用 HTTPS。');
  if (url.username || url.password) throw new Error('请不要把账号或密钥写进 API 地址；密钥请使用单独字段。');
  if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或 # 片段。');
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/chat/completions')) path += '/chat/completions';
  url.pathname = path;
  const endpoint = url.href;
  if (endpoint.length > 2048) throw new Error('API 地址过长。');
  if (!model) throw new Error('请填写模型名称。');
  if (model.length > 120 || CONTROL.test(model)) throw new Error('模型名称过长或包含非法字符。');
  if (apiKey.length > 4096 || CONTROL.test(apiKey)) throw new Error('API Key 过长或包含换行等非法字符。');
  return { endpoint, model, apiKey };
}

function httpError(status) {
  if (status === 401 || status === 403) return `API 拒绝了密钥或权限（HTTP ${status}）。请检查 API Key、额度和模型权限。`;
  if (status === 404) return 'API 返回 404。请检查 API 地址是否到 /v1 或完整的 /chat/completions，以及模型名称。';
  if (status === 429) return 'API 请求过于频繁或额度不足（HTTP 429）。请稍后重试或检查账户额度。';
  if (status >= 500) return `API 服务暂时不可用（HTTP ${status}）。请稍后重试；上方反例直译不受影响。`;
  return `API 请求被拒绝（HTTP ${status}）。请检查模型名、参数和接口兼容性。`;
}

function extractText(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  return content;
}

export class ApiExplainer {
  constructor(onEvent, options = {}) {
    this.onEvent = onEvent;
    this.fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.controller = null;
    this.timeout = null;
    this.busy = false;
    this.key = '';
    this.generationId = 0;
    this.timedOut = false;
  }

  cancel() {
    clearTimeout(this.timeout);
    this.timeout = null;
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
    this.key = '';
    this.timedOut = false;
    this.generationId++;
  }

  async generate(payload, key, config) {
    if (!isModelPayload(payload)) return;
    const argumentMode = payload.mode === 'argument';
    let normalized;
    try { normalized = normalizeApiConfig(config); }
    catch (error) { this.onEvent({ type: 'error', key, message: error.message }); return; }
    this.cancel();
    const id = ++this.generationId;
    this.key = key;
    this.busy = true;
    this.timedOut = false;
    this.controller = new AbortController();
    this.onEvent({ type: 'status', stage: 'connecting', key });
    this.timeout = setTimeout(() => {
      this.timedOut = true;
      this.controller?.abort();
    }, this.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (normalized.apiKey) headers.Authorization = `Bearer ${normalized.apiKey}`;
      const response = await this.fetchImpl(normalized.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: normalized.model,
          messages: buildMessages(payload),
          stream: false,
          temperature: 0,
          max_tokens: argumentMode ? 1600 : 600,
        }),
        signal: this.controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (id !== this.generationId) return;
      if (!response.ok) throw new Error(httpError(response.status));
      let data;
      try { data = await response.json(); }
      catch { throw new Error('API 返回的不是有效 JSON。请确认接口兼容 OpenAI Chat Completions。'); }
      if (id !== this.generationId) return;
      const text = normalizeGeneratedText(extractText(data), argumentMode ? 6000 : 1200);
      if (!text) throw new Error(argumentMode ? 'API 未返回可用解释，请重试或查看本地引擎结果。' : 'API 未返回可用改写，请参考上方反例直译。');
      this.onEvent({ type: 'done', key, text, device: `API · ${normalized.model}` });
    } catch (error) {
      if (id !== this.generationId) return;
      if (this.timedOut) this.onEvent({ type: 'error', key, message: `API 请求超时（${Math.round(this.timeoutMs / 1000)} 秒）。可重试或切回本地模型；反例直译不受影响。` });
      else if (error?.name === 'AbortError') return;
      else if (error instanceof TypeError) this.onEvent({ type: 'error', key, message: '无法连接 API。请检查地址、网络和服务端 CORS 设置；浏览器直连需要接口允许跨域。' });
      else this.onEvent({ type: 'error', key, message: String(error?.message || error).slice(0, 400) });
    } finally {
      if (id === this.generationId) {
        clearTimeout(this.timeout);
        this.timeout = null;
        this.controller = null;
        this.busy = false;
        this.key = '';
        this.timedOut = false;
      }
    }
  }
}
