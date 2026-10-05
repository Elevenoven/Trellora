import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.keyword-preview-verification');
const bundlePath = path.join(outDir, 'keywordPreview.cjs');
const keywordPath = path.join(outDir, 'keywords.jsonl');
const chunksPath = path.join(outDir, 'chunks.jsonl');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({ entryPoints: ['electron/pipeline/keywordPreview.ts'], outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
const previewModule = await import(pathToFileURL(bundlePath).href);

fs.writeFileSync(chunksPath, [
  {
    schemaVersion: 2,
    documentId: 'doc-preview',
    chunkId: 'chunk-1',
    ordinal: 1,
    text: '访问控制需要最小权限和审计留痕。',
    sourceRefs: [{ page: 2, lineNo: 8 }],
  },
  {
    schemaVersion: 2,
    documentId: 'doc-preview',
    chunkId: 'chunk-2',
    ordinal: 2,
    text: 'sqlite-vec 用于本地向量检索。',
    sourceRefs: [{ lineNo: 12 }],
  },
].map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8');

fs.writeFileSync(keywordPath, [
  {
    schemaVersion: 2,
    documentId: 'doc-preview',
    chunkId: 'chunk-1',
    parentChunkId: null,
    keyword: ['访问控制'],
    keywords: [{
      term: '访问控制',
      normalizedTerm: '访问控制',
      kind: 'phrase',
      rank: 1,
      score: 0.91,
      occurrences: [{ start: 0, end: 4, sentenceIndex: 0 }],
      features: { tfidf: 0.9, domainBoost: true },
      forcedTop1: false,
    }],
    emptyReason: null,
  },
  {
    schemaVersion: 2,
    documentId: 'doc-preview',
    chunkId: 'chunk-2',
    parentChunkId: null,
    keyword: [],
    keywords: [],
    emptyReason: 'NO_VALID_CANDIDATE',
  },
].map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8');

const preview = await previewModule.readKeywordPreview({ documentId: 'doc-preview', keywordsPath: keywordPath, chunksPath, offset: 0, limit: 20 });
assert.equal(preview.rowCount, 2);
assert.equal(preview.rows[0].text, '访问控制需要最小权限和审计留痕。');
assert.deepEqual(preview.rows[0].sourceLocations, ['第2页', '第8行']);
assert.equal(preview.rows[0].keywords[0].term, '访问控制');
assert.equal(preview.rows[0].keywords[0].occurrences[0].end, 4);
assert.equal(preview.rows[1].emptyReason, 'NO_VALID_CANDIDATE');
assert.equal('keywordsPath' in preview, false);

const secondPage = await previewModule.readKeywordPreview({ documentId: 'doc-preview', keywordsPath: keywordPath, chunksPath, offset: 1, limit: 20 });
assert.equal(secondPage.rows.length, 1);
assert.equal(secondPage.rows[0].ordinal, 2);
assert.equal(secondPage.hasMore, false);

fs.rmSync(outDir, { recursive: true, force: true });
console.log('verify-pipeline-keyword-preview: bounded structured preview, source locations, offsets, pagination, and path redaction passed');
