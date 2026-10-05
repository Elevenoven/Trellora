import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 打包被测模块（引擎会自动拉入 toolRegistry / toolResultBudget）。
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-knowledge-react-agent');
await build({
  entryPoints: [
    path.join(rootDir, 'electron', 'knowledge', 'reactAgent', 'reactEngine.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'knowledgeSessionState.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentPrompt.ts'),
  ],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { runReActLoop, DEFAULT_REACT_BUDGET, DEFAULT_REACT_TERMINAL_POLICY } = await import(pathToFileURL(path.join(outDir, 'reactAgent', 'reactEngine.js')).href);
const { KnowledgeAgentSessionState } = await import(pathToFileURL(path.join(outDir, 'knowledgeTools', 'knowledgeSessionState.js')).href);
const { buildKnowledgeAgentSystemPrompt, buildKnowledgeRuntimeContext } = await import(pathToFileURL(path.join(outDir, 'knowledgeAgentPrompt.js')).href);

let checks = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  checks += 1;
};
const equal = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  checks += 1;
};

equal(DEFAULT_REACT_BUDGET, {
  maxIterations: 6,
  maxModelCalls: 8,
  maxToolCalls: 10,
  maxEmptyRetries: 1,
  maxRepeatedContentRounds: 2,
  maxSingleObservationChars: 12_000,
  maxTotalObservationTokens: 20_000,
  contextConsolidationThreshold: 0.5,
  contextConsolidationMaxTokens: 2_000,
  contextConsolidationTargetRatio: 0.6,
  contextConsolidationSummaryReserveTokens: 500,
  contextConsolidationMaxAttempts: 3,
  contextConsolidationTimeoutMs: 60_000,
  contextConsolidationMessageCodePoints: 2_000,
  contextConsolidationToolCodePoints: 1_000,
  contextConsolidationFallbackCodePoints: 500,
  contextAtomicTrimThreshold: 0.8,
}, '知识库 ReAct 默认预算必须逐项保持稳定');

equal(DEFAULT_REACT_TERMINAL_POLICY, {
  synthesisInstruction: '证据收集到此为止。请仅基于上方工具返回的证据，直接给出带引用号 [n] 的最终回答；证据不足的部分如实说明。不要再调用任何工具。',
  emptyRetryNudge: '请直接给出基于证据的最终回答，不要再输出空内容。',
  toolCallLimitReply: '工具调用次数已达上限，请基于已有证据直接作答。',
  contextHardLimitReply: '当前请求的必要上下文仍超过模型可接收上限，请缩小问题范围、减少附件或切换到更大上下文窗口的模型后重试。',
  finalAnswerNormalization: 'extract-final-answer-tag',
}, '知识库 ReAct 默认终态策略必须逐项保持稳定');

// ── 1. 会话状态：seenChunks 去重 + 引用号台账 ────────────────────────────
const session = new KnowledgeAgentSessionState({ maxSingleObservationChars: 12_000, maxTotalObservationTokens: 20_000 });
const first = session.registerEvidence({ documentId: 'doc-1', parentChunkId: 'p-1', ordinal: 3, text: '父块正文', sourceText: '父块正文' });
ok(first.reference === '[1]' && first.alreadySeen === false, '首次登记分配引用号 [1]');
const again = session.registerEvidence({ documentId: 'doc-1', parentChunkId: 'p-1', ordinal: 3, text: '父块正文', sourceText: '父块正文' });
ok(again.reference === '[1]' && again.alreadySeen === true, '重复父块复用引用号并标记已见过');
const second = session.registerEvidence({ documentId: 'doc-2', parentChunkId: 'p-9', ordinal: 7, text: '另一块', sourceText: '另一块' });
ok(second.reference === '[2]', '新父块递增分配 [2]');
ok(session.ledgerEntries().length === 2, '台账只保留两个唯一父块');
const windowKey = session.seenWindowKey('doc-1', 3, 1);
session.markWindowSeen(windowKey);
ok(session.isWindowSeen(windowKey) && !session.isWindowSeen(session.seenWindowKey('doc-1', 3, 2)), '深读窗口去重按窗口范围区分');

// ── 2. 观察预算：单条截断 + 总量熔断 ─────────────────────────────────────
const tightSession = new KnowledgeAgentSessionState({ maxSingleObservationChars: 100, maxTotalObservationTokens: 60 });
const tracker = tightSession.budgetTracker;
const accepted = tracker.accept('甲'.repeat(500));
ok(accepted.length <= 100 && accepted.includes('截断'), '单条观察截断并附标注');
ok(tracker.canObserve() === false, '超预算后 canObserve 关闭');

// ── 3. 系统提示词与 runtime_context ──────────────────────────────────────
const systemPrompt = buildKnowledgeAgentSystemPrompt({ libraryLabel: '电力电子资料库', capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true } });
ok(systemPrompt.includes('电力电子资料库'), '提示词包含资料库名');
for (const rule of ['证据优先', '每个新问题重新检索', '命中即深读', '语义与字面分流', '先穷尽知识库', '引用纪律', '停止条件']) {
  ok(systemPrompt.includes(rule), `提示词包含硬规则「${rule}」`);
}
ok(systemPrompt.includes('工具轮 content') && systemPrompt.includes('<final_answer>'), '提示词把工具轮自述与终答正文明确分离');
const limitedPrompt = buildKnowledgeAgentSystemPrompt({ libraryLabel: '库', capabilities: { semanticSearch: false, keywordSearch: true, deepRead: true } });
ok(limitedPrompt.includes('语义检索不可用'), '无向量索引时提示词声明能力限制');
const runtimeContext = buildKnowledgeRuntimeContext({ libraryLabel: '电力电子资料库', documentCount: 12, indexedChunks: 348, capabilities: { semanticSearch: true, keywordSearch: true, deepRead: true }, now: new Date('2026-08-28T00:00:00Z') });
ok(runtimeContext.includes('<runtime_context>') && runtimeContext.includes('documents="12"') && runtimeContext.includes('indexed_chunks="348"'), 'runtime_context 注入库规模');
ok(runtimeContext.includes('semantic_search,keyword_search,deep_read'), 'runtime_context 声明能力面');

