import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-wiki-workspace');
await build({
  entryPoints: {
    state: path.join(rootDir, 'src', 'wiki', 'wikiViewState.ts'),
    layout: path.join(rootDir, 'src', 'wiki', 'wikiLayout.ts'),
    outline: path.join(rootDir, 'electron', 'wikiOutline.ts'),
  },
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

const state = await import(pathToFileURL(path.join(outDir, 'state.js')).href);
const layout = await import(pathToFileURL(path.join(outDir, 'layout.js')).href);
const outline = await import(pathToFileURL(path.join(outDir, 'outline.js')).href);

const structurePath = path.join(outDir, 'structure.jsonl');
await fs.writeFile(structurePath, `${[
  { nodeId: 'n-root', parentId: null, type: 'DOCUMENT_ROOT', text: 'doc-real', firstLineNo: 0 },
  { nodeId: 'n-title', parentId: 'n-root', type: 'DOCUMENT_TITLE', text: '真实索引文档', firstLineNo: 0 },
  { nodeId: 'n-chapter', parentId: 'n-title', type: 'HEADING', text: '第一章 接入流程', firstLineNo: 3 },
  { nodeId: 'n-body', parentId: 'n-chapter', type: 'BODY', text: '这是来自结构树的正文。', firstLineNo: 4 },
  { nodeId: 'n-section', parentId: 'n-chapter', type: 'HEADING', text: '1.1 前置检查', firstLineNo: 7 },
  { nodeId: 'n-section-2', parentId: 'n-chapter', type: 'HEADING', text: '1.2 接入验证', firstLineNo: 9 },
  { nodeId: 'n-chapter-2', parentId: 'n-title', type: 'HEADING', text: '第二章 验收流程', firstLineNo: 12 },
].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
const realOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-real',
  documentName: 'fallback.md',
  contentHash: 'content-hash-real',
  structurePath,
  updatedAt: '2026-08-31T00:00:00.000Z',
});
assert.equal(realOutline.title, '真实索引文档');
assert.equal(realOutline.nodes.length, 5);
assert.equal(realOutline.nodes[1].parentId, realOutline.nodes[0].id);
assert.equal(realOutline.nodes[2].parentId, realOutline.nodes[1].id);
assert.match(realOutline.nodes[1].markdown, /来自结构树的正文/);
const rootNodeId = realOutline.nodes[0].id;
const initialRootOrder = realOutline.nodes
  .filter((node) => node.parentId === rootNodeId)
  .sort((left, right) => left.order - right.order)
  .map((node) => node.id);
assert.equal(initialRootOrder.length, 2);
assert.ok(realOutline.orderRevisions[rootNodeId]);

const slicedStructurePath = path.join(outDir, 'structure-sliced.jsonl');
await fs.writeFile(slicedStructurePath, `${[
  { nodeId: 'n-root', parentId: null, type: 'DOCUMENT_ROOT', text: 'doc-sliced', firstLineNo: 0 },
  { nodeId: 'n-title', parentId: 'n-root', type: 'DOCUMENT_TITLE', text: '真实索引文档', firstLineNo: 1 },
  { nodeId: 'n-chapter', parentId: 'n-title', type: 'HEADING', text: '第一章 接入流程', firstLineNo: 2 },
  { nodeId: 'n-body', parentId: 'n-chapter', type: 'BODY', text: '正文保留原始换行。', firstLineNo: 3 },
  { nodeId: 'n-section', parentId: 'n-chapter', type: 'HEADING', text: '1.1 前置检查', firstLineNo: 7 },
  { nodeId: 'n-section-body', parentId: 'n-section', type: 'BODY', text: '检查项内容', firstLineNo: 8 },
  { nodeId: 'n-empty', parentId: 'n-title', type: 'HEADING', text: '第二章 空章节', firstLineNo: 9 },
  { nodeId: 'n-empty-child', parentId: 'n-empty', type: 'HEADING', text: '2.1 子节', firstLineNo: 10 },
  { nodeId: 'n-empty-child-body', parentId: 'n-empty-child', type: 'BODY', text: '子节正文。', firstLineNo: 11 },
  { nodeId: 'n-list', parentId: 'n-title', type: 'HEADING', text: '第三章 列表', firstLineNo: 12 },
  { nodeId: 'n-list-item', parentId: 'n-list', type: 'LIST_ITEM', text: '- 顶层项', firstLineNo: 13, indent: 0 },
  { nodeId: 'n-list-nested', parentId: 'n-list-item', type: 'LIST_ITEM', text: '- 嵌套项', firstLineNo: 14, indent: 2 },
  { nodeId: 'n-blocks', parentId: 'n-title', type: 'HEADING', text: '第四章 块结构', firstLineNo: 15 },
  { nodeId: 'n-table-1', parentId: 'n-blocks', type: 'TABLE_ROW', text: '| 列A | 列B |', firstLineNo: 16 },
  { nodeId: 'n-table-2', parentId: 'n-blocks', type: 'TABLE_ROW', text: '| --- | --- |', firstLineNo: 17 },
  { nodeId: 'n-table-3', parentId: 'n-blocks', type: 'TABLE_ROW', text: '| 1 | 2 |', firstLineNo: 18 },
  { nodeId: 'n-quote', parentId: 'n-blocks', type: 'QUOTE', text: '> 引用一行', firstLineNo: 22 },
].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
// Parse artifacts compact blank lines away; the line layout records where they were.
const slicedMarkdownPath = path.join(outDir, 'document-sliced.md');
await fs.writeFile(slicedMarkdownPath, [
  '# 真实索引文档',
  '## 第一章 接入流程',
  '正文保留原始换行。',
  '```ini',
  'HMM = false',
  '```',
  '### 1.1 前置检查',
  '检查项内容',
  '## 第二章 空章节',
  '### 2.1 子节',
  '子节正文。',
  '## 第三章 列表',
  '- 顶层项',
  '  - 嵌套项',
  '## 第四章 块结构',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '```text',
  '代码行',
  '```',
  '> 引用一行',
  '',
].join('\n'), 'utf8');
const slicedLayoutPath = path.join(outDir, 'line-layout-sliced.jsonl');
await fs.writeFile(slicedLayoutPath, `${[
  { schemaVersion: 1, lineNo: 1, blankBefore: false },
  { schemaVersion: 1, lineNo: 2, blankBefore: true },
  { schemaVersion: 1, lineNo: 3, blankBefore: true },
  { schemaVersion: 1, lineNo: 4, blankBefore: true },
  { schemaVersion: 1, lineNo: 5, blankBefore: false },
  { schemaVersion: 1, lineNo: 6, blankBefore: false },
  { schemaVersion: 1, lineNo: 7, blankBefore: true },
  { schemaVersion: 1, lineNo: 8, blankBefore: false },
  { schemaVersion: 1, lineNo: 9, blankBefore: true },
  { schemaVersion: 1, lineNo: 10, blankBefore: true },
  { schemaVersion: 1, lineNo: 11, blankBefore: true },
  { schemaVersion: 1, lineNo: 12, blankBefore: true },
  { schemaVersion: 1, lineNo: 13, blankBefore: true },
  { schemaVersion: 1, lineNo: 14, blankBefore: false },
  { schemaVersion: 1, lineNo: 15, blankBefore: true },
  { schemaVersion: 1, lineNo: 16, blankBefore: true },
  { schemaVersion: 1, lineNo: 17, blankBefore: true },
  { schemaVersion: 1, lineNo: 18, blankBefore: true },
  { schemaVersion: 1, lineNo: 19, blankBefore: true },
  { schemaVersion: 1, lineNo: 20, blankBefore: true },
  { schemaVersion: 1, lineNo: 21, blankBefore: true },
  { schemaVersion: 1, lineNo: 22, blankBefore: true },
].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
const slicedOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-sliced',
  documentName: 'sliced.md',
  contentHash: 'content-hash-sliced',
  structurePath: slicedStructurePath,
  markdownPath: slicedMarkdownPath,
  lineLayoutPath: slicedLayoutPath,
  updatedAt: '2026-08-31T00:00:00.000Z',
});
const slicedNodeById = new Map(slicedOutline.nodes.map((node) => [node.id, node]));
assert.equal(
  slicedNodeById.get('wiki:doc-sliced:n-root')?.markdown,
  [
    '# 真实索引文档', '',
    '## 第一章 接入流程', '', '正文保留原始换行。', '', '```ini', 'HMM = false', '```', '',
    '### 1.1 前置检查', '检查项内容', '',
    '## 第二章 空章节', '', '### 2.1 子节', '', '子节正文。', '',
    '## 第三章 列表', '', '- 顶层项', '  - 嵌套项', '',
    '## 第四章 块结构', '', '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '', '```text', '代码行', '```', '', '> 引用一行',
  ].join('\n'),
  'A body-less root must render the whole document',
);
assert.equal(
  slicedNodeById.get('wiki:doc-sliced:n-chapter')?.markdown,
  [
    '## 第一章 接入流程', '', '正文保留原始换行。', '', '```ini', 'HMM = false', '```', '',
    '### 1.1 前置检查', '检查项内容',
  ].join('\n'),
  'A chapter must render its own Markdown followed by its complete descendant subtree',
);
assert.equal(
  slicedNodeById.get('wiki:doc-sliced:n-section')?.markdown,
  ['### 1.1 前置检查', '检查项内容'].join('\n'),
  'A section slice must stop before the next heading',
);
assert.equal(
  slicedNodeById.get('wiki:doc-sliced:n-empty')?.markdown,
  ['## 第二章 空章节', '', '### 2.1 子节', '', '子节正文。'].join('\n'),
  'A heading without own body must render its whole subtree',
);
assert.equal(
  slicedNodeById.get('wiki:doc-sliced:n-blocks')?.markdown,
  [
    '## 第四章 块结构', '',
    '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '',
    '```text', '代码行', '```', '',
    '> 引用一行',
  ].join('\n'),
  'Restored blank lines must never split table row runs or code fences',
);
const missingSourceOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-sliced',
  documentName: 'sliced.md',
  contentHash: 'content-hash-sliced',
  structurePath: slicedStructurePath,
  markdownPath: path.join(outDir, 'document-missing.md'),
  updatedAt: '2026-08-31T00:00:00.000Z',
});
assert.match(
  missingSourceOutline.nodes.find((node) => node.id === 'wiki:doc-sliced:n-chapter')?.markdown ?? '',
  /正文保留原始换行。/,
  'A missing document.md must fall back to structure-tree synthesis',
);
assert.equal(
  missingSourceOutline.nodes.find((node) => node.id === 'wiki:doc-sliced:n-chapter')?.markdown,
  ['# 第一章 接入流程', '', '正文保留原始换行。', '', '## 1.1 前置检查', '', '检查项内容'].join('\n'),
  'The synthesis fallback must retain descendant headings as well as their bodies',
);
assert.match(
  missingSourceOutline.nodes.find((node) => node.id === 'wiki:doc-sliced:n-empty')?.markdown ?? '',
  /子节正文。/,
  'The synthesis fallback must also expand body-less chapters into their subtree',
);
assert.equal(
  missingSourceOutline.nodes.find((node) => node.id === 'wiki:doc-sliced:n-list')?.markdown,
  ['# 第三章 列表', '', '- 顶层项', '  - 嵌套项'].join('\n'),
  'Synthesized list items must keep their original marker once and restore nesting',
);
assert.equal(
  missingSourceOutline.nodes.find((node) => node.id === 'wiki:doc-sliced:n-blocks')?.markdown,
  ['# 第四章 块结构', '', '| 列A | 列B |', '| --- | --- |', '| 1 | 2 |', '> 引用一行'].join('\n'),
  'Synthesized quotes must keep their original marker once and tables stay contiguous',
);

const recursiveStructurePath = path.join(outDir, 'structure-recursive.jsonl');
await fs.writeFile(recursiveStructurePath, `${[
  { nodeId: 'n-root', parentId: null, type: 'DOCUMENT_ROOT', text: 'doc-recursive', firstLineNo: 0 },
  { nodeId: 'n-title', parentId: 'n-root', type: 'DOCUMENT_TITLE', text: '递归章节文档', firstLineNo: 1 },
  { nodeId: 'n-chapter', parentId: 'n-title', type: 'HEADING', text: '第三章 阶段产物与可用性', firstLineNo: 2 },
  { nodeId: 'n-chapter-body', parentId: 'n-chapter', type: 'BODY', text: '这是第三章自身的正文。', firstLineNo: 3 },
  { nodeId: 'n-section-1', parentId: 'n-chapter', type: 'HEADING', text: '3.1 检查点选择', firstLineNo: 4 },
  { nodeId: 'n-section-1-body', parentId: 'n-section-1', type: 'BODY', text: '3.1 的正文。', firstLineNo: 5 },
  { nodeId: 'n-section-1-1', parentId: 'n-section-1', type: 'HEADING', text: '3.1.1 嵌套检查', firstLineNo: 6 },
  { nodeId: 'n-section-1-1-body', parentId: 'n-section-1-1', type: 'BODY', text: '3.1.1 的正文。', firstLineNo: 7 },
  { nodeId: 'n-section-2', parentId: 'n-chapter', type: 'HEADING', text: '3.2 相邻上下文约束', firstLineNo: 8 },
  { nodeId: 'n-section-2-body', parentId: 'n-section-2', type: 'BODY', text: '3.2 的正文。', firstLineNo: 9 },
  { nodeId: 'n-section-3', parentId: 'n-chapter', type: 'HEADING', text: '3.3 收尾验收', firstLineNo: 10 },
  { nodeId: 'n-section-3-body', parentId: 'n-section-3', type: 'BODY', text: '3.3 的正文。', firstLineNo: 11 },
  { nodeId: 'n-sibling', parentId: 'n-title', type: 'HEADING', text: '第四章 同级章节', firstLineNo: 12 },
  { nodeId: 'n-sibling-body', parentId: 'n-sibling', type: 'BODY', text: '同级章节正文不得出现。', firstLineNo: 13 },
].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
const recursiveMarkdownPath = path.join(outDir, 'document-recursive.md');
await fs.writeFile(recursiveMarkdownPath, [
  '# 递归章节文档',
  '## 第三章 阶段产物与可用性',
  '这是第三章自身的正文。',
  '### 3.1 检查点选择',
  '3.1 的正文。',
  '#### 3.1.1 嵌套检查',
  '3.1.1 的正文。',
  '### 3.2 相邻上下文约束',
  '3.2 的正文。',
  '### 3.3 收尾验收',
  '3.3 的正文。',
  '## 第四章 同级章节',
  '同级章节正文不得出现。',
  '',
].join('\n'), 'utf8');
const recursiveOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-recursive',
  documentName: 'recursive.md',
  contentHash: 'content-hash-recursive',
  structurePath: recursiveStructurePath,
  markdownPath: recursiveMarkdownPath,
  updatedAt: '2026-09-07T00:00:00.000Z',
});
const recursiveChapter = recursiveOutline.nodes.find((node) => node.id === 'wiki:doc-recursive:n-chapter');
assert.equal(
  recursiveChapter?.markdown,
  [
    '## 第三章 阶段产物与可用性', '这是第三章自身的正文。',
    '### 3.1 检查点选择', '3.1 的正文。',
    '#### 3.1.1 嵌套检查', '3.1.1 的正文。',
    '### 3.2 相邻上下文约束', '3.2 的正文。',
    '### 3.3 收尾验收', '3.3 的正文。',
  ].join('\n'),
  'A parent chapter must include its body and all recursively nested child sections in source order',
);
assert.doesNotMatch(recursiveChapter?.markdown ?? '', /第四章 同级章节|同级章节正文不得出现/u);
const recursiveFallbackOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-recursive',
  documentName: 'recursive.md',
  contentHash: 'content-hash-recursive',
  structurePath: recursiveStructurePath,
  markdownPath: path.join(outDir, 'document-recursive-missing.md'),
  updatedAt: '2026-09-07T00:00:00.000Z',
});
assert.equal(
  recursiveFallbackOutline.nodes.find((node) => node.id === 'wiki:doc-recursive:n-chapter')?.markdown,
  [
    '# 第三章 阶段产物与可用性', '', '这是第三章自身的正文。','',
    '## 3.1 检查点选择', '', '3.1 的正文。','',
    '### 3.1.1 嵌套检查', '', '3.1.1 的正文。','',
    '## 3.2 相邻上下文约束', '', '3.2 的正文。','',
    '## 3.3 收尾验收', '', '3.3 的正文。',
  ].join('\n'),
  'The synthesized fallback must preserve the same complete subtree and heading hierarchy',
);

const chapterNodeId = realOutline.nodes[1].id;
const initialChapterOrder = realOutline.nodes
  .filter((node) => node.parentId === chapterNodeId)
  .sort((left, right) => left.order - right.order)
  .map((node) => node.id);
const concurrentLibraryPath = await fs.mkdtemp(path.join(outDir, 'order-concurrent-'));
const concurrentResults = await Promise.all([
  outline.reorderWikiSiblingNodes({
    libraryPath: concurrentLibraryPath,
    outline: realOutline,
    request: {
      documentId: realOutline.documentId,
      parentId: rootNodeId,
      orderedNodeIds: [...initialRootOrder].reverse(),
      expectedRevision: realOutline.orderRevisions[rootNodeId],
    },
  }),
  outline.reorderWikiSiblingNodes({
    libraryPath: concurrentLibraryPath,
    outline: realOutline,
    request: {
      documentId: realOutline.documentId,
      parentId: chapterNodeId,
      orderedNodeIds: [...initialChapterOrder].reverse(),
      expectedRevision: realOutline.orderRevisions[chapterNodeId],
    },
  }),
]);
assert.ok(concurrentResults.every((result) => result.ok), 'Concurrent branch saves must be serialized and merged');
const concurrentlyMergedOutline = outline.applyWikiSiblingOrderOverrides(concurrentLibraryPath, realOutline);
assert.deepEqual(
  concurrentlyMergedOutline.nodes.filter((node) => node.parentId === rootNodeId).sort((a, b) => a.order - b.order).map((node) => node.id),
  [...initialRootOrder].reverse(),
);
assert.deepEqual(
  concurrentlyMergedOutline.nodes.filter((node) => node.parentId === chapterNodeId).sort((a, b) => a.order - b.order).map((node) => node.id),
  [...initialChapterOrder].reverse(),
);

const orderLibraryPath = await fs.mkdtemp(path.join(outDir, 'order-library-'));
const reversedRootOrder = [...initialRootOrder].reverse();
const persistedOrder = await outline.reorderWikiSiblingNodes({
  libraryPath: orderLibraryPath,
  outline: realOutline,
  request: {
    documentId: realOutline.documentId,
    parentId: rootNodeId,
    orderedNodeIds: reversedRootOrder,
    expectedRevision: realOutline.orderRevisions[rootNodeId],
  },
  now: new Date('2026-09-01T00:00:00.000Z'),
});
assert.equal(persistedOrder.ok, true);
assert.ok(persistedOrder.ok && persistedOrder.revision !== realOutline.orderRevisions[rootNodeId]);

const restartedRawOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-real',
  documentName: 'fallback.md',
  contentHash: 'content-hash-real',
  structurePath,
  updatedAt: '2026-08-31T00:00:00.000Z',
});
const restartedOutline = outline.applyWikiSiblingOrderOverrides(orderLibraryPath, restartedRawOutline);
assert.deepEqual(
  restartedOutline.nodes
    .filter((node) => node.parentId === rootNodeId)
    .sort((left, right) => left.order - right.order)
    .map((node) => node.id),
  reversedRootOrder,
  'A fresh outline read must restore the persisted sibling order',
);

