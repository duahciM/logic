/**
 * Bounded, goal-directed natural deduction proof search for classical
 * first-order logic. A returned proof is independently checked by verifyProof.
 * Failure to find a proof is NOT a validity decision.
 */
import { alphaKey, equal, format, freeVariables, substituteTerm, collectTerms, freshConstant } from './fol.js';

export const RULE_LABELS = Object.freeze({
  premise: '前提', assumption: '假设', andI: '合取引入 ∧I', andE1: '合取消除 ∧E₁', andE2: '合取消除 ∧E₂',
  orI1: '析取引入 ∨I₁', orI2: '析取引入 ∨I₂', orE: '析取消除 ∨E',
  impliesI: '蕴涵引入 →I', impliesE: '蕴涵消除 →E', iffI: '等价引入 ↔I', iffE1: '等价消除 ↔E₁', iffE2: '等价消除 ↔E₂',
  notI: '否定引入 ¬I', notE: '否定消除 ¬E', raa: '归谬法 RAA', bottomE: '爆炸原理 ⊥E', truthI: '恒真引入 ⊤I',
  forallI: '全称引入 ∀I', forallE: '全称消除 ∀E', existsI: '存在引入 ∃I', existsE: '存在消除 ∃E',
});
const FALSE = { type: 'constant', value: false };
const TRUE = { type: 'constant', value: true };
const not = formula => ({ type: 'not', child: formula });

