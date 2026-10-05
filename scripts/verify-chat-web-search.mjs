import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 打包被测模块（开放式问答联网搜索：ReAct 链路 + 固定流水线降级 + 提示词）。
const rootDir = process.cwd();
const outDir = path.join(rootDir, '.package-staging', 'verify-chat-web-search');
await build({
  entryPoints: [
    path.join(rootDir, 'electron', 'knowledge', 'chatWebAgentTurn.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'modelCallCoordinator.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'modelCallBudget.ts'),
    path.join(rootDir, 'electron', 'knowledge', 'knowledgeTools', 'knowledgeSessionState.ts'),
  ],
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const {
  buildChatWebAgentSystemPrompt,
  buildChatWebRuntimeContext,
  runChatWebSearchReactTurn,
  runChatWebSearchFallbackTurn,
} = await import(pathToFileURL(path.join(outDir, 'chatWebAgentTurn.js')).href);
const { ModelCallCoordinator } = await import(pathToFileURL(path.join(outDir, 'modelCallCoordinator.js')).href);
const { ModelCallBudgetGate } = await import(pathToFileURL(path.join(outDir, 'modelCallBudget.js')).href);
const { KnowledgeAgentSessionState } = await import(pathToFileURL(path.join(outDir, 'knowledgeTools', 'knowledgeSessionState.js')).href);

let checks = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  checks += 1;
};
const budget = { maxSingleObservationChars: 12_000, maxTotalObservationTokens: 20_000 };

const makeCoordinator = () => new ModelCallCoordinator(
  new ModelCallBudgetGate({ maxModelCalls: 12 }),
  131_072,
  'react-turn',
  undefined,
  { providerKind: 'openai', model: 'mock-model' },
);
const mockResults = [
  { title: '氮化镓最新进展', url: 'https://example.com/gan', snippet: '摘要：氮化镓器件在快充领域持续突破。', source: 'zhipu', publishedAt: '2026-08-01' },
  { title: '碳化硅综述', url: 'https://example.com/sic', snippet: '摘要：碳化硅器件概览。', source: 'zhipu' },
];
const makeMockAdapter = () => {
  const queries = [];
  return {
    queries,
    adapter: {
      id: 'zhipu',
      label: 'Mock',
      description: 'mock',
      requirements: 'none',
      search: async ({ query }) => {
        queries.push(query);
        return mockResults;
      },
    },
  };
};
const noopTrace = () => {};
const baseRequest = (userText) => ({ requestId: 'req-1', userText, conversation: [], intent: 'ask', scope: 'chat' });

// ── 1. 提示词与运行时上下文 ────────────────────────────────────────────────
const systemPrompt = buildChatWebAgentSystemPrompt('auto');
ok(systemPrompt.includes('web_search 最多 3 次') && systemPrompt.includes('web_fetch 最多 3 次'), '系统提示词声明联网工具次数限额');
ok(systemPrompt.includes('不得编造') && systemPrompt.includes('page_verified'), '系统提示词含引用纪律与验证分级');
ok(systemPrompt.includes('不可信数据'), '系统提示词声明网页内容不可信');
const runtime = buildChatWebRuntimeContext({ webSearchProvider: 'zhipu', now: new Date('2026-08-28T00:00:00Z') });
ok(runtime.includes('<web_search provider="zhipu" />'), 'runtime_context 输出厂商节点');
ok(runtime.includes('capabilities="web_search"') && runtime.includes('2026'), 'runtime_context 含能力面与日期锚点');

// ── 2. web-only 台账：引用号从 [1] 起 ─────────────────────────────────────
const session = new KnowledgeAgentSessionState(budget);
const first = session.registerWebEvidence({ url: 'https://example.com/a', title: '网页甲', source: 'zhipu', sourceText: '摘要甲' });
ok(first.reference === '[1]', '无知识库块时网页证据引用号从 [1] 起');
const noLinkA = session.registerWebEvidence({ url: '', title: '无链接条目甲', source: 'zhipu', sourceText: '搜索引擎未提供来源链接的摘要。' });
const noLinkB = session.registerWebEvidence({ url: '', title: '无链接条目乙', source: 'zhipu', sourceText: '另一条无链接摘要。' });
const noLinkARepeat = session.registerWebEvidence({ url: '', title: '无链接条目甲', source: 'zhipu', sourceText: '搜索引擎未提供来源链接的摘要。' });
ok(noLinkA.reference === '[2]' && noLinkB.reference === '[3]', '无链接证据按内容顺序分配引用号');
ok(noLinkARepeat.reference === '[2]' && noLinkARepeat.alreadySeen === true, '无链接证据按标题+摘要去重复用引用号');
ok(session.isSearchableUrl('') === false, '无链接证据不进入 web_fetch 白名单');

// ── 3. ReAct 链路：mock transport + 适配器 ────────────────────────────────
const reactMock = makeMockAdapter();
let reactCallIndex = 0;
const chatToolSchemas = [];
const chatThinkingModes = [];
let finalResponseResolved = false;
let liveDeltaObservedBeforeResolve = false;
const mockTransport = {
  capability: 'native-tools',
  chat: async (_config, request) => {
    chatToolSchemas.push(request.tools);
    chatThinkingModes.push(request.thinkingMode);
    reactCallIndex += 1;
    request.onThinkingDelta?.(reactCallIndex === 1 ? '先判断是否需要联网。' : '根据检索结果组织回答。');
    if (reactCallIndex === 1) {
      return { content: '', toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: '氮化镓最新进展' } }] };
    }
    const content = '氮化镓器件近期在快充领域持续突破 [1]；碳化硅器件亦有综述可参考 [2]。';
    request.onDelta?.(content.slice(0, 18));
    await new Promise((resolve) => setTimeout(resolve, 0));
    request.onDelta?.(content.slice(18));
    finalResponseResolved = true;
    return { content, toolCalls: [] };
  },
};
const reactEvents = [];
const reactOutcome = await runChatWebSearchReactTurn({
  event: {},
  request: { ...baseRequest('氮化镓有什么最新进展？'), thinkingMode: 'advanced' },
  controller: new AbortController(),
  model: 'mock-model',
  provider: 'openai',
  providerConfig: { kind: 'openai' },
  contextWindowTokens: 131_072,
  modelCallCoordinator: makeCoordinator(),
  onDetailedTrace: noopTrace,
  emitTurnEvent: (payload) => {
    reactEvents.push(payload);
    if (payload.type === 'delta' && !finalResponseResolved) liveDeltaObservedBeforeResolve = true;
  },
  webSearch: { adapter: reactMock.adapter, runtimeConfig: {}, maxResults: 6 },
  skillInstructions: [],
  qaSessionId: 'session-1',
  transport: mockTransport,
});
ok(reactOutcome.fallbackRequested === false && reactOutcome.result, 'transport 注入时 ReAct 链路正常产出');
ok(reactOutcome.result.interactionRoute === 'chat', 'ReAct 结果保持 interactionRoute=chat');
ok(reactOutcome.result.answer.includes('[1]') && reactOutcome.result.answer.includes('[2]'), '终答包含模型引用号');
const reactRefs = reactOutcome.result.webCitations.map((citation) => citation.reference);
ok(reactRefs.join(',') === '1,2', 'webCitations 按引用号投影且连续');
ok(reactOutcome.result.webCitations.every((citation) => citation.pageVerified === false), '摘要级证据 pageVerified=false');
ok(reactOutcome.result.qaSessionId === 'session-1', 'QA 会话 id 回传');
ok(reactOutcome.result.toolEvents.some((toolEvent) => toolEvent.tool === 'assistant_web_search' && toolEvent.state === 'completed'), '工具事件使用 assistant_web_search 公开名');
const chatWebSearchSchema = chatToolSchemas[0]?.find((tool) => tool.name === 'web_search');
ok(chatWebSearchSchema && !chatWebSearchSchema.description.includes('knowledge_search') && !chatWebSearchSchema.description.includes('grep_chunks'), '聊天模式的 web_search Schema 不包含知识库工具前置条件');
const reactSearchEvent = reactOutcome.result.toolEvents.find((toolEvent) => toolEvent.tool === 'assistant_web_search' && toolEvent.state === 'completed');
ok(reactSearchEvent?.publicResults?.length === 2, 'ReAct 工具事件携带结构化返回结果');
ok(reactSearchEvent.publicResults[0].reference === '[1]' && reactSearchEvent.publicResults[0].url === 'https://example.com/gan' && reactSearchEvent.publicResults[0].pageVerified === false, 'publicResults 含引用号、URL 与验证分级');
ok(reactSearchEvent.publicResults[0].snippet === '摘要：氮化镓器件在快充领域持续突破。' && reactSearchEvent.publicResults[0].source === 'zhipu' && reactSearchEvent.publicResults[0].publishedAt === '2026-08-01', 'publicResults 含摘要、厂商与发布日期');
ok(reactMock.queries.length === 1 && reactMock.queries[0] === '氮化镓最新进展', 'web_search 经适配器执行一次');
ok(reactEvents.some((payload) => payload.type === 'tool'), 'ReAct 链路对外发布工具事件');
ok(chatThinkingModes.length > 0 && chatThinkingModes.every((mode) => mode === 'advanced'), '联网 ReAct 每个业务模型请求都继承高级思考');
ok(reactEvents.filter((payload) => payload.type === 'thinking-delta').map((payload) => payload.text).join('').includes('组织回答'), '联网 ReAct 的 reasoning 增量会下发到界面深度思考区');
const reactDeltas = reactEvents.filter((payload) => payload.type === 'delta');
ok(finalResponseResolved && liveDeltaObservedBeforeResolve && reactDeltas.length === 2 && reactDeltas.map((payload) => payload.text).join('') === reactOutcome.result.answer,
  '联网 ReAct 的终答在模型调用完成前按增量下发，完成后不会重复补发');

