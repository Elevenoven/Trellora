import type { IpcMainInvokeEvent } from 'electron';
import { listMaterialsDocuments } from '../materialsLibrary';
import { readMaterialDocumentIndexStats } from '../pipeline/materialChunkSearch';
import { resolveRerankRuntime } from './rerankAdapters';
import { DEFAULT_REACT_BUDGET, KNOWLEDGE_SHADOW_MODEL_CALL_BUDGET } from './reactAgent/reactEngineTypes';
import { runReActLoop } from './reactAgent/reactEngine';
import { createReActChatTransport, type ReActChatMessage, type ReActChatTransport } from './reactAgent/reactChatTransport';
import { projectReActModelRoundEvent } from './reactAgent/reactPublicModelTrace';
import { ReActToolRegistry } from './reactAgent/toolRegistry';
import { KnowledgeAgentSessionState } from './knowledgeTools/knowledgeSessionState';
import { knowledgeSearchTool } from './knowledgeTools/knowledgeSearchTool';
import { grepChunksTool } from './knowledgeTools/grepChunksTool';
import { listKnowledgeChunksTool } from './knowledgeTools/listKnowledgeChunksTool';
import { getDocumentInfoTool } from './knowledgeTools/getDocumentInfoTool';
import { graphLocalSearchTool } from './knowledgeTools/graphLocalSearchTool';
import { graphGlobalSearchTool } from './knowledgeTools/graphGlobalSearchTool';
import { GLOBAL_SEARCH_LLM_TIMEOUT_MS, GLOBAL_SEARCH_REDUCE_MAX_OUTPUT_TOKENS } from '../pipeline/graphGlobalSearch';
import { generateAiText } from './aiProvider';
import { readGraphProjectionStatus } from '../pipeline/graphProjection';
import { webSearchTool } from './knowledgeTools/webSearchTool';
import { webFetchTool } from './knowledgeTools/webFetchTool';
import { createReadSkillTool } from './knowledgeTools/readSkillTool';
import { createSearchMemoryTool, type SearchMemoryToolRuntime } from './knowledgeTools/searchMemoryTool';
import { createSearchConversationsTool, type SearchConversationsToolRuntime } from './knowledgeTools/searchConversationsTool';
import { buildKnowledgeAgentSystemPrompt, buildKnowledgeRuntimeContext, buildKnowledgeSkillsBlock, type KnowledgeAgentCapabilities } from './knowledgeAgentPrompt';
import { buildKnowledgeMemoryEnvelope } from './knowledgeMemoryEnvelope';
import { resolveQaZoneBudget } from './qaMemoryAssembler';
import { buildQueryRewritePrompt, normalizeGraphIntent, QueryRewriteError, rewriteKnowledgeQuestion, selectRewriteHistoryTurns, type QueryRewriteProviderCallObservationEvent, type QueryRewriteResult } from './queryRewrite';
import type { KnowledgeToolContext, KnowledgeToolQueryOptions, KnowledgeToolRetrievalContext } from './knowledgeToolContext';
import type { ResolvedSkillDefinitions } from './skillDefinitionResolver';
import type { AssistantPublicModelEvent, AssistantTurnEvent, AssistantTurnRequest, AssistantTurnResult, AssistantKnowledgeShadowTelemetry, CurrentNotePublicToolEvent, QaQueryRewriteRecord } from './assistantTurnTypes';
import type { AssistantDetailedTraceSink } from './assistantDetailedTrace';
import { ModelCallCoordinator } from './modelCallCoordinator';
import { ModelCallBudgetGate } from './modelCallBudget';
import type { AiProviderConfig, AiProviderKind } from './aiTypes';
import type { QaAgentMessageInput, QaCanonicalHistoryMessage, QaRecentTurn, QaResidualMemoryObservationInput, QaSummaryBlock } from './qaMemoryTypes';
import { createQaAgentMessageInputs } from './qaCanonicalHistory';
import { resolveAssistantAnswerTemperature } from './assistantGenerationPolicy';
import { estimateTokenCount, type AssistantContextUsage } from './tokenEstimator';
import type { HubStore } from '../store';
import { KnowledgeBaseImageResolver } from './knowledgeBaseImageResolver';
import { observeDynamicMemoryS0Call } from './dynamicMemoryS0Observe';
import type { AssistantContextRuntimeMode } from './contextRuntimeTypes';

/** 工具名到对外公开事件名的映射；保持 CurrentNotePublicToolEvent 的类型收敛。 */
const KNOWLEDGE_AGENT_TOOL_EVENT_NAMES: Record<string, CurrentNotePublicToolEvent['tool']> = {
  knowledge_search: 'knowledge_agent_search',
  grep_chunks: 'knowledge_agent_grep',
  list_knowledge_chunks: 'knowledge_agent_deep_read',
  get_document_info: 'knowledge_agent_doc_info',
  graph_local_search: 'knowledge_agent_graph_search',
  graph_global_search: 'knowledge_agent_graph_global_search',
  read_skill: 'knowledge_agent_skill',
  web_search: 'knowledge_agent_web_search',
  web_fetch: 'knowledge_agent_web_fetch',
  search_conversations: 'search_conversations',
};