export class Search {
  constructor(premises, conclusion, options = {}) {
    this.premises = premises;
    this.conclusion = conclusion;
    this.maxNodes = options.maxNodes ?? 6000;
    this.maxDepth = options.maxDepth ?? 32;
    this.nextId = 1;
    this.nodes = 0;
    this.failed = new Set();
    this.active = new Set();
    this.debug = Boolean(options.debug);
    this.context = premises.map((formula, index) => ({ formula, node: this.make('premise', formula, { premiseIndex: index }) }));
  }
  make(rule, formula, extra = {}) {
    if (++this.nodes > this.maxNodes) throw new Error('proof-search-limit');
    return { id: this.nextId++, rule, formula, children: [], subproofs: [], ...extra };
  }
  stateKey(goal, context) {
    return `${alphaKey(goal)}|${context.map(entry => alphaKey(entry.formula)).sort().join(',')}`;
  }
  run() {
    try {
      const proof = this.prove(this.conclusion, this.context, 0);
      const stats = { nodes: this.nodes, maxNodes: this.maxNodes, maxDepth: this.maxDepth };
      if (!proof) return this.debug ? { proof: null, stats } : null;
      const check = verifyProof(proof, this.premises, this.conclusion);
      if (!check.ok) return this.debug ? { proof, verification: check, stats } : null;
      return { proof, steps: flattenProof(proof), stats, verification: check };
    } catch (error) {
      if (error.message === 'proof-search-limit') return this.debug ? { proof: null, stats: { nodes: this.nodes, maxNodes: this.maxNodes, maxDepth: this.maxDepth }, limit: true } : null;
      throw error;
    }
  }
  forbidden(context, goal, extra = []) {
    const forbidden = new Set();
    for (const term of collectTerms([...context.map(entry => entry.formula), goal, ...extra])) forbidden.add(term.name);
    return forbidden;
  }
  witnesses(context, goal) {
    const formulas = [...context.map(entry => entry.formula), goal];
    const constants = collectTerms(formulas).filter(term => term.kind === 'constant');
    const free = new Set();
    for (const formula of formulas) for (const name of freeVariables(formula)) free.add(name);
    const variables = [...free].sort().map(name => ({ type: 'term', kind: 'variable', name }));
    const seen = new Set();
    const ordered = [...variables, ...constants].filter(term => {
      const key = `${term.kind}:${term.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const fresh = freshConstant(this.forbidden(context, goal));
    return [...ordered.slice(0, 6), fresh];
  }
  prove(goal, context, depth) {
    if (depth > this.maxDepth || this.nodes > this.maxNodes) return null;
    const key = this.stateKey(goal, context);
    if (this.active.has(key) || this.failed.has(key)) return null;
    this.active.add(key);
    let result = null;
    try {
      result = this.proveInner(goal, context, depth);
      return result;
    } finally {
      this.active.delete(key);
      if (!result) this.failed.add(key);
    }
  }
  proveInner(goal, context, depth) {
    {
      const exact = context.find(entry => equal(entry.formula, goal));
      if (exact) return exact.node;
      if (equal(goal, TRUE)) return this.make('truthI', goal);
      if (equal(goal, FALSE)) return this.contradiction(context, depth);

      if (goal.type === 'and') {
        const left = this.prove(goal.left, context, depth + 1);
        if (left) {
          const right = this.prove(goal.right, context, depth + 1);
          if (right) return this.make('andI', goal, { children: [left, right] });
        }
      } else if (goal.type === 'implies') {
        const sub = this.subproof(goal.left, goal.right, context, depth + 1);
        if (sub) return this.make('impliesI', goal, { subproofs: [sub] });
      } else if (goal.type === 'iff') {
        const left = this.subproof(goal.left, goal.right, context, depth + 1);
        if (left) {
          const right = this.subproof(goal.right, goal.left, context, depth + 1);
          if (right) return this.make('iffI', goal, { subproofs: [left, right] });
        }
      } else if (goal.type === 'not') {
        const sub = this.subproof(goal.child, FALSE, context, depth + 1);
        if (sub) return this.make('notI', goal, { subproofs: [sub] });
      } else if (goal.type === 'forall') {
        const eigen = freshConstant(this.forbidden(context, goal));
        const instance = substituteTerm(goal.child, goal.variable, eigen);
        const proof = this.prove(instance, context, depth + 1);
        if (proof) return this.make('forallI', goal, { children: [proof], variable: goal.variable, eigen });
      } else if (goal.type === 'or') {
        const left = this.prove(goal.left, context, depth + 1);
        if (left) return this.make('orI1', goal, { children: [left] });
        const right = this.prove(goal.right, context, depth + 1);
        if (right) return this.make('orI2', goal, { children: [right] });
      }

      if (goal.type === 'exists') {
        // Prefer eliminating an available existential, then introduce a witness.
        for (const entry of [...context].reverse()) {
          if (entry.formula.type !== 'exists') continue;
          const proof = this.useFormula(entry.formula, entry.node, goal, context, depth, 0);
          if (proof) return proof;
        }
        for (const witness of this.witnesses(context, goal)) {
          const instance = substituteTerm(goal.child, goal.variable, witness);
          const proof = this.prove(instance, context, depth + 1);
          if (proof) return this.make('existsI', goal, { children: [proof], variable: goal.variable, term: witness });
        }
      }

      const used = this.useContext(goal, context, depth);
      if (used) return used;

      // Classical reductio. The active-state guard prevents immediate RAA loops.
      if (!equal(goal, FALSE)) {
        const sub = this.subproof(not(goal), FALSE, context, depth + 1);
        if (sub) return this.make('raa', goal, { subproofs: [sub] });
      }
      return null;
    }
  }
  subproof(assumption, goal, context, depth) {
    const assumptionNode = this.make('assumption', assumption);
    const proof = this.prove(goal, [...context, { formula: assumption, node: assumptionNode }], depth + 1);
    return proof ? { assumption, assumptionNode, proof } : null;
  }
  contradiction(context, depth) {
    for (let i = 0; i < context.length; i++) {
      for (let j = 0; j < context.length; j++) {
        if (i === j) continue;
        const positive = context[i];
        const negative = context[j];
        if (negative.formula.type === 'not' && equal(negative.formula.child, positive.formula)) {
          return this.make('notE', FALSE, { children: [positive.node, negative.node] });
        }
      }
    }
    return this.useContext(FALSE, context, depth);
  }
  useContext(goal, context, depth) {
    const ordered = [...context].reverse();
    for (const entry of ordered) {
      const proof = this.useFormula(entry.formula, entry.node, goal, context, depth, 0);
      if (proof) return proof;
    }
    return null;
  }
  useFormula(formula, node, goal, context, depth, eliminationDepth) {
    if (equal(formula, goal)) return node;
    if (eliminationDepth > 4 || depth > this.maxDepth) return null;
    if (formula.type === 'and') {
      const left = this.make('andE1', formula.left, { children: [node] });
      const found = this.useFormula(formula.left, left, goal, context, depth, eliminationDepth + 1);
      if (found) return found;
      const right = this.make('andE2', formula.right, { children: [node] });
      return this.useFormula(formula.right, right, goal, context, depth, eliminationDepth + 1);
    }
    if (formula.type === 'implies') {
      const antecedent = this.prove(formula.left, context, depth + 1);
      if (!antecedent) return null;
      const consequent = this.make('impliesE', formula.right, { children: [node, antecedent] });
      return this.useFormula(formula.right, consequent, goal, context, depth, eliminationDepth + 1);
    }
    if (formula.type === 'iff') {
      if (equal(formula.left, goal)) {
        const right = this.prove(formula.right, context, depth + 1);
        if (right) return this.make('iffE1', goal, { children: [node, right] });
      }
      if (equal(formula.right, goal)) {
        const left = this.prove(formula.left, context, depth + 1);
        if (left) return this.make('iffE2', goal, { children: [node, left] });
      }
      return null;
    }
    if (formula.type === 'forall') {
      if (eliminationDepth > 3) return null;
      for (const witness of this.witnesses(context, goal).slice(0, 6)) {
        const instance = substituteTerm(formula.child, formula.variable, witness);
        const eliminated = this.make('forallE', instance, { children: [node], variable: formula.variable, term: witness });
        const found = this.useFormula(instance, eliminated, goal, context, depth, eliminationDepth + 1);
        if (found) return found;
      }
      return null;
    }
    if (formula.type === 'exists') {
      const eigen = freshConstant(this.forbidden(context, goal, [formula]));
      const instance = substituteTerm(formula.child, formula.variable, eigen);
      const innerContext = context.filter(entry => entry.node.id !== node.id);
      const sub = this.subproof(instance, goal, innerContext, depth + 1);
      if (!sub) return null;
      return this.make('existsE', goal, { children: [node], subproofs: [{ ...sub, eigen }], variable: formula.variable, eigen });
    }
    if (formula.type === 'or') {
      const innerContext = context.filter(entry => entry.node.id !== node.id);
      const left = this.subproof(formula.left, goal, innerContext, depth + 1);
      if (!left) return null;
      const right = this.subproof(formula.right, goal, innerContext, depth + 1);
      if (!right) return null;
      return this.make('orE', goal, { children: [node], subproofs: [left, right] });
    }
    if (formula.type === 'not' && equal(goal, FALSE)) {
      const positive = this.prove(formula.child, context, depth + 1);
      if (positive) return this.make('notE', FALSE, { children: [positive, node] });
      return null;
    }
    if (equal(formula, FALSE)) return this.make('bottomE', goal, { children: [node] });
    return null;
  }
}

export function proveArgument(premises, conclusion, options) {
  return new Search(premises, conclusion, options).run();
}

function openAssumptions(node, map = new Map()) {
  if (node.rule === 'assumption') map.set(node.id, node.formula);
  for (const child of node.children || []) openAssumptions(child, map);
  for (const sub of node.subproofs || []) {
    const inner = openAssumptions(sub.proof, new Map());
    inner.delete(sub.assumptionNode.id);
    for (const [id, formula] of inner) map.set(id, formula);
  }
  return map;
}
function containsConstant(formula, name) {
  return collectTerms([formula]).some(term => term.kind === 'constant' && term.name === name);
}

export function verifyProof(root, premises, conclusion) {
  const errors = [];
  const fail = message => errors.push(message);
  const check = (node, expected) => { if (!equal(node.formula, expected)) fail(`公式不匹配：期望 ${format(expected)}，得到 ${format(node.formula)}`); };
  function visit(node) {
    const children = node.children || [];
    const subs = node.subproofs || [];
    switch (node.rule) {
      case 'premise':
        if (!premises[node.premiseIndex] || !equal(node.formula, premises[node.premiseIndex])) fail('前提引用无效。');
        break;
      case 'assumption': break;
      case 'truthI': check(node, TRUE); break;
      case 'andI':
        if (children.length !== 2 || node.formula.type !== 'and') return fail('∧I 结构无效。');
        check(children[0], node.formula.left); check(children[1], node.formula.right); break;
      case 'andE1':
        if (children.length !== 1 || children[0].formula.type !== 'and') return fail('∧E₁ 结构无效。');
        check(node, children[0].formula.left); break;
      case 'andE2':
        if (children.length !== 1 || children[0].formula.type !== 'and') return fail('∧E₂ 结构无效。');
        check(node, children[0].formula.right); break;
      case 'orI1':
        if (children.length !== 1 || node.formula.type !== 'or') return fail('∨I₁ 结构无效。');
        check(children[0], node.formula.left); break;
      case 'orI2':
        if (children.length !== 1 || node.formula.type !== 'or') return fail('∨I₂ 结构无效。');
        check(children[0], node.formula.right); break;
      case 'orE':
        if (children.length !== 1 || subs.length !== 2 || children[0].formula.type !== 'or') return fail('∨E 结构无效。');
        check(subs[0].assumptionNode, children[0].formula.left); check(subs[1].assumptionNode, children[0].formula.right);
        check(subs[0].proof, node.formula); check(subs[1].proof, node.formula); break;
      case 'impliesI':
        if (subs.length !== 1 || node.formula.type !== 'implies') return fail('→I 结构无效。');
        check(subs[0].assumptionNode, node.formula.left); check(subs[0].proof, node.formula.right); break;
      case 'impliesE':
        if (children.length !== 2 || children[0].formula.type !== 'implies') return fail('→E 结构无效。');
        check(children[1], children[0].formula.left); check(node, children[0].formula.right); break;
      case 'iffI':
        if (subs.length !== 2 || node.formula.type !== 'iff') return fail('↔I 结构无效。');
        check(subs[0].assumptionNode, node.formula.left); check(subs[0].proof, node.formula.right);
        check(subs[1].assumptionNode, node.formula.right); check(subs[1].proof, node.formula.left); break;
      case 'iffE1':
        if (children.length !== 2 || children[0].formula.type !== 'iff') return fail('↔E₁ 结构无效。');
        check(children[1], children[0].formula.right); check(node, children[0].formula.left); break;
      case 'iffE2':
        if (children.length !== 2 || children[0].formula.type !== 'iff') return fail('↔E₂ 结构无效。');
        check(children[1], children[0].formula.left); check(node, children[0].formula.right); break;
      case 'notI':
        if (subs.length !== 1 || node.formula.type !== 'not') return fail('¬I 结构无效。');
        check(subs[0].assumptionNode, node.formula.child); check(subs[0].proof, FALSE); break;
      case 'notE':
        if (children.length !== 2 || children[1].formula.type !== 'not') return fail('¬E 结构无效。');
        if (!equal(children[1].formula.child, children[0].formula)) fail('¬E 的两个公式不互补。');
        check(node, FALSE); break;
      case 'raa':
        if (subs.length !== 1) return fail('RAA 结构无效。');
        check(subs[0].assumptionNode, not(node.formula)); check(subs[0].proof, FALSE); break;
      case 'bottomE':
        if (children.length !== 1) return fail('⊥E 结构无效。');
        check(children[0], FALSE); break;
      case 'forallI': {
        if (children.length !== 1 || node.formula.type !== 'forall' || !node.eigen) return fail('∀I 结构无效。');
        check(children[0], substituteTerm(node.formula.child, node.formula.variable, node.eigen));
        for (const assumption of openAssumptions(children[0]).values()) if (containsConstant(assumption, node.eigen.name)) fail('∀I 本征常项出现在开放假设中。');
        break;
      }
      case 'forallE':
        if (children.length !== 1 || children[0].formula.type !== 'forall' || !node.term) return fail('∀E 结构无效。');
        check(node, substituteTerm(children[0].formula.child, children[0].formula.variable, node.term)); break;
      case 'existsI':
        if (children.length !== 1 || node.formula.type !== 'exists' || !node.term) return fail('∃I 结构无效。');
        check(children[0], substituteTerm(node.formula.child, node.formula.variable, node.term)); break;
      case 'existsE': {
        if (children.length !== 1 || subs.length !== 1 || children[0].formula.type !== 'exists' || !node.eigen) return fail('∃E 结构无效。');
        const exists = children[0].formula;
        check(subs[0].assumptionNode, substituteTerm(exists.child, exists.variable, node.eigen));
        check(subs[0].proof, node.formula);
        if (containsConstant(node.formula, node.eigen.name)) fail('∃E 本征常项出现在结论中。');
        const open = openAssumptions(subs[0].proof);
        open.delete(subs[0].assumptionNode.id);
        for (const assumption of open.values()) if (containsConstant(assumption, node.eigen.name)) fail('∃E 本征常项出现在开放假设中。');
        break;
      }
      default: fail(`未知规则 ${node.rule}`);
    }
    for (const child of children) visit(child);
    for (const sub of subs) { visit(sub.assumptionNode); visit(sub.proof); }
  }
  visit(root);
  if (!equal(root.formula, conclusion)) fail('证明的最终公式不是目标结论。');
  if (openAssumptions(root).size) fail('证明仍含有未 discharge 的假设。');
  return { ok: errors.length === 0, errors };
}

export function flattenProof(root) {
  const lines = [];
  const emitted = new Map();
  function emit(node, depth) {
    if (emitted.has(node.id)) return emitted.get(node.id);
    const refs = [];
    if (node.rule !== 'premise' && node.rule !== 'assumption') {
      for (const child of node.children || []) refs.push(emit(child, depth));
      for (const sub of node.subproofs || []) {
        refs.push(emit(sub.assumptionNode, depth + 1));
        refs.push(emit(sub.proof, depth + 1));
      }
    }
    const line = lines.length + 1;
    emitted.set(node.id, line);
    const notes = [];
    if (node.rule === 'forallI') notes.push(`本征常项 ${node.eigen.name} 不在开放假设中出现`);
    if (node.rule === 'existsE') notes.push(`本征常项 ${node.eigen.name} 不在结论或其他开放假设中出现`);
    if (node.rule === 'forallE') notes.push(`以 ${node.term.name} 实例化`);
    if (node.rule === 'existsI') notes.push(`以 ${node.term.name} 为见证`);
    lines.push({ line, depth, formula: node.formula, formatted: format(node.formula), rule: node.rule, ruleLabel: RULE_LABELS[node.rule] || node.rule, refs: [...new Set(refs)], note: notes.join('；') });
    return line;
  }
  const premises = new Map();
  (function collect(node) {
    if (node.rule === 'premise') premises.set(node.id, node);
    for (const child of node.children || []) collect(child);
    for (const sub of node.subproofs || []) { collect(sub.assumptionNode); collect(sub.proof); }
  })(root);
  for (const premise of [...premises.values()].sort((a, b) => a.premiseIndex - b.premiseIndex)) emit(premise, 0);
  emit(root, 0);
  return lines;
}

export function proofToText(steps) {
  return steps.map(step => `${String(step.line).padStart(2, ' ')}. ${'  '.repeat(step.depth)}${step.formatted}    ${step.ruleLabel}${step.refs.length ? ` [${step.refs.join(', ')}]` : ''}${step.note ? `（${step.note}）` : ''}`).join('\n');
}