// 模型偶发虚构工具名时，必须如实显示为工具调用失败，不得误标为联网搜索。
let recoveryCallIndex = 0;
const recoveryOutcome = await runChatWebSearchReactTurn({
  event: {},
  request: baseRequest('Java 的垃圾回收机制是如何工作的？'),
  controller: new AbortController(),
  model: 'mock-model',
  provider: 'openai',
  providerConfig: { kind: 'openai' },
  contextWindowTokens: 131_072,
  modelCallCoordinator: makeCoordinator(),
  onDetailedTrace: noopTrace,
  emitTurnEvent: noopTrace,
  webSearch: { adapter: makeMockAdapter().adapter, runtimeConfig: {}, maxResults: 6 },
  skillInstructions: [],
  transport: {
    capability: 'native-tools',
    chat: async () => {
      recoveryCallIndex += 1;
      return recoveryCallIndex === 1
        ? { content: '', toolCalls: [{ id: 'call-unknown', name: 'knowledge_search', arguments: { query: 'Java GC' } }] }
        : { content: '已在工具调用失败后恢复作答。', toolCalls: [] };
    },
  },
});
ok(recoveryOutcome.result?.toolEvents.some((toolEvent) => toolEvent.tool === 'assistant_tool_error' && toolEvent.state === 'rejected' && toolEvent.message.includes('未知工具 knowledge_search')), '未知工具调用公开为工具调用失败');
ok(!recoveryOutcome.result?.toolEvents.some((toolEvent) => toolEvent.tool === 'assistant_web_search' && toolEvent.state === 'rejected'), '未知工具调用不会误标为联网搜索失败');

