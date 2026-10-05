import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `assistant-plan-migration-${process.pid}-${Date.now()}`);
const libraryDir = path.join(stagingRoot, 'library');
const databasePath = path.join(libraryDir, '.menghan-meta', 'assistant-memory.db');
const databaseBundle = process.env.ASSISTANT_MEMORY_DATABASE_BUNDLE || path.join(stagingRoot, 'assistantMemoryDatabase.cjs');
const repositoryBundle = process.env.ASSISTANT_MEMORY_REPOSITORY_BUNDLE || path.join(stagingRoot, 'assistantMemoryRepository.cjs');
let database;
let owner;

try {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!process.env.ASSISTANT_MEMORY_DATABASE_BUNDLE || !process.env.ASSISTANT_MEMORY_REPOSITORY_BUNDLE) {
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
  }
  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const { migrateAssistantMemoryDatabase } = databaseModule;
  const { AssistantMemoryDatabase, AssistantMemoryRepository } = { ...databaseModule, ...repositoryModule };

  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'assistant-memory', 'pre-plan-schema.sql'), 'utf8'));
  database.prepare("UPDATE assistant_memory_state SET summarized_through_seq = 1, rolling_summary = '旧版摘要' WHERE session_id = 'session-fixture-1'").run();
  assert.equal(database.prepare('SELECT title FROM assistant_sessions WHERE session_id = ?').get('session-fixture-1').title, '旧会话');

  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1, '迁移测试必须启用 foreign_keys');
  assert.equal(database.pragma('user_version', { simple: true }), 7);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'assistant_turn_digests'").get().count, 1);
  const summaryColumns = database.prepare('PRAGMA table_info(assistant_memory_state)').all().map((row) => row.name);
  assert.ok(summaryColumns.includes('rolling_summary_version'));
  assert.ok(summaryColumns.includes('rolling_summary_json'));
  assert.ok(summaryColumns.includes('rolling_summary_content_hash'));
  const migratedSummary = JSON.parse(database.prepare("SELECT rolling_summary_json FROM assistant_memory_state WHERE session_id = 'session-fixture-1'").get().rolling_summary_json);
  assert.equal(migratedSummary.legacyText, '旧版摘要', '旧字符串摘要必须保留为 legacy payload');
  assert.equal(migratedSummary.coveredThroughSeq, 1, '旧摘要覆盖序号必须迁移');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'assistant_search_plan%'").get().count, 6);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_sessions WHERE session_id = 'session-fixture-1'").get().count, 1, '旧 session 数据必须可读');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.equal(database.pragma('user_version', { simple: true }), 7, '重复迁移必须保持 schema version');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [], '幂等迁移后 foreign_key_check 必须为空');
  assert.equal(database.prepare("SELECT instr(group_concat(sql, ' '), 'rawMarkdown') AS leaked FROM sqlite_master WHERE name LIKE 'assistant_search_plan%'").get().leaked, 0, 'SearchPlan 表不得保存笔记原文');
  assert.equal(database.prepare("SELECT instr(group_concat(sql, ' '), 'reasoning') AS leaked FROM sqlite_master WHERE name LIKE 'assistant_search_plan%'").get().leaked, 0, 'SearchPlan 表不得保存隐藏思维链');

  insertSecondSession(database);
  insertCompletedPlan(database);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  owner = new AssistantMemoryDatabase();
  const repository = new AssistantMemoryRepository(owner, libraryDir);
  const scopeA = { libraryId: 'library-fixture', noteId: 'note-fixture-1', sessionId: 'session-fixture-1' };
  const sameHashSnapshot = { contentHash: 'hash-fixture-v1' };
  const restored = repository.loadSearchPlan(scopeA, 'turn-fixture-1', sameHashSnapshot);
  assert.equal(restored?.planId, 'plan-fixture-1', '同 session、同 turn 可以恢复计划');
  assert.equal(restored?.status, 'completed');
  assert.equal(restored?.goals[0].evidenceBindings[0].evidenceIds[0], 'evidence-fixture-1');
  assert.equal(repository.loadSearchPlan({ ...scopeA, sessionId: 'session-fixture-2' }, 'turn-fixture-1', sameHashSnapshot), undefined, '新 session 不得读取旧 session 计划');
  const scopeB = { libraryId: 'library-fixture', noteId: 'note-fixture-1', sessionId: 'session-fixture-2' };
  await repository.persistSearchPlan(scopeB, 'turn-fixture-2', sameHashSnapshot, {
    planId: 'plan-fixture-2',
    version: 4,
    originalQuestion: '第二问题',
    goals: [{
      goalId: 'goal-fixture-2',
      question: '核实第二问题',
      evidenceKind: 'fact',
      requirements: [{ requirementId: 'requirement-fixture-2', label: '第二问题的原文依据', minEvidence: 1 }],
      queryTerms: Array.from({ length: 12 }, (_, index) => ({ term: `第二问题-${index + 1}`, source: 'planner' })),
      status: 'searching',
      evidenceBindings: [],
      conflictBindings: [],
    }],
    activeGoalId: 'goal-fixture-2',
    status: 'active',
    revisionCount: 1,
    goalUpdateCount: 3,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:03.000Z',
  });
  const restoredUnbounded = repository.loadSearchPlan(scopeB, 'turn-fixture-2', sameHashSnapshot);
  assert.equal(restoredUnbounded?.status, 'active', 'repository 必须能写入并恢复结构化计划');
  assert.equal(restoredUnbounded?.goals[0].queryTerms.length, 12, 'v7 必须持久化超过旧 6 项上限的 QueryTerm。');
  assert.equal(database.prepare("SELECT MAX(term_order) AS max_order FROM assistant_search_plan_query_terms WHERE plan_id = 'plan-fixture-2'").get().max_order, 11);
  const queryTermSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assistant_search_plan_query_terms'").get().sql;
  assert.doesNotMatch(queryTermSchema, /term_order\s*<=/iu, 'v7 不得保留 QueryTerm 数量上限。');

  let crossSessionError;
  try {
    database.prepare(`
    INSERT INTO assistant_search_plan_evidence (plan_id, goal_id, requirement_id, session_id, evidence_id, side)
    VALUES ('plan-fixture-1', 'goal-fixture-1', 'requirement-fixture-1', 'session-fixture-2', 'evidence-fixture-1', 'supports')
    `).run();
  } catch (error) {
    crossSessionError = error;
  }
  assert.ok(crossSessionError, '跨 session evidenceId 必须被复合外键拒绝');
  assert.match(String(crossSessionError?.message), /FOREIGN KEY constraint failed/);
  let crossSessionDigestError;
  try {
    database.prepare(`
      INSERT INTO assistant_turn_digests (
        digest_id, session_id, turn_id, turn_seq, note_content_hash, digest_version,
        digest_json, plan_id, plan_version, plan_status, state, created_at
      ) VALUES ('digest-cross-session', 'session-fixture-2', 'turn-fixture-2', 1, 'hash-fixture-v1', 1, '{}', 'plan-fixture-1', 2, 'completed', 'active', '2026-08-22T00:00:04.000Z')
    `).run();
  } catch (error) {
    crossSessionDigestError = error;
  }
  assert.ok(crossSessionDigestError, 'digest 的 plan outcome 引用必须拒绝跨 session');
  assert.match(String(crossSessionDigestError?.message), /FOREIGN KEY constraint failed/);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  const stale = repository.loadSearchPlan(scopeA, 'turn-fixture-1', { contentHash: 'hash-fixture-v2' });
  assert.equal(stale?.status, 'stale', 'contentHash 变化时计划必须 stale');
  assert.equal(database.prepare("SELECT state FROM assistant_evidence_refs WHERE session_id = 'session-fixture-1' AND evidence_id = 'evidence-fixture-1'").get().state, 'stale', 'contentHash 变化时证据必须 stale');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  const archived = repository.archiveSession(scopeA);
  assert.equal(archived.status, 'archived');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_search_plans WHERE plan_id = 'plan-fixture-1'").get().count, 1, '归档只改变 session 状态，不得级联删除计划');
  repository.deleteSession(scopeA);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_search_plans WHERE plan_id = 'plan-fixture-1'").get().count, 0, '删除 session 必须级联删除计划');

  const pendingPlan = database.prepare("SELECT status, version, revision_count, goal_update_count FROM assistant_search_plans WHERE plan_id = 'plan-fixture-2'").get();
  assert.equal(pendingPlan.status, 'active');
  assert.equal(repository.recoverInterruptedTurns(), 1, '应用中断时 pending turn 必须结束');
  const interruptedTurn = database.prepare("SELECT status FROM assistant_turns WHERE turn_id = 'turn-fixture-2'").get();
  const interruptedPlan = database.prepare("SELECT status, version, revision_count, goal_update_count FROM assistant_search_plans WHERE plan_id = 'plan-fixture-2'").get();
  assert.equal(interruptedTurn.status, 'interrupted');
  assert.equal(interruptedPlan.status, 'interrupted', '中断轮次的计划必须是 interrupted');
  assert.equal(interruptedPlan.version, pendingPlan.version + 1);
  assert.equal(interruptedPlan.revision_count, pendingPlan.revision_count, '中断恢复不得重置重规划计数');
  assert.equal(interruptedPlan.goal_update_count, pendingPlan.goal_update_count, '中断恢复不得重置目标更新计数');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  console.log('Assistant SearchPlan migration verification passed');
} finally {
  owner?.closeAll();
  database?.close();
  if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
}

