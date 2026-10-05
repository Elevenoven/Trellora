import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-schema-scope-${process.pid}-${Date.now()}`);
const storageWorkspace = path.join(stagingRoot, 'storage-workspace');
const logicalWorkspaceA = path.join(stagingRoot, 'logical-workspace-a');
const logicalWorkspaceB = path.join(stagingRoot, 'logical-workspace-b');
const v5Workspace = path.join(stagingRoot, 'v5-workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;
let restartedOwner;
let v5Owner;
let verificationPassed = false;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(logicalWorkspaceA, { recursive: true });
  mkdirSync(logicalWorkspaceB, { recursive: true });
  transpileTestModules([
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/memoryExtractionScheduler.ts',
  ]);

  const databaseModule = await load('electron/knowledge/qaMemoryDatabase.ts');
  const scopeModule = await load('electron/knowledge/memory/memoryScope.ts');
  const configModule = await load('electron/knowledge/memory/memoryConfig.ts');
  const repositoryModule = await load('electron/knowledge/memory/memoryRepository.ts');
  const schedulerModule = await load('electron/knowledge/memory/memoryExtractionScheduler.ts');
  const {
    QaMemoryDatabase,
    QA_MEMORY_SCHEMA_VERSION,
    getQaMemoryDatabasePath,
    migrateQaMemoryDatabase,
  } = databaseModule;
  const { MemoryScopeResolver, ensureLocalMemoryPrincipalId } = scopeModule;
  const { normalizeWorkspaceMemoryConfig, isConversationMemoryEnabled } = configModule;
  const { MemoryRepository } = repositoryModule;
  const { MemoryExtractionScheduler } = schedulerModule;

  assert.equal(QA_MEMORY_SCHEMA_VERSION, 11);
  owner = new QaMemoryDatabase();
  const database = owner.getDatabase(storageWorkspace);
  assert.equal(database.pragma('user_version', { simple: true }), 11);
  verifyRequiredShape(database);
  migrateQaMemoryDatabase(database);
  migrateQaMemoryDatabase(database);
  verifyRequiredShape(database);

  verifyV5Upgrade({ QaMemoryDatabase, getQaMemoryDatabasePath });

  const principalStore = new Map();
  const localStore = {
    get: (key) => principalStore.get(key),
    set: (key, value) => principalStore.set(key, value),
  };
  const generatedPrincipal = ensureLocalMemoryPrincipalId(localStore);
  assert.match(generatedPrincipal, /^local-principal-[0-9a-f-]{36}$/u);
  assert.equal(ensureLocalMemoryPrincipalId(localStore), generatedPrincipal, '本地 principalId 必须稳定复用');

  let activeWorkspacePath = logicalWorkspaceA;
  const registeredPaths = [logicalWorkspaceA, logicalWorkspaceB];
  const resolverA = new MemoryScopeResolver({
    getActiveWorkspacePath: () => activeWorkspacePath,
    listRegisteredWorkspacePaths: () => registeredPaths,
    getPrincipalId: () => 'principal-a',
  });
  const resolverB = new MemoryScopeResolver({
    getActiveWorkspacePath: () => activeWorkspacePath,
    listRegisteredWorkspacePaths: () => registeredPaths,
    getPrincipalId: () => 'principal-b',
  });
  const contextA = resolverA.resolveActive();
  const contextPrincipalB = resolverB.resolveActive();
  activeWorkspacePath = logicalWorkspaceB;
  const contextWorkspaceB = resolverA.resolveActive();
  activeWorkspacePath = logicalWorkspaceA;

  const repository = new MemoryRepository(owner, storageWorkspace);
  assert.throws(
    () => repository.getSubject({ ...contextA.scope }),
    /主进程/u,
    '复制字段得到的普通对象不得伪造可信作用域',
  );
  repository.ensureSubject(contextA.scope);
  assert.equal(repository.getSubject(contextPrincipalB.scope), undefined, '跨 principal 读取必须为零');
  assert.equal(repository.getSubject(contextWorkspaceB.scope), undefined, '跨 workspace 读取必须为零');
  repository.ensureSubject(contextPrincipalB.scope);
  repository.ensureSubject(contextWorkspaceB.scope);
  verifyCompositeScopeForeignKeys(database, contextA.scope, contextPrincipalB.scope);

  const defaults = repository.getWorkspaceConfig(contextA.scope);
  assert.equal(defaults.enabled, false, '工作区 L4 必须默认关闭');
  assert.equal(repository.getPrincipalConfig(contextA.scope).enabled, true, 'principal 必须默认开启');
  assert.deepEqual(repository.resolveAvailability(contextA.scope), {
    enabled: false,
    reason: 'workspace-disabled',
  });
  const instructions = '记'.repeat(1_001);
  const enabledWorkspace = repository.updateWorkspaceConfig(contextA.scope, {
    enabled: true,
    writeMode: 'auto',
    maxItems: 9_999,
    extractDelaySeconds: 0,
    extractMinIntervalSeconds: 0,
    extractInstructions: instructions,
  });
  assert.equal(enabledWorkspace.maxItems, 2_000);
  assert.equal(enabledWorkspace.extractDelaySeconds, 5);
  assert.equal(enabledWorkspace.extractMinIntervalSeconds, 300);
  assert.equal(Array.from(enabledWorkspace.extractInstructions).length, 1_000);
  assert.deepEqual(repository.resolveAvailability(contextA.scope), { enabled: true });
  assert.deepEqual(repository.resolveAvailability(contextA.scope, { memoryEnabled: false }), {
    enabled: false,
    reason: 'agent-disabled',
  });
  repository.setPrincipalEnabled(contextA.scope, false);
  assert.deepEqual(repository.resolveAvailability(contextA.scope), {
    enabled: false,
    reason: 'principal-disabled',
  });
  repository.setPrincipalEnabled(contextA.scope, true);
  assert.equal(isConversationMemoryEnabled(), true, 'L3 不得被 L4 三层开关关闭');
  assert.equal(normalizeWorkspaceMemoryConfig({ maxItems: -1 }).maxItems, 200);

  assert.equal(resolverA.revalidatePersistedScope(contextA.scope)?.workspacePath, path.resolve(logicalWorkspaceA));
  assert.equal(resolverA.revalidatePersistedScope(contextPrincipalB.scope), undefined);
  const unregisteredResolver = new MemoryScopeResolver({
    getActiveWorkspacePath: () => path.join(stagingRoot, 'not-registered'),
    listRegisteredWorkspacePaths: () => registeredPaths,
    getPrincipalId: () => 'principal-a',
  });
  assert.throws(() => unregisteredResolver.resolveActive(), /未在主进程注册/u);

  let scheduler = new MemoryExtractionScheduler(owner, storageWorkspace);
  const firstScheduledAt = new Date();
  const firstJob = scheduler.schedule(contextA.scope, 'session-a', { now: firstScheduledAt, dueAt: firstScheduledAt });
  const claimedFirst = scheduler.claimNextDue(
    (scope) => resolverA.revalidatePersistedScope(scope),
    firstScheduledAt,
  );
  assert.equal(claimedFirst?.id, firstJob.id);
  assert.deepEqual(claimedFirst?.claimedSessionIds, ['session-a']);
  scheduler.schedule(contextA.scope, 'session-b', {
    now: new Date(firstScheduledAt.getTime() + 1_000),
    dueAt: new Date(firstScheduledAt.getTime() + 1_000),
  });
  assert.deepEqual(repository.getSubject(contextA.scope)?.pendingSessionIds, ['session-b']);
  database.prepare(`
    UPDATE memory_extraction_jobs SET lease_until = ? WHERE id = ?
  `).run(new Date(firstScheduledAt.getTime() - 1_000).toISOString(), firstJob.id);

  owner.closeAll();
  owner = undefined;
  restartedOwner = new QaMemoryDatabase();
  const restartedDatabase = restartedOwner.getDatabase(storageWorkspace);
  const restartedRepository = new MemoryRepository(restartedOwner, storageWorkspace);
  scheduler = new MemoryExtractionScheduler(restartedOwner, storageWorkspace);
  const recovered = scheduler.getJob(contextA.scope, firstJob.id);
  assert.equal(recovered?.status, 'retry', '启动扫描必须恢复过期 running 租约');
  assert.deepEqual(recovered?.claimedSessionIds, ['session-a'], '崩溃恢复不得丢失已认领会话');
  assert.deepEqual(restartedRepository.getSubject(contextA.scope)?.pendingSessionIds, ['session-b'], '运行中新增会话必须留在 pending');
  assert.equal(scheduler.getJob(contextPrincipalB.scope, firstJob.id), undefined, '跨 principal 不得读取任务');
  assert.equal(scheduler.getJob(contextWorkspaceB.scope, firstJob.id), undefined, '跨 workspace 不得读取任务');

  const reclaimed = scheduler.claimNextDue(
    (scope) => resolverA.revalidatePersistedScope(scope),
    new Date(),
  );
  assert.deepEqual(reclaimed?.claimedSessionIds, ['session-a']);
  scheduler.complete(contextA.scope, firstJob.id);
  const followUp = scheduler.claimNextDue(
    (scope) => resolverA.revalidatePersistedScope(scope),
    new Date(Date.now() + 16_000),
  );
  assert.deepEqual(followUp?.claimedSessionIds, ['session-b'], '前一任务完成后必须继续处理运行中积累的会话');
  assert.deepEqual(restartedRepository.getSubject(contextA.scope)?.pendingSessionIds, []);
  assert.equal(restartedDatabase.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(restartedDatabase.prepare('PRAGMA foreign_key_check').all(), []);

  assert.throws(
    () => restartedDatabase.prepare(`
      UPDATE memory_workspace_settings SET max_items = 2001 WHERE workspace_id = ?
    `).run(contextA.scope.workspaceId),
    /CHECK constraint failed/u,
    '数据库 CHECK 必须阻止越界配置',
  );
  verifyProductionStartupWiring();

  verificationPassed = true;
  console.log('WeKnora memory schema, scope, config, and durable job verification passed');
} finally {
  owner?.closeAll();
  restartedOwner?.closeAll();
  v5Owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function verifyV5Upgrade({ QaMemoryDatabase, getQaMemoryDatabasePath }) {
  v5Owner = new QaMemoryDatabase();
  const initial = v5Owner.getDatabase(v5Workspace);
  assert.equal(initial.pragma('user_version', { simple: true }), 11);
  v5Owner.closeAll();
  v5Owner = undefined;

  const databasePath = getQaMemoryDatabasePath(v5Workspace);
  const deployedV5 = new Database(databasePath);
  deployedV5.pragma('foreign_keys = OFF');
  deployedV5.exec(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES ('v5-session', 'chat', 'v5 迁移', NULL, 0, 1, 0,
              '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, user_text,
      assistant_text, scope_label, status, user_tokens, assistant_tokens,
      result_json, result_metadata_json, created_at, finished_at
    ) VALUES ('v5-turn', 'v5-session', 1, 'v5-turn', 1, '旧问题', '旧回答',
              '本次使用：无', 'complete', 2, 2, '{}', '{}',
              '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:01.000Z');
    DROP TRIGGER IF EXISTS conversation_search_documents_ai;
    DROP TRIGGER IF EXISTS conversation_search_documents_ad;
    DROP TRIGGER IF EXISTS conversation_search_documents_au;
    DROP TABLE IF EXISTS conversation_search_fts;
    DROP TABLE IF EXISTS assistant_used_memories;
    DROP TABLE IF EXISTS qa_agent_tool_calls;
    DROP TABLE IF EXISTS qa_agent_messages;
    DROP TABLE IF EXISTS conversation_search_documents;
    DROP TABLE IF EXISTS memory_item_embeddings;
    DROP TABLE IF EXISTS memory_doc_affinity_events;
    DROP TABLE IF EXISTS memory_doc_affinities;
    DROP TABLE IF EXISTS memory_topic_stats;
    DROP TABLE IF EXISTS memory_tombstones;
    DROP TABLE IF EXISTS memory_extraction_jobs;
    DROP TABLE IF EXISTS memory_items;
    DROP TABLE IF EXISTS memory_subjects;
    DROP TABLE IF EXISTS memory_workspace_settings;
    DROP TABLE IF EXISTS memory_migration_audit;
    DROP INDEX IF EXISTS idx_qa_turns_request_attempt;
    DROP INDEX IF EXISTS idx_qa_turns_current_completed;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE qa_turns RENAME TO qa_turns_v6;
    CREATE TABLE qa_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
      turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
      user_text TEXT NOT NULL,
      assistant_text TEXT,
      scope_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'not-found', 'cancelled', 'error', 'interrupted')),
      user_tokens INTEGER NOT NULL DEFAULT 0,
      assistant_tokens INTEGER NOT NULL DEFAULT 0,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (session_id, turn_seq)
    );
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, user_text, assistant_text, scope_label,
      status, user_tokens, assistant_tokens, result_json, created_at, finished_at
    )
    SELECT turn_id, session_id, turn_seq, user_text, assistant_text, scope_label,
           status, user_tokens, assistant_tokens, result_json, created_at, finished_at
    FROM qa_turns_v6;
    DROP TABLE qa_turns_v6;
    CREATE INDEX idx_qa_turns_session_seq ON qa_turns(session_id, turn_seq ASC);
    PRAGMA legacy_alter_table = OFF;
    PRAGMA user_version = 5;
  `);
  const v5TurnColumns = new Set(deployedV5.prepare('PRAGMA table_info(qa_turns)').all().map((column) => column.name));
  assert.equal(v5TurnColumns.has('request_id'), false, 'v5 fixture 不得预带 v6 turn 字段');
  deployedV5.close();

  v5Owner = new QaMemoryDatabase();
  const upgraded = v5Owner.getDatabase(v5Workspace);
  assert.equal(upgraded.pragma('user_version', { simple: true }), 11, '既有 v5 库必须原位升级到 v11');
  verifyRequiredShape(upgraded);
  assert.deepEqual(
    upgraded.prepare(`
      SELECT request_id, attempt_no, result_metadata_json, user_text, assistant_text
      FROM qa_turns WHERE turn_id = 'v5-turn'
    `).get(),
    {
      request_id: 'v5-turn',
      attempt_no: 1,
      result_metadata_json: '{}',
      user_text: '旧问题',
      assistant_text: '旧回答',
    },
    'v5 原始 turn 必须完整保留并回填 v6 字段',
  );
  v5Owner.closeAll();
  v5Owner = undefined;

  v5Owner = new QaMemoryDatabase();
  verifyRequiredShape(v5Owner.getDatabase(v5Workspace));
}