const unavailable = await runChatWebSearchReactTurn({
  event: {},
  request: baseRequest('氮化镓有什么最新进展？'),
  controller: new AbortController(),
  model: 'mock-model',
  provider: 'ollama',
  providerConfig: { kind: 'ollama' },
  contextWindowTokens: 131_072,
  modelCallCoordinator: makeCoordinator(),
  onDetailedTrace: noopTrace,
  emitTurnEvent: noopTrace,
  webSearch: { adapter: reactMock.adapter, runtimeConfig: {}, maxResults: 6 },
  skillInstructions: [],
});
ok(unavailable.fallbackRequested === true && unavailable.result === undefined, 'Ollama 等无工具调用传输层请求固定流水线降级');

// ── 4. 固定流水线：时间敏感度门控与证据注入 ──────────────────────────────
const makeFallbackInput = (userText, overrides = {}) => ({
  event: {},
  request: baseRequest(userText),
  controller: new AbortController(),
  model: 'mock-model',
  provider: 'openai',
  providerConfig: { kind: 'openai' },
  contextWindowTokens: 131_072,
  modelCallCoordinator: makeCoordinator(),
  onDetailedTrace: noopTrace,
  emitTurnEvent: noopTrace,
  webSearch: { adapter: makeMockAdapter().adapter, runtimeConfig: {}, maxResults: 6 },
  skillInstructions: [],
  ...overrides,
});

const insensitive = await runChatWebSearchFallbackTurn(makeFallbackInput('光合作用的原理是什么？'));
ok(insensitive.result === undefined && insensitive.fallbackRequested === false, '时间不敏感问题不搜索、交回直答链路');

