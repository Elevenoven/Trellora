import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `assistant-search-scope-migration-${process.pid}-${Date.now()}`);
const libraryDir = path.join(stagingRoot, 'library');
const databasePath = path.join(libraryDir, '.menghan-meta', 'assistant-memory.db');
const newDatabasePath = path.join(stagingRoot, 'new', '.menghan-meta', 'assistant-memory.db');
const v4DatabasePath = path.join(stagingRoot, 'v4', '.menghan-meta', 'assistant-memory.db');
const databaseBundle = path.join(stagingRoot, 'assistantMemoryDatabase.cjs');
const repositoryBundle = path.join(stagingRoot, 'assistantMemoryRepository.cjs');
let database;
let newDatabase;
let v4Database;
let owner;
let failedDatabase;

try {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  mkdirSync(path.dirname(newDatabasePath), { recursive: true });
  mkdirSync(path.dirname(v4DatabasePath), { recursive: true });
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryDatabase.ts')],
    outfile: databaseBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
  await build({
    entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryRepository.ts')],
    outfile: repositoryBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  });
  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const { migrateAssistantMemoryDatabase, AssistantMemoryDatabase } = databaseModule;
  const { AssistantMemoryRepository } = repositoryModule;

  // Legacy fixture has the v2 pre-Plan shape; the real migration chain must
  // preserve it and finish at the current schema without rebuilding the file.
  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'assistant-memory', 'pre-plan-schema.sql'), 'utf8'));
  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.equal(database.pragma('user_version', { simple: true }), 7);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  // Build a real v4-shaped fixture from the same migrated legacy data, then
  // exercise the incremental v4 -> current-schema chain.
  v4Database = new Database(v4DatabasePath);
  v4Database.pragma('foreign_keys = ON');
  v4Database.exec(readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'assistant-memory', 'pre-plan-schema.sql'), 'utf8'));
  migrateAssistantMemoryDatabase(v4Database, 'library-v4-fixture');
  v4Database.exec(`
    DROP TABLE assistant_workspace_turns;
    DROP TABLE assistant_workspace_sessions;
    DROP TABLE assistant_search_goal_sections;
    DROP TABLE assistant_search_goal_coverage;
    DROP TABLE assistant_search_plan_scope_aspects;
    ALTER TABLE assistant_search_plans DROP COLUMN scope_confidence;
    ALTER TABLE assistant_search_plans DROP COLUMN scope_origin;
    ALTER TABLE assistant_search_plans DROP COLUMN target_topic;
    ALTER TABLE assistant_search_plans DROP COLUMN coverage_policy;
    ALTER TABLE assistant_search_plans DROP COLUMN scope_mode;
    PRAGMA user_version = 4;
  `);
  assert.equal(v4Database.pragma('user_version', { simple: true }), 4);
  migrateAssistantMemoryDatabase(v4Database, 'library-v4-fixture');
  assert.equal(v4Database.pragma('user_version', { simple: true }), 7, 'v4 真实形状必须增量升级到当前版本');
  assert.deepEqual(v4Database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('assistant_search_plan_scope_aspects', 'assistant_search_goal_coverage', 'assistant_search_goal_sections')").get().count, 3);
  const planColumns = database.prepare('PRAGMA table_info(assistant_search_plans)').all().map((row) => row.name);
  assert.deepEqual(planColumns.filter((name) => name.startsWith('scope_') || name === 'coverage_policy' || name === 'target_topic').sort(), ['coverage_policy', 'scope_confidence', 'scope_mode', 'scope_origin', 'target_topic']);
  const v5Sql = database.prepare("SELECT group_concat(sql, ' ') AS sql FROM sqlite_master WHERE name IN ('assistant_search_plans', 'assistant_search_plan_scope_aspects', 'assistant_search_goal_coverage', 'assistant_search_goal_sections')").get().sql;
  assert.equal(/rawMarkdown|reasoning|search observation|原文全文/iu.test(v5Sql), false, 'v5 tables must not persist raw text or hidden reasoning');
  const databaseStatBeforeIdempotent = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.equal(database.pragma('user_version', { simple: true }), 7);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, databaseStatBeforeIdempotent);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  insertPendingSession(database);
  owner = new AssistantMemoryDatabase();
  const repository = new AssistantMemoryRepository(owner, libraryDir);
  const scope = { libraryId: 'library-fixture', noteId: 'note-fixture-1', sessionId: 'session-scope-1' };
  const snapshot = { snapshotId: 'snapshot-fixture-v1', contentHash: 'hash-fixture-v1' };
  const plan = createPlan();
  const searchScope = {
    mode: 'topic-wide',
    coveragePolicy: 'aspect-complete',
    targetTopic: 'NER',
    targetAspects: ['定义', '评估'],
    origin: 'planner-inferred',
    confidence: 'medium',
  };
  const searchCoverage = [{
    goalId: 'goal-scope-1',
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    queryFingerprint: 'a'.repeat(64),
    matchedBlockCount: 4,
    matchedHeadingCount: 2,
    readHeadingCount: 1,
    coveredAspectCount: 1,
    targetAspectCount: 2,
    discoveredHeadingIds: ['heading-1', 'heading-2'],
    readHeadingIds: ['heading-1'],
    coveredAspects: ['定义'],
    missingAspects: ['评估'],
    candidateExhausted: false,
    candidateTruncated: true,
    nextSearchCursor: 'search-cursor-opaque-v1',
  }];
  await repository.persistSearchPlan(scope, 'turn-scope-1', snapshot, plan, [], { searchScope, searchCoverage });
  const restored = repository.loadSearchPlan(scope, 'turn-scope-1', snapshot);
  assert.equal(restored?.status, 'partial');
  assert.deepEqual(restored?.scope, searchScope);
  assert.equal(restored?.coverage?.[0]?.nextSearchCursor, 'search-cursor-opaque-v1');
  assert.deepEqual(restored?.coverage?.[0]?.readHeadingIds, ['heading-1']);
  assert.equal(repository.loadSearchPlan({ ...scope, sessionId: 'session-fixture-1' }, 'turn-scope-1', snapshot), undefined, '跨 session 恢复必须拒绝');
  assert.throws(() => repository.loadSearchPlan({ ...scope, noteId: 'other-note' }, 'turn-scope-1', snapshot), '跨 note 访问必须 fail closed');
  const stale = repository.loadSearchPlan(scope, 'turn-scope-1', { ...snapshot, contentHash: 'hash-fixture-v2' });
  assert.equal(stale?.status, 'stale');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_search_goal_coverage WHERE plan_id = 'plan-scope-1'").get().count, 0, 'contentHash 失效不得恢复 coverage/cursor');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  newDatabase = new Database(newDatabasePath);
  newDatabase.pragma('foreign_keys = ON');
  migrateAssistantMemoryDatabase(newDatabase, 'library-new');
  assert.equal(newDatabase.pragma('user_version', { simple: true }), 7, '新数据库必须直接建立当前版本');
  assert.deepEqual(newDatabase.prepare('PRAGMA foreign_key_check').all(), []);

  // A malformed v4-shaped file must remain present and unchanged when v5
  // cannot be applied; the application is expected to close it, not rebuild it.
  const failedPath = path.join(stagingRoot, 'failed', 'assistant-memory.db');
  mkdirSync(path.dirname(failedPath), { recursive: true });
  failedDatabase = new Database(failedPath);
  failedDatabase.exec("CREATE TABLE assistant_search_plans (plan_id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL DEFAULT 'focused'); PRAGMA user_version = 4;");
  assert.throws(() => migrateAssistantMemoryDatabase(failedDatabase, 'library-failed'));
  assert.equal(failedDatabase.pragma('user_version', { simple: true }), 4);
  assert.equal(existsSync(failedPath), true);
  failedDatabase.close();
  failedDatabase = undefined;
  console.log('Assistant Search scope and workspace-memory migration verification passed');
} finally {
  owner?.closeAll();
  database?.close();
  newDatabase?.close();
  v4Database?.close();
  failedDatabase?.close();
  if (existsSync(stagingRoot)) {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles after process exit. */ }
  }
}

function insertPendingSession(database) {
  database.exec(`
    INSERT INTO assistant_sessions (session_id, note_id, title, status, last_turn_seq, created_at, updated_at)
    VALUES ('session-scope-1', 'note-fixture-1', '范围会话', 'active', 1, '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');
    INSERT INTO assistant_turns (turn_id, session_id, turn_seq, note_content_hash, user_text, route, context_mode, status, provider_fingerprint, model, created_at)
    VALUES ('turn-scope-1', 'session-scope-1', 1, 'hash-fixture-v1', 'NER', 'current-note-react', 'react-search', 'pending', 'fixture|model', 'model', '2026-08-23T00:00:00.000Z');
  `);
}

function createPlan() {
  return {
    planId: 'plan-scope-1',
    version: 1,
    originalQuestion: 'NER',
    goals: [{
      goalId: 'goal-scope-1',
      question: '核实 NER',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'requirement-scope-1', label: 'NER 原文依据', minEvidence: 1 }],
      queryTerms: [{ term: 'NER', source: 'planner' }],
      status: 'partial',
      evidenceBindings: [],
      conflictBindings: [],
    }],
    activeGoalId: 'goal-scope-1',
    status: 'partial',
    revisionCount: 0,
    goalUpdateCount: 0,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
}