const staleRevisionResult = await outline.reorderWikiSiblingNodes({
  libraryPath: orderLibraryPath,
  outline: restartedRawOutline,
  request: {
    documentId: restartedRawOutline.documentId,
    parentId: rootNodeId,
    orderedNodeIds: initialRootOrder,
    expectedRevision: restartedRawOutline.orderRevisions[rootNodeId],
  },
});
assert.equal(staleRevisionResult.ok, false);
assert.equal(staleRevisionResult.error.code, 'WIKI_ORDER_CONFLICT');

const invalidSetResult = await outline.reorderWikiSiblingNodes({
  libraryPath: orderLibraryPath,
  outline: restartedRawOutline,
  request: {
    documentId: restartedRawOutline.documentId,
    parentId: rootNodeId,
    orderedNodeIds: [reversedRootOrder[0], realOutline.nodes[2].id],
    expectedRevision: restartedOutline.orderRevisions[rootNodeId],
  },
});
assert.equal(invalidSetResult.ok, false);
assert.equal(invalidSetResult.error.code, 'WIKI_ORDER_CONFLICT');

const changedSourceOutline = await outline.readWikiDocumentOutline({
  documentId: 'doc-real',
  documentName: 'fallback.md',
  contentHash: 'content-hash-changed',
  structurePath,
  updatedAt: '2026-09-01T01:00:00.000Z',
});
const changedSourceWithOverlay = outline.applyWikiSiblingOrderOverrides(orderLibraryPath, changedSourceOutline);
assert.deepEqual(
  changedSourceWithOverlay.nodes
    .filter((node) => node.parentId === rootNodeId)
    .sort((left, right) => left.order - right.order)
    .map((node) => node.id),
  initialRootOrder,
  'A source content hash change must invalidate the prior order overlay',
);

