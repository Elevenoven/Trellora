const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const vectorTableName = 'material_chunk_vectors';
const vectorMetaTableName = 'material_chunk_vector_meta';
const profileTableName = 'material_embedding_profile';
const stateTableName = 'material_chunk_embedding_state';
const jobsTableName = 'material_embedding_jobs';

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.libraryPath) {
    throw new Error('请提供 --library <资料库路径>，或设置 MENGHAN_MATERIAL_LIBRARY。默认只做迁移预检；真正清理必须显式传 --apply。');
  }
  const report = inspectLegacyVectors(options.libraryPath);
  if (report.state === 'LOCKED') {
    throw new Error('资料库已有 LOCKED profile，拒绝执行 legacy 清理；已锁定语义空间不得被迁移脚本修改。');
  }
  if (report.state !== 'LEGACY_UNBOUND') {
    printReport({ ...report, action: 'NOOP', message: '没有发现带向量行的未标识 legacy 索引，无需迁移。' });
    return;
  }
  if (!options.apply) {
    printReport({ ...report, action: 'PLAN', message: '发现 legacy 向量。请先确认备份目录，再使用 --apply 清理；清理后资料库回到 UNBOUND，必须重新测试并锁定 profile。' });
    return;
  }
  const result = await migrateLegacyVectors({ libraryPath: options.libraryPath, backupDirectory: options.backupDirectory });
  printReport(result);
}

function inspectLegacyVectors(libraryPath) {
  const databasePath = getDatabasePath(libraryPath);
  if (!fs.existsSync(databasePath)) return { state: 'UNBOUND', databasePath, vectorRowCount: 0 };
  const database = openDatabase(databasePath);
  try {
    const profile = readLockedProfile(database);
    const vectorTableExists = tableExists(database, vectorTableName);
    let vectorRowCount = 0;
    if (vectorTableExists) {
      sqliteVec.load(database);
      vectorRowCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${vectorTableName}`).get().count) || 0;
    }
    const legacy = {
      vectorTableExists,
      vectorRowCount,
      storedModel: readMeta(database, 'embedding_model') || undefined,
      storedDimension: numberOrUndefined(readMeta(database, 'vector_dimension')),
      storedProfileHash: readMeta(database, 'embedding_profile_hash') || undefined,
    };
    return {
      state: profile ? 'LOCKED' : vectorRowCount > 0 ? 'LEGACY_UNBOUND' : 'UNBOUND',
      databasePath,
      ...(profile ? { profileHash: profile.profile_hash } : {}),
      ...legacy,
    };
  } finally {
    database.close();
  }
}

async function migrateLegacyVectors(input) {
  const before = inspectLegacyVectors(input.libraryPath);
  if (before.state === 'LOCKED') throw new Error('资料库已有 LOCKED profile，拒绝执行 legacy 清理；已锁定语义空间不得被迁移脚本修改。');
  if (before.state !== 'LEGACY_UNBOUND') return { ...before, action: 'NOOP' };
  const databasePath = before.databasePath;
  const backupDirectory = path.resolve(input.backupDirectory || path.join(path.dirname(databasePath), 'legacy-vector-backups'));
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `${timestamp()}-${process.pid}-index.db`);
  if (path.resolve(backupPath) === path.resolve(databasePath)) throw new Error('备份目标不能覆盖当前 index.db。');

  const database = openDatabase(databasePath);
  let backupSha256;
  try {
    await database.backup(backupPath);
    backupSha256 = hashFile(backupPath);
    database.transaction(() => {
      if (tableExists(database, vectorTableName)) database.exec(`DROP TABLE ${vectorTableName}`);
      if (tableExists(database, vectorMetaTableName)) {
        database.prepare(`DELETE FROM ${vectorMetaTableName} WHERE key IN (?, ?, ?, ?)`).run(
          'embedding_model', 'vector_dimension', 'embedding_profile_hash', 'last_completed_at',
        );
      }
      if (tableExists(database, stateTableName)) database.exec(`DELETE FROM ${stateTableName}`);
      if (tableExists(database, jobsTableName)) database.exec(`DELETE FROM ${jobsTableName}`);
    })();
  } finally {
    database.close();
  }

  const after = inspectLegacyVectors(input.libraryPath);
  const metadataPath = `${backupPath}.json`;
  const metadata = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    databasePath,
    backupPath,
    backupSha256,
    before,
    after,
    recovery: '恢复前退出应用，只替换资料库 .menghan-meta/index.db；不要手工替换 -wal/-shm。恢复后重新执行 sqlite-vec 和 profile 验证。',
  };
  writeJsonAtomically(metadataPath, metadata);
  return { ...after, action: 'MIGRATED', backupPath, metadataPath, backupSha256, before, after };
}

function getDatabasePath(libraryPath) {
  const resolved = path.resolve(String(libraryPath));
  return path.join(resolved, '.menghan-meta', 'index.db');
}

function openDatabase(databasePath) {
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  sqliteVec.load(database);
  return database;
}

function readLockedProfile(database) {
  if (!tableExists(database, profileTableName)) return undefined;
  const row = database.prepare(`SELECT profile_hash, state FROM ${profileTableName} WHERE singleton_id = 1`).get();
  return row && row.state === 'LOCKED' ? row : undefined;
}

function tableExists(database, tableName) {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName));
}

function readMeta(database, key) {
  if (!tableExists(database, vectorMetaTableName)) return '';
  return String(database.prepare(`SELECT value FROM ${vectorMetaTableName} WHERE key = ?`).get(key)?.value ?? '');
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function parseArgs(argv) {
  const options = { libraryPath: process.env.MENGHAN_MATERIAL_LIBRARY?.trim(), backupDirectory: undefined, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--library') options.libraryPath = argv[++index];
    else if (argument === '--backup-dir') options.backupDirectory = argv[++index];
    else if (argument === '--help' || argument === '-h') {
      console.log('用法：migrate-material-legacy-vectors.cjs --library <path> [--backup-dir <path>] [--apply]');
      process.exit(0);
    } else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function printReport(report) {
  console.log(JSON.stringify(report, null, 2));
}

module.exports = { inspectLegacyVectors, migrateLegacyVectors };
