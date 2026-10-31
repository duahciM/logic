import { DEFAULT_MEANINGS, LIMITS } from './logic.js';
import { analyzeArgument, parseFormula } from './argument.js';
import { proofToText } from './natural-deduction.js';
import { describeModel } from './countermodel.js';
import { describeCounterexample, describeFirstOrderCountermodel, explanationKey } from './explanation.js';
import { LocalExplainer } from './llm-client.js';
import { ApiExplainer, API_PRESETS, normalizeApiConfig } from './api-client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORAGE_KEY = 'logic-lab.workspace.v1';
const API_STORAGE_KEY = 'logic-lab.llm-api.v1';
const PAGE_SIZE = 32;
const EXAMPLES = {
  mp: { name: '肯定前件', premises: ['P → Q', 'P'], conclusion: 'Q' },
  mt: { name: '否定后件', premises: ['P → Q', '¬Q'], conclusion: '¬P' },
  hs: { name: '假言三段论', premises: ['P → Q', 'Q → R'], conclusion: 'P → R' },
  ds: { name: '选言三段论', premises: ['P ∨ Q', '¬P'], conclusion: 'Q' },
  cd: { name: '二难推理', premises: ['P → Q', 'R → S', 'P ∨ R'], conclusion: 'Q ∨ S' },
  conj: { name: '合取引入', premises: ['P', 'Q'], conclusion: 'P ∧ Q' },
  explosion: { name: '矛盾前提', premises: ['P', '¬P'], conclusion: 'Q' },
  ac: { name: '肯定后件谬误', premises: ['P → Q', 'Q'], conclusion: 'P' },
  da: { name: '否定前件谬误', premises: ['P → Q', '¬P'], conclusion: '¬Q' },
  xor: { name: '异或选言', premises: ['P ⊕ Q', 'P'], conclusion: '¬Q' },
  nand: { name: '与非德摩根律', premises: ['P ↑ Q'], conclusion: '¬P ∨ ¬Q' },
  'xor-fallacy': { name: '把相容析取当异或', premises: ['P ∨ Q', 'P'], conclusion: '¬Q' },
  'nand-fallacy': { name: '误用与非', premises: ['P ↑ Q'], conclusion: '¬P ∧ ¬Q' },
  'fol-mp': { name: '全称三段论', premises: ['∀x (P(x) → Q(x))', '∀x P(x)'], conclusion: '∀x Q(x)' },
  'fol-exists': { name: '全称到存在', premises: ['∀x P(x)'], conclusion: '∃x P(x)' },
  'fol-exists-and': { name: '存在合取', premises: ['∃x (P(x) ∧ Q(x))'], conclusion: '∃x P(x)' },
  'fol-syllogism': { name: '存在三段论', premises: ['∀x (P(x) → Q(x))', '∃x P(x)'], conclusion: '∃x Q(x)' },
  'fol-not-exists': { name: '量词否定', premises: ['¬∃x P(x)'], conclusion: '∀x ¬P(x)' },
  'fol-order': { name: '量词交换', premises: ['∃x ∀y R(x, y)'], conclusion: '∀y ∃x R(x, y)' },
  'fol-invalid-exists': { name: '存在不能推全称', premises: ['∃x P(x)'], conclusion: '∀x P(x)' },
  'fol-invalid-order': { name: '全称存在不能交换', premises: ['∀x ∃y R(x, y)'], conclusion: '∃y ∀x R(x, y)' },
  'fol-invalid-converse': { name: '肯定后件谓词版', premises: ['∀x (P(x) → Q(x))', '∃x Q(x)'], conclusion: '∃x P(x)' },
  'def-expand': { name: '定义展开', premises: ['P ≝ Q ∧ R', 'Q', 'R'], conclusion: 'P' },
  'def-invalid': { name: '定义不能跳步', premises: ['P ≝ Q → R', 'Q'], conclusion: 'P' },
  'eq-reflexive': { name: '相等自反', premises: [], conclusion: 'a = a' },
  'eq-symmetric': { name: '相等对称', premises: ['a = b'], conclusion: 'b = a' },
  'eq-transitive': { name: '相等传递', premises: ['a = b', 'b = c'], conclusion: 'a = c' },
  'eq-substitute': { name: '等词替换', premises: ['a = b', 'P(a)'], conclusion: 'P(b)' },
  'eq-distinct': { name: '不相等推出存在不同对象', premises: ['a ≠ b'], conclusion: '∃x ∃y x ≠ y' },
  'eq-quantifier': { name: '相等与全称', premises: ['∀x (x = a → P(x))'], conclusion: 'P(a)' },
  'eq-invalid': { name: '无相等不能替换', premises: ['P(a)'], conclusion: 'P(b)' },
};

let nextId = 1;
const makeId = () => `field-${nextId++}`;
const makeField = (value = '') => ({ id: makeId(), value });
const defaultState = () => ({
  premises: EXAMPLES.mp.premises.map(makeField),
  conclusion: makeField(EXAMPLES.mp.conclusion),
  meanings: { ...DEFAULT_MEANINGS }, useMeanings: true, example: 'mp',
});

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.premises) || saved.premises.length > LIMITS.premises) return defaultState();
    const validField = field => field && typeof field.value === 'string' && field.value.length <= LIMITS.formulaLength;
    if (!saved.premises.every(validField) || !validField(saved.conclusion)) return defaultState();
    const meanings = { ...DEFAULT_MEANINGS };
    if (saved.meanings && typeof saved.meanings === 'object') {
      for (const [key, value] of Object.entries(saved.meanings)) {
        if (/^[A-Z]$/.test(key) && typeof value === 'string') meanings[key] = value.slice(0, 60);
      }
    }
    return {
      premises: saved.premises.map(field => makeField(field.value)), conclusion: makeField(saved.conclusion.value),
      meanings, useMeanings: saved.useMeanings !== false,
      example: Object.hasOwn(EXAMPLES, saved.example) ? saved.example : 'custom',
    };
  } catch { return defaultState(); }
}

let state = loadState();
let activeId = state.premises[0]?.id || state.conclusion.id;
let result = null;
let errors = new Map();
let filter = 'all';
let page = 0;
let toastTimer;
let saveTimer;
const histories = new Map();
const selections = new Map();
const snapshots = new Map();
let lastDeleted = null;
let modelConsent = false;
let currentExplanationKey = '';
let modelText = '';
let apiPreferences = loadApiPreferences();
let llmChannel = apiPreferences.channel === 'api' ? 'api' : 'local';
let apiSessionKey = '';
let apiConsentTarget = '';
const explainer = new LocalExplainer(event => handleModelEvent({ ...event, channel: 'local' }));
const apiExplainer = new ApiExplainer(event => handleModelEvent({ ...event, channel: 'api' }));

