/**
 * Whole-argument LLM exploration, with a separate, deterministic review step.
 * The model chooses its explanation and may propose a counterexample; only this
 * module's evaluation can turn that proposal into a logical refutation.
 */
import { evaluate, LIMITS } from './logic.js';
import { describe } from './fol.js';
import { evaluateFormula } from './countermodel.js';

export const ARGUMENT_LIMITS = Object.freeze({ domain: 4, tuples: 256, explanation: 6000 });
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = (value, size) => Number.isInteger(value) && value >= 0 && value < size;

function relevantMeanings(result, meanings = {}) {
  if (result.kind !== 'propositional') return {};
  return Object.fromEntries(result.variables.map(name => [name, meanings[name]?.trim() || '']).filter(([, value]) => value));
}

export function argumentSignature(result) {
  if (result.kind === 'propositional') return { variables: [...result.variables] };
  const predicates = new Map();
  const constants = new Set();
  const free = new Set();
  for (const ast of [...result.folPremises, result.folConclusion]) {
    const info = describe(ast);
    for (const [name, arity] of info.predicates) {
      if (predicates.has(name) && predicates.get(name) !== arity) throw new Error(`谓词 ${name} 的参数个数不一致。`);
      predicates.set(name, arity);
    }
    for (const name of info.constants) constants.add(name);
    for (const name of info.freeVariables) free.add(name);
  }
  return {
    predicates: [...predicates].map(([name, arity]) => ({ name, arity })),
    constants: [...constants].sort(),
    freeVariables: [...free].sort(),
  };
}

/** Deliberately excludes truth tables, proof-search state, credentials and old answers. */
export function buildArgumentPayload(result, meanings = {}) {
  if (!result || !['propositional', 'first-order'].includes(result.kind)) throw new Error('请先验证前提和结论的语法。');
  const premises = result.premises.map(premise => premise.formatted);
  const conclusion = result.conclusion.formatted;
  if (premises.length > LIMITS.premises || [...premises, conclusion].some(text => typeof text !== 'string' || !text || text.length > LIMITS.formulaLength)) {
    throw new Error('论证超出可发送的长度限制。');
  }
  return {
    mode: 'argument',
    kind: result.kind,
    logic: 'classical; non-empty domains; rigid equality; definitions are biconditionals',
    argument: { premises, conclusion },
    signature: argumentSignature(result),
    optionalMeaningHints: relevantMeanings(result, meanings),
    referenceVerdict: { valid: result.valid, source: 'independent local engine', note: '仅供独立参考；模型自行组织解释，候选反例随后由程序逐条求值。' },
  };
}

export function isArgumentPayload(payload) {
  if (!isRecord(payload) || payload.mode !== 'argument' || !['propositional', 'first-order'].includes(payload.kind)) return false;
  const argument = payload.argument;
  return isRecord(argument) && Array.isArray(argument.premises) && argument.premises.length <= LIMITS.premises
    && typeof argument.conclusion === 'string' && argument.conclusion.length > 0 && argument.conclusion.length <= LIMITS.formulaLength
    && [...argument.premises, argument.conclusion].every(text => typeof text === 'string' && text.length > 0 && text.length <= LIMITS.formulaLength);
}

/** Accept fenced JSON when available; ordinary prose remains useful but is never a proof. */
export function parseArgumentResponse(value) {
  if (typeof value !== 'string') return { explanation: '', counterexample: null, structured: false };
  let text = value.replace(/\u0000/g, '').trim().slice(0, ARGUMENT_LIMITS.explanation);
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (!isRecord(data) || !hasOwn(data, 'explanation')) continue;
      if (typeof data.explanation !== 'string') continue;
      return {
        explanation: data.explanation.replace(/\u0000/g, '').trim().slice(0, ARGUMENT_LIMITS.explanation),
        counterexample: hasOwn(data, 'counterexample') ? data.counterexample : null,
        structured: true,
      };
    } catch { /* Try a fenced/embedded object, then retain plain prose. */ }
  }
  return { explanation: text, counterexample: null, structured: false };
}

function reviewBase(status, message) {
  return { status, message, premiseValues: [], conclusionValue: null, values: null, model: null };
}
function exactKeys(object, keys) {
  return isRecord(object) && Object.keys(object).length === keys.length && keys.every(key => hasOwn(object, key) && SAFE_NAME.test(key));
}
function truthDetails(result, premiseValues, conclusionValue) {
  const failed = premiseValues.map((value, index) => value ? null : `前提 ${index + 1} 为假`).filter(Boolean);
  if (conclusionValue) failed.push('结论为真');
  return failed.length ? `逐条求值后，${failed.join('，')}；不满足“前提全真、结论为假”。` : '逐条求值后，全部前提为真，结论为假。';
}

