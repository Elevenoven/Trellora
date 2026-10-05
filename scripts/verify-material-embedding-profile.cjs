const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const rootDir = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(rootDir, '.material-embedding-profile-test-'));
const bundlePath = path.join(rootDir, '.material-embedding-profile-verification.cjs');
const searchBundlePath = path.join(rootDir, '.material-embedding-profile-search-verification.cjs');

(async () => {
  try {
    const buildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['better-sqlite3', 'sqlite-vec'] };
    await Promise.all([
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialEmbeddingProfile.ts')], outfile: bundlePath }),
      build({ ...buildOptions, entryPoints: [path.join(rootDir, 'electron/pipeline/materialChunkSearch.ts')], outfile: searchBundlePath }),
    ]);
    const profile = require(bundlePath);
    const search = require(searchBundlePath);
    const candidate = createCandidate();

    const probe = async () => ({ vectorDimension: 3, responseModel: 'model-a' });
    const tested = await profile.testMaterialEmbeddingCandidate({ candidate, probe });
    assert.equal(tested.state, 'TESTED');
    assert.equal(tested.vectorDimension, 3);
    assert.equal(fs.existsSync(path.join(tempRoot, 'unbound', '.menghan-meta', 'index.db')), false, '探测不应创建资料库 DB');

    const libraryPath = path.join(tempRoot, 'locked');
    fs.mkdirSync(libraryPath, { recursive: true });
    const locked = await profile.lockMaterialEmbeddingProfile({ libraryPath, candidate, probe, appVersion: 'test-app-1' });
    assert.equal(locked.state, 'LOCKED');
    assert.equal(locked.profileHash, tested.profileHash);

    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    const database = new Database(databasePath);
    try {
      sqliteVec.load(database);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM material_embedding_profile').get().count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM material_chunk_vectors').get().count, 0);
      const vectorSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'material_chunk_vectors'").get().sql;
      assert.match(vectorSql, /float\[3\]/);
    } finally {
      database.close();
    }

    const repeated = await profile.lockMaterialEmbeddingProfile({ libraryPath, candidate, probe, appVersion: 'test-app-2' });
    assert.equal(repeated.profileHash, locked.profileHash, '同一候选重复锁定必须幂等');
    await assert.rejects(
      search.synchronizeMaterialChunkVectors({ libraryPath, embeddingModel: 'model-a', embed: async () => [[1, 0, 0]] }),
      (error) => error?.code === 'EMBEDDING_PROFILE_LOCKED',
      '锁定后旧版直接重建入口必须停止写入',
    );
    const rotatedKeyCandidate = { ...candidate, apiKey: 'rotated-key-is-not-part-of-candidate' };
    assert.equal(
      profile.computeMaterialEmbeddingProfileHash({ candidate, responseModel: 'model-a', vectorDimension: 3 }),
      profile.computeMaterialEmbeddingProfileHash({ candidate: rotatedKeyCandidate, responseModel: 'model-a', vectorDimension: 3 }),
      'API Key 不得影响 profileHash',
    );

    const lockedVariants = [
      { ...candidate, sourceId: 'another-source' },
      { ...candidate, requestedModel: 'model-b' },
      { ...candidate, requestedDimensions: 4 },
      { ...candidate, endpointIdentity: 'http://127.0.0.1:11435' },
      { ...candidate, documentInputVersion: 'material-chunk-text-v2' },
    ];
    for (const variant of lockedVariants) {
      const variantProbe = async () => ({ vectorDimension: variant.requestedDimensions ?? 3, responseModel: variant.requestedModel });
      await assert.rejects(
        profile.lockMaterialEmbeddingProfile({ libraryPath, candidate: variant, probe: variantProbe }),
        (error) => error?.code === 'EMBEDDING_PROFILE_LOCKED',
      );
    }

    const concurrentLibraryPath = path.join(tempRoot, 'concurrent');
    fs.mkdirSync(concurrentLibraryPath, { recursive: true });
    const candidateB = { ...candidate, requestedModel: 'model-b' };
    const concurrentProbe = async ({ candidate: inputCandidate }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { vectorDimension: inputCandidate.requestedModel === 'model-b' ? 4 : 3, responseModel: inputCandidate.requestedModel };
    };
    const concurrentResults = await Promise.allSettled([
      profile.lockMaterialEmbeddingProfile({ libraryPath: concurrentLibraryPath, candidate, probe: concurrentProbe }),
      profile.lockMaterialEmbeddingProfile({ libraryPath: concurrentLibraryPath, candidate: candidateB, probe: concurrentProbe }),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1, '并发不同候选只能有一个成功锁定事实');
    assert.equal(concurrentResults.filter((result) => result.status === 'rejected' && result.reason?.code === 'EMBEDDING_PROFILE_LOCKED').length, 1);

    const failedLibraryPath = path.join(tempRoot, 'probe-failed');
    fs.mkdirSync(failedLibraryPath, { recursive: true });
    await assert.rejects(
      profile.lockMaterialEmbeddingProfile({ libraryPath: failedLibraryPath, candidate, probe: async () => { throw new Error('network down'); } }),
      (error) => error?.code === 'EMBEDDING_PROBE_FAILED',
    );
    assert.equal(fs.existsSync(path.join(failedLibraryPath, '.menghan-meta', 'index.db')), false, '探测失败不得创建 profile 或 vec0 表');

    const legacyLibraryPath = path.join(tempRoot, 'legacy');
    const legacyDatabasePath = path.join(legacyLibraryPath, '.menghan-meta', 'index.db');
    fs.mkdirSync(path.dirname(legacyDatabasePath), { recursive: true });
    const legacyDatabase = new Database(legacyDatabasePath);
    sqliteVec.load(legacyDatabase);
    legacyDatabase.exec('CREATE VIRTUAL TABLE material_chunk_vectors USING vec0(embedding float[3] distance_metric=cosine)');
    legacyDatabase.prepare('INSERT INTO material_chunk_vectors(rowid, embedding) VALUES (?, ?)').run(1n, Buffer.from(new Float32Array([1, 0, 0]).buffer));
    legacyDatabase.exec('CREATE TABLE material_chunk_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacyDatabase.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('embedding_model', 'legacy-model');
    legacyDatabase.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('vector_dimension', '3');
    legacyDatabase.close();
    assert.equal(profile.readMaterialEmbeddingProfile(legacyLibraryPath).state, 'LEGACY_UNBOUND');
    await assert.rejects(
      profile.lockMaterialEmbeddingProfile({ libraryPath: legacyLibraryPath, candidate, probe }),
      (error) => error?.code === 'EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION',
    );

    console.log('verify-material-embedding-profile: canonical hash, probe isolation, fixed-dimension schema, idempotent lock, mismatch rejection, concurrent lock, API key exclusion, and legacy detection passed');
  } finally {
    await removeTestArtifact(tempRoot);
    await removeTestArtifact(bundlePath);
    await removeTestArtifact(searchBundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

function createCandidate() {
  return {
    schemaVersion: 1,
    sourceId: 'ollama',
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
  console.warn(`verify-material-embedding-profile: 临时文件清理失败：${targetPath}`);
}