// ── 3.1 核心工具 Schema 与注册顺序基线 ────────────────────────────────
const coreToolContracts = [
  ['grepChunksTool.ts', /name: 'grep_chunks'/u, /maxLength: 80/u, /required: \['pattern'\]/u],
  ['listKnowledgeChunksTool.ts', /name: 'list_knowledge_chunks'/u, /required: \['document_id', 'ordinal'\]/u, /window: \{ type: 'number'/u],
  ['getDocumentInfoTool.ts', /name: 'get_document_info'/u, /document_id: \{ type: 'string'/u, /parameters: \{[\s\S]*?properties:/u],
  ['knowledgeSearchTool.ts', /name: 'knowledge_search'/u, /maxItems: MAX_QUERIES/u, /required: \['queries'\]/u],
];
for (const [fileName, ...patterns] of coreToolContracts) {
  const source = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', fileName), 'utf8');
  for (const pattern of patterns) ok(pattern.test(source), `${fileName} 核心 Schema 保持稳定：${pattern}`);
}
const registrySource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentTurn.ts'), 'utf8');
ok(/registry\.register\(grepChunksTool\);\s*registry\.register\(listKnowledgeChunksTool\);\s*registry\.register\(getDocumentInfoTool\);\s*if \(capabilities\.semanticSearch\) registry\.register\(knowledgeSearchTool\);/u.test(registrySource), '知识库核心工具注册顺序和语义检索条件保持稳定');

// ── 4. 引擎主循环：Think→Act→Observe→终答 + 重复动作拒绝 ────────────────
const echoTool = {
  name: 'echo_search',
  description: '测试用检索。',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  execute: async (args, ctx) => {
    const { reference } = ctx.session.registerEvidence({ documentId: 'doc-1', parentChunkId: `p-${args.q}`, ordinal: 1, text: `证据：${args.q}`, sourceText: `证据：${args.q}` });
    return { ok: true, observation: `<search_results><result reference="${reference}">证据：${args.q}</result></search_results>`, message: `命中 ${args.q}`, referenceCount: 1 };
  },
};
const makeScriptedTransport = (responses) => {
  const calls = [];
  return {
    calls,
    transport: {
      capability: 'native-tools',
      chat: async (_config, input) => {
        calls.push(input);
        if (responses.length === 0) throw new Error('脚本化响应耗尽');
        const next = responses.shift();
        next.play?.(input);
        return next;
      },
    },
  };
};
const dummyConfig = { kind: 'custom', endpoint: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' };
const baseRegistryInput = () => {
  const registry = {
    tools: new Map(),
    register(tool) { this.tools.set(tool.name, tool); },
    get(name) { return this.tools.get(name); },
    names() { return [...this.tools.keys()]; },
    schemas() { return [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })); },
    validate(call) {
      const tool = this.tools.get(call.name);
      if (!tool) return `未知工具 ${call.name}`;
      for (const required of tool.parameters.required ?? []) {
        if (!(required in call.arguments)) return `缺少必填参数 ${required}`;
      }
      return undefined;
    },
  };
  registry.register(echoTool);
  return registry;
};

const runSession = new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET);
const scripted = makeScriptedTransport([
  { content: '先检索。', toolCalls: [{ id: 'c1', name: 'echo_search', arguments: { q: '谐波' } }], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { content: '再查一次。', toolCalls: [{ id: 'c2', name: 'echo_search', arguments: { q: '谐波' } }] },
  { content: '', toolCalls: [] },
  { content: '答案是谐波抑制。[1]', toolCalls: [] },
]);
const roundEvents = [];
const naturalResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '什么是谐波抑制？',
  model: 'm',
  thinkingMode: 'advanced',
  config: dummyConfig,
  transport: scripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: runSession },
  observationTracker: runSession.budgetTracker,
  signal: new AbortController().signal,
  onRound: (roundEvent) => roundEvents.push(roundEvent),
  collectCitations: () => runSession.ledgerEntries(),
});
ok(naturalResult.stopReason === 'natural', '正常终答停止原因为 natural');
ok(naturalResult.finalAnswer.includes('[1]'), '终答保留引用号');
ok(naturalResult.citations.length === 1 && naturalResult.citations[0].reference === '[1]', '终答引用台账来自会话状态');
ok(roundEvents.some((roundEvent) => roundEvent.state === 'rejected'), '重复动作签名命中后被拒绝并回观察');
equal(roundEvents.map((event) => `${event.round}:${event.tool}:${event.state}`), [
  '1:echo_search:started',
  '1:echo_search:completed',
  '2:echo_search:rejected',
], '工具事件必须按 started → completed → 下一轮 rejected 的真实顺序发布');
ok(scripted.calls[1].messages.some((message) => message.role === 'tool' && message.toolCallId === 'c1'), '工具结果以 tool 消息回注上下文');
ok(scripted.calls[3].messages.some((message) => message.role === 'user' && message.content.includes('空内容')), '空回答触发重试提示');
ok(scripted.calls.every((request) => request.thinkingMode === 'advanced'), '每个 ReAct 决策请求都继承用户选择的高级思考');
ok(naturalResult.usage?.totalTokens === 15, '用量累计来自传输层');
ok(naturalResult.streamedAnswerChars === 0, '未提供流式回调时 streamedAnswerChars 为 0，调用方全量补发');