function loadApiPreferences() {
  const fallback = { channel: 'local', preset: 'custom', baseUrl: '', model: '', remember: true };
  try {
    const saved = JSON.parse(localStorage.getItem(API_STORAGE_KEY));
    if (!saved || saved.version !== 1) return fallback;
    return {
      channel: saved.channel === 'api' ? 'api' : 'local',
      preset: Object.hasOwn(API_PRESETS, saved.preset) ? saved.preset : 'custom',
      baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl.slice(0, 2048) : '',
      model: typeof saved.model === 'string' ? saved.model.slice(0, 120) : '',
      remember: saved.remember !== false,
    };
  } catch { return fallback; }
}
function saveApiPreferences() {
  try {
    if (!apiPreferences.remember) { localStorage.removeItem(API_STORAGE_KEY); return; }
    localStorage.setItem(API_STORAGE_KEY, JSON.stringify({
      version: 1, channel: apiPreferences.channel, preset: apiPreferences.preset,
      baseUrl: apiPreferences.baseUrl, model: apiPreferences.model, remember: true,
    }));
  } catch { /* Non-secret preferences are optional; the key is never stored here. */ }
}
function currentApiConfig() { return { baseUrl: apiPreferences.baseUrl, model: apiPreferences.model, apiKey: apiSessionKey }; }
function apiTarget() { return `${apiPreferences.baseUrl}|${apiPreferences.model}`; }
function apiSummaryText() {
  try { return `${apiPreferences.model} · ${new URL(apiPreferences.baseUrl).host}`; }
  catch { return '尚未配置 API'; }
}
function activeExplainer() { return llmChannel === 'api' ? apiExplainer : explainer; }

function fields() { return [...state.premises, state.conclusion]; }
function getField(id = activeId) { return fields().find(field => field.id === id); }
function fieldElement(id = activeId) { return document.getElementById(id); }
function fieldLabel(id = activeId) {
  const index = state.premises.findIndex(field => field.id === id);
  return index < 0 ? '结论' : `前提 ${index + 1}`;
}
function getSelection(id = activeId) {
  const field = getField(id);
  const input = fieldElement(id);
  const saved = selections.get(id);
  return {
    start: Math.min(saved?.start ?? field?.value.length ?? 0, field?.value.length ?? 0),
    end: Math.min(saved?.end ?? field?.value.length ?? 0, field?.value.length ?? 0),
  };
}
function rememberSelection(id) {
  const input = fieldElement(id);
  if (input) selections.set(id, { start: input.selectionStart, end: input.selectionEnd });
}
function rememberAll() { for (const field of fields()) snapshots.set(field.id, field.value); }
function pushHistory(id, value, selection = getSelection(id)) {
  const history = histories.get(id) || [];
  history.push({ value, selection });
  if (history.length > 100) history.shift();
  histories.set(id, history);
}
function saveState() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, premises: state.premises.map(({ value }) => ({ value })),
      conclusion: { value: state.conclusion.value }, meanings: state.meanings,
      useMeanings: state.useMeanings, example: state.example,
    }));
    $('#save-status').innerHTML = '<span class="status-dot"></span>自动保存在此浏览器';
  } catch {
    $('#save-status').textContent = '仅在当前页面保存';
  }
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 250); }
function toast(message, action = null) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = action.label;
    button.addEventListener('click', () => { action.run(); node.classList.remove('visible'); });
    node.append(button);
  }
  node.classList.add('visible');
  toastTimer = setTimeout(() => node.classList.remove('visible'), action ? 7000 : 3200);
}

