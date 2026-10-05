const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.material-vector-risk-test-'));
const bundlePath = path.join(rootDir, '.material-vector-risk-verification.cjs');
const libraryPath = path.join(tempRoot, 'library');

(async () => {
  try {
    await build({
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['better-sqlite3', 'sqlite-vec'],
      entryPoints: [path.join(rootDir, 'electron/pipeline/materialChunkSearch.ts')],
      outfile: bundlePath,
    });

    const search = require(bundlePath);
    fs.mkdirSync(libraryPath, { recursive: true });
    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    try {
      search.ensureMaterialChunkSearchSchema(database);
      search.replaceMaterialChunkProjection(database, {
        documentId: 'doc-1',
        sourceContentHash: 'source-1',
        stageKey: 'stage-1',
        chunks: [{
          documentId: 'doc-1',
          chunkId: 'chunk-1',
          parentChunkId: null,
          ordinal: 1,
          text: '模型切换风险基线。',
          sourceText: '模型切换风险基线。',
          sectionPath: [],
          sectionContext: '',
          sourceRefs: [{ page: 1 }],
          contentHash: 'hash-1',
          searchTokens: ['模型', '切换', '风险', '基线'],
        }],
        keywords: [],
      });
    } finally {
      database.close();
    }

    const legacyDatabase = new Database(databasePath);
    try {
      sqliteVec.load(legacyDatabase);
      legacyDatabase.exec('CREATE VIRTUAL TABLE material_chunk_vectors USING vec0(embedding float[2] distance_metric=cosine)');
      legacyDatabase.prepare('INSERT INTO material_chunk_vectors(rowid, embedding) VALUES (?, ?)').run(BigInt(1), Buffer.from(new Float32Array([1, 0]).buffer));
      legacyDatabase.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('embedding_model', 'legacy-model');
      legacyDatabase.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('vector_dimension', '2');
    } finally {
      legacyDatabase.close();
    }

    await assert.rejects(
      search.synchronizeMaterialChunkVectors({
        libraryPath,
        embeddingModel: 'model-a',
        embed: async ({ texts }) => texts.map(() => [1, 0]),
      }),
      (error) => error?.code === 'EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION',
    );

    const afterRejectedOverride = new Database(databasePath);
    try {
      sqliteVec.load(afterRejectedOverride);
      assert.equal(afterRejectedOverride.prepare('SELECT COUNT(*) AS count FROM material_chunk_vectors').get().count, 1);
      assert.equal(afterRejectedOverride.prepare('SELECT COUNT(*) AS count FROM material_chunk_vector_meta').get().count, 2);
    } finally {
      afterRejectedOverride.close();
    }

    const mainSource = fs.readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(rootDir, 'electron/preload.ts'), 'utf8');
    assert.doesNotMatch(mainSource, /ipcMain\.handle\('rebuild-material-chunk-vectors'/, 'renderer 不应再拥有旧版可变模型重建 IPC');
    const searchHandlerStart = mainSource.indexOf("registerAppHandler('search-material-chunks'");
    const searchHandlerEnd = mainSource.indexOf("registerAppHandler('start-materials-pipeline'", searchHandlerStart);
    assert.ok(searchHandlerStart >= 0 && searchHandlerEnd > searchHandlerStart, '资料库查询 IPC 处理器必须存在');
    const searchHandlerSource = mainSource.slice(searchHandlerStart, searchHandlerEnd);
    assert.doesNotMatch(searchHandlerSource, /getConfiguredEmbeddingModel\(\)/, '资料库查询不应读取全局 embedding 模型');
    assert.doesNotMatch(searchHandlerSource, /embeddingModel\s*:/, '资料库查询不应接受 renderer 指定模型');
    assert.doesNotMatch(preloadSource, /rebuildMaterialChunkVectors/, 'preload 不应暴露可传入模型名的旧版重建入口');

    console.log('verify-material-vector-legacy-risk: legacy vector override is rejected without DB mutation, while renderer model override IPC is removed');
  } finally {
    await removeTestArtifact(tempRoot);
    await removeTestArtifact(bundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function removeTestArtifact(targetPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn(`verify-material-vector-legacy-risk: 临时文件清理失败：${targetPath}`);
}
