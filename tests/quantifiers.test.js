import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, format, substituteTerm, freeVariables, alphaKey } from '../fol.js';
import { proveArgument, verifyProof, proofToText } from '../natural-deduction.js';
import { findCountermodel, evaluateFormula } from '../countermodel.js';
import { analyzeArgument } from '../argument.js';

const ast = source => parse(source).ast;

test('first-order parser handles quantifiers, predicates, and scope parentheses', () => {
  assert.equal(parse('∀x (P(x) → Q(x))').formatted, '∀x (P(x) → Q(x))');
  assert.equal(parse('exists x P(x)').formatted, '∃x P(x)');
  assert.equal(parse('∀x ∃y R(x, y)').formatted, '∀x ∃y R(x, y)');
  assert.deepEqual(parse('P(a)').constants, ['a']);
  assert.deepEqual(parse('P(x)').freeVariables, ['x']);
  assert.deepEqual(parse('∀x P(x)').freeVariables, []);
  assert.throws(() => parse('∀a P(a)'), /量词必须约束个体变量/);
  assert.throws(() => parse('P(x, Q(y))'), /个体变量或常项/);
});

test('capture-avoiding substitution and alpha equivalence', () => {
  const formula = ast('∀y P(x, y)');
  const substituted = substituteTerm(formula, 'x', { type: 'term', kind: 'variable', name: 'y' });
  assert.notEqual(format(substituted), '∀y P(y, y)');
  assert.deepEqual([...freeVariables(substituted)], ['y']);
  assert.equal(alphaKey(ast('∀x P(x)')), alphaKey(ast('∀y P(y)')));
  assert.notEqual(alphaKey(ast('∀x P(x)')), alphaKey(ast('∀x Q(x)')));
});

test('natural deduction proves classic propositional and quantified arguments', () => {
  const cases = [
    [['P → Q', 'P'], 'Q'],
    [['P → Q', '¬Q'], '¬P'],
    [['P ∨ Q', '¬P'], 'Q'],
    [['P ↔ Q', 'P'], 'Q'],
    [[], 'P ∨ ¬P'],
    [['¬¬P'], 'P'],
    [['∀x (P(x) → Q(x))', '∀x P(x)'], '∀x Q(x)'],
    [['∀x P(x)'], '∃x P(x)'],
    [['∃x (P(x) ∧ Q(x))'], '∃x P(x)'],
    [['∀x (P(x) → Q(x))', '∃x P(x)'], '∃x Q(x)'],
    [['¬∃x P(x)'], '∀x ¬P(x)'],
    [['∀x ¬P(x)'], '¬∃x P(x)'],
    [['∃x ∀y R(x, y)'], '∀y ∃x R(x, y)'],
  ];
  for (const [premises, conclusion] of cases) {
    const result = proveArgument(premises.map(ast), ast(conclusion), { maxNodes: 20000 });
    assert.ok(result, `${premises.join(', ')} ⊢ ${conclusion}`);
    assert.equal(result.verification.ok, true);
    assert.ok(result.steps.length > 0);
    assert.ok(proofToText(result.steps).includes(conclusion.includes('∀') ? '∀' : result.steps.at(-1).formatted));
  }
});

test('proof verifier rejects a broken final conclusion', () => {
  const result = proveArgument([ast('P')], ast('P'));
  const check = verifyProof(result.proof, [ast('P')], ast('Q'));
  assert.equal(check.ok, false);
});

test('bounded countermodel search refutes invalid quantified arguments', () => {
  const cases = [
    [['∃x P(x)'], '∀x P(x)'],
    [['∀x ∃y R(x, y)'], '∃y ∀x R(x, y)'],
    [['∀x (P(x) → Q(x))', '∃x Q(x)'], '∃x P(x)'],
  ];
  for (const [premises, conclusion] of cases) {
    const result = findCountermodel(premises.map(ast), ast(conclusion), { maxDomain: 3 });
    assert.equal(result.found, true, conclusion);
    assert.ok(result.premiseValues.every(Boolean));
    assert.equal(result.conclusionValue, false);
    for (const premise of premises) assert.equal(evaluateFormula(ast(premise), result.model, result.model.assignment), true);
    assert.equal(evaluateFormula(ast(conclusion), result.model, result.model.assignment), false);
  }
});

test('unified analyzer keeps propositional truth tables and adds first-order proofs/models', () => {
  const prop = analyzeArgument({ premises: ['P → Q', 'P'], conclusion: 'Q' });
  assert.equal(prop.kind, 'propositional');
  assert.equal(prop.valid, true);
  assert.ok(prop.proofSteps.length);
  const valid = analyzeArgument({ premises: ['∀x (P(x) → Q(x))', '∀x P(x)'], conclusion: '∀x Q(x)' });
  assert.equal(valid.kind, 'first-order');
  assert.equal(valid.valid, true);
  assert.ok(valid.proofVerified);
  const invalid = analyzeArgument({ premises: ['∃x P(x)'], conclusion: '∀x P(x)' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.countermodel);
  assert.equal(invalid.proof, null);
});

test('mixed predicate arity is rejected', () => {
  assert.throws(() => analyzeArgument({ premises: ['P(x)'], conclusion: 'P(x, y)' }), /参数个数不一致/);
});

test('open formulas respect eigenvariable conditions and search failure stays undecided', () => {
  const invalidOpen = analyzeArgument({ premises: ['P(x)'], conclusion: '∀x P(x)' });
  assert.equal(invalidOpen.valid, false);
  assert.ok(invalidOpen.countermodel);
  const validOpen = analyzeArgument({ premises: ['P(x)'], conclusion: '∃x P(x)' });
  assert.equal(validOpen.valid, true);
  const unknown = analyzeArgument({ premises: ['∀x ∃y R(x, y)'], conclusion: '∃y ∀x R(x, y)' }, { proofMaxNodes: 1, maxDomain: 0 });
  assert.equal(unknown.valid, null);
  assert.equal(unknown.proof, null);
  assert.equal(unknown.countermodel, null);
});
