/**
 * Logic Lab's small, dependency-free classical propositional logic engine.
 * No eval, Function constructor, or browser APIs are used.
 */
export const LIMITS = Object.freeze({ variables: 10, premises: 8, formulaLength: 500, depth: 64 });
export const DEFAULT_MEANINGS = Object.freeze({
  P: '今天下雨', Q: '地面湿润', R: '我带了雨伞', S: '航班准点',
  A: '开关开启', B: '指示灯亮起', C: '门已锁好', D: '警报响起',
});

const PRECEDENCE = Object.freeze({ definition: 0, iff: 0, implies: 1, reverse: 1, or: 2, xor: 2, nor: 2, and: 3, nand: 3, not: 4, variable: 5, constant: 5 });
const BINARY = { '↔': 'iff', '→': 'implies', '←': 'reverse', '∨': 'or', '⊕': 'xor', '↓': 'nor', '∧': 'and', '↑': 'nand' };
const DISPLAY_OP = { definition: '≝', iff: '↔', implies: '→', reverse: '←', or: '∨', xor: '⊕', nor: '↓', and: '∧', nand: '↑' };

export class LogicError extends Error {
  constructor(message, position = null) {
    super(message);
    this.name = 'LogicError';
    this.position = position;
  }
}

function tokenize(source) {
  if (typeof source !== 'string') throw new LogicError('逻辑公式必须是文本。');
  if (source.length > LIMITS.formulaLength) throw new LogicError(`每条公式最多 ${LIMITS.formulaLength} 个字符。`);
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    const start = i;
    let type, value;
    const aliases = [
      ['<=>', 'op', '↔'], ['<->', 'op', '↔'], ['<-', 'op', '←'], ['->', 'op', '→'], ['=>', 'op', '→'],
      ['⊕', 'op', '⊕'], ['⊻', 'op', '⊕'], ['≢', 'op', '⊕'], ['^', 'op', '⊕'],
      ['↑', 'op', '↑'], ['⊼', 'op', '↑'], ['↓', 'op', '↓'], ['⊽', 'op', '↓'],
      ['←', 'op', '←'], ['⊃', 'op', '→'], ['≡', 'op', '↔'],
      ['≝', 'op', '≝'], ['≔', 'op', '≝'], ['≜', 'op', '≝'], [':=', 'op', '≝'], ['=def', 'op', '≝'], ['=df', 'op', '≝'],
      ['&&', 'op', '∧'], ['||', 'op', '∨'],
      ['↔', 'op', '↔'], ['→', 'op', '→'], ['∨', 'op', '∨'], ['∧', 'op', '∧'],
      ['¬', 'op', '¬'], ['!', 'op', '¬'], ['~', 'op', '¬'],
      ['&', 'op', '∧'], ['|', 'op', '∨'], ['>', 'op', '→'],
      ['(', 'left', '('], [')', 'right', ')'], ['⊤', 'constant', true], ['⊥', 'constant', false],
    ];
    const alias = aliases.find(([text]) => source.startsWith(text, i));
    if (alias) {
      [, type, value] = alias;
      i += alias[0].length;
    } else if (/[A-Za-z]/.test(char)) {
      type = 'variable'; value = char.toUpperCase(); i++;
    } else {
      throw new LogicError(`无法识别“${char}”。请使用单个英文字母和面板中的逻辑符号。`, start);
    }
    tokens.push({ type, value, position: start });
  }
  tokens.push({ type: 'end', value: null, position: source.length });
  return tokens;
}