function fieldMarkup(field, index, isConclusion = false) {
  const label = isConclusion ? '结论' : `前提 ${index + 1}`;
  const error = errors.get(field.id);
  return `<div class="formula-field ${isConclusion ? 'conclusion-field' : ''} ${field.id === activeId ? 'active' : ''} ${error ? 'has-error' : ''}" data-field-wrapper="${field.id}">
    <div class="field-top"><label class="field-name" for="${field.id}"><span class="field-index">${isConclusion ? '∴' : index + 1}</span>${label}<span class="field-active-label">正在编辑</span></label>
    ${!isConclusion ? `<button class="icon-button delete-premise" type="button" data-delete="${field.id}" aria-label="删除${label}" title="删除${label}" >${icon('trash')}</button>` : `<span class="small-tag">所以…</span>`}</div>
    <input id="${field.id}" class="formula-input" type="text" value="${escapeHTML(field.value)}" placeholder="${isConclusion ? '你想推出什么结论？' : '点击左侧符号，写下前提'}" maxlength="${LIMITS.formulaLength}" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="${label}的逻辑公式" aria-describedby="${field.id}-error" ${error ? 'aria-invalid="true"' : ''}>
    <p class="field-error" id="${field.id}-error">${escapeHTML(error || '')}</p>
  </div>`;
}
function bindField(input) {
  const id = input.id;
  input.addEventListener('focus', () => { activeId = id; rememberSelection(id); updateActiveUI(); });
  for (const event of ['click', 'keyup', 'select', 'blur']) input.addEventListener(event, () => rememberSelection(id));
  input.addEventListener('input', () => {
    const field = getField(id);
    if (!field || field.value === input.value) return;
    pushHistory(id, snapshots.get(id) ?? field.value, getSelection(id));
    field.value = input.value;
    snapshots.set(id, input.value);
    rememberSelection(id);
    markEdited();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); validate(true); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
  });
}
function renderFields(focusId = null) {
  $('#premises').innerHTML = state.premises.length ? state.premises.map((field, index) => fieldMarkup(field, index)).join('') : '<p class="empty-premises">暂无前提，将检验结论是否为重言式。</p>';
  $('#conclusion').innerHTML = fieldMarkup(state.conclusion, -1, true);
  for (const field of fields()) {
    if (!snapshots.has(field.id)) snapshots.set(field.id, field.value);
    bindField(fieldElement(field.id));
  }
  $('#premise-count').textContent = `${state.premises.length} / ${LIMITS.premises}`;
  $('#add-premise').disabled = state.premises.length >= LIMITS.premises;
  $('#example-select').value = state.example;
  updateActiveUI();
  if (focusId) focusField(focusId);
}
function updateActiveUI() {
  for (const field of fields()) {
    const wrapper = $(`[data-field-wrapper="${field.id}"]`);
    wrapper?.classList.toggle('active', field.id === activeId);
  }
  $('#active-field-label').textContent = fieldLabel();
  const field = getField();
  const selection = getSelection();
  $('#undo-button').disabled = !histories.get(activeId)?.length;
  $('#backspace-button').disabled = !field?.value || selection.end === 0;
  $('#clear-button').disabled = !field?.value;
}
function focusField(id, selection = null) {
  const input = fieldElement(id);
  if (!input) return;
  activeId = id;
  input.focus({ preventScroll: true });
  const pos = selection ?? { start: input.value.length, end: input.value.length };
  input.setSelectionRange(pos.start, pos.end);
  rememberSelection(id);
  updateActiveUI();
}
function commitValue(id, value, selection) {
  const field = getField(id);
  if (!field) return;
  if (field.value !== value) {
    pushHistory(id, field.value);
    field.value = value;
    snapshots.set(id, value);
    markEdited();
  }
  fieldElement(id).value = value;
  focusField(id, selection);
}
function insertSymbol(symbol) {
  const field = getField();
  if (!field) return;
  let { start, end } = getSelection();
  const selected = field.value.slice(start, end);
  const left = field.value.slice(0, start);
  const right = field.value.slice(end);
  let inserted, caret;
  if (symbol === '()') {
    inserted = `(${selected})`;
    caret = start + 1 + selected.length + (selected ? 1 : 0);
  } else if (['∧', '∨', '→', '↔', '⊕', '↑', '↓', '←', '≝', '≔', '=', '≠'].includes(symbol)) {
    const prefix = left && !/\s$/.test(left) ? ' ' : '';
    const suffix = !right || !/^\s/.test(right) ? ' ' : '';
    inserted = `${prefix}${symbol}${suffix}`;
    caret = start + inserted.length;
  } else {
    inserted = symbol;
    caret = start + symbol.length;
  }
  const value = left + inserted + right;
  if (value.length > LIMITS.formulaLength) { toast(`每条公式最多 ${LIMITS.formulaLength} 个字符。`); return; }
  commitValue(field.id, value, { start: caret, end: caret });
}
function undo() {
  const previous = histories.get(activeId)?.pop();
  if (!previous) return;
  const field = getField();
  field.value = previous.value;
  snapshots.set(field.id, field.value);
  fieldElement(field.id).value = field.value;
  markEdited();
  focusField(field.id, previous.selection);
}
function backspace() {
  const field = getField();
  let { start, end } = getSelection();
  if (start === end && start > 0) start--;
  if (start === end) return;
  commitValue(field.id, field.value.slice(0, start) + field.value.slice(end), { start, end: start });
}
function markEdited() {
  state.example = 'custom';
  $('#example-select').value = 'custom';
  result = null;
  errors.clear();
  for (const wrapper of $$('.formula-field')) {
    wrapper.classList.remove('has-error');
    const input = $('input', wrapper);
    input.removeAttribute('aria-invalid');
    $('.field-error', wrapper).textContent = '';
  }
  renderResult(); renderTranslation(); renderProof(); renderTable(); updateActiveUI(); queueSave();
}

