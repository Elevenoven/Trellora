import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `qa-memory-phase6-${process.pid}-${Date.now()}`);
const compiledRoot = path.join(stagingRoot, 'compiled');
const compiledKnowledgeRoot = path.join(compiledRoot, 'electron', 'knowledge');
let verificationPassed = false;
const owners = [];

try {
  assertTemporaryPath(stagingRoot);
  mkdirSync(stagingRoot, { recursive: true });
  transpileTestModules([
    'electron/knowledge/assistantLibraryIdentity.ts',
    'electron/knowledge/assistantSessionScope.ts',
    'electron/knowledge/assistantWorkspaceMemoryDatabase.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/qaMemoryTypes.ts',
    'electron/knowledge/structuredOutputContract.ts',
    'electron/knowledge/qaConversationCheckpoint.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/qaCanonicalHistory.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/conversationArchiveContract.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/qaMemoryRepository.ts',
    'electron/knowledge/qaLegacyMemoryMigration.ts',
  ]);

  const legacyModule = await import(pathToFileURL(path.join(compiledKnowledgeRoot, 'assistantWorkspaceMemoryDatabase.js')).href);
  const qaDatabaseModule = await import(pathToFileURL(path.join(compiledKnowledgeRoot, 'qaMemoryDatabase.js')).href);
  const qaRepositoryModule = await import(pathToFileURL(path.join(compiledKnowledgeRoot, 'qaMemoryRepository.js')).href);
  const migrationModule = await import(pathToFileURL(path.join(compiledKnowledgeRoot, 'qaLegacyMemoryMigration.js')).href);
  const {
    getAssistantWorkspaceMemoryDatabasePath,
    migrateAssistantWorkspaceMemoryDatabase,
  } = legacyModule;
  const { QaMemoryDatabase, QA_MEMORY_SCHEMA_VERSION } = qaDatabaseModule;
  const { QaMemoryRepository } = qaRepositoryModule;
  const { QaLegacyMemoryMigrationError, QaLegacyMemoryMigrationService } = migrationModule;

  // 1. 空工作区：不创建旧库，新 QA 库仍升级到 v4。
  {
    const workspace = fixtureWorkspace('empty');
    const owner = track(new QaMemoryDatabase());
    const service = new QaLegacyMemoryMigrationService(owner);
    assert.deepEqual(service.migrate(workspace), {
      status: 'no-source',
      copiedSessionCount: 0,
      copiedTurnCount: 0,
    });
    const qa = owner.getDatabase(workspace);
    assert.equal(qa.pragma('user_version', { simple: true }), QA_MEMORY_SCHEMA_VERSION);
    assert.equal(existsSync(getAssistantWorkspaceMemoryDatabasePath(workspace)), false);
    assert.equal(tableCount(qa, 'memory_migrations'), 0);
  }

  // 2 + 4. 只有旧库：全量迁移、pending 归一为 interrupted、重复执行幂等。
  {
    const workspace = fixtureWorkspace('legacy-only');
    const sourcePath = createLegacyDatabase(workspace, migrateAssistantWorkspaceMemoryDatabase, {
      sessions: [
        legacySession('11111111', '旧会话 A', false, 1, '2026-08-26T01:00:00.000Z'),
        legacySession('22222222', '旧会话 B', true, 1, '2026-08-26T02:00:00.000Z'),
      ],
      turns: [
        legacyTurn('legacy-turn-a', sessionId('11111111'), 'complete', '问题 A', '回答 A', '2026-08-26T01:00:00.000Z'),
        legacyTurn('legacy-turn-b', sessionId('22222222'), 'pending', '问题 B', null, '2026-08-26T02:00:00.000Z'),
      ],
    });
    const sourceHash = fileHash(sourcePath);
    const owner = track(new QaMemoryDatabase());
    const service = new QaLegacyMemoryMigrationService(owner);
    const first = service.migrate(workspace);
    assert.equal(first.status, 'completed');
    assert.equal(first.copiedSessionCount, 2);
    assert.equal(first.copiedTurnCount, 2);
    assert.ok(first.backupPaths && existsSync(first.backupPaths.legacy) && existsSync(first.backupPaths.qa));
    assert.equal(fileHash(sourcePath), sourceHash, '迁移不得修改旧数据库');

    const qa = owner.getDatabase(workspace);
    assert.equal(tableCount(qa, 'qa_sessions'), 2);
    assert.equal(tableCount(qa, 'qa_turns'), 2);
    assert.equal(qa.prepare("SELECT status FROM qa_turns WHERE turn_id = 'legacy-turn-b'").get().status, 'interrupted');
    const migration = qa.prepare('SELECT * FROM memory_migrations WHERE migration_id = ?').get(first.migrationId);
    assert.equal(migration.status, 'completed');
    assert.equal(migration.source_hash, migration.target_hash);
    assert.equal(migration.source_session_count, 2);
    assert.equal(migration.source_turn_count, 2);

    const repository = new QaMemoryRepository(owner, workspace);
    const ordered = repository.listSessions({ pageSize: 10 });
    assert.deepEqual(ordered.items.map((item) => item.title), ['旧会话 B', '旧会话 A']);
    assert.deepEqual(repository.getSession(sessionId('11111111')).turns.map((turn) => turn.turnSeq), [1]);

    const repeated = service.migrate(workspace);
    assert.equal(repeated.status, 'already-completed');
    assert.equal(repeated.copiedSessionCount, 0);
    assert.equal(repeated.copiedTurnCount, 0);
    assert.equal(tableCount(qa, 'qa_turns'), 2, '重复迁移不得产生重复轮次');
  }

  // 3. 新旧库同时有数据且 ID 冲突：保留新数据，旧数据确定性重映射。
  {
    const workspace = fixtureWorkspace('both-with-conflicts');
    const conflictingSessionId = sessionId('33333333');
    const sourcePath = createLegacyDatabase(workspace, migrateAssistantWorkspaceMemoryDatabase, {
      sessions: [legacySession('33333333', '待迁移旧会话', true, 1, '2026-08-26T03:00:00.000Z')],
      turns: [legacyTurn('shared-turn-id', conflictingSessionId, 'complete', '旧问题', '旧回答', '2026-08-26T03:00:00.000Z')],
    });
    const sourceHash = fileHash(sourcePath);
    const owner = track(new QaMemoryDatabase());
    const qa = owner.getDatabase(workspace);
    seedQaConflict(qa, conflictingSessionId, 'shared-turn-id');
    const service = new QaLegacyMemoryMigrationService(owner);
    const result = service.migrate(workspace);
    assert.equal(result.status, 'completed');
    assert.equal(fileHash(sourcePath), sourceHash);
    assert.equal(tableCount(qa, 'qa_sessions'), 2);
    assert.equal(tableCount(qa, 'qa_turns'), 2);
    assert.equal(qa.prepare('SELECT title FROM qa_sessions WHERE session_id = ?').get(conflictingSessionId).title, '现有 QA 会话');
    assert.equal(qa.prepare("SELECT user_text FROM qa_turns WHERE turn_id = 'shared-turn-id'").get().user_text, '现有问题');
    const sessionMap = qa.prepare(`
      SELECT qa_id FROM memory_migration_id_map
      WHERE migration_id = ? AND entity_type = 'session' AND legacy_id = ?
    `).get(result.migrationId, conflictingSessionId);
    const turnMap = qa.prepare(`
      SELECT qa_id FROM memory_migration_id_map
      WHERE migration_id = ? AND entity_type = 'turn' AND legacy_id = 'shared-turn-id'
    `).get(result.migrationId);
    assert.notEqual(sessionMap.qa_id, conflictingSessionId);
    assert.notEqual(turnMap.qa_id, 'shared-turn-id');
    assert.match(sessionMap.qa_id, /^assistant-session-[0-9a-f-]{36}$/u);
    const migrated = new QaMemoryRepository(owner, workspace).getSession(sessionMap.qa_id);
    assert.equal(migrated.session.title, '待迁移旧会话');
    assert.deepEqual(migrated.turns.map((turn) => [turn.turnSeq, turn.userText, turn.assistantText]), [[1, '旧问题', '旧回答']]);
  }

  // 5. 中断：事务回滚，失败可审计，再次运行可完成。
  {
    const workspace = fixtureWorkspace('interrupted');
    const sourcePath = createLegacyDatabase(workspace, migrateAssistantWorkspaceMemoryDatabase, {
      sessions: [legacySession('44444444', '中断重试', false, 1, '2026-08-26T04:00:00.000Z')],
      turns: [legacyTurn('interrupted-turn', sessionId('44444444'), 'complete', '中断问题', '中断回答', '2026-08-26T04:00:00.000Z')],
    });
    const sourceHash = fileHash(sourcePath);
    const owner = track(new QaMemoryDatabase());
    const service = new QaLegacyMemoryMigrationService(owner);
    assert.throws(
      () => service.migrate(workspace, { faultInjector: (point) => {
        if (point === 'after-session-copy') throw new Error('模拟进程中断');
      } }),
      (error) => error instanceof QaLegacyMemoryMigrationError && /迁移失败/u.test(error.message),
    );
    const qa = owner.getDatabase(workspace);
    assert.equal(tableCount(qa, 'qa_sessions'), 0, '中断事务不得遗留半迁移会话');
    assert.equal(tableCount(qa, 'qa_turns'), 0, '中断事务不得遗留半迁移轮次');
    assert.equal(qa.prepare('SELECT status FROM memory_migrations ORDER BY updated_at DESC LIMIT 1').get().status, 'failed');
    assert.equal(fileHash(sourcePath), sourceHash);
    const retried = service.migrate(workspace);
    assert.equal(retried.status, 'completed');
    assert.equal(tableCount(qa, 'qa_sessions'), 1);
    assert.equal(tableCount(qa, 'qa_turns'), 1);
  }

  // 6. 损坏旧库：保留原件与备份，QA 仍能正常读写。
  {
    const workspace = fixtureWorkspace('corrupt');
    const sourcePath = getAssistantWorkspaceMemoryDatabasePath(workspace);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, Buffer.from('not-a-sqlite-database\n', 'utf8'));
    const sourceHash = fileHash(sourcePath);
    const owner = track(new QaMemoryDatabase());
    const service = new QaLegacyMemoryMigrationService(owner);
    assert.throws(
      () => service.migrate(workspace),
      (error) => error instanceof QaLegacyMemoryMigrationError && error.code === 'QA_LEGACY_MEMORY_MIGRATION_FAILED',
    );
    assert.equal(fileHash(sourcePath), sourceHash);
    const qa = owner.getDatabase(workspace);
    const failed = qa.prepare("SELECT backup_path FROM memory_migrations WHERE status = 'failed' LIMIT 1").get();
    const backups = JSON.parse(failed.backup_path);
    assert.ok(existsSync(backups.legacy) && existsSync(backups.qa));
    const repository = new QaMemoryRepository(owner, workspace);
    const created = repository.createSession('chat', { title: '损坏旧库不阻塞新问答' });
    assert.equal(repository.getSession(created.sessionId).session.title, '损坏旧库不阻塞新问答');
  }

  verifyProductionWiring();
  verificationPassed = true;
  console.log('Unified Q&A legacy migration Phase 6 verification passed');
} finally {
  for (const owner of owners) owner.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function track(owner) {
  owners.push(owner);
  return owner;
}

function fixtureWorkspace(name) {
  const workspace = path.join(stagingRoot, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function sessionId(seed) {
  return `assistant-session-${seed}-${seed.slice(0, 4)}-4${seed.slice(1, 4)}-8${seed.slice(1, 4)}-${seed}${seed.slice(0, 4)}`;
}

function legacySession(seed, title, pinned, lastTurnSeq, timestamp) {
  return {
    sessionId: sessionId(seed),
    libraryId: `library-${seed}`,
    libraryPath: path.join(stagingRoot, `library-${seed}`),
    title,
    pinned,
    lastTurnSeq,
    timestamp,
  };
}

function legacyTurn(turnId, ownerSessionId, status, userText, assistantText, timestamp) {
  return { turnId, sessionId: ownerSessionId, status, userText, assistantText, timestamp };
}

function createLegacyDatabase(workspace, migrateSchema, fixture) {
  const databasePath = path.join(workspace, 'ConversationMemory', 'conversation-memory.db');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  migrateSchema(database);
  const insertLibrary = database.prepare(`
    INSERT INTO conversation_memory_libraries (library_id, library_path, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO assistant_workspace_sessions (
      session_id, library_id, title, is_pinned, last_turn_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const libraries = new Set();
  for (const session of fixture.sessions) {
    if (!libraries.has(session.libraryId)) {
      mkdirSync(session.libraryPath, { recursive: true });
      insertLibrary.run(session.libraryId, session.libraryPath, session.timestamp, session.timestamp);
      libraries.add(session.libraryId);
    }
    insertSession.run(
      session.sessionId,
      session.libraryId,
      session.title,
      session.pinned ? 1 : 0,
      session.lastTurnSeq,
      session.timestamp,
      session.timestamp,
    );
  }
  const insertTurn = database.prepare(`
    INSERT INTO assistant_workspace_turns (
      turn_id, session_id, turn_seq, user_text, assistant_text, scope_label,
      status, result_json, created_at, finished_at
    ) VALUES (?, ?, 1, ?, ?, '本次使用：旧资料库', ?, '{}', ?, ?)
  `);
  for (const turn of fixture.turns) {
    insertTurn.run(
      turn.turnId,
      turn.sessionId,
      turn.userText,
      turn.assistantText,
      turn.status,
      turn.timestamp,
      turn.status === 'pending' ? null : turn.timestamp,
    );
  }
  database.close();
  return databasePath;
}

function seedQaConflict(database, sessionIdValue, turnId) {
  const timestamp = '2026-08-26T00:00:00.000Z';
  database.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES (?, 'chat', '现有 QA 会话', NULL, 0, 1, 0, ?, ?)
  `).run(sessionIdValue, timestamp, timestamp);
  database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, replaced_by_turn_id,
      user_text, assistant_text, scope_label, status, user_tokens, assistant_tokens,
      result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, ?, 1, ?, 1, NULL, '现有问题', '现有回答', '本次使用：无',
              'complete', 4, 4, '{}', '{}', ?, ?)
  `).run(turnId, sessionIdValue, turnId, timestamp, timestamp);
}

function verifyProductionWiring() {
  const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  const preloadSource = readFileSync(path.join(rootDir, 'electron', 'preload.ts'), 'utf8');
  const declarations = readFileSync(path.join(rootDir, 'src', 'electron.d.ts'), 'utf8');
  const rendererSources = collectSourceFiles(path.join(rootDir, 'src'))
    .filter((filePath) => !filePath.endsWith(`${path.sep}electron.d.ts`))
    .map((filePath) => readFileSync(filePath, 'utf8'))
    .join('\n');
  assert.match(mainSource, /new QaLegacyMemoryMigrationService\(qaMemoryDatabase\)/u);
  assert.match(mainSource, /qaLegacyMemoryMigrationService\.migrate\(key\)/u);
  assert.doesNotMatch(mainSource, /migrateLegacyLibrary/u);
  assert.doesNotMatch(mainSource, /assistantWorkspaceMemoryRecoveredLibraries/u);
  assert.doesNotMatch(mainSource, /assistant-workspace-memory:/u, 'WK-M9 后主进程必须关闭旧工作区记忆 IPC');
  for (const symbol of ['createAssistantWorkspaceSession', 'listAssistantWorkspaceSessions', 'getAssistantWorkspaceSession']) {
    assert.doesNotMatch(preloadSource, new RegExp(symbol, 'u'), `WK-M9 后 preload 不得继续暴露 ${symbol}`);
    assert.doesNotMatch(declarations, new RegExp(symbol, 'u'), `WK-M9 后类型声明不得继续暴露 ${symbol}`);
  }
  assert.doesNotMatch(rendererSources, /(?:create|list|get|rename|set|delete)AssistantWorkspaceSession/u, 'Renderer 不得再调用旧工作区记忆接口');
}

function collectSourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectSourceFiles(resolved));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) result.push(resolved);
  }
  return result;
}

function tableCount(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function fileHash(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function transpileTestModules(relativePaths) {
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const outputPath = path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
      fileName: sourcePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });
    writeFileSync(outputPath, output.outputText, 'utf8');
  }
}

function assertTemporaryPath(target) {
  const stagingBase = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(stagingBase)) throw new Error(`临时目录越界：${target}`);
}