/** Parse with precedence ¬ > ∧/↑ > ∨/⊕/↓ > →/← > ↔. Use parentheses for mixed arrows. */
export function parse(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const isOp = (value) => peek().type === 'op' && peek().value === value;
  function expectOperand(token = peek()) {
    if (token.type === 'end') throw new LogicError('公式尚未完成：这里还需要一个命题变量。', token.position);
    throw new LogicError(`“${token.value}”前缺少命题变量，或连接词使用有误。`, token.position);
  }
  function primary(depth) {
    const token = take();
    if (token.type === 'variable') return { type: 'variable', name: token.value };
    if (token.type === 'constant') return { type: 'constant', value: token.value };
    if (token.type === 'left') {
      if (isOp(')') || peek().type === 'end') throw new LogicError('括号内不能为空。', peek().position);
      const node = expression(depth + 1);
      if (peek().type !== 'right') throw new LogicError('缺少右括号“)”。', peek().position);
      take();
      return node;
    }
    if (token.type === 'end') expectOperand(token);
    throw new LogicError(`这里需要命题变量或左括号，而不是“${token.value}”。`, token.position);
  }
  function unary(depth) {
    if (depth > LIMITS.depth) throw new LogicError('公式嵌套过深，请简化公式。');
    if (isOp('¬')) { take(); return { type: 'not', child: unary(depth + 1) }; }
    return primary(depth);
  }
  function binary(depth, operator, next) {
    let node = next(depth);
    while (isOp(operator)) {
      take();
      const right = operator === '→' ? binary(depth, operator, next) : next(depth);
      node = { type: BINARY[operator], left: node, right };
    }
    return node;
  }
  const and = (depth) => {
    let node = unary(depth);
    while (isOp('∧') || isOp('↑')) { const op = take().value; node = { type: BINARY[op], left: node, right: unary(depth) }; }
    return node;
  };
  const or = (depth) => {
    let node = and(depth);
    while (isOp('∨') || isOp('⊕') || isOp('↓')) { const op = take().value; node = { type: BINARY[op], left: node, right: and(depth) }; }
    return node;
  };
  const implies = (depth) => {
    let node = or(depth);
    const chain = [];
    while (isOp('→') || isOp('←')) { const op = take().value; chain.push({ op, node: or(depth) }); }
    if (!chain.length) return node;
    if (chain.some(item => item.op !== chain[0].op)) throw new LogicError('混用 → 与 ← 时请加括号，明确结合方向。', peek().position);
    if (chain[0].op === '←') {
      for (const item of chain) node = { type: 'reverse', left: node, right: item.node };
      return node;
    }
    let right = chain[chain.length - 1].node;
    for (let i = chain.length - 1; i >= 0; i--) right = { type: 'implies', left: i === 0 ? node : chain[i - 1].node, right };
    return right;
  };
  const expression = (depth) => {
    let node = implies(depth);
    if (isOp('≝')) {
      take();
      node = { type: 'definition', left: node, right: implies(depth) };
      if (isOp('≝') || isOp('↔')) throw new LogicError('定义符号不应与 ↔ 或另一个 ≝ 连写，请加括号。', peek().position);
      return node;
    }
    while (isOp('↔')) {
      take();
      node = { type: 'iff', left: node, right: implies(depth) };
      if (isOp('≝')) throw new LogicError('定义符号不应与 ↔ 连写，请加括号。', peek().position);
    }
    return node;
  };
  if (peek().type === 'end') throw new LogicError('请先填写逻辑公式。', 0);
  const ast = expression(0);
  if (peek().type !== 'end') {
    const token = peek();
    const message = token.type === 'right'
      ? '多余的右括号“)”，请检查括号是否配对。'
      : `“${token.value}”前需要逻辑连接词；两个命题不能直接相邻。`;
    throw new LogicError(message, token.position);
  }
  const variables = [...new Set(collectVariables(ast))].sort();
  return { ast, variables, formatted: format(ast) };
}

export function collectVariables(node) {
  if (node.type === 'variable') return [node.name];
  if (node.type === 'constant') return [];
  if (node.type === 'not') return collectVariables(node.child);
  return [...collectVariables(node.left), ...collectVariables(node.right)];
}

export function format(node, parentPrecedence = -1) {
  const precedence = PRECEDENCE[node.type];
  let text;
  if (node.type === 'variable') text = node.name;
  else if (node.type === 'constant') text = node.value ? '⊤' : '⊥';
  else if (node.type === 'not') text = `¬${format(node.child, precedence)}`;
  else {
    const strict = ['implies', 'reverse', 'iff', 'definition', 'xor', 'nand', 'nor'].includes(node.type);
    const minimum = child => precedence + (strict || (child.type !== node.type && PRECEDENCE[child.type] === precedence) ? 1 : 0);
    text = `${format(node.left, minimum(node.left))} ${DISPLAY_OP[node.type]} ${format(node.right, minimum(node.right))}`;
  }
  return precedence < parentPrecedence ? `(${text})` : text;
}

export function evaluate(node, assignment) {
  switch (node.type) {
    case 'variable':
      if (typeof assignment[node.name] !== 'boolean') throw new LogicError(`缺少变量 ${node.name} 的真假值。`);
      return assignment[node.name];
    case 'constant': return node.value;
    case 'not': return !evaluate(node.child, assignment);
    case 'and': return evaluate(node.left, assignment) && evaluate(node.right, assignment);
    case 'or': return evaluate(node.left, assignment) || evaluate(node.right, assignment);
    case 'implies': return !evaluate(node.left, assignment) || evaluate(node.right, assignment);
    case 'iff': return evaluate(node.left, assignment) === evaluate(node.right, assignment);
    case 'definition': return evaluate(node.left, assignment) === evaluate(node.right, assignment);
    case 'reverse': return !evaluate(node.right, assignment) || evaluate(node.left, assignment);
    case 'xor': return evaluate(node.left, assignment) !== evaluate(node.right, assignment);
    case 'nand': return !(evaluate(node.left, assignment) && evaluate(node.right, assignment));
    case 'nor': return !(evaluate(node.left, assignment) || evaluate(node.right, assignment));
    default: throw new LogicError('未知的公式节点。');
  }
}

