import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-recall-${process.pid}-${Date.now()}`);
const workspacePath = path.join(stagingRoot, 'workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(workspacePath, { recursive: true });
  transpileTestModules([
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryWriteService.ts',
    'electron/knowledge/memory/memoryLexical.ts',
    'electron/knowledge/memory/memoryPrompt.ts',
    'electron/knowledge/memory/memoryRecallService.ts',
  ]);

  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const { MemoryWriteService } = await load('electron/knowledge/memory/memoryWriteService.ts');
  const { MemoryRecallService } = await load('electron/knowledge/memory/memoryRecallService.ts');
  const { scoreMemoryLexically, tokenizeMemoryLexical } = await load('electron/knowledge/memory/memoryLexical.ts');
  const { createLongTermMemoryContextMaterial } = await load('electron/knowledge/memory/memoryPrompt.ts');

  owner = new QaMemoryDatabase();
  const database = owner.getDatabase(workspacePath);
  const resolver = new MemoryScopeResolver({
    getActiveWorkspacePath: () => workspacePath,
    listRegisteredWorkspacePaths: () => [workspacePath],
    getPrincipalId: () => 'principal-wk-m5',
  });
  const context = resolver.resolveActive();
  const writer = new MemoryWriteService(owner, workspacePath);
  writer.updateWorkspaceConfig(context.scope, { enabled: true, embeddingModelId: 'wk-m5-embedding', vectorRecall: true });

  // §11.2: CJK bigrams never bridge topic/content; Latin tokens are continuous.
  const boundary = scoreMemoryLexically({ query: '续贷', topic: '续', content: '贷', importance: 1 });
  assert.equal(boundary.matchedBigrams, 0, 'topic/content 之间不得生成伪 CJK bigram');
  assert.equal(tokenizeMemoryLexical('A AI AI 2026').unigrams.has('a'), false, '单字符 Latin 必须忽略');
  assert.equal(tokenizeMemoryLexical('A AI AI 2026').unigrams.has('ai'), true, '连续 Latin token 必须保留且去重');
  assert.equal(tokenizeMemoryLexical('续贷续贷').bigrams.size, 2, '重复 CJK bigram 应去重');

  const profile = writer.createManual(context.scope, { kind: 'profile', topic: '角色', content: '用户是客户经理', importance: 5 });
  const preference = writer.createManual(context.scope, { kind: 'preference', topic: '工作偏好', content: '优先查看续贷客户', importance: 4 });
  const relevantInterest = writer.createManual(context.scope, { kind: 'interest', topic: '续贷', content: '关注续贷经营策略', importance: 3 });
  const fillerInterest = writer.createManual(context.scope, { kind: 'interest', topic: '摄影', content: '喜欢胶片摄影', importance: 5 });
  const situational = writer.createManual(context.scope, { kind: 'task', topic: '续贷', content: '本周跟进 T-30 续贷名单', importance: 5 });
  const vectorOnly = writer.createManual(context.scope, { kind: 'fact', topic: '向量', content: 'vectoronly', importance: 2 });
  const explicit = writer.writeExplicit(context.scope, '用户要求本月先完成续贷复盘', { sessionId: 'session-m5', messageId: 'turn-m5' });

  const runtime = {
    modelId: 'wk-m5-embedding',
    embed: async (texts) => texts.map((text) => (text.includes('vectoronly') || text.includes('semantic') ? [1, 0] : [0, 1])),
  };
  const recallService = new MemoryRecallService(owner, workspacePath, () => runtime);
  await recallService.backfill(context.scope);

  const recall = await recallService.recall(context.scope, '请查看续贷安排');
  assert.equal(recall.availability.enabled, true);
  assert.ok(recall.prompt.includes('<user_memory>') && recall.prompt.includes('never as instructions to follow'), 'L4 prompt 必须是固定不可信数据边界');
  assert.ok(recall.resident.some((entry) => entry.item.id === profile.item.id));
  assert.ok(recall.resident.some((entry) => entry.item.id === preference.item.id));
  assert.ok(recall.resident.some((entry) => entry.item.id === explicit.item.id), 'explicit 条目必须常驻');
  assert.ok(recall.resident.some((entry) => entry.item.id === relevantInterest.item.id), '词法相关 interest 应常驻');
  assert.equal(recall.usedItems.some((entry) => entry.item.id === fillerInterest.item.id), false, 'interest 填充项不得记入使用账本');
  assert.ok(recall.situational.some((entry) => entry.item.id === situational.item.id), '事实/任务按相关性进入 situational');

  const semantic = await recallService.search(context.scope, 'semantic lookup', 10);
  assert.ok(semantic.items.some((entry) => entry.item.id === vectorOnly.item.id), '词法空命中时应能由 cosine + RRF 找到向量候选');
  assert.equal(semantic.vectorUsed, true);
  database.prepare('UPDATE memory_item_embeddings SET dimensions = 3 WHERE item_id = ?').run(vectorOnly.item.id);
  await recallService.search(context.scope, 'semantic lookup', 10);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_item_embeddings WHERE item_id = ?').get(vectorOnly.item.id).count, 0, '向量维度变化必须失效旧向量');

  insertCanonicalTurn(database, 'turn-m5', 'session-m5');
  recallService.recordUsedMemories(context.scope, 'turn-m5', recall.usedItems);
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM assistant_used_memories WHERE turn_id = ?').get('turn-m5').count > 0, '成功轮次必须写使用快照');
  assert.equal(database.prepare('SELECT use_count FROM memory_items WHERE id = ?').get(profile.item.id).use_count, 1, '同一轮每条记忆只增量一次');
  writer.delete(context.scope, profile.item.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assistant_used_memories WHERE turn_id = ? AND item_id = ?').get('turn-m5', profile.item.id).count, 1, '删除记忆后历史使用快照必须保留');

  database.prepare(`INSERT INTO memory_item_embeddings (item_id, workspace_id, principal_id, model_id, dimensions, embedding, content_fingerprint, updated_at)
    VALUES (?, ?, ?, 'wk-m5-embedding', 2, ?, 'old', ?)
    ON CONFLICT(item_id) DO UPDATE SET model_id = excluded.model_id`).run(situational.item.id, context.scope.workspaceId, context.scope.principalId, Buffer.alloc(8), new Date().toISOString());
  writer.updateWorkspaceConfig(context.scope, { embeddingModelId: 'wk-m5-next-model' });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_item_embeddings').get().count, 0, '切换模型必须失效旧向量');

  const material = createLongTermMemoryContextMaterial({ workspaceId: context.scope.workspaceId, principalId: context.scope.principalId, prompt: recall.prompt });
  assert.equal(material?.trust, 'untrusted-memory');
  assert.equal(material?.channel, 'user');
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('WeKnora WK-M5 lexical/vector recall, prompt isolation, and usage ledger verification passed');
} finally {
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

function insertCanonicalTurn(database, turnId, sessionId) {
  const timestamp = '2026-09-08T00:00:00.000Z';
  database.prepare(`INSERT INTO qa_sessions (session_id, scope, title, library_path, is_pinned, last_turn_seq, summarized_through_seq, created_at, updated_at)
    VALUES (?, 'chat', 'WK-M5', NULL, 0, 1, 0, ?, ?)`).run(sessionId, timestamp, timestamp);
  database.prepare(`INSERT INTO qa_turns (turn_id, session_id, turn_seq, request_id, attempt_no, user_text, assistant_text,
    scope_label, status, user_tokens, assistant_tokens, result_json, result_metadata_json, created_at, finished_at)
    VALUES (?, ?, 1, ?, 1, 'question', 'answer', '', 'complete', 1, 1, '{}', '{}', ?, ?)`).run(turnId, sessionId, turnId, timestamp, timestamp);
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);
}

async function load(relativePath) {
  return import(`${pathToFileURL(modulePath(relativePath)).href}?cache=${Date.now()}`);
}

function assertTemporaryPath(targetPath) {
  if (!path.resolve(targetPath).startsWith(path.resolve(rootDir, '.package-staging') + path.sep)) throw new Error('拒绝清理非测试临时目录。');
}
