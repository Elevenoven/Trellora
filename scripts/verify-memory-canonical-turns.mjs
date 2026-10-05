import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const rootDir = process.cwd();
const stagingRoot = path.join(rootDir, '.package-staging', `memory-canonical-turns-${process.pid}-${Date.now()}`);
const workspaceDir = path.join(stagingRoot, 'workspace');
const compiledRoot = path.join(stagingRoot, 'compiled');
const modulePath = (relativePath) => path.join(compiledRoot, relativePath.replace(/\.ts$/u, '.js'));
let owner;
let verificationPassed = false;

assertTemporaryPath(stagingRoot);
try {
  mkdirSync(workspaceDir, { recursive: true });
  transpileTestModules([
    'electron/knowledge/assistantSessionScope.ts',
    'electron/knowledge/tokenEstimator.ts',
    'electron/knowledge/qaMemoryTypes.ts',
    'electron/knowledge/structuredOutputContract.ts',
    'electron/knowledge/qaConversationCheckpoint.ts',
    'electron/knowledge/qaMemoryDatabase.ts',
    'electron/knowledge/qaCanonicalHistory.ts',
    'electron/knowledge/memory/memoryConstants.ts',
    'electron/knowledge/memory/memoryText.ts',
    'electron/knowledge/memory/memoryTypes.ts',
    'electron/knowledge/memory/memoryScope.ts',
    'electron/knowledge/memory/memoryConfig.ts',
    'electron/knowledge/memory/memoryRepository.ts',
    'electron/knowledge/memory/conversationArchiveContract.ts',
    'electron/knowledge/qaMemoryRepository.ts',
  ]);

  const { QaMemoryDatabase } = await load('electron/knowledge/qaMemoryDatabase.ts');
  const { QaMemoryRepository } = await load('electron/knowledge/qaMemoryRepository.ts');
  const {
    QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE,
    calculateQaHistoryMessageOverfetch,
    projectQaRecentTurnsToConversation,
    projectQaRecentTurnsToHistoryMessages,
    mergeQaRecentCompleteConversations,
    selectQaRecentCompleteConversation,
    stripInlineThinkBlocks,
    validateQaAgentMessageInputs,
  } = await load('electron/knowledge/qaCanonicalHistory.ts');

  assert.equal(calculateQaHistoryMessageOverfetch(5), 50);
  assert.equal(calculateQaHistoryMessageOverfetch(20), 80);
  assert.equal(stripInlineThinkBlocks('甲<think>隐藏一</think>乙<think>隐藏二</think>丙'), '甲乙丙');
  const sessionOnlyHistory = selectQaRecentCompleteConversation([
    { role: 'assistant', content: '无归属回答' },
    ...Array.from({ length: 7 }, (_, index) => [
      { role: 'user', content: `会话问题${index + 1}` },
      { role: 'assistant', content: `会话回答${index + 1}` },
    ]).flat(),
    { role: 'user', content: '未完成问题' },
  ]);
  assert.deepEqual(sessionOnlyHistory.map((message) => message.content), [
    '会话问题3', '会话回答3', '会话问题4', '会话回答4', '会话问题5',
    '会话回答5', '会话问题6', '会话回答6', '会话问题7', '会话回答7',
  ]);
  assert.deepEqual(
    mergeQaRecentCompleteConversations([
      [{ role: 'user', content: '重复问题' }, { role: 'assistant', content: '重复回答' }],
      [{ role: 'user', content: '重复问题' }, { role: 'assistant', content: '重复回答' }],
    ]),
    [{ role: 'user', content: '重复问题' }, { role: 'assistant', content: '重复回答' }],
  );

  owner = new QaMemoryDatabase();
  const repository = new QaMemoryRepository(owner, workspaceDir);
  const database = owner.getDatabase(workspaceDir);
  const sessionId = 'assistant-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  repository.ensureSession(sessionId, 'chat');

  const longAnswer = `完整回答-${'长'.repeat(70_000)}-结束`;
  const longQuestion = `完整问题-${'问'.repeat(70_000)}-结束`;
  repository.startTurn(sessionId, {
    turnId: 'turn-1',
    userText: longQuestion,
    scopeLabel: '本次使用：无',
    route: 'chat',
  });
  repository.finalizeTurn(sessionId, 'turn-1', answerResult(`<think>不应落库</think>${longAnswer}`, {
    retrievalWarning: '元'.repeat(1_600_100),
  }));
  const storedLong = database.prepare(`
    SELECT user_text, assistant_text, result_json FROM qa_turns WHERE turn_id = 'turn-1'
  `).get();
  assert.equal(storedLong.user_text, longQuestion, '用户原文不得按旧应用层上限截断');
  assert.equal(storedLong.assistant_text, longAnswer, '最终回答不得按旧 60K 上限截断');
  assert.equal(JSON.parse(storedLong.result_json).retrievalWarning.length, 1_600_100, '结构化结果不得按旧 1.5 MiB 上限截断');
  assert.equal(storedLong.result_json.includes('完整回答-'), false, 'result_json 不得复制最终回答');

  for (let index = 2; index <= 7; index += 1) {
    repository.startTurn(sessionId, {
      turnId: `turn-${index}`,
      userText: `问题${index}`,
      scopeLabel: '本次使用：无',
      route: index % 2 === 0 ? 'chat' : 'knowledge-base',
    });
    repository.finalizeTurn(sessionId, `turn-${index}`, answerResult(`回答${index}`));
    if (index === 3) {
      repository.startTurn(sessionId, {
        turnId: 'turn-error',
        userText: '失败问题',
        scopeLabel: '本次使用：无',
      });
      repository.finishAbortedTurn(sessionId, 'turn-error', 'error');
    }
    if (index === 5) {
      repository.startTurn(sessionId, {
        turnId: 'turn-cancelled',
        userText: '取消问题',
        scopeLabel: '本次使用：无',
      });
      repository.finishAbortedTurn(sessionId, 'turn-cancelled', 'cancelled', '已经生成的部分回答');
    }
  }

  repository.startTurn(sessionId, {
    turnId: 'turn-8',
    userText: '问题8',
    scopeLabel: '本次使用：知识库',
    route: 'knowledge-base',
    attachments: [
      {
        kind: 'image',
        attachmentId: 'image-1',
        name: '截图.png',
        mimeType: 'image/png',
        sizeBytes: 123,
        dataUrl: 'data:image/png;base64,SHOULD_NOT_PERSIST',
      },
      {
        kind: 'document',
        attachmentId: 'document-1',
        name: '说明.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 456,
        path: 'E:\\private\\SHOULD_NOT_PERSIST.pdf',
      },
    ],
  });
  repository.finalizeTurn(sessionId, 'turn-8', answerResult('<think>最终隐藏思考</think>回答8'), {
    route: 'knowledge-base',
    agentMessages: [
      {
        role: 'assistant',
        content: '先检索',
        reasoningContent: '工具调用推理',
        toolCalls: [{ callId: 'call-8', toolName: 'knowledge_search', arguments: { query: '问题8' } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-8',
        toolName: 'knowledge_search',
        content: 'SECRET_RETRIEVAL_RESULT',
      },
      {
        role: 'assistant',
        toolCalls: [{ callId: 'pseudo-final-8', toolName: 'final_answer', arguments: { answer: '伪终答' } }],
      },
      {
        role: 'tool',
        toolCallId: 'pseudo-final-8',
        toolName: 'final_answer',
        content: 'PSEUDO_FINAL_RESULT',
      },
    ],
    finalReasoningContent: '最终 reasoning_content',
  });

  const recent = repository.loadRecentCompleteTurns(sessionId);
  assert.deepEqual(recent.map((turn) => turn.userText), ['问题4', '问题5', '问题6', '问题7', '问题8']);
  const cancelledTurn = repository.getSession(sessionId).turns.find((turn) => turn.turnId === 'turn-cancelled');
  assert.equal(cancelledTurn?.status, 'cancelled');
  assert.equal(cancelledTurn?.assistantText, '已经生成的部分回答', '取消轮应保留已生成正文');
  assert.equal(recent.some((turn) => turn.turnId === 'turn-cancelled'), false, '取消轮不得进入后续对话热窗');
  assert.equal(recent.every((turn) => turn.finishedAt && turn.assistantText), true);
  assert.equal(recent.at(-1).assistantText, '回答8');
  database.prepare(`
    UPDATE qa_turns
    SET result_metadata_json = json_set(result_metadata_json, '$.route', 'chat-direct')
    WHERE turn_id = 'turn-7'
  `).run();
  assert.equal(
    repository.loadRecentCompleteTurns(sessionId).find((turn) => turn.turnId === 'turn-7').metadata.route,
    'chat',
    '旧版或无效 route 必须回退到四种 canonical route 之一',
  );
  assert.deepEqual(recent.at(-1).metadata.attachments, [
    { attachmentId: 'image-1', kind: 'image', name: '截图.png', mimeType: 'image/png', sizeBytes: 123 },
    { attachmentId: 'document-1', kind: 'document', name: '说明.pdf', mimeType: 'application/pdf', sizeBytes: 456 },
  ]);
  const rawTurn8 = JSON.stringify(database.prepare(`SELECT * FROM qa_turns WHERE turn_id = 'turn-8'`).get());
  assert.equal(rawTurn8.includes('SHOULD_NOT_PERSIST'), false, '附件字节与本地路径不得落入轮次表');

  const projected = projectQaRecentTurnsToHistoryMessages(recent);
  const directHistory = projectQaRecentTurnsToConversation(recent);
  assert.equal(directHistory.length, 10);
  for (const [index, turn] of recent.entries()) {
    assert.equal(directHistory[index * 2].content.startsWith(turn.userText), true);
    assert.equal(directHistory[index * 2 + 1].content, turn.assistantText);
  }
  const turn8Start = projected.findIndex((message) => message.role === 'user' && message.content.startsWith('问题8'));
  assert.deepEqual(projected.slice(turn8Start).map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(projected[turn8Start].content.includes('截图.png'), true);
  assert.equal(projected[turn8Start].content.includes('说明.pdf'), true);
  assert.equal(projected[turn8Start + 2].content, QA_RETRIEVAL_HISTORY_EXPIRED_MESSAGE);
  assert.equal(projected[turn8Start + 3].reasoningContent, '最终 reasoning_content');
  assert.equal(projected.some((message) => message.content === 'PSEUDO_FINAL_RESULT'), false);
  const retained = projectQaRecentTurnsToHistoryMessages(recent, { retainRetrievalHistory: true });
  assert.equal(retained.some((message) => message.content === 'SECRET_RETRIEVAL_RESULT'), true);
  database.prepare(`UPDATE qa_agent_tool_calls SET arguments_json = '[]' WHERE call_id = 'call-8'`).run();
  assert.deepEqual(
    repository.loadRecentCompleteTurns(sessionId).map((turn) => turn.userText),
    ['问题3', '问题4', '问题5', '问题6', '问题7'],
    '损坏的 Agent steps 只应排除所属轮次，不能让其他完整轮次丢失',
  );
  database.prepare(`
    UPDATE qa_agent_tool_calls SET arguments_json = '{"query":"问题8"}' WHERE call_id = 'call-8'
  `).run();

  const retryRequestId = 'logical-retry-request';
  repository.startTurn(sessionId, {
    turnId: 'retry-1',
    requestId: retryRequestId,
    userText: '重试问题',
    scopeLabel: '本次使用：无',
  });
  repository.finalizeTurn(sessionId, 'retry-1', answerResult('旧成功回答'));
  repository.startTurn(sessionId, {
    turnId: 'retry-2',
    requestId: retryRequestId,
    userText: '重试问题',
    scopeLabel: '本次使用：无',
  });
  assert.equal(currentCompletedAttempt(database, sessionId, retryRequestId).turn_id, 'retry-1', 'pending 重试不得替换旧成功轮');
  repository.finishAbortedTurn(sessionId, 'retry-2', 'error');
  assert.equal(currentCompletedAttempt(database, sessionId, retryRequestId).turn_id, 'retry-1', '失败重试不得替换旧成功轮');

  repository.startTurn(sessionId, {
    turnId: 'retry-3',
    requestId: retryRequestId,
    userText: '重试问题',
    scopeLabel: '本次使用：无',
  });
  assert.throws(() => repository.finalizeTurn(sessionId, 'retry-3', answerResult('非法步骤不得完成'), {
    agentMessages: [{
      role: 'assistant',
      toolCalls: [{ callId: 'orphan-call', toolName: 'knowledge_search', arguments: { query: 'x' } }],
    }],
  }), /缺少对应结果/u);
  assert.equal(database.prepare(`SELECT status FROM qa_turns WHERE turn_id = 'retry-3'`).get().status, 'pending');
  assert.equal(currentCompletedAttempt(database, sessionId, retryRequestId).turn_id, 'retry-1');
  repository.finishAbortedTurn(sessionId, 'retry-3', 'error');

  repository.startTurn(sessionId, {
    turnId: 'retry-4',
    requestId: retryRequestId,
    userText: '重试问题',
    scopeLabel: '本次使用：无',
  });
  repository.finalizeTurn(sessionId, 'retry-4', answerResult('新成功回答'));
  assert.equal(currentCompletedAttempt(database, sessionId, retryRequestId).turn_id, 'retry-4');
  assert.equal(database.prepare(`SELECT replaced_by_turn_id FROM qa_turns WHERE turn_id = 'retry-1'`).get().replaced_by_turn_id, 'retry-4');

  assert.throws(() => validateQaAgentMessageInputs([
    { role: 'tool', toolCallId: 'foreign-call', toolName: 'knowledge_search', content: '越界结果' },
  ]), /未按 call_seq/u);
  assert.equal(database.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  verifyProductionRouteWiring();

  verificationPassed = true;
  console.log('WK-M2 canonical turn storage, retry, and replay verification passed');
} finally {
  owner?.closeAll();
  assertTemporaryPath(stagingRoot);
  rmSync(stagingRoot, { recursive: true, force: true });
}

if (verificationPassed) process.exit(0);

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

function currentCompletedAttempt(database, sessionId, requestId) {
  return database.prepare(`
    SELECT turn_id, attempt_no FROM qa_turns
    WHERE session_id = ? AND request_id = ?
      AND status IN ('complete', 'partial', 'not-found')
      AND replaced_by_turn_id IS NULL
  `).get(sessionId, requestId);
}

function verifyProductionRouteWiring() {
  const mainSource = readFileSync(path.join(rootDir, 'electron', 'main.ts'), 'utf8');
  for (const route of [
    'chat',
    'knowledge-base',
    'current-note-direct',
    'current-note-react',
  ]) {
    assert.match(mainSource, new RegExp(`['"]${route}['"]`, 'u'), `生产入口未接入 ${route}`);
  }
  assert.match(mainSource, /qaHistoryMessages: qaPreparation\.recentHistoryMessages/u);
  assert.match(mainSource, /qaHistoryMessages: qaChatPreparation\?\.recentHistoryMessages/u);
  assert.match(mainSource, /selectQaRecentCompleteConversation\(request\.conversation\)/u);
  assert.match(mainSource, /loadRecentCompleteTurns\(sessionId\)/u);
  assert.match(mainSource, /loadRecentCompleteTurns\(sessionScope\.sessionId\)/u);
  assert.equal(
    mainSource.match(/generationConversation = projectQaRecentTurnsToConversation\(\s*(?:getQaMemoryOrchestrator\(\)\.repository|qaOrchestrator\.repository)\.loadRecentCompleteTurns\(sessionScope\.sessionId\)/gu)?.length,
    2,
    'current-note Direct 的普通分支和附件/额外上下文分支均从仍在写入的统一库读取完整历史',
  );
  const currentNoteReact = mainSource.slice(mainSource.indexOf('if (useCurrentNoteAgent && currentNoteSnapshot)'), mainSource.indexOf("let generationConversation = selectQaRecentCompleteConversation"));
  assert.match(currentNoteReact, /conversation = projectQaRecentTurnsToConversation\(qaOrchestrator\.repository\.loadRecentCompleteTurns\(sessionId\)\)/u);
  assert.doesNotMatch(currentNoteReact, /scopedMemoryRepository\.loadContext/u, '默认 observe 不得回读已停止写入的旧 turn 表');
  assert.doesNotMatch(mainSource, /mergeQaRecentCompleteConversations\(\[legacyConversation, canonicalConversation\]\)/u, 'WK-M9 后禁止双历史合并投影');
}

function transpileTestModules(relativePaths) {
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const outputPath = modulePath(relativePath);
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

function load(relativePath) {
  return import(pathToFileURL(modulePath(relativePath)).href);
}

function assertTemporaryPath(target) {
  const base = `${path.resolve(rootDir, '.package-staging')}${path.sep}`.toLocaleLowerCase('en-US');
  const resolved = path.resolve(target).toLocaleLowerCase('en-US');
  if (!resolved.startsWith(base)) throw new Error(`临时目录越界：${target}`);
}
