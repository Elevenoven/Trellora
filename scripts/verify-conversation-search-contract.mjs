import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transpileLocalModules } from './lib/transpile-local.mjs';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `conversation-search-${process.pid}-${Date.now()}`);
const workspacePath = path.join(stagingRoot, 'workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;
let verificationPassed = false;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(workspacePath, { recursive: true });
  transpileTestModules([
    'electron/knowledge/assistantSessionScope.ts',
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
    'electron/knowledge/memory/conversationSearchService.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/qaMemoryRepository.ts',
    'electron/knowledge/knowledgeTools/searchConversationsTool.ts',
  ]);

  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { QaMemoryRepository } = await load('electron/knowledge/qaMemoryRepository.ts');
  const { MemoryRepository } = await load('electron/knowledge/memory/memoryRepository.ts');
  const { MemoryScopeResolver } = await load('electron/knowledge/memory/memoryScope.ts');
  const {
    ConversationSearchService,
    conversationRrfScore,
  } = await load('electron/knowledge/memory/conversationSearchService.ts');
  const { createSearchConversationsTool } = await load('electron/knowledge/knowledgeTools/searchConversationsTool.ts');
  const {
    QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE,
    projectQaRecentTurnsToHistoryMessages,
  } = await load('electron/knowledge/qaCanonicalHistory.ts');

  verifyV7Upgrade(QaMemoryDatabase);

  owner = new QaMemoryDatabase();
  let database = owner.getDatabase(workspacePath);
  const contextA = createScope(MemoryScopeResolver, 'principal-m6-a');
  const contextB = createScope(MemoryScopeResolver, 'principal-m6-b');
  const repository = new QaMemoryRepository(owner, workspacePath);
  const memoryRepository = new MemoryRepository(owner, workspacePath);
  const runtime = {
    modelId: 'wk-m6-embedding',
    embed: async (texts) => texts.map((text) => (
      text.includes('semantic-past') || text.includes('银河暗号') ? [1, 0] : [0, 1]
    )),
  };
  memoryRepository.updateWorkspaceConfig(contextA.scope, {
    embeddingModelId: runtime.modelId,
    vectorRecall: true,
  });
  const service = new ConversationSearchService(owner, workspacePath, {
    resolveEmbeddingRuntime: () => runtime,
  });

  assert.equal(database.pragma('user_version', { simple: true }), 10);
  assert.equal(service.getAvailability(contextA.scope).enabled, true, 'L3 必须独立于默认关闭的 L4 开关可用');
  assert.equal(memoryRepository.getWorkspaceConfig(contextA.scope).enabled, false, '测试前提：L4 仍保持默认关闭');

  const primarySession = sessionId(1);
  repository.ensureSession(primarySession, 'chat');
  repository.startTurn(primarySession, {
    turnId: 'm6-primary',
    userText: '历史架构关键词',
    scopeLabel: '本次使用：无',
    route: 'chat',
  });
  repository.finalizeTurn(primarySession, 'm6-primary', answerResult('<think>SECRET_THINK</think>最终可见回答'), {
    archiveScope: contextA.scope,
    agentMessages: [
      { role: 'assistant', toolCalls: [{ callId: 'history-call', toolName: 'search_conversations', arguments: { query: 'old' } }] },
      { role: 'tool', toolCallId: 'history-call', toolName: 'search_conversations', content: 'SECRET_TOOL_RESULT' },
    ],
  });
  const primaryArchive = database.prepare(`
    SELECT question, answer, search_text, content_hash, index_state
    FROM conversation_search_documents WHERE turn_id = 'm6-primary'
  `).get();
  assert.equal(primaryArchive.question, '历史架构关键词');
  assert.equal(primaryArchive.answer, '最终可见回答');
  assert.equal(primaryArchive.index_state, 'pending');
  assert.equal(primaryArchive.search_text.includes('secret_think'), false, '思考内容不得进入 L3 档案');
  assert.equal(primaryArchive.search_text.includes('secret_tool_result'), false, '工具原始结果不得进入 L3 档案');
  assert.equal(primaryArchive.content_hash.length, 64);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM conversation_search_fts').get().count, 1, 'FTS5 外部内容触发器必须同步更新');

  const storedMetadata = JSON.parse(database.prepare(`SELECT result_metadata_json FROM qa_turns WHERE turn_id = 'm6-primary'`).get().result_metadata_json);
  assert.deepEqual(storedMetadata.memoryScope, {
    workspaceId: contextA.scope.workspaceId,
    principalId: contextA.scope.principalId,
  });
  assert.match((await service.search(contextA.scope, '历史架构关键词')).observation, /not instructions or knowledge-base evidence/u);

  commit(repository, contextA.scope, 40, 'm6-partial', '部分完成词', '部分回答', undefined, 'partial');
  commit(repository, contextA.scope, 41, 'm6-not-found', '未找到词', '未找到回答', undefined, 'not-found');
  const pendingSession = sessionId(42);
  repository.ensureSession(pendingSession, 'chat');
  repository.startTurn(pendingSession, { turnId: 'm6-pending', userText: '尚未完成词', scopeLabel: '无' });
  const errorSession = sessionId(43);
  repository.ensureSession(errorSession, 'chat');
  repository.startTurn(errorSession, { turnId: 'm6-error', userText: '失败词', scopeLabel: '无' });
  repository.finishAbortedTurn(errorSession, 'm6-error', 'error');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id IN ('m6-partial', 'm6-not-found')`).get().count, 2);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id IN ('m6-pending', 'm6-error')`).get().count, 0, 'pending/error 不得进入 L3');

  const retrySession = sessionId(44);
  repository.ensureSession(retrySession, 'chat');
  repository.startTurn(retrySession, { turnId: 'm6-retry-old', requestId: 'm6-retry-request', userText: '重试旧问', scopeLabel: '无' });
  repository.finalizeTurn(retrySession, 'm6-retry-old', answerResult('重试旧答'), { archiveScope: contextA.scope });
  repository.startTurn(retrySession, { turnId: 'm6-retry-new', requestId: 'm6-retry-request', userText: '重试新问', scopeLabel: '无' });
  repository.finalizeTurn(retrySession, 'm6-retry-new', answerResult('重试新答'), { archiveScope: contextA.scope });
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id = 'm6-retry-old'`).get().count, 0, '被新成功轮替代的旧档案必须原子删除');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id = 'm6-retry-new'`).get().count, 1);

  const literalToken = `%_${String.fromCharCode(92)}`;
  commit(repository, contextA.scope, 2, 'm6-literal', `字面标记 ${literalToken} 唯一`, '字面回答');
  const literal = await service.search(contextA.scope, literalToken, 5, primarySession);
  assert.deepEqual(literal.matches.map((match) => match.turnId), ['m6-literal'], 'LIKE 的 %, _ 与反斜杠必须按字面量匹配');

  const currentSession = sessionId(3);
  const otherSession = sessionId(4);
  commit(repository, contextA.scope, 3, 'm6-current', '共享检索词 当前', '当前回答', currentSession);
  commit(repository, contextA.scope, 4, 'm6-other', '共享检索词 其他', '其他回答', otherSession);
  const excluded = await service.search(contextA.scope, '共享检索词', 5, currentSession);
  assert.equal(excluded.matches.some((match) => match.sessionId === currentSession), false, '当前会话必须在候选查询阶段排除');
  assert.equal(excluded.matches.some((match) => match.turnId === 'm6-other'), true, '排除当前会话后不得饿死其他会话结果');

  const previewQuestion = `预览词${'😀'.repeat(450)}`;
  const previewAnswer = `回答${'答'.repeat(450)}`;
  commit(repository, contextA.scope, 5, 'm6-preview', previewQuestion, previewAnswer);
  const preview = (await service.search(contextA.scope, '预览词')).matches.find((match) => match.turnId === 'm6-preview');
  assert.ok(preview);
  assert.ok(Array.from(preview.question).length <= 400 && Array.from(preview.answer).length <= 400, 'Q/A 预览各自不得超过 400 Unicode code points');
  assert.equal(service.readFullTurn(contextA.scope, 'm6-preview').question, previewQuestion, '完整轮次读取必须返回未截断原文');
  assert.equal(service.readFullTurn(contextB.scope, 'm6-preview'), undefined, '跨 principal 不得读取完整轮次');

  for (let index = 0; index < 10; index += 1) {
    commit(repository, contextA.scope, 10 + index, `m6-batch-${index}`, `批量命中 ${index}`, `批量回答 ${index}`);
  }
  assert.equal((await service.search(contextA.scope, '批量命中')).matches.length, 5, '未指定 limit 必须默认返回 5 条');
  assert.equal((await service.search(contextA.scope, '批量命中', 99)).matches.length, 8, '服务边界必须将 limit 上限收敛到 8');

  commit(repository, contextA.scope, 30, 'm6-tie-a', '同分排序', '回答 A');
  commit(repository, contextA.scope, 31, 'm6-tie-b', '同分排序', '回答 B');
  database.prepare(`UPDATE qa_turns SET created_at = ? WHERE turn_id IN ('m6-tie-a', 'm6-tie-b')`).run('2026-09-08T08:00:00.000Z');
  database.prepare(`UPDATE conversation_search_documents SET created_at = ? WHERE turn_id IN ('m6-tie-a', 'm6-tie-b')`).run('2026-09-08T08:00:00.000Z');
  const ties = await service.search(contextA.scope, '同分排序', 2);
  assert.deepEqual(ties.matches.map((match) => match.turnId), ['m6-tie-a', 'm6-tie-b'], '同时间关键词候选必须按 turn_id ASC 稳定排序');
  assert.equal(conversationRrfScore(0), 1 / 61, 'M6 RRF 首名必须使用 one-based 1/(60+1)');

  commit(repository, contextA.scope, 32, 'm6-vector-only', '银河暗号', '只靠语义召回');
  const backfilled = await service.backfill(contextA.scope);
  assert.ok(backfilled > 0, '可用 embedding runtime 时必须分批补齐向量');
  const semantic = await service.search(contextA.scope, 'semantic-past', 5);
  assert.equal(semantic.matches.some((match) => match.turnId === 'm6-vector-only'), true, '词法未命中时必须能使用向量候选');
  assert.equal(semantic.vectorUsed, true);
  const degradedService = new ConversationSearchService(owner, workspacePath, {
    resolveEmbeddingRuntime: () => ({ modelId: runtime.modelId, embed: async () => { throw new Error('embedding down'); } }),
  });
  const degraded = await degradedService.search(contextA.scope, '历史架构关键词', 5);
  assert.equal(degraded.matches.some((match) => match.turnId === 'm6-primary'), true, 'query embedding 失败必须回退关键词结果');
  assert.equal(degraded.vectorUsed, false);
  memoryRepository.updateWorkspaceConfig(contextA.scope, { embeddingModelId: 'wk-m6-next-model' });
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE embedding IS NOT NULL OR index_state = 'ready'`).get().count, 0, '切换模型必须失效 L3 旧向量正文');
  memoryRepository.updateWorkspaceConfig(contextA.scope, { embeddingModelId: runtime.modelId });

  commit(repository, contextB.scope, 33, 'm6-other-principal', '跨主体机密', '不应泄露');
  const keywordOnlyService = new ConversationSearchService(owner, workspacePath);
  assert.equal((await keywordOnlyService.search(contextA.scope, '跨主体机密')).matches.length, 0, '跨 principal 搜索必须为零结果');

  const ownerlessSession = sessionId(34);
  repository.ensureSession(ownerlessSession, 'chat');
  repository.startTurn(ownerlessSession, { turnId: 'm6-ownerless', userText: '无归属旧轮次', scopeLabel: '无' });
  repository.finalizeTurn(ownerlessSession, 'm6-ownerless', answerResult('不得被当前主体认领'));
  database.prepare(`DELETE FROM conversation_search_documents WHERE turn_id = 'm6-other'`).run();
  owner.closeAll();
  owner = new QaMemoryDatabase();
  database = owner.getDatabase(workspacePath);
  const restartedService = new ConversationSearchService(owner, workspacePath);
  restartedService.start(contextA.scope);
  restartedService.stop();
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id = 'm6-other'`).get().count, 1, '重启扫描必须补回有归属的缺失档案');
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM conversation_search_documents WHERE turn_id = 'm6-ownerless'`).get().count, 0, '重启扫描不得认领无归属完成轮次');
  assert.equal(database.prepare(`SELECT principal_id FROM conversation_search_documents WHERE turn_id = 'm6-other-principal'`).get().principal_id, contextB.scope.principalId, '重启扫描不得改写其他主体归属');

  const replayRepository = new QaMemoryRepository(owner, workspacePath);
  const replay = projectQaRecentTurnsToHistoryMessages(replayRepository.loadRecentCompleteTurns(primarySession));
  const expiredTool = replay.find((message) => message.role === 'tool' && message.toolName === 'search_conversations');
  assert.equal(expiredTool?.content, QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE, '历史 search_conversations 观察默认必须过期而非重放');

  const tool = createSearchConversationsTool({ search: (query, limit) => restartedService.search(contextA.scope, query, limit, primarySession) });
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['limit', 'query'], '模型参数不得暴露 owner 或 currentSessionId');
  assert.equal((await tool.execute({}, undefined)).ok, false, 'query 必须是工具必填参数');
  assert.equal((await tool.execute({ query: 'x', limit: 9 }, undefined)).ok, false, '工具 limit 最大值必须是 8');
  const emptyTool = createSearchConversationsTool({ search: async () => ({ availability: { enabled: true }, matches: [], observation: '', vectorUsed: false }) });
  const emptyExecution = await emptyTool.execute({ query: '不存在' }, undefined);
  assert.equal(emptyExecution.ok, true);
  assert.equal(emptyExecution.referenceCount, 0);
  assert.match(emptyExecution.observation, /<past_conversations>/u);
  const unavailableTool = createSearchConversationsTool({ search: async () => ({ availability: { enabled: false, reason: 'scope-unavailable' }, matches: [], observation: '', vectorUsed: false }) });
  assert.equal((await unavailableTool.execute({ query: '任意' }, undefined)).ok, false, '不可用与零结果必须区分');

  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  verificationPassed = true;
  console.log('WeKnora WK-M6 conversation archive, hybrid search, and tool isolation verification passed');
} finally {
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

function createScope(MemoryScopeResolver, principalId) {
  return new MemoryScopeResolver({
    getActiveWorkspacePath: () => workspacePath,
    listRegisteredWorkspacePaths: () => [workspacePath],
    getPrincipalId: () => principalId,
  }).resolveActive();
}

function sessionId(index) {
  return `assistant-session-${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function commit(repository, scope, index, turnId, question, answer, explicitSessionId, completeness = 'complete') {
  const selectedSessionId = explicitSessionId ?? sessionId(index);
  repository.ensureSession(selectedSessionId, 'chat');
  repository.startTurn(selectedSessionId, { turnId, userText: question, scopeLabel: '本次使用：无', route: 'chat' });
  repository.finalizeTurn(selectedSessionId, turnId, answerResult(answer, { completeness }), { archiveScope: scope, route: 'chat' });
}

function answerResult(answer, extras = {}) {
  return {
    type: 'answer',
    answer,
    provider: 'openai-compatible',
    model: 'test-model',
    sourceNotes: [],
    retrievalMode: 'none',
    interactionRoute: 'chat',
    completeness: 'complete',
    cacheUsage: { providerReported: false },
    ...extras,
  };
}

function verifyV7Upgrade(QaMemoryDatabase) {
  const migrationWorkspace = path.join(stagingRoot, 'v7-workspace');
  let migrationOwner = new QaMemoryDatabase();
  const legacy = migrationOwner.getDatabase(migrationWorkspace);
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    DROP TRIGGER conversation_search_documents_ai;
    DROP TRIGGER conversation_search_documents_ad;
    DROP TRIGGER conversation_search_documents_au;
    DROP TABLE conversation_search_fts;
    DROP INDEX idx_conversation_search_scope_session_created;
    ALTER TABLE conversation_search_documents RENAME TO conversation_search_documents_v8;
    CREATE TABLE conversation_search_documents (
      doc_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL UNIQUE REFERENCES qa_turns(turn_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      search_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding_model_id TEXT,
      embedding_fingerprint TEXT,
      index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending', 'ready', 'failed', 'disabled')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id, principal_id)
        REFERENCES memory_subjects(workspace_id, principal_id) ON DELETE CASCADE
    );
    DROP TABLE conversation_search_documents_v8;
    PRAGMA user_version = 7;
  `);
  migrationOwner.closeAll();
  migrationOwner = new QaMemoryDatabase();
  const upgraded = migrationOwner.getDatabase(migrationWorkspace);
  const columns = new Set(upgraded.prepare('PRAGMA table_info(conversation_search_documents)').all().map((column) => column.name));
  assert.equal(upgraded.pragma('user_version', { simple: true }), 10, 'v7 数据库必须原位升级到 v10');
  assert.equal(columns.has('embedding_dimensions'), true);
  assert.equal(columns.has('embedding'), true);
  assert.equal(upgraded.pragma('quick_check', { simple: true }), 'ok');
  migrationOwner.closeAll();
}

function transpileTestModules(relativePaths) {
  transpileLocalModules(rootDir, compiledRoot, relativePaths);
}

function load(relativePath) {
  return import(`${pathToFileURL(modulePath(relativePath)).href}?cache=${Date.now()}`);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
