/**
 * LexScore v2 词法打分功能验证：
 * 1. 导入侧写入自研倒排 material_term_postings 与语料统计；
 * 2. 检索返回 lexicalBreakdown，且覆盖率/标题加成/关键词通道行为符合设计；
 * 3. 旧库（无倒排投影）首次检索触发懒回填，结果不劣化。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.lexscore-v2-test-'));
const indexBundlePath = path.join(rootDir, '.lexscore-v2-index-verification.cjs');
const searchBundlePath = path.join(rootDir, '.lexscore-v2-search-verification.cjs');
const libraryPath = path.join(tempRoot, 'library');
const dbPath = path.join(libraryPath, '.menghan-meta', 'index.db');

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
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/keywordIndex.ts')], outfile: indexBundlePath }),
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialChunkSearch.ts')], outfile: searchBundlePath }),
    ]);
    const index = require(indexBundlePath);
    const search = require(searchBundlePath);
    fs.mkdirSync(libraryPath, { recursive: true });

    // ---- 样本数据：doc-1 两个块，doc-2 一个对照块 ----
    const parent1 = createChunk('doc-1', 'parent-1', null, 1, '访问控制要求启用最小权限。', [{ page: 1 }]);
    const child1 = createChunk('doc-1', 'child-1', 'parent-1', 2, '审计要求规定访问控制必须留痕，访问日志定期审查。', [{ page: 2, block: 'b-1' }], [{ nodeId: 'h-1', text: '审计要求' }]);
    child1.schemaVersion = 2;
    child1.sourceText = '审计要求规定访问控制必须留痕，访问日志定期审查。';
    child1.sectionContext = '章节：审计要求';
    const child2 = createChunk('doc-2', 'child-2', null, 1, '访问控制概述。', [{ page: 1 }], [{ nodeId: 'h-2', text: '概述' }]);

    const doc1Chunks = [parent1, child1];
    const doc1Records = [
      createKeywordRecord(parent1, [], ['访问', '控制', '要求', '启用', '最小', '权限']),
      createKeywordRecord(child1, [
        { term: '审计要求', normalizedTerm: '审计要求', rank: 1, score: 0.95, kind: 'phrase', start: 0, end: 4 },
        { term: '访问控制', normalizedTerm: '访问控制', rank: 2, score: 0.9, kind: 'phrase', start: 6, end: 10 },
      ], ['审计', '要求', '规定', '访问控制', '必须', '留痕', '访问', '日志', '定期', '审查', '访问']),
    ];
    const writeImport = async (documentId, chunks, records, extra = {}) => {
      const chunksPath = path.join(tempRoot, `chunks-${documentId}.jsonl`);
      const keywordsPath = path.join(tempRoot, `keywords-${documentId}.jsonl`);
      fs.writeFileSync(chunksPath, `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`, 'utf8');
      fs.writeFileSync(keywordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      await index.importKeywordsStage({ libraryPath, documentId, sourceContentHash: `source-${documentId}`, stageKey: `stage-${documentId}`, chunksPath, keywordsPath, ...extra });
    };
    await writeImport('doc-1', doc1Chunks, doc1Records);
    await writeImport('doc-2', [child2], [createKeywordRecord(child2, [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.6, kind: 'phrase', start: 0, end: 4 }], ['访问控制', '概述'])]);

    // ---- 1. 导入侧：倒排表、长度列、语料统计、回填标记 ----
    const db = new Database(dbPath);
    try {
      const child1Row = db.prepare("SELECT id FROM material_chunks WHERE chunk_id = 'child-1'").get();
      const child1BodyTf = db.prepare("SELECT tf FROM material_term_postings WHERE chunk_rowid = ? AND field = 'body' AND term = '访问'").get(child1Row.id);
      assert.equal(child1BodyTf.tf, 2, 'body 倒排必须记录真实词频（访问 出现 2 次）');
      const kwTerms = db.prepare("SELECT term FROM material_term_postings WHERE chunk_rowid = ? AND field = 'keyword' ORDER BY term").all(child1Row.id).map((row) => row.term);
      assert.deepEqual(kwTerms, ['审计要求', '访问控制'], '生成关键词必须写入 keyword 域倒排');
      const lengths = db.prepare('SELECT lexical_body_len AS bodyLen, lexical_kw_len AS kwLen FROM material_chunks WHERE chunk_id = ?').get('child-1');
      assert.equal(lengths.bodyLen, 11, 'lexical_body_len 必须等于 searchTokens 数');
      assert.equal(lengths.kwLen, 2, 'lexical_kw_len 必须等于去重关键词数');
      const stat = (key) => db.prepare('SELECT value FROM material_lexical_stats WHERE key = ?').get(key)?.value;
      assert.equal(stat('doc_count'), '3');
      assert.equal(stat('backfilled:doc-1'), '1', '导入路径必须留下回填标记，避免旧库逻辑重复回填');
    } finally {
      db.close();
    }

    // ---- 2. 标题加成：raw query 命中章节标题 ----
    const titleSearch = await search.searchMaterialChunks({ libraryPath, query: '审计要求', queryTerms: ['审计', '要求'], mode: 'keyword', documentIds: ['doc-1'], limit: 10 });
    assert.equal(titleSearch.results[0].chunkId, 'child-1', '章节标题命中的子块必须排第一');
    const titleBreakdown = titleSearch.results[0].lexicalBreakdown;
    assert.ok(titleBreakdown, '词法命中结果必须携带 lexicalBreakdown');
    assert.ok(titleBreakdown.title > 0, '章节标题域得分必须计入分解');
    assert.ok(titleBreakdown.bonus >= 0.15, 'raw query 命中章节标题必须触发 titleExactBonus');
    assert.ok(titleBreakdown.coverage === 1, '两个词都在标题域命中时覆盖率应为 1');

    // ---- 3. 覆盖率门控：全命中块必须高于部分命中块 ----
    const coverageSearch = await search.searchMaterialChunks({ libraryPath, query: '访问控制留痕', queryTerms: ['访问控制', '留痕'], mode: 'keyword', documentIds: ['doc-1', 'doc-2'], limit: 10 });
    const scoreOf = (chunkId) => coverageSearch.results.find((result) => result.chunkId === chunkId);
    assert.ok(scoreOf('child-1'), '全命中块必须被召回');
    assert.ok(scoreOf('child-2'), '部分命中块也必须被召回');
    assert.equal(coverageSearch.results[0].chunkId, 'child-1', '覆盖率更高的块必须排在部分命中块之前');
    assert.ok(scoreOf('child-1').lexicalBreakdown.coverage > scoreOf('child-2').lexicalBreakdown.coverage, 'breakdown 覆盖率必须反映查询词命中比例');

    // ---- 4. TF 区分度：同词频语料下高 tf 块靠前 ----
    const tfSearch = await search.searchMaterialChunks({ libraryPath, query: '访问', queryTerms: ['访问'], mode: 'keyword', documentIds: ['doc-1', 'doc-2'], limit: 10 });
    assert.equal(tfSearch.results[0].chunkId, 'child-1', 'tf=2 的块应高于 tf=1 的块');

    // ---- 5. 关键词通道：IDF 加权 K(d) 有界归一 ----
    const kwResult = coverageSearch.results.find((result) => result.chunkId === 'child-1');
    assert.ok(kwResult.keywordScore > 0 && kwResult.keywordScore < 1, '关键词通道得分必须落在 (0,1) 的有界区间');

    // ---- 6. 旧库懒回填：清空倒排与标记后，检索自动重建且结果不劣化 ----
    const db2 = new Database(dbPath);
    try {
      db2.exec('DELETE FROM material_term_postings');
      db2.exec("DELETE FROM material_lexical_stats WHERE key LIKE 'backfilled:%'");
    } finally {
      db2.close();
    }
    const backfillSearch = await search.searchMaterialChunks({ libraryPath, query: '访问控制留痕', queryTerms: ['访问控制', '留痕'], mode: 'keyword', documentIds: ['doc-1', 'doc-2'], limit: 10 });
    assert.equal(backfillSearch.results[0].chunkId, 'child-1', '懒回填后排序必须与新库一致');
    assert.ok(backfillSearch.results[0].lexicalBreakdown, '懒回填后必须走新打分路径并返回分解');
    const db3 = new Database(dbPath);
    try {
      const postings = db3.prepare('SELECT COUNT(*) AS count FROM material_term_postings').get().count;
      assert.ok(postings > 0, '检索必须触发倒排懒回填');
      const marker = db3.prepare("SELECT value FROM material_lexical_stats WHERE key = 'backfilled:doc-1'").get();
      assert.equal(marker?.value, '1', '回填完成后必须写标记防止重复回填');
    } finally {
      db3.close();
    }

    // ---- 7. 删除清理：文档移除后倒排同步清理 ----
    assert.ok(index.removeKeywordIndexEntries(libraryPath, 'doc-2') > 0);
    const db4 = new Database(dbPath);
    try {
      const orphan = db4.prepare(`
        SELECT COUNT(*) AS count FROM material_term_postings AS postings
        WHERE NOT EXISTS (SELECT 1 FROM material_chunks AS chunks WHERE chunks.id = postings.chunk_rowid)
      `).get().count;
      assert.equal(orphan, 0, '删除文档时必须同步清理倒排投影');
    } finally {
      db4.close();
    }

    console.log('verify-lexscore-v2: postings projection, breakdown, title bonus, coverage gating, tf ranking, bounded keyword score, lazy backfill, delete cleanup passed');
  } finally {
    await removeTestArtifact(tempRoot);
    await removeTestArtifact(indexBundlePath);
    await removeTestArtifact(searchBundlePath);
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
  console.warn(`verify-lexscore-v2: 临时文件清理失败：${targetPath}`);
}
