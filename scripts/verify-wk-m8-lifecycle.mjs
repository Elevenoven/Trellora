import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `wk-m8-${process.pid}-${Date.now()}`);
const storageWorkspace = path.join(stagingRoot, 'storage');
const logicalWorkspace = path.join(stagingRoot, 'logical');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;
let assistantOwner;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(logicalWorkspace, { recursive: true });
  transpileTestModules([
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryLexical.ts',
    'electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryConditioningService.ts',
    'electron/knowledge/memory/memoryAffinityService.ts',
    'electron/knowledge/memory/memoryConsolidationService.ts',
    'electron/pathGuards.ts',
    'electron/treeOrder.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/assistantLibraryIdentity.ts',
    'electron/knowledge/assistantRollingSummary.ts',
    'electron/knowledge/assistantMemoryDatabase.ts',
    'electron/knowledge/memory/memoryMigrationService.ts',
  ]);
  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { MemoryConditioningService } = await load('electron/knowledge/memory/memoryConditioningService.ts');
  const { MemoryAffinityService, calculateDocumentAffinityFactor, applyDocumentAffinity } = await load('electron/knowledge/memory/memoryAffinityService.ts');
  const { MemoryConsolidationService } = await load('electron/knowledge/memory/memoryConsolidationService.ts');
  const { AssistantMemoryDatabase } = await load('electron/knowledge/assistantMemoryDatabase.ts');
  const { MemoryMigrationService } = await load('electron/knowledge/memory/memoryMigrationService.ts');

  owner = new QaMemoryDatabase();
  const resolver = new MemoryScopeResolver({
    getActiveWorkspacePath: () => logicalWorkspace,
    listRegisteredWorkspacePaths: () => [logicalWorkspace],
    getPrincipalId: () => 'wk-m8-principal',
  });
  const { scope } = resolver.resolveActive();
  const writer = new MemoryWriteService(owner, storageWorkspace);
  writer.updateWorkspaceConfig(scope, { enabled: true, retrievalConditioning: true, writeMode: 'auto' });
  const database = owner.getDatabase(storageWorkspace);
  const now = new Date('2026-09-08T00:00:00.000Z').toISOString();

  for (let index = 0; index < 35; index += 1) {
    database.prepare(`
      INSERT INTO memory_items (
        id, workspace_id, principal_id, kind, content, topic, normalized_key,
        importance, origin, status, valid_from, memory_generation, created_at, updated_at
      ) VALUES (?, ?, ?, 'profile', ?, '', ?, 3, 'manual', 'active', ?, 0, ?, ?)
    `).run(`profile-${index}`, scope.workspaceId, scope.principalId, `画像条目${index}`, `profile-${index}`, now, now, now);
  }
  for (let index = 0; index < 7; index += 1) {
    database.prepare(`
      INSERT INTO memory_doc_affinities (
        id, workspace_id, principal_id, document_id, title, hits, first_used_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`affinity-${index}`, scope.workspaceId, scope.principalId, `doc-${index}`, `熟悉文档${index}`, 8 - index, now, now);
  }
  const conditioning = new MemoryConditioningService(owner, storageWorkspace).build(scope);
  assert.equal(conditioning.itemIds.length, 30, '问题改写背景最多读取 30 条画像/兴趣');
  assert.equal(conditioning.familiarDocumentIds.length, 5, '熟悉文档标题最多 5 条');
  assert.ok(conditioning.contentCodePoints <= 240, '问题改写背景正文最多 240 Unicode 字符');
  assert.match(conditioning.prompt, /^<asker_background note="仅用于消解问题语境，不是检索过滤条件">/u);

  assert.equal(calculateDocumentAffinityFactor(0), 1);
  assert.equal(calculateDocumentAffinityFactor(1), 1);
  assert.equal(calculateDocumentAffinityFactor(8), 1.15);
  assert.equal(calculateDocumentAffinityFactor(999), 1.15);
  const reranked = applyDocumentAffinity([
    { documentId: 'plain', score: 1, value: 'plain' },
    { documentId: 'familiar', score: 0.9, value: 'familiar' },
  ], new Map([['familiar', { hits: 8 }]]));
  assert.equal(reranked[0].documentId, 'familiar', '亲和度只做弱乘法重排');

  database.prepare(`
    INSERT INTO qa_sessions (session_id, scope, title, last_turn_seq, created_at, updated_at)
    VALUES ('affinity-session', 'knowledge-base', '测试', 2, ?, ?)
  `).run(now, now);
  for (let index = 1; index <= 2; index += 1) database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, user_text, assistant_text,
      status, result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, 'affinity-session', ?, ?, 1, '问', '答[1]', 'complete', '{}', '{}', ?, ?)
  `).run(`affinity-turn-${index}`, index, `affinity-turn-${index}`, now, now);
  const affinity = new MemoryAffinityService(owner, storageWorkspace);
  assert.equal(affinity.recordCompletedAnswer(scope, 'affinity-turn-1', [
    { documentId: 'answer-doc', title: '答案文档' },
    { documentId: 'answer-doc', title: '答案文档' },
  ]), 1);
  assert.equal(affinity.recordCompletedAnswer(scope, 'affinity-turn-1', [{ documentId: 'answer-doc' }]), 0, '同一回答同一文档必须幂等');
  assert.equal(affinity.recordCompletedAnswer(scope, 'affinity-turn-2', [{ documentId: 'answer-doc' }]), 1);
  assert.equal(affinity.listForCandidates(scope, ['answer-doc']).get('answer-doc').hits, 2);
  writer.updateWorkspaceConfig(scope, { enabled: false });
  assert.ok(affinity.list(scope).some((item) => item.documentId === 'answer-doc'), '关闭记忆后仍须允许管理既有熟悉文档');
  writer.updateWorkspaceConfig(scope, { enabled: true });

  database.prepare(`DELETE FROM memory_items WHERE workspace_id = ? AND principal_id = ?`).run(scope.workspaceId, scope.principalId);
  writer.createManual(scope, { kind: 'preference', content: '偏好深色紧凑界面', importance: 3 });
  writer.createManual(scope, { kind: 'preference', content: '喜欢深色紧凑布局', importance: 3 });
  const consolidation = new MemoryConsolidationService(owner, storageWorkspace);
  const merged = await consolidation.consolidate(scope, 'manual', async () => ({
    merge: true,
    content: '偏好深色且紧凑的界面布局',
    topic: '界面偏好',
    importance: 4,
  }), new Date('2026-09-08T01:00:00.000Z'));
  assert.equal(merged.candidateClusters, 1);
  assert.equal(merged.mergedClusters, 0, '人工整理必须先预览，不能仅依据模型批准合并');
  assert.equal(merged.previews.length, 1);
  assert.equal(writer.list(scope, { statuses: ['active'] }).items.length, 2, '用户确认前保留原记忆');
  consolidation.approvePreview(scope, merged.previews[0].id, merged.previews[0].fingerprint);
  assert.equal(writer.list(scope, { statuses: ['active'] }).items.length, 1);
  const tooSoon = await consolidation.consolidate(scope, 'manual', async () => ({ merge: false }), new Date('2026-09-08T01:00:30.000Z'));
  assert.equal(tooSoon.skipReason, 'too_soon', '手工整理最小间隔必须为 60 秒');

  database.prepare(`
    INSERT INTO user_profile_settings (profile_id, created_at, updated_at)
    VALUES ('legacy-profile', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO user_profile_items (
      item_id, profile_id, category, item_key, field_label, value_text,
      normalized_value, cardinality, temporal_status, assertion_kind, status,
      confidence, stability, user_locked, source_count, revision, created_at, updated_at
    ) VALUES (
      'legacy-profile-long', 'legacy-profile', 'identity', 'biography', '背景', ?,
      ?, 'single', 'current', 'explicit', 'active',
      1, 'stable', 0, 0, 1, ?, ?
    )
  `).run('长'.repeat(301), '长'.repeat(301), now, now);
  database.prepare(`
    INSERT INTO user_profile_items (
      item_id, profile_id, category, item_key, field_label, value_text,
      normalized_value, cardinality, temporal_status, assertion_kind, status,
      confidence, stability, user_locked, source_count, revision, created_at, updated_at
    ) VALUES (
      'legacy-profile-item', 'legacy-profile', 'communication', 'tone', '表达风格',
      '回答保持简洁', '回答保持简洁', 'single', 'current', 'explicit', 'active',
      1, 'stable', 1, 0, 1, ?, ?
    )
  `).run(now, now);
  const legacyLibrary = path.join(stagingRoot, 'legacy-library');
  mkdirSync(legacyLibrary, { recursive: true });
  assistantOwner = new AssistantMemoryDatabase();
  const legacyDatabase = assistantOwner.getDatabase(legacyLibrary);
  legacyDatabase.prepare(`
    INSERT INTO assistant_note_identity (note_id, relative_path, last_content_hash, state, created_at, updated_at)
    VALUES ('note-1', '测试.md', 'content-hash-1', 'active', ?, ?)
  `).run(now, now);
  legacyDatabase.prepare(`
    INSERT INTO assistant_sessions (session_id, note_id, title, status, last_turn_seq, created_at, updated_at)
    VALUES ('legacy-session', 'note-1', '旧当前笔记对话', 'active', 2, ?, ?)
  `).run(now, now);
  legacyDatabase.prepare(`
    INSERT INTO assistant_turns (
      turn_id, session_id, turn_seq, note_content_hash, user_text, assistant_text,
      route, context_mode, status, provider_fingerprint, model, usage_json, created_at, finished_at
    ) VALUES (?, 'legacy-session', ?, 'content-hash-1', ?, ?, 'direct', 'persistent', ?, 'test', 'test-model', '{}', ?, ?)
  `).run('legacy-complete-turn', 1, '旧问题', '旧回答', 'complete', now, now);
  legacyDatabase.prepare(`
    INSERT INTO assistant_turns (
      turn_id, session_id, turn_seq, note_content_hash, user_text, assistant_text,
      route, context_mode, status, provider_fingerprint, model, usage_json, created_at, finished_at
    ) VALUES (?, 'legacy-session', ?, 'content-hash-1', ?, NULL, 'direct', 'persistent', ?, 'test', 'test-model', '{}', ?, ?)
  `).run('legacy-failed-turn', 2, '失败问题', 'error', now, now);
  const migrationService = new MemoryMigrationService(owner, assistantOwner, storageWorkspace);
  const firstMigration = migrationService.migrate(scope, [legacyLibrary]);
  assert.equal(firstMigration.profile.completed, 2);
  const longProfile = database.prepare(`SELECT status, length(content) AS length, proposal_action, review_reason, write_protection FROM memory_items WHERE topic = '背景'`).get();
  assert.deepEqual(longProfile, { status: 'pending', length: 300, proposal_action: 'add', review_reason: 'LEGACY_PROPOSAL', write_protection: 'legacy' }, '超长旧画像必须按新版形状进入人工复核并保留旧数据保护');
  assert.match(database.prepare(`SELECT mapping_json FROM memory_migration_audit WHERE source_id = 'legacy-profile-long'`).get().mapping_json, /content-over-300-code-points/u);
  assert.equal(firstMigration.currentNote.completed, 1);
  assert.equal(firstMigration.currentNote.skipped, 1, '失败/未完成 current-note 轮次只写审计');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM qa_turns WHERE scope_label = '当前笔记'`).get().count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE question = '旧问题'`).get().count, 1);
  const secondMigration = migrationService.migrate(scope, [legacyLibrary]);
  assert.equal(secondMigration.profile.skipped, 2, 'profile 迁移必须按 fingerprint 幂等');
  assert.equal(secondMigration.currentNote.skipped, 2, 'current-note 迁移必须按 fingerprint 幂等');

  const queryRewriteSource = readFileSync(path.join(rootDir, 'electron/knowledge/queryRewrite.ts'), 'utf8');
  const ragSource = readFileSync(path.join(rootDir, 'electron/knowledge/knowledgeBaseRag.ts'), 'utf8');
  const mainSource = readFileSync(path.join(rootDir, 'electron/main.ts'), 'utf8');
  assert.match(queryRewriteSource, /askerBackground/u, '背景必须显式进入 query rewrite');
  assert.match(ragSource, /相关性门控后的弱排序信号/u, '亲和度必须位于相关性门控之后');
  assert.match(mainSource, /result\.answer\.includes\(`\[\$\{citation\.reference\}\]`\)/u, '只允许真实引用写入文档亲和度');
  assert.match(mainSource, /memory:consolidate/u);
  assert.match(mainSource, /memory:list-topics/u);
  assert.match(mainSource, /memory:list-documents/u);
  assert.match(mainSource, /memory:get-used-for-turn/u);
  assert.match(mainSource, /memory:import/u);
  assert.match(mainSource, /MemoryMigrationService/u);

  console.log('WK-M8 retrieval conditioning, affinity, consolidation, migration wiring, and management contract passed');
} finally {
  owner?.closeAll();
  assistantOwner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);
}

function load(relativePath) {
  return import(pathToFileURL(modulePath(relativePath)).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  if (!path.resolve(target).toLocaleLowerCase('en-US').startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
