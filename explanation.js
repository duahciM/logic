import { translate } from './logic.js';
import { translate as translateFol } from './fol.js';
import { describeModel } from './countermodel.js';

/** Ground every sentence in an actual counterexample; never infer real-world absurdity. */
export function describeCounterexample(result, meanings = {}) {
  if (!result || result.valid !== false || !result.counterexamples?.length) return null;
  const row = result.counterexamples[0];
  const sentence = node => translate(node, meanings);
  const premises = result.premises.map(p => sentence(p.ast));
  const conclusion = sentence(result.conclusion.ast);
  const assignments = result.variables.map(name => ({
    name, value: row.values[name], meaning: meanings[name]?.trim() || name,
    text: `${name}（${meanings[name]?.trim() || name}）为${row.values[name] ? '真' : '假'}`,
  }));
  const premiseText = premises.length ? premises.map(text => `“${text}”`).join('和') : '没有前提';
  const narrative = premises.length
    ? `可以设想这样一个反例：${assignments.map(item => item.text).join('，')}。在这个设定下，前提${premiseText}全部成立，而结论“${conclusion}”不成立。不合理的不是这些事实本身，而是认为“前提成立，结论就必然成立”的这一步：这个反例已经说明，前提并没有把结论保证到底。`
    : `可以设想：${assignments.map(item => item.text).join('，')}。此时结论“${conclusion}”为假，因此它不是在所有情况下都成立。没有前提时，不能把一个偶然成立的命题当作必然结论。`;
  return {
    valid: false, premises, conclusion, assignments, narrative,
    counterexample: { values: row.values, premiseValues: row.premiseValues, conclusionValue: row.conclusionValue },
  };
}

export function describeFirstOrderCountermodel(result, meanings = {}) {
  if (!result || result.valid !== false || !result.countermodel) return null;
  const model = result.countermodel;
  const description = describeModel(model);
  const premises = result.premises.map(premise => translateFol(premise.ast, meanings));
  const conclusion = translateFol(result.conclusion.ast, meanings);
  const parts = [`论域包含 ${model.domain.length} 个对象：${description.elements}`];
  if (description.predicates.length) parts.push(`谓词解释：${description.predicates.join('；')}`);
  if (description.constants.length) parts.push(`常项解释：${description.constants.join('，')}`);
  if (description.assignment.length) parts.push(`自由变量赋值：${description.assignment.join('，')}`);
  const premiseText = premises.length ? premises.map(text => `“${text}”`).join('和') : '没有前提';
  const narrative = `可以设想这样一个有限反例模型：${parts.join('。')}。在这个解释下，前提${premiseText}全部为真，而结论“${conclusion}”为假。不合理的不是这些对象或谓词解释本身，而是认为“只要前提成立，结论就必然成立”的这一步：这个模型已经说明，前提并没有把结论保证到底。`;
  return { valid: false, premises, conclusion, narrative, model: description, counterexample: { domainSize: model.domain.length } };
}

export function explanationKey(result, meanings) {
  if (!result || result.valid !== false) return '';
  if (result.kind === 'first-order') {
    return JSON.stringify({ premises: result.premises.map(p => p.formatted), conclusion: result.conclusion.formatted, meanings, model: describeModel(result.countermodel) });
  }
  return JSON.stringify({ premises: result.premises.map(p => p.formatted), conclusion: result.conclusion.formatted, meanings, values: result.counterexamples[0].values });
}
