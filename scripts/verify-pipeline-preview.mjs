import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.pipeline-preview-test');
const outFile = path.join(outDir, 'artifact-preview.cjs');
const inputFile = path.join(outDir, 'large.jsonl');
const parentsFile = path.join(outDir, 'parents.jsonl');
const childrenFile = path.join(outDir, 'children.jsonl');
const relatedChildrenFile = path.join(outDir, 'related-children.jsonl');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(inputFile, `${Array.from({ length: 123 }, (_, index) => JSON.stringify({ line: index + 1, text: `第 ${index + 1} 行` })).join('\n')}\n`, 'utf8');
writeFileSync(parentsFile, `${JSON.stringify({ parentId: 'p-000001', text: '章节：第一章\n\nParent 正文' })}\n`, 'utf8');
writeFileSync(childrenFile, `${JSON.stringify({ chunkId: 'c-1', parentChunkId: 'p-000001', text: '章节：第一章\n\nChild 正文', sourceText: 'Child 正文' })}\n`, 'utf8');
writeFileSync(relatedChildrenFile, `${[
  ...Array.from({ length: 12 }, (_, index) => ({ chunkId: `c-${index + 1}`, parentChunkId: 'p-000001', text: `Child ${index + 1}` })),
  { chunkId: 'c-13', parentChunkId: 'p-000002', text: '其他 Parent 的 Child' },
  { chunkId: 'c-14', parentChunkId: 'p-000002', text: '其他 Parent 的另一个 Child' },
].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

await build({
  stdin: {
    contents: `
      export { assertArtifactPreviewIntegrity, normalizeArtifactPreviewParentChunkId, normalizeArtifactPreviewWindow, readArtifactPreview } from './electron/pipeline/artifactPreview';
      export { isStageOutputAllowed, stageOutputNames } from './electron/pipeline/artifactStore';
      export { createPipelineLayout } from './electron/pipeline/pathLayout';
      export { buildArtifactPreviewItems, getArtifactPreviewModes, getDefaultArtifactPreviewMode } from './src/utils/pipelineArtifactPreview';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});

const { assertArtifactPreviewIntegrity, buildArtifactPreviewItems, createPipelineLayout, getArtifactPreviewModes, getDefaultArtifactPreviewMode, isStageOutputAllowed, normalizeArtifactPreviewParentChunkId, normalizeArtifactPreviewWindow, readArtifactPreview, stageOutputNames } = await import(pathToFileURL(outFile).href);
const metadata = (filePath) => ({
  bytes: statSync(filePath).size,
  sha256: crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex'),
});
const options = (filePath, stage, fileName) => ({
  documentId: 'preview-doc', stage, fileName, relativePath: `06-preview/${fileName}`, ...metadata(filePath),
});

const document = { id: 'preview-doc', name: '预览.md', relativePath: '预览.md', absolutePath: inputFile, extension: '.md', sizeBytes: 1, addedAt: '', contentHash: 'source-hash' };
const v2Layout = createPipelineLayout(outDir, document, '', 'disabled', 'default', 'default', 'chunk-v2', true);
const legacyLayout = createPipelineLayout(outDir, document, '', 'disabled', 'default', 'default', 'disabled', false);
assert.deepEqual(stageOutputNames(v2Layout, 'chunks'), ['parents.jsonl', 'children.jsonl', 'chunks.jsonl', 'chunk-plan.json', 'chunks-report.json']);
assert.equal(isStageOutputAllowed(v2Layout, 'chunks', 'parents.jsonl'), true);
assert.equal(isStageOutputAllowed(v2Layout, 'chunks', 'children.jsonl'), true);
assert.equal(isStageOutputAllowed(v2Layout, 'chunks', 'stage-manifest.json'), false);
assert.equal(isStageOutputAllowed(v2Layout, 'chunks', '../parents.jsonl'), false);
assert.equal(isStageOutputAllowed(legacyLayout, 'chunks', 'parents.jsonl'), false);
assert.equal(isStageOutputAllowed(legacyLayout, 'chunks', 'chunks.jsonl'), true);

assert.deepEqual(normalizeArtifactPreviewWindow(-10, 500), { offset: 0, limit: 100 });
assert.equal(normalizeArtifactPreviewParentChunkId('p-000001'), 'p-000001');
assert.equal(normalizeArtifactPreviewParentChunkId(undefined), undefined);
assert.throws(() => normalizeArtifactPreviewParentChunkId('../children.jsonl'), /父块标识无效/);
const page = await readArtifactPreview(inputFile, { ...options(inputFile, 'signals', 'signals.jsonl'), offset: 40, limit: 20 });
assert.equal(page.lineCount, 123);
assert.equal(page.rows[0].lineNumber, 41);
assert.equal(page.rows.at(-1).lineNumber, 60);
assert.equal(page.rows.length, 20);
assert.equal(page.hasMore, true);
const lastPage = await readArtifactPreview(inputFile, { ...options(inputFile, 'chunks', 'chunks.jsonl'), offset: 120, limit: 40 });
assert.equal(lastPage.rows[0].lineNumber, 121);
assert.equal(lastPage.rows.length, 3);
assert.equal(lastPage.hasMore, false);