const taggedScripted = makeScriptedTransport([{
  content: '现在我有了足够证据，让我整理一下。\n<final_answer>直接面向用户的答案。[1]</final_answer>\n这段也不应展示。',
  toolCalls: [],
}]);
const taggedResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '终答边界测试',
  model: 'm',
  config: dummyConfig,
  transport: taggedScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: runSession },
  signal: new AbortController().signal,
});
ok(taggedResult.finalAnswer === '直接面向用户的答案。[1]', '终答只保留 final_answer 标签内正文');

const knowledgeTurnSource = fs.readFileSync(path.join(rootDir, 'electron', 'knowledge', 'knowledgeAgentTurn.ts'), 'utf8');
const loopStart = knowledgeTurnSource.indexOf('loopResult = await runReActLoop<KnowledgeToolContext>');
const loopEnd = knowledgeTurnSource.indexOf('} catch (error)', loopStart);
const loopWiring = knowledgeTurnSource.slice(loopStart, loopEnd);
ok(loopStart >= 0 && loopEnd > loopStart && !/onAnswerDelta:\s*emitDelta/u.test(loopWiring), '知识库决策轮文本不再投到回答位置');
ok(/onThinkingDelta:\s*emitThinkingDelta/u.test(loopWiring), '显式 reasoning 仍保留在深度思考轨迹');
ok(/loopResult\.citations\.filter\(\(entry\) => answer\.includes\(entry\.reference\)\)/u.test(knowledgeTurnSource), '知识库终态只投影答案正文实际使用的引用号');

