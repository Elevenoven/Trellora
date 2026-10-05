import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `user-profile-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'fresh-workspace');
const legacyWorkspaceDir = path.join(stagingRoot, 'v4-workspace');
const phase1WorkspaceDir = path.join(stagingRoot, 'phase1-v5-workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const databaseBundle = path.join(compiledRoot, 'electron', 'knowledge', 'qaMemoryDatabase.js');
const repositoryBundle = path.join(compiledRoot, 'electron', 'knowledge', 'userProfileRepository.js');
let owner;
let migratedOwner;
let phase1Owner;
let verificationPassed = false;

try {
  transpileTestModules([
    'shared/effectiveContextWindow.ts',
    'electron/knowledge/assistantMode.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/userProfileTypes.ts',
    'electron/knowledge/userProfileLifecycle.ts',
    'electron/knowledge/userProfileExtractor.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/userProfileExtractionJobRepository.ts',
    'electron/knowledge/userProfileRepository.ts',
  ]);
  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const { QaMemoryDatabase, QA_MEMORY_SCHEMA_VERSION, getQaMemoryDatabasePath } = databaseModule;
  const { UserProfileRepository, UserProfileRevisionConflictError } = repositoryModule;

  owner = new QaMemoryDatabase();
  const repository = new UserProfileRepository(owner, workspaceDir);
  const initial = repository.getOverview();
  assert.equal(QA_MEMORY_SCHEMA_VERSION, 9);
  assert.equal(initial.items.length, 0);
  assert.equal(initial.settings.autoExtractEnabled, false, '自动提取必须默认关闭');
  assert.equal(initial.settings.useInQaContext, false, '画像上下文必须默认关闭');
  assert.equal(initial.extraction.stats.totalJobs, 0);
  assert.equal(repository.saveSettings({ autoExtractEnabled: true }).autoExtractEnabled, true);
  assert.equal(repository.saveSettings({ useInQaContext: true }).useInQaContext, true, 'Phase 3 必须允许显式启用画像上下文');

  const teacher = repository.upsertItem(profileInput('职业角色', '老师', 'multiple'));
  const programmer = repository.upsertItem(profileInput('职业角色', '程序员', 'multiple'));
  let overview = repository.getOverview();
  assert.deepEqual(
    overview.items.filter((item) => item.fieldLabel === '职业角色').map((item) => [item.valueText, item.status]).sort(),
    [['程序员', 'active'], ['老师', 'active']],
    '多值职业角色必须支持老师和程序员同时有效',
  );

  const chinese = repository.upsertItem(profileInput('回答语言', '中文', 'single'));
  const english = repository.upsertItem(profileInput('回答语言', '英文', 'single'));
  overview = repository.getOverview();
  assert.equal(overview.items.find((item) => item.itemId === chinese.itemId)?.status, 'superseded');
  assert.equal(overview.items.find((item) => item.itemId === english.itemId)?.status, 'active');

  const editedTeacher = repository.upsertItem({
    ...profileInput('职业角色', '高中老师', 'multiple'),
    itemId: teacher.itemId,
    expectedRevision: teacher.revision,
  });
  assert.equal(editedTeacher.revision, teacher.revision + 1);
  const unlockedTeacher = repository.setLocked({
    itemId: editedTeacher.itemId,
    locked: false,
    expectedRevision: editedTeacher.revision,
  });
  assert.equal(unlockedTeacher.userLocked, false);
  assert.throws(
    () => repository.setLocked({ itemId: editedTeacher.itemId, locked: true, expectedRevision: editedTeacher.revision }),
    UserProfileRevisionConflictError,
    '旧修订号不得覆盖较新的用户编辑',
  );

  const database = owner.getDatabase(workspaceDir);
  assert.equal(database.pragma('user_version', { simple: true }), 9);
  seedEvidence(database, programmer.itemId, 12);
  const firstEvidencePage = repository.listEvidence({ itemId: programmer.itemId, pageSize: 10 });
  assert.equal(firstEvidencePage.items.length, 10);
  assert.equal(firstEvidencePage.nextCursor, 10);
  const secondEvidencePage = repository.listEvidence({ itemId: programmer.itemId, cursor: firstEvidencePage.nextCursor, pageSize: 10 });
  assert.equal(secondEvidencePage.items.length, 2);
  assert.equal(secondEvidencePage.nextCursor, undefined);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  assert.equal(repository.deleteItem({ itemId: programmer.itemId, expectedRevision: programmer.revision }), true);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM user_profile_evidence WHERE item_id = ?').get(programmer.itemId).count, 0, '删除条目必须级联删除证据');
  const clearResult = repository.clear('all');
  assert.equal(clearResult.deletedItems, 3);
  assert.equal(repository.getOverview().counts.total, 0);

  phase1Owner = new QaMemoryDatabase();
  new UserProfileRepository(phase1Owner, phase1WorkspaceDir).getOverview();
  phase1Owner.closeAll();
  createPhase1V5Shape(getQaMemoryDatabasePath(phase1WorkspaceDir));
  phase1Owner = new QaMemoryDatabase();
  const upgradedPhase1Database = phase1Owner.getDatabase(phase1WorkspaceDir);
  const upgradedJobColumns = new Set(upgradedPhase1Database.prepare('PRAGMA table_info(user_profile_extraction_jobs)').all().map((column) => column.name));
  assert.ok(upgradedJobColumns.has('manual_retry_no'), '已发布的 Phase 1 v5 任务表必须同版本升级');
  const upgradedSettingsColumns = new Set(upgradedPhase1Database.prepare('PRAGMA table_info(user_profile_settings)').all().map((column) => column.name));
  assert.ok(upgradedSettingsColumns.has('extraction_model_profile_id'));
  const sourceTurnForeignKey = upgradedPhase1Database.prepare('PRAGMA foreign_key_list(user_profile_evidence)').all().find((entry) => entry.from === 'source_turn_id');
  assert.equal(sourceTurnForeignKey.on_delete, 'CASCADE');

  createV4Database(getQaMemoryDatabasePath(legacyWorkspaceDir));
  migratedOwner = new QaMemoryDatabase();
  const migratedDatabase = migratedOwner.getDatabase(legacyWorkspaceDir);
  assert.equal(migratedDatabase.pragma('user_version', { simple: true }), 9, '既有 v4 数据库必须原位升级到当前 schema');
  assert.equal(migratedDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'user_profile_%'").get().count, 5);
  assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), []);

  verifyUiAndIpcBoundary();
  verificationPassed = true;
  console.log('User profile data boundary verification passed');
} finally {
  owner?.closeAll();
  migratedOwner?.closeAll();
  phase1Owner?.closeAll();
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function profileInput(fieldLabel, valueText, cardinality) {
  return {
    category: 'professional',
    fieldLabel,
    valueText,
    cardinality,
    temporalStatus: 'current',
    userLocked: true,
  };
}

function seedEvidence(database, itemId, count) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES ('profile-test-session', 'chat', '画像证据测试', NULL, 0, ?, 0, ?, ?)
  `).run(count, now, now);
  const insertTurn = database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, replaced_by_turn_id,
      user_text, assistant_text, scope_label, status, user_tokens, assistant_tokens,
      result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, 'profile-test-session', ?, ?, 1, NULL, ?, '收到', '本次使用：无',
              'complete', 0, 0, '{}', '{}', ?, ?)
  `);
  const insertEvidence = database.prepare(`
    INSERT INTO user_profile_evidence (
      evidence_id, item_id, source_turn_id, source_session_id, source_scope,
      excerpt, assertion_kind, confidence, occurred_at, created_at
    ) VALUES (?, ?, ?, 'profile-test-session', 'chat', ?, 'explicit', 1, ?, ?)
  `);
  for (let index = 1; index <= count; index += 1) {
    const turnId = `profile-test-turn-${index}`;
    const occurredAt = new Date(Date.now() + index * 1_000).toISOString();
    insertTurn.run(turnId, index, turnId, `我是程序员（证据 ${index}）`, occurredAt, occurredAt);
    insertEvidence.run(`profile-test-evidence-${index}`, itemId, turnId, `我是程序员（证据 ${index}）`, occurredAt, now);
  }
  database.prepare('UPDATE user_profile_items SET source_count = ? WHERE item_id = ?').run(count, itemId);
}

function createV4Database(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE qa_sessions (
        session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, library_path TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0, last_turn_seq INTEGER NOT NULL DEFAULT 0,
        summarized_through_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE qa_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        scope_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        user_tokens INTEGER NOT NULL DEFAULT 0,
        assistant_tokens INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE qa_summaries (
        batch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        turn_from INTEGER NOT NULL, turn_to INTEGER NOT NULL, summary_text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0, compressor TEXT NOT NULL, status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE qa_summary_rollups (
        rollup_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES qa_sessions(session_id) ON DELETE CASCADE,
        level INTEGER NOT NULL, source_start_seq INTEGER NOT NULL, source_end_seq INTEGER NOT NULL,
        source_ids_json TEXT NOT NULL, source_hash TEXT NOT NULL, summary_text TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0, compressor TEXT NOT NULL, status TEXT NOT NULL,
        summary_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_migrations (
        migration_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        migration_version INTEGER NOT NULL, status TEXT NOT NULL, source_session_count INTEGER NOT NULL DEFAULT 0,
        source_turn_count INTEGER NOT NULL DEFAULT 0, copied_session_count INTEGER NOT NULL DEFAULT 0,
        copied_turn_count INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '', target_hash TEXT NOT NULL DEFAULT '',
        backup_path TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL,
        completed_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_migration_id_map (
        migration_id TEXT NOT NULL REFERENCES memory_migrations(migration_id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL, legacy_id TEXT NOT NULL, qa_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        PRIMARY KEY (migration_id, entity_type, legacy_id)
      );
      CREATE INDEX idx_qa_sessions_global_order ON qa_sessions(is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE INDEX idx_qa_summary_rollups_session_level_order ON qa_summary_rollups(session_id, level, source_start_seq ASC);
      CREATE INDEX idx_memory_migrations_source ON memory_migrations(source_path, migration_version, status);
      PRAGMA user_version = 4;
    `);
  } finally {
    database.close();
  }
}

