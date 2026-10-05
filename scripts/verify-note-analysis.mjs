import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-note-analysis');
const libraryDir = path.join(outDir, 'library');
const metaOut = path.join(outDir, 'meta.cjs');
const sourceOut = path.join(outDir, 'source.cjs');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(libraryDir, { recursive: true });

await Promise.all([
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'metaDatabase.ts')], outfile: metaOut, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
  build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'noteAnalysisSource.ts')], outfile: sourceOut, bundle: true, platform: 'node', format: 'cjs' }),
]);

const { getNoteAnalysis, saveNoteAnalysis, synchronizeKnowledgeIndex } = await import(pathToFileURL(metaOut).href);
const { getNoteAnalysisSourceHash } = await import(pathToFileURL(sourceOut).href);
const notePath = 'Analysis.md';
const beforeTags = '---\ntitle: Analysis\ntags: [existing]\n---\n\n# Analysis\n\n本地优先知识管理。\n';
const afterTags = '---\ntitle: Analysis\ntags: [existing, confirmed]\n---\n\n# Analysis\n\n本地优先知识管理。\n';
const changedContent = '---\ntitle: Analysis\ntags: [existing, confirmed]\n---\n\n# Analysis\n\n内容已更新。\n';
const originalHash = getNoteAnalysisSourceHash(beforeTags);
assert.equal(originalHash, getNoteAnalysisSourceHash(afterTags), 'Applying confirmed tags must not stale an unchanged analysis');
assert.notEqual(originalHash, getNoteAnalysisSourceHash(changedContent), 'Body edits must stale an analysis');

synchronizeKnowledgeIndex(libraryDir, [{
  path: notePath,
  relativePath: notePath,
  title: 'Analysis',
  kind: 'markdown',
  extension: '.md',
  mtimeMs: 1,
  facts: { frontmatter: { title: 'Analysis', tags: ['existing'] }, headings: [], tags: ['existing'], outgoingLinks: [], plainText: '本地优先知识管理。', contentHash: 'raw-hash' },
}]);
saveNoteAnalysis(libraryDir, {
  notePath,
  sourceHash: originalHash,
  provider: 'ollama',
  model: 'test',
  summary: '本地优先知识管理。',
  keyPoints: ['数据保留在本地。'],
  tagCandidates: [{ name: '知识管理', confidence: 'high', evidence: '正文出现“知识管理”。' }],
});

const current = getNoteAnalysis(libraryDir, notePath, originalHash);
assert.equal(current?.isStale, undefined);
assert.equal(current?.tagCandidates[0]?.confidence, 'high');
const stale = getNoteAnalysis(libraryDir, notePath, getNoteAnalysisSourceHash(changedContent));
assert.equal(stale?.isStale, true);

console.log('Unified note analysis verification passed');