const unwritableLibraryPath = await fs.mkdtemp(path.join(outDir, 'order-unwritable-'));
await fs.writeFile(path.join(unwritableLibraryPath, '.menghan-meta'), 'not-a-directory', 'utf8');
const saveFailureResult = await outline.reorderWikiSiblingNodes({
  libraryPath: unwritableLibraryPath,
  outline: realOutline,
  request: {
    documentId: realOutline.documentId,
    parentId: rootNodeId,
    orderedNodeIds: reversedRootOrder,
    expectedRevision: realOutline.orderRevisions[rootNodeId],
  },
});
assert.equal(saveFailureResult.ok, false);
assert.equal(saveFailureResult.error.code, 'WIKI_ORDER_SAVE_FAILED');
await fs.rm(orderLibraryPath, { recursive: true, force: true });
await fs.rm(concurrentLibraryPath, { recursive: true, force: true });
await fs.rm(unwritableLibraryPath, { recursive: true, force: true });

const sourceRef = { sourceName: 'mock.md', headingId: 'root', updatedAt: '2026-08-30T00:00:00.000Z' };
const nodes = [
  createNode('root', null, 0, 0),
  createNode('chapter-a', 'root', 1, 1),
  createNode('chapter-b', 'root', 1, 2),
  createNode('chapter-a-1', 'chapter-a', 2, 1),
];