export interface KnowledgeAgentTurnInput {
  event: IpcMainInvokeEvent;
  request: AssistantTurnRequest;
  controller: AbortController;
  source: { libraryPath: string; label?: string };
  model: string;
  provider: AiProviderKind;
  providerConfig: AiProviderConfig;
  contextWindowTokens: number;
  modelCallCoordinator: ModelCallCoordinator;
  onDetailedTrace: AssistantDetailedTraceSink;
  store: HubStore;
  /** 事件下发；由 main.ts 注入以复用 emitAssistantTurnEvent 的销毁检查。 */
  emitTurnEvent: (payload: AssistantTurnEvent) => void;
  /** 按查询装配检索依赖；由 main.ts 注入 prepareMaterialSearchContext。 */
  prepareMaterialSearchContext: (libraryPath: string, query: string, options?: KnowledgeToolQueryOptions) => Promise<KnowledgeToolRetrievalContext>;
  qaRecentTurns?: QaRecentTurn[];
  qaHistoryMessages?: QaCanonicalHistoryMessage[];
  qaSessionId?: string;
  qaResidualMemoryObservation?: QaResidualMemoryObservationInput;
  assistantContextRuntimeMode?: AssistantContextRuntimeMode;
  /** 记忆信封注入：M1 摘要批次（批次正序）；由 main.ts 从记忆库投影。 */
  qaSummaryBlocks?: readonly QaSummaryBlock[];
  /** 记忆信封注入：已由 UserProfileContextAdapter 渲染的用户画像内容。 */
  userProfileEnvelope?: string;
  /** Skill 接入（L1 目录 + 已选预加载）：由 main.ts 解析注入。 */
  skills?: ResolvedSkillDefinitions;
  /** Skill 指令全文查询（read_skill 用）：目录契约不含正文，单独注入。 */
  skillInstructionById?: ReadonlyMap<string, string>;
  /** Skill 资源根（P2 目录形态技能）：技能 id → 目录绝对路径，供 read_skill 按 file_path 读取。 */
  skillResourceRootById?: ReadonlyMap<string, string>;
  /** 联网搜索运行时（联网搜索设计方案 §8）；由 main.ts 按配置+请求开关解析注入，缺省不注册联网工具。 */
  webSearch?: KnowledgeToolContext['webSearch'];
  /** M5 L4 is injected as untrusted user data; its deeper reader is Agent-only. */
  longTermMemoryPrompt?: string;
  /** M8：只交给问题改写器的用户背景，不进入回答上下文或检索过滤。 */
  retrievalConditioning?: string;
  /** M8：只在相关性门控后调用的弱文档亲和度系数。 */
  documentAffinityFactors?: KnowledgeToolContext['documentAffinityFactors'];
  memorySearch?: SearchMemoryToolRuntime;
  /** M6 L3 search is independent of the L4 memory enabled switch. */
  conversationSearch?: SearchConversationsToolRuntime;
  /** shadow：与旧链路并行跑，只落详细轨迹，不向渲染进程发任何事件。 */
  mode?: 'production' | 'shadow';
  /** 传输层注入；仅验证脚本使用，缺省按线协议工厂创建。 */
  transport?: ReActChatTransport;
  /** 改写服务注入；仅验证脚本使用，缺省走旧链路同款 rewriteKnowledgeQuestion。 */
  rewriteQuestion?: (rewriteInput: {
    question: string;
    history: QaRecentTurn[];
    askerBackground?: string;
    model: string;
    providerConfig?: AiProviderConfig;
    contextWindowTokens?: number;
    signal: AbortSignal;
    onProviderCallObserved?: (event: QueryRewriteProviderCallObservationEvent) => void;
  }) => Promise<QueryRewriteResult>;
}

export interface KnowledgeAgentTurnMetrics {
  /** Think 轮数 / 模型调用次数 / 工具调用次数（引擎真实计数）。 */
  rounds: number;
  modelCalls: number;
  maintenanceModelCalls: number;
  toolCalls: number;
  stopReason: string;
  stopDetail?: string;
  /** 台账登记的去重证据父块数（影子对比证据覆盖口径）。 */
  evidenceParentChunks: number;
  /** 记忆信封实际注入 token（0 表示未注入）。 */
  memoryEnvelopeTokens?: number;
  /** 轮内固化执行次数（P2）；0/缺省表示未触发。 */
  consolidations?: number;
}

export interface KnowledgeAgentTurnOutcome {
  result: AssistantTurnResult | undefined;
  agentMessages?: QaAgentMessageInput[];
  finalReasoningContent?: string;
  /** 传输层不可用（如本地 Ollama）时为 true；调用方回退旧流水线。 */
  fallbackRequested: boolean;
  /** 引擎实际预算计数；供 P2 影子对比遥测使用。 */
  metrics?: KnowledgeAgentTurnMetrics;
}