function verifyRequiredShape(database) {
  const requiredTables = [
    'memory_workspace_settings',
    'memory_subjects',
    'memory_items',
    'memory_tombstones',
    'memory_topic_stats',
    'memory_doc_affinities',
    'memory_doc_affinity_events',
    'memory_item_embeddings',
    'memory_extraction_jobs',
    'memory_extraction_turn_receipts',
    'memory_extraction_pending_sources',
    'conversation_search_documents',
    'conversation_search_fts',
    'assistant_used_memories',
    'memory_migration_audit',
    'qa_agent_messages',
    'qa_agent_tool_calls',
  ];
  for (const table of requiredTables) {
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table).count, 1, `缺少 ${table}`);
  }
  const turnColumns = new Set(database.prepare('PRAGMA table_info(qa_turns)').all().map((column) => column.name));
  for (const column of ['request_id', 'attempt_no', 'replaced_by_turn_id', 'assistant_text', 'result_metadata_json']) {
    assert.equal(turnColumns.has(column), true, `qa_turns 缺少 ${column}`);
  }
  const extractionColumns = new Set(database.prepare('PRAGMA table_info(memory_extraction_jobs)').all().map((column) => column.name));
  for (const column of ['source_model_profile_id', 'source_model_id', 'source_context_window_tokens', 'claimed_sources_json']) {
    assert.equal(extractionColumns.has(column), true, `memory_extraction_jobs 缺少 ${column}`);
  }
  for (const index of ['idx_memory_items_active_key', 'idx_memory_items_pending_key', 'idx_memory_items_pending_target', 'idx_memory_extraction_jobs_live_scope', 'idx_memory_extraction_pending_due', 'idx_qa_turns_current_completed']) {
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?
    `).get(index).count, 1, `缺少 ${index}`);
  }
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
}

function verifyCompositeScopeForeignKeys(database, scopeA, scopeB) {
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO memory_items (
      id, workspace_id, principal_id, kind, content, topic, normalized_key,
      importance, origin, status, valid_from, created_at, updated_at
    ) VALUES ('scope-item-a', ?, ?, 'fact', '作用域 A 的事实', '', 'scope-item-a',
              3, 'manual', 'active', ?, ?, ?)
  `).run(scopeA.workspaceId, scopeA.principalId, timestamp, timestamp, timestamp);
  assert.throws(
    () => database.prepare(`
      INSERT INTO memory_item_embeddings (
        item_id, workspace_id, principal_id, model_id, dimensions,
        embedding, content_fingerprint, updated_at
      ) VALUES ('scope-item-a', ?, ?, 'test-model', 1, X'00000000', 'fingerprint', ?)
    `).run(scopeB.workspaceId, scopeB.principalId, timestamp),
    /FOREIGN KEY constraint failed/u,
    'embedding 不得借用其他作用域的 item',
  );
}

function verifyProductionStartupWiring() {
  const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  assert.match(mainSource, /ensureLocalMemoryPrincipalId\(store\)/u, '主进程启动时必须建立稳定 principal');
  assert.match(
    mainSource,
    /qaMemoryDatabase\.getDatabase\(configuredWorkspacePath\)/u,
    '主进程启动时必须打开统一数据库并扫描过期租约',
  );
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);
}

function load(relativePath) {
  return import(pathToFileURL(modulePath(relativePath)).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