// ── 5. 引擎预算熔断：超轮次兜底合成 ──────────────────────────────────────
const budgetScripted = makeScriptedTransport([
  { content: '', toolCalls: [{ id: 'c1', name: 'echo_search', arguments: { q: '一轮' } }] },
  { content: '', toolCalls: [{ id: 'c2', name: 'echo_search', arguments: { q: '二轮' } }] },
  { content: '兜底合成答案。[1]', toolCalls: [] },
]);
const budgetSession = new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET);
const budgetResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '预算测试',
  model: 'm',
  thinkingMode: 'advanced',
  config: dummyConfig,
  transport: budgetScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: budgetSession },
  observationTracker: budgetSession.budgetTracker,
  budget: { maxIterations: 2 },
  signal: new AbortController().signal,
  collectCitations: () => budgetSession.ledgerEntries(),
});
ok(budgetResult.stopReason === 'budget-synthesized', '超轮次触发兜底合成');
ok(budgetResult.finalAnswer === '兜底合成答案。[1]', '兜底合成使用不带工具的最终调用');
ok(budgetResult.stopDetail?.includes('2'), '停止详情说明轮数上限');
ok(budgetScripted.calls.at(-1)?.thinkingMode === 'advanced', 'ReAct 兜底终答同样继承高级思考');
equal(budgetScripted.calls.at(-1)?.messages.at(-1)?.content, '证据收集到此为止。请仅基于上方工具返回的证据，直接给出带引用号 [n] 的最终回答；证据不足的部分如实说明。不要再调用任何工具。', '知识库预算兜底终态提示必须逐字符保持稳定');

// ── 6. 无证据 + 空回答耗尽：静态抢救文案 ─────────────────────────────────
const emptyScripted = makeScriptedTransport([
  { content: '', toolCalls: [] },
  { content: '', toolCalls: [] },
  { content: '', toolCalls: [] },
]);
const emptySession = new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET);
const emptyResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '空回答测试',
  model: 'm',
  config: dummyConfig,
  transport: emptyScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: emptySession },
  observationTracker: emptySession.budgetTracker,
  signal: new AbortController().signal,
  collectCitations: () => emptySession.ledgerEntries(),
});
equal(emptyResult.finalAnswer, '很抱歉，本次未能在资料库中检索到足够内容。请换个问法，或先确认资料库已完成解析与索引。', '无观察且空回答耗尽后的静态终态文案必须保持稳定');
equal(emptyScripted.calls[1]?.messages.at(-1)?.content, '请直接给出基于证据的最终回答，不要再输出空内容。', '知识库空回答重试提示必须逐字符保持稳定');

