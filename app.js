import { analyze, parse, translate, DEFAULT_MEANINGS, LIMITS } from './logic.js';
import { describeCounterexample, explanationKey } from './explanation.js';
import { LocalExplainer } from './llm-client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const STORAGE_KEY = 'logic-lab.workspace.v1';
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
const explainer = new LocalExplainer(handleModelEvent);

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
  } else if (['∧', '∨', '→', '↔', '⊕', '↑', '↓', '←'].includes(symbol)) {
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
  renderResult(); renderTranslation(); renderTable(); updateActiveUI(); queueSave();
}

function validate(showToast = false) {
  errors.clear();
  for (const field of fields()) {
    try { parse(field.value); }
    catch (error) { errors.set(field.id, error.message); }
  }
  result = null;
  if (!errors.size) {
    try {
      result = analyze({ premises: state.premises.map(field => field.value), conclusion: state.conclusion.value });
      filter = 'all'; page = 0;
      if (showToast) toast(result.valid ? '验证完成：这是一个有效论证。' : `验证完成：找到 ${result.counterexamples.length} 个反例。`);
    } catch (error) { errors.set('global', error.message); }
  }
  for (const field of fields()) {
    const wrapper = $(`[data-field-wrapper="${field.id}"]`);
    const message = errors.get(field.id);
    wrapper.classList.toggle('has-error', Boolean(message));
    $('input', wrapper).setAttribute('aria-invalid', message ? 'true' : 'false');
    $('.field-error', wrapper).textContent = message || '';
  }
  renderResult(); renderTranslation(); renderTable();
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
  const { valid, variables, rows, counterexamples, criticalRows, contradictoryPremises, tautologicalConclusion } = result;
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
  if (!valid) {
    const first = counterexamples[0];
    extra = `<div class="counterexample-detail"><strong>看看这个反例</strong><div class="assignment-chips">${variables.map(name => `<span class="assignment-chip">${name} = ${first.values[name] ? '真' : '假'}</span>`).join('')}</div><p>此时，全部前提为真，结论为假。</p><button class="counterexample-link" type="button" id="show-counterexamples">在真值表中查看 ${icon('arrow')}</button></div>`;
  }
  $('#result-content').innerHTML = `<div><div class="result-banner"><span class="result-emblem">${icon(valid ? 'check' : 'x')}</span><div><h3>${valid ? '论证有效' : '论证无效'}</h3><p>${valid ? 'VALID ARGUMENT' : 'INVALID ARGUMENT'}</p></div></div><p class="result-explanation">${explanation}</p><div class="result-metrics"><div class="result-metric"><strong>${variables.length}</strong><span>命题变量</span></div><div class="result-metric"><strong>${rows.length}</strong><span>真假组合</span></div><div class="result-metric"><strong>${counterexamples.length}</strong><span>发现反例</span></div></div>${extra}</div>`;
  $('#show-counterexamples')?.addEventListener('click', () => { setFilter('counterexample'); $('.truth-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

function currentMeanings() { return state.useMeanings ? state.meanings : {}; }
function resetModelUI() {
  modelText = '';
  $('#model-output').hidden = true;
  $('#model-output p').textContent = '';
  $('#model-progress').hidden = true;
  $('#cancel-model').hidden = true;
  $('#cancel-model').textContent = '停止 / 卸载';
  $('#enable-model').hidden = false;
  $('#enable-model span').textContent = '下载并启用小模型';
  $('#model-status').textContent = '未加载模型。仅在点击启用后下载权重，随后在本机推理。';
}
function renderTranslation() {
  const invalid = result?.valid === false;
  $('#translation-card').hidden = !invalid;
  if (!invalid) {
    currentExplanationKey = '';
    explainer.cancel();
    $('#translation-content').replaceChildren();
    $('#copy-translation').disabled = true;
    resetModelUI();
    return;
  }
  const key = explanationKey(result, currentMeanings());
  const description = describeCounterexample(result, currentMeanings());
  if (key !== currentExplanationKey) {
    explainer.cancel();
    currentExplanationKey = key;
    resetModelUI();
    $('#translation-content').textContent = description.narrative;
    if (modelConsent) startModel();
  }
  $('#copy-translation').disabled = false;
}
function startModel() {
  if (result?.valid !== false) return;
  resetModelUI();
  $('#enable-model').hidden = true;
  $('#cancel-model').hidden = false;
  explainer.generate(describeCounterexample(result, currentMeanings()), currentExplanationKey);
}
function handleModelEvent(event) {
  if (event.key !== currentExplanationKey || result?.valid !== false) return;
  const status = $('#model-status');
  if (event.type === 'progress') {
    $('#model-progress').hidden = false;
    const bar = $('#model-progress progress');
    if (event.total) { bar.value = event.loaded / event.total; } else bar.removeAttribute('value');
    const mb = n => (n / 1024 / 1024).toFixed(1);
    $('#model-progress span').textContent = event.total ? `${mb(event.loaded)} / ${mb(event.total)} MiB` : `${mb(event.loaded)} MiB`;
    status.textContent = '按需下载模型文件；公式仍留在本机。';
  } else if (event.type === 'status') {
    status.textContent = ({ starting: '正在启动本地推理线程…', runtime: '正在准备推理运行时…', initializing: '正在将模型载入本机内存…', generating: '正在改写已验证的反例，不重新判断有效性…', fallback: 'WebGPU 初始化失败，尝试 CPU 兼容模式（需要额外下载兼容权重）…' })[event.stage] || '正在准备…';
  } else if (event.type === 'token') {
    modelText += event.text;
    $('#model-output').hidden = false;
    $('#model-output p').textContent = modelText;
  } else if (event.type === 'done') {
    $('#model-progress').hidden = true;
    modelText = event.text.trim();
    if (!modelText || modelText.length > 1200 || !/[\u4e00-\u9fff]/.test(modelText)) {
      status.textContent = '模型未给出可用改写，已保留上方准确的反例直译。可以重试。';
      $('#model-output').hidden = true;
    } else {
      $('#model-output p').textContent = modelText;
      status.textContent = `改写完成（${event.device || '本机'}）。请以上方反例为准。`;
      $('#enable-model span').textContent = '重新生成改写';
      $('#enable-model').hidden = false;
      $('#cancel-model').hidden = false;
      $('#cancel-model').textContent = '卸载模型';
    }
  } else if (event.type === 'error') {
    status.textContent = `模型暂不可用：${event.message} 上方反例直译仍然有效。`;
    $('#model-output').hidden = true;
    $('#enable-model').hidden = false;
    $('#enable-model span').textContent = '重试本地模型';
    $('#cancel-model').hidden = true;
    explainer.cancel();
  }
}
function usedVariables() {
  return [...new Set(fields().flatMap(field => field.value.match(/[A-Za-z]/g) || []).map(name => name.toUpperCase()))].sort();
}
function setFilter(next) {
  filter = next; page = 0; renderTable();
}
function filteredRows() {
  if (!result) return [];
  const rows = filter === 'critical' ? result.criticalRows : filter === 'counterexample' ? result.counterexamples : result.rows;
  return rows;
}
function renderTable() {
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
  if (!result) return;
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
  activeId = state.premises[0].id;
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
for (const button of $$('[data-filter]')) button.addEventListener('click', () => setFilter(button.dataset.filter));
$('#prev-page').addEventListener('click', () => { page--; renderTable(); $('#truth-table-container').scrollTop = 0; });
$('#next-page').addEventListener('click', () => { page++; renderTable(); $('#truth-table-container').scrollTop = 0; });
$('#export-table').addEventListener('click', exportCSV);
$('#edit-meanings').addEventListener('click', openMeanings);
$('#enable-model').addEventListener('click', () => {
  if (result?.valid !== false) return;
  if (modelConsent) startModel(); else $('#model-dialog').showModal();
});
$('#confirm-model').addEventListener('click', () => {
  if (result?.valid !== false) { $('#model-dialog').close(); return; }
  modelConsent = true; $('#model-dialog').close(); startModel();
});
$('#cancel-model').addEventListener('click', () => {
  explainer.cancel(); modelConsent = false; resetModelUI();
  $('#model-status').textContent = '已停止并卸载内存中的模型。已下载的缓存仍保留，下次需重新点击启用。';
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
window.addEventListener('pagehide', saveState);
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#shortcut-key').textContent = '⌘';

renderFields();
renderTranslation();
// Restore a complete argument with a fresh, locally computed result.
if (fields().every(field => { try { parse(field.value); return true; } catch { return false; } })) validate();
else { renderResult(); renderTable(); }
