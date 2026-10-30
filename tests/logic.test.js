import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, format, translate, analyze, LogicError, LIMITS } from '../logic.js';

const value = (formula, assignment = {}) => evaluate(parse(formula).ast, assignment);

test('all five connectives have classical two-valued semantics', () => {
  for (const P of [false, true]) for (const Q of [false, true]) {
    const env = { P, Q };
    assert.equal(value('¬P', env), !P);
    assert.equal(value('P ∧ Q', env), P && Q);
    assert.equal(value('P ∨ Q', env), P || Q);
    assert.equal(value('P → Q', env), !P || Q);
    assert.equal(value('P ↔ Q', env), P === Q);
  }
});

test('operator precedence and parentheses are respected', () => {
  assert.equal(value('¬P ∧ Q → R ∨ S ↔ A', { P: true, Q: true, R: false, S: false, A: false }), false);
  assert.equal(value('P ∨ Q ∧ R', { P: false, Q: true, R: false }), false);
  assert.equal(value('(P ∨ Q) ∧ R', { P: false, Q: true, R: true }), true);
  assert.equal(value('¬(P ∧ Q)', { P: true, Q: false }), true);
  assert.equal(value('P → Q → R', { P: false, Q: true, R: false }), true);
  assert.equal(value('(P → Q) → R', { P: false, Q: true, R: false }), false);
});

test('keyboard aliases, whitespace and case normalize safely', () => {
  assert.equal(parse('!p && (q || !r) -> s <-> a').formatted, '¬P ∧ (Q ∨ ¬R) → S ↔ A');
  assert.equal(parse('~P | Q => R <=> S').formatted, '¬P ∨ Q → R ↔ S');
  assert.equal(parse(' p \n →\t q ').formatted, 'P → Q');
  assert.deepEqual(parse('r ∨ q ∧ r').variables, ['Q', 'R']);
});

test('constants are truth constants, not variables', () => {
  assert.deepEqual(parse('⊤ → ⊥').variables, []);
  assert.equal(value('⊤'), true);
  assert.equal(value('⊥'), false);
  assert.equal(value('⊥ → P', { P: false }), true);
  assert.equal(value('P ∨ ¬P', { P: false }), true);
  assert.equal(value('P ∨ ¬P', { P: true }), true);
});

test('invalid formulas report errors rather than silently evaluating', () => {
  for (const formula of ['', ' ', 'P Q', '(P', 'P)', '()', 'P ∧', '→ Q', 'P ∧ → Q', 'P $ Q', '1', 'P.Q', '¬', 'P → → Q']) {
    assert.throws(() => parse(formula), LogicError, formula);
  }
  assert.throws(() => parse(42), LogicError);
  assert.throws(() => parse('P'.repeat(LIMITS.formulaLength + 1)), /最多/);
  assert.throws(() => parse('('.repeat(80) + 'P' + ')'.repeat(80)), /过深/);
});

test('formatter round-trips 300 generated formulas without changing semantics', () => {
  let seed = 78523;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const names = ['P', 'Q', 'R'];
  const generate = depth => {
    if (!depth || random() < .3) return { type: 'variable', name: names[Math.floor(random() * names.length)] };
    if (random() < .2) return { type: 'not', child: generate(depth - 1) };
    return { type: ['and', 'or', 'implies', 'iff'][Math.floor(random() * 4)], left: generate(depth - 1), right: generate(depth - 1) };
  };
  for (let i = 0; i < 300; i++) {
    const ast = generate(4);
    const formatted = format(ast);
    const reparsed = parse(formatted).ast;
    for (let mask = 0; mask < 8; mask++) {
      const env = { P: Boolean(mask & 4), Q: Boolean(mask & 2), R: Boolean(mask & 1) };
      assert.equal(evaluate(reparsed, env), evaluate(ast, env), formatted);
    }
  }
});