function insertSecondSession(database) {
  database.prepare(`
    INSERT INTO assistant_sessions (session_id, note_id, title, status, last_turn_seq, created_at, updated_at)
    VALUES ('session-fixture-2', 'note-fixture-1', '第二会话', 'active', 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO assistant_turns (turn_id, session_id, turn_seq, note_content_hash, user_text, route, context_mode, status, provider_fingerprint, model, created_at)
    VALUES ('turn-fixture-2', 'session-fixture-2', 1, 'hash-fixture-v1', '第二问题', 'current-note-react', 'react-search', 'pending', 'fixture|model', 'model', '2026-08-22T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO assistant_evidence_refs (session_id, evidence_id, note_id, note_content_hash, block_ids_json, heading_path_json, line_from, line_to, text_hash, preview, source_tool, state, created_at)
    VALUES ('session-fixture-2', 'evidence-fixture-2', 'note-fixture-1', 'hash-fixture-v1', '["block-2"]', '["标题"]', 2, 2, 'quote-hash-fixture-2', '第二会话证据', 'current-note-react', 'active', '2026-08-22T00:00:01.000Z')
  `).run();
}

function insertCompletedPlan(database) {
  database.prepare(`
    INSERT INTO assistant_search_plans (plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question, version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at)
    VALUES ('plan-fixture-1', 'library-fixture', 'note-fixture-1', 'session-fixture-1', 'turn-fixture-1', 'hash-fixture-v1', '旧问题', 2, NULL, 'completed', 1, 2, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:02.000Z')
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_goals (plan_id, goal_id, goal_order, question, evidence_kind, status, missing_evidence)
    VALUES ('plan-fixture-1', 'goal-fixture-1', 0, '核实旧问题', 'fact', 'covered', NULL)
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_requirements (plan_id, goal_id, requirement_id, requirement_order, label, subject, min_evidence)
    VALUES ('plan-fixture-1', 'goal-fixture-1', 'requirement-fixture-1', 0, '旧问题的原文依据', NULL, 1)
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_query_terms (plan_id, goal_id, term_order, term, source)
    VALUES ('plan-fixture-1', 'goal-fixture-1', 0, '旧问题', 'planner')
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_evidence (plan_id, goal_id, requirement_id, session_id, evidence_id, side)
    VALUES ('plan-fixture-1', 'goal-fixture-1', 'requirement-fixture-1', 'session-fixture-1', 'evidence-fixture-1', 'ordinary')
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plans (plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question, version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at)
    VALUES ('plan-fixture-2', 'library-fixture', 'note-fixture-1', 'session-fixture-2', 'turn-fixture-2', 'hash-fixture-v1', '第二问题', 4, 'goal-fixture-2', 'active', 1, 3, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:02.000Z')
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_goals (plan_id, goal_id, goal_order, question, evidence_kind, status, missing_evidence)
    VALUES ('plan-fixture-2', 'goal-fixture-2', 0, '核实第二问题', 'fact', 'searching', NULL)
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_requirements (plan_id, goal_id, requirement_id, requirement_order, label, subject, min_evidence)
    VALUES ('plan-fixture-2', 'goal-fixture-2', 'requirement-fixture-2', 0, '第二问题的原文依据', NULL, 1)
  `).run();
  database.prepare(`
    INSERT INTO assistant_search_plan_query_terms (plan_id, goal_id, term_order, term, source)
    VALUES ('plan-fixture-2', 'goal-fixture-2', 0, '第二问题', 'planner')
  `).run();
}
