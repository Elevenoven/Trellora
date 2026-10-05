import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-extraction-${process.pid}-${Date.now()}`);
const workspacePath = path.join(stagingRoot, 'workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;
let service;
let fixtureScope;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(workspacePath, { recursive: true });
  transpileTestModules([
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/aiTypes.ts',
    'electron/knowledge/aiProvider.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryExtractionScheduler.ts',
    'electron/knowledge/memory/memoryExtractor.ts',
    'electron/knowledge/memory/memoryTopicService.ts',
    'electron/knowledge/memory/memoryExtractionService.ts',
  ]);

  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { MemoryExtractionService } = await load('electron/knowledge/memory/memoryExtractionService.ts');
  owner = new QaMemoryDatabase();
  const database = owner.getDatabase(workspacePath);
  const resolver = new MemoryScopeResolver({
    getActiveWorkspacePath: () => workspacePath,
    listRegisteredWorkspacePaths: () => [workspacePath],
    getPrincipalId: () => 'principal-wk-m4',
  });
  const context = resolver.resolveActive();
  fixtureScope = context.scope;
  const writer = new MemoryWriteService(owner, workspacePath);
  writer.updateWorkspaceConfig(context.scope, {
    enabled: true,
    writeMode: 'auto',
    extractDelaySeconds: 5,
    interestThreshold: 3,
  });

  const outputs = [];
  const seenPrompts = [];
  let modelAvailable = true;
  service = new MemoryExtractionService(owner, workspacePath, {
    revalidateScope: (scope) => resolver.revalidatePersistedScope(scope),
    isRouteEnabled: () => true, automaticWriteReady: () => true,
    resolveModel: async () => modelAvailable
      ? {
        ready: true,
        model: 'test-memory-model',
        contextWindowTokens: 8_192,
        providerConfig: { kind: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'test-memory-model' },
      }
      : { ready: false, code: 'model_unavailable', message: '测试模型不可用' },
    generateJson: async (input) => {
      seenPrompts.push(input.prompt);
      const next = outputs.shift();
      input.onRawResponse?.(JSON.stringify(next));
      return next;
    },
  });

  insertCanonicalTurn(database, 'turn-1', 'session-a', '我希望优先关注续贷客户。', 'assistant-private-answer-should-never-be-prompted', 1);
  outputs.push({
    schemaVersion: 2,
    topics: ['续贷客户'],
    decisions: [{
      operation: 'add', targetItemId: null, relation: 'independent', evidenceQuote: '我希望优先关注续贷客户。', kind: 'preference', content: '用户希望优先关注续贷客户', topic: '客户经营',
      importance: 3, inferred: true, sourceMessageId: 'turn-1', expiresAt: null,
    }],
  });
  const firstJobId = enqueueNow(service, database, context.scope, 'session-a', 'turn-1');
  await waitFor(() => database.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(firstJobId)?.status === 'done');
  assert.equal(database.prepare("SELECT status FROM memory_items WHERE source_message_id = 'turn-1'").get().status, 'pending', 'inferred=true 必须产生 pending 候选');
  assert.equal(database.prepare("SELECT hits FROM memory_topic_stats WHERE normalized_key = '续贷客户'").get().hits, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE kind = 'interest' AND status = 'active'").get().count, 0, '低于阈值不得晋升 interest');
  assert.equal(database.prepare('SELECT extract_cursor_message_id FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?').get(context.scope.workspaceId, context.scope.principalId).extract_cursor_message_id, 'turn-1');
  assert.equal(seenPrompts.some((prompt) => prompt.includes('assistant-private-answer-should-never-be-prompted')), false, '提炼请求不得读取 assistant 文本');

  for (const turnId of ['turn-2', 'turn-3']) {
    insertCanonicalTurn(database, turnId, 'session-a', `${turnId}：继续讨论续贷客户。`, 'assistant-answer', Number(turnId.slice(-1)));
    outputs.push({ schemaVersion: 2, topics: ['续贷客户'], decisions: [] });
    const jobId = enqueueNow(service, database, context.scope, 'session-a', turnId);
    await waitFor(() => database.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(jobId)?.status === 'done');
  }
  assert.equal(database.prepare("SELECT hits FROM memory_topic_stats WHERE normalized_key = '续贷客户'").get().hits, 3);
  assert.equal(database.prepare("SELECT status FROM memory_items WHERE kind = 'interest' AND topic = '续贷客户'").get().status, 'pending', '第三次命中产生待确认 interest，不直接生效');

  const old = writer.list(context.scope, {statuses:['pending']}).items.find(item => item.sourceMessageId === 'turn-1');
  writer.confirm(context.scope, old.id);
  insertCanonicalTurn(database, 'turn-4', 'session-a', '我不再需要优先关注续贷客户。', 'assistant-answer', 4);
  outputs.push({
    schemaVersion: 2,
    topics: [],
    decisions: [{
      operation: 'delete', targetItemId: old.id, relation: 'correction', evidenceQuote: '我不再需要优先关注续贷客户。', kind: 'preference', content: '用户希望优先关注续贷客户', topic: '客户经营',
      importance: 3, inferred: true, sourceMessageId: 'turn-4', expiresAt: null,
    }],
  });
  const deleteJobId = enqueueNow(service, database, context.scope, 'session-a', 'turn-4');
  await waitFor(() => database.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(deleteJobId)?.status === 'done');
  assert.equal(database.prepare("SELECT status FROM memory_items WHERE source_message_id = 'turn-1'").get().status, 'active', '自动 delete 先提出撤销提案，旧项保持有效');

  assert.equal(writer.list(context.scope,{statuses:['pending']}).items.find(item=>item.sourceMessageId === 'turn-4').proposalAction, 'retire');
  insertCanonicalTurn(database, 'turn-5', 'session-a', '这条在无效 JSON 后不能推进水位。', 'assistant-answer', 5);
  outputs.push({}, {}, {}, {}, {}, {});
  const invalidJobId = enqueueNow(service, database, context.scope, 'session-a', 'turn-5');
  await waitFor(() => database.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(invalidJobId)?.status === 'failed');
  assert.equal(database.prepare('SELECT extract_cursor_message_id FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?').get(context.scope.workspaceId, context.scope.principalId).extract_cursor_message_id, 'turn-4', '无效 JSON 不得推进水位');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_items WHERE source_message_id = ?').get('turn-5').count, 0);

  modelAvailable = false;
  insertCanonicalTurn(database, 'turn-6', 'session-a', '模型不可用时不能改变水位。', 'assistant-answer', 6);
  const unavailableJobId = enqueueNow(service, database, context.scope, 'session-a', 'turn-6');
  await waitFor(() => database.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(unavailableJobId)?.status === 'failed');
  assert.equal(database.prepare('SELECT extract_cursor_message_id FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?').get(context.scope.workspaceId, context.scope.principalId).extract_cursor_message_id, 'turn-4', '模型不可用不得推进水位');

  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('WeKnora WK-M4 automatic extraction, watermark, topic, and interest verification passed');
} finally {
  service?.stop();
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function enqueueNow(service, database, scope, sessionId, turnId) {
  service.scheduleAfterCompletedTurn(scope, {
    sessionId,
    messageId: turnId,
    modelHint: { profileId: 'profile-a', modelId: 'test-memory-model', contextWindowTokens: 8_192 },
  });
  const jobId = database.prepare(`
    SELECT id FROM memory_extraction_jobs
    WHERE workspace_id = ? AND principal_id = ? AND status IN ('queued', 'retry')
    ORDER BY created_at DESC LIMIT 1
  `).get(scope.workspaceId, scope.principalId).id;
  database.prepare('UPDATE memory_extraction_jobs SET due_at = ? WHERE id = ?').run(new Date().toISOString(), jobId);
  database.prepare(`UPDATE memory_extraction_pending_sources SET due_at = ?`).run(new Date().toISOString());
  service.start();
  return jobId;
}

function insertCanonicalTurn(database, turnId, sessionId, userText, assistantText, sequence) {
  const createdAt = `2026-09-08T00:00:0${sequence}.000Z`;
  database.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq, summarized_through_seq, created_at, updated_at
    ) VALUES (?, 'chat', 'WK-M4', NULL, 0, ?, 0, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_turn_seq = excluded.last_turn_seq, updated_at = excluded.updated_at
  `).run(sessionId, sequence, createdAt, createdAt);
  database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, user_text, assistant_text,
      scope_label, status, user_tokens, assistant_tokens, result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, '', 'complete', 1, 1, '{}', ?, ?, ?)
  `).run(turnId, sessionId, sequence, turnId, userText, assistantText, JSON.stringify({ route: 'chat', memoryScope: fixtureScope, memoryExtractionGeneration: 0, memoryExtractionEligible: true, memoryExtractionAgentId: 'default' }), createdAt, createdAt);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待 WK-M4 后台任务超时。');
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);
}

async function load(relativePath) {
  return import(`${pathToFileURL(modulePath(relativePath)).href}?cache=${Date.now()}`);
}

function assertTemporaryPath(targetPath) {
  if (!path.resolve(targetPath).startsWith(path.resolve(rootDir, '.package-staging') + path.sep)) {
    throw new Error('拒绝清理非测试临时目录。');
  }
}
