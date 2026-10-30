/**
 * Bounded finite-countermodel search for first-order arguments.
 * This is a refutation tool, not a decision procedure for first-order logic.
 */
import { freeVariables } from './fol.js';

const TRUE = { type: 'constant', value: true };
const FALSE = { type: 'constant', value: false };

function signature(formulas) {
  const predicates = new Map();
  const constants = new Set();
  const free = new Set();
  function visit(node) {
    if (node.type === 'predicate') {
      const previous = predicates.get(node.name);
      if (previous !== undefined && previous !== node.args.length) throw new Error(`谓词 ${node.name} 的参数个数不一致。`);
      predicates.set(node.name, node.args.length);
      for (const arg of node.args) if (arg.kind === 'constant') constants.add(arg.name);
    } else if (node.type === 'not') visit(node.child);
    else if (node.type === 'forall' || node.type === 'exists') visit(node.child);
    else if (node.left) { visit(node.left); visit(node.right); }
  }
  for (const formula of formulas) {
    visit(formula);
    for (const name of freeVariables(formula)) free.add(name);
  }
  return { predicates, constants: [...constants].sort(), free: [...free].sort() };
}

function* mappings(names, size, limit) {
  if (!names.length) { yield {}; return; }
  let count = 0;
  const current = {};
  function* rec(index) {
    if (index === names.length) { yield { ...current }; return; }
    for (let value = 0; value < size; value++) {
      if (++count > limit) return;
      current[names[index]] = value;
      yield* rec(index + 1);
    }
  }
  yield* rec(0);
}

function ground(node, env, size, mapping) {
  if (node.type === 'predicate') {
    const indices = node.args.map(arg => {
      const value = arg.kind === 'variable' ? env[arg.name] : mapping[arg.name];
      if (value === undefined) throw new Error(`缺少项 ${arg.name} 的解释。`);
      return value;
    });
    return { type: 'variable', name: `${node.name}#${indices.join(',')}` };
  }
  if (node.type === 'constant') return node;
  if (node.type === 'not') return { type: 'not', child: ground(node.child, env, size, mapping) };
  if (node.type === 'forall' || node.type === 'exists') {
    let result = null;
    for (let value = 0; value < size; value++) {
      const child = ground(node.child, { ...env, [node.variable]: value }, size, mapping);
      if (!result) result = child;
      else result = { type: node.type === 'forall' ? 'and' : 'or', left: result, right: child };
    }
    return result || (node.type === 'forall' ? TRUE : FALSE);
  }
  return { ...node, left: ground(node.left, env, size, mapping), right: ground(node.right, env, size, mapping) };
}

function simplify(node, assignment) {
  if (node.type === 'constant') return node;
  if (node.type === 'variable') {
    const value = assignment[node.name];
    return value === undefined ? node : { type: 'constant', value };
  }
  if (node.type === 'not') {
    const child = simplify(node.child, assignment);
    if (child.type === 'constant') return { type: 'constant', value: !child.value };
    return { type: 'not', child };
  }
  const left = simplify(node.left, assignment);
  const right = simplify(node.right, assignment);
  const l = left.type === 'constant' ? left.value : null;
  const r = right.type === 'constant' ? right.value : null;
  switch (node.type) {
    case 'and':
      if (l === false || r === false) return FALSE;
      if (l === true) return right;
      if (r === true) return left;
      return { type: 'and', left, right };
    case 'or':
      if (l === true || r === true) return TRUE;
      if (l === false) return right;
      if (r === false) return left;
      return { type: 'or', left, right };
    case 'implies':
      if (l === false || r === true) return TRUE;
      if (l === true) return right;
      if (r === false) return simplify({ type: 'not', child: left }, assignment);
      return { type: 'implies', left, right };
    case 'reverse':
      return simplify({ type: 'implies', left: right, right: left }, assignment);
    case 'iff':
      if (l !== null && r !== null) return { type: 'constant', value: l === r };
      if (l === true) return right;
      if (r === true) return left;
      if (l === false) return simplify({ type: 'not', child: right }, assignment);
      if (r === false) return simplify({ type: 'not', child: left }, assignment);
      return { type: 'iff', left, right };
    case 'xor':
      if (l !== null && r !== null) return { type: 'constant', value: l !== r };
      if (l === false) return right;
      if (r === false) return left;
      if (l === true) return simplify({ type: 'not', child: right }, assignment);
      if (r === true) return simplify({ type: 'not', child: left }, assignment);
      return { type: 'xor', left, right };
    case 'nand':
      return simplify({ type: 'not', child: { type: 'and', left, right } }, assignment);
    case 'nor':
      return simplify({ type: 'not', child: { type: 'or', left, right } }, assignment);
    default: throw new Error(`未知的命题连接词 ${node.type}`);
  }
}

function chooseVariable(node) {
  if (node.type === 'variable') return node.name;
  if (node.type === 'not') return chooseVariable(node.child);
  if (node.left) return chooseVariable(node.left) || chooseVariable(node.right);
  return null;
}
function countAtoms(node, set = new Set()) {
  if (node.type === 'variable') set.add(node.name);
  else if (node.type === 'not') countAtoms(node.child, set);
  else if (node.left) { countAtoms(node.left, set); countAtoms(node.right, set); }
  return set;
}