test('Chinese translation uses connectives and optional variable meanings', () => {
  const meanings = { P: '今天下雨', Q: '地面湿润' };
  assert.equal(translate(parse('P → Q').ast, meanings), '如果今天下雨，那么地面湿润');
  assert.equal(translate(parse('P ∧ ¬Q').ast, meanings), '今天下雨，并且并非地面湿润');
  assert.equal(translate(parse('P ↔ Q').ast, meanings), '今天下雨，当且仅当地面湿润');
  assert.equal(translate(parse('P ∨ Q').ast), 'P，或者Q');
  assert.equal(translate(parse('¬(P ∧ Q)').ast), '并非（P，并且Q）');
  assert.equal(translate(parse('(P → Q) → R').ast), '如果（如果P，那么Q），那么R');
  assert.equal(translate(parse('P → (Q → R)').ast), '如果P，那么（如果Q，那么R）');
});

test('classic valid argument forms are accepted', () => {
  const examples = [
    { premises: ['P → Q', 'P'], conclusion: 'Q' },
    { premises: ['P → Q', '¬Q'], conclusion: '¬P' },
    { premises: ['P → Q', 'Q → R'], conclusion: 'P → R' },
    { premises: ['P ∨ Q', '¬P'], conclusion: 'Q' },
    { premises: ['P → Q', 'R → S', 'P ∨ R'], conclusion: 'Q ∨ S' },
    { premises: ['P', 'Q'], conclusion: 'P ∧ Q' },
  ];
  for (const example of examples) {
    const result = analyze(example);
    assert.equal(result.valid, true, example.conclusion);
    assert.equal(result.counterexamples.length, 0);
    assert.ok(result.criticalRows.length > 0);
  }
});

test('affirming the consequent and denying the antecedent yield real counterexamples', () => {
  const ac = analyze({ premises: ['P → Q', 'Q'], conclusion: 'P' });
  assert.equal(ac.valid, false);
  assert.deepEqual(ac.counterexamples.map(row => row.values), [{ P: false, Q: true }]);
  const da = analyze({ premises: ['P → Q', '¬P'], conclusion: '¬Q' });
  assert.equal(da.valid, false);
  assert.deepEqual(da.counterexamples.map(row => row.values), [{ P: false, Q: true }]);
});

test('contradictory premises are vacuously valid and explicitly identified', () => {
  const result = analyze({ premises: ['P', '¬P'], conclusion: 'Q' });
  assert.equal(result.valid, true);
  assert.equal(result.contradictoryPremises, true);
  assert.equal(result.criticalRows.length, 0);
  assert.equal(result.rows.length, 4);
});

test('with no premises, validity means the conclusion is a tautology', () => {
  assert.equal(analyze({ conclusion: 'P ∨ ¬P' }).valid, true);
  assert.equal(analyze({ conclusion: 'P' }).valid, false);
  assert.equal(analyze({ conclusion: '⊤' }).valid, true);
  assert.equal(analyze({ conclusion: '⊥' }).valid, false);
});

test('truth table is exhaustive, ordered, and internally consistent', () => {
  const result = analyze({ premises: ['P ∨ Q'], conclusion: 'P ∧ Q' });
  assert.deepEqual(result.rows.map(row => [row.values.P, row.values.Q]), [[true, true], [true, false], [false, true], [false, false]]);
  assert.equal(result.rows.length, 4);
  assert.equal(result.counterexamples.length, 2);
  assert.equal(result.criticalRows.length, 3);
  for (const row of result.rows) {
    assert.equal(row.allPremisesTrue, row.premiseValues.every(Boolean));
    assert.equal(row.counterexample, row.allPremisesTrue && !row.conclusionValue);
  }
});

test('ten variables are supported; excessive resource requests fail clearly', () => {
  const names = ['P', 'Q', 'R', 'S', 'A', 'B', 'C', 'D', 'E', 'F'];
  const result = analyze({ premises: [names.join(' ∧ ')], conclusion: names.join(' ∧ ') });
  assert.equal(result.variables.length, 10);
  assert.equal(result.rows.length, 1024);
  assert.equal(result.valid, true);
  assert.throws(() => analyze({ conclusion: [...names, 'G'].join(' ∨ ') }), /最多支持 10/);
  assert.throws(() => analyze({ premises: Array(9).fill('P'), conclusion: 'P' }), /前提数量/);
  assert.throws(() => analyze({ premises: ['P →'], conclusion: 'P' }), /前提 1/);
  assert.throws(() => analyze({ premises: ['P'], conclusion: 'Q ∧' }), /结论/);
});
