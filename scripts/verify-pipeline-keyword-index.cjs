const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.keyword-index-test-'));
const bundlePath = path.join(rootDir, '.keyword-index-verification.cjs');
const libraryPath = path.join(tempRoot, 'library');
const chunksPath = path.join(tempRoot, 'chunks.jsonl');
const keywordsPath = path.join(tempRoot, 'keywords.jsonl');

(async () => {
try {
  await build({
    entryPoints: [path.join(rootDir, 'electron/pipeline/keywordIndex.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3'],
  });
  const index = require(bundlePath);
  fs.mkdirSync(libraryPath, { recursive: true });

  const firstChunks = [
    { schemaVersion: 1, documentId: 'doc-index', chunkId: 'chunk-1', ordinal: 1, text: '访问控制需要最小权限。', sourceRefs: [] },
    { schemaVersion: 1, documentId: 'doc-index', chunkId: 'chunk-2', ordinal: 2, text: '本块没有可用关键词。', sourceRefs: [] },
  ];
  fs.writeFileSync(chunksPath, `${firstChunks.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(keywordsPath, `${[
    createKeywordRecord('doc-index', 'chunk-1', firstChunks[0].text, [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.9, kind: 'phrase', start: 0, end: 4 }], ['访问控制', '需要', '最小权限']),
    createKeywordRecord('doc-index', 'chunk-2', firstChunks[1].text, [], ['本块', '可用', '关键词']),
  ].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

  const imported = await index.importKeywordsStage({
    libraryPath,
    documentId: 'doc-index',
    sourceContentHash: 'source-v1',
    stageKey: 'stage-v1',
    chunksPath,
    keywordsPath,
  });
  assert.deepEqual({ importedChunks: imported.importedChunks, importedKeywords: imported.importedKeywords, readBackChunks: imported.readBackChunks, readBackKeywords: imported.readBackKeywords }, { importedChunks: 2, importedKeywords: 1, readBackChunks: 2, readBackKeywords: 1 });

  const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
  const database = new Database(databasePath);
  try {
    const row = database.prepare('SELECT normalized_term, offsets_json, chunk_content_hash FROM chunk_keywords WHERE document_id = ?').get('doc-index');
    assert.equal(row.normalized_term, '访问控制');
    assert.deepEqual(JSON.parse(row.offsets_json), [{ start: 0, end: 4, sentenceIndex: 0 }]);
    assert.match(row.chunk_content_hash, /^sha256:/);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chunk_keywords_term'").get().name, 'idx_chunk_keywords_term');
    assert.deepEqual(database.prepare('SELECT text FROM material_chunk_fts WHERE chunk_id = ?').get('chunk-1'), { text: '访问控制 需要 最小权限' });
  } finally {
    database.close();
  }

  fs.writeFileSync(keywordsPath, `${[
    createKeywordRecord('doc-index', 'chunk-1', firstChunks[0].text, [{ term: '最小权限', normalizedTerm: '最小权限', rank: 1, score: 0.8, kind: 'phrase', start: 6, end: 10 }]),
    createKeywordRecord('doc-index', 'chunk-2', firstChunks[1].text, []),
  ].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
  const updated = await index.importKeywordsStage({ libraryPath, documentId: 'doc-index', sourceContentHash: 'source-v2', stageKey: 'stage-v2', chunksPath, keywordsPath });
  assert.equal(updated.replacedKeywords, 1);
  assert.equal(index.readKeywordIndexDocument(libraryPath, 'doc-index').stageKey, 'stage-v2');
  assert.equal(index.isKeywordIndexCurrent({ libraryPath, documentId: 'doc-index', sourceContentHash: 'source-v2', stageKey: 'stage-v2', expectedChunks: 2, expectedKeywords: 1 }), true);

  const invalidKeywordsPath = path.join(tempRoot, 'invalid-keywords.jsonl');
  fs.writeFileSync(invalidKeywordsPath, JSON.stringify(createKeywordRecord('doc-index', 'chunk-1', firstChunks[0].text, [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.8, kind: 'phrase', start: 0, end: 3 }])) + '\n' + JSON.stringify(createKeywordRecord('doc-index', 'chunk-2', firstChunks[1].text, [])) + '\n', 'utf8');
  await assert.rejects(() => index.importKeywordsStage({ libraryPath, documentId: 'doc-index', sourceContentHash: 'source-v3', stageKey: 'stage-v3', chunksPath, keywordsPath: invalidKeywordsPath }), /KEYWORDS_INDEX_INPUT_INVALID|关键词 occurrence/);
  assert.equal(index.readKeywordIndexDocument(libraryPath, 'doc-index').stageKey, 'stage-v2');

  assert.equal(index.removeKeywordIndexEntries(libraryPath, 'doc-index'), 1);
  assert.equal(index.readKeywordIndexDocument(libraryPath, 'doc-index'), null);
  console.log('verify-pipeline-keyword-index: schema/index creation, hash and offset validation, transactional replacement, readback, and delete cleanup passed');
} finally {
  await removeTestArtifact(tempRoot, true);
  await removeTestArtifact(bundlePath, false);
}
})().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function removeTestArtifact(targetPath, recursive) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn(`verify-pipeline-keyword-index: 临时文件清理失败，已保留供诊断：${targetPath}`, lastError);
}

function createKeywordRecord(documentId, chunkId, text, keywords, searchTokens = keywords.map((keyword) => keyword.normalizedTerm)) {
  return {
    schemaVersion: 3,
    documentId,
    chunkId,
    parentChunkId: null,
    chunkContentHash: `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`,
    algorithm: { version: 'kw-1' },
    keyword: keywords.map((keyword) => keyword.term),
    searchTokens,
    keywords: keywords.map((keyword) => ({
      term: keyword.term,
      normalizedTerm: keyword.normalizedTerm,
      rank: keyword.rank,
      score: keyword.score,
      kind: keyword.kind,
      occurrences: [{ start: keyword.start, end: keyword.end, sentenceIndex: 0 }],
      features: {},
      forcedTop1: false,
    })),
    emptyReason: keywords.length ? null : 'NO_VALID_CANDIDATE',
  };
}
