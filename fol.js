/**
 * Classical first-order formulas (without function symbols or equality).
 * Uppercase letters are predicate/proposition symbols; lowercase x,y,z,u,v,w
 * are individual variables, other lowercase letters are individual constants.
 */
import { LIMITS, LogicError } from './logic.js';

export const INDIVIDUAL_VARIABLES = Object.freeze(['x', 'y', 'z', 'u', 'v', 'w']);
const PRECEDENCE = Object.freeze({ iff: 0, implies: 1, reverse: 1, or: 2, xor: 2, nor: 2, and: 3, nand: 3, not: 4, forall: 4, exists: 4, predicate: 5, constant: 5 });
const BINARY = { '↔': 'iff', '→': 'implies', '←': 'reverse', '∨': 'or', '⊕': 'xor', '↓': 'nor', '∧': 'and', '↑': 'nand' };
const DISPLAY_OP = { iff: '↔', implies: '→', reverse: '←', or: '∨', xor: '⊕', nor: '↓', and: '∧', nand: '↑' };
const QUANTIFIER = { forall: '∀', exists: '∃' };

export function isFirstOrderSource(source) {
  return typeof source === 'string' && (/[∀∃]/.test(source) || /\b(?:forall|exists)\b/i.test(source) || /[A-Z]\s*\(/.test(source));
}

function tokenize(source) {
  if (typeof source !== 'string') throw new LogicError('逻辑公式必须是文本。');
  if (source.length > LIMITS.formulaLength) throw new LogicError(`每条公式最多 ${LIMITS.formulaLength} 个字符。`);
  const tokens = [];
  let i = 0;
  const aliases = [
    ['<=>', 'op', '↔'], ['<->', 'op', '↔'], ['<-', 'op', '←'], ['->', 'op', '→'], ['=>', 'op', '→'],
    ['⊕', 'op', '⊕'], ['⊻', 'op', '⊕'], ['≢', 'op', '⊕'], ['^', 'op', '⊕'],
    ['↑', 'op', '↑'], ['⊼', 'op', '↑'], ['↓', 'op', '↓'], ['⊽', 'op', '↓'],
    ['←', 'op', '←'], ['⊃', 'op', '→'], ['≡', 'op', '↔'],
    ['&&', 'op', '∧'], ['||', 'op', '∨'], ['==', 'op', '↔'],
    ['↔', 'op', '↔'], ['→', 'op', '→'], ['∨', 'op', '∨'], ['∧', 'op', '∧'],
    ['¬', 'op', '¬'], ['!', 'op', '¬'], ['~', 'op', '¬'],
    ['&', 'op', '∧'], ['|', 'op', '∨'], ['>', 'op', '→'], ['=', 'op', '↔'],
    ['∀', 'quantifier', 'forall'], ['∃', 'quantifier', 'exists'],
    ['(', 'left', '('], [')', 'right', ')'], [',', 'comma', ','],
    ['⊤', 'constant', true], ['⊥', 'constant', false],
  ];
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    const start = i;
    const word = source.slice(i).match(/^(forall|exists)\b/i);
    if (word) {
      tokens.push({ type: 'quantifier', value: word[1].toLowerCase() === 'forall' ? 'forall' : 'exists', position: start });
      i += word[1].length;
      continue;
    }
    const alias = aliases.find(([text]) => source.startsWith(text, i));
    if (alias) {
      const [, type, value] = alias;
      tokens.push({ type, value, position: start });
      i += alias[0].length;
    } else if (/[A-Z]/.test(char)) {
      tokens.push({ type: 'predicate', value: char, position: start });
      i++;
    } else if (/[a-z]/.test(char)) {
      tokens.push({ type: 'term', value: char, position: start });
      i++;
    } else {
      throw new LogicError(`无法识别“${char}”。量词公式请使用 P(x)、∀x、∃x 等写法。`, start);
    }
  }
  tokens.push({ type: 'end', value: null, position: source.length });
  return tokens;
}

