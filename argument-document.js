/** Deterministic, offline export of the current argument and its evidence. */
import { proofToText } from './natural-deduction.js';
import { describeModel } from './countermodel.js';
import { describeCounterexample, describeFirstOrderCountermodel } from './explanation.js';
import { translate } from './logic.js';
import { translate as translateFol } from './fol.js';

export const DOCUMENT_FORMATS = Object.freeze({
  markdown: { extension: 'md', mime: 'text/markdown;charset=utf-8' },
  html: { extension: 'html', mime: 'text/html;charset=utf-8' },
  text: { extension: 'txt', mime: 'text/plain;charset=utf-8' },
});

export function verdictLabel(result) {
  return result?.valid === true ? '有效' : result?.valid === false ? '无效' : '尚未判定';
}
export function kindLabel(result) {
  return result?.kind === 'first-order' ? '一阶逻辑（含等词，非空论域）' : '命题逻辑';
}
export function truthTableDimensions(result) {
  if (result?.kind !== 'propositional') return null;
  const rows = result.rows.length;
  const columns = 1 + result.variables.length + result.premises.length + 2;
  return { rows, columns, variables: result.variables.length, premises: result.premises.length };
}
export function truthTableSizeText(result) {
  const size = truthTableDimensions(result);
  if (!size) return '一阶逻辑不生成命题真值表；使用自然演绎证明或有限反例模型。';
  return `${size.rows} 行 × ${size.columns} 列（${size.variables} 个命题变量，${size.premises} 条前提；行数 = 2^变量数）`;
}
function sentence(result, ast, meanings) {
  return result.kind === 'first-order' ? translateFol(ast, meanings) : translate(ast, meanings);
}
function timestamp(now) {
  return now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
export function documentFilename(result, format = 'markdown', now = new Date()) {
  const meta = DOCUMENT_FORMATS[format] || DOCUMENT_FORMATS.markdown;
  const verdict = result?.valid === true ? 'valid' : result?.valid === false ? 'invalid' : 'undecided';
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `logic-argument-${verdict}-${stamp}.${meta.extension}`;
}
function mdEscape(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function verdictExplanation(result) {
  if (result.valid === true) {
    if (result.kind === 'propositional') {
      const critical = result.criticalRows.length;
      return result.contradictoryPremises
        ? `真值表检查了全部 ${result.rows.length} 行，没有任何一行让所有前提同时为真，因此不存在反例。经典逻辑下这是空真有效，不代表结论在现实中为真。`
        : `真值表检查了全部 ${result.rows.length} 行；其中 ${critical} 行使所有前提为真，这些行的结论全部为真，因此不存在“前提全真、结论为假”的反例。`;
    }
    return '已构造并通过独立规则校验的自然演绎证明，因此论证有效。';
  }
  if (result.valid === false) {
    return result.kind === 'first-order'
      ? `已找到有限反例模型（论域大小 ${result.countermodel.domain.length}）：所有前提为真，结论为假。`
      : `真值表找到 ${result.counterexamples.length} 个反例：所有前提为真，结论为假。`;
  }
  return '有界自然演绎证明搜索未找到证明，有限反例模型搜索也未找到反例。一阶逻辑不可判定；这不等于有效，也不等于无效。';
}
function proofSection(result) {
  if (result.proofSteps?.length) return { title: '自然演绎证明', text: proofToText(result.proofSteps), steps: result.proofSteps };
  if (result.kind === 'propositional' && result.valid === true) {
    return { title: '真值表判定过程', text: verdictExplanation(result), steps: null };
  }
  if (result.countermodel) return { title: '有限反例模型', text: describeFirstOrderCountermodel(result)?.narrative || '', steps: null };
  return { title: '证明搜索状态', text: verdictExplanation(result), steps: null };
}
function counterexampleSection(result, meanings) {
  if (result.valid !== false) return null;
  return result.kind === 'first-order' ? describeFirstOrderCountermodel(result, meanings) : describeCounterexample(result, meanings);
}
function searchSection(result) {
  if (result.kind !== 'first-order') return null;
  const stats = result.proofStats || {};
  const search = result.countermodelSearch || {};
  const lines = [
    `自然演绎搜索节点：${stats.nodes ?? 0} / ${stats.maxNodes ?? '—'}；最大深度：${stats.maxDepth ?? '—'}。`,
    `有限模型搜索最大论域：${search.maxDomain ?? '—'}；${search.found ? '已找到反例模型。' : '未找到反例模型。'}`,
  ];
  if (search.searched?.length) lines.push(`已检查论域：${search.searched.map(item => `${item.size}${item.skipped ? '（跳过）' : ''}`).join('、')}。`);
  if (!result.proofSteps?.length && result.valid !== false) lines.push('未找到自然演绎证明不等于无效；只有显式反例模型才能推翻论证。');
  return lines.join('\n');
}
function truthTableMarkdown(result) {
  if (result.kind !== 'propositional') return '';
  const header = ['#', ...result.variables, ...result.premises.map((_, i) => `前提${i + 1}`), '结论', '结果'];
  const lines = [`| ${header.map(mdEscape).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const [index, row] of result.rows.entries()) {
    const cells = [index + 1, ...result.variables.map(name => row.values[name] ? 'T' : 'F'), ...row.premiseValues.map(v => v ? 'T' : 'F'), row.conclusionValue ? 'T' : 'F', row.counterexample ? '反例' : row.allPremisesTrue ? '成立' : '—'];
    lines.push(`| ${cells.map(mdEscape).join(' | ')} |`);
  }
  return lines.join('\n');
}
function modelMarkdown(result) {
  if (!result.countermodel) return '';
  const model = describeModel(result.countermodel);
  const values = result.countermodelSearch?.premiseValues || [];
  const lines = [`论域：${model.elements}`];
  if (model.constants.length) lines.push(`常项：${model.constants.join('；')}`);
  if (model.assignment.length) lines.push(`自由变量赋值：${model.assignment.join('；')}`);
  if (model.predicates.length) lines.push(`谓词解释：${model.predicates.join('；')}`);
  result.premises.forEach((premise, index) => lines.push(`前提 ${index + 1}：\`${premise.formatted}\` 为 ${values[index] === false ? '假' : '真'}`));
  lines.push(`结论：\`${result.conclusion.formatted}\` 为 假`);
  return lines.join('\n');
}

export function buildMarkdown(result, meanings = {}, options = {}) {
  if (!result) throw new Error('请先验证论证。');
  const now = options.now || new Date();
  const proof = proofSection(result);
  const counterexample = counterexampleSection(result, meanings);
  const lines = [
    '# 前提–结论文档',
    '',
    `- 生成时间：${timestamp(now)}`,
    `- 逻辑类型：${kindLabel(result)}`,
    `- 判定结果：${verdictLabel(result)}`,
    `- 真值表规模：${truthTableSizeText(result)}`,
    '',
    '## 前提',
    '',
  ];
  if (!result.premises.length) lines.push('（无前提）');
  result.premises.forEach((premise, index) => {
    lines.push(`${index + 1}. \`${premise.formatted}\``);
    if (meanings && Object.keys(meanings).length) lines.push(`   - 直译：${sentence(result, premise.ast, meanings)}`);
  });
  lines.push('', '## 结论', '', `\`${result.conclusion.formatted}\``);
  if (meanings && Object.keys(meanings).length) lines.push(`直译：${sentence(result, result.conclusion.ast, meanings)}`);
  lines.push('', '## 判定说明', '', verdictExplanation(result), '', `## ${proof.title}`, '');
  if (proof.steps) lines.push('```text', proof.text, '```');
  else lines.push(proof.text);
  if (result.kind === 'propositional' && result.valid === true && !result.proofSteps?.length) {
    lines.push('', '未生成自然演绎证明步骤：有界证明搜索未找到证明，但真值表已经给出确定性有效判定。下方完整真值表可作为语义证明证书。');
  }
  if (counterexample) lines.push('', '## 反例直译', '', counterexample.narrative);
  if (result.countermodel) lines.push('', '## 反例模型细节', '', modelMarkdown(result));
  const search = searchSection(result);
  if (search) lines.push('', '## 搜索边界', '', search);
  if (result.kind === 'propositional') lines.push('', '## 完整真值表', '', truthTableMarkdown(result));
  lines.push('', '---', '本文档由逻辑工坊在本地生成；有效性以真值表、自然演绎证明或有限反例模型为准。', '');
  return lines.join('\n');
}
function htmlList(items) {
  return `<ul>${items.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}
function truthTableHtml(result) {
  if (result.kind !== 'propositional') return '';
  const header = ['#', ...result.variables, ...result.premises.map((_, i) => `前提${i + 1}`), '结论', '结果'];
  const rows = result.rows.map((row, index) => {
    const cells = [index + 1, ...result.variables.map(name => row.values[name] ? 'T' : 'F'), ...row.premiseValues.map(v => v ? 'T' : 'F'), row.conclusionValue ? 'T' : 'F', row.counterexample ? '反例' : row.allPremisesTrue ? '成立' : '—'];
    return `<tr class="${row.counterexample ? 'counterexample' : row.allPremisesTrue ? 'critical' : ''}">${cells.map(cell => `<td>${htmlEscape(cell)}</td>`).join('')}</tr>`;
  }).join('');
  return `<table><thead><tr>${header.map(cell => `<th>${htmlEscape(cell)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}
export function buildHtml(result, meanings = {}, options = {}) {
  if (!result) throw new Error('请先验证论证。');
  const now = options.now || new Date();
  const proof = proofSection(result);
  const counterexample = counterexampleSection(result, meanings);
  const premises = result.premises.length
    ? `<ol>${result.premises.map(p => `<li><code>${htmlEscape(p.formatted)}</code>${meanings && Object.keys(meanings).length ? `<p>${htmlEscape(sentence(result, p.ast, meanings))}</p>` : ''}</li>`).join('')}</ol>`
    : '<p>（无前提）</p>';
  const proofBody = proof.steps
    ? `<ol class="proof">${proof.steps.map(step => `<li style="margin-left:${Math.min(step.depth, 6) * 18}px"><code>${htmlEscape(step.formatted)}</code> <span>${htmlEscape(step.ruleLabel)}${step.refs.length ? ` [${step.refs.join(', ')}]` : ''}${step.note ? `（${htmlEscape(step.note)}）` : ''}</span></li>`).join('')}</ol>`
    : `<p>${htmlEscape(proof.text).replace(/\n/g, '<br>')}</p>`;
  const search = searchSection(result);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前提–结论文档 · ${htmlEscape(verdictLabel(result))}</title>
<style>body{font-family:system-ui,'Noto Sans SC',sans-serif;max-width:960px;margin:32px auto;padding:0 18px;line-height:1.8;color:#292b40}h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #e9eaf2;padding-bottom:6px}code{font-family:'Cambria Math','Noto Sans Math',serif;background:#f7f5fc;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e9eaf2;padding:6px 8px;text-align:center}th{background:#f5f2fa}.counterexample{background:#fdf1f2}.critical{background:#eff8f3}.proof{list-style:none;padding:0}.proof li{border-bottom:1px solid #f0edf6;padding:6px 0}.meta{color:#666a80;font-size:14px}</style></head><body>
<h1>前提–结论文档</h1>
<p class="meta">生成时间：${htmlEscape(timestamp(now))}<br>逻辑类型：${htmlEscape(kindLabel(result))}<br>判定结果：<strong>${htmlEscape(verdictLabel(result))}</strong><br>真值表规模：${htmlEscape(truthTableSizeText(result))}</p>
<h2>前提</h2>${premises}
<h2>结论</h2><p><code>${htmlEscape(result.conclusion.formatted)}</code></p>${meanings && Object.keys(meanings).length ? `<p>${htmlEscape(sentence(result, result.conclusion.ast, meanings))}</p>` : ''}
<h2>判定说明</h2><p>${htmlEscape(verdictExplanation(result))}</p>
<h2>${htmlEscape(proof.title)}</h2>${proofBody}
${result.kind === 'propositional' && result.valid === true && !result.proofSteps?.length ? '<p>未生成自然演绎证明步骤：有界证明搜索未找到证明，但真值表已经给出确定性有效判定。完整真值表可作为语义证明证书。</p>' : ''}
${counterexample ? `<h2>反例直译</h2><p>${htmlEscape(counterexample.narrative)}</p>` : ''}
${result.countermodel ? `<h2>反例模型细节</h2><p>${htmlEscape(modelMarkdown(result)).replace(/\n/g, '<br>')}</p>` : ''}
${search ? `<h2>搜索边界</h2><p>${htmlEscape(search).replace(/\n/g, '<br>')}</p>` : ''}
${result.kind === 'propositional' ? `<h2>完整真值表</h2>${truthTableHtml(result)}` : ''}
<hr><p class="meta">本文档由逻辑工坊在本地生成；有效性以真值表、自然演绎证明或有限反例模型为准。</p>
</body></html>`;
}
export function buildDocument(result, meanings = {}, format = 'markdown', options = {}) {
  if (!DOCUMENT_FORMATS[format]) throw new Error('未知文档格式。');
  if (!result) throw new Error('请先验证论证。');
  const content = format === 'html' ? buildHtml(result, meanings, options) : buildMarkdown(result, meanings, options);
  return { content, ...DOCUMENT_FORMATS[format], filename: documentFilename(result, format, options.now || new Date()) };
}