function dpll(node, assignment, budget) {
  const simplified = simplify(node, assignment);
  if (simplified.type === 'constant') return simplified.value ? assignment : null;
  if (++budget.nodes > budget.maxNodes) throw new Error('sat-search-limit');
  const variable = chooseVariable(simplified);
  if (!variable) return null;
  const positive = dpll(simplified, { ...assignment, [variable]: true }, budget);
  if (positive) return positive;
  return dpll(simplified, { ...assignment, [variable]: false }, budget);
}

export function evaluateFormula(node, model, env = {}) {
  if (node.type === 'predicate') {
    const indices = node.args.map(arg => arg.kind === 'variable' ? env[arg.name] : model.constants[arg.name]);
    if (indices.some(value => value === undefined)) throw new Error(`缺少项 ${arg.name} 的解释。`);
    return model.predicates[node.name].has(indices.join(','));
  }
  if (node.type === 'constant') return node.value;
  if (node.type === 'not') return !evaluateFormula(node.child, model, env);
  if (node.type === 'forall' || node.type === 'exists') {
    for (let value = 0; value < model.domain.length; value++) {
      const child = evaluateFormula(node.child, model, { ...env, [node.variable]: value });
      if (node.type === 'forall' && !child) return false;
      if (node.type === 'exists' && child) return true;
    }
    return node.type === 'forall';
  }
  const left = evaluateFormula(node.left, model, env);
  const right = evaluateFormula(node.right, model, env);
  switch (node.type) {
    case 'and': return left && right;
    case 'or': return left || right;
    case 'implies': return !left || right;
    case 'reverse': return !right || left;
    case 'iff': return left === right;
    case 'xor': return left !== right;
    case 'nand': return !(left && right);
    case 'nor': return !(left || right);
    default: throw new Error(`未知的公式节点 ${node.type}`);
  }
}

export function findCountermodel(premises, conclusion, options = {}) {
  const maxDomain = options.maxDomain ?? 3;
  const maxAtoms = options.maxAtoms ?? 20;
  const maxMappings = options.maxMappings ?? 512;
  const maxSatNodes = options.maxSatNodes ?? 200000;
  const sig = signature([...premises, conclusion]);
  const searched = [];
  let skipped = false;
  for (let size = 1; size <= maxDomain; size++) {
    const atomEstimate = [...sig.predicates.values()].reduce((sum, arity) => sum + size ** arity, 0);
    if (atomEstimate > maxAtoms) { skipped = true; searched.push({ size, skipped: 'too-many-atoms' }); continue; }
    const names = [...sig.constants, ...sig.free];
    if (size ** names.length > maxMappings) { skipped = true; searched.push({ size, skipped: 'too-many-mappings' }); continue; }
    for (const mapping of mappings(names, size, maxMappings)) {
      try {
        const groundedPremises = premises.map(formula => ground(formula, mapping, size, mapping));
        const groundedConclusion = ground(conclusion, mapping, size, mapping);
        let target = { type: 'not', child: groundedConclusion };
        for (const premise of groundedPremises) target = { type: 'and', left: premise, right: target };
        if (countAtoms(target).size > maxAtoms) { skipped = true; continue; }
        const assignment = dpll(target, {}, { nodes: 0, maxNodes: maxSatNodes });
        if (!assignment) continue;
        const predicates = {};
        for (const [name, arity] of sig.predicates) {
          const set = new Set();
          const indices = Array(arity).fill(0);
          const total = size ** arity;
          for (let code = 0; code < total; code++) {
            let rest = code;
            for (let position = arity - 1; position >= 0; position--) { indices[position] = rest % size; rest = Math.floor(rest / size); }
            if (assignment[`${name}#${indices.join(',')}`]) set.add(indices.join(','));
          }
          predicates[name] = set;
        }
        const model = {
          domain: Array.from({ length: size }, (_, index) => index),
          constants: Object.fromEntries(sig.constants.map(name => [name, mapping[name]])),
          assignment: Object.fromEntries(sig.free.map(name => [name, mapping[name]])),
          predicates,
        };
        const premiseValues = premises.map(formula => evaluateFormula(formula, model, model.assignment));
        const conclusionValue = evaluateFormula(conclusion, model, model.assignment);
        if (premiseValues.every(Boolean) && !conclusionValue) {
          return { found: true, model, premiseValues, conclusionValue, domainSize: size, searched, skipped };
        }
      } catch (error) {
        if (error.message === 'sat-search-limit') { skipped = true; searched.push({ size, skipped: 'sat-limit' }); break; }
        throw error;
      }
    }
    searched.push({ size, skipped: null });
  }
  return { found: false, searched, skipped, maxDomain };
}

export function describeModel(model) {
  const elements = model.domain.map(value => `d${value}`).join(', ');
  const constants = Object.entries(model.constants).map(([name, value]) => `${name} = d${value}`);
  const predicates = Object.entries(model.predicates).map(([name, set]) => {
    const tuples = [...set].map(key => `(${key.split(',').map(value => `d${value}`).join(', ')})`);
    return `${name}: ${tuples.length ? tuples.join(', ') : '空'}`;
  });
  const assignment = Object.entries(model.assignment).map(([name, value]) => `${name} = d${value}`);
  return { elements, constants, predicates, assignment };
}