assert.equal(state.collectVisibleWikiNodes(nodes).length, 4);
assert.equal(state.collectVisibleWikiNodes(nodes.map((node) => node.id === 'chapter-a' ? { ...node, collapsed: true } : node)).length, 3);
assert.deepEqual(state.getWikiNodePath(nodes, 'chapter-a-1').map((node) => node.id), ['root', 'chapter-a', 'chapter-a-1']);
assert.deepEqual(
  state.collectWikiSelectionBranchIds(nodes, 'chapter-a-1'),
  ['root', 'chapter-a', 'chapter-a-1'],
  'Selecting a leaf must keep its complete incoming path visible',
);
assert.deepEqual(
  state.collectWikiSelectionBranchIds(nodes, 'chapter-a'),
  ['root', 'chapter-a', 'chapter-a-1'],
  'Selecting a branch must include both its ancestors and descendants',
);
assert.deepEqual(state.getOrderedWikiSiblingIds(nodes, 'root'), ['chapter-a', 'chapter-b']);
const reorderedNodes = state.reorderWikiSiblings(nodes, 'root', ['chapter-b', 'chapter-a']);
assert.deepEqual(state.getOrderedWikiSiblingIds(reorderedNodes, 'root'), ['chapter-b', 'chapter-a']);
assert.deepEqual(state.collectWikiSiblingOrderChanges(nodes, reorderedNodes), [{
  parentId: 'root',
  previousOrderedNodeIds: ['chapter-a', 'chapter-b'],
  orderedNodeIds: ['chapter-b', 'chapter-a'],
}]);
assert.throws(
  () => state.reorderWikiSiblings(nodes, 'root', ['chapter-a', 'chapter-a-1']),
  /章节结构已变化/,
  'Cross-parent drops must be rejected instead of changing hierarchy',
);
const cancelledReorderNodes = state.reorderWikiSiblings(reorderedNodes, 'root', ['chapter-a', 'chapter-b']);
assert.deepEqual(
  state.getOrderedWikiSiblingIds(cancelledReorderNodes, 'root'),
  state.getOrderedWikiSiblingIds(nodes, 'root'),
  'Cancelling reorder must be able to restore the baseline sibling order',
);
assert.deepEqual(state.collectWikiSiblingOrderChanges(nodes, cancelledReorderNodes), []);

