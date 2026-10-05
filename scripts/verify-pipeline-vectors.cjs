const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.pipeline-vectors-test-'));
const artifactBundle = path.join(rootDir, '.pipeline-vectors-artifact.cjs');
const coordinatorBundle = path.join(rootDir, '.pipeline-vectors-coordinator.cjs');
const libraryPath = path.join(tempRoot, 'library');
const documentId = 'doc-vectors';
const document = {
  id: documentId,
  name: '向量阶段验证.md',
  extension: '.md',
  relativePath: '向量阶段验证.md',
  absolutePath: path.join(libraryPath, '向量阶段验证.md'),
  contentHash: 'source-vectors-1',
  sizeBytes: 18,
};

(async () => {
  try {
    await build({
      entryPoints: [path.join(rootDir, 'electron/pipeline/artifactStore.ts')],
      outfile: artifactBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['better-sqlite3'],
    });
    await build({
      entryPoints: [path.join(rootDir, 'electron/pipeline/materialVectorCoordinator.ts')],
      outfile: coordinatorBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['better-sqlite3'],
    });

    const artifact = require(artifactBundle);
    const coordinator = require(coordinatorBundle);
    fs.mkdirSync(libraryPath, { recursive: true });
    fs.writeFileSync(document.absolutePath, '向量阶段验证内容。', 'utf8');

    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    try {
      coordinator.ensureMaterialChunkSearchSchema(database);
      const text = '向量阶段验证内容。';
      const contentHash = `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
      const inserted = database.prepare(`INSERT INTO material_chunks (
        document_id, chunk_id, parent_chunk_id, ordinal, text, source_text,
        section_path_json, section_context, source_refs_json, content_hash, keyword_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(documentId, 'chunk-1', null, 1, text, text, '[]', '', '[]', contentHash, '向量 阶段');
      database.prepare(`INSERT INTO material_chunk_fts (rowid, document_id, chunk_id, text, keyword_text, section_path)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(inserted.lastInsertRowid, documentId, 'chunk-1', text, '向量 阶段', '');
    } finally {
      database.close();
    }

    const profile = await coordinator.lockMaterialEmbeddingProfile({
      libraryPath,
      candidate: {
        schemaVersion: 1,
        sourceId: 'verify-ollama',
        transportKind: 'ollama',
        endpointIdentity: 'http://127.0.0.1:11434',
        requestedModel: 'verify-embedding',
        vectorType: 'float32',
        distanceMetric: 'cosine',
        encodingFormat: 'float',
        truncateInputs: false,
        documentInputVersion: 'material-chunk-text-v1',
        queryInputVersion: 'material-query-text-v1',
      },
      probe: async () => ({ vectorDimension: 2, responseModel: 'verify-embedding' }),
      appVersion: 'verify-pipeline-vectors',
    });

    let adapterCalls = 0;
    const firstRun = await coordinator.synchronizeMaterialVectors({
      libraryPath,
      documentId,
      profile,
      batchSize: 1,
      maxAttempts: 1,
      sleep: async () => {},
      adapter: {
        probe: async () => ({ vectorDimension: 2, responseModel: 'verify-embedding' }),
        embedBatch: async ({ texts }) => {
          adapterCalls += 1;
          return { vectors: texts.map(() => [0.25, 0.75]), dimension: 2 };
        },
      },
    });
    assert.equal(firstRun.state, 'SUCCEEDED', `${firstRun.errorCode || ''} ${firstRun.errorMessage || ''}`);
    assert.equal(firstRun.completedItems, 1);
    assert.equal(adapterCalls, 1);
    assert.equal(coordinator.isMaterialVectorProjectionCurrent({ libraryPath, documentId, profileHash: profile.profileHash, expectedChunks: 1 }), true);

    const layout = artifact.prepareParseLayout(libraryPath, document, '', 'disabled', 'default', 'keywords-v1', 'disabled', false, profile.profileHash);
    assert.equal(path.basename(layout.vectorsDirectory), '08-vectors');
    assert.deepEqual(artifact.stageOutputNames(layout, 'vectors'), ['vector-report.json']);
    const firstStageKey = artifact.vectorsStageKey(layout);
    const changedProfileLayout = artifact.prepareParseLayout(libraryPath, document, '', 'disabled', 'default', 'keywords-v1', 'disabled', false, `${profile.profileHash}-changed`);
    assert.notEqual(artifact.vectorsStageKey(changedProfileLayout), firstStageKey);

    const tempDirectory = artifact.createStageTempDirectory(layout, 'vectors', 'verify-job');
    fs.writeFileSync(path.join(tempDirectory, 'vector-report.json'), `${JSON.stringify({
      schemaVersion: 1,
      documentId,
      stageKey: firstStageKey,
      profileHash: profile.profileHash,
      sourceId: profile.sourceId,
      model: profile.responseModel,
      dimension: profile.vectorDimension,
      distanceMetric: profile.distanceMetric,
      counts: { chunks: 1, indexed: 1, skipped: 0, failed: 0, batches: 1, retries: 0 },
      usage: { available: false },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    await artifact.commitVectorsStage(layout, tempDirectory);
    assert.equal(await artifact.isStageCacheValid(layout, 'vectors'), true);
    assert.equal(artifact.isVectorProjectionCurrent(layout), true);

    const snapshot = coordinator.readMaterialVectorProjectionSnapshot(libraryPath, documentId);
    assert.equal(snapshot.profile.profileHash, profile.profileHash);
    assert.deepEqual(snapshot.progress, {
      totalItems: 1,
      completedItems: 1,
      pendingItems: 0,
      inFlightItems: 0,
      failedItems: 0,
    });

    const damagedDatabase = new Database(databasePath);
    try {
      sqliteVec.load(damagedDatabase);
      damagedDatabase.prepare('DELETE FROM material_chunk_vectors').run();
    } finally {
      damagedDatabase.close();
    }
    assert.equal(artifact.isVectorProjectionCurrent(layout), false);
    const repair = await coordinator.synchronizeMaterialVectors({
      libraryPath,
      documentId,
      profile,
      batchSize: 1,
      maxAttempts: 1,
      sleep: async () => {},
      adapter: {
        probe: async () => ({ vectorDimension: 2, responseModel: 'verify-embedding' }),
        embedBatch: async ({ texts }) => {
          adapterCalls += 1;
          return { vectors: texts.map(() => [0.25, 0.75]), dimension: 2 };
        },
      },
    });
    assert.equal(repair.state, 'SUCCEEDED');
    assert.equal(adapterCalls, 2);
    assert.equal(coordinator.isMaterialVectorProjectionCurrent({ libraryPath, documentId, profileHash: profile.profileHash, expectedChunks: 1 }), true);

    console.log('verify-pipeline-vectors: vectors stage layout, profile-bound cache key, report commit, SQLite projection readback, repair and invalidation passed');
  } finally {
    await removeTestArtifact(tempRoot, true);
    await removeTestArtifact(artifactBundle, false);
    await removeTestArtifact(coordinatorBundle, false);
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
  console.warn(`verify-pipeline-vectors: 临时文件清理失败，已保留供诊断：${targetPath}`, lastError);
}