// ── 6.1 上下文硬门禁与工具上限终态基线 ────────────────────────────────
const contextLimitScripted = makeScriptedTransport([]);
const contextLimitResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '上下文硬门禁测试',
  model: 'm',
  config: dummyConfig,
  transport: contextLimitScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET) },
  signal: new AbortController().signal,
  onModelCall: () => ({ ready: false, reason: 'context-budget' }),
});
equal(contextLimitResult.finalAnswer, '当前请求的必要上下文仍超过模型可接收上限，请缩小问题范围、减少附件或切换到更大上下文窗口的模型后重试。', '上下文硬门禁终态文案必须逐字符保持稳定');
equal(contextLimitScripted.calls.length, 0, '上下文硬门禁不得把请求发送给 Provider');

const toolLimitSession = new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET);
const toolLimitScripted = makeScriptedTransport([
  { content: '执行两个工具。', toolCalls: [
    { id: 'limit-1', name: 'echo_search', arguments: { q: '允许' } },
    { id: 'limit-2', name: 'echo_search', arguments: { q: '拒绝' } },
  ] },
  { content: '根据已取得证据回答。[1]', toolCalls: [] },
]);
const toolLimitEvents = [];
const toolLimitResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '工具上限测试',
  model: 'm',
  config: dummyConfig,
  transport: toolLimitScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: toolLimitSession },
  observationTracker: toolLimitSession.budgetTracker,
  budget: { maxToolCalls: 1 },
  signal: new AbortController().signal,
  onRound: (event) => toolLimitEvents.push(event),
});
ok(toolLimitEvents.some((event) => event.tool === 'echo_search' && event.state === 'rejected' && event.message === '工具调用次数超过上限 1，已拒绝。'), '超出工具上限时必须发布 rejected 事件');
ok(toolLimitResult.agentMessages.some((message) => message.role === 'tool' && message.toolCallId === 'limit-2' && message.content === '<tool_error>工具调用次数已达上限，请基于已有证据直接作答。</tool_error>'), '超出工具上限时必须回注稳定的 tool observation');

// ── 7. 流式投影：增量转发 + 工具调用切换收回 + 流式字数记账 ───────────
const streamSession = new KnowledgeAgentSessionState(DEFAULT_REACT_BUDGET);
const streamDeltas = [];
const streamResets = [];
const streamScripted = makeScriptedTransport([
  {
    content: '我先查一下。',
    toolCalls: [{ id: 's1', name: 'echo_search', arguments: { q: '流式' } }],
    play: (request) => {
      request.onDelta?.('我先查');
      request.onToolCallStart?.();
      request.onDelta?.('孤儿增量');
    },
  },
  {
    content: '最终答案是流式。[1]',
    toolCalls: [],
    play: (request) => {
      request.onDelta?.('最终答案');
      request.onDelta?.('是流式。[1]');
    },
  },
]);
const streamResult = await runReActLoop({
  systemPrompt,
  history: [],
  question: '流式测试',
  model: 'm',
  config: dummyConfig,
  transport: streamScripted.transport,
  registry: baseRegistryInput(),
  toolContext: { session: streamSession },
  observationTracker: streamSession.budgetTracker,
  signal: new AbortController().signal,
  collectCitations: () => streamSession.ledgerEntries(),
  onAnswerDelta: (text) => streamDeltas.push(text),
  // 模拟 UI：收到 delta-reset 时清空已累积的流式内容。
  onAnswerReset: () => {
    streamResets.push(1);
    streamDeltas.length = 0;
  },
});
ok(streamResets.length === 1, '模型转工具调用时已流式文本收回一次');
ok(streamDeltas.join('') === '最终答案是流式。[1]', '收回后仅转发终答增量，工具调用后的孤儿增量被丢弃');
ok(streamResult.streamedAnswerChars === streamResult.finalAnswer.length, 'streamedAnswerChars 等于终答长度，调用方无需补发');

console.log(`knowledge-react-agent 验证通过：${checks} 项断言（引擎循环、重复拒绝、预算熔断、引用台账、提示词与运行时上下文、流式投影收回）。`);
