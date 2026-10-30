/**
 * Unified argument analysis: exact propositional truth tables plus
 * first-order natural-deduction proof search and bounded countermodels.
 */
import { analyze as analyzePropositional, parse as parsePropositional, format as formatPropositional, LIMITS, LogicError } from './logic.js';
import { parse as parseFol, format as formatFol, isFirstOrderSource, describe } from './fol.js';
import { proveArgument } from './natural-deduction.js';
import { findCountermodel } from './countermodel.js';

export function propToFol(node) {
  if (node.type === 'variable') return { type: 'predicate', name: node.name, args: [] };
  if (node.type === 'constant') return node;
  if (node.type === 'not') return { type: 'not', child: propToFol(node.child) };
  return { ...node, left: propToFol(node.left), right: propToFol(node.right) };
}

export function parseFormula(source) {
  return isFirstOrderSource(source) ? parseFol(source) : parsePropositional(source);
}

function parseAnyFol(source) {
  if (isFirstOrderSource(source)) {
    const parsed = parseFol(source);
    return { ast: parsed.ast, formatted: parsed.formatted };
  }
  const parsed = parsePropositional(source);
  const ast = propToFol(parsed.ast);
  return { ast, formatted: formatFol(ast) };
}

export function analyzeArgument({ premises = [], conclusion = '' } = {}, options = {}) {
  if (!Array.isArray(premises) || premises.length > LIMITS.premises) throw new LogicError(`前提数量不能超过 ${LIMITS.premises} 条。`);
  const firstOrder = premises.some(isFirstOrderSource) || isFirstOrderSource(conclusion);
  const proofOptions = { maxNodes: options.proofMaxNodes ?? 6000, maxDepth: options.proofMaxDepth ?? 32 };
  if (!firstOrder) {
    const result = analyzePropositional({ premises, conclusion });
    const folPremises = result.premises.map(premise => propToFol(premise.ast));
    const folConclusion = propToFol(result.conclusion.ast);
    const proof = proveArgument(folPremises, folConclusion, proofOptions);
    return {
      ...result, kind: 'propositional', folPremises, folConclusion,
      proof: proof?.proof ?? null, proofSteps: proof?.steps ?? [], proofStats: proof?.stats ?? null,
      proofVerified: Boolean(proof?.verification?.ok),
    };
  }
  const parsedPremises = premises.map((source, index) => {
    try { return parseAnyFol(source); }
    catch (error) { throw new LogicError(`前提 ${index + 1}：${error.message}`, error.position); }
  });
  let parsedConclusion;
  try { parsedConclusion = parseAnyFol(conclusion); }
  catch (error) { throw new LogicError(`结论：${error.message}`, error.position); }
  const folPremises = parsedPremises.map(premise => premise.ast);
  const folConclusion = parsedConclusion.ast;
  // Reject inconsistent predicate arities before proof/model search.
  describe({ type: 'and', left: folPremises.reduce((left, formula) => left ? { type: 'and', left, right: formula } : formula, { type: 'constant', value: true }), right: folConclusion });
  const proof = proveArgument(folPremises, folConclusion, proofOptions);
  let valid = null;
  let countermodelSearch = null;
  if (proof) valid = true;
  else {
    countermodelSearch = findCountermodel(folPremises, folConclusion, {
      maxDomain: options.maxDomain ?? 3,
      maxAtoms: options.maxAtoms ?? 20,
      maxMappings: options.maxMappings ?? 512,
      maxSatNodes: options.maxSatNodes ?? 200000,
    });
    if (countermodelSearch.found) valid = false;
  }
  const free = new Set();
  for (const formula of [...folPremises, folConclusion]) for (const name of describe(formula).freeVariables) free.add(name);
  return {
    kind: 'first-order', valid,
    premises: parsedPremises, conclusion: parsedConclusion, folPremises, folConclusion,
    variables: [...free].sort(), rows: [], counterexamples: countermodelSearch?.found ? [countermodelSearch.model] : [], criticalRows: [],
    contradictoryPremises: false, tautologicalConclusion: false,
    proof: proof?.proof ?? null, proofSteps: proof?.steps ?? [], proofStats: proof?.stats ?? null, proofVerified: Boolean(proof?.verification?.ok),
    countermodel: countermodelSearch?.found ? countermodelSearch.model : null, countermodelSearch,
    conditional: formatFol({ type: 'implies', left: folPremises.reduce((left, formula) => ({ type: 'and', left, right: formula }), { type: 'constant', value: true }), right: folConclusion }),
  };
}
