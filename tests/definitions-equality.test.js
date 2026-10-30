import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseProp, evaluate as evaluateProp, translate as translateProp } from '../logic.js';
import { parse as parseFol, isFirstOrderSource, hasEqualitySource, freeTermOccurrences, freeVariables } from '../fol.js';
import { proveArgument, verifyProof } from '../natural-deduction.js';
import { findCountermodel, evaluateFormula } from '../countermodel.js';
import { analyzeArgument, parseFormula } from '../argument.js';

const fol = source => parseFol(source).ast;
const term = name => ({ type: 'term', kind: ['x', 'y', 'z', 'u', 'v', 'w'].includes(name) ? 'variable' : 'constant', name });

test('definition symbols parse as bidirectional definitions in propositional logic', () => {
  for (const source of ['P ≝ Q ∧ R', 'P ≔ Q ∧ R', 'P ≜ Q ∧ R', 'P := Q ∧ R', 'P =def Q ∧ R', 'P =df Q ∧ R']) {
    const parsed = parseProp(source);
    assert.equal(parsed.formatted, 'P ≝ Q ∧ R');
    assert.equal(evaluateProp(parsed.ast, { P: true, Q: true, R: true }), true);
    assert.equal(evaluateProp(parsed.ast, { P: true, Q: true, R: false }), false);
  }
  assert.ok(translateProp(parseProp('P ≝ Q').ast).includes('按定义'));
  assert.equal(isFirstOrderSource('P ≝ Q'), false);
  assert.equal(hasEqualitySource('P ≝ Q'), false);
  assert.throws(() => parseProp('P ≝ Q ≝ R'), /连写/);
});

test('propositional definitions keep truth tables and natural-deduction definition rules', () => {
  const valid = analyzeArgument({ premises: ['P ≝ Q ∧ R', 'Q', 'R'], conclusion: 'P' });
  assert.equal(valid.kind, 'propositional');
  assert.equal(valid.valid, true);
  assert.ok(valid.rows.length === 8);
  assert.ok(valid.proofSteps.some(step => step.rule === 'definitionE1'));
  const invalid = analyzeArgument({ premises: ['P ≝ Q → R', 'Q'], conclusion: 'P' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.counterexamples.length > 0);
});

test('equality and inequality are first-order atomic assertions with aliases', () => {
  assert.equal(parseFol('a == b').formatted, 'a = b');
  assert.equal(parseFol('a != b').formatted, 'a ≠ b');
  assert.equal(parseFol('a /= b').formatted, 'a ≠ b');
  assert.equal(parseFol('¬a = b').formatted, 'a ≠ b');
  assert.equal(parseFol('¬(a ≠ b)').formatted, '¬(a ≠ b)');
  assert.deepEqual(parseFol('x = a').constants, ['a']);
  assert.deepEqual(parseFol('x = a').freeVariables, ['x']);
  assert.deepEqual([...freeVariables(fol('∀x x = a'))], []);
  assert.equal(isFirstOrderSource('a = b'), true);
  assert.throws(() => parseFol('P = Q'), /个体项/);
  assert.throws(() => parseFol('a = b = c'), /连写/);
  assert.throws(() => parseFormula('P = Q'), /个体项/);
});

test('natural deduction proves reflexivity, symmetry, transitivity, and substitution', () => {
  const cases = [
    [[], 'a = a'],
    [['a = b'], 'b = a'],
    [['a = b', 'b = c'], 'a = c'],
    [['a = b', 'P(a)'], 'P(b)'],
    [['a = b', 'P(b)'], 'P(a)'],
    [['a = b'], '∀x (P(x, a) → P(x, b))'],
    [['a ≠ b', 'b = c'], 'a ≠ c'],
    [['a ≠ b'], '∃x ∃y x ≠ y'],
    [['∀x (x = a → P(x))'], 'P(a)'],
    [['a ≠ a'], 'P'],
    [['P(a) ≝ Q(a)', 'Q(a)'], 'P(a)'],
    [['P ≝ Q', 'P'], 'Q'],
    [['P ≝ Q', 'Q'], 'P'],
  ];
  for (const [premises, conclusion] of cases) {
    const result = proveArgument(premises.map(fol), fol(conclusion), { maxNodes: 20000 });
    assert.ok(result, `${premises.join(', ')} ⊢ ${conclusion}`);
    assert.equal(result.verification.ok, true, result.verification.errors.join('; '));
  }
  const substitution = proveArgument([fol('a = b'), fol('P(a)')], fol('P(b)'));
  assert.ok(substitution.steps.some(step => step.rule === 'equalsE'));
  assert.ok(substitution.steps.some(step => step.rule === 'equalsI') === false);
});

test('equality substitution verifier rejects invalid and capturing replacements', () => {
  const equation = fol('a = y');
  const source = fol('∀y P(a)');
  const goal = fol('∀y P(y)');
  assert.deepEqual(freeTermOccurrences(source, term('a'), term('y')), []);
  const premiseEquation = { id: 1, rule: 'premise', formula: equation, premiseIndex: 0, children: [], subproofs: [] };
  const premiseSource = { id: 2, rule: 'premise', formula: source, premiseIndex: 1, children: [], subproofs: [] };
  const bad = { id: 3, rule: 'equalsE', formula: goal, children: [premiseEquation, premiseSource], from: term('a'), to: term('y'), paths: [['child', 'args', 0]], subproofs: [] };
  const check = verifyProof(bad, [equation, source], goal);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(error => error.includes('捕获') || error.includes('受约束')));
});

test('finite countermodels respect rigid equality and expose invalid substitutions', () => {
  const invalid = findCountermodel([fol('P(a)')], fol('P(b)'), { maxDomain: 3 });
  assert.equal(invalid.found, true);
  assert.notEqual(invalid.model.constants.a, invalid.model.constants.b);
  assert.equal(evaluateFormula(fol('P(a)'), invalid.model, invalid.model.assignment), true);
  assert.equal(evaluateFormula(fol('P(b)'), invalid.model, invalid.model.assignment), false);
  const contradiction = findCountermodel([fol('a = b')], fol('a ≠ b'), { maxDomain: 2 });
  assert.equal(contradiction.found, true);
  assert.equal(contradiction.model.constants.a, contradiction.model.constants.b);
  const analyzed = analyzeArgument({ premises: ['P(a)'], conclusion: 'P(b)' });
  assert.equal(analyzed.valid, false);
  assert.ok(analyzed.countermodel);
});

test('empty-premise equality and definition/equality routing remain stable', () => {
  const reflexive = analyzeArgument({ premises: [], conclusion: 'a = a' });
  assert.equal(reflexive.kind, 'first-order');
  assert.equal(reflexive.valid, true);
  assert.equal(reflexive.proofSteps.length, 1);
  const definition = analyzeArgument({ premises: ['∀x (P(x) ≝ Q(x))', 'Q(a)'], conclusion: 'P(a)' });
  assert.equal(definition.kind, 'first-order');
  assert.equal(definition.valid, true);
});