const parentPage = await readArtifactPreview(parentsFile, { ...options(parentsFile, 'chunks', 'parents.jsonl') });
const childPage = await readArtifactPreview(childrenFile, { ...options(childrenFile, 'chunks', 'children.jsonl') });
assert.match(parentPage.rows[0].text, /parentId/);
assert.match(childPage.rows[0].text, /parentChunkId/);
const relatedFirstPage = await readArtifactPreview(relatedChildrenFile, {
  ...options(relatedChildrenFile, 'chunks', 'children.jsonl'),
  parentChunkId: 'p-000001',
  offset: 0,
  limit: 10,
});
assert.equal(relatedFirstPage.lineCount, 12, '过滤后的总数必须只统计当前 Parent 的 Child');
assert.equal(relatedFirstPage.rows.length, 10);
assert.equal(relatedFirstPage.hasMore, true);
const relatedLastPage = await readArtifactPreview(relatedChildrenFile, {
  ...options(relatedChildrenFile, 'chunks', 'children.jsonl'),
  parentChunkId: 'p-000001',
  offset: 10,
  limit: 10,
});
assert.equal(relatedLastPage.rows.length, 2);
assert.equal(relatedLastPage.hasMore, false);
assert.ok(relatedLastPage.rows.every((row) => JSON.parse(row.text).parentChunkId === 'p-000001'));
assert.deepEqual(getArtifactPreviewModes('tree', 'structure.jsonl'), ['structured', 'text', 'json']);
assert.deepEqual(getArtifactPreviewModes('chunks', 'parents.jsonl'), ['structured', 'text', 'json']);
assert.deepEqual(getArtifactPreviewModes('parse', 'document.md'), ['text']);
assert.equal(getDefaultArtifactPreviewMode('chunks', 'children.jsonl'), 'structured');

const previewItems = buildArtifactPreviewItems([
  {
    lineNumber: 1,
    text: JSON.stringify({ nodeId: 'n-1', parentId: 'n-root', type: 'HEADING', text: '第一章', depth: 2, firstLineNo: 4, lastLineNo: 4, sectionPath: [{ text: '总则' }, { text: '第一章' }] }),
  },
  {
    lineNumber: 2,
    text: JSON.stringify({ chunkId: 'c-1', parentChunkId: 'p-1', ordinal: 1, text: '章节：第一章\n\nChild 正文', sourceText: 'Child 正文', charCount: 24, sectionPath: [{ text: '第一章' }] }),
  },
], 'structure.jsonl');
assert.equal(previewItems[0].kind, 'tree');
assert.equal(previewItems[0].parentId, 'n-root');
assert.deepEqual(previewItems[0].sectionPath, ['总则', '第一章']);
assert.match(previewItems[0].prettyJson, /\n  "nodeId"/);

const childPreviewItem = buildArtifactPreviewItems([{ lineNumber: 1, text: childPage.rows[0].text }], 'children.jsonl')[0];
assert.equal(childPreviewItem.kind, 'child');
assert.equal(childPreviewItem.parentId, 'p-000001');
assert.equal(childPreviewItem.text, 'Child 正文');
const invalidPreviewItem = buildArtifactPreviewItems([{ lineNumber: 9, text: '{invalid-json' }], 'structure.jsonl')[0];
assert.equal(invalidPreviewItem.kind, 'tree');
assert.equal(invalidPreviewItem.prettyJson, '{invalid-json');
assert.equal(invalidPreviewItem.text, '{invalid-json');

const original = options(childrenFile, 'chunks', 'children.jsonl');
writeFileSync(childrenFile, `${JSON.stringify({ chunkId: 'c-2', parentChunkId: 'p-000002', text: '章节：第二章\n\nChild 正文', sourceText: 'Child 原文' })}\n`, 'utf8');
assert.equal(statSync(childrenFile).size, original.bytes, '同尺寸篡改应能覆盖哈希校验边界');
await assert.rejects(() => assertArtifactPreviewIntegrity(childrenFile, original), /哈希已变化/);
writeFileSync(childrenFile, '{}\n', 'utf8');
await assert.rejects(() => assertArtifactPreviewIntegrity(childrenFile, original), /大小已变化/);

rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-preview: Parent/Child allowlist, filtered child pagination, manifest integrity, and structured/text/JSON preview models passed');
