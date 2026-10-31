import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeArgument } from '../argument.js';
import { buildArgumentPayload, parseArgumentResponse, verifyCounterexample, ARGUMENT_LIMITS } from '../llm-argument.js';
import { buildMessages, isModelPayload } from '../llm-prompt.js';
import { ApiExplainer } from '../api-client.js';
import { LocalExplainer } from '../llm-client.js';

const prop = analyzeArgument({ premises: ['P → Q', 'Q'], conclusion: 'P' });
const validProp = analyzeArgument({ premises: ['P → Q', 'P'], conclusion: 'Q' });
const fol = analyzeArgument({ premises: ['∃x P(x)'], conclusion: '∀x P(x)' });
const undecided = { ...fol, valid: null, countermodel: null, counterexamples: [] };
const config = { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'secret-key' };
const okResponse = text => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });

test('whole-argument payload packages every symbolic premise and the conclusion without tables or proof state', () => {
  const payload = buildArgumentPayload(prop, { P: '今天下雨', Q: '地面湿润', R: '无关含义' });
  assert.equal(payload.mode, 'argument');
  assert.deepEqual(payload.argument, { premises: ['P → Q', 'Q'], conclusion: 'P' });
  assert.deepEqual(payload.signature.variables, ['P', 'Q']);
  assert.deepEqual(payload.optionalMeaningHints, { P: '今天下雨', Q: '地面湿润' });
  assert.equal(payload.referenceVerdict.valid, false);
  assert.ok(!JSON.stringify(payload).includes('rows'));
  assert.ok(!JSON.stringify(payload).includes('proofSteps'));
  assert.ok(!JSON.stringify(payload).includes('无关含义'));
  assert.ok(isModelPayload(payload));
});

test('argument mode may explore valid and undecided arguments, while legacy narration remains invalid-only', () => {
  const validPayload = buildArgumentPayload(validProp);
  const undecidedPayload = buildArgumentPayload(undecided);
  assert.ok(isModelPayload(validPayload));
  assert.ok(isModelPayload(undecidedPayload));
  assert.equal(isModelPayload({ valid: true }), false);
  assert.throws(() => buildMessages({ valid: true }), /反例/);
  const messages = buildMessages(validPayload);
  assert.match(messages[0].content, /自己决定怎样解释/);
  assert.match(messages[0].content, /不要为了迎合/);
  assert.ok(messages[1].content.includes('"premises":["P → Q","P"]'));
  assert.ok(!JSON.stringify(messages).includes('secret-key'));
});

test('first-order payload exposes the signature needed for a checkable finite model', () => {
  const result = analyzeArgument({ premises: ['∀x (P(x) → R(x, a))', 'P(b)'], conclusion: 'R(b, a)' });
  const payload = buildArgumentPayload(result);
  assert.equal(payload.kind, 'first-order');
  assert.deepEqual(payload.signature.predicates, [{ name: 'P', arity: 1 }, { name: 'R', arity: 2 }]);
  assert.deepEqual(payload.signature.constants, ['a', 'b']);
  assert.deepEqual(payload.optionalMeaningHints, {});
});

test('response parsing accepts JSON, fenced JSON and prose without treating prose as a proof', () => {
  const candidate = { type: 'valuation', values: { P: false, Q: true } };
  const json = JSON.stringify({ explanation: '可以设想一个反例。', counterexample: candidate });
  assert.deepEqual(parseArgumentResponse(json).counterexample, candidate);
  assert.equal(parseArgumentResponse(`\n\`\`\`json\n${json}\n\`\`\`\n`).structured, true);
  assert.equal(parseArgumentResponse(`说明：${json}`).structured, true);
  const prose = parseArgumentResponse('我认为这个推理跳步了，但没有可靠反例。');
  assert.equal(prose.structured, false);
  assert.equal(prose.counterexample, null);
  assert.equal(parseArgumentResponse('{"explanation":').counterexample, null);
});

test('propositional candidate is accepted only when every premise is true and the conclusion false', () => {
  const review = verifyCounterexample(prop, { type: 'valuation', values: { P: false, Q: true } });
  assert.equal(review.status, 'verified');
  assert.deepEqual(review.premiseValues, [true, true]);
  assert.equal(review.conclusionValue, false);
  assert.deepEqual(review.values, { P: false, Q: true });
});

test('propositional candidates that satisfy the conclusion or fail a premise are rejected', () => {
  assert.equal(verifyCounterexample(prop, { type: 'valuation', values: { P: true, Q: true } }).status, 'rejected');
  const failed = verifyCounterexample(prop, { type: 'valuation', values: { P: true, Q: false } });
  assert.equal(failed.status, 'rejected');
  assert.match(failed.message, /前提 1 为假/);
});

test('propositional candidates require exact boolean coverage and reject extra or prototype-like keys', () => {
  for (const values of [{ P: false }, { P: false, Q: true, R: false }, { P: 0, Q: true }, { P: false, Q: 'true' }, JSON.parse('{"P":false,"Q":true,"__proto__":false}')]) {
    assert.equal(verifyCounterexample(prop, { type: 'valuation', values }).status, 'invalid');
  }
  assert.equal(verifyCounterexample(prop, null).status, 'missing');
  assert.equal(verifyCounterexample(prop, { type: 'finite-model' }).status, 'invalid');
});

