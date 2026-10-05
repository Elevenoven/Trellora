const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.material-query-profile-test-'));
const indexBundlePath = path.join(rootDir, '.material-query-profile-index.cjs');
const searchBundlePath = path.join(rootDir, '.material-query-profile-search.cjs');
const coordinatorBundlePath = path.join(rootDir, '.material-query-profile-coordinator.cjs');
const libraryPath = path.join(tempRoot, 'library');
const chunksPath = path.join(tempRoot, 'chunks.jsonl');
const keywordsPath = path.join(tempRoot, 'keywords.jsonl');

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
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialVectorCoordinator.ts')], outfile: coordinatorBundlePath }),
    ]);
    const index = require(indexBundlePath);
    const search = require(searchBundlePath);
    const coordinator = require(coordinatorBundlePath);
    fs.mkdirSync(libraryPath, { recursive: true });

    const chunk = {
      schemaVersion: 1,
      documentId: 'doc-query',
      chunkId: 'chunk-query',
      parentChunkId: null,
      ordinal: 1,
      text: '访问控制必须保留完整审计留痕。',
      sourceRefs: [{ page: 7, block: 'query-1' }],
      sectionPath: [],
    };
    fs.writeFileSync(chunksPath, `${JSON.stringify(chunk)}\n`, 'utf8');
    fs.writeFileSync(keywordsPath, `${JSON.stringify(createKeywordRecord(chunk, [{ term: '访问控制', normalizedTerm: '访问控制', rank: 1, score: 0.95, kind: 'phrase', start: 0, end: 4 }]))}\n`, 'utf8');
    await index.importKeywordsStage({
      libraryPath,
      documentId: chunk.documentId,
      sourceContentHash: 'source-query-1',
      stageKey: 'stage-query-1',
      chunksPath,
      keywordsPath,
    });

    const candidate = {
      schemaVersion: 1,
      sourceId: 'profile-source-a',
      transportKind: 'ollama',
      endpointIdentity: 'http://127.0.0.1:11434',
      requestedModel: 'model-a',
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
      probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
      appVersion: 'verify-material-query-profile',
    });
    const indexAdapter = {
      probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
      embedBatch: async ({ texts }) => ({ vectors: texts.map(() => [1, 0]), dimension: 2, responseModel: 'model-a' }),
    };
    await coordinator.synchronizeMaterialVectors({ libraryPath, profile, adapter: indexAdapter });

    let credentialVersion = 'key-a';
    const queryModels = [];
    const queryCredentials = [];
    const queryAdapter = {
      probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
      embedBatch: async ({ profile: requestedProfile, texts }) => {
        queryModels.push(requestedProfile.requestedModel);
        queryCredentials.push(credentialVersion);
        return { vectors: texts.map(() => [1, 0]), dimension: 2, responseModel: 'model-a' };
      },
    };

    const first = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'hybrid', adapter: queryAdapter });
    assert.equal(first.vectorIndexed, true);
    assert.equal(first.results[0].chunkId, 'chunk-query');
    assert.ok(first.results[0].matchTypes.includes('语义'));
    assert.deepEqual(queryModels, ['model-a'], 'query adapter 必须收到锁定 profile 的模型');

    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    const beforeRotation = new Database(databasePath);
    sqliteVec.load(beforeRotation);
    const profileHashBeforeRotation = beforeRotation.prepare('SELECT profile_hash AS profileHash FROM material_embedding_profile WHERE singleton_id = 1').get().profileHash;
    const vectorRowsBeforeRotation = beforeRotation.prepare('SELECT COUNT(*) AS count FROM material_chunk_vectors').get().count;
    beforeRotation.close();
    credentialVersion = 'key-b';
    const afterRotation = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'semantic', adapter: queryAdapter });
    assert.equal(afterRotation.results[0].chunkId, 'chunk-query');
    assert.deepEqual(queryCredentials, ['key-a', 'key-b'], 'API Key 轮换只应改变凭据，不应改变 query profile');
    const afterRotationDatabase = new Database(databasePath);
    sqliteVec.load(afterRotationDatabase);
    assert.equal(afterRotationDatabase.prepare('SELECT profile_hash AS profileHash FROM material_embedding_profile WHERE singleton_id = 1').get().profileHash, profileHashBeforeRotation);
    assert.equal(afterRotationDatabase.prepare('SELECT COUNT(*) AS count FROM material_chunk_vectors').get().count, vectorRowsBeforeRotation);
    afterRotationDatabase.close();

    const wrongDimensionAdapter = {
      probe: async () => ({ vectorDimension: 3, responseModel: 'model-a' }),
      embedBatch: async () => ({ vectors: [[1, 0, 0]], dimension: 3, responseModel: 'model-a' }),
    };
    const wrongDimension = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'hybrid', adapter: wrongDimensionAdapter });
    assert.equal(wrongDimension.results[0].chunkId, 'chunk-query');
    assert.ok(wrongDimension.notice?.includes('维度'));
    const wrongDimensionSemantic = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'semantic', adapter: wrongDimensionAdapter });
    assert.equal(wrongDimensionSemantic.results.length, 0);
    assert.ok(wrongDimensionSemantic.notice?.includes('维度'));

    const failingAdapter = {
      probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
      embedBatch: async () => {
        const error = new Error('向量服务拒绝当前 API Key。');
        error.code = 'EMBEDDING_AUTH_FAILED';
        throw error;
      },
    };
    const fallback = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'hybrid', adapter: failingAdapter });
    assert.equal(fallback.results[0].chunkId, 'chunk-query');
    assert.ok(fallback.notice?.includes('向量检索不可用'));
    const semanticFailure = await search.searchMaterialChunks({ libraryPath, query: '访问控制', mode: 'semantic', adapter: failingAdapter });
    assert.equal(semanticFailure.results.length, 0);
    assert.ok(semanticFailure.notice?.includes('API Key'));

    const mismatchDatabase = new Database(databasePath);
    mismatchDatabase.prepare('UPDATE material_chunk_vector_meta SET value = ? WHERE key = ?').run('different-profile', 'embedding_profile_hash');
    mismatchDatabase.close();
    let mismatchCalls = 0;
    const mismatch = await search.searchMaterialChunks({
      libraryPath,
      query: '访问控制',
      mode: 'hybrid',
      adapter: {
        probe: queryAdapter.probe,
        embedBatch: async (request) => {
          mismatchCalls += 1;
          return queryAdapter.embedBatch(request);
        },
      },
    });
    assert.equal(mismatch.vectorIndexed, false);
    assert.equal(mismatchCalls, 0, 'profile/vector meta 不一致时不得调用 query embedding');
    assert.equal(mismatch.results[0].chunkId, 'chunk-query');
    assert.ok(mismatch.notice?.includes('profile'));

    const mainSource = fs.readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
    const searchHandlerStart = mainSource.indexOf("registerAppHandler('search-material-chunks'");
    const searchHandlerEnd = mainSource.indexOf("registerAppHandler('start-materials-pipeline'", searchHandlerStart);
    assert.ok(searchHandlerStart >= 0 && searchHandlerEnd > searchHandlerStart, '资料库查询 IPC 处理器必须存在');
    const searchHandlerSource = mainSource.slice(searchHandlerStart, searchHandlerEnd);
    assert.doesNotMatch(searchHandlerSource, /getConfiguredEmbeddingModel\(\)/, '资料库查询不能读取全局 embedding 模型');
    assert.doesNotMatch(searchHandlerSource, /embeddingModel\s*:/, '资料库查询 IPC 不得接受 renderer 指定模型');
    assert.match(mainSource, /resolveLockedMaterialEmbeddingAdapter\(profileStatus\.profile\)/, '查询必须按锁定 profile 解析来源凭据');

    console.log('verify-material-query-profile: locked-profile query model/dimension binding, key rotation, global-model isolation, lexical fallback, and profile/state mismatch protection passed');
  } finally {
    await removeTestArtifact(tempRoot);
    await removeTestArtifact(indexBundlePath);
    await removeTestArtifact(searchBundlePath);
    await removeTestArtifact(coordinatorBundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

function createKeywordRecord(chunk, keywords) {
  return {
    schemaVersion: 1,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    parentChunkId: chunk.parentChunkId,
    chunkContentHash: `sha256:${crypto.createHash('sha256').update(chunk.text, 'utf8').digest('hex')}`,
    algorithm: { version: 'kw-1' },
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
  console.warn(`verify-material-query-profile: 临时文件清理失败：${targetPath}`);
}