/** Translate structurally, preserving scope with Chinese parentheses. */
export function translate(node, meanings = {}, parentPrecedence = -1) {
  const precedence = PRECEDENCE[node.type];
  let text;
  if (node.type === 'variable') {
    const meaning = meanings[node.name];
    text = typeof meaning === 'string' && meaning.trim() ? meaning.trim() : node.name;
  } else if (node.type === 'constant') text = node.value ? '真' : '假';
  else if (node.type === 'not') {
    const child = translate(node.child, meanings);
    text = node.child.type === 'variable' || node.child.type === 'constant'
      ? `并非${child}` : `并非（${child}）`;
  } else {
    const strict = ['implies', 'reverse', 'iff', 'definition', 'xor', 'nand', 'nor'].includes(node.type);
    const childPrecedence = precedence + (strict ? 1 : 0);
    const left = translate(node.left, meanings, node.type === 'nand' ? 3 : node.type === 'nor' ? 2 : childPrecedence);
    const right = translate(node.right, meanings, node.type === 'nand' ? 4 : node.type === 'nor' ? 3 : childPrecedence);
    if (node.type === 'implies') text = `如果${left}，那么${right}`;
    else if (node.type === 'reverse') text = `如果${right}，那么${left}`;
    else if (node.type === 'iff') text = `${left}，当且仅当${right}`;
    else if (node.type === 'definition') {
      const scopedRight = ['and', 'or', 'implies', 'reverse', 'iff', 'definition', 'xor', 'nand', 'nor', 'forall', 'exists'].includes(node.right.type) ? `（${right}）` : right;
      text = `${left}，按定义当且仅当${scopedRight}`;
    }
    else if (node.type === 'xor') text = `要么${left}，要么${right}（二者不同时成立）`;
    else if (node.type === 'nand') text = `并非（${left}，并且${right}）`;
    else if (node.type === 'nor') text = `并非（${left}，或者${right}）`;
    else text = `${left}，${node.type === 'and' ? '并且' : '或者'}${right}`;
  }
  return precedence < parentPrecedence ? `（${text}）` : text;
}

/**
 * An argument is valid iff no valuation makes every premise true and the
 * conclusion false. With no premises this correctly reduces to tautology.
 */
export function analyze({ premises = [], conclusion = '' } = {}) {
  if (!Array.isArray(premises) || premises.length > LIMITS.premises) {
    throw new LogicError(`前提数量不能超过 ${LIMITS.premises} 条。`);
  }
  const parsedPremises = premises.map((source, index) => {
    try { return parse(source); }
    catch (error) { throw new LogicError(`前提 ${index + 1}：${error.message}`, error.position); }
  });
  let parsedConclusion;
  try { parsedConclusion = parse(conclusion); }
  catch (error) { throw new LogicError(`结论：${error.message}`, error.position); }
  const variables = [...new Set([...parsedPremises.flatMap(p => p.variables), ...parsedConclusion.variables])].sort();
  if (variables.length > LIMITS.variables) {
    throw new LogicError(`当前使用 ${variables.length} 个变量；最多支持 ${LIMITS.variables} 个，以保证真值表计算流畅。`);
  }
  const count = 2 ** variables.length;
  const rows = [];
  for (let mask = 0; mask < count; mask++) {
    const values = Object.fromEntries(variables.map((name, index) => [name, ((count - 1 - mask) & (1 << (variables.length - 1 - index))) !== 0]));
    const premiseValues = parsedPremises.map(p => evaluate(p.ast, values));
    const conclusionValue = evaluate(parsedConclusion.ast, values);
    const allPremisesTrue = premiseValues.every(Boolean);
    rows.push({ values, premiseValues, conclusionValue, allPremisesTrue, counterexample: allPremisesTrue && !conclusionValue });
  }
  const counterexamples = rows.filter(row => row.counterexample);
  const criticalRows = rows.filter(row => row.allPremisesTrue);
  return {
    valid: counterexamples.length === 0, variables, rows, counterexamples, criticalRows,
    premises: parsedPremises, conclusion: parsedConclusion,
    contradictoryPremises: parsedPremises.length > 0 && criticalRows.length === 0,
    tautologicalConclusion: rows.every(row => row.conclusionValue),
    conditional: format({ type: 'implies', left: parsedPremises.reduce((left, p) => left ? { type: 'and', left, right: p.ast } : p.ast, null) || { type: 'constant', value: true }, right: parsedConclusion.ast }),
  };
}