const failingAdapter = { id: 'zhipu', label: 'Mock', description: 'mock', requirements: 'none', search: async () => { throw new Error('网络超时'); } };
const failedSearch = await runChatWebSearchFallbackTurn(makeFallbackInput('氮化镓有什么最新进展？', { webSearch: { adapter: failingAdapter, runtimeConfig: {}, maxResults: 6 } }));
ok(failedSearch.result === undefined, '搜索失败降级为直答而非失败回答');

const emptyAdapter = { id: 'zhipu', label: 'Mock', description: 'mock', requirements: 'none', search: async () => [] };
const emptySearch = await runChatWebSearchFallbackTurn(makeFallbackInput('氮化镓有什么最新进展？', { webSearch: { adapter: emptyAdapter, runtimeConfig: {}, maxResults: 6 } }));
ok(emptySearch.result === undefined, '零结果降级为直答');

let capturedStreamInput;
const stubbed = await runChatWebSearchFallbackTurn(makeFallbackInput('氮化镓有什么最新进展？', {
  streamAnswer: async (streamInput) => {
    capturedStreamInput = streamInput;
    return {
      answer: '根据联网资料，氮化镓器件持续突破 [1]，碳化硅亦有综述 [2]。',
      contextUsage: { inputTokens: 120, contextWindowTokens: 131_072, estimated: false, source: 'provider' },
    };
  },
}));
ok(stubbed.result && stubbed.result.interactionRoute === 'chat', '命中门控且有结果时产出 chat 结果');
ok(capturedStreamInput.userPrompt.includes('联网资料（摘要级，未经全文验证）：'), '证据区块注入 user prompt 并披露未验证');
ok(capturedStreamInput.userPrompt.includes('[1] 《氮化镓最新进展》') && capturedStreamInput.userPrompt.includes('URL: https://example.com/gan'), '证据区块含 [N] 编号、标题与 URL');
ok(capturedStreamInput.systemPrompt.includes('编号必须与资料标题开头的 [N] 完全一致'), '系统提示词追加证据引用纪律');
ok(stubbed.result.webCitations.map((citation) => citation.reference).join(',') === '1,2', '终答引用命中条目投影为 webCitations');
ok(stubbed.result.toolEvents.some((toolEvent) => toolEvent.tool === 'assistant_web_search' && toolEvent.state === 'completed'), '固定流水线发布搜索完成事件');
const fallbackSearchEvent = stubbed.result.toolEvents.find((toolEvent) => toolEvent.tool === 'assistant_web_search' && toolEvent.state === 'completed');
ok(fallbackSearchEvent?.publicResults?.length === 2 && fallbackSearchEvent.publicResults[0].reference === '[1]', '固定流水线工具事件携带结构化返回结果');
ok(fallbackSearchEvent.publicResults[0].title === '氮化镓最新进展' && fallbackSearchEvent.publicResults[0].url === 'https://example.com/gan' && fallbackSearchEvent.publicResults[0].pageVerified === false, '固定流水线 publicResults 含标题、URL 与摘要级分级');

// ── 5. 无链接结果：证据披露与引用投影 ────────────────────────────────
let noLinkStreamInput;
const noLinkAdapter = { id: 'zhipu', label: 'Mock', description: 'mock', requirements: 'none', search: async () => [{ title: '无链接条目', url: '', source: 'zhipu', snippet: '搜索引擎未提供来源链接的摘要。' }] };
const noLinkTurn = await runChatWebSearchFallbackTurn(makeFallbackInput('氮化镓有什么最新进展？', {
  webSearch: { adapter: noLinkAdapter, runtimeConfig: {}, maxResults: 6 },
  streamAnswer: async (streamInput) => {
    noLinkStreamInput = streamInput;
    return {
      answer: '根据联网资料，氮化镓器件持续突破 [1]。',
      contextUsage: { inputTokens: 120, contextWindowTokens: 131_072, estimated: false, source: 'provider' },
    };
  },
}));
ok(noLinkTurn.result && noLinkStreamInput.userPrompt.includes('URL: 无链接（搜索引擎未提供来源地址）'), '无链接证据块披露无来源链接');
ok(noLinkTurn.result.webCitations.length === 1 && noLinkTurn.result.webCitations[0].url === '', '无链接证据投影为空 URL 引用');

console.log(`chat-web-search 验证通过：${checks} 项断言（提示词纪律、ReAct 链路投影、传输层降级、时间门控、证据注入）。`);