const job = {
  id: 'job-1',
  operationId: 'op-1',
  status: 'running',
  stage: '开始',
  progress: 0,
  etaSeconds: 30,
  tasks: [{ id: 'task-a', chapterNodeId: 'chapter-a', title: 'A', status: 'queued', progress: 0, stage: '等待' }],
};
const snapshot = {
  document: { id: 'doc', title: 'Doc', sourceName: 'mock.md', description: '', updatedAt: sourceRef.updatedAt, nodeCount: nodes.length },
  mode: 'auto',
  nodes,
  orderPersistence: 'session',
  siblingOrderRevisions: { root: 'mock-root-0' },
  generationJob: job,
  nodeAi: {},
};
const nextSnapshot = state.reduceWikiEvent(snapshot, {
  type: 'task-updated',
  operationId: 'op-1',
  seq: 2,
  timestamp: sourceRef.updatedAt,
  task: { ...job.tasks[0], status: 'running', progress: 56, stage: '分析中' },
});
assert.equal(nextSnapshot.generationJob.progress, 56);
assert.equal(nextSnapshot.generationJob.tasks[0].status, 'running');
const retrievalSnapshot = state.reduceWikiEvent(snapshot, {
  type: 'retrieval-updated',
  operationId: 'op-scope',
  seq: 3,
  timestamp: sourceRef.updatedAt,
  nodeId: 'chapter-a',
  retrieval: {
    phase: 'searching', scopeMode: 'node-first', currentCycle: 2, maxRetrievalCycles: 5,
    activeRange: 'document', searchedSections: [], localSearchCount: 1, documentSearchCount: 1,
    escalationReason: 'local-no-hit',
  },
});
assert.equal(retrievalSnapshot.nodeAi['chapter-a'].retrieval.currentCycle, 2);
assert.equal(retrievalSnapshot.nodeAi['chapter-a'].retrieval.activeRange, 'document');

