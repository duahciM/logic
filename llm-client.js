/** Lazy, consensual local inference. Importing this module performs no network requests. */
import { isModelPayload } from './llm-prompt.js';

export class LocalExplainer {
  constructor(onEvent) {
    this.worker = null;
    this.onEvent = onEvent;
    this.key = '';
    this.busy = false;
    this.ready = false;
    this.timeout = null;
  }

  cancel() {
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.ready = false;
    this.key = '';
  }

  async clearCache() {
    this.cancel();
    if (!('caches' in window)) return false;
    let removed = false;
    for (const name of await caches.keys()) {
      if (!/transformers|onnx/i.test(name)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (/Qwen2\.5-0\.5B-Instruct|ort-wasm/i.test(request.url)) { await cache.delete(request); removed = true; }
      }
    }
    return removed;
  }

  generate(payload, key) {
    if (!isModelPayload(payload)) return;
    this.cancel();
    this.key = key;
    this.busy = true;
    this.onEvent({ type: 'status', stage: 'starting', key });
    try {
      this.worker = new Worker(new URL('./vendor/llm/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        if (data.key && data.key !== this.key) return;
        if (data.type === 'ready') this.ready = true;
        if (data.type === 'done' || data.type === 'error') { this.busy = false; clearTimeout(this.timeout); }
        this.onEvent({ ...data, key });
      };
      this.worker.onerror = () => {
        this.cancel();
        this.onEvent({ type: 'error', key, message: '本地模型运行环境未能启动。请先执行 npm ci --ignore-scripts && npm run build，或继续使用反例直译。' });
      };
      this.timeout = setTimeout(() => {
        this.cancel();
        this.onEvent({ type: 'error', key, message: '模型加载或生成超时。权重缓存会保留，可重试；反例直译不受影响。' });
      }, 10 * 60 * 1000);
      this.worker.postMessage({ type: 'generate', payload });
    } catch (error) {
      this.cancel();
      this.onEvent({ type: 'error', key, message: error.message });
    }
  }
}
