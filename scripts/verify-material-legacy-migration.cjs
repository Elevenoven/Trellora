const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { inspectLegacyVectors, migrateLegacyVectors } = require('./migrate-material-legacy-vectors.cjs');

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'menghan-legacy-migration-'));
  try {
    const libraryPath = path.join(tempRoot, 'library');
    const databasePath = path.join(libraryPath, '.menghan-meta', 'index.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    sqliteVec.load(database);
    database.exec(`
      CREATE TABLE material_chunk_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE material_chunk_vectors USING vec0(embedding float[2] distance_metric=cosine);
      CREATE TABLE material_chunk_embedding_state (chunk_rowid INTEGER PRIMARY KEY, document_id TEXT, chunk_id TEXT, chunk_content_hash TEXT, profile_hash TEXT, state TEXT, attempt_count INTEGER, lease_token TEXT, lease_expires_at TEXT, last_error_code TEXT, last_error_message TEXT, updated_at TEXT);
      CREATE TABLE material_embedding_jobs (job_id TEXT PRIMARY KEY, document_id TEXT, profile_hash TEXT, state TEXT, total_items INTEGER, completed_items INTEGER, skipped_items INTEGER, failed_items INTEGER, batch_count INTEGER, retry_count INTEGER, created_at TEXT, started_at TEXT, updated_at TEXT, finished_at TEXT, error_code TEXT, error_message TEXT);
    `);
    database.prepare('INSERT INTO material_chunk_vectors(rowid, embedding) VALUES (?, ?)').run(BigInt(1), Buffer.from(new Float32Array([1, 0]).buffer));
    database.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('embedding_model', 'legacy-model');
    database.prepare('INSERT INTO material_chunk_vector_meta(key, value) VALUES (?, ?)').run('vector_dimension', '2');
    database.prepare('INSERT INTO material_chunk_embedding_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(1, 'doc-1', 'chunk-1', 'hash-1', 'legacy', 'SUCCEEDED', 1, null, null, null, null, new Date().toISOString());
    database.prepare('INSERT INTO material_embedding_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('job-1', 'doc-1', 'legacy', 'SUCCEEDED', 1, 1, 0, 0, 1, 0, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), null, null);
    database.close();

    const before = inspectLegacyVectors(libraryPath);
    assert.equal(before.state, 'LEGACY_UNBOUND');
    const result = await migrateLegacyVectors({ libraryPath, backupDirectory: path.join(tempRoot, 'backups') });
    assert.equal(result.action, 'MIGRATED');
    assert.equal(result.after.state, 'UNBOUND');
    assert.equal(fs.existsSync(result.backupPath), true);
    assert.equal(fs.existsSync(result.metadataPath), true);

    const migrated = new Database(databasePath);
    assert.equal(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'material_chunk_vectors'").get(), undefined);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM material_chunk_vector_meta').get().count, 0);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM material_chunk_embedding_state').get().count, 0);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM material_embedding_jobs').get().count, 0);
    migrated.close();

    const lockedLibraryPath = path.join(tempRoot, 'locked-library');
    const lockedDatabasePath = path.join(lockedLibraryPath, '.menghan-meta', 'index.db');
    fs.mkdirSync(path.dirname(lockedDatabasePath), { recursive: true });
    const lockedDatabase = new Database(lockedDatabasePath);
    sqliteVec.load(lockedDatabase);
    lockedDatabase.exec(`
      CREATE TABLE material_embedding_profile (singleton_id INTEGER PRIMARY KEY, profile_hash TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE material_chunk_vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE material_chunk_vectors USING vec0(embedding float[2] distance_metric=cosine);
    `);
    lockedDatabase.prepare('INSERT INTO material_embedding_profile(singleton_id, profile_hash, state) VALUES (1, ?, ?)').run('locked-hash', 'LOCKED');
    lockedDatabase.prepare('INSERT INTO material_chunk_vectors(rowid, embedding) VALUES (?, ?)').run(BigInt(1), Buffer.from(new Float32Array([1, 0]).buffer));
    lockedDatabase.close();
    await assert.rejects(
      () => migrateLegacyVectors({ libraryPath: lockedLibraryPath, backupDirectory: path.join(tempRoot, 'locked-backups') }),
      /LOCKED/u,
      '已锁定 profile 不得被 legacy 迁移脚本修改',
    );
    console.log('verify-material-legacy-migration: backup, explicit cleanup, metadata reset, state/job cleanup, and UNBOUND recovery passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