function createPhase1V5Shape(databasePath) {
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database.exec(`
      DROP INDEX IF EXISTS idx_user_profile_jobs_status;
      DROP INDEX IF EXISTS idx_user_profile_jobs_session;
      DROP TABLE user_profile_extraction_jobs;
      CREATE TABLE user_profile_extraction_jobs (
        job_id TEXT PRIMARY KEY,
        source_turn_id TEXT NOT NULL UNIQUE REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES user_profile_settings(profile_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        extractor_version TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_profile_jobs_status
        ON user_profile_extraction_jobs(profile_id, status, created_at ASC);
      DROP INDEX IF EXISTS idx_user_profile_evidence_item_time;
      DROP INDEX IF EXISTS idx_user_profile_evidence_item_turn;
      DROP TABLE user_profile_evidence;
      CREATE TABLE user_profile_evidence (
        evidence_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES user_profile_items(item_id) ON DELETE CASCADE,
        source_turn_id TEXT REFERENCES qa_turns(turn_id) ON DELETE SET NULL,
        source_session_id TEXT,
        source_scope TEXT NOT NULL CHECK (source_scope IN ('chat', 'knowledge-base', 'manual')),
        excerpt TEXT NOT NULL,
        assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('manual', 'explicit', 'inferred')),
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_profile_evidence_item_time
        ON user_profile_evidence(item_id, occurred_at DESC, evidence_id DESC);
      ALTER TABLE user_profile_settings DROP COLUMN extraction_model_profile_id;
      PRAGMA user_version = 5;
    `);
  } finally {
    database.close();
  }
}