function verifyValuation(result, candidate) {
  if (!exactKeys(candidate.values, result.variables) || !result.variables.every(name => typeof candidate.values[name] === 'boolean')) {
    return reviewBase('invalid', `赋值必须恰好包含 ${result.variables.join('、') || '全部所需变量'}，且每个值只能是 true 或 false。`);
  }
  const values = Object.fromEntries(result.variables.map(name => [name, candidate.values[name]]));
  const premiseValues = result.premises.map(premise => evaluate(premise.ast, values));
  const conclusionValue = evaluate(result.conclusion.ast, values);
  const ok = premiseValues.every(Boolean) && !conclusionValue;
  return { ...reviewBase(ok ? 'verified' : 'rejected', truthDetails(result, premiseValues, conclusionValue)), premiseValues, conclusionValue, values };
}

function verifyFiniteModel(result, candidate) {
  const size = candidate.domainSize;
  if (!Number.isInteger(size) || size < 1 || size > ARGUMENT_LIMITS.domain) return reviewBase('invalid', `有限模型论域必须是 1–${ARGUMENT_LIMITS.domain} 个对象。`);
  const sig = argumentSignature(result);
  if (!exactKeys(candidate.constants, sig.constants) || !sig.constants.every(name => isIndex(candidate.constants[name], size))) {
    return reviewBase('invalid', '常项解释必须恰好覆盖公式中的全部常项，并指向论域内的对象编号。');
  }
  if (!exactKeys(candidate.assignment, sig.freeVariables) || !sig.freeVariables.every(name => isIndex(candidate.assignment[name], size))) {
    return reviewBase('invalid', '自由变量赋值必须恰好覆盖公式中的自由变量，并指向论域内的对象编号。');
  }
  const names = sig.predicates.map(predicate => predicate.name);
  if (!exactKeys(candidate.predicates, names)) return reviewBase('invalid', '谓词解释必须恰好覆盖公式中的全部谓词，不能新增或遗漏。');
  const predicates = {};
  let total = 0;
  for (const { name, arity } of sig.predicates) {
    const tuples = candidate.predicates[name];
    if (!Array.isArray(tuples) || tuples.length > ARGUMENT_LIMITS.tuples) return reviewBase('invalid', `谓词 ${name} 必须是有界的元组数组。`);
    const set = new Set();
    for (const tuple of tuples) {
      if (!Array.isArray(tuple) || tuple.length !== arity || !tuple.every(value => isIndex(value, size))) {
        return reviewBase('invalid', `谓词 ${name} 的每个元组必须有 ${arity} 个论域内编号。`);
      }
      set.add(tuple.join(','));
      if (++total > ARGUMENT_LIMITS.tuples) return reviewBase('invalid', '候选模型过大，已停止复核。');
    }
    predicates[name] = set;
  }
  const model = {
    domain: Array.from({ length: size }, (_, index) => index),
    constants: Object.fromEntries(sig.constants.map(name => [name, candidate.constants[name]])),
    assignment: Object.fromEntries(sig.freeVariables.map(name => [name, candidate.assignment[name]])),
    predicates,
  };
  const premiseValues = result.folPremises.map(ast => evaluateFormula(ast, model, model.assignment));
  const conclusionValue = evaluateFormula(result.folConclusion, model, model.assignment);
  const ok = premiseValues.every(Boolean) && !conclusionValue;
  return { ...reviewBase(ok ? 'verified' : 'rejected', truthDetails(result, premiseValues, conclusionValue)), premiseValues, conclusionValue, model };
}

/** No model-authored verdict, HTML, code or formula is executed here. */
export function verifyCounterexample(result, candidate) {
  if (!result) return reviewBase('invalid', '没有可复核的当前论证。');
  if (candidate === null || candidate === undefined) return reviewBase('missing', '模型没有给出可复核的候选反例；文字解释不等于无效性证明。');
  if (!isRecord(candidate)) return reviewBase('invalid', '候选反例必须是结构化赋值或有限模型。');
  try {
    if (result.kind === 'propositional') {
      if (candidate.type !== 'valuation' || !exactKeys(candidate, ['type', 'values'])) return reviewBase('invalid', '命题反例需要 type 为 valuation 的完整真假赋值，且不能附加其他字段。');
      return verifyValuation(result, candidate);
    }
    if (candidate.type !== 'finite-model' || !exactKeys(candidate, ['type', 'domainSize', 'constants', 'assignment', 'predicates'])) return reviewBase('invalid', '一阶反例需要 type 为 finite-model 的完整有限模型，且不能附加其他字段。');
    return verifyFiniteModel(result, candidate);
  } catch (error) {
    return reviewBase('invalid', `候选反例未能通过结构或求值检查：${String(error?.message || error).slice(0, 180)}`);
  }
}