test('first-order candidate can refute existential-to-universal with a two-object model', () => {
  const review = verifyCounterexample(fol, { type: 'finite-model', domainSize: 2, constants: {}, assignment: {}, predicates: { P: [[0]] } });
  assert.equal(review.status, 'verified');
  assert.deepEqual(review.premiseValues, [true]);
  assert.equal(review.conclusionValue, false);
  assert.deepEqual([...review.model.predicates.P], ['0']);
});

test('one-object model does not refute existential-to-universal and malformed models are rejected', () => {
  assert.equal(verifyCounterexample(fol, { type: 'finite-model', domainSize: 1, constants: {}, assignment: {}, predicates: { P: [[0]] } }).status, 'rejected');
  for (const candidate of [
    { type: 'finite-model', domainSize: 0, constants: {}, assignment: {}, predicates: { P: [] } },
    { type: 'finite-model', domainSize: 2, constants: {}, assignment: {}, predicates: { P: [[2]] } },
    { type: 'finite-model', domainSize: 2, constants: {}, assignment: {}, predicates: { P: [[0, 1]] } },
    { type: 'finite-model', domainSize: 2, constants: {}, assignment: {}, predicates: { P: [[0]], Q: [] } },
    { type: 'finite-model', domainSize: 2, constants: {}, assignment: {}, predicates: {} },
  ]) assert.equal(verifyCounterexample(fol, candidate).status, 'invalid');
});

test('finite-model review preserves rigid equality and rejects assignments that falsify premises', () => {
  const equality = analyzeArgument({ premises: ['a = b'], conclusion: 'a ≠ b' });
  const good = verifyCounterexample(equality, { type: 'finite-model', domainSize: 1, constants: { a: 0, b: 0 }, assignment: {}, predicates: {} });
  assert.equal(good.status, 'verified');
  const bad = verifyCounterexample(equality, { type: 'finite-model', domainSize: 2, constants: { a: 0, b: 1 }, assignment: {}, predicates: {} });
  assert.equal(bad.status, 'rejected');
});

test('free variables and constants must be interpreted exactly', () => {
  const open = analyzeArgument({ premises: ['P(x)'], conclusion: 'Q(x)' });
  const good = verifyCounterexample(open, { type: 'finite-model', domainSize: 1, constants: {}, assignment: { x: 0 }, predicates: { P: [[0]], Q: [] } });
  assert.equal(good.status, 'verified');
  assert.equal(verifyCounterexample(open, { type: 'finite-model', domainSize: 1, constants: {}, assignment: {}, predicates: { P: [[0]], Q: [] } }).status, 'invalid');
  const constants = analyzeArgument({ premises: ['P(a)'], conclusion: 'P(b)' });
  assert.equal(verifyCounterexample(constants, { type: 'finite-model', domainSize: 2, constants: { a: 0 }, assignment: {}, predicates: { P: [[0]] } }).status, 'invalid');
});

test('candidate review is bounded and never executes model-authored formulas', () => {
  const huge = { type: 'finite-model', domainSize: ARGUMENT_LIMITS.domain + 1, constants: {}, assignment: {}, predicates: { P: [] } };
  assert.equal(verifyCounterexample(fol, huge).status, 'invalid');
  const tuples = Array.from({ length: ARGUMENT_LIMITS.tuples + 1 }, () => [0]);
  assert.equal(verifyCounterexample(fol, { type: 'finite-model', domainSize: 1, constants: {}, assignment: {}, predicates: { P: tuples } }).status, 'invalid');
  assert.equal(verifyCounterexample(prop, { type: 'valuation', values: { P: false, Q: true }, formula: 'process.exit()' }).status, 'invalid');
});

test('API argument mode sends the packaged symbols and allows a larger structured answer', async () => {
  const calls = [];
  const events = [];
  const client = new ApiExplainer(event => events.push(event), { fetchImpl: async (url, options) => { calls.push({ url, options }); return okResponse(JSON.stringify({ explanation: '可以设想。', counterexample: { type: 'valuation', values: { P: false, Q: true } } })); } });
  await client.generate(buildArgumentPayload(validProp), 'argument-key', config);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.max_tokens, 1600);
  assert.ok(body.messages[1].content.includes('"conclusion":"Q"'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
  assert.ok(!calls[0].options.body.includes('secret-key'));
  assert.equal(events.at(-1).type, 'done');
});

test('local argument mode is explicit and can start for a valid argument; legacy mode cannot', t => {
  const workers = [];
  class FakeWorker { constructor(url, options) { this.url = url; this.options = options; workers.push(this); } postMessage() {} terminate() {} }
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = previous; });
  const client = new LocalExplainer(() => {});
  client.generate({ valid: true }, 'legacy-valid');
  assert.equal(workers.length, 0);
  client.generate(buildArgumentPayload(validProp), 'argument-valid');
  assert.equal(workers.length, 1);
  client.cancel();
});