function validate(showToast = false) {
  errors.clear();
  for (const field of fields()) {
    try { parseFormula(field.value); }
    catch (error) { errors.set(field.id, error.message); }
  }
  result = null;
  if (!errors.size) {
    try {
      result = analyzeArgument({ premises: state.premises.map(field => field.value), conclusion: state.conclusion.value });
      filter = 'all'; page = 0;
      if (showToast) toast(result.valid === true ? (result.kind === 'first-order' ? '验证完成：已构造自然演绎证明。' : '验证完成：这是一个有效论证。') : result.valid === false ? (result.kind === 'first-order' ? '验证完成：找到有限反例模型。' : `验证完成：找到 ${result.counterexamples.length} 个反例。`) : '尚未判定：证明搜索和有限模型搜索都未给出结论。');
    } catch (error) { errors.set('global', error.message); }
  }
  for (const field of fields()) {
    const wrapper = $(`[data-field-wrapper="${field.id}"]`);
    const message = errors.get(field.id);
    wrapper.classList.toggle('has-error', Boolean(message));
    $('input', wrapper).setAttribute('aria-invalid', message ? 'true' : 'false');
    $('.field-error', wrapper).textContent = message || '';
  }
  renderResult(); renderTranslation(); renderProof(); renderTable();
  if (errors.size) {
    const id = errors.keys().next().value;
    focusField(id);
    fieldElement(id)?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
  saveState();
}
function placeholderResult(title, text, symbol = 'clock', type = '') {
  $('#result-card').className = `card result-card ${type}`;
  $('#result-status-tag').textContent = type === 'error' ? '检查公式' : '等待验证';
  $('#result-content').innerHTML = `<div class="result-placeholder"><div class="placeholder-icon">${icon(symbol)}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(text)}</p></div>`;
}
function renderResult() {
  if (!result) {
    const error = errors.get('global');
    if (error) placeholderResult('再调整一下公式', error, 'info', 'error');
    else if (errors.size) placeholderResult('公式还差一点点', '请检查标记的输入框，补全公式后再验证。', 'info', 'error');
    else placeholderResult('你的推理，经得起检验吗？', '填写前提与结论，点击“验证论证”，看看结论是否必然成立。');
    return;
  }
  if (result.kind === 'first-order') { renderFirstOrderResult(); return; }
  const { valid, variables, rows, counterexamples, contradictoryPremises, tautologicalConclusion } = result;
  $('#result-card').className = `card result-card ${valid ? 'valid' : 'invalid'}`;
  $('#result-status-tag').textContent = '已验证';
  let explanation = valid
    ? `检查了全部 <strong>${rows.length} 种</strong>真假组合，不存在<strong>前提全真、结论为假</strong>的情况。因此，这个论证是有效的。`
    : `找到 <strong>${counterexamples.length} 个反例</strong>：所有前提为真，结论却为假。只要存在一个反例，论证就无效。`;
  let extra = '';
  if (contradictoryPremises) {
    extra = '<div class="result-note">前提不可能同时为真，因而不存在反例。这在经典逻辑中称为“空真有效”，并不说明结论在现实中为真。</div>';
  } else if (!state.premises.length) {
    extra = `<div class="result-note">没有前提时，只有重言式才能作为有效结论。当前结论${tautologicalConclusion ? '在所有赋值下都为真' : '并非在所有赋值下都为真'}。</div>`;
  }
  if (valid && result.proofSteps?.length) extra += '<div class="result-note">已构造自然演绎证明，每一步的规则与依赖见下方证明过程。</div>';
  if (!valid) {
    const first = counterexamples[0];
    extra = `<div class="counterexample-detail"><strong>看看这个反例</strong><div class="assignment-chips">${variables.map(name => `<span class="assignment-chip">${name} = ${first.values[name] ? '真' : '假'}</span>`).join('')}</div><p>此时，全部前提为真，结论为假。</p><button class="counterexample-link" type="button" id="show-counterexamples">在真值表中查看 ${icon('arrow')}</button></div>`;
  }
  $('#result-content').innerHTML = `<div><div class="result-banner"><span class="result-emblem">${icon(valid ? 'check' : 'x')}</span><div><h3>${valid ? '论证有效' : '论证无效'}</h3><p>${valid ? 'VALID ARGUMENT' : 'INVALID ARGUMENT'}</p></div></div><p class="result-explanation">${explanation}</p><div class="result-metrics"><div class="result-metric"><strong>${variables.length}</strong><span>命题变量</span></div><div class="result-metric"><strong>${rows.length}</strong><span>真假组合</span></div><div class="result-metric"><strong>${counterexamples.length}</strong><span>发现反例</span></div></div>${extra}</div>`;
  $('#show-counterexamples')?.addEventListener('click', () => { setFilter('counterexample'); $('.truth-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}
function renderFirstOrderResult() {
  const { valid, proofSteps, proofStats, countermodel, countermodelSearch } = result;
  const type = valid === true ? 'valid' : valid === false ? 'invalid' : 'unknown';
  $('#result-card').className = `card result-card ${type}`;
  $('#result-status-tag').textContent = valid === null ? '有界搜索' : '已验证';
  const title = valid === true ? '论证有效' : valid === false ? '论证无效' : '尚未判定';
  const english = valid === true ? 'PROOF FOUND' : valid === false ? 'COUNTERMODEL FOUND' : 'NOT DECIDED';
  const explanation = valid === true
    ? `已构造并通过校验的<strong>自然演绎证明</strong>，共 ${proofSteps.length} 步。证明只使用语法规则，不依赖真值表枚举。`
    : valid === false
      ? `找到一个<strong>有限反例模型</strong>（论域大小 ${countermodel.domain.length}）：所有前提为真，结论为假。只要存在一个模型反例，论证就无效。`
      : `有界自然演绎证明搜索未找到证明，有限反例模型搜索（论域至多 ${countermodelSearch?.maxDomain ?? 3}）也未找到反例。一阶逻辑不可判定，这<strong>不等于</strong>论证有效或无效。`;
  const metrics = valid === true
    ? `<div class="result-metric"><strong>${proofSteps.length}</strong><span>证明步骤</span></div><div class="result-metric"><strong>${result.premises.length}</strong><span>前提</span></div><div class="result-metric"><strong>${proofStats?.nodes ?? '—'}</strong><span>搜索节点</span></div>`
    : valid === false
      ? `<div class="result-metric"><strong>${countermodel.domain.length}</strong><span>论域大小</span></div><div class="result-metric"><strong>${result.premises.length}</strong><span>前提</span></div><div class="result-metric"><strong>1</strong><span>反例模型</span></div>`
      : `<div class="result-metric"><strong>${proofStats?.nodes ?? 0}</strong><span>搜索节点</span></div><div class="result-metric"><strong>${countermodelSearch?.maxDomain ?? 3}</strong><span>最大论域</span></div><div class="result-metric"><strong>—</strong><span>结论</span></div>`;
  const extra = valid === null
    ? '<div class="result-note">可尝试简化公式、补充中间前提，或检查量词辖域。证明搜索失败不会被当作无效；只有显式反例模型才能推翻论证。</div>'
    : `<div class="result-note">${valid === true ? '量词、定义与等词规则的条件已自动检查。' : '反例模型的谓词解释与真假评估见下方。'}</div><button class="counterexample-link" type="button" id="show-proof">${valid === true ? '查看自然演绎证明' : '查看反例模型'} ${icon('arrow')}</button>`;
  $('#result-content').innerHTML = `<div><div class="result-banner"><span class="result-emblem">${icon(valid === true ? 'check' : valid === false ? 'x' : 'info')}</span><div><h3>${title}</h3><p>${english}</p></div></div><p class="result-explanation">${explanation}</p><div class="result-metrics">${metrics}</div>${extra}</div>`;
  $('#show-proof')?.addEventListener('click', () => $('#proof-card').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function currentMeanings() { return state.useMeanings ? state.meanings : {}; }
function resetModelUI() {
  modelText = '';
  $('#model-output').hidden = true;
  $('#model-output p').textContent = '';
  $('#model-progress').hidden = true;
  $('#cancel-model').hidden = true;
  $('#cancel-model').textContent = '停止 / 卸载';
  const api = llmChannel === 'api';
  const firstOrder = result?.kind === 'first-order';
  $('#local-controls').hidden = api || firstOrder;
  $('#api-controls').hidden = !api;
  $('#clear-model-cache').hidden = api;
  $('#clear-api-key').hidden = !api || !apiSessionKey;
  $('#llm-channel-tag').textContent = api ? '外部 API' : '本地小模型';
  $('#llm-channel-description').textContent = api
    ? '仅在你点击发送后，把当前已验证反例发送到你配置的 API。模型不改判有效性。'
    : '把已验证的反例改写得更通俗。模型不改判有效性，也不证明现实中的结论为假。';
  $('#model-privacy-note').textContent = api
    ? '公式与反例会发送到所配 API · 密钥仅当前页面'
    : '浏览器缓存 · 不上传公式';
  $('#enable-model').hidden = false;
  $('#enable-model span').textContent = '下载并启用小模型';
  $('#enable-api').hidden = false;
  $('#enable-api span').textContent = '发送反例并改写';
  if (api) {
    $('#model-status').textContent = !apiPreferences.baseUrl || !apiPreferences.model
      ? '尚未配置 API。点击“配置 API”填写地址和模型；保存配置不会发送请求。'
      : `已配置 ${apiSummaryText()}。${apiSessionKey ? '密钥仅保存在当前页面内存。' : '未填入密钥；无认证接口可留空。'}点击发送后才会请求。`;
  } else if (firstOrder) {
    $('#model-status').textContent = '本地小模型目前只解释命题反例；可切换到 API 通道解释此有限模型。';
  } else {
    $('#model-status').textContent = '未加载模型。仅在点击启用后下载权重，随后在本机推理。';
  }
}
function currentDescription() {
  if (result?.valid !== false) return null;
  return result.kind === 'first-order'
    ? describeFirstOrderCountermodel(result, currentMeanings())
    : describeCounterexample(result, currentMeanings());
}
function renderTranslation() {
  const invalid = result?.valid === false;
  $('#translation-card').hidden = !invalid;
  $('#model-panel').hidden = !invalid;
  if (!invalid) {
    currentExplanationKey = '';
    explainer.cancel();
    apiExplainer.cancel();
    $('#translation-content').replaceChildren();
    $('#copy-translation').disabled = true;
    resetModelUI();
    return;
  }
  const firstOrder = result.kind === 'first-order';
  const key = explanationKey(result, currentMeanings());
  const description = currentDescription();
  $('#invalid-only-label').innerHTML = `<span></span>${firstOrder ? '有限模型已找到反例' : '真值表已找到反例'}`;
  if (key !== currentExplanationKey) {
    explainer.cancel();
    apiExplainer.cancel();
    currentExplanationKey = key;
    resetModelUI();
    $('#translation-content').textContent = description.narrative;
    if (modelConsent && !firstOrder && llmChannel === 'local') startModel();
  }
  $('#copy-translation').disabled = false;
}
function startModel() {
  if (result?.valid !== false || result.kind === 'first-order' || llmChannel !== 'local') return;
  resetModelUI();
  $('#enable-model').hidden = true;
  $('#cancel-model').hidden = false;
  explainer.generate(describeCounterexample(result, currentMeanings()), currentExplanationKey);
}
function sendApiRequest() {
  if (result?.valid !== false || llmChannel !== 'api') return;
  let config;
  try { config = normalizeApiConfig(currentApiConfig()); }
  catch (error) { $('#model-status').textContent = error.message; openApiConfig(); return; }
  resetModelUI();
  $('#enable-api').hidden = true;
  $('#cancel-model').hidden = false;
  $('#cancel-model').textContent = '停止请求';
  $('#model-status').textContent = '正在把你点击发送的已验证反例交给 API；有效性仍由本地引擎判定。';
  apiExplainer.generate({ ...currentDescription(), kind: result.kind }, currentExplanationKey, currentApiConfig());
}
function requestApiGeneration() {
  if (result?.valid !== false || llmChannel !== 'api') return;
  let config;
  try { config = normalizeApiConfig(currentApiConfig()); }
  catch (error) { $('#model-status').textContent = error.message; openApiConfig(); return; }
  if (apiConsentTarget !== apiTarget()) {
    $('#api-confirm-endpoint').textContent = config.endpoint;
    $('#api-confirm-model').textContent = config.model;
    $('#api-confirm-dialog').showModal();
    return;
  }
  sendApiRequest();
}
function switchChannel(channel) {
  const next = channel === 'api' ? 'api' : 'local';
  if (next === llmChannel) return;
  activeExplainer().cancel();
  llmChannel = next;
  apiPreferences.channel = next;
  saveApiPreferences();
  resetModelUI();
  if (result?.valid === false && next === 'local' && modelConsent && result.kind !== 'first-order') startModel();
}
function handleModelEvent(event) {
  if (event.key !== currentExplanationKey || result?.valid !== false || event.channel !== llmChannel) return;
  const api = event.channel === 'api';
  if (!api && result.kind === 'first-order') return;
  const status = $('#model-status');
  if (event.type === 'progress' && !api) {
    $('#model-progress').hidden = false;
    const bar = $('#model-progress progress');
    if (event.total) { bar.value = event.loaded / event.total; } else bar.removeAttribute('value');
    const mb = n => (n / 1024 / 1024).toFixed(1);
    $('#model-progress span').textContent = event.total ? `${mb(event.loaded)} / ${mb(event.total)} MiB` : `${mb(event.loaded)} MiB`;
    status.textContent = '按需下载模型文件；公式仍留在本机。';
  } else if (event.type === 'status') {
    status.textContent = ({
      starting: '正在启动本地推理线程…', runtime: '正在准备推理运行时…', initializing: '正在将模型载入本机内存…',
      connecting: '正在连接你配置的 API…',
      generating: api ? 'API 正在改写已验证的反例，不重新判断有效性…' : '正在改写已验证的反例，不重新判断有效性…',
      fallback: 'WebGPU 初始化失败，尝试 CPU 兼容模式（需要额外下载兼容权重）…',
    })[event.stage] || '正在准备…';
  } else if (event.type === 'token' && !api) {
    modelText += event.text;
    $('#model-output').hidden = false;
    $('#model-output p').textContent = modelText;
  } else if (event.type === 'done') {
    $('#model-progress').hidden = true;
    modelText = String(event.text || '').trim();
    if (!modelText || modelText.length > 1200 || !/[\u4e00-\u9fff]/.test(modelText)) {
      status.textContent = '模型未给出可用改写，已保留上方准确的反例直译。可以重试。';
      $('#model-output').hidden = true;
    } else {
      $('#model-output').hidden = false;
      $('#model-output p').textContent = modelText;
      status.textContent = `改写完成（${event.device || (api ? 'API' : '本机')}）。请以上方反例为准。`;
      const button = api ? $('#enable-api') : $('#enable-model');
      button.querySelector('span').textContent = '重新生成改写';
      button.hidden = false;
      $('#cancel-model').hidden = api;
      $('#cancel-model').textContent = '卸载模型';
    }
  } else if (event.type === 'error') {
    status.textContent = `${api ? 'API' : '模型'}暂不可用：${event.message} 上方反例直译仍然有效。`;
    $('#model-output').hidden = true;
    const button = api ? $('#enable-api') : $('#enable-model');
    button.hidden = false;
    button.querySelector('span').textContent = api ? '重试 API 请求' : '重试本地模型';
    $('#cancel-model').hidden = true;
    activeExplainer().cancel();
  }
}
function openApiConfig() {
  $('#api-preset').value = apiPreferences.preset;
  $('#api-base-url').value = apiPreferences.baseUrl;
  $('#api-model').value = apiPreferences.model;
  $('#api-key').value = '';
  $('#api-remember').checked = apiPreferences.remember;
  $('#api-clear-key').checked = false;
  $('#api-key-status').textContent = apiSessionKey
    ? '当前页面已填入密钥。留空可保留；勾选“清除密钥”可移除。'
    : '当前页面没有密钥。无认证接口可留空；密钥不会写入浏览器存储。';
  $('#api-config-error').textContent = '';
  $('#api-config-dialog').showModal();
}
function usedVariables() {
  return [...new Set(fields().flatMap(field => field.value.match(/[A-Z]/g) || []))].sort();
}
function setFilter(next) {
  filter = next; page = 0; renderTable();
}
function filteredRows() {
  if (!result) return [];
  const rows = filter === 'critical' ? result.criticalRows : filter === 'counterexample' ? result.counterexamples : result.rows;
  return rows;
}
function renderProof() {
  const card = $('#proof-card');
  const has = Boolean(result && (result.kind === 'first-order' || result.proofSteps?.length || result.valid === true));
  card.hidden = !has;
  $('.workspace-grid').classList.toggle('has-proof', has);
  if (!has) { $('#proof-content').innerHTML = ''; $('#copy-proof').disabled = true; return; }
  $('#copy-proof').disabled = !(result.proofSteps?.length || result.countermodel);
  const tag = $('#proof-tag');
  const description = $('#proof-description');
  if (result.proofSteps?.length) {
    tag.textContent = '已证明';
    description.textContent = '每一步都标注规则与依赖行；量词、定义与等词规则附带适用条件。证明已通过独立规则校验。';
    const lines = result.proofSteps.map(step => `<li class="proof-line depth-${Math.min(step.depth, 6)} ${step.rule === 'assumption' ? 'assumption' : ''}" style="--depth:${step.depth}"><span class="proof-line-number">${step.line}</span><span class="proof-formula">${escapeHTML(step.formatted)}</span><span class="proof-rule">${escapeHTML(step.ruleLabel)}${step.refs.length ? `<span class="proof-refs">[${step.refs.join(', ')}]</span>` : ''}</span>${step.note ? `<span class="proof-note">${escapeHTML(step.note)}</span>` : ''}</li>`).join('');
    $('#proof-content').innerHTML = `<ol class="proof-lines" aria-label="自然演绎证明步骤">${lines}</ol><p class="proof-footer">最终行即为目标结论。缩进表示子证明：假设在子证明内引入，并在对应引入规则处解除。</p>`;
    return;
  }
  if (result.countermodel) {
    tag.textContent = '反例模型';
    description.textContent = '这是一个有限模型反例：前提全部为真，结论为假。它足以推翻论证。';
    const model = describeModel(result.countermodel);
    const values = result.countermodelSearch?.premiseValues || [];
    const premises = result.premises.map((premise, index) => `<li><code>${escapeHTML(premise.formatted)}</code><span class="model-truth ${values[index] === false ? 'false' : 'true'}">${values[index] === false ? '假' : '真'}</span></li>`).join('');
    $('#proof-content').innerHTML = `<div class="countermodel"><div class="model-block"><h3>论域</h3><div class="assignment-chips">${result.countermodel.domain.map(value => `<span class="assignment-chip">d${value}</span>`).join('')}</div></div>${model.predicates.length ? `<div class="model-block"><h3>谓词解释</h3><ul class="model-list">${model.predicates.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul></div>` : ''}${model.constants.length ? `<div class="model-block"><h3>常项</h3><p>${escapeHTML(model.constants.join('，'))}</p></div>` : ''}${model.assignment.length ? `<div class="model-block"><h3>自由变量赋值</h3><p>${escapeHTML(model.assignment.join('，'))}</p></div>` : ''}<div class="model-block"><h3>公式真假</h3><ul class="model-list formula-values">${premises}<li><code>${escapeHTML(result.conclusion.formatted)}</code><span class="model-truth false">假</span></li></ul></div></div>`;
    return;
  }
  if (result.valid === true) {
    tag.textContent = '真值表有效';
    description.textContent = '命题逻辑已由真值表判定有效。';
    $('#proof-content').innerHTML = '<div class="table-empty">当前有界自然演绎搜索未找到证明，但真值表已经给出确定性判定。可尝试简化公式后重新验证。</div>';
    return;
  }
  tag.textContent = '尚未判定';
  description.textContent = '一阶逻辑不可判定；有界搜索失败不等于无效。';
  const searched = result.countermodelSearch?.searched?.map(item => `论域 ${item.size}${item.skipped ? '（跳过）' : ''}`).join('、') || '无';
  $('#proof-content').innerHTML = `<div class="table-empty">${icon('info')}未找到自然演绎证明，也未找到有限反例模型。<br>证明搜索节点：${result.proofStats?.nodes ?? 0} / ${result.proofStats?.maxNodes ?? '—'}；已检查：${escapeHTML(searched)}。<br>请简化公式、补充中间前提，或检查量词辖域。</div>`;
}

function renderTable() {
  const isFirstOrder = result?.kind === 'first-order';
  $('.truth-card').hidden = isFirstOrder;
  if (isFirstOrder) { $('#export-table').disabled = true; return; }
  const hasResult = Boolean(result);
  $('#export-table').disabled = !hasResult;
  $('#truth-count').textContent = hasResult ? `${result.rows.length} 种赋值` : '等待验证';
  $('#all-row-count').textContent = hasResult ? result.rows.length : '—';
  $('#critical-row-count').textContent = hasResult ? result.criticalRows.length : '—';
  $('#counterexample-count').textContent = hasResult ? result.counterexamples.length : '—';
  for (const button of $$('[data-filter]')) {
    button.disabled = !hasResult;
    button.classList.toggle('selected', button.dataset.filter === filter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  if (!hasResult) {
    $('#truth-table-container').innerHTML = `<div class="table-empty">${icon('table')}验证论证后，所有真假组合会在这里展开。<br>输入修改后，旧结果会自动清除。</div>`;
    $('#page-label').textContent = '— / —';
    $('#prev-page').disabled = true; $('#next-page').disabled = true;
    return;
  }
  const rows = filteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const valueCell = value => `<span class="truth-value ${value ? 'true' : 'false'}" aria-label="${value ? '真' : '假'}">${value ? 'T' : 'F'}</span>`;
  const header = `<tr><th scope="col"><span class="table-column-label">赋值</span>#</th>${result.variables.map(name => `<th scope="col" class="variable-column" title="${escapeHTML(state.useMeanings ? state.meanings[name] || name : name)}">${name}</th>`).join('')}${result.premises.map((premise, index) => `<th scope="col" class="formula-column"><span class="table-column-label">前提 ${index + 1}</span><span class="table-formula" title="${escapeHTML(premise.formatted)}">${escapeHTML(premise.formatted)}</span></th>`).join('')}<th scope="col" class="formula-column conclusion-column"><span class="table-column-label">结论</span><span class="table-formula" title="${escapeHTML(result.conclusion.formatted)}">${escapeHTML(result.conclusion.formatted)}</span></th><th scope="col"><span class="table-column-label">检验</span>结果</th></tr>`;
  const body = visible.map(row => {
    const number = result.rows.indexOf(row) + 1;
    return `<tr class="${row.counterexample ? 'counterexample-row' : row.allPremisesTrue ? 'critical-row' : ''}"><td>${number}</td>${result.variables.map(name => `<td>${valueCell(row.values[name])}</td>`).join('')}${row.premiseValues.map(value => `<td>${valueCell(value)}</td>`).join('')}<td class="conclusion-column">${valueCell(row.conclusionValue)}</td><td>${row.counterexample ? '<span class="row-status bad">反例</span>' : row.allPremisesTrue ? '<span class="row-status good">成立</span>' : '<span class="row-status">—</span>'}</td></tr>`;
  }).join('');
  $('#truth-table-container').innerHTML = rows.length
    ? `<table class="truth-table"><caption class="sr-only">论证真值表，T 表示真，F 表示假。绿色行表示所有前提为真，红色行表示反例。</caption><thead>${header}</thead><tbody>${body}</tbody></table>`
    : `<div class="table-empty">${icon(filter === 'counterexample' ? 'check-circle' : 'info')}${filter === 'counterexample' ? '没有反例。没有任何一种赋值能让前提全真、结论为假。' : '没有让所有前提同时为真的赋值，请留意前提是否互相矛盾。'}</div>`;
  $('#page-label').textContent = rows.length > PAGE_SIZE ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, rows.length)} / ${rows.length}` : `${pages} / ${pages}`;
  $('#prev-page').disabled = page === 0;
  $('#next-page').disabled = page >= pages - 1;
}
function exportCSV() {
  if (!result || result.kind === 'first-order') return;
  const quote = value => `"${String(value).replace(/"/g, '""')}"`;
  const header = ['赋值', ...result.variables, ...result.premises.map((premise, index) => `前提${index + 1}: ${premise.formatted}`), `结论: ${result.conclusion.formatted}`, '检验'];
  const lines = [header, ...result.rows.map((row, index) => [index + 1, ...result.variables.map(name => row.values[name] ? 'T' : 'F'), ...row.premiseValues.map(value => value ? 'T' : 'F'), row.conclusionValue ? 'T' : 'F', row.counterexample ? '反例' : row.allPremisesTrue ? '成立' : '—'])];
  const csv = '\uFEFF' + lines.map(line => line.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url; link.download = '逻辑工坊-真值表.csv'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出完整真值表，共 ${result.rows.length} 种赋值。`);
}

function loadExample(key) {
  const example = EXAMPLES[key];
  if (!example) return;
  state.premises = example.premises.map(makeField);
  state.conclusion = makeField(example.conclusion);
  state.example = key;
  activeId = state.premises[0]?.id || state.conclusion.id;
  lastDeleted = null;
  clearTimeout(toastTimer);
  $('#toast').classList.remove('visible');
  histories.clear(); selections.clear(); snapshots.clear();
  renderFields(); renderTranslation(); validate();
}
function addPremise(value = '', afterId = null) {
  if (state.premises.length >= LIMITS.premises) return;
  const field = makeField(value);
  const index = afterId ? state.premises.findIndex(premise => premise.id === afterId) + 1 : state.premises.length;
  state.premises.splice(index, 0, field);
  activeId = field.id;
  renderFields(field.id);
  if (!value) markEdited(); else { renderTranslation(); queueSave(); }
}
function deletePremise(id) {
  if (state.premises.length === 0) return;
  const index = state.premises.findIndex(field => field.id === id);
  if (index < 0) return;
  lastDeleted = { value: state.premises[index].value, index };
  state.premises.splice(index, 1);
  if (activeId === id) activeId = (state.premises[Math.min(index, state.premises.length - 1)] || state.conclusion).id;
  renderFields(); markEdited();
  toast('已删除这条前提。', { label: '撤销', run: () => {
    if (!lastDeleted) return;
    const removed = lastDeleted; lastDeleted = null;
    addPremise(removed.value, removed.index > 0 ? state.premises[removed.index - 1]?.id : null);
  } });
}
function openMeanings() {
  const variables = usedVariables();
  const names = variables.length ? variables : ['P', 'Q', 'R'];
  $('#meaning-fields').innerHTML = names.map(name => `<label class="meaning-field"><span class="meaning-variable">${name}</span><input type="text" name="${name}" maxlength="60" value="${escapeHTML(state.meanings[name] || '')}" placeholder="例如：${DEFAULT_MEANINGS[name] || '这个命题成立'}" aria-label="变量 ${name} 的命题含义"></label>`).join('');
  $('#use-meanings').checked = state.useMeanings;
  $('#meanings-dialog').showModal();
}

// Symbol buttons preserve the current text selection, including on touch devices.
document.addEventListener('pointerdown', event => {
  if (event.target.closest('[data-symbol], #undo-button, #backspace-button, #clear-button')) event.preventDefault();
});
document.addEventListener('click', event => {
  const symbol = event.target.closest('[data-symbol]');
  if (symbol) insertSymbol(symbol.dataset.symbol);
  const remove = event.target.closest('[data-delete]');
  if (remove && !remove.disabled) deletePremise(remove.dataset.delete);
});
$('#undo-button').addEventListener('click', undo);
$('#backspace-button').addEventListener('click', backspace);
$('#clear-button').addEventListener('click', () => commitValue(activeId, '', { start: 0, end: 0 }));
$('#add-premise').addEventListener('click', () => addPremise());
$('#validate-button').addEventListener('click', () => validate(true));
$('#example-select').addEventListener('change', event => loadExample(event.target.value));
$('#new-argument').addEventListener('click', () => {
  state.premises = [makeField()]; state.conclusion = makeField(); state.example = 'custom';
  activeId = state.premises[0].id;
  histories.clear(); selections.clear(); snapshots.clear(); lastDeleted = null;
  renderFields(activeId); markEdited();
  $('.editor-card').scrollIntoView({ behavior: 'instant', block: 'nearest' });
  toast('新的思考，从这里开始。命题含义已为你保留。');
});
$('#copy-translation').addEventListener('click', async () => {
  if (result?.valid !== false) return;
  const text = $('#translation-content').textContent + (modelText ? `\n\n模型辅助改写（请核对）：\n${modelText}` : '');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const textarea = document.createElement('textarea'); textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(textarea); textarea.select();
      const copied = document.execCommand('copy'); textarea.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    toast('自然语言翻译已复制。');
  } catch { toast('浏览器未允许复制，请选中翻译文字后手动复制。'); }
});
$('#copy-proof').addEventListener('click', async () => {
  const text = result?.proofSteps?.length ? proofToText(result.proofSteps) : result?.countermodel ? describeFirstOrderCountermodel(result, currentMeanings())?.narrative : '';
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const textarea = document.createElement('textarea'); textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(textarea); textarea.select();
      const copied = document.execCommand('copy'); textarea.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    toast(result?.proofSteps?.length ? '自然演绎证明已复制。' : '反例模型说明已复制。');
  } catch { toast('浏览器未允许复制，请选中文字后手动复制。'); }
});
for (const button of $$('[data-filter]')) button.addEventListener('click', () => setFilter(button.dataset.filter));
$('#prev-page').addEventListener('click', () => { page--; renderTable(); $('#truth-table-container').scrollTop = 0; });
$('#next-page').addEventListener('click', () => { page++; renderTable(); $('#truth-table-container').scrollTop = 0; });
$('#export-table').addEventListener('click', exportCSV);
$('#edit-meanings').addEventListener('click', openMeanings);
$('#llm-channel').addEventListener('change', event => switchChannel(event.target.value));
$('#configure-api').addEventListener('click', openApiConfig);
$('#enable-model').addEventListener('click', () => {
  if (result?.valid !== false || llmChannel !== 'local') return;
  if (modelConsent) startModel(); else $('#model-dialog').showModal();
});
$('#confirm-model').addEventListener('click', () => {
  if (result?.valid !== false) { $('#model-dialog').close(); return; }
  modelConsent = true; $('#model-dialog').close(); startModel();
});
$('#enable-api').addEventListener('click', requestApiGeneration);
$('#confirm-api').addEventListener('click', () => {
  if (result?.valid !== false || llmChannel !== 'api') { $('#api-confirm-dialog').close(); return; }
  try { normalizeApiConfig(currentApiConfig()); }
  catch (error) { $('#api-confirm-dialog').close(); $('#model-status').textContent = error.message; openApiConfig(); return; }
  apiConsentTarget = apiTarget();
  $('#api-confirm-dialog').close();
  sendApiRequest();
});
$('#cancel-model').addEventListener('click', () => {
  if (llmChannel === 'api') {
    apiExplainer.cancel(); resetModelUI();
    $('#model-status').textContent = '已停止 API 请求。未完成的响应会被忽略；上方反例直译不受影响。';
  } else {
    explainer.cancel(); modelConsent = false; resetModelUI();
    $('#model-status').textContent = '已停止并卸载内存中的模型。已下载的缓存仍保留，下次需重新点击启用。';
  }
});
$('#clear-api-key').addEventListener('click', () => {
  apiSessionKey = ''; apiConsentTarget = '';
  apiExplainer.cancel(); resetModelUI();
  toast('已清除当前页面内存中的 API 密钥。地址和模型等非秘密配置不受影响。');
});
$('#api-preset').addEventListener('change', event => {
  const preset = API_PRESETS[event.target.value];
  if (!preset || event.target.value === 'custom') return;
  $('#api-base-url').value = preset.baseUrl;
  $('#api-model').value = preset.model;
});
$('#api-config-form').addEventListener('submit', event => {
  event.preventDefault();
  const preset = $('#api-preset').value;
  const baseUrl = $('#api-base-url').value.trim();
  const model = $('#api-model').value.trim();
  try { normalizeApiConfig({ baseUrl, model, apiKey: '' }); }
  catch (error) { $('#api-config-error').textContent = error.message; return; }
  const enteredKey = $('#api-key').value.trim();
  if ($('#api-clear-key').checked) apiSessionKey = '';
  else if (enteredKey) apiSessionKey = enteredKey;
  apiPreferences = { channel: 'api', preset: Object.hasOwn(API_PRESETS, preset) ? preset : 'custom', baseUrl, model, remember: $('#api-remember').checked };
  apiConsentTarget = '';
  saveApiPreferences();
  llmChannel = 'api';
  $('#llm-channel').value = 'api';
  $('#api-key').value = '';
  $('#api-config-dialog').close();
  explainer.cancel();
  apiExplainer.cancel();
  resetModelUI();
  toast('API 配置已保存。密钥仅在当前页面内存；尚未发送任何反例。');
});
$('#clear-model-cache').addEventListener('click', async () => {
  modelConsent = false;
  $('#clear-model-cache').disabled = true;
  try { const removed = await explainer.clearCache(); resetModelUI(); toast(removed ? '模型缓存已清除，下次启用时才会重新下载。' : '当前没有可清除的模型缓存。'); }
  catch { toast('浏览器未允许清理缓存，请在站点设置中清除。'); }
  finally { $('#clear-model-cache').disabled = false; }
});
$('#reset-meanings').addEventListener('click', () => {
  for (const input of $$('#meaning-fields input')) input.value = DEFAULT_MEANINGS[input.name] || '';
  $('#use-meanings').checked = true;
});
$('#meanings-form').addEventListener('submit', event => {
  event.preventDefault();
  for (const input of $$('#meaning-fields input')) state.meanings[input.name] = input.value.trim();
  state.useMeanings = $('#use-meanings').checked;
  $('#meanings-dialog').close(); renderTranslation(); renderTable(); saveState();
  toast('命题含义已更新，论证的逻辑形式保持不变。');
});
for (const button of $$('[data-open-help]')) button.addEventListener('click', () => $('#help-dialog').showModal());
for (const button of $$('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of $$('dialog')) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
document.addEventListener('selectionchange', () => {
  const input = document.activeElement;
  if (input?.classList.contains('formula-input')) {
    rememberSelection(input.id);
    updateActiveUI();
  }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$$('dialog[open]').length) { event.preventDefault(); validate(true); }
});
window.addEventListener('pagehide', () => { saveState(); apiSessionKey = ''; apiExplainer.cancel(); explainer.cancel(); });
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#shortcut-key').textContent = '⌘';

$('#llm-channel').value = llmChannel;
renderFields();
renderTranslation();
// Restore a complete argument with a fresh, locally computed result.
if (fields().every(field => { try { parseFormula(field.value); return true; } catch { return false; } })) validate();
else { renderResult(); renderProof(); renderTable(); }
