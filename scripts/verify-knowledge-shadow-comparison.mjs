import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-shadow-comparison');
const workspaceDir = path.join(outDir, 'workspace');
const sourceDir = path.join(outDir, 'sources');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });

// electron 打桩：依赖链（rerankAdapters → modelHub）仅在密钥读写时触碰
// safeStorage，mock store 下不会触发，这里给出安全缺省即可。
writeFileSync(
  path.join(outDir, 'electron-stub.cjs'),
  'module.exports = { safeStorage: { isEncryptionAvailable: () => false } };\n',
);

await build({
  stdin: {
    contents: `
      export { runKnowledgeAgentTurn, runKnowledgeShadowComparison, buildKnowledgeShadowTelemetry } from './electron/knowledge/knowledgeAgentTurn';
      export { shouldShadowKnowledgeAgent, normalizeAssistantKnowledgeAgentMode } from './electron/knowledge/assistantMode';
      export { defaultAppPreferences, getAppPreferences, saveAppPreferences } from './electron/appPreferences';
      export { ModelCallCoordinator } from './electron/knowledge/modelCallCoordinator';
      export { ModelCallBudgetGate } from './electron/knowledge/modelCallBudget';
      export { ensureMaterialsRoot, createMaterialsLibraryDirectory, importMaterialsDocuments, listMaterialsDocuments } from './electron/materialsLibrary';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: path.join(outDir, 'shadow.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { electron: path.join(outDir, 'electron-stub.cjs') },
});

const {
  runKnowledgeAgentTurn,
  runKnowledgeShadowComparison,
  buildKnowledgeShadowTelemetry,
  shouldShadowKnowledgeAgent,
  normalizeAssistantKnowledgeAgentMode,
  defaultAppPreferences,
  getAppPreferences,
  saveAppPreferences,
  ModelCallCoordinator,
  ModelCallBudgetGate,
  ensureMaterialsRoot,
  createMaterialsLibraryDirectory,
  importMaterialsDocuments,
  listMaterialsDocuments,
} = await import(pathToFileURL(path.join(outDir, 'shadow.cjs')).href);

// 1. 搭建一个真实资料库目录（含一个 md 文档）。
const root = ensureMaterialsRoot(workspaceDir);
const created = createMaterialsLibraryDirectory(root, 'shadow-lib', new Date(2026, 7, 28, 10, 0, 0));
const sourceFile = path.join(sourceDir, 'demo-note.md');
writeFileSync(sourceFile, '# 影子对比样例\n\n这是一份用于影子对比验证的样例文档。\n');
importMaterialsDocuments(created.path, [sourceFile]);
const documents = listMaterialsDocuments(created.path);
assert.ok(documents.length >= 1, '资料库应包含至少一个文档');

// 2. 模式判定（P3 默认开启：缺省/非法值归一化为 on）。
assert.equal(normalizeAssistantKnowledgeAgentMode('shadow'), 'shadow');
assert.equal(normalizeAssistantKnowledgeAgentMode('off'), 'off');
assert.equal(normalizeAssistantKnowledgeAgentMode('bogus'), 'on');
assert.equal(normalizeAssistantKnowledgeAgentMode(undefined), 'on');
assert.equal(shouldShadowKnowledgeAgent('shadow'), true);
assert.equal(shouldShadowKnowledgeAgent('on'), false);
assert.equal(shouldShadowKnowledgeAgent('off'), false);

// 2.1 P3 偏好默认值：新装/缺省走 on；已存的 shadow/off 原样保留。
{
  assert.equal(defaultAppPreferences.assistantKnowledgeAgentMode, 'on', 'P3 默认值应为 on');
  const emptyStore = createMockStore();
  assert.equal(getAppPreferences(emptyStore).assistantKnowledgeAgentMode, 'on', '缺省偏好应归一化为 on');
  const offStore = createMockStore();
  saveAppPreferences(offStore, { assistantKnowledgeAgentMode: 'off' });
  assert.equal(getAppPreferences(offStore).assistantKnowledgeAgentMode, 'off', '显式 off 应保留为降级开关');
  const shadowStore = createMockStore();
  saveAppPreferences(shadowStore, { assistantKnowledgeAgentMode: 'shadow' });
  assert.equal(getAppPreferences(shadowStore).assistantKnowledgeAgentMode, 'shadow');
}

// 3. 脚本化传输层：第一轮调用 get_document_info，第二轮直接终答。
function createScriptedTransport(script) {
  let index = 0;
  return {
    capability: 'native-tools',
    chat: async () => {
      assert.ok(index < script.length, '模型调用次数超出脚本预期');
      return script[index++];
    },
  };
}

const SCRIPTED_RESPONSES = () => [
  { content: '', toolCalls: [{ id: 'call-1', name: 'get_document_info', arguments: {} }] },
  { content: '资料库中共有 1 份文档。', toolCalls: [] },
];

function createMockStore() {
  const data = new Map();
  return {
    get: (key) => data.get(key),
    set: (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    delete: (key) => { data.delete(key); },
  };
}

function createCoordinator() {
  return new ModelCallCoordinator(new ModelCallBudgetGate({ maxModelCalls: 10 }), 32_000, 'react-turn', undefined, {
    providerKind: 'openai-compatible',
    model: 'mock-model',
  });
}

function createBaseInput() {
  return {
    event: {},
    request: { requestId: 'req-shadow-1', userText: '资料库里有多少文档？' },
    controller: new AbortController(),
    source: { libraryPath: created.path, label: 'shadow-lib' },
    model: 'mock-model',
    provider: 'openai-compatible',
    providerConfig: { kind: 'openai-compatible' },
    contextWindowTokens: 32_000,
    modelCallCoordinator: createCoordinator(),
    store: createMockStore(),
    prepareMaterialSearchContext: async (libraryPath) => ({ targetPath: libraryPath }),
    qaRecentTurns: [],
    qaSessionId: 'shadow-session',
    // 默认改写生效后保持脚本封闭：注入 mock 改写服务，避免真实网络调用。
    rewriteQuestion: async ({ question }) => ({ rewrite: question, shouldSplit: false, subQuestions: [question], model: 'mock-model', elapsedMs: 1 }),
  };
}

// 4. shadow 模式：静默不发事件，但完整产出结果投影与引擎指标。
{
  const events = [];
  const trace = [];
  const outcome = await runKnowledgeAgentTurn({
    ...createBaseInput(),
    mode: 'shadow',
    transport: createScriptedTransport(SCRIPTED_RESPONSES()),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => trace.push(entry),
  });
  assert.equal(events.length, 0, 'shadow 模式不得向渲染进程发布任何事件');
  assert.equal(outcome.fallbackRequested, false);
  assert.ok(outcome.result, 'shadow 模式仍需产出结果投影供遥测');
  assert.equal(outcome.result.answer, '资料库中共有 1 份文档。');
  assert.equal(outcome.result.completeness, 'not-found', '无引用答案应标记 not-found');
  assert.equal(outcome.metrics.toolCalls, 1, '引擎应记录 1 次工具调用');
  assert.equal(outcome.metrics.modelCalls, 2, '引擎应记录 2 次模型调用');
  assert.ok(outcome.metrics.rounds >= 1, '引擎应记录至少 1 轮 Think');
  assert.equal(outcome.metrics.stopReason, 'natural');
  assert.equal(outcome.metrics.evidenceParentChunks, 0, 'get_document_info 不登记证据');
  assert.equal(outcome.result.modelEvents?.length, 4, '两次模型调用应各保留 started/completed 公开事件');
  assert.equal(outcome.result.toolEvents?.find((event) => event.tool === 'knowledge_agent_doc_info')?.round, 1, '工具事件应关联发起它的模型轮次');
  assert.ok(trace.some((entry) => entry.stage === 'react'), 'shadow 模式仍落详细轨迹');
}

// 5. production 模式：事件正常下发（status / tool / delta）。
{
  const events = [];
  const outcome = await runKnowledgeAgentTurn({
    ...createBaseInput(),
    transport: createScriptedTransport(SCRIPTED_RESPONSES()),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: () => {},
  });
  assert.equal(outcome.fallbackRequested, false);
  assert.ok(events.some((event) => event.type === 'status'), 'production 模式应发布 status 事件');
  assert.ok(events.some((event) => event.type === 'tool'), 'production 模式应发布 tool 事件');
  assert.ok(events.some((event) => event.type === 'model' && event.event.state === 'completed'), 'production 模式应发布已脱敏的模型输出事件');
  assert.ok(events.some((event) => event.type === 'delta'), 'production 模式应发布 delta 事件');
}

// 6. 遥测构建器：ran / skipped 两条分支。
{
  const ranOutcome = await runKnowledgeAgentTurn({
    ...createBaseInput(),
    mode: 'shadow',
    transport: createScriptedTransport(SCRIPTED_RESPONSES()),
    emitTurnEvent: () => {},
    onDetailedTrace: () => {},
  });
  const ranTelemetry = buildKnowledgeShadowTelemetry(ranOutcome, 123);
  assert.equal(ranTelemetry.status, 'ran');
  assert.equal(ranTelemetry.elapsedMs, 123);
  assert.equal(ranTelemetry.toolCalls, 1);
  assert.equal(ranTelemetry.modelCalls, 2);
  assert.equal(ranTelemetry.evidenceParentChunks, 0);
  assert.equal(ranTelemetry.citedParentChunks, 0);
  assert.equal(ranTelemetry.completeness, 'not-found');

  const skippedTelemetry = buildKnowledgeShadowTelemetry({ result: undefined, fallbackRequested: true }, 10);
  assert.equal(skippedTelemetry.status, 'skipped');
  assert.equal(skippedTelemetry.skipReason, 'transport-unavailable');
}

// 7. runKnowledgeShadowComparison：Ollama（无传输层）收敛为 skipped。
{
  const trace = [];
  const telemetry = await runKnowledgeShadowComparison({
    ...createBaseInput(),
    provider: 'ollama',
    providerConfig: { kind: 'ollama' },
    onDetailedTrace: (entry) => trace.push(entry),
  });
  assert.equal(telemetry.status, 'skipped');
  assert.equal(telemetry.skipReason, 'transport-unavailable');
  assert.ok(telemetry.elapsedMs >= 0);
}

// 8. runKnowledgeShadowComparison：取消信号收敛为 cancelled，不抛出。
{
  const input = createBaseInput();
  input.controller.abort();
  const telemetry = await runKnowledgeShadowComparison({
    ...input,
    onDetailedTrace: () => {},
  });
  assert.equal(telemetry.status, 'skipped');
  assert.equal(telemetry.skipReason, 'cancelled');
}

// 9. runKnowledgeShadowComparison：资料库路径异常收敛为 failure，不抛出。
{
  const telemetry = await runKnowledgeShadowComparison({
    ...createBaseInput(),
    source: { libraryPath: path.join(outDir, 'not-a-library'), label: 'missing' },
    onDetailedTrace: () => {},
  });
  assert.equal(telemetry.status, 'failure');
  assert.ok(typeof telemetry.error === 'string' && telemetry.error.length > 0, 'failure 遥测应携带错误信息');
}

// 10. 取消回归：保留取消前已经下发的正文，不清空、不生成替代回答。
{
  const base = createBaseInput();
  const events = [];
  const cancellingTransport = {
    capability: 'native-tools',
    chat: async (_config, request) => {
      request.onDelta?.('已经生成的部分回答');
      base.controller.abort();
      const error = new Error('请求已取消');
      error.name = 'AbortError';
      throw error;
    },
  };
  await assert.rejects(
    runKnowledgeAgentTurn({
      ...base,
      transport: cancellingTransport,
      emitTurnEvent: (payload) => events.push(payload),
      onDetailedTrace: () => {},
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '已经生成的部分回答');
  assert.equal(events.some((event) => event.type === 'delta-reset'), false, '取消不得清空已经下发的正文');
}

// 11. 指代消解集成：有历史 + 代词问题时，改写结果随问题注入 ReAct 循环。
{
  const base = createBaseInput();
  base.qaRecentTurns = [{ userText: '项目经理是干啥的', answerHead: '项目经理负责研发体系管理与需求攻坚。' }];
  base.request = { requestId: 'req-rewrite-1', userText: '它主要能做啥？' };
  const events = [];
  const trace = [];
  let capturedQuestion = '';
  const capturingTransport = {
    capability: 'native-tools',
    chat: async (_config, { messages }) => {
      capturedQuestion = messages[messages.length - 1].content;
      return { content: '项目经理主要负责研发体系管理。', toolCalls: [] };
    },
  };
  let rewriteCalls = 0;
  const outcome = await runKnowledgeAgentTurn({
    ...base,
    transport: capturingTransport,
    rewriteQuestion: async ({ question }) => {
      rewriteCalls += 1;
      assert.equal(question, '它主要能做啥？');
      return { rewrite: '项目经理主要能做啥', shouldSplit: false, subQuestions: ['项目经理主要能做啥'], model: 'mock-model', elapsedMs: 1 };
    },
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => trace.push(entry),
  });
  assert.equal(rewriteCalls, 1, '改写门放行时应调用一次改写服务');
  assert.ok(capturedQuestion.includes('它主要能做啥？'), '问题应保留用户原文');
  assert.ok(capturedQuestion.includes('指代已解析') && capturedQuestion.includes('项目经理主要能做啥'), '改写结果应随问题注入');
  assert.ok(events.some((event) => event.type === 'tool' && event.event.tool === 'rewrite_question' && event.event.state === 'completed'), 'production 应发布改写完成事件');
  assert.ok(trace.some((entry) => entry.stage === 'rewrite' && entry.status === 'completed'), '改写应落详细轨迹');
  assert.equal(outcome.fallbackRequested, false);
}

// 12. 改写失败回退原文：不注入提示、发 rejected 事件、循环照常完成。
{
  const base = createBaseInput();
  base.qaRecentTurns = [{ userText: '项目经理是干啥的', answerHead: '项目经理负责研发体系管理。' }];
  base.request = { requestId: 'req-rewrite-2', userText: '它主要能做啥？' };
  const events = [];
  const trace = [];
  let capturedQuestion = '';
  const capturingTransport = {
    capability: 'native-tools',
    chat: async (_config, { messages }) => {
      capturedQuestion = messages[messages.length - 1].content;
      return { content: '回退原文后的回答。', toolCalls: [] };
    },
  };
  const outcome = await runKnowledgeAgentTurn({
    ...base,
    transport: capturingTransport,
    rewriteQuestion: async () => {
      throw new Error('改写服务不可用');
    },
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => trace.push(entry),
  });
  assert.ok(!capturedQuestion.includes('指代已解析'), '改写失败不得注入提示');
  assert.ok(events.some((event) => event.type === 'tool' && event.event.tool === 'rewrite_question' && event.event.state === 'rejected'), '改写失败应发 rejected 事件');
  assert.ok(trace.some((entry) => entry.stage === 'rewrite' && entry.status === 'rejected'));
  assert.equal(outcome.result.answer, '回退原文后的回答。');
}

// 13. shadow 模式静默：改写事件不下发，但提示仍注入。
{
  const base = createBaseInput();
  base.qaRecentTurns = [{ userText: '项目经理是干啥的', answerHead: '项目经理负责研发体系管理。' }];
  base.request = { requestId: 'req-rewrite-3', userText: '它主要能做啥？' };
  const events = [];
  let capturedQuestion = '';
  const capturingTransport = {
    capability: 'native-tools',
    chat: async (_config, { messages }) => {
      capturedQuestion = messages[messages.length - 1].content;
      return { content: '影子回答。', toolCalls: [] };
    },
  };
  await runKnowledgeAgentTurn({
    ...base,
    mode: 'shadow',
    transport: capturingTransport,
    rewriteQuestion: async () => ({ rewrite: '项目经理主要能做啥', shouldSplit: false, subQuestions: ['项目经理主要能做啥'], model: 'mock-model', elapsedMs: 1 }),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: () => {},
  });
  assert.equal(events.length, 0, 'shadow 模式改写事件也不得下发');
  assert.ok(capturedQuestion.includes('指代已解析'), 'shadow 模式仍应注入解析提示');
}

console.log('knowledge-shadow-comparison 验证通过：静默事件、引擎指标、遥测分支、影子执行器与取消保留正文全部符合契约。');
