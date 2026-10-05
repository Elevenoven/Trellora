const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.material-chunk-search-test-'));
const bundlePath = path.join(rootDir, '.material-chunk-search-verification.cjs');
const searchBundlePath = path.join(rootDir, '.material-chunk-search-query-verification.cjs');
const coordinatorBundlePath = path.join(rootDir, '.material-chunk-search-coordinator-verification.cjs');
const libraryPath = path.join(tempRoot, 'library');
const chunksPath = path.join(tempRoot, 'chunks.jsonl');
const keywordsPath = path.join(tempRoot, 'keywords.jsonl');
const parentsPath = path.join(tempRoot, 'parents.jsonl');

(async () => {
  try {
    const buildOptions = {
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['better-sqlite3', 'sqlite-vec'],
    };
    await Promise.all([
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/keywordIndex.ts')], outfile: bundlePath }),
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialChunkSearch.ts')], outfile: searchBundlePath }),
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialVectorCoordinator.ts')], outfile: coordinatorBundlePath }),
    ]);
    const index = require(bundlePath);
    const search = require(searchBundlePath);
    const coordinator = require(coordinatorBundlePath);
    const pipelineViewSource = fs.readFileSync(path.join(rootDir, 'src/components/MaterialsPipelineView.tsx'), 'utf8');
    assert.match(pipelineViewSource, /id: 'fts', label: 'FTS5索引'/, '流水线 UI 必须显示独立的 FTS5 索引节点');
    assert.match(pipelineViewSource, /pipelineStatus\?\.ftsIndex/, 'FTS5 UI 状态必须来自主进程的 SQLite 投影读回');
    assert.match(pipelineViewSource, /material_chunk_fts/, 'FTS5 卡片必须标明实际 SQLite 虚表');
    fs.mkdirSync(libraryPath, { recursive: true });

    const chunks = [
      createChunk('doc-1', 'parent-1', null, 1, '安全管理制度与访问控制要求。', [{ page: 1 }]),
      createChunk('doc-1', 'child-1', 'parent-1', 2, '访问控制要求启用最小权限，所有操作必须留痕。', [{ page: 3, block: 'b-1' }], [{ nodeId: 'n-1', text: '访问控制' }]),
      createChunk('doc-2', 'child-2', null, 1, '访问控制在其他文档中出现。', [{ page: 9 }]),
    ];
    const doc1Chunks = chunks.slice(0, 2);
    const doc1KeywordRecords = [
      createKeywordRecord(chunks[0], [], ['安全管理制度', '访问控制', '要求']),
      createKeywordRecord(chunks[1], [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.95, kind: 'phrase', start: 0, end: 4 }, { term: '最小权限', normalizedTerm: '最小权限', rank: 2, score: 0.8, kind: 'phrase', start: 8, end: 12 }], ['访问控制', '要求', '启用', '最小权限', '所有', '操作', '必须', '留痕']),
    ];
    fs.writeFileSync(chunksPath, `${doc1Chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`, 'utf8');
    fs.writeFileSync(keywordsPath, `${doc1KeywordRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const imported = await index.importKeywordsStage({
      libraryPath,
      documentId: 'doc-1',
      sourceContentHash: 'source-doc-1',
      stageKey: 'stage-doc-1',
      chunksPath,
      keywordsPath,
    }).catch((error) => {
      throw error;
    });
    assert.equal(imported.importedChunks, 2);
    assert.equal(index.isKeywordIndexCurrent({ libraryPath, documentId: 'doc-1', sourceContentHash: 'source-doc-1', stageKey: 'stage-doc-1', expectedChunks: 2, expectedKeywords: 2 }), true);
    const ftsSnapshot = index.readFtsIndexProjectionSnapshot(libraryPath, 'doc-1');
    assert.deepEqual(
      { ...ftsSnapshot, indexedAt: undefined },
      {
        documentId: 'doc-1',
        sourceContentHash: 'source-doc-1',
        stageKey: 'stage-doc-1',
        projectedChunkCount: 2,
        projectedKeywordCount: 2,
        indexedChunks: 2,
        ftsRows: 2,
        indexedKeywords: 2,
        indexedAt: undefined,
      },
      'FTS5 UI 状态必须从 SQLite 实际读回文档、chunk、FTS 和关键词数量',
    );
    assert.match(ftsSnapshot.indexedAt, /^\d{4}-\d{2}-\d{2}T/, 'FTS5 UI 必须显示数据库记录的实际落库时间');

    const doc2ChunksPath = path.join(tempRoot, 'chunks-doc2.jsonl');
    const doc2KeywordsPath = path.join(tempRoot, 'keywords-doc2.jsonl');
    fs.writeFileSync(doc2ChunksPath, `${JSON.stringify(chunks[2])}\n`, 'utf8');
    fs.writeFileSync(doc2KeywordsPath, `${JSON.stringify(createKeywordRecord(chunks[2], [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.9, kind: 'phrase', start: 0, end: 4 }], ['访问控制', '其他', '文档', '出现']))}\n`, 'utf8');
    await index.importKeywordsStage({ libraryPath, documentId: 'doc-2', sourceContentHash: 'source-doc-2', stageKey: 'stage-doc-2', chunksPath: doc2ChunksPath, keywordsPath: doc2KeywordsPath });

    const v2Parent = {
      schemaVersion: 2, documentId: 'doc-3', parentId: 'p-3', ordinal: 1,
      text: '章节：审计要求\n\n审计留痕与保管期限要求。', sourceText: '审计留痕与保管期限要求。',
      sectionPath: [{ nodeId: 'h-3', text: '审计要求' }], sectionContext: '章节：审计要求', sourceRefs: [{ page: 7, block: 'parent-3' }],
    };
    const v2Child = createChunk('doc-3', 'c-3', 'p-3', 1, '章节：审计要求\n\n审计留痕必须可追溯。', [{ page: 7, block: 'child-3' }], [{ nodeId: 'h-3', text: '审计要求' }]);
    v2Child.schemaVersion = 2;
    v2Child.sourceText = '审计留痕必须可追溯。';
    v2Child.sectionContext = '章节：审计要求';
    const v2ChunksPath = path.join(tempRoot, 'chunks-v2.jsonl');
    const v2KeywordsPath = path.join(tempRoot, 'keywords-v2.jsonl');
    fs.writeFileSync(parentsPath, `${JSON.stringify(v2Parent)}\n`, 'utf8');
    fs.writeFileSync(v2ChunksPath, `${JSON.stringify(v2Child)}\n`, 'utf8');
    fs.writeFileSync(v2KeywordsPath, `${JSON.stringify(createKeywordRecord(v2Child, [{ term: '审计留痕', normalizedTerm: '审计留痕', rank: 1, score: 0.97, kind: 'phrase', start: v2Child.text.indexOf('审计留痕'), end: v2Child.text.indexOf('审计留痕') + 4 }], ['章节', '审计', '要求', '审计留痕', '必须', '追溯']))}\n`, 'utf8');
    await index.importKeywordsStage({ libraryPath, documentId: 'doc-3', sourceContentHash: 'source-doc-3', stageKey: 'stage-doc-3', chunksPath: v2ChunksPath, parentsPath, keywordsPath: v2KeywordsPath });

    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    const database = new Database(databasePath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM material_chunks WHERE document_id = ?').get('doc-1').count, 2);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM material_chunk_fts WHERE document_id = ?').get('doc-1').count, 2);
      assert.equal(database.prepare('SELECT keyword_text FROM material_chunks WHERE chunk_id = ?').get('child-1').keyword_text, '访问控制 最小权限');
      assert.deepEqual(
        database.prepare('SELECT chunk_id AS chunkId FROM material_chunk_fts WHERE material_chunk_fts MATCH ?').all('keyword_text : "最小权限"'),
        [{ chunkId: 'child-1' }],
        '生成关键词必须真实写入 FTS5 的 keyword_text 列，而不是只留在普通表中',
      );
      assert.deepEqual(
        database.prepare('SELECT chunk_id AS chunkId FROM material_chunk_fts WHERE material_chunk_fts MATCH ?').all('text : "最小权限"'),
        [{ chunkId: 'child-1' }],
        'chunk 原文的 Jieba 词元必须真实写入 FTS5 text 列',
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM material_chunk_parents WHERE document_id = ?').get('doc-3').count, 1);
      assert.equal(database.prepare('SELECT source_text FROM material_chunks WHERE chunk_id = ?').get('c-3').source_text, '审计留痕必须可追溯。');
    } finally {
      database.close();
    }

    const keywordSearch = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'keyword', documentIds: ['doc-1'], limit: 10 });
    assert.equal(keywordSearch.results[0].chunkId, 'child-1');
    const bodyOnlyMatch = keywordSearch.results.find((result) => result.chunkId === 'parent-1');
    assert.ok(bodyOnlyMatch, '正文中的普通匹配仍应由 FTS5 召回');
    assert.ok(keywordSearch.results[0].bm25Score > bodyOnlyMatch.bm25Score, 'FTS5 关键词命中应优先于正文 LIKE 兜底');
    const segmentedLongQuery = await search.searchMaterialChunks({
      libraryPath,
      query: '最小权限必须留痕',
      queryTerms: ['最小权限', '必须', '留痕'],
      mode: 'keyword',
      documentIds: ['doc-1'],
    });
    assert.equal(segmentedLongQuery.results[0].chunkId, 'child-1');
    assert.ok(segmentedLongQuery.results[0].bm25Score > 0, '非连续长查询必须通过 Jieba 词元进入 FTS5，而不是只依赖原文 LIKE');
    assert.equal(keywordSearch.results[0].citation.chunkId, 'child-1');
    assert.deepEqual(keywordSearch.results[0].citation.sourceRefs, [{ page: 3, block: 'b-1' }]);
    assert.equal(keywordSearch.results[0].citation.parent.chunkId, 'parent-1');
    assert.equal((await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'keyword', documentIds: ['doc-2'] })).results[0].chunkId, 'child-2');
    const v2Search = await search.searchMaterialChunks({ libraryPath, query: '审计留痕', mode: 'keyword', documentIds: ['doc-3'], limit: 10 });
    assert.equal(v2Search.results[0].chunkId, 'c-3');
    assert.equal(v2Search.results[0].text.startsWith('章节：审计要求'), true, '检索应使用带章节的 Child 文本');
    assert.equal(v2Search.results[0].citation.sourceText, '审计留痕必须可追溯。', '引用必须使用未重复章节前缀的原文');
    assert.equal(v2Search.results[0].citation.parent.chunkId, 'p-3', 'Child 命中必须能回溯 Parent');
    assert.equal(v2Search.results[0].citation.parent.sourceText, '审计留痕与保管期限要求。');

    const candidate = {
      schemaVersion: 1,
      sourceId: 'test-source',
      transportKind: 'ollama',
      endpointIdentity: 'http://127.0.0.1:11434',
      requestedModel: 'test-embedding',
      vectorType: 'float32',
      distanceMetric: 'cosine',
      encodingFormat: 'float',
      truncateInputs: true,
      documentInputVersion: 'material-chunk-text-v1',
      queryInputVersion: 'material-query-text-v1',
    };
    const profile = await coordinator.lockMaterialEmbeddingProfile({
      libraryPath,
      candidate,
      probe: async () => ({ vectorDimension: 2, responseModel: 'test-embedding' }),
      appVersion: 'verify-material-chunk-search',
    });
    const queriedModels = [];
    const adapter = {
      probe: async () => ({ vectorDimension: 2, responseModel: 'test-embedding' }),
      embedBatch: async ({ profile: requestedProfile, texts }) => {
        queriedModels.push(requestedProfile.requestedModel);
        return {
          vectors: texts.map((text) => text.includes('访问控制') ? [1, 0] : [0, 1]),
          dimension: 2,
          responseModel: 'test-embedding',
        };
      },
    };
    const vector = await coordinator.synchronizeMaterialVectors({
      libraryPath,
      profile,
      adapter,
    });
    assert.equal(vector.completedItems, 4);
    assert.equal(vector.state, 'SUCCEEDED');
    const hybrid = await search.searchMaterialChunks({
      libraryPath,
      query: '访问控制',
      mode: 'hybrid',
      adapter,
      limit: 10,
    });
    assert.equal(hybrid.vectorIndexed, true);
    assert.equal(
      hybrid.results[0].chunkId,
      'child-1',
      `混合排序分数：${JSON.stringify(hybrid.results.map((result) => ({ chunkId: result.chunkId, score: result.score, bm25Score: result.bm25Score, keywordScore: result.keywordScore, vectorScore: result.vectorScore })))}`,
    );
    assert.ok(hybrid.results[0].matchTypes.includes('语义'));
    assert.equal(queriedModels.at(-1), 'test-embedding', 'query 必须使用资料库锁定 profile 的模型');

    const childVectorTopFive = await search.searchMaterialChunks({
      libraryPath,
      query: '访问控制',
      mode: 'semantic',
      adapter,
      limit: 5,
      childOnly: true,
    });
    assert.ok(childVectorTopFive.results.length <= 5, '专用 RAG 的向量召回必须限制为 Top 5 子块');
    assert.ok(childVectorTopFive.results.every((result) => result.parentChunkId && result.citation.parent), '专用 RAG 的向量召回不能把父块或孤立块当作子块证据');
    assert.equal(queriedModels.at(-1), 'test-embedding', '子块向量召回同样必须使用资料库锁定 profile 的模型');

    const invalidKeywordsPath = path.join(tempRoot, 'invalid-keywords.jsonl');
    fs.writeFileSync(invalidKeywordsPath, `${JSON.stringify(createKeywordRecord(chunks[0], []))}\n${JSON.stringify(createKeywordRecord(chunks[1], [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.9, kind: 'phrase', start: 0, end: 3 }]))}\n`, 'utf8');
    await assert.rejects(() => index.importKeywordsStage({ libraryPath, documentId: 'doc-1', sourceContentHash: 'source-doc-1-v2', stageKey: 'stage-doc-1-v2', chunksPath, keywordsPath: invalidKeywordsPath }), /KEYWORDS_INDEX_INPUT_INVALID|关键词 occurrence/);
    assert.equal(index.readKeywordIndexDocument(libraryPath, 'doc-1').stageKey, 'stage-doc-1');
    assert.equal((await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'keyword', documentIds: ['doc-1'] })).results[0].citation.sourceRefs[0].page, 3);

    assert.equal(index.removeKeywordIndexEntries(libraryPath, 'doc-1'), 2);
    assert.equal(index.readFtsIndexProjectionSnapshot(libraryPath, 'doc-1'), null);
    assert.equal((await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'keyword', documentIds: ['doc-1'] })).indexedChunks, 0);
    console.log('verify-material-chunk-search: FTS UI status/readback, keyword/vector projection, library scope, parent retrieval, citation reconciliation, rollback, and delete cleanup passed');
  } finally {
    await removeTestArtifact(tempRoot);
    await removeTestArtifact(bundlePath);
    await removeTestArtifact(searchBundlePath);
    await removeTestArtifact(coordinatorBundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

function createChunk(documentId, chunkId, parentChunkId, ordinal, text, sourceRefs, sectionPath = []) {
  return { schemaVersion: 1, documentId, chunkId, parentChunkId, ordinal, text, sourceRefs, sectionPath };
}

function createKeywordRecord(chunk, keywords, searchTokens = keywords.map((keyword) => keyword.normalizedTerm)) {
  return {
    schemaVersion: 3,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    parentChunkId: chunk.parentChunkId,
    chunkContentHash: `sha256:${crypto.createHash('sha256').update(chunk.text, 'utf8').digest('hex')}`,
    algorithm: { version: 'kw-1' },
    keyword: keywords.map((keyword) => keyword.term),
    searchTokens,
    keywords: keywords.map((keyword) => ({
      ...keyword,
      occurrences: [{ start: keyword.start, end: keyword.end, sentenceIndex: 0 }],
      features: {},
      forcedTop1: false,
    })),
    emptyReason: keywords.length ? null : 'NO_VALID_CANDIDATE',
  };
}

async function removeTestArtifact(targetPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn(`verify-material-chunk-search: 临时文件清理失败：${targetPath}`);
}