/**
 * 知识库 ReAct Agent 入口（方案 §2）：工具注册 → 提示词与运行时上下文
 * 装配 → runReActLoop 主循环 → AssistantTurnResult 投影。
 * 引擎初始化失败或传输层不可用时请求回退，由 main.ts 走旧流水线。
 */
export async function runKnowledgeAgentTurn(input: KnowledgeAgentTurnInput): Promise<KnowledgeAgentTurnOutcome> {
  const { request, controller, source } = input;
  const executionStartedAt = Date.now();
  const sourceLabel = source.label?.trim() || '个人知识库';
  const silent = input.mode === 'shadow';
  const toolEvents: CurrentNotePublicToolEvent[] = [];
  const modelEvents: AssistantPublicModelEvent[] = [];
  const emitStatus = (message: string) => {
    if (silent) return;
    input.emitTurnEvent({ requestId: request.requestId, type: 'status', message });
  };
  const emitDelta = (text: string) => {
    if (silent) return;
    if (!controller.signal.aborted) input.emitTurnEvent({ requestId: request.requestId, type: 'delta', text });
  };
  const emitThinkingDelta = (text: string) => {
    if (silent) return;
    if (!controller.signal.aborted) input.emitTurnEvent({ requestId: request.requestId, type: 'thinking-delta', text });
  };
  const emitToolEvent = (toolEvent: CurrentNotePublicToolEvent) => {
    toolEvents.push(toolEvent);
    if (!silent) input.emitTurnEvent({ requestId: request.requestId, type: 'tool', event: toolEvent });
  };
  const emitModelEvent = (modelEvent: AssistantPublicModelEvent) => {
    modelEvents.push(modelEvent);
    if (!silent) input.emitTurnEvent({ requestId: request.requestId, type: 'model', event: modelEvent });
  };

  const transport = input.transport ?? createReActChatTransport(input.providerConfig, input.model);
  if (!transport) {
    input.onDetailedTrace({ stage: 'react', action: 'transport', status: 'rejected', error: '当前模型不支持原生工具调用，回退旧流水线。' });
    return { result: undefined, fallbackRequested: true };
  }

  emitStatus(`正在以知识库 Agent 模式处理（${sourceLabel}）…`);
  const rerankRuntime = resolveRerankRuntime(input.store);
  const documents = listMaterialsDocuments(source.libraryPath);
  const libraryStats = readMaterialDocumentIndexStats(source.libraryPath);
  const graphProjection = readGraphProjectionStatus(source.libraryPath);
  const capabilities: KnowledgeAgentCapabilities = {
    semanticSearch: true,
    keywordSearch: true,
    deepRead: true,
    webSearch: Boolean(input.webSearch),
    // 图谱投影存在即可查询（库级图装配成功才会写入投影）；实体向量通道属 P4。
    graphSearch: Boolean(graphProjection),
    // 全局检索需社区摘要就绪（覆盖 >0）才注册（方案 §4.2/§4.3）。
    graphGlobalSearch: Boolean(graphProjection && graphProjection.summaryCoverage > 0),
  };

  const budget = DEFAULT_REACT_BUDGET;
  const s0ObservationEnabled = input.assistantContextRuntimeMode !== 'off';
  // 动态预算剖面（P1 信封 + P2 固化）在同一窗口下解析一次，避免重复计算。
  const zoneBudget = resolveQaZoneBudget('knowledge-base', input.contextWindowTokens);
  const session = new KnowledgeAgentSessionState({
    maxSingleObservationChars: budget.maxSingleObservationChars,
    maxTotalObservationTokens: budget.maxTotalObservationTokens,
  });
  const knowledgeBaseImages = new KnowledgeBaseImageResolver(source.libraryPath, { documents });

  // 通过回调解耦：准备逻辑沿用 main.ts 的 prepareMaterialSearchContext。
  const prepareQueryContext = (query: string, options?: KnowledgeToolQueryOptions) => input.prepareMaterialSearchContext(source.libraryPath, query, options);

  const toolContext: KnowledgeToolContext = {
    libraryPath: source.libraryPath,
    libraryLabel: sourceLabel,
    session,
    signal: controller.signal,
    documentNameById: (documentId) => documents.find((document) => document.id === documentId)?.name,
    prepareQueryContext,
    rerank: { enabled: rerankRuntime.enabled, adapter: rerankRuntime.adapter },
    ...(input.documentAffinityFactors ? { documentAffinityFactors: input.documentAffinityFactors } : {}),
    resolveEvidenceVisuals: (evidence) => knowledgeBaseImages.resolve(evidence),
    // 全局图谱检索复用问答 generation 槽位模型做 map-reduce（方案 §4.4 槽位复用）。
    ...(capabilities.graphGlobalSearch ? {
      graphGlobalSearch: {
        callModel: (prompt: string) => generateAiText({
          model: input.model,
          prompt,
          timeoutMs: GLOBAL_SEARCH_LLM_TIMEOUT_MS,
          maxOutputTokens: GLOBAL_SEARCH_REDUCE_MAX_OUTPUT_TOKENS,
          signal: controller.signal,
          providerConfig: input.providerConfig,
        }),
      },
    } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
    onStage: emitStatus,
  };

  const registry = new ReActToolRegistry<KnowledgeToolContext>();
  registry.register(grepChunksTool);
  registry.register(listKnowledgeChunksTool);
  registry.register(getDocumentInfoTool);
  if (capabilities.semanticSearch) registry.register(knowledgeSearchTool);
  // 图谱检索条件注册（GraphRAG 方案 §4.1）：投影不存在时不进注册表。
  if (capabilities.graphSearch) registry.register(graphLocalSearchTool);
  // 全局图谱检索条件注册（方案 §4.2）：社区摘要未就绪时不注册，链路自然回退混合检索。
  if (capabilities.graphGlobalSearch) registry.register(graphGlobalSearchTool);
  // 联网工具条件注册（联网搜索设计方案 §3）：未启用/配置缺失时根本不进注册表。
  if (capabilities.webSearch) {
    registry.register(webSearchTool);
    registry.register(webFetchTool);
  }
  if (input.memorySearch) registry.register(createSearchMemoryTool(input.memorySearch));
  if (input.conversationSearch) registry.register(createSearchConversationsTool<KnowledgeToolContext>(input.conversationSearch));

  let systemPrompt = buildKnowledgeAgentSystemPrompt({ libraryLabel: sourceLabel, capabilities });
  let skillsBlockText = '';
  // Skill 接入块（L1 目录常驻 + 已选预加载）：追加在基础提示词之后、记忆信封之前；
  // 失败语义对齐记忆信封——装配异常退化为无技能块、不注册工具，绝不失败回答。
  try {
    if (input.skills) {
      const skillResourceRoots = input.skillResourceRootById ?? new Map<string, string>();
      const skillsBlock = buildKnowledgeSkillsBlock({ ...input.skills, hasResourceSkills: skillResourceRoots.size > 0 });
      if (skillsBlock) {
        systemPrompt = `${systemPrompt}\n\n${skillsBlock}`;
        skillsBlockText = skillsBlock;
      }
      if (input.skills.catalog.length > 0) {
        registry.register(createReadSkillTool(input.skills, input.skillInstructionById ?? new Map(), skillResourceRoots));
      }
      input.onDetailedTrace({
        stage: 'skills',
        action: 'catalog',
        status: 'completed',
        output: { selectedCount: input.skills.selected.length, catalogCount: input.skills.catalog.length },
      });
    }
  } catch (error) {
    input.onDetailedTrace({
      stage: 'skills',
      action: 'catalog',
      status: 'rejected',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // 记忆信封（优化方案 P1）：M1 摘要 + 用户画像追加到 system prompt 尾部；
  // 失败语义对齐 WeKnora——任一读取/装配异常退化为空信封，绝不失败回答。
  let memoryEnvelopeTokens = 0;
  let memoryEnvelopeText = '';
  try {
    const envelopeBudget = zoneBudget.memoryEnvelope;
    const envelope = buildKnowledgeMemoryEnvelope({
      summaryBlocks: input.qaSummaryBlocks,
      userProfileContent: input.userProfileEnvelope,
      budgetTokens: envelopeBudget,
    });
    if (envelope.text) {
      systemPrompt = `${systemPrompt}\n\n${envelope.text}`;
      memoryEnvelopeTokens = envelope.tokens;
      memoryEnvelopeText = envelope.text;
    }
    input.onDetailedTrace({
      stage: 'memory',
      action: 'envelope',
      status: 'completed',
      output: {
        budgetTokens: envelopeBudget,
        envelopeTokens: envelope.tokens,
        profileTokens: envelope.profileTokens,
        summaryTokens: envelope.summaryTokens,
        includedBatchCount: envelope.includedBatchCount,
      },
    });
  } catch (error) {
    input.onDetailedTrace({
      stage: 'memory',
      action: 'envelope',
      status: 'rejected',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const runtimeContext = buildKnowledgeRuntimeContext({
    libraryLabel: sourceLabel,
    documentCount: documents.length,
    indexedChunks: libraryStats.parentChunks,
    capabilities,
    ...(input.webSearch ? { webSearchProvider: input.webSearch.adapter.id } : {}),
  });

  const history: ReActChatMessage[] = input.qaHistoryMessages
    ? input.qaHistoryMessages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
    }))
    : (input.qaRecentTurns ?? []).flatMap((turn) => {
      const items: ReActChatMessage[] = [{ role: 'user', content: turn.userText }];
      if (turn.answerHead.trim()) items.push({ role: 'assistant', content: turn.answerHead.slice(0, 1500) });
      return items;
    });

  // 问题改写（复用旧链路组件，设计 §3–§7）：ReAct 链路默认先做一次改写/指代消解，
  // 再把解析结果作为提示随问题交给 ReAct 循环；失败回退原文。
  let resolvedHint: string | undefined;
  let graphIntent: 'global' | 'local' | 'none' = 'none';
  let queryRewrite: QaQueryRewriteRecord;
  const rewriteStartedAt = Date.now();
  emitToolEvent({ tool: 'rewrite_question', state: 'started', message: '正在结合历史上下文改写问题…' });
  input.onDetailedTrace({
    stage: 'rewrite',
    action: 'query-rewrite',
    status: 'started',
    input: { originalQuestion: request.userText, historyTurnCount: (input.qaRecentTurns ?? []).length },
  });
  try {
    const rewriteHistory = selectRewriteHistoryTurns(input.qaRecentTurns ?? []);
    const rewritePrompt = buildQueryRewritePrompt({
      question: request.userText,
      history: rewriteHistory,
      ...(input.retrievalConditioning ? { askerBackground: input.retrievalConditioning } : {}),
    });
    const preparedRewrite = input.modelCallCoordinator.prepare({ callKind: 'query-rewrite', prompt: rewritePrompt });
    if (!preparedRewrite.ready) throw new Error(`模型调用准备被拒绝：${preparedRewrite.reason}`);
    const rewritten = await (input.rewriteQuestion ?? rewriteKnowledgeQuestion)({
      question: request.userText,
      history: rewriteHistory,
      ...(input.retrievalConditioning ? { askerBackground: input.retrievalConditioning } : {}),
      model: input.model,
      providerConfig: input.providerConfig,
      contextWindowTokens: input.contextWindowTokens,
      signal: controller.signal,
      ...(s0ObservationEnabled ? {
        onProviderCallObserved: (event) => recordQueryRewriteS0Observation(
          input,
          event,
          rewriteHistory,
        ),
      } : {}),
    });
    resolvedHint = rewritten.rewrite;
    graphIntent = normalizeGraphIntent(rewritten.graphIntent);
    queryRewrite = {
      skipped: false,
      rewrite: rewritten.rewrite,
      shouldSplit: rewritten.shouldSplit,
      subQuestions: rewritten.subQuestions,
      graphIntent: rewritten.graphIntent,
      ...(rewritten.rawOutput !== undefined ? { rawOutput: rewritten.rawOutput } : {}),
      model: rewritten.model,
      elapsedMs: rewritten.elapsedMs,
      ...(rewritten.guardTriggered ? { guardTriggered: rewritten.guardTriggered } : {}),
    };
    input.onDetailedTrace({
      stage: 'rewrite',
      action: 'query-rewrite',
      status: 'completed',
      elapsedMs: rewritten.elapsedMs,
      output: { rewrite: rewritten.rewrite, shouldSplit: rewritten.shouldSplit, subQuestions: rewritten.subQuestions, graphIntent: rewritten.graphIntent },
    });
    emitToolEvent({ tool: 'rewrite_question', state: 'completed', message: `指代已解析：${rewritten.rewrite}` });
  } catch (error) {
    if (controller.signal.aborted) throw error;
    const failedRaw = error instanceof QueryRewriteError ? error.rawOutput : undefined;
    const failedMessage = (error instanceof Error ? error.message : String(error)) || '问题改写失败。';
    queryRewrite = {
      skipped: false,
      elapsedMs: Math.max(0, Date.now() - rewriteStartedAt),
      failed: {
        code: error instanceof QueryRewriteError ? error.code : 'rewrite-error',
        message: failedMessage,
        ...(failedRaw !== undefined ? { rawOutput: failedRaw } : {}),
      },
    };
    input.onDetailedTrace({
      stage: 'rewrite',
      action: 'query-rewrite',
      status: 'rejected',
      elapsedMs: queryRewrite.elapsedMs,
      errorCode: queryRewrite.failed?.code,
      error: failedMessage,
      ...(failedRaw !== undefined ? { output: { rawOutput: failedRaw } } : {}),
    });
    emitToolEvent({ tool: 'rewrite_question', state: 'rejected', message: '问题改写失败，已回退原文检索。' });
  }
  // 图意图门控（方案 §4.3）：软提示，工具不可用时不下发；最终路由仍由 ReAct 循环决定。
  const graphIntentHint = graphIntent === 'global' && capabilities.graphGlobalSearch
    ? '\n（图意图：整体性问题，可优先用 graph_global_search 把握全局，再用其他工具核实原文）'
    : graphIntent === 'local' && capabilities.graphSearch
      ? '\n（图意图：实体关系问题，可优先用 graph_local_search 沿图谱检索）'
      : '';
  const question = `${input.longTermMemoryPrompt?.trim() ? `${input.longTermMemoryPrompt.trim()}\n\n` : ''}${runtimeContext}\n\n${request.userText}${resolvedHint ? `\n（指代已解析，检索请以该指代为准：${resolvedHint}）` : ''}${graphIntentHint}`;

  const roundTrace = (entry: { stage: 'react'; action: string; status: 'started' | 'completed' | 'failed'; detail?: Record<string, unknown> }) => {
    input.onDetailedTrace({ stage: 'react', action: entry.action, status: entry.status, ...(entry.detail ? { output: entry.detail } : {}) });
  };

  let loopResult;
  try {
    loopResult = await runReActLoop<KnowledgeToolContext>({
      systemPrompt,
      history,
      question,
      model: input.model,
      thinkingMode: request.thinkingMode,
      config: input.providerConfig,
      transport,
      registry,
      toolContext,
      observationTracker: session.budgetTracker,
      budget,
      contextWindowTokens: input.contextWindowTokens,
      signal: controller.signal,
      temperature: resolveAssistantAnswerTemperature({ grounded: true }),
      onModelCall: ({ serializedPromptText }) => {
        const prepared = input.modelCallCoordinator.prepare({ callKind: 'direct', prompt: serializedPromptText });
        return prepared.ready
          ? { ready: true, maxPromptTokens: prepared.call.plan.maxPromptTokens }
          : { ready: false, reason: prepared.reason };
      },
      onModelRound: (modelEvent) => emitModelEvent(projectReActModelRoundEvent(modelEvent)),
      ...(s0ObservationEnabled ? {
        onProviderCallObserved: (event) => {
          const historyMessages = new Set(history);
          const toolMessages = event.request.messages.filter((message) => message.role === 'tool');
          const agentMessages = event.request.messages.filter((message) => (
            (message.role === 'assistant' && !historyMessages.has(message))
            || (message.role === 'tool' && message.content.startsWith('<tool_error>'))
          ));
          const evidenceMessages = toolMessages.filter((message) => !message.content.startsWith('<tool_error>'));
          const rNextTokens = Math.min(
            Math.max(0, budget.maxTotalObservationTokens - session.budgetTracker.usedTokens),
            estimateTokenCount('x'.repeat(budget.maxSingleObservationChars)),
          );
          input.onDetailedTrace({
            stage: 'context-runtime',
            action: 'dynamic-memory-s0-provider-call',
            status: event.responseCompleted ? 'completed' : 'rejected',
            callKind: event.callKind,
            output: observeDynamicMemoryS0Call({
              route: 'knowledge-base-react',
              callKind: event.callKind,
              messages: event.request.messages,
              tools: event.request.tools,
              providerFields: {
                model: event.request.model,
                ...(event.request.temperature === undefined ? {} : { temperature: event.request.temperature }),
                ...(event.request.maxOutputTokens === undefined ? {} : { maxOutputTokens: event.request.maxOutputTokens }),
              },
              contextWindowTokens: input.contextWindowTokens,
              outputReserveTokens: event.request.maxOutputTokens,
              rNextTokens: event.callKind === 'react-decide' ? rNextTokens : 0,
              memoryTexts: [memoryEnvelopeText, ...event.request.messages.filter((message) => historyMessages.has(message)).map((message) => message.content)],
              agentStateTexts: agentMessages.map((message) => message.content),
              evidenceTexts: evidenceMessages.map((message) => message.content),
              skillTexts: skillsBlockText ? [skillsBlockText] : [],
              coverage: input.qaResidualMemoryObservation,
              usage: event.usage,
              responseCompleted: event.responseCompleted,
            }),
          });
        },
      } : {}),
      onRound: (roundEvent) => {
        const mapped: CurrentNotePublicToolEvent = {
          tool: KNOWLEDGE_AGENT_TOOL_EVENT_NAMES[roundEvent.tool] ?? 'knowledge_agent_search',
          state: roundEvent.state === 'failed' ? 'rejected' : roundEvent.state,
          message: roundEvent.message,
          round: roundEvent.round,
          ...(roundEvent.referenceCount !== undefined ? { outputSummary: `新增引用 ${roundEvent.referenceCount} 条` } : {}),
          ...(roundEvent.publicResults?.length ? { publicResults: roundEvent.publicResults } : {}),
          ...(roundEvent.elapsedMs !== undefined ? { elapsedMs: roundEvent.elapsedMs } : {}),
        };
        emitToolEvent(mapped);
      },
      onTrace: roundTrace,
      collectCitations: () => session.ledgerEntries(),
      // 决策轮 content 先留在 modelEvents，并随对应工具折叠展示；确认无 tool_calls
      // 后再由下方统一投影规范化终答，避免过程自述进入回答正文。
      onThinkingDelta: emitThinkingDelta,
    });
  } catch (error) {
    if (controller.signal.aborted) throw error;
    input.onDetailedTrace({ stage: 'react', action: 'loop', status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  const answer = loopResult.finalAnswer;
  // 引擎已流式投影的部分不重发；未提供流式回调时全量补发。
  const streamedChars = Math.min(loopResult.streamedAnswerChars, answer.length);
  for (let index = streamedChars; index < answer.length; index += 64) {
    emitDelta(answer.slice(index, index + 64));
  }

  const citations = loopResult.citations.filter((entry) => answer.includes(entry.reference));
  // 知识库与网页证据分流投影（联网搜索设计方案 §7.2）：引用号共享同一递增序列。
  const knowledgeCitations = citations.filter((entry) => entry.kind !== 'web');
  const knowledgeBaseCitations = knowledgeCitations.map((entry) => ({
    reference: Number(entry.reference.replace(/[[\]]/g, '')),
    documentId: entry.documentId,
    documentName: documents.find((document) => document.id === entry.documentId)?.name ?? sourceLabel,
    parentOrdinal: entry.ordinal ?? 0,
    content: entry.sourceText ?? '',
  })).filter((entry) => Number.isFinite(entry.reference) && entry.reference > 0)
    .sort((first, second) => first.reference - second.reference);
  const webCitations = citations.filter((entry) => entry.kind === 'web').map((entry) => ({
    reference: Number(entry.reference.replace(/[[\]]/g, '')),
    title: entry.title ?? entry.url ?? '',
    url: entry.url ?? '',
    source: entry.source ?? '',
    pageVerified: entry.pageVerified === true,
    content: entry.sourceText ?? '',
  })).filter((entry) => Number.isFinite(entry.reference) && entry.reference > 0)
    .sort((first, second) => first.reference - second.reference);

  const sourceNotes = knowledgeCitations.map((entry) => {
    const document = documents.find((candidate) => candidate.id === entry.documentId);
    const documentName = document?.name ?? sourceLabel;
    const compact = (entry.sourceText ?? '').replace(/\s+/g, ' ').trim();
    return {
      path: document?.absolutePath ?? source.libraryPath,
      reference: Number(entry.reference.replace(/[[\]]/g, '')),
      documentId: entry.documentId,
      parentOrdinal: entry.ordinal ?? 0,
      title: documentName,
      snippet: compact.slice(0, 220),
      score: entry.score ?? 0,
      methods: ['semantic'] as Array<'keyword' | 'semantic'>,
      sourceType: 'knowledge-base' as const,
    };
  });

  const completeness: 'complete' | 'partial' | 'not-found' = citations.length > 0
    ? (loopResult.stopReason === 'natural' ? 'complete' : 'partial')
    : 'not-found';

  // 上下文窗口用量：优先取最后一次模型调用的服务商上报；
  // 服务商不上报时回退末次 prompt 本地估算 + 回答估算，保证底部用量与调试轨道不落空。
  const lastUsage = loopResult.lastUsage;
  const estimatedInputTokens = loopResult.lastPromptTokens ?? 0;
  const estimatedOutputTokens = estimateTokenCount(answer);
  const contextUsage: AssistantContextUsage = lastUsage?.inputTokens !== undefined
    ? {
      inputTokens: lastUsage.inputTokens,
      contextWindowTokens: input.contextWindowTokens,
      estimated: false,
      source: 'provider',
      ...(lastUsage.outputTokens !== undefined ? { outputTokens: lastUsage.outputTokens } : {}),
      ...(lastUsage.totalTokens !== undefined ? { totalTokens: lastUsage.totalTokens } : {}),
      ...(lastUsage.cachedInputTokens !== undefined ? { cachedInputTokens: lastUsage.cachedInputTokens } : {}),
    }
    : {
      inputTokens: estimatedInputTokens,
      contextWindowTokens: input.contextWindowTokens,
      estimated: true,
      source: 'estimate',
      outputTokens: estimatedOutputTokens,
      totalTokens: estimatedInputTokens + estimatedOutputTokens,
    };

  const metrics: KnowledgeAgentTurnMetrics = {
    rounds: loopResult.rounds,
    modelCalls: loopResult.modelCalls,
    maintenanceModelCalls: loopResult.maintenanceModelCalls,
    toolCalls: loopResult.toolCalls,
    stopReason: loopResult.stopReason,
    ...(loopResult.stopDetail ? { stopDetail: loopResult.stopDetail } : {}),
    evidenceParentChunks: session.ledgerEntries().length,
    ...(memoryEnvelopeTokens > 0 ? { memoryEnvelopeTokens } : {}),
    ...(loopResult.consolidations > 0 ? { consolidations: loopResult.consolidations } : {}),
  };

  return {
    fallbackRequested: false,
    metrics,
    agentMessages: createQaAgentMessageInputs(loopResult.agentMessages),
    ...(loopResult.finalReasoningContent ? { finalReasoningContent: loopResult.finalReasoningContent } : {}),
    result: {
      type: 'answer',
      answer,
      provider: input.provider,
      model: input.model,
      sourceNotes,
      knowledgeBaseCitations,
      retrievalMode: 'hybrid',
      interactionRoute: 'react',
      completeness,
      toolEvents,
      modelEvents,
      queryRewrite,
      executionElapsedMs: Math.max(0, Date.now() - executionStartedAt),
      ...(webCitations.length > 0 ? { webCitations } : {}),
      ...(input.qaSessionId ? { qaSessionId: input.qaSessionId } : {}),
      contextUsage,
      cacheUsage: {
        providerReported: contextUsage.source === 'provider' && contextUsage.cachedInputTokens !== undefined,
        ...(contextUsage.cachedInputTokens !== undefined ? { cachedInputTokens: contextUsage.cachedInputTokens } : {}),
      },
    },
  };
}

/**
 * P2 影子对比遥测（方案 §9）：把一轮影子执行的回答投影折算为可与旧链路
 * 对比的指标（证据覆盖 / 轮次 / 耗时），随详细轨迹落盘。
 */
export function buildKnowledgeShadowTelemetry(outcome: KnowledgeAgentTurnOutcome, elapsedMs: number): AssistantKnowledgeShadowTelemetry {
  if (outcome.fallbackRequested || !outcome.result) {
    return { status: 'skipped', skipReason: 'transport-unavailable', elapsedMs };
  }
  const { result, metrics } = outcome;
  return {
    status: 'ran',
    elapsedMs,
    ...(metrics
      ? {
        stopReason: metrics.stopReason,
        rounds: metrics.rounds,
        modelCalls: metrics.modelCalls,
        maintenanceModelCalls: metrics.maintenanceModelCalls,
        toolCalls: metrics.toolCalls,
        evidenceParentChunks: metrics.evidenceParentChunks,
        ...(metrics.stopDetail ? { stopDetail: metrics.stopDetail } : {}),
        ...(metrics.memoryEnvelopeTokens !== undefined && metrics.memoryEnvelopeTokens > 0
          ? { memoryEnvelopeTokens: metrics.memoryEnvelopeTokens }
          : {}),
        ...(metrics.consolidations !== undefined && metrics.consolidations > 0
          ? { consolidations: metrics.consolidations }
          : {}),
      }
      : {}),
    citedParentChunks: result.knowledgeBaseCitations.length,
    completeness: result.completeness,
  };
}

function recordQueryRewriteS0Observation(
  input: KnowledgeAgentTurnInput,
  event: QueryRewriteProviderCallObservationEvent,
  history: readonly QaRecentTurn[],
): void {
  input.onDetailedTrace({
    stage: 'context-runtime',
    action: 'dynamic-memory-s0-provider-call',
    status: event.responseCompleted ? 'completed' : 'rejected',
    callKind: 'query-rewrite',
    output: observeDynamicMemoryS0Call({
      route: 'knowledge-base-react',
      callKind: 'query-rewrite',
      messages: [{ role: 'user', content: event.request.prompt }],
      structuredOutputSchema: event.request.structuredOutputSchema,
      providerFields: {
        model: event.request.model,
        maxOutputTokens: event.request.maxOutputTokens,
      },
      contextWindowTokens: event.request.contextWindowTokens ?? input.contextWindowTokens,
      outputReserveTokens: event.request.maxOutputTokens,
      memoryTexts: history.flatMap((turn) => [turn.userText, turn.answerHead]),
      coverage: input.qaResidualMemoryObservation,
      usage: event.usage,
      responseCompleted: event.responseCompleted,
    }),
  });
}

/**
 * P2 影子对比执行器：使用独立的模型调用预算门后台跑新链路，
 * 静默不发任何渲染进程事件，失败自行收敛为遥测，不向调用方抛出。
 */
export async function runKnowledgeShadowComparison(
  input: Omit<KnowledgeAgentTurnInput, 'mode' | 'transport' | 'modelCallCoordinator' | 'emitTurnEvent'>,
): Promise<AssistantKnowledgeShadowTelemetry> {
  const startedAt = Date.now();
  try {
    const shadowGate = new ModelCallBudgetGate({ maxModelCalls: KNOWLEDGE_SHADOW_MODEL_CALL_BUDGET });
    const shadowCoordinator = new ModelCallCoordinator(shadowGate, input.contextWindowTokens, 'react-turn', undefined, {
      providerKind: input.provider,
      model: input.model,
    });
    const outcome = await runKnowledgeAgentTurn({
      ...input,
      mode: 'shadow',
      modelCallCoordinator: shadowCoordinator,
      emitTurnEvent: () => {
        // 影子对比静默：不向渲染进程发布任何事件。
      },
    });
    return buildKnowledgeShadowTelemetry(outcome, Date.now() - startedAt);
  } catch (error) {
    if (input.controller.signal.aborted) {
      return { status: 'skipped', skipReason: 'cancelled', elapsedMs: Date.now() - startedAt };
    }
    return { status: 'failure', error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt };
  }
}