export function parse(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const isOp = value => peek().type === 'op' && peek().value === value;
  function term() {
    const token = take();
    if (token.type !== 'term') throw new LogicError('这里需要个体变量或常项（如 x、a）。', token.position);
    return { type: 'term', kind: INDIVIDUAL_VARIABLES.includes(token.value) ? 'variable' : 'constant', name: token.value };
  }
  function primary(depth) {
    const token = take();
    if (token.type === 'quantifier') {
      const variable = term();
      if (variable.kind !== 'variable') throw new LogicError('量词必须约束个体变量，如 ∀x 或 ∃y。', token.position);
      const child = unary(depth + 1);
      return { type: token.value, variable: variable.name, child };
    }
    if (token.type === 'predicate') {
      if (peek().type !== 'left') return { type: 'predicate', name: token.value, args: [] };
      take();
      const args = [];
      if (peek().type === 'right') throw new LogicError('谓词至少需要一个参数；零元命题请直接写 P。', peek().position);
      args.push(term());
      while (peek().type === 'comma') { take(); args.push(term()); }
      if (peek().type !== 'right') throw new LogicError('谓词参数后缺少右括号“)”。', peek().position);
      take();
      return { type: 'predicate', name: token.value, args };
    }
    if (token.type === 'constant') return { type: 'constant', value: token.value };
    if (token.type === 'left') {
      if (peek().type === 'right' || peek().type === 'end') throw new LogicError('括号内不能为空。', peek().position);
      const node = expression(depth + 1);
      if (peek().type !== 'right') throw new LogicError('缺少右括号“)”。', peek().position);
      take();
      return node;
    }
    if (token.type === 'term') throw new LogicError('个体项不能单独作为公式，请写成 P(x) 等谓词公式。', token.position);
    if (token.type === 'end') throw new LogicError('公式尚未完成。', token.position);
    throw new LogicError(`这里需要谓词、量词或左括号，而不是“${token.value}”。`, token.position);
  }
  function unary(depth) {
    if (depth > LIMITS.depth) throw new LogicError('公式嵌套过深，请简化公式。');
    if (isOp('¬')) { take(); return { type: 'not', child: unary(depth + 1) }; }
    return primary(depth);
  }
  const and = depth => {
    let node = unary(depth);
    while (isOp('∧') || isOp('↑')) { const op = take().value; node = { type: BINARY[op], left: node, right: unary(depth) }; }
    return node;
  };
  const or = depth => {
    let node = and(depth);
    while (isOp('∨') || isOp('⊕') || isOp('↓')) { const op = take().value; node = { type: BINARY[op], left: node, right: and(depth) }; }
    return node;
  };
  const implies = depth => {
    let node = or(depth);
    const chain = [];
    while (isOp('→') || isOp('←')) { const op = take().value; chain.push({ op, node: or(depth) }); }
    if (!chain.length) return node;
    if (chain.some(item => item.op !== chain[0].op)) throw new LogicError('混用 → 与 ← 时请加括号。', peek().position);
    if (chain[0].op === '←') {
      for (const item of chain) node = { type: 'reverse', left: node, right: item.node };
      return node;
    }
    let right = chain[chain.length - 1].node;
    for (let i = chain.length - 1; i >= 0; i--) right = { type: 'implies', left: i === 0 ? node : chain[i - 1].node, right };
    return right;
  };
  const expression = depth => {
    let node = implies(depth);
    while (isOp('↔')) { take(); node = { type: 'iff', left: node, right: implies(depth) }; }
    return node;
  };
  if (peek().type === 'end') throw new LogicError('请先填写逻辑公式。', 0);
  const ast = expression(0);
  if (peek().type !== 'end') {
    const token = peek();
    throw new LogicError(token.type === 'right' ? '多余的右括号“)”。' : `“${token.value}”前需要逻辑连接词。`, token.position);
  }
  return describe(ast);
}

