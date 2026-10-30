import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, format, translate, analyze } from '../logic.js';
import { describeCounterexample, explanationKey } from '../explanation.js';

const val = (s, env) => evaluate(parse(s).ast, env);

test('extended connectives have exact truth tables and aliases', () => {
  for (const P of [false, true]) for (const Q of [false, true]) {
    const env = { P, Q };
    assert.equal(val('P ⊕ Q', env), P !== Q);
    assert.equal(val('P ^ Q', env), P !== Q);
    assert.equal(val('P ⊻ Q', env), P !== Q);
    assert.equal(val('P ≢ Q', env), P !== Q);
    assert.equal(val('P ↑ Q', env), !(P && Q));
    assert.equal(val('P ⊼ Q', env), !(P && Q));
    assert.equal(val('P ↓ Q', env), !(P || Q));
    assert.equal(val('P ⊽ Q', env), !(P || Q));
    assert.equal(val('P ← Q', env), !Q || P);
    assert.equal(val('P <- Q', env), !Q || P);
    assert.equal(val('P ⊃ Q', env), !P || Q);
    assert.equal(val('P ≡ Q', env), P === Q);
  }
});

test('extended operators preserve grouping, associativity and reject ambiguous arrows', () => {
  assert.equal(val('P → Q → R', { P: true, Q: true, R: false }), false);
  assert.equal(val('P ← Q ← R', { P: false, Q: true, R: true }), false);
  assert.equal(parse('P ← Q ← R').formatted, '(P ← Q) ← R');
  assert.throws(() => parse('P → Q ← R'), /括号/);
  assert.equal(val('P ∧ Q ↑ R', { P: true, Q: true, R: false }), true);
  assert.equal(val('P ∨ Q ⊕ R', { P: true, Q: true, R: false }), true);
});

test('2000 generated extended formulas round-trip without changing any valuation', () => {
  let seed = 98765;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const ops = ['and', 'or', 'implies', 'iff', 'xor', 'nor', 'nand', 'reverse'];
  const generate = depth => !depth || random() < .3
    ? { type: 'variable', name: ['P', 'Q', 'R'][Math.floor(random() * 3)] }
    : random() < .2 ? { type: 'not', child: generate(depth - 1) }
      : { type: ops[Math.floor(random() * ops.length)], left: generate(depth - 1), right: generate(depth - 1) };
  for (let i = 0; i < 2000; i++) {
    const ast = generate(4), source = format(ast), parsed = parse(source).ast;
    for (let mask = 0; mask < 8; mask++) {
      const env = { P: Boolean(mask & 4), Q: Boolean(mask & 2), R: Boolean(mask & 1) };
      assert.equal(evaluate(ast, env), evaluate(parsed, env), source);
    }
  }
});

test('extended Chinese translations preserve semantics', () => {
  assert.equal(translate(parse('P ↑ Q').ast), '并非（P，并且Q）');
  assert.equal(translate(parse('P ↓ Q').ast), '并非（P，或者Q）');
  assert.equal(translate(parse('P ⊕ Q').ast), '要么P，要么Q（二者不同时成立）');
  assert.equal(translate(parse('P ← Q').ast), '如果Q，那么P');
});

test('new examples really have their advertised validity', () => {
  assert.equal(analyze({ premises: ['P ⊕ Q', 'P'], conclusion: '¬Q' }).valid, true);
  assert.equal(analyze({ premises: ['P ↑ Q'], conclusion: '¬P ∨ ¬Q' }).valid, true);
  assert.equal(analyze({ premises: ['P ∨ Q', 'P'], conclusion: '¬Q' }).valid, false);
  assert.equal(analyze({ premises: ['P ↑ Q'], conclusion: '¬P ∧ ¬Q' }).valid, false);
});

test('only invalid arguments produce model payloads and deterministic explanations', () => {
  const valid = analyze({ premises: ['P'], conclusion: 'P' });
  assert.equal(describeCounterexample(valid), null);
  assert.equal(explanationKey(valid, {}), '');
  const invalid = analyze({ premises: ['P → Q', 'Q'], conclusion: 'P' });
  const explanation = describeCounterexample(invalid, { P: '今天下雨', Q: '地面湿润' });
  assert.equal(explanation.valid, false);
  assert.deepEqual(explanation.counterexample.values, { P: false, Q: true });
  assert.ok(explanation.narrative.includes('可以设想'));
  assert.ok(explanation.narrative.includes('不合理的不是这些事实本身'));
  assert.ok(explanation.narrative.includes('前提“如果今天下雨，那么地面湿润”和“地面湿润”全部成立'));
  assert.notEqual(explanationKey(invalid, { P: '甲' }), explanationKey(invalid, { P: '乙' }));
});
