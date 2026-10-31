import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiExplainer, normalizeApiConfig } from '../api-client.js';
import { buildMessages, isCounterexamplePayload } from '../llm-prompt.js';

const invalid = { valid: false, kind: 'propositional', premises: ['如果P那么Q'], conclusion: 'P', counterexample: { values: { P: false, Q: true } }, narrative: '反例' };
const config = { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'secret-key' };
const okResponse = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });

test('API config normalization appends chat completions and rejects unsafe URLs', () => {
  assert.equal(normalizeApiConfig(config).endpoint, 'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeApiConfig({ ...config, baseUrl: 'https://api.example.com/v1/chat/completions/' }).endpoint, 'https://api.example.com/v1/chat/completions');
  assert.throws(() => normalizeApiConfig({ ...config, baseUrl: 'http://api.example.com/v1' }), /HTTPS/);
  assert.throws(() => normalizeApiConfig({ ...config, baseUrl: 'https://user:pass@api.example.com/v1' }), /账号或密钥/);
  assert.throws(() => normalizeApiConfig({ ...config, baseUrl: 'https://api.example.com/v1?key=secret' }), /查询参数/);
  assert.throws(() => normalizeApiConfig({ ...config, model: '' }), /模型名称/);
  assert.throws(() => normalizeApiConfig({ ...config, apiKey: 'bad\nkey' }), /非法字符/);
});

test('shared prompt refuses valid payloads and never includes the API key', () => {
  assert.equal(isCounterexamplePayload({ valid: true }), false);
  assert.throws(() => buildMessages({ valid: true }), /反例/);
  const messages = buildMessages(invalid);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('不能改判'));
  assert.ok(messages[1].content.includes('反例'));
  assert.ok(!JSON.stringify(messages).includes('secret-key'));
});

test('API client is lazy and refuses valid or missing payloads', async () => {
  let calls = 0;
  const client = new ApiExplainer(() => {}, { fetchImpl: async () => { calls++; return okResponse('可以设想。'); } });
  await client.generate({ valid: true }, 'key', config);
  await client.generate(null, 'key', config);
  assert.equal(calls, 0);
});

test('API client sends one guarded POST with key only in Authorization header', async () => {
  const calls = [];
  const events = [];
  const client = new ApiExplainer(event => events.push(event), {
    fetchImpl: async (url, options) => { calls.push({ url, options }); return okResponse('可以设想一个反例。不合理的是跳步。'); },
  });
  await client.generate(invalid, 'explanation-key', config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer secret-key');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.ok(!options.body.includes('secret-key'));
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(events.filter(e => e.type === 'done').map(e => ({ key: e.key, text: e.text, device: e.device })), [{ key: 'explanation-key', text: '可以设想一个反例。不合理的是跳步。', device: 'API · test-model' }]);
});

test('API client maps HTTP errors and keeps deterministic fallback available', async () => {
  const events = [];
  const client = new ApiExplainer(event => events.push(event), { fetchImpl: async () => ({ ok: false, status: 401 }) });
  await client.generate(invalid, 'key', config);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /401/);
  assert.equal(client.busy, false);
});

test('API client rejects invalid JSON and empty output', async () => {
  const events = [];
  const client = new ApiExplainer(event => events.push(event), { fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
  await client.generate(invalid, 'key', config);
  assert.match(events.at(-1).message, /JSON/);
  const empty = new ApiExplainer(event => events.push(event), { fetchImpl: async () => okResponse('') });
  await empty.generate(invalid, 'key', config);
  assert.match(events.at(-1).message, /未返回可用改写/);
});

test('API cancellation aborts and ignores late output', async () => {
  const events = [];
  let resolveFetch;
  let aborted = false;
  const client = new ApiExplainer(event => events.push(event), {
    fetchImpl: (url, options) => new Promise(resolve => {
      resolveFetch = resolve;
      options.signal.addEventListener('abort', () => { aborted = true; });
    }),
  });
  const pending = client.generate(invalid, 'key', config);
  client.cancel();
  resolveFetch(okResponse('late'));
  await pending;
  assert.equal(aborted, true);
  assert.equal(events.filter(e => e.type === 'done').length, 0);
  assert.equal(client.busy, false);
});

test('API timeout produces a useful error', async () => {
  const events = [];
  const client = new ApiExplainer(event => events.push(event), {
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await client.generate(invalid, 'key', config);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /超时/);
});

test('network/CORS failures are reported without leaking the key', async () => {
  const events = [];
  const client = new ApiExplainer(event => events.push(event), { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await client.generate(invalid, 'key', config);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /CORS/);
  assert.ok(!events.at(-1).message.includes('secret-key'));
});