export function describe(ast) {
  const predicates = new Map();
  const constants = new Set();
  const variables = new Set();
  walk(ast, node => {
    if (node.type === 'predicate') {
      const previous = predicates.get(node.name);
      if (previous !== undefined && previous !== node.args.length) throw new LogicError(`谓词 ${node.name} 的参数个数不一致。`);
      predicates.set(node.name, node.args.length);
      for (const arg of node.args) (arg.kind === 'constant' ? constants : variables).add(arg.name);
    }
  });
  return { ast, formatted: format(ast), predicates, constants: [...constants].sort(), individualVariables: [...variables].sort(), freeVariables: [...freeVariables(ast)].sort() };
}

function walk(node, visit) {
  visit(node);
  if (node.type === 'not') walk(node.child, visit);
  else if (node.type === 'forall' || node.type === 'exists') walk(node.child, visit);
  else if (node.left) { walk(node.left, visit); walk(node.right, visit); }
}

export function freeVariables(node) {
  if (node.type === 'predicate') return new Set(node.args.filter(arg => arg.kind === 'variable').map(arg => arg.name));
  if (node.type === 'constant') return new Set();
  if (node.type === 'not') return freeVariables(node.child);
  if (node.type === 'forall' || node.type === 'exists') {
    const free = freeVariables(node.child);
    free.delete(node.variable);
    return free;
  }
  return new Set([...freeVariables(node.left), ...freeVariables(node.right)]);
}

export function format(node, parentPrecedence = -1) {
  const precedence = PRECEDENCE[node.type];
  let text;
  if (node.type === 'predicate') text = node.args.length ? `${node.name}(${node.args.map(arg => arg.name).join(', ')})` : node.name;
  else if (node.type === 'constant') text = node.value ? '⊤' : '⊥';
  else if (node.type === 'not') text = `¬${format(node.child, precedence)}`;
  else if (node.type === 'forall' || node.type === 'exists') text = `${QUANTIFIER[node.type]}${node.variable} ${format(node.child, precedence)}`;
  else {
    const strict = ['implies', 'reverse', 'iff', 'xor', 'nand', 'nor'].includes(node.type);
    const minimum = child => precedence + (strict || (child.type !== node.type && PRECEDENCE[child.type] === precedence) ? 1 : 0);
    text = `${format(node.left, minimum(node.left))} ${DISPLAY_OP[node.type]} ${format(node.right, minimum(node.right))}`;
  }
  return precedence < parentPrecedence ? `(${text})` : text;
}

export function alphaKey(node, env = new Map(), depth = 0) {
  if (node.type === 'predicate') return `${node.name}/${node.args.length}(${node.args.map(arg => arg.kind === 'variable' ? (env.has(arg.name) ? `b${env.get(arg.name)}` : `f${arg.name}`) : `c${arg.name}`).join(',')})`;
  if (node.type === 'constant') return node.value ? '⊤' : '⊥';
  if (node.type === 'not') return `¬(${alphaKey(node.child, env, depth)})`;
  if (node.type === 'forall' || node.type === 'exists') {
    const next = new Map(env);
    next.set(node.variable, depth);
    return `${QUANTIFIER[node.type]}${depth}.${alphaKey(node.child, next, depth + 1)}`;
  }
  return `(${alphaKey(node.left, env, depth)}${DISPLAY_OP[node.type]}${alphaKey(node.right, env, depth)})`;
}
export const equal = (a, b) => alphaKey(a) === alphaKey(b);

function freshVariable(forbidden) {
  for (const name of [...INDIVIDUAL_VARIABLES, 'x1', 'x2', 'x3', 'x4', 'x5', 'x6']) if (!forbidden.has(name)) return name;
  let i = 7;
  while (forbidden.has(`x${i}`)) i++;
  return `x${i}`;
}

