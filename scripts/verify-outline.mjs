import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-outline');
const outFile = path.join(outDir, 'noteIndex.cjs');
const rendererOutFile = path.join(outDir, 'outline.cjs');
const libraryDir = path.join(outDir, 'library');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'electron', 'noteIndex.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

await build({
  entryPoints: [path.join(rootDir, 'src', 'utils', 'outline.ts')],
  outfile: rendererOutFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const {
  buildNoteIndex,
  extractHeadings,
  getNoteMeta,
} = await import(pathToFileURL(outFile).href);
const {
  buildOutlineTree,
  collectCollapsibleOutlineKeys,
  createHeadingEntriesFromElements,
  flattenVisibleOutlineTree,
} = await import(pathToFileURL(rendererOutFile).href);

const markdown = [
  '# 一级标题',
  '',
  '  ## 前导空格二级标题',
  '',
  '###无空格三级标题',
  '',
  'Setext 一级标题',
  '================',
  '',
  'Setext 二级标题',
  '----------------',
  '',
  '```md',
  '# 代码块标题不应出现',
  '```',
].join('\n');

const htmlNote = [
  '<h1>Hermes Guide</h1>',
  '<blockquote><p>Version: 2.3+</p></blockquote>',
  '<h2>Table of Contents</h2>',
  '<ol>',
  '<li><p>1. Overview should not be promoted from this list</p></li>',
  '<li><p>4.1 Streaming chat should not be promoted from this list</p></li>',
  '</ol>',
  '<pre><code class="language-markdown">',
  '# Alias should stay inside code',
  '## Build should stay inside code',
  '## Code style should stay inside code',
  '</code></pre>',
  '<h2>1. Overview</h2>',
  '<h3>1.1 Details</h3>',
].join('\n');

assert.deepEqual(
  extractHeadings(markdown).map((heading) => [heading.level, heading.text, heading.line]),
  [
    [1, '一级标题', 1],
    [2, '前导空格二级标题', 3],
    [3, '无空格三级标题', 5],
    [1, 'Setext 一级标题', 7],
    [2, 'Setext 二级标题', 10],
  ],
);

assert.deepEqual(
  extractHeadings(htmlNote).map((heading) => [heading.level, heading.text]),
  [
    [1, 'Hermes Guide'],
    [2, 'Table of Contents'],
    [2, '1. Overview'],
    [3, '1.1 Details'],
  ],
);

const markdownPath = path.join(libraryDir, 'Imported.md');
const htmlPath = path.join(libraryDir, 'ImportedHtml.md');
const textPath = path.join(libraryDir, 'Imported.txt');
writeFileSync(markdownPath, markdown, 'utf8');
writeFileSync(htmlPath, htmlNote, 'utf8');
writeFileSync(textPath, '# 文本文件标题\n\n## 文本文件二级标题\n', 'utf8');

const index = buildNoteIndex(libraryDir);
assert.deepEqual(
  getNoteMeta(index, markdownPath).headings.map((heading) => [heading.level, heading.text]),
  [
    [1, '一级标题'],
    [2, '前导空格二级标题'],
    [3, '无空格三级标题'],
    [1, 'Setext 一级标题'],
    [2, 'Setext 二级标题'],
  ],
);
assert.deepEqual(
  getNoteMeta(index, htmlPath).headings.map((heading) => [heading.level, heading.text]),
  [
    [1, 'Hermes Guide'],
    [2, 'Table of Contents'],
    [2, '1. Overview'],
    [3, '1.1 Details'],
  ],
);
assert.deepEqual(
  getNoteMeta(index, textPath).headings.map((heading) => [heading.level, heading.text]),
  [
    [1, '文本文件标题'],
    [2, '文本文件二级标题'],
  ],
);

assert.deepEqual(
  createHeadingEntriesFromElements([
    { tagName: 'H1', textContent: 'Rendered Title' },
    { tagName: 'H2', textContent: 'Rendered Section' },
    { tagName: 'H3', innerText: 'Rendered Detail', textContent: 'ignored fallback' },
    { tagName: 'H4', textContent: '   ' },
  ]).map((heading) => [heading.level, heading.text, heading.index]),
  [
    [1, 'Rendered Title', 0],
    [2, 'Rendered Section', 1],
    [3, 'Rendered Detail', 2],
  ],
);

const hierarchyHeadings = createHeadingEntriesFromElements([
  { tagName: 'H1', textContent: 'Root A' },
  { tagName: 'H3', textContent: 'Skipped-level child' },
  { tagName: 'H4', textContent: 'Grandchild' },
  { tagName: 'H2', textContent: 'Sibling child' },
  { tagName: 'H1', textContent: 'Root B' },
  { tagName: 'H2', textContent: 'Repeated' },
  { tagName: 'H2', textContent: 'Repeated' },
]);
const outlineTree = buildOutlineTree(hierarchyHeadings);

assert.deepEqual(
  outlineTree.map((node) => [
    node.heading.text,
    node.children.map((child) => [child.heading.text, child.children.map((grandchild) => grandchild.heading.text)]),
  ]),
  [
    ['Root A', [['Skipped-level child', ['Grandchild']], ['Sibling child', []]]],
    ['Root B', [['Repeated', []], ['Repeated', []]]],
  ],
);

const collapsibleKeys = collectCollapsibleOutlineKeys(outlineTree);
assert.equal(collapsibleKeys.length, 3);
assert.notEqual(outlineTree[1].children[0].key, outlineTree[1].children[1].key, 'repeated headings need unique outline keys');
assert.deepEqual(
  flattenVisibleOutlineTree(outlineTree, new Set([outlineTree[0].key])).map((row) => [row.heading.text, row.depth]),
  [
    ['Root A', 0],
    ['Root B', 0],
    ['Repeated', 1],
    ['Repeated', 1],
  ],
);
assert.deepEqual(
  flattenVisibleOutlineTree(outlineTree, new Set(collapsibleKeys)).map((row) => row.heading.text),
  ['Root A', 'Root B'],
  'collapse all should keep only root headings visible',
);

console.log('Outline verification passed');
