import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalExplainer } from '../llm-client.js';

class FakeWorker {
  static instances = [];
  constructor(url, options) {
    this.url = url; this.options = options; this.messages = []; this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { if (!this.terminated) this.onmessage?.({ data }); }
}

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

function setup(t) {
  FakeWorker.instances = [];
  mockGlobal(t, 'Worker', FakeWorker);
  const events = [];
  const client = new LocalExplainer(event => events.push(event));
  t.after(() => client.cancel());
  return { client, events };
}
const invalid = { valid: false, counterexample: { values: { P: false } } };

test('LLM client is lazy and refuses valid or missing payloads', t => {
  const { client, events } = setup(t);
  client.generate({ valid: true }, 'valid');
  client.generate(null, 'missing');
  assert.equal(FakeWorker.instances.length, 0);
  assert.equal(events.length, 0);
});

test('LLM client creates a module worker only for an invalid counterexample', t => {
  const { client } = setup(t);
  client.generate(invalid, 'invalid-key');
  assert.equal(FakeWorker.instances.length, 1);
  const worker = FakeWorker.instances[0];
  assert.match(worker.url.href, /vendor\/llm\/worker\.js$/);
  assert.equal(worker.options.type, 'module');
  assert.deepEqual(worker.messages, [{ type: 'generate', payload: invalid }]);
});

test('cancellation terminates the worker and ignores late output', t => {
  const { client, events } = setup(t);
  client.generate(invalid, 'old');
  const worker = FakeWorker.instances[0];
  client.cancel();
  worker.emit({ type: 'done', text: 'stale' });
  assert.equal(worker.terminated, true);
  assert.equal(client.worker, null);
  assert.equal(client.busy, false);
  assert.equal(events.filter(event => event.type === 'done').length, 0);
});

test('new explanations terminate old workers and scope events to the new key', t => {
  const { client, events } = setup(t);
  client.generate(invalid, 'old');
  const old = FakeWorker.instances[0];
  client.generate(invalid, 'new');
  const current = FakeWorker.instances[1];
  assert.equal(old.terminated, true);
  current.emit({ type: 'token', text: '反例', key: 'old' });
  current.emit({ type: 'done', text: '反例' });
  assert.deepEqual(events.filter(event => event.type === 'done'), [{ type: 'done', text: '反例', key: 'new' }]);
  assert.equal(client.busy, false);
});

test('worker startup errors unload the client and retain a useful fallback message', t => {
  const { client, events } = setup(t);
  client.generate(invalid, 'key');
  const worker = FakeWorker.instances[0];
  worker.onerror();
  assert.equal(worker.terminated, true);
  assert.equal(client.worker, null);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /反例直译/);
});

test('cache clearing is selective and cancels active inference', async t => {
  const { client } = setup(t);
  client.generate(invalid, 'key');
  const worker = FakeWorker.instances[0];
  const deleted = [];
  const modelCache = {
    keys: async () => [new Request('https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/abc/onnx/model_q4.onnx'), new Request('https://example.com/ort-wasm-simd-threaded.jsep.wasm'), new Request('https://example.com/other-model.onnx')],
    delete: async request => { deleted.push(request.url); return true; },
  };
  const unrelated = { keys: async () => { throw new Error('must not open unrelated cache'); } };
  mockGlobal(t, 'window', { caches: {} });
  mockGlobal(t, 'caches', {
    keys: async () => ['transformers-cache', 'site-assets'],
    open: async name => name === 'transformers-cache' ? modelCache : unrelated,
  });
  assert.equal(await client.clearCache(), true);
  assert.equal(worker.terminated, true);
  assert.equal(deleted.length, 2);
  assert.ok(deleted.every(url => /Qwen2\.5|ort-wasm/.test(url)));
});
