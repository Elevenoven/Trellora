import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { DOMParser } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';

const bundle = path.resolve('scripts/.verify-selection-expansion-adaptive.cjs');
const rendererBundle = path.resolve('scripts/.verify-selection-expansion-locator.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
try {
  await build({ stdin: { contents: `
    export * from './shared/selectionExpansionPolicy';
    export * from './electron/knowledge/selectionEditLocator';
    export * from './electron/knowledge/currentNoteSnapshot';
    export * from './electron/knowledge/selectionExpansionContext';
    export { resolveAiModelDescriptor, resolveThinkingOptions } from './electron/knowledge/aiModelCapabilities';
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const api = await import(pathToFileURL(bundle).href);
  assert.equal(api.countMeaningfulCharacters('中 😀 \r\n文'), 3);
  assert.equal(api.countFullNoteCharacters('中\r\n😀'), 3);
  assert.equal(api.resolveExpansionTarget('中 文'), 4);
  assert.throws(() => api.resolveExpansionTarget('中文', 2), /必须大于/);
  assert.equal(api.createSelectionLengthReceipt('原文', '正文', 10).minimumCharacters, 8);
  const qwen = { kind: 'openai-compatible', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-flash' };
  const deepseek = { kind: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' };
  for (const config of [qwen, deepseek]) {
    const mode = api.resolveExpansionThinkingMode(config, config.model);
    assert.equal(mode, 'simple');
    const options = api.resolveThinkingOptions(api.resolveAiModelDescriptor(config, config.model), mode);
    assert.deepEqual(options, config === qwen ? { enable_thinking: false } : { thinking: { type: 'disabled' } });
  }
  const markdown = '# 背景\n\n同样**文字**。\n\n# 扩写位置\n\n同样**文字**。\n';
  const snapshot = api.createCurrentNoteSnapshot({ libraryPath: path.resolve('fixtures'), notePath: path.resolve('fixtures/定位.md'), title: '定位', contentHash: hash(markdown), markdown, headings: [], revision: 1 });
  const selectedText = '同样文字。';
  const capture = { editorSessionId: 'test', docRevision: 1, from: 15, to: 20, textOffset: '背景同样文字。扩写位置'.length,
    documentTextHash: hash('背景同样文字。扩写位置同样文字。'), selectedTextHash: hash(selectedText), canonicalSliceJson: 'null', markdownFragment: '**文字**',
    selectionStructureSignature: 'test', documentStructureSignature: 'test', blockKinds: ['paragraph'], rect: { left: 0, top: 0, right: 1, bottom: 1 } };
  const located = api.locateSelectionInSnapshot(snapshot, selectedText, api.validateSelectionLocatorCapture(capture));
  assert.equal(located.lineFrom, 7, '重复文本必须定位到选中出现处');
  assert.equal(located.lineTo, 7);
  assert.throws(() => api.locateSelectionInSnapshot(snapshot, selectedText, { ...capture, documentTextHash: hash('changed') }), /无法确认/);
  assert.throws(() => api.validateSelectionLocatorCapture({ ...capture, textOffset: -1 }), /坐标/);
  for (const size of [11999, 12000, 12001]) {
    const markdown = '# 正文\n' + '原'.repeat(size - 5);
    const source = api.createCurrentNoteSnapshot({ libraryPath: path.resolve('fixtures'), notePath: path.resolve('fixtures/全文.md'), title: '全文', contentHash: hash(markdown), markdown, headings: [], revision: 1 });
    const context = api.collectExpansionSnapshotContext(source, ['goal-1', 'goal-2']);
    assert.equal(context.receipt.fullNoteCharacters, size);
    assert.equal(context.receipt.fullNoteIncluded, size <= 12000);
    if (size <= 12000) {
      assert.equal(context.evidence[0].content, markdown, '超过 8000 字符的全文必须保持完整');
      assert.deepEqual(context.evidence[0].goalIds, ['goal-1', 'goal-2']);
    } else assert.deepEqual(context.evidence, []);
  }
  const longLines = Array.from({ length: 250 }, (_, i) => `段落${i}\n`).join('\n');
  const linesSnapshot = api.createCurrentNoteSnapshot({ libraryPath: path.resolve('fixtures'), notePath: path.resolve('fixtures/多行.md'), title: '多行', contentHash: hash(longLines), markdown: longLines, headings: [], revision: 1 });
  assert.equal(api.collectExpansionSnapshotContext(linesSnapshot, []).evidence[0].content, longLines, '全文不能受 200 行工具上限截断');
  assert.equal(api.resolveSelectionExpansionMode(), 'adaptive');
  assert.equal(api.resolveSelectionExpansionMode('legacy'), 'legacy');
  await build({ stdin: { contents: `
    export * from './src/editor/selectionActions';
    export { contentToEditorHtml } from './src/utils/markdown';
    export { FormulaBlock } from './src/editor/formulaBlock';
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: rendererBundle, logLevel: 'silent' });
  const renderer = await import(pathToFileURL(rendererBundle).href);
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const schema = getSchema([StarterKit, Link, Table, TableCell, TableHeader, TableRow, renderer.FormulaBlock]);
  for (const rich of [
    '# 说明\n\n**同样文字。**\n\n- 第一条\n- [链接](https://example.test)\n\n> 引用\n\n```ts\nconst a = 1;\n```\n\n**同样文字。**',
    '| 产物 | 说明 |\n| --- | --- |\n| blocks | 结构块 |\n\n同样文字。',
    '$$\na_i = b_{i+1}\n$$\n\n同样文字。',
    '---\ntitle: 中文标题\n---\n\n同样文字。',
    '[[其他笔记|可见别名]]\n\n同样文字。',
  ]) {
    const html = document.createElement('div'); html.innerHTML = renderer.contentToEditorHtml(rich);
    const doc = DOMParser.fromSchema(schema).parse(html);
    let from = 0;
    doc.descendants((node, position) => { if (node.isText && node.text === selectedText) from = position; });
    assert.ok(from);
    const editor = { schema, state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, from, from + selectedText.length) }), view: { coordsAtPos: () => ({ left: 0, top: 0, right: 1, bottom: 1 }) } };
    const selection = renderer.createSelectionExpansionSnapshot({ editor, editorSessionId: 'rich', currentPath: 'rich.md', docRevision: 1 });
    const capture = await renderer.createSelectionLocatorCapture(selection);
    const source = api.createCurrentNoteSnapshot({ libraryPath: path.resolve('fixtures'), notePath: path.resolve('fixtures/rich.md'), title: 'rich', contentHash: hash(rich), markdown: rich, headings: [], revision: 1 });
    assert.equal(api.locateSelectionInSnapshot(source, selectedText, capture).lineFrom, rich.split('\n').findLastIndex((line) => line.includes(selectedText)) + 1);
  }
  console.log('Adaptive expansion stages 1–2 passed: Unicode counts, locator, 11999/12000/12001 boundary, complete large/multiline source and rollback.');
} finally { delete globalThis.window; delete globalThis.document; await Promise.all([fs.rm(bundle, { force: true }), fs.rm(rendererBundle, { force: true })]); }
