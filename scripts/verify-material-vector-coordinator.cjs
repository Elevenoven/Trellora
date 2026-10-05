const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { build } = require('esbuild');

const rootDir = process.cwd();
const bundlePath = path.join(rootDir, '.material-vector-coordinator-verification.cjs');

(async () => {
  const api = await loadCoordinator();
  apiError = api.MaterialEmbeddingAdapterError;
  const fixture = await createFixture(api, 35);
  try {
    const normalCalls = [];
    const normal = await api.synchronizeMaterialVectors({
      libraryPath: fixture.libraryPath,
      documentId: 'doc-a',
      profile: fixture.profile,
      adapter: createAdapter(normalCalls),
      batchSize: 16,
      maxBatchCharacters: 100_000,
      sleep: async () => {},
      random: () => 0,
    });
    assert.deepEqual(normalCalls, [16, 16, 3]);
    assert.equal(normal.state, 'SUCCEEDED');
    assert.equal(normal.completedItems, 35);
    assert.equal(countRows(fixture.dbPath, 'material_chunk_vectors'), 35);
    assert.equal(countRows(fixture.dbPath, 'material_chunk_embedding_state', "state = 'SUCCEEDED'"), 35);
    assert.doesNotMatch(JSON.stringify(normal), /chunk text 1|0\.25/);

    updateChunk(fixture.dbPath, 5, 'chunk text changed', 'hash-changed');
    const changedCalls = [];
    const changed = await api.synchronizeMaterialVectors({
      libraryPath: fixture.libraryPath,
      documentId: 'doc-a',
      profile: fixture.profile,
      adapter: createAdapter(changedCalls),
      batchSize: 16,
      sleep: async () => {},
    });
    assert.deepEqual(changedCalls, [1]);
    assert.equal(changed.completedItems, 35);
    assert.equal(changed.skippedItems, 34);

    deleteVector(fixture.dbPath, 6);
    const missingCalls = [];
    const missing = await api.synchronizeMaterialVectors({
      libraryPath: fixture.libraryPath,
      documentId: 'doc-a',
      profile: fixture.profile,
      adapter: createAdapter(missingCalls),
      batchSize: 16,
      sleep: async () => {},
    });
    assert.deepEqual(missingCalls, [1]);
    assert.equal(missing.completedItems, 35);

    const failedFixture = await createFixture(api, 35);
    try {
      let call = 0;
      const failedFirst = await api.synchronizeMaterialVectors({
        libraryPath: failedFixture.libraryPath,
        documentId: 'doc-a',
        profile: failedFixture.profile,
        adapter: createAdapter([], { failOnCall: () => ++call === 2 }),
        batchSize: 16,
        maxAttempts: 1,
        sleep: async () => {},
      });
      assert.equal(failedFirst.state, 'FAILED_RETRYABLE');
      assert.equal(failedFirst.completedItems, 16);
      assert.equal(countRows(failedFixture.dbPath, 'material_chunk_vectors'), 16);
      const restartCalls = [];
      const restarted = await api.synchronizeMaterialVectors({
        libraryPath: failedFixture.libraryPath,
        documentId: 'doc-a',
        profile: failedFixture.profile,
        adapter: createAdapter(restartCalls),
        batchSize: 16,
        sleep: async () => {},
      });
      assert.deepEqual(restartCalls, [16, 3]);
      assert.equal(restarted.state, 'SUCCEEDED');
      assert.equal(restarted.completedItems, 35);
    } finally {
      removeDirectory(failedFixture.rootPath);
    }

    const splitFixture = await createFixture(api, 35);
    try {
      const splitCalls = [];
      const split = await api.synchronizeMaterialVectors({
        libraryPath: splitFixture.libraryPath,
        documentId: 'doc-a',
        profile: splitFixture.profile,
        adapter: createAdapter(splitCalls, { rejectAbove: 4 }),
        batchSize: 16,
        maxAttempts: 2,
        sleep: async () => {},
      });
      assert.deepEqual(splitCalls, [16, 8, 4, 4, 8, 4, 4, 16, 8, 4, 4, 8, 4, 4, 3]);
      assert.equal(split.state, 'SUCCEEDED');
      assert.equal(split.completedItems, 35);
    } finally {
      removeDirectory(splitFixture.rootPath);
    }

    const databaseFailureFixture = await createFixture(api, 35);
    try {
      const dbFailure = await api.synchronizeMaterialVectors({
        libraryPath: databaseFailureFixture.libraryPath,
        documentId: 'doc-a',
        profile: databaseFailureFixture.profile,
        adapter: createAdapter([]),
        batchSize: 16,
        maxAttempts: 1,
        sleep: async () => {},
        beforeBatchCommit: () => { throw new Error('simulated db failure'); },
      });
      assert.equal(dbFailure.state, 'FAILED_RETRYABLE');
      assert.equal(countRows(databaseFailureFixture.dbPath, 'material_chunk_vectors'), 0);
    } finally {
      removeDirectory(databaseFailureFixture.rootPath);
    }

    const cancelFixture = await createFixture(api, 35);
    try {
      const cancelled = await api.synchronizeMaterialVectors({
        libraryPath: cancelFixture.libraryPath,
        documentId: 'doc-a',
        profile: cancelFixture.profile,
        adapter: {
          probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
          embedBatch: async () => { throw new apiError('EMBEDDING_CANCELLED', 'simulated cancellation'); },
        },
        batchSize: 16,
        sleep: async () => {},
      });
      assert.equal(cancelled.state, 'CANCELLED');
      assert.equal(cancelled.completedItems, 0);
      assert.equal(countRows(cancelFixture.dbPath, 'material_chunk_embedding_state', "state = 'PENDING'"), 35);
    } finally {
      removeDirectory(cancelFixture.rootPath);
    }

    const oversizedFixture = await createFixture(api, 2);
    try {
      const oversized = await api.synchronizeMaterialVectors({
        libraryPath: oversizedFixture.libraryPath,
        documentId: 'doc-a',
        profile: oversizedFixture.profile,
        adapter: createAdapter([], { rejectAbove: 0 }),
        batchSize: 2,
        maxAttempts: 1,
        sleep: async () => {},
      });
      assert.equal(oversized.state, 'FAILED');
      assert.equal(oversized.failedItems, 2);
      assert.equal(countRows(oversizedFixture.dbPath, 'material_chunk_vectors'), 0);
    } finally {
      removeDirectory(oversizedFixture.rootPath);
    }

    const leaseFixture = await createFixture(api, 35);
    try {
      const db = new Database(leaseFixture.dbPath);
      api.ensureMaterialVectorCoordinatorSchema(db);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO material_chunk_embedding_state (
          chunk_rowid, document_id, chunk_id, chunk_content_hash, profile_hash,
          state, attempt_count, lease_token, lease_expires_at, updated_at
        ) VALUES (1, 'doc-a', 'chunk-1', 'hash-1', ?, 'IN_FLIGHT', 1, 'expired', ?, ?)
      `).run(leaseFixture.profile.profileHash, '2000-01-01T00:00:00.000Z', now);
      db.close();
      const recoveredCalls = [];
      const recovered = await api.synchronizeMaterialVectors({
        libraryPath: leaseFixture.libraryPath,
        documentId: 'doc-a',
        profile: leaseFixture.profile,
        adapter: createAdapter(recoveredCalls),
        batchSize: 16,
        sleep: async () => {},
      });
      assert.equal(recovered.state, 'SUCCEEDED');
      assert.equal(recovered.completedItems, 35);
      assert.equal(recoveredCalls[0], 16);
    } finally {
      removeDirectory(leaseFixture.rootPath);
    }

    const db = new Database(fixture.dbPath);
    sqliteVec.load(db);
    const removed = api.removeMaterialVectorEntries(db, 'doc-a');
    assert.equal(removed, 35);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM material_chunk_vectors').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM material_chunk_embedding_state').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM material_embedding_jobs').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM material_embedding_profile').get().count, 1);
    db.close();

    console.log('verify-material-vector-coordinator: 16/16/3 batching, checkpoint resume, content-hash reconciliation, missing-vector repair, 413 binary split, lease recovery, transactional rollback, cleanup, and metadata-only reports passed');
  } finally {
    removeDirectory(fixture.rootPath);
    removeTestArtifact(bundlePath);
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  removeTestArtifact(bundlePath);
  process.exit(1);
});

async function loadCoordinator() {
  await build({
    entryPoints: [path.join(rootDir, 'electron/pipeline/materialVectorCoordinator.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3'],
  });
  return require(bundlePath);
}

async function createFixture(api, count) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'menghan-vector-coordinator-'));
  const libraryPath = path.join(rootPath, 'library');
  fs.mkdirSync(libraryPath, { recursive: true });
  const dbPath = path.join(libraryPath, '.menghan-meta', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  api.ensureMaterialChunkSearchSchema(db);
  const insert = db.prepare(`
    INSERT INTO material_chunks (
      id, document_id, chunk_id, parent_chunk_id, ordinal, text, source_text,
      section_path_json, section_context, source_refs_json, content_hash, keyword_text
    ) VALUES (?, 'doc-a', ?, NULL, ?, ?, ?, '[]', '', '[]', ?, '')
  `);
  const transaction = db.transaction(() => {
    for (let index = 1; index <= count; index += 1) {
      insert.run(index, `chunk-${index}`, index, `chunk text ${index}`, `chunk text ${index}`, `hash-${index}`);
    }
  });
  transaction();
  db.close();
  const candidate = {
    schemaVersion: 1,
    sourceId: 'coordinator-test',
    transportKind: 'ollama',
    endpointIdentity: 'http://127.0.0.1:11434',
    requestedModel: 'model-a',
    vectorType: 'float32',
    distanceMetric: 'cosine',
    encodingFormat: 'float',
    truncateInputs: false,
    documentInputVersion: 'material-chunk-text-v1',
    queryInputVersion: 'material-query-text-v1',
  };
  const profile = await api.lockMaterialEmbeddingProfile({
    libraryPath,
    candidate,
    probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
    appVersion: 'verify',
  });
  return { rootPath, libraryPath, dbPath, profile };
}

function createAdapter(calls, options = {}) {
  let callCount = 0;
  return {
    probe: async () => ({ vectorDimension: 2, responseModel: 'model-a' }),
    embedBatch: async ({ texts }) => {
      calls.push(texts.length);
      callCount += 1;
      if (options.failOnCall?.(callCount)) {
        throw new apiError('EMBEDDING_NETWORK_ERROR', 'simulated network failure', { retryable: true });
      }
      if (options.rejectAbove !== undefined && texts.length > options.rejectAbove) {
        throw new apiError('EMBEDDING_BATCH_TOO_LARGE', 'simulated 413', { retryable: true, status: 413 });
      }
      return { vectors: texts.map((_, index) => [1, index % 2]), dimension: 2, responseModel: 'model-a' };
    },
  };
}

let apiError;

function countRows(dbPath, table, where = '') {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get();
  db.close();
  return Number(row.count);
}

function updateChunk(dbPath, rowId, text, hash) {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.prepare('UPDATE material_chunks SET text = ?, source_text = ?, content_hash = ? WHERE id = ?').run(text, text, hash, rowId);
  db.close();
}

function deleteVector(dbPath, rowId) {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.prepare('DELETE FROM material_chunk_vectors WHERE rowid = ?').run(BigInt(rowId));
  db.close();
}

function removeDirectory(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
}

function removeTestArtifact(target) {
  try { fs.rmSync(target, { force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
}