const laidOut = layout.layoutWikiGraph(nodes);
const repeatedLayout = layout.layoutWikiGraph(nodes);
assert.deepEqual(repeatedLayout, laidOut, 'Wiki layout must be deterministic for the same ordered tree');
assert.equal(laidOut.nodes.length, nodes.length);
assert.equal(laidOut.edges.length, nodes.length - 1);
assertNoNodeOverlap(nodes, laidOut.nodes);
assertParentsCenteredOnChildren(nodes, laidOut.nodes);
assertSiblingSubtreesOrdered(nodes, laidOut.nodes);
const modelById = new Map(nodes.map((node) => [node.id, node]));
laidOut.edges.forEach((edge) => {
  const source = laidOut.nodes.find((node) => node.id === edge.source);
  const target = laidOut.nodes.find((node) => node.id === edge.target);
  assert.ok(source && target, `${edge.id} must connect laid-out nodes`);
  const curvePath = layout.createWikiCurvePath(
    source.position.x + layout.getWikiNodeSize(modelById.get(edge.source)).width,
    source.position.y + layout.getWikiNodeSize(modelById.get(edge.source)).height / 2,
    target.position.x,
    target.position.y + layout.getWikiNodeSize(modelById.get(edge.target)).height / 2,
  );
  assert.match(curvePath, /^M [-\d.]+ [-\d.]+ C /, `${edge.id} must render as a smooth cubic curve`);
});

const basePositionById = new Map(laidOut.nodes.map((node) => [node.id, node.position]));
const rootBase = basePositionById.get('root');
const wholeTreeDrag = layout.applyWikiBranchDrag(
  nodes,
  laidOut.nodes,
  'root',
  rootBase,
  { x: rootBase.x + 12, y: rootBase.y + 60 },
);
wholeTreeDrag.forEach((node) => {
  const base = basePositionById.get(node.id);
  assert.equal(node.position.x - base.x, 12, 'Dragging the root must translate the whole tree horizontally');
  assert.equal(node.position.y - base.y, 60, 'Dragging the root must translate the whole tree vertically');
});

const leafBase = basePositionById.get('chapter-a-1');
const leafDrag = layout.applyWikiBranchDrag(
  nodes,
  laidOut.nodes,
  'chapter-a-1',
  leafBase,
  { x: leafBase.x, y: leafBase.y - 40 },
);
const leafPositionById = new Map(leafDrag.map((node) => [node.id, node.position]));
const draggedLeaf = leafPositionById.get('chapter-a-1');
const recentredParent = leafPositionById.get('chapter-a');
assert.equal(draggedLeaf.y, leafBase.y - 40);
assert.equal(
  recentredParent.y + layout.getWikiNodeSize(modelById.get('chapter-a')).height / 2,
  draggedLeaf.y + layout.getWikiNodeSize(modelById.get('chapter-a-1')).height / 2,
  'A single-child parent must stay vertically centred on its child after a drag',
);
assert.equal(
  leafPositionById.get('chapter-b').y,
  basePositionById.get('chapter-b').y,
  'Unrelated branches must not move during recentering',
);
assertParentsCenteredOnChildren(nodes, leafDrag);

let slowestLayoutMs = 0;
for (const nodeCount of [1, 7, 30, 100]) {
  const fixtureNodes = createLayoutFixture(nodeCount);
  const startedAt = performance.now();
  const fixtureLayout = layout.layoutWikiGraph(fixtureNodes);
  const repeatedFixtureLayout = layout.layoutWikiGraph(fixtureNodes);
  slowestLayoutMs = Math.max(slowestLayoutMs, performance.now() - startedAt);
  assert.equal(fixtureLayout.nodes.length, nodeCount);
  assert.deepEqual(repeatedFixtureLayout, fixtureLayout, `${nodeCount}-node Wiki layout must be deterministic`);
  assertNoNodeOverlap(fixtureNodes, fixtureLayout.nodes);
  assertParentsCenteredOnChildren(fixtureNodes, fixtureLayout.nodes);
  assertSiblingSubtreesOrdered(fixtureNodes, fixtureLayout.nodes);
}

