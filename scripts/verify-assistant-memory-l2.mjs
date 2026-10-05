import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `assistant-memory-l2-${process.pid}-${Date.now()}`);
const libraryDir = path.join(stagingRoot, 'library');
const databasePath = path.join(libraryDir, '.menghan-meta', 'assistant-memory.db');
const databaseBundle = process.env.ASSISTANT_MEMORY_L2_DATABASE_BUNDLE || path.join(stagingRoot, 'assistantMemoryDatabase.cjs');
const repositoryBundle = process.env.ASSISTANT_MEMORY_L2_REPOSITORY_BUNDLE || path.join(stagingRoot, 'assistantMemoryRepository.cjs');
const contentHash = 'hash-fixture-v1';
const changedContentHash = 'hash-fixture-v2';
let database;
let owner;

try {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!process.env.ASSISTANT_MEMORY_L2_DATABASE_BUNDLE || !process.env.ASSISTANT_MEMORY_L2_REPOSITORY_BUNDLE) {
    await Promise.all([
      build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryDatabase.ts')], outfile: databaseBundle, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
      build({ entryPoints: [path.join(rootDir, 'electron', 'knowledge', 'assistantMemoryRepository.ts')], outfile: repositoryBundle, bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'] }),
    ]);
  }
  const databaseModule = await import(pathToFileURL(databaseBundle).href);
  const repositoryModule = await import(pathToFileURL(repositoryBundle).href);
  const { migrateAssistantMemoryDatabase, AssistantMemoryDatabase } = databaseModule;
  const { AssistantMemoryRepository } = repositoryModule;

  database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'assistant-memory', 'pre-plan-schema.sql'), 'utf8'));
  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.equal(database.pragma('user_version', { simple: true }), 4);
  migrateAssistantMemoryDatabase(database, 'library-fixture');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  insertAdditionalTerminalTurns(database);
  insertPlan(database);
  // Keep the legacy evidence row for plan validation, but avoid requiring a
  // full markdown snapshot in this migration-focused fixture.
  database.prepare("DELETE FROM assistant_turn_evidence WHERE turn_id = 'turn-fixture-1'").run();
  owner = new AssistantMemoryDatabase();
  const repository = new AssistantMemoryRepository(owner, libraryDir);
  const scopeA = { libraryId: 'library-fixture', noteId: 'note-fixture-1', sessionId: 'session-fixture-1' };
  const snapshot = { contentHash };

  const restoredPlan = repository.getSession(scopeA).turns.items.find((turn) => turn.turnId === 'turn-fixture-1')?.planEvent;
  assert.deepEqual(restoredPlan, {
    phase: 'finished',
    status: 'completed',
    goals: [{ label: '核实旧问题', status: 'covered', evidenceCount: 1 }],
  }, '恢复会话时应重建不含查询词的公开 Planner 快照');
  assert.equal('queryTerms' in (restoredPlan?.goals[0] ?? {}), false);

  const first = await repository.compactRollingSummary(scopeA, snapshot);
  assert.deepEqual(first.payload.turnDigests.map((digest) => digest.turnSeq), [1, 2], '首次只处理热窗口之外的冷 turn');
  assert.equal(first.coveredThroughSeq, 2);
  assert.equal(first.payload.turnDigests[0].planOutcome.planId, 'plan-fixture-1', 'digest 必须保留 plan outcome 引用');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_turn_digests WHERE session_id = 'session-fixture-1' AND state = 'active'").get().count, 2);

  const repeated = await repository.compactRollingSummary(scopeA, snapshot);
  assert.equal(repeated.version, first.version, '没有新增冷 turn 时不得重复提交摘要版本');
  assert.equal(repeated.payload.turnDigests.length, 2);
  assert.equal(repository.loadContext(scopeA, snapshot).conversation.length, 7, '摘要 + 最近三个终态 turn 必须完整保留');

  const casBase = repository.getRollingSummary(scopeA);
  assert.equal(await repository.commitRollingSummary(scopeA, snapshot, {
    expectedVersion: casBase.version,
    expectedCoveredThroughSeq: casBase.coveredThroughSeq,
    payload: casBase.payload,
  }), true, '匹配版本与覆盖序号时 CAS 必须提交');
  assert.equal(await repository.commitRollingSummary(scopeA, snapshot, {
    expectedVersion: casBase.version,
    expectedCoveredThroughSeq: casBase.coveredThroughSeq,
    payload: casBase.payload,
  }), false, '旧版本 CAS 必须被拒绝');

  const sessionB = repository.createSession({ libraryId: 'library-fixture', relativePath: 'fixture.md', contentHash, title: '第二会话' });
  const scopeB = { libraryId: 'library-fixture', noteId: 'note-fixture-1', sessionId: sessionB.sessionId };
  await assert.rejects(
    repository.commitRollingSummary(scopeB, snapshot, {
      expectedVersion: 1,
      expectedCoveredThroughSeq: 0,
      payload: casBase.payload,
    }),
    /当前会话不可用/u,
    '跨 session 的 turn/plan outcome 引用必须被拒绝',
  );
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  repository.loadContext(scopeA, { contentHash: changedContentHash });
  const invalidated = repository.getRollingSummary(scopeA);
  assert.equal(invalidated.payload.turnDigests.length, 0, 'contentHash 变化必须使滚动摘要失效');
  assert.equal(invalidated.coveredThroughSeq, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM assistant_turn_digests WHERE session_id = 'session-fixture-1' AND state = 'active'").get().count, 0);
  assert.equal(database.prepare("SELECT status FROM assistant_search_plans WHERE plan_id = 'plan-fixture-1'").get().status, 'stale');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);

  console.log('Assistant-memory L2 verification passed');
} finally {
  owner?.closeAll();
  database?.close();
  if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
}

function insertAdditionalTerminalTurns(database) {
  database.prepare('UPDATE assistant_sessions SET last_turn_seq = 5 WHERE session_id = ?').run('session-fixture-1');
  const insert = database.prepare(`
    INSERT INTO assistant_turns (
      turn_id, session_id, turn_seq, note_content_hash, user_text, assistant_text,
      route, context_mode, status, provider_fingerprint, model, created_at, finished_at
    ) VALUES (?, 'session-fixture-1', ?, ?, ?, ?, 'current-note-react', 'react-search', 'complete', 'fixture|model', 'model', ?, ?)
  `);
  for (let turnSeq = 2; turnSeq <= 5; turnSeq += 1) {
    insert.run(`turn-fixture-${turnSeq}`, turnSeq, contentHash, `问题 ${turnSeq}`, `回答 ${turnSeq}`, `2026-08-22T00:00:0${turnSeq}.000Z`, `2026-08-22T00:00:0${turnSeq}.500Z`);
  }
}

function insertPlan(database) {
  database.prepare(`
    INSERT INTO assistant_search_plans (
      plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question,
      version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at
    ) VALUES ('plan-fixture-1', 'library-fixture', 'note-fixture-1', 'session-fixture-1', 'turn-fixture-1', ?, '旧问题', 2, NULL, 'completed', 1, 2, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:02.000Z')
  `).run(contentHash);
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
}