export function substituteTerm(node, variable, replacement) {
  if (node.type === 'predicate') return { ...node, args: node.args.map(arg => arg.kind === 'variable' && arg.name === variable ? replacement : arg) };
  if (node.type === 'constant') return node;
  if (node.type === 'not') return { ...node, child: substituteTerm(node.child, variable, replacement) };
  if (node.type === 'forall' || node.type === 'exists') {
    if (node.variable === variable) return node;
    if (replacement.kind === 'variable' && replacement.name === node.variable) {
      const forbidden = new Set([...freeVariables(node.child), replacement.name, variable]);
      const renamed = freshVariable(forbidden);
      const renamedChild = substituteTerm(node.child, node.variable, { type: 'term', kind: 'variable', name: renamed });
      return { ...node, variable: renamed, child: substituteTerm(renamedChild, variable, replacement) };
    }
    return { ...node, child: substituteTerm(node.child, variable, replacement) };
  }
  return { ...node, left: substituteTerm(node.left, variable, replacement), right: substituteTerm(node.right, variable, replacement) };
}

export function translate(node, meanings = {}, parentPrecedence = -1) {
  const precedence = PRECEDENCE[node.type];
  let text;
  if (node.type === 'predicate') {
    const meaning = meanings[node.name];
    if (!node.args.length) text = typeof meaning === 'string' && meaning.trim() ? meaning.trim() : node.name;
    else {
      const args = node.args.map(arg => arg.name).join('、');
      text = typeof meaning === 'string' && meaning.trim() ? `${args}满足“${meaning.trim()}”` : `${args}满足谓词 ${node.name}`;
    }
  } else if (node.type === 'constant') text = node.value ? '真' : '假';
  else if (node.type === 'not') {
    const child = translate(node.child, meanings);
    text = ['predicate', 'constant'].includes(node.child.type) ? `并非${child}` : `并非（${child}）`;
  } else if (node.type === 'forall' || node.type === 'exists') {
    const child = translate(node.child, meanings, precedence);
    text = node.type === 'forall' ? `对任意 ${node.variable}，${child}` : `存在 ${node.variable}，使得${child}`;
  } else {
    const strict = ['implies', 'reverse', 'iff', 'xor', 'nand', 'nor'].includes(node.type);
    const childPrecedence = precedence + (strict ? 1 : 0);
    const left = translate(node.left, meanings, node.type === 'nand' ? 3 : node.type === 'nor' ? 2 : childPrecedence);
    const right = translate(node.right, meanings, node.type === 'nand' ? 4 : node.type === 'nor' ? 3 : childPrecedence);
    if (node.type === 'implies') text = `如果${left}，那么${right}`;
    else if (node.type === 'reverse') text = `如果${right}，那么${left}`;
    else if (node.type === 'iff') text = `${left}，当且仅当${right}`;
    else if (node.type === 'xor') text = `要么${left}，要么${right}（二者不同时成立）`;
    else if (node.type === 'nand') text = `并非（${left}，并且${right}）`;
    else if (node.type === 'nor') text = `并非（${left}，或者${right}）`;
    else text = `${left}，${node.type === 'and' ? '并且' : '或者'}${right}`;
  }
  return precedence < parentPrecedence ? `（${text}）` : text;
}

export function collectTerms(nodes) {
  const terms = new Map();
  for (const node of nodes) walk(node, current => {
    if (current.type === 'predicate') for (const arg of current.args) terms.set(`${arg.kind}:${arg.name}`, arg);
  });
  return [...terms.values()];
}

export function freshConstant(forbidden = new Set()) {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't'];
  for (const name of names) if (!forbidden.has(name) && !INDIVIDUAL_VARIABLES.includes(name)) return { type: 'term', kind: 'constant', name };
  let index = 1;
  while (forbidden.has(`c${index}`)) index++;
  return { type: 'term', kind: 'constant', name: `c${index}` };
}