const [mapCanvas, mapNode, mapEdge, layoutSource, view, documentList, toolbar, assistantTab, agentDataSource, wikiAgentTurn, preload, main, navRail, app, css] = await Promise.all([
  read('src/components/wiki/WikiMapCanvas.tsx'),
  read('src/components/wiki/WikiMapNode.tsx'),
  read('src/components/wiki/WikiCurveEdge.tsx'),
  read('src/wiki/wikiLayout.ts'),
  read('src/components/wiki/WikiView.tsx'),
  read('src/components/wiki/WikiDocumentListPane.tsx'),
  read('src/components/wiki/WikiToolbar.tsx'),
  read('src/components/wiki/WikiAssistantTab.tsx'),
  read('src/wiki/wikiElectronAgentDataSource.ts'),
  read('electron/wiki/wikiNodeAgentTurn.ts'),
  read('electron/preload.ts'),
  read('electron/main.ts'),
  read('src/components/NavRail.tsx'),
  read('src/App.tsx'),
  read('src/styles/variables.css'),
]);
assert.match(mapCanvas, /nodesDraggable=\{!reorderSaving\}/);
assert.match(mapCanvas, /freelyDraggable/);
assert.match(mapCanvas, /onNodeDragStart/);
assert.match(mapCanvas, /applyWikiBranchDrag/);
assert.match(mapCanvas, /onNodeSizeMeasured/);
assert.match(mapCanvas, /PLACEHOLDER_NODE_ID/);
assert.match(mapCanvas, /onCancelReorder/);
assert.match(mapCanvas, /disableKeyboardA11y/);
assert.match(mapCanvas, /deleteKeyCode=\{null\}/);
assert.match(mapCanvas, /onNodeContextMenu/);
assert.match(mapCanvas, /MiniMap/);
assert.match(
  mapCanvas,
  /node\.position\.x \+ nodeSize\.width \+ HORIZONTAL_DRAG_TOLERANCE/,
  '调整顺序的右侧拖拽边界必须包含节点宽度，避免模式切换时被画布自动夹到左侧。',
);
assert.match(mapCanvas, /useUpdateNodeInternals/);
assert.match(mapCanvas, /ResizeObserver/);
assert.match(mapCanvas, /elementsSelectable=\{false\}/);
assert.doesNotMatch(mapCanvas, /onEdgesChange=/);
assert.match(mapNode, /Alt \+ ↑\/↓|event\.altKey/);
assert.match(mapNode, /isConnectable=\{false\}/);
assert.match(mapEdge, /createWikiCurvePath/);
assert.match(mapEdge, /wiki-map-edge/);
assert.doesNotMatch(layoutSource, /elkjs/);
assert.match(layoutSource, /layoutWikiTree/);
assert.match(mapNode, /ResizeObserver/);
assert.match(view, /ResizeObserver/);
assert.match(view, /WikiSplitPane/);
assert.match(view, /listWikiKnowledgeBases/);
assert.match(view, /sidebarMode/);
assert.match(
  view,
  /const handleLibraryChange = useCallback\([\s\S]*?setOutlineOpen\(true\)[\s\S]*?setLibraryPath\(nextLibraryPath\)/,
  '切换知识库时必须自动打开左侧文档列表。',
);
assert.match(view, /reorderBaselineRef/);
assert.match(view, /reorderElectronWikiSiblingNodes/);
assert.match(view, /未保存的分支已恢复原顺序/);
assert.match(documentList, /outlineState/);
assert.match(documentList, /已索引文档/);
assert.match(toolbar, /选择知识库/);
assert.match(toolbar, /SegmentedControl/);
assert.match(toolbar, /调整顺序/);
assert.match(toolbar, /浏览模式可自由拖动节点/);
assert.match(assistantTab, /useAssistantAttachments/);
assert.match(assistantTab, /AssistantComposerAttachments/);
assert.match(assistantTab, /AssistantMessageAttachments/);
assert.match(assistantTab, /onPaste=\{handlePaste\}/);
assert.match(assistantTab, /证据航迹|WikiEvidenceTrail/);
assert.match(assistantTab, /(?:周期|t\("周期"\)\}) \{retrieval\.currentCycle\}\/\{retrieval\.maxRetrievalCycles\}/);
assert.match(assistantTab, /定位到来源章节/);
assert.match(view, /handleNavigateEvidenceNode/);
assert.match(agentDataSource, /scope: 'wiki-node'/);
assert.match(agentDataSource, /wikiScopeProgress/);
assert.match(agentDataSource, /wikiScopeResult/);
assert.match(agentDataSource, /\.\.\.\(attachments\.length \? \{ attachments \} : \{\}\)/);
assert.match(wikiAgentTurn, /parseAssistantDocumentAttachments\(request\.attachments/);
assert.match(wikiAgentTurn, /new AttachmentContextProvider\(request\.attachments, \{[\s\S]*?documentTextByAttachmentId: documentParseSession\.documentTextByAttachmentId,[\s\S]*?documentImagesByAttachmentId/u);
assert.match(wikiAgentTurn, /const turnImages = \[\.\.\.\(input\.images \?\? \[\]\)\]/, 'Wiki 必须先复制显式图片，再合并 PDF 派生图片。');
assert.ok((wikiAgentTurn.match(/\.\.\.\(turnImages\.length \? \{ images: turnImages \} : \{\}\)/g) ?? []).length >= 2, 'Wiki 原生工具链与降级链路都必须保留合并后的图片。');
assert.match(preload, /get-wiki-document-outline/);
assert.match(preload, /reorder-wiki-sibling-nodes/);
assert.match(main, /isStageManifestCurrent\(layout, 'tree'\)/);
assert.match(main, /applyWikiSiblingOrderOverrides/);
assert.match(main, /runWikiNodeAgentTurn\([\s\S]*?\.\.\.\(turnImages\.length \? \{ images: turnImages \} : \{\}\)/);
assert.match(navRail, /id: 'wiki'.*label: 'Wiki'/);
assert.match(navRail, /onClick=\{\(\) => onNavigate\(item\.id\)\}/);
assert.match(app, /mainView === 'wiki'/);
assert.match(css, /\.wiki-map-edge/);
assert.match(css, /\.wiki-map-edge\.settling\s*\{\s*transition:\s*none;/);
assert.match(css, /grid-template-columns: minmax\(0, var\(--wiki-primary-width\)\)/);
assert.match(css, /\.wiki-map-node:focus-visible[\s\S]*?box-shadow:/);
assert.match(css, /\.wiki-map-node\.reorder-enabled\s*\{\s*touch-action:\s*none;/);
assert.match(css, /\.wiki-map-canvas\.browse-mode \.react-flow__node\s*\{\s*cursor:\s*grab;/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.wiki-workspace \*[\s\S]*?transition-duration:\s*0\.01ms !important;/);
assert.match(css, /html,\s*body,\s*#root\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/);
assert.match(css, /\.app-shell\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/);
assert.doesNotMatch(css, /\.(?:app-shell|wiki-main-pane)\s*\{[^}]*(?:width|height):\s*100v[wh]/);

console.log(`Wiki workspace verification passed (${realOutline.nodes.length} real outline nodes, 1/7/30/100-node layouts, slowest ${slowestLayoutMs.toFixed(2)}ms)`);

function createNode(id, parentId, depth, order) {
  return {
    id,
    documentId: 'doc',
    parentId,
    title: id,
    order,
    depth,
    kind: 'source',
    status: 'idle',
    markdown: `# ${id}`,
    sourceRef: { ...sourceRef, headingId: id },
  };
}

function createLayoutFixture(nodeCount) {
  const fixtureNodes = [];
  for (let index = 0; index < nodeCount; index += 1) {
    const parent = index === 0 ? null : fixtureNodes[Math.floor((index - 1) / 4)];
    fixtureNodes.push({
      ...createNode(`stress-${index}`, parent?.id ?? null, parent ? parent.depth + 1 : 0, index === 0 ? 0 : ((index - 1) % 4) + 1),
      title: index % 6 === 0 ? `较长的章节标题 ${index}：用于验证固定节点尺寸下的稳定布局` : `章节 ${index}`,
    });
  }
  return fixtureNodes;
}

function assertNoNodeOverlap(modelNodes, layoutNodes) {
  const modelById = new Map(modelNodes.map((node) => [node.id, node]));
  for (let leftIndex = 0; leftIndex < layoutNodes.length; leftIndex += 1) {
    const left = layoutNodes[leftIndex];
    const leftSize = layout.getWikiNodeSize(modelById.get(left.id));
    for (let rightIndex = leftIndex + 1; rightIndex < layoutNodes.length; rightIndex += 1) {
      const right = layoutNodes[rightIndex];
      const rightSize = layout.getWikiNodeSize(modelById.get(right.id));
      const separated = left.position.x + leftSize.width <= right.position.x
        || right.position.x + rightSize.width <= left.position.x
        || left.position.y + leftSize.height <= right.position.y
        || right.position.y + rightSize.height <= left.position.y;
      assert.ok(separated, `${left.id} overlaps ${right.id}`);
    }
  }
}

function collectSubtreeBounds(modelNodes, layoutNodes) {
  const modelById = new Map(modelNodes.map((node) => [node.id, node]));
  const positionById = new Map(layoutNodes.map((node) => [node.id, node.position]));
  const childrenByParentId = new Map();
  modelNodes.forEach((node) => {
    if (!node.parentId || !modelById.has(node.parentId)) return;
    const children = childrenByParentId.get(node.parentId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentId, children);
  });
  const boundsById = new Map();
  const boundsOf = (nodeId) => {
    const cached = boundsById.get(nodeId);
    if (cached) return cached;
    const position = positionById.get(nodeId);
    const node = modelById.get(nodeId);
    if (!position || !node) return null;
    const bounds = { top: position.y, bottom: position.y + layout.getWikiNodeSize(node).height };
    boundsById.set(nodeId, bounds);
    for (const child of childrenByParentId.get(nodeId) ?? []) {
      const childBounds = boundsOf(child.id);
      if (!childBounds) continue;
      bounds.top = Math.min(bounds.top, childBounds.top);
      bounds.bottom = Math.max(bounds.bottom, childBounds.bottom);
    }
    return bounds;
  };
  modelNodes.forEach((node) => boundsOf(node.id));
  return { boundsById, childrenByParentId, modelById };
}

function assertParentsCenteredOnChildren(modelNodes, layoutNodes) {
  const { boundsById, childrenByParentId, modelById } = collectSubtreeBounds(modelNodes, layoutNodes);
  const positionById = new Map(layoutNodes.map((node) => [node.id, node.position]));
  childrenByParentId.forEach((children, parentId) => {
    const parent = modelById.get(parentId);
    const parentPosition = positionById.get(parentId);
    if (!parent || !parentPosition) return;
    const bounds = children.map((child) => boundsById.get(child.id)).filter(Boolean);
    if (bounds.length === 0) return;
    const spanCenter = (Math.min(...bounds.map((candidate) => candidate.top)) + Math.max(...bounds.map((candidate) => candidate.bottom))) / 2;
    const parentCenter = parentPosition.y + layout.getWikiNodeSize(parent).height / 2;
    assert.ok(
      Math.abs(parentCenter - spanCenter) < 0.51,
      `${parentId} must stay vertically centred on its children span`,
    );
  });
}

function assertSiblingSubtreesOrdered(modelNodes, layoutNodes) {
  const { boundsById, childrenByParentId } = collectSubtreeBounds(modelNodes, layoutNodes);
  childrenByParentId.forEach((children, parentId) => {
    for (let index = 1; index < children.length; index += 1) {
      const previousBounds = boundsById.get(children[index - 1].id);
      const nextBounds = boundsById.get(children[index].id);
      assert.ok(previousBounds && nextBounds, `${parentId} children must all have subtree bounds`);
      assert.ok(
        previousBounds.bottom < nextBounds.top,
        `${parentId} sibling subtrees must stay vertically separated in order`,
      );
    }
  });
}

function read(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), 'utf8');
}