function verifyUiAndIpcBoundary() {
  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  const preloadSource = readFileSync(path.join(rootDir, 'electron/preload.ts'), 'utf8');
  const settingsSource = readFileSync(path.join(rootDir, 'src/components/SettingsPanel.tsx'), 'utf8');
  const pageSource = readFileSync(path.join(rootDir, 'src/components/settings/UserInformationSettings.tsx'), 'utf8');
  assert.doesNotMatch(mainSource, /user-profile:/u, 'WK-M9 后旧画像 IPC 必须关闭');
  assert.doesNotMatch(preloadSource, /user-profile:/u, 'WK-M9 后 renderer 不得访问旧画像 IPC');
  assert.match(preloadSource, /getLongTermMemoryOverview/u);
  assert.match(settingsSource, /id: 'user-information', label: '个性化'/u);
  assert.match(pageSource, /集中管理画像、偏好、事实、任务和兴趣/u);
  assert.match(pageSource, /getLongTermMemoryOverview/u);
  assert.match(pageSource, /listLongTermMemoryItems/u);
  assert.match(pageSource, /待确认内容不会进入回答/u);
  assert.doesNotMatch(pageSource, /startAssistantTurn|generateAi|invoke\([^)]*model/iu, '用户信息页不得直接触发通用问答模型调用');
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
