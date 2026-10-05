import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// WK-M7 L1 工作记忆验证：50%/30% 固化、独立维护预算、降级与端到端接线。
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-context-consolidation');
const workspaceDir = path.join(outDir, 'workspace');
const sourceDir = path.join(outDir, 'sources');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });

writeFileSync(
  path.join(outDir, 'electron-stub.cjs'),
  'module.exports = { safeStorage: { isEncryptionAvailable: () => false } };\n',
);

await build({
  stdin: {
    contents: `
      export { runReActLoop, findConsolidationKeepBoundary, DEFAULT_REACT_BUDGET } from './electron/knowledge/reactAgent/reactEngine';
      export { runKnowledgeAgentTurn, runKnowledgeShadowComparison } from './electron/knowledge/knowledgeAgentTurn';
      export { resolveQaZoneBudget } from './electron/knowledge/qaMemoryAssembler';
      export { ModelCallCoordinator } from './electron/knowledge/modelCallCoordinator';
      export { ModelCallBudgetGate } from './electron/knowledge/modelCallBudget';
      export { ensureMaterialsRoot, createMaterialsLibraryDirectory, importMaterialsDocuments, listMaterialsDocuments } from './electron/materialsLibrary';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  outfile: path.join(outDir, 'consolidation.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { electron: path.join(outDir, 'electron-stub.cjs') },
});

const {
  runReActLoop,
  findConsolidationKeepBoundary,
  DEFAULT_REACT_BUDGET,
  runKnowledgeAgentTurn,
  runKnowledgeShadowComparison,
  resolveQaZoneBudget,
  ModelCallCoordinator,
  ModelCallBudgetGate,
  ensureMaterialsRoot,
  createMaterialsLibraryDirectory,
  importMaterialsDocuments,
  listMaterialsDocuments,
} = await import(pathToFileURL(path.join(outDir, 'consolidation.cjs')).href);

let checks = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  checks += 1;
};

// ── 1. 固化参数：摘要输出严格固定 2000 ────────────────────────────────
{
  const large = resolveQaZoneBudget('knowledge-base', 128_000);
  // P = 128000 − 8192 − 5120 = 114688；2.5% = 2867 > 绝对上限 2000 → 取上限。
  assert.equal(large.consolidationSummary, 2_000, '128K 窗口应命中绝对上限 2000');
  const mid = resolveQaZoneBudget('knowledge-base', 32_000);
  // P = 32000 − 4000 − 2048 = 25952；2.5% = 648（低于上限，比例值生效）。
  assert.equal(mid.consolidationSummary, Math.floor(25_952 * 0.025), '32K 窗口应取比例值');
  const small = resolveQaZoneBudget('knowledge-base', 4_096);
  // P = 4096 − 512 − 2048 = 1536；2.5% = 38，小窗口自动收缩。
  assert.equal(small.consolidationSummary, Math.floor(1_536 * 0.025), '4K 小窗口应自动收缩固化预算');
  assert.equal(resolveQaZoneBudget('chat', 128_000).consolidationSummary, 0, '非知识库剖面固化预算应为 0');
  ok(DEFAULT_REACT_BUDGET.contextConsolidationThreshold === 0.5, '默认触发比例应对齐 WeKnora 0.5');
  ok(DEFAULT_REACT_BUDGET.contextConsolidationMaxTokens === 2_000, '默认摘要输出上限应为 2000');
}

// ── 2. 保留边界：工具对不可拆 + 最新单元无条件保留 ────────────────────────
const msg = (role, content, extra = {}) => ({ role, content, ...extra });
{
  // CJK 按 1 字符 = 1 token 估算，预算数值可精确构造。
  const withTrailingAnswer = [
    msg('user', '首'),
    msg('assistant', '答1'),
    msg('assistant', '调', { toolCalls: [{ id: 'x1', name: 'knowledge_search', arguments: {} }] }),
    msg('tool', '结1', { toolCallId: 'x1', toolName: 'knowledge_search' }),
    msg('tool', '结2', { toolCallId: 'x2', toolName: 'knowledge_search' }),
    msg('assistant', '末'),
  ];
  ok(findConsolidationKeepBoundary(withTrailingAnswer, 0).keepCount === 0, '零预算不得越过 30% 回填目标强留消息');
  ok(findConsolidationKeepBoundary(withTrailingAnswer, Number.MAX_SAFE_INTEGER).keepCount === 6, '预算充足时全部保留');
  const boundaries = Array.from({ length: 200 }, (_, budget) => findConsolidationKeepBoundary(withTrailingAnswer, budget).keepCount);
  ok(boundaries.includes(4), '存在预算可容纳最新单元与完整工具组');
  ok(!boundaries.includes(2) && !boundaries.includes(3), '任何预算都不得只保留工具调用组的一部分');

  const trailingToolGroup = [
    msg('user', '首'),
    msg('assistant', '调', { toolCalls: [{ id: 'x1', name: 'knowledge_search', arguments: {} }] }),
    msg('tool', '结1', { toolCallId: 'x1', toolName: 'knowledge_search' }),
    msg('tool', '结2', { toolCallId: 'x2', toolName: 'knowledge_search' }),
  ];
  ok(findConsolidationKeepBoundary(trailingToolGroup, 0).keepCount === 0, '工具组预算不足时整体进入摘要，不拆对');
}

// ── 引擎级测试脚手架 ──────────────────────────────────────────────────────
const emptyRegistry = {
  register() {},
  get: () => undefined,
  names: () => [],
  schemas: () => [],
  validate: () => undefined,
};
const dummyConfig = { kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' };
const isConsolidationCall = (req) => req.tools.length === 0 && req.messages[0].content.includes('对话历史压缩器');
const LONG_HISTORY = [
  msg('user', `首轮问题：${'甲'.repeat(1_500)}`),
  msg('assistant', `首轮回答：${'乙'.repeat(1_500)}`),
  msg('user', `次轮问题：${'丙'.repeat(1_500)}`),
];
const runEngine = async ({ transport, onModelCall, signal, traces }) => runReActLoop({
  systemPrompt: `SYS${'S'.repeat(297)}`,
  history: LONG_HISTORY,
  question: '什么是谐波？',
  model: 'm',
  config: dummyConfig,
  transport,
  registry: emptyRegistry,
  toolContext: {},
  contextWindowTokens: 4_096,
  signal: signal ?? new AbortController().signal,
  ...(onModelCall ? { onModelCall } : {}),
  ...(traces ? { onTrace: (entry) => traces.push(entry) } : {}),
  collectCitations: () => [],
});

// ── 3. 触发与替换：超阈值 → 摘要调用 → 旧消息被摘要消息替换 ────────────────
{
  const calls = [];
  const traces = [];
  const result = await runEngine({
    traces,
    transport: {
      capability: 'native-tools',
      chat: async (_config, req) => {
        calls.push(req);
        if (isConsolidationCall(req)) return { content: '早期两轮问答已压缩。', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
        return { content: '最终答案。', toolCalls: [] };
      },
    },
  });
  ok(calls.length === 2, '固化应新增一次摘要调用');
  ok(calls[0].temperature === 0.3, '摘要调用应使用低温度 0.3');
  ok(calls[0].maxOutputTokens === 2_000, '缺省剖面时摘要输出取绝对上限 2000');
  ok(calls[0].messages[1].content.includes(LONG_HISTORY[0].content.slice(0, 50)), '摘要转录应包含被固化的旧消息');
  ok(calls[0].messages[1].content.includes(LONG_HISTORY[2].content.slice(0, 50)), '30% 回填目标不足时全部旧历史应进入摘要转录');
  const thinkMessages = calls[1].messages;
  ok(thinkMessages[0].content.startsWith('SYS'), 'system prompt 应保持首位');
  ok(thinkMessages[1].role === 'system' && thinkMessages[1].content.startsWith('[Memory Summary - 3 earlier messages consolidated]'), '固化产物应使用严格 Memory Summary 标记');
  ok(thinkMessages[1].content.includes('早期两轮问答已压缩。'), '摘要消息应携带模型摘要文本');
  ok(thinkMessages[thinkMessages.length - 1].content === '什么是谐波？', '本轮问题必须完整保尾');
  ok(result.stopReason === 'natural' && result.consolidations === 1 && result.modelCalls === 1, '摘要不得占用业务模型调用数');
  ok(result.maintenanceModelCalls === 1, '成功摘要应单独记录一次维护模型调用');
  ok(result.usage?.totalTokens === 8, '摘要调用用量应并入总用量');
  const consolidateTrace = traces.find((entry) => entry.action === 'consolidate' && entry.status === 'completed');
  ok(consolidateTrace?.detail?.mode === 'llm' && consolidateTrace?.detail?.consolidatedCount === 3 && consolidateTrace?.detail?.keptCount === 0, '固化轨迹应记录模式与数量');
}

// ── 4. 摘要调用失败 → 原文归档降级，回答照常 ───────────────────────────────
{
  const calls = [];
  const traces = [];
  const result = await runEngine({
    traces,
    transport: {
      capability: 'native-tools',
      chat: async (_config, req) => {
        calls.push(req);
        if (isConsolidationCall(req)) throw new Error('模拟摘要失败');
        return { content: '降级后的最终答案。', toolCalls: [] };
      },
    },
  });
  ok(result.stopReason === 'natural' && result.consolidations === 1, '摘要失败不应阻断回答');
  const consolidateTrace = traces.find((entry) => entry.action === 'consolidate' && entry.status === 'completed');
  ok(consolidateTrace?.detail?.mode === 'raw-archive', '失败应降级为原文归档模式');
  ok(calls[3].messages[1].content.includes(LONG_HISTORY[0].content.slice(0, 500)), '三次摘要失败后原文归档应携带被固化消息的截断原文');
  ok(result.maintenanceModelCalls === 3, '失败摘要最多只允许三次维护尝试');
}

// ── 5. 摘要维护调用不经过业务调用预算门 ──────────────────────────────────
{
  const calls = [];
  const traces = [];
  let modelCallIndex = 0;
  const result = await runEngine({
    traces,
    onModelCall: () => {
      modelCallIndex += 1;
      return { ready: true };
    },
    transport: {
      capability: 'native-tools',
      chat: async (_config, req) => {
        calls.push(req);
        return { content: '熔断降级后的答案。', toolCalls: [] };
      },
    },
  });
  ok(calls.length === 2, '摘要维护调用与最终业务调用都应发送');
  ok(modelCallIndex === 1, '业务调用预算门只应看见最终 Think，不应看见摘要');
  ok(result.modelCalls === 1 && result.maintenanceModelCalls === 1 && result.consolidations === 1, '业务与维护调用必须分别计数');
  const consolidateTrace = traces.find((entry) => entry.action === 'consolidate' && entry.status === 'completed');
  ok(consolidateTrace?.detail?.mode === 'llm', '独立维护预算应正常生成摘要');
}

// ── 6. 固化期间被取消 → 直接终止，不生成替代回答 ──────────────────────────
{
  const controller = new AbortController();
  const traces = [];
  await assert.rejects(
    runEngine({
      traces,
      signal: controller.signal,
      transport: {
        capability: 'native-tools',
        chat: async (_config, req) => {
          if (isConsolidationCall(req)) {
            controller.abort();
            throw new Error('请求被取消');
          }
          return { content: '不应到达。', toolCalls: [] };
        },
      },
    }),
    (error) => error?.name === 'AbortError',
    '固化期间取消应直接终止，不得生成兜底回答',
  );
  ok(traces.some((entry) => entry.action === 'consolidate' && entry.status === 'failed'), '取消应落固化失败轨迹');
}

// ── 7. 未提供窗口 → 永不触发 ──────────────────────────────────────────────
{
  const calls = [];
  const result = await runReActLoop({
    systemPrompt: 'SYS',
    history: LONG_HISTORY,
    question: '什么是谐波？',
    model: 'm',
    config: dummyConfig,
    transport: {
      capability: 'native-tools',
      chat: async (_config, req) => {
        calls.push(req);
        return { content: '直接作答。', toolCalls: [] };
      },
    },
    registry: emptyRegistry,
    toolContext: {},
    signal: new AbortController().signal,
    collectCitations: () => [],
  });
  ok(calls.length === 1 && result.consolidations === 0, '无窗口参数时不得触发固化');
}

// ── 端到端：runKnowledgeAgentTurn 接线（生产 + 影子） ─────────────────────
const root = ensureMaterialsRoot(workspaceDir);
const created = createMaterialsLibraryDirectory(root, 'consolidation-lib', new Date(2026, 7, 28, 10, 0, 0));
const sourceFile = path.join(sourceDir, 'demo-note.md');
writeFileSync(sourceFile, '# 固化样例\n\n这是一份用于轮内固化验证的样例文档。\n');
importMaterialsDocuments(created.path, [sourceFile]);
const documents = listMaterialsDocuments(created.path);

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

const LONG_TURNS = [1, 2, 3].map((seq) => ({
  turnSeq: seq,
  userText: `第${seq}轮问题：${'问'.repeat(1_000)}`,
  answerHead: `第${seq}轮回答：${'答'.repeat(1_500)}`,
}));

function createBaseInput() {
  return {
    event: {},
    request: { requestId: 'req-consolidation-1', userText: '继续讨论刚才的主题' },
    controller: new AbortController(),
    source: { libraryPath: created.path, label: 'consolidation-lib' },
    model: 'mock-model',
    provider: 'openai-compatible',
    providerConfig: { baseUrl: 'http://mock.local', apiKey: 'mock-key' },
    contextWindowTokens: 4_096,
    modelCallCoordinator: createCoordinator(),
    store: createMockStore(),
    emitTurnEvent: () => {},
    prepareMaterialSearchContext: async () => ({
      libraryPath: created.path,
      documents,
      hybridSearch: async () => ({ entries: [], timings: {} }),
      lexicalSearch: async () => ({ entries: [], timings: {} }),
      parentChunkById: new Map(),
      rerank: undefined,
    }),
    qaRecentTurns: LONG_TURNS,
    qaSessionId: 'sess-consolidation-1',
    rewriteQuestion: async () => ({ rewrite: undefined, shouldSplit: false, subQuestions: [], elapsedMs: 1 }),
  };
}

const createE2eTransport = (calls) => ({
  capability: 'native-tools',
  chat: async (_config, req) => {
    calls.push(req);
    if (isConsolidationCall(req)) return { content: '会话早期讨论了主题甲与主题乙。', toolCalls: [] };
    return { content: '基于先前讨论，答案是主题甲。', toolCalls: [] };
  },
});

// 8. 生产模式：4K 窗口仍使用固定 2000 摘要输出，指标与轨迹落痕。
{
  const calls = [];
  const traces = [];
  const input = {
    ...createBaseInput(),
    onDetailedTrace: (entry) => traces.push(entry),
    transport: createE2eTransport(calls),
  };
  const outcome = await runKnowledgeAgentTurn(input);
  ok(outcome.result?.answer.includes('主题甲'), '生产模式应产出回答');
  ok(calls.length === 2 && isConsolidationCall(calls[0]), '长历史应触发一次固化');
  ok(calls[0].maxOutputTokens === 2_000, '固化摘要输出预算应严格固定为 2000');
  ok(outcome.metrics?.consolidations === 1, '指标应记录固化次数');
  const consolidateTrace = traces.find((entry) => entry.stage === 'react' && entry.action === 'consolidate' && entry.status === 'completed');
  ok(consolidateTrace?.output?.mode === 'llm' && consolidateTrace?.output?.consolidatedCount >= 2, '端到端应落固化轨迹');
}

// 9. 影子模式：遥测透传固化次数，且静默不发事件。
{
  const calls = [];
  const events = [];
  const traces = [];
  const input = {
    ...createBaseInput(),
    emitTurnEvent: (payload) => events.push(payload),
    onDetailedTrace: (entry) => traces.push(entry),
    transport: createE2eTransport(calls),
  };
  const telemetry = await runKnowledgeShadowComparison(input);
  ok(telemetry.status === 'ran', '影子链路应正常跑完');
  ok(telemetry.consolidations === 1, '影子遥测应透传固化次数');
  ok(events.length === 0, '影子模式不得向渲染进程发事件');
}

console.log(`knowledge-context-consolidation 验证通过：${checks} 项断言（固定参数、原子边界、独立维护预算、失败降级、取消终止、端到端与影子遥测）。`);
