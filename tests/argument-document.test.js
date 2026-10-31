import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeArgument } from '../argument.js';
import { buildDocument, buildMarkdown, buildHtml, truthTableDimensions, truthTableSizeText, documentFilename } from '../argument-document.js';

const fixedNow = new Date('2026-10-31T07:01:02Z');

test('document exports every premise and the conclusion for valid propositional arguments', () => {
  const result = analyzeArgument({ premises: ['P → Q', 'P'], conclusion: 'Q' });
  const md = buildMarkdown(result, { P: '今天下雨', Q: '地面湿润' }, { now: fixedNow });
  assert.match(md, /# 前提–结论文档/);
  assert.match(md, /判定结果：有效/);
  assert.match(md, /`P → Q`/);
  assert.match(md, /`P`/);
  assert.match(md, /`Q`/);
  assert.match(md, /今天下雨/);
  assert.match(md, /完整真值表/);
});

test('valid propositional arguments without a natural-deduction proof get a truth-table certificate, not a fake proof', () => {
  const result = analyzeArgument({ premises: ['P → Q', 'P'], conclusion: 'Q' }, { proofMaxNodes: 1 });
  assert.equal(result.valid, true);
  assert.equal(result.proofSteps.length, 0);
  const md = buildMarkdown(result, {}, { now: fixedNow });
  assert.match(md, /真值表判定过程/);
  assert.match(md, /未生成自然演绎证明步骤/);
  assert.ok(!md.includes('## 自然演绎证明'));
});

test('invalid propositional arguments export counterexamples and the full truth table', () => {
  const result = analyzeArgument({ premises: ['P → Q', 'Q'], conclusion: 'P' });
  const md = buildMarkdown(result, {}, { now: fixedNow });
  assert.match(md, /判定结果：无效/);
  assert.match(md, /反例直译/);
  assert.match(md, /可以设想/);
  assert.match(md, /\| 3 \| F \| T \| T \| T \| F \| 反例 \|/);
});

test('undecided first-order arguments are exportable and clearly not called invalid', () => {
  const result = analyzeArgument({ premises: ['∀x ∃y R(x, y)'], conclusion: '∃y ∀x R(x, y)' }, { proofMaxNodes: 1, maxDomain: 0 });
  assert.equal(result.valid, null);
  const md = buildMarkdown(result, {}, { now: fixedNow });
  assert.match(md, /判定结果：尚未判定/);
  assert.match(md, /搜索边界/);
  assert.match(md, /未找到自然演绎证明不等于无效/);
  assert.ok(!md.includes('判定结果：无效'));
});

test('first-order proofs and finite countermodels are included when available', () => {
  const valid = analyzeArgument({ premises: ['∀x (P(x) → Q(x))', '∀x P(x)'], conclusion: '∀x Q(x)' });
  assert.match(buildMarkdown(valid), /自然演绎证明/);
  const invalid = analyzeArgument({ premises: ['∃x P(x)'], conclusion: '∀x P(x)' });
  const md = buildMarkdown(invalid);
  assert.match(md, /有限反例模型/);
  assert.match(md, /论域：d0, d1/);
  assert.match(md, /判定结果：无效/);
});

test('truth-table dimensions are 2^variables rows, not a fixed 16 by 16 grid', () => {
  const result = analyzeArgument({ premises: ['P → Q', 'R → S'], conclusion: 'P → S' });
  const size = truthTableDimensions(result);
  assert.deepEqual(size, { rows: 16, columns: 9, variables: 4, premises: 2 });
  assert.match(truthTableSizeText(result), /16 行 × 9 列/);
  const two = analyzeArgument({ premises: ['P'], conclusion: 'P' });
  assert.equal(truthTableDimensions(two).rows, 2);
});

test('HTML documents escape user meanings and include verdict evidence', () => {
  const result = analyzeArgument({ premises: ['P → Q', 'Q'], conclusion: 'P' });
  const html = buildHtml(result, { P: '<script>alert(1)</script>' }, { now: fixedNow });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /判定结果：<strong>无效<\/strong>/);
  assert.match(html, /<table>/);
});

test('document builder selects format, extension, mime and filename', () => {
  const result = analyzeArgument({ premises: ['P'], conclusion: 'P' });
  const md = buildDocument(result, {}, 'markdown', { now: fixedNow });
  assert.equal(md.extension, 'md');
  assert.match(md.mime, /text\/markdown/);
  assert.equal(md.filename, 'logic-argument-valid-20261031T070102Z.md');
  const html = buildDocument(result, {}, 'html', { now: fixedNow });
  assert.equal(html.extension, 'html');
  assert.match(html.content, /<!doctype html>/);
  const text = buildDocument(result, {}, 'text', { now: fixedNow });
  assert.equal(text.extension, 'txt');
  assert.throws(() => buildDocument(result, {}, 'exe'), /未知文档格式/);
  assert.throws(() => buildDocument(null), /请先验证/);
  assert.equal(documentFilename(result, 'html', fixedNow), 'logic-argument-valid-20261031T070102Z.html');
});
