import type { IpcMainInvokeEvent } from 'electron';
import { findMaterialsDocument } from '../materialsLibrary';
import { readMaterialDocumentIndexStats } from '../pipeline/materialChunkSearch';
import { resolveRerankRuntime } from '../knowledge/rerankAdapters';
import { runReActLoop } from '../knowledge/reactAgent/reactEngine';
import { createReActChatTransport, type ReActChatMessage, type ReActChatTransport } from '../knowledge/reactAgent/reactChatTransport';
import { projectReActModelRoundEvent } from '../knowledge/reactAgent/reactPublicModelTrace';
import type { ReActCitationLedgerEntry } from '../knowledge/reactAgent/reactEngineTypes';
import { ReActToolRegistry } from '../knowledge/reactAgent/toolRegistry';
import { KnowledgeAgentSessionState } from '../knowledge/knowledgeTools/knowledgeSessionState';
import type { KnowledgeToolRetrievalContext } from '../knowledge/knowledgeToolContext';
import { streamKnowledgeAnswer } from '../knowledge/assistantTurn';
import type {
  AssistantKnowledgeBaseCitation,
  AssistantPublicModelEvent,
  AssistantTurnEvent,
  AssistantTurnRequest,
  AssistantTurnResult,
  AssistantTurnSource,
  AssistantWikiDraft,
  AssistantWikiDraftChild,
  AssistantWikiScopeProgress,
  AssistantWikiScopeResult,
  CurrentNotePublicToolEvent,
} from '../knowledge/assistantTurnTypes';
import { maxAssistantImageTotalBytes } from '../knowledge/assistantTurnTypes';
import type { AssistantDetailedTraceSink } from '../knowledge/assistantDetailedTrace';
import { ModelCallPreparationError, type ModelCallCoordinator } from '../knowledge/modelCallCoordinator';
import type { AiProviderConfig, AiProviderKind } from '../knowledge/aiTypes';
import type { AiTransportImage } from '../knowledge/aiGenerationTransport';
import { resolveAssistantAnswerTemperature } from '../knowledge/assistantGenerationPolicy';
import { collectAiTransportImageHashes, materializeAssistantDocumentImages, parseAssistantDocumentAttachments } from '../knowledge/assistantDocumentAttachmentParser';
import { AttachmentContextProvider, renderAttachmentMetadata, renderAttachmentRange, renderDocumentImageTransportIndex } from '../knowledge/attachmentContextProvider';
import { KnowledgeBaseImageResolver, renderKnowledgeBaseImageTransportIndex } from '../knowledge/knowledgeBaseImageResolver';
import type { MineruRuntimeConfig } from '../pipeline/types';
import { estimateTokenCount, type AssistantContextUsage } from '../knowledge/tokenEstimator';
import type { HubStore } from '../store';
import type { WikiDocumentOutline } from '../wikiOutline';
import {
  collectSubtreeHeadingIds,
  collectWikiChildNodes,
  findWikiNode,
  formatWikiNodePath,
  getWikiNodeBreadcrumb,
  isWikiRootNode,
} from './wikiNodeScope';
import {
  buildWikiAgentQuestion,
  buildWikiNodeAgentSystemPrompt,
  buildWikiNodeContentBlock,
  buildWikiNodeFallbackSystemPrompt,
  buildWikiRuntimeContext,
  type WikiAgentCapabilities,
} from './wikiNodeAgentPrompt';
import { WIKI_NODE_REACT_BUDGET, WIKI_NODE_SUMMARY_REACT_BUDGET } from './wikiNodeBudget';
import { resolveWikiSummaryPolicy, type WikiActionKind } from './wikiQuickActions';
import {
  buildWikiQueryRewritePrompt,
  rewriteWikiQuestion,
  selectWikiRewriteHistory,
  shouldRewriteWikiQuestion,
  WikiQueryRewriteError,
} from './wikiQueryRewrite';
import {
  createWikiScopePolicy,
  createWikiScopeState,
  resolveWikiScopeDecision,
  type WikiScopeDecision,
  type WikiScopeState,
  type WikiRetrievalStopReason,
  type WikiSearchRange,
} from './wikiScopePolicy';
import { buildWikiFallbackQueries, createWikiScopedSearchTool } from './wikiRetrievalCycle';
import type { WikiToolContext } from './wikiToolContext';
import { wikiNodeSearchTool } from './wikiTools/wikiNodeSearchTool';
import { wikiGrepNodeTool } from './wikiTools/wikiGrepNodeTool';
import { wikiReadNodeTool } from './wikiTools/wikiReadNodeTool';
import { wikiGetNodeInfoTool } from './wikiTools/wikiGetNodeInfoTool';
import { wikiSearchDocumentTool } from './wikiTools/wikiSearchDocumentTool';
import { generateWikiSplitProposal } from './wikiSplitProposal';
import { assessWikiDirectEvidence } from './wikiDirectEvidenceGate';

/**
 * Wiki 工具名到对外公开事件名的映射（方案 §4.2）。
 * CurrentNotePublicToolEvent 的 tool 联合收敛到既有 knowledge_agent_* 事件，
 * 渲染进程调试轨道无需新增事件类型即可复用展示。
 */
const WIKI_AGENT_TOOL_EVENT_NAMES: Record<string, CurrentNotePublicToolEvent['tool']> = {
  wiki_node_search: 'knowledge_agent_search',
  wiki_grep_node: 'knowledge_agent_search',
  wiki_search_document: 'knowledge_agent_search',
  wiki_read_node: 'knowledge_agent_deep_read',
  wiki_get_node_info: 'knowledge_agent_doc_info',
};

export interface WikiNodeAgentTurnInput {
  event: IpcMainInvokeEvent;
  request: AssistantTurnRequest;
  controller: AbortController;
  /** 本轮 Wiki 作用域目标（方案 §4.2）；由 main.ts 从已校验的 wikiTarget 注入。 */
  wikiTarget: { libraryPath: string; documentId: string; nodeId: string; actionKind: WikiActionKind };
  /** 已投影并应用同级排序覆盖的文档目录树；由 main.ts 读取后注入。 */
  outline: WikiDocumentOutline;
  model: string;
  provider: AiProviderKind;
  providerConfig: AiProviderConfig;
  contextWindowTokens: number;
  /** Wiki 本轮图片附件；沿 ReAct 当前 user 消息传给 VLM，不写入会话历史。 */
  images?: AiTransportImage[];
  /** 主进程解析并注入的 MinerU 配置；授权后用于 PDF 正文/图片解析，不进入模型上下文。 */
  mineru?: MineruRuntimeConfig;
  modelCallCoordinator: ModelCallCoordinator;
  onDetailedTrace: AssistantDetailedTraceSink;
  store: HubStore;
  /** 事件下发；由 main.ts 注入以复用 emitAssistantTurnEvent 的销毁检查。 */
  emitTurnEvent: (payload: AssistantTurnEvent) => void;
  /** 按查询装配检索依赖；由 main.ts 注入 prepareMaterialSearchContext。 */
  prepareMaterialSearchContext: (libraryPath: string, query: string) => Promise<KnowledgeToolRetrievalContext>;
  /** 传输层注入；仅验证脚本使用，缺省按线协议工厂创建。 */
  transport?: ReActChatTransport;
  /** 普通流式生成注入；仅验证脚本使用，生产缺省走 streamKnowledgeAnswer。 */
  streamAnswer?: typeof streamKnowledgeAnswer;
  /** Wiki 问题改写注入；仅验证脚本使用。 */
  rewriteQuestion?: typeof rewriteWikiQuestion;
}

export interface WikiNodeAgentTurnMetrics {
  rounds: number;
  modelCalls: number;
  toolCalls: number;
  stopReason: string;
  stopDetail?: string;
  /** 台账登记的去重证据父块数（不含直载 [0]）。 */
  evidenceParentChunks: number;
  /** Wiki 检索类工具实际启动的受控周期数。 */
  retrievalCycles: number;
  maxRetrievalCycles: number;
  finalScope: WikiSearchRange;
  scopeStopReason?: WikiRetrievalStopReason;
}

export interface WikiNodeAgentTurnOutcome {
  result: AssistantTurnResult | undefined;
  /** true 表示原生工具链不可用或异常，本轮已由固定降级流水线完成。 */
  degraded?: boolean;
  metrics?: WikiNodeAgentTurnMetrics;
}

/**
 * Wiki 节点 ReAct Agent 入口（方案 §4）：作用域装配 → 节点直载 → 工具注册
 * → 提示词与运行时上下文 → runReActLoop 主循环 → AssistantTurnResult 投影。
 *
 * 与知识库 Agent 同构，差异只在作用域（限定当前节点子树）、预算剖面（更紧）
 * 与节点直载（≤6,000 字符全文注入并约定引用 [0]）。传输层不可用时请求回退。
 */
export async function runWikiNodeAgentTurn(input: WikiNodeAgentTurnInput): Promise<WikiNodeAgentTurnOutcome> {
  const { request, controller, wikiTarget, outline } = input;
  const executionStartedAt = Date.now();
  const toolEvents: CurrentNotePublicToolEvent[] = [];
  const modelEvents: AssistantPublicModelEvent[] = [];
  const turnImages = [...(input.images ?? [])];
  const emitStatus = (message: string) => {
    input.emitTurnEvent({ requestId: request.requestId, type: 'status', message });
  };
  const emitDelta = (text: string) => {
    if (!controller.signal.aborted) input.emitTurnEvent({ requestId: request.requestId, type: 'delta', text });
  };
  const emitThinkingDelta = (text: string) => {
    if (!controller.signal.aborted) input.emitTurnEvent({ requestId: request.requestId, type: 'thinking-delta', text });
  };
  const emitDeltaReset = () => {
    if (!controller.signal.aborted) input.emitTurnEvent({ requestId: request.requestId, type: 'delta-reset' });
  };
  const emitToolEvent = (toolEvent: CurrentNotePublicToolEvent) => {
    toolEvents.push(toolEvent);
    input.emitTurnEvent({ requestId: request.requestId, type: 'tool', event: toolEvent });
  };
  const emitModelEvent = (modelEvent: AssistantPublicModelEvent) => {
    modelEvents.push(modelEvent);
    input.emitTurnEvent({ requestId: request.requestId, type: 'model', event: modelEvent });
  };

  const node = findWikiNode(outline.nodes, wikiTarget.nodeId);
  if (!node) {
    throw new Error('目标 Wiki 节点不存在或已随文档更新失效，请刷新节点树后重试。');
  }
  const document = findMaterialsDocument(wikiTarget.libraryPath, wikiTarget.documentId);
  const documentName = document?.name?.trim() || outline.title || '当前文档';
  const sourcePath = document?.absolutePath ?? wikiTarget.libraryPath;
  const isRoot = isWikiRootNode(node);
  // 根节点作用域为整篇文档（不下发章节过滤）；其余节点限定自身 + 后代标题子树。
  const sectionNodeIds = isRoot ? undefined : collectSubtreeHeadingIds(outline.nodes, wikiTarget.nodeId);
  const nodeBreadcrumb = getWikiNodeBreadcrumb(outline.nodes, wikiTarget.nodeId);
  const nodePath = formatWikiNodePath(nodeBreadcrumb);
  const childTitles = collectWikiChildNodes(outline.nodes, wikiTarget.nodeId).map((child) => child.title);
  let nodeMarkdown = node.markdown ?? '';

  emitStatus(`正在以 Wiki 节点问答模式处理（${nodePath || node.title}）…`);

  const rewriteGate = shouldRewriteWikiQuestion({
    userText: request.userText,
    conversation: request.conversation,
    actionKind: wikiTarget.actionKind,
  });
  input.onDetailedTrace({
    stage: 'rewrite',
    action: 'wiki-query-rewrite-gate',
    status: 'completed',
    input: { originalQuestion: request.userText, historyMessageCount: request.conversation.length },
    output: rewriteGate,
  });

  let resolvedQuestion = request.userText.trim();
  let resolvedSubQuestions = resolvedQuestion ? [resolvedQuestion] : [];
  let explicitSectionTitles: string[] = [];
  let scopeDecision = resolveWikiScopeDecision({
    actionKind: wikiTarget.actionKind,
    userText: request.userText,
  });
  if (rewriteGate.rewriting) {
    const rewriteStartedAt = Date.now();
    const rewriteHistory = selectWikiRewriteHistory(request.conversation);
    emitToolEvent({ tool: 'rewrite_question', state: 'started', message: '正在结合 Wiki 对话与章节范围解析问题…' });
    input.onDetailedTrace({
      stage: 'rewrite',
      action: 'wiki-query-rewrite',
      status: 'started',
      input: { originalQuestion: request.userText, historyMessageCount: rewriteHistory.length },
    });
    try {
      const rewritePrompt = buildWikiQueryRewritePrompt({ question: request.userText, history: rewriteHistory });
      const preparedRewrite = input.modelCallCoordinator.prepare({ callKind: 'query-rewrite', prompt: rewritePrompt });
      if (!preparedRewrite.ready) throw new Error(`模型调用准备被拒绝：${preparedRewrite.reason}`);
      const rewritten = await (input.rewriteQuestion ?? rewriteWikiQuestion)({
        question: request.userText,
        history: rewriteHistory,
        actionKind: wikiTarget.actionKind,
        model: input.model,
        providerConfig: input.providerConfig,
        contextWindowTokens: input.contextWindowTokens,
        signal: controller.signal,
      });
      resolvedQuestion = rewritten.rewrite;
      resolvedSubQuestions = rewritten.subQuestions;
      explicitSectionTitles = rewritten.explicitSectionTitles;
      scopeDecision = resolveWikiScopeDecision({
        actionKind: wikiTarget.actionKind,
        userText: request.userText,
        suggestedMode: rewritten.scopeIntent,
      });
      input.onDetailedTrace({
        stage: 'rewrite',
        action: 'wiki-query-rewrite',
        status: 'completed',
        elapsedMs: rewritten.elapsedMs,
        output: {
          rewrite: rewritten.rewrite,
          shouldSplit: rewritten.shouldSplit,
          subQuestions: rewritten.subQuestions,
          scopeIntent: scopeDecision.mode,
          explicitSectionTitles: rewritten.explicitSectionTitles,
          ...(rewritten.guardTriggered ? { guardTriggered: rewritten.guardTriggered } : {}),
        },
      });
      emitToolEvent({ tool: 'rewrite_question', state: 'completed', message: `问题已解析：${resolvedQuestion}` });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const rawOutput = error instanceof WikiQueryRewriteError ? error.rawOutput : undefined;
      const errorCode = error instanceof WikiQueryRewriteError ? error.code : 'rewrite-error';
      input.onDetailedTrace({
        stage: 'rewrite',
        action: 'wiki-query-rewrite',
        status: 'rejected',
        elapsedMs: Math.max(0, Date.now() - rewriteStartedAt),
        errorCode,
        error: error instanceof Error ? error.message : String(error),
        ...(rawOutput !== undefined ? { output: { rawOutput } } : {}),
      });
      emitToolEvent({ tool: 'rewrite_question', state: 'rejected', message: '问题解析失败，已回退原问题与确定性范围。' });
    }
  }

  const scopeState = createWikiScopeState({
    decision: scopeDecision,
    documentId: wikiTarget.documentId,
    anchorNodeId: wikiTarget.nodeId,
    subtreeHeadingIds: sectionNodeIds,
    anchorIsRoot: isRoot,
  });
  const scopePolicy = createWikiScopePolicy(scopeState);
  input.onDetailedTrace({
    stage: 'routing',
    action: 'wiki-scope-decision',
    status: 'completed',
    output: {
      mode: scopeDecision.mode,
      reason: scopeDecision.reason,
      initialScope: resolveInitialWikiScope(scopeDecision, isRoot),
      documentSearchAvailable: scopePolicy.documentSearchAvailable,
      maxRetrievalCycles: scopeState.maxRetrievalCycles,
    },
  });

  let attachmentContext = '';
  if (request.attachments?.length) {
    const attachmentStartedAt = Date.now();
    emitToolEvent({ tool: 'read_attachments', state: 'started', message: '正在读取并解析本轮附件…' });
    input.onDetailedTrace({
      stage: 'context-tool',
      action: 'read_attachments',
      status: 'started',
      input: { attachments: request.attachments.map((attachment) => ({ attachmentId: attachment.attachmentId, kind: attachment.kind, name: attachment.name, sizeBytes: attachment.sizeBytes })) },
    });
    const documentParseSession = await parseAssistantDocumentAttachments(request.attachments, {
      signal: controller.signal,
      ...(input.mineru ? { mineru: input.mineru } : {}),
      onProgress: emitStatus,
    });
    try {
    const attachmentProvider = new AttachmentContextProvider(request.attachments, {
      documentTextByAttachmentId: documentParseSession.documentTextByAttachmentId,
      documentImagesByAttachmentId: documentParseSession.documentImagesByAttachmentId,
    });
    const metadata = attachmentProvider.listMetadata();
    emitToolEvent({
      tool: 'read_attachments',
      state: 'completed',
      message: documentParseSession.documentTextByAttachmentId.size ? `已解析 ${documentParseSession.documentTextByAttachmentId.size} 个文档附件。` : '附件已读取。',
      outputSummary: `${metadata.length} 个附件可用于本轮回答`,
      elapsedMs: Math.max(0, Date.now() - attachmentStartedAt),
    });
    input.onDetailedTrace({
      stage: 'context-tool',
      action: 'read_attachments',
      status: 'completed',
      output: { attachmentCount: metadata.length, parsedDocumentIds: [...documentParseSession.documentTextByAttachmentId.keys()] },
      elapsedMs: Math.max(0, Date.now() - attachmentStartedAt),
    });

    emitToolEvent({ tool: 'search_attachment', state: 'started', message: '正在搜索本轮附件…' });
    const attachmentHits = attachmentProvider.search(resolvedQuestion);
    emitToolEvent({ tool: 'search_attachment', state: 'completed', message: `已定位 ${attachmentHits.length} 个相关附件范围。`, outputSummary: `${attachmentHits.length} 个命中范围` });
    const attachmentReads = attachmentHits.length
      ? (() => {
        emitToolEvent({ tool: 'read_attachment_range', state: 'started', message: `正在读取 ${attachmentHits.length} 个附件命中范围…` });
        return attachmentHits.map((hit) => attachmentProvider.readRange(hit));
      })()
      : [];
    if (attachmentHits.length) {
      emitToolEvent({ tool: 'read_attachment_range', state: 'completed', message: `已读取 ${attachmentReads.length} 个有界附件范围。`, outputSummary: `${attachmentReads.length} 个范围` });
    }
    const explicitImageBytes = request.attachments.reduce((total, attachment) => total + (attachment.kind === 'image' ? attachment.sizeBytes : 0), 0);
    const materializedDocumentImages = materializeAssistantDocumentImages(
      attachmentProvider.selectDocumentImages(attachmentReads, resolvedQuestion),
      {
        maxTotalBytes: Math.max(0, maxAssistantImageTotalBytes - explicitImageBytes),
        excludedSha256: collectAiTransportImageHashes(turnImages),
      },
    );
    turnImages.push(...materializedDocumentImages.map((item) => item.transport));
    attachmentContext = [
      '<attachment_context>',
      ...metadata.map(renderAttachmentMetadata),
      ...attachmentReads.map(renderAttachmentRange),
      ...(materializedDocumentImages.length
        ? [renderDocumentImageTransportIndex(materializedDocumentImages.map((item) => item.source), request.attachments.filter((attachment) => attachment.kind === 'image').length)]
        : []),
      '</attachment_context>',
    ].join('\n\n');
    } finally {
      documentParseSession.dispose();
    }
  }

  const rerankRuntime = resolveRerankRuntime(input.store);
  const libraryStats = readMaterialDocumentIndexStats(wikiTarget.libraryPath, wikiTarget.documentId);
  const documentSearchAvailable = scopePolicy.documentSearchAvailable;
  const capabilities: WikiAgentCapabilities = {
    // 文档级父块索引存在即认为语义检索可用；否则 wiki_node_search 退化为关键词召回。
    semanticSearch: libraryStats.parentChunks > 0,
    keywordSearch: true,
    // 字面检索基于内存投影的节点 markdown，无需向量索引，始终可用。
    literalSearch: true,
    deepRead: true,
    documentSearch: documentSearchAvailable,
  };

  const budget = wikiTarget.actionKind === 'summarize'
    ? WIKI_NODE_SUMMARY_REACT_BUDGET
    : WIKI_NODE_REACT_BUDGET;
  const session = new KnowledgeAgentSessionState({
    maxSingleObservationChars: budget.maxSingleObservationChars,
    maxTotalObservationTokens: budget.maxTotalObservationTokens,
  });

  const prepareQueryContext = (query: string) => input.prepareMaterialSearchContext(wikiTarget.libraryPath, query);
  const knowledgeBaseImageResolver = new KnowledgeBaseImageResolver(wikiTarget.libraryPath, {
    documents: document ? [document] : [],
    initialImages: turnImages,
  });
  const nodeVisuals = knowledgeBaseImageResolver.resolve([{
    documentId: wikiTarget.documentId,
    text: nodeMarkdown,
    sourceText: nodeMarkdown,
  }]);
  nodeMarkdown = nodeVisuals.evidence[0]?.text ?? nodeMarkdown;
  turnImages.push(...nodeVisuals.images);
  const nodeVisualIndex = renderKnowledgeBaseImageTransportIndex(nodeVisuals.mappings);
  if (nodeVisualIndex) attachmentContext = [attachmentContext, nodeVisualIndex].filter(Boolean).join('\n\n');

  const toolContext: WikiToolContext = {
    libraryPath: wikiTarget.libraryPath,
    documentId: wikiTarget.documentId,
    documentName,
    nodeId: wikiTarget.nodeId,
    sectionNodeIds,
    outlineNodes: outline.nodes,
    scopeState,
    scopePolicy,
    session,
    signal: controller.signal,
    prepareQueryContext,
    rerank: { enabled: rerankRuntime.enabled, adapter: rerankRuntime.adapter },
    resolveEvidenceVisuals: (evidence) => knowledgeBaseImageResolver.resolve(evidence),
    onStage: emitStatus,
    onScopeTrace: (entry) => {
      input.onDetailedTrace({
        stage: 'react-tool',
        action: entry.action,
        status: entry.status,
        ...(entry.output ? { output: entry.output } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      });
    },
  };

  const scopedNodeSearchTool = createWikiScopedSearchTool(wikiNodeSearchTool, 'subtree');
  const scopedGrepNodeTool = createWikiScopedSearchTool(wikiGrepNodeTool, 'subtree');
  const scopedDocumentSearchTool = createWikiScopedSearchTool(wikiSearchDocumentTool, 'document');
  const registry = new ReActToolRegistry<WikiToolContext>();
  registry.register(scopedNodeSearchTool);
  registry.register(scopedGrepNodeTool);
  registry.register(wikiReadNodeTool);
  registry.register(wikiGetNodeInfoTool);
  if (documentSearchAvailable) registry.register(scopedDocumentSearchTool);

  // 节点直载块（方案 §3.3）：≤6,000 字符全文注入（引用 [0]），否则头尾节选并强制走工具。
  const contentBlock = buildWikiNodeContentBlock(nodeMarkdown);
  const summaryPolicy = wikiTarget.actionKind === 'summarize'
    ? resolveWikiSummaryPolicy(contentBlock.totalChars)
    : undefined;
  const systemPrompt = buildWikiNodeAgentSystemPrompt({
    documentName,
    nodeTitle: node.title,
    nodePath,
    capabilities,
    actionKind: wikiTarget.actionKind,
    scopeMode: scopeDecision.mode,
    summaryPolicy,
  });
  const runtimeContext = buildWikiRuntimeContext({
    documentName,
    nodeTitle: node.title,
    nodePath,
    childTitles,
    nodeChars: contentBlock.totalChars,
    truncated: !contentBlock.full,
    capabilities,
    scopeMode: scopeDecision.mode,
    scopeReason: scopeDecision.reason,
  });

  const runFallback = async (reason: string): Promise<WikiNodeAgentTurnOutcome> => {
    emitDeltaReset();
    emitStatus('原生工具链不可用，正在执行受控循环检索完成回答…');
    input.onDetailedTrace({ stage: 'react', action: 'wiki-fallback', status: 'started', output: { reason } });

    const fallbackQueries = buildWikiFallbackQueries({
      originalQuestion: request.userText,
      resolvedQuestion,
      subQuestions: resolvedSubQuestions,
      explicitSectionTitles,
    });
    const observations: string[] = [];
    let queryIndex = 0;
    let retryCurrentQueryInDocument = false;
    let currentQueryHasEvidence = false;
    let everyCompletedQueryHasEvidence = true;
    while (queryIndex < fallbackQueries.length && scopeState.retrievalCycleCount < scopeState.maxRetrievalCycles) {
      if (controller.signal.aborted) throw new Error('Wiki 节点问答已取消。');
      const query = fallbackQueries[queryIndex]!;
      const useDocumentSearch = !isRoot && documentSearchAvailable && (
        retryCurrentQueryInDocument
        || scopeState.documentScopeEntered
        || scopeState.mode === 'document-first'
      );
      const activeTool = useDocumentSearch ? scopedDocumentSearchTool : scopedNodeSearchTool;
      const rangeLabel = useDocumentSearch ? '本文其他章节' : '当前章节及其子章节';
      const cycleBefore = scopeState.retrievalCycleCount;
      const searchStartedAt = Date.now();
      scopePolicy.startModelDecision();
      emitToolEvent({
        tool: 'knowledge_agent_search',
        state: 'started',
        message: `正在${rangeLabel}执行第 ${cycleBefore + 1}/${scopeState.maxRetrievalCycles} 次受控检索…`,
        wikiScopeProgress: buildWikiScopeProgress({
          phase: 'searching',
          range: useDocumentSearch ? 'document' : 'subtree',
          scopeDecision,
          scopeState,
          currentCycle: cycleBefore + 1,
        }),
      });
      try {
        const search = await activeTool.execute({ queries: [query] }, toolContext);
        observations.push(search.observation);
        if (search.images?.length) turnImages.push(...search.images);
        emitToolEvent({
          tool: 'knowledge_agent_search',
          state: search.ok ? 'completed' : 'rejected',
          message: search.message,
          ...(search.referenceCount !== undefined ? { outputSummary: `新增引用 ${search.referenceCount} 条` } : {}),
          wikiScopeProgress: buildWikiScopeProgress({
            phase: 'completed',
            range: useDocumentSearch ? 'document' : 'subtree',
            scopeDecision,
            scopeState,
            ...(search.referenceCount !== undefined ? { newEvidenceCount: search.referenceCount } : {}),
          }),
          elapsedMs: Math.max(0, Date.now() - searchStartedAt),
        });
        if ((search.referenceCount ?? 0) > 0) {
          currentQueryHasEvidence = true;
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        observations.push(`<search_results />\n<retrieval_note>第 ${cycleBefore + 1} 次检索失败：${escapeFallbackText(message)}。</retrieval_note>`);
        emitToolEvent({
          tool: 'knowledge_agent_search',
          state: 'rejected',
          message: `第 ${cycleBefore + 1} 次受控检索失败：${message}`,
          wikiScopeProgress: buildWikiScopeProgress({
            phase: 'completed',
            range: useDocumentSearch ? 'document' : 'subtree',
            scopeDecision,
            scopeState,
            newEvidenceCount: 0,
          }),
          elapsedMs: Math.max(0, Date.now() - searchStartedAt),
        });
      }

      if (!currentQueryHasEvidence && !useDocumentSearch && scopePolicy.canEscalateToDocument()) {
        retryCurrentQueryInDocument = true;
        continue;
      }
      if (!currentQueryHasEvidence) everyCompletedQueryHasEvidence = false;
      currentQueryHasEvidence = false;
      retryCurrentQueryInDocument = false;
      queryIndex += 1;
    }
    if (controller.signal.aborted) throw new Error('Wiki 节点问答已取消。');

    if (queryIndex >= fallbackQueries.length && everyCompletedQueryHasEvidence && fallbackQueries.length > 0) {
      scopePolicy.markEvidenceSufficient();
    } else if (scopeState.retrievalCycleCount >= scopeState.maxRetrievalCycles) {
      scopePolicy.markCycleLimit();
    } else if (!scopeState.stopReason) {
      scopePolicy.markNoNewQuery();
    }
    const searchObservation = observations.length > 0
      ? observations.join('\n\n')
      : '<search_results />\n<retrieval_note>没有新的合法查询路径，只能依据本轮已有证据与直载章节内容作答。</retrieval_note>';
    const finalScopeLabel = scopeState.documentScopeEntered ? '当前文档范围' : '当前章节范围';
    const fallbackPrefix = `> 检索能力受限：已执行 ${scopeState.retrievalCycleCount}/${scopeState.maxRetrievalCycles} 次受控检索，最终范围为${finalScopeLabel}。`;

    const fallbackSystemPrompt = buildWikiNodeFallbackSystemPrompt({
      documentName,
      nodeTitle: node.title,
      nodePath,
      actionKind: wikiTarget.actionKind,
      summaryPolicy,
      retrievalCycles: scopeState.retrievalCycleCount,
      documentSearchUsed: scopeState.documentSearchCount > 0,
    });
    const fallbackUserPrompt = buildWikiAgentQuestion({
      userQuestion: request.userText,
      resolvedQuestion,
      wikiContext: runtimeContext,
      nodeContent: contentBlock.text,
      conversation: request.conversation,
      ...(attachmentContext ? { attachmentContext } : {}),
      fallbackSearchResults: searchObservation,
    });
    const combinedPrompt = `${fallbackSystemPrompt}\n\n${fallbackUserPrompt}`;
    const prepared = input.modelCallCoordinator.prepare({ callKind: 'direct', prompt: combinedPrompt });
    if (!prepared.ready) throw new ModelCallPreparationError(prepared.reason);

    emitDelta(`${fallbackPrefix}\n\n`);
    const generation = await (input.streamAnswer ?? streamKnowledgeAnswer)({
      question: request.userText,
      conversation: request.conversation,
      sources: [],
      prompt: combinedPrompt,
      systemPrompt: fallbackSystemPrompt,
      userPrompt: fallbackUserPrompt,
      temperature: resolveAssistantAnswerTemperature({ grounded: true }),
      model: input.model,
      signal: controller.signal,
      providerConfig: input.providerConfig,
      thinkingMode: request.thinkingMode,
      ...(turnImages.length ? { images: turnImages } : {}),
      answerDepth: request.answerDepth,
      ...(summaryPolicy ? { maxOutputTokens: summaryPolicy.maxOutputTokens } : {}),
      contextWindowTokens: input.contextWindowTokens,
      preparedModelCall: prepared.call,
      modelCallKind: 'direct',
      contextRuntimeRoute: 'knowledge-base',
      contextRuntimeScope: {
        libraryId: wikiTarget.libraryPath,
        turnId: request.requestId,
      },
      onDelta: emitDelta,
      onThinkingDelta: emitThinkingDelta,
    });
    const rawAnswer = `${fallbackPrefix}\n\n${generation.answer}`;
    const guardedAnswer = guardWikiDirectEvidenceAnswer({
      answer: rawAnswer,
      question: resolvedQuestion,
      nodeMarkdown,
      actionKind: wikiTarget.actionKind,
      ledgerEntries: session.ledgerEntries(),
      searchedDocument: scopeState.documentScopeEntered,
      evidenceToolSatisfied: scopeState.retrievalCycleCount > 0 || session.ledgerEntries().some(isWikiEvidenceEntry),
    });
    const answer = guardedAnswer.answer;
    if (guardedAnswer.corrected) {
      emitDeltaReset();
      emitDelta(answer);
      input.onDetailedTrace({
        stage: 'result',
        action: 'wiki-direct-evidence-guard',
        status: 'completed',
        output: guardedAnswer.assessment,
      });
    }
    const projected = projectWikiCitations({
      answer,
      ledgerEntries: session.ledgerEntries(),
      nodeMarkdown,
      nodeBreadcrumb,
      documentName,
      nodeTitle: node.title,
      sourcePath,
      anchorNodeId: wikiTarget.nodeId,
      outlineNodes: outline.nodes,
    });
    const completeness = resolveWikiCompleteness(projected.knowledgeBaseCitations.length, scopeState.stopReason);
    const wikiScopeResult = buildWikiScopeResult({
      scopeDecision,
      scopeState,
      nodeBreadcrumb,
      outlineNodes: outline.nodes,
      ledgerEntries: session.ledgerEntries(),
      citations: projected.knowledgeBaseCitations,
      anchorNodeId: wikiTarget.nodeId,
    });
    const wikiDraft = await createWikiDraft({
      input,
      answer,
      nodeTitle: node.title,
      nodePath,
      nodeMarkdown,
      emitStatus,
    });
    const metrics: WikiNodeAgentTurnMetrics = {
      rounds: 0,
      modelCalls: 1,
      toolCalls: scopeState.retrievalCycleCount,
      stopReason: 'degraded-fallback',
      stopDetail: reason,
      evidenceParentChunks: session.ledgerEntries().length,
      retrievalCycles: scopeState.retrievalCycleCount,
      maxRetrievalCycles: scopeState.maxRetrievalCycles,
      finalScope: scopeState.documentScopeEntered ? 'document' : 'subtree',
      ...(scopeState.stopReason ? { scopeStopReason: scopeState.stopReason } : {}),
    };
    input.onDetailedTrace({
      stage: 'result',
      action: 'wiki-scope-result',
      status: 'completed',
      output: { ...wikiScopeResult, completeness },
    });
    input.onDetailedTrace({
      stage: 'react',
      action: 'wiki-fallback',
      status: 'completed',
      output: {
        reason,
        evidenceParentChunks: metrics.evidenceParentChunks,
        retrievalCycles: metrics.retrievalCycles,
        maxRetrievalCycles: metrics.maxRetrievalCycles,
        finalScope: metrics.finalScope,
        scopeStopReason: metrics.scopeStopReason,
      },
    });
    return {
      degraded: true,
      metrics,
      result: {
        type: 'answer',
        answer,
        provider: input.provider,
        model: input.model,
        sourceNotes: projected.sourceNotes,
        knowledgeBaseCitations: projected.knowledgeBaseCitations,
        retrievalMode: 'hybrid',
        interactionRoute: 'react',
        completeness,
        wikiScopeResult,
        toolEvents,
        executionElapsedMs: Math.max(0, Date.now() - executionStartedAt),
        contextUsage: generation.contextUsage,
        wikiDraft,
        retrievalWarning: `检索能力受限：原生工具链不可用或运行异常，本轮已执行 ${metrics.retrievalCycles}/${metrics.maxRetrievalCycles} 次受控检索。`,
        ...(generation.thinkingText ? { thinkingText: generation.thinkingText, thinkingElapsedMs: generation.thinkingElapsedMs } : {}),
        cacheUsage: {
          providerReported: generation.contextUsage.source === 'provider' && generation.contextUsage.cachedInputTokens !== undefined,
          ...(generation.contextUsage.cachedInputTokens !== undefined ? { cachedInputTokens: generation.contextUsage.cachedInputTokens } : {}),
        },
      },
    };
  };

  const transport = input.transport ?? createReActChatTransport(input.providerConfig, input.model);
  if (!transport) {
    input.onDetailedTrace({ stage: 'react', action: 'transport', status: 'rejected', error: '当前模型不支持原生工具调用，已切换 Wiki 限定检索流水线。' });
    return runFallback('transport-unavailable');
  }

  // 历史：复用渲染进程提供且已校验的会话上下文（≤6 条），保持多轮追问连续。
  const history: ReActChatMessage[] = request.conversation.map((message) => ({ role: message.role, content: message.content }));
  const question = buildWikiAgentQuestion({
    userQuestion: request.userText,
    resolvedQuestion,
    wikiContext: runtimeContext,
    nodeContent: contentBlock.text,
    ...(attachmentContext ? { attachmentContext } : {}),
  });

  // Wiki has an evidence gate after each model response. Keep a candidate
  // answer private until that gate accepts it; otherwise a rejected candidate
  // appears complete in the UI, is cleared, and looks like a second generation.
  let pendingAnswerDeltas = '';
  let visibleStreamedAnswerChars = 0;
  let visibleAnswerPublished = false;
  let lastRejectedFinalAnswerCycle: number | null = null;
  const discardPendingAnswer = () => { pendingAnswerDeltas = ''; };
  const publishPendingAnswer = () => {
    if (!pendingAnswerDeltas) return;
    visibleStreamedAnswerChars += pendingAnswerDeltas.length;
    visibleAnswerPublished = true;
    emitDelta(pendingAnswerDeltas);
    pendingAnswerDeltas = '';
  };
  const resetPendingOrVisibleAnswer = () => {
    pendingAnswerDeltas = '';
    if (!visibleAnswerPublished) return;
    visibleAnswerPublished = false;
    visibleStreamedAnswerChars = 0;
    emitDeltaReset();
  };

  let loopResult;
  try {
    loopResult = await runReActLoop<WikiToolContext>({
      systemPrompt,
      history,
      question,
      ...(turnImages.length ? { images: turnImages } : {}),
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
      ...(summaryPolicy ? { maxOutputTokens: summaryPolicy.maxOutputTokens } : {}),
      onModelCall: ({ serializedPromptText }) => {
        const prepared = input.modelCallCoordinator.prepare({ callKind: 'direct', prompt: serializedPromptText });
        return prepared.ready
          ? { ready: true, maxPromptTokens: prepared.call.plan.maxPromptTokens }
          : { ready: false, reason: prepared.reason };
      },
      onModelRound: (modelRound) => {
        if (modelRound.state === 'started') {
          scopePolicy.startModelDecision();
          discardPendingAnswer();
        }
        emitModelEvent(projectReActModelRoundEvent(modelRound));
      },
      onBeforeFinalAnswer: ({ answer, citations }) => {
        const directEvidence = assessWikiDirectEvidence({
          question: resolvedQuestion,
          nodeMarkdown,
          answer,
          actionKind: wikiTarget.actionKind,
        });
        const alignedRetrievedEvidence = selectQuestionAlignedRetrievedEvidence({
          question: resolvedQuestion,
          actionKind: wikiTarget.actionKind,
          ledgerEntries: citations,
        });
        const retrievedEvidenceSufficient = alignedRetrievedEvidence.length > 0;
        const retrievedEvidenceCited = alignedRetrievedEvidence.some((entry) => answer.includes(entry.reference));
        const evidenceToolSatisfied = !directEvidence.requiresEvidence || retrievedEvidenceSufficient;
        const evidenceSufficient = !directEvidence.requiresEvidence || retrievedEvidenceSufficient;
        let decision = scopePolicy.evaluateFinalAnswer({
          zeroCycleEvidenceSufficient: evidenceToolSatisfied && evidenceSufficient,
          retrievedEvidenceSufficient: evidenceToolSatisfied && evidenceSufficient,
        });

        // A provider may ignore a corrective nudge and return another terminal
        // answer without performing the requested search. Permit only one such
        // correction at the same retrieval-cycle count; the deterministic
        // evidence guard below will then repair citations or return not-found.
        let boundedRepeatedFinalAnswer = false;
        if (!decision.accept) {
          if (lastRejectedFinalAnswerCycle === scopeState.retrievalCycleCount) {
            scopePolicy.markNoNewQuery();
            decision = { accept: true, stopReason: 'no-new-query' };
            boundedRepeatedFinalAnswer = true;
            input.onDetailedTrace({
              stage: 'routing',
              action: 'wiki-final-answer-repeat-bound',
              status: 'completed',
              output: {
                cycles: scopeState.retrievalCycleCount,
                maxCycles: scopeState.maxRetrievalCycles,
                reason: 'model-returned-terminal-answer-without-new-search',
              },
            });
          } else {
            lastRejectedFinalAnswerCycle = scopeState.retrievalCycleCount;
          }
        }
        if (!decision.accept) {
          discardPendingAnswer();
          emitStatus(`现有证据仍不足，准备继续检索（${scopeState.retrievalCycleCount}/${scopeState.maxRetrievalCycles}）…`);
          input.onDetailedTrace({
            stage: 'routing',
            action: 'wiki-final-answer-gate',
            status: 'rejected',
            output: {
              cycles: scopeState.retrievalCycleCount,
              maxCycles: scopeState.maxRetrievalCycles,
              scope: scopeState.documentScopeEntered ? 'document' : 'subtree',
              directEvidence,
              retrievedEvidenceSufficient,
              retrievedEvidenceCited,
            },
            error: decision.message,
          });
        } else {
          const guardedCandidate = guardWikiDirectEvidenceAnswer({
            answer,
            question: resolvedQuestion,
            nodeMarkdown,
            actionKind: wikiTarget.actionKind,
            ledgerEntries: citations,
            searchedDocument: scopeState.documentScopeEntered,
            evidenceToolSatisfied,
          });
          if (guardedCandidate.corrected) discardPendingAnswer();
          else publishPendingAnswer();
        }
        return {
          accept: decision.accept,
          ...(decision.message ? { nudge: decision.message } : {}),
          detail: {
            cycles: scopeState.retrievalCycleCount,
            maxCycles: scopeState.maxRetrievalCycles,
            scope: scopeState.documentScopeEntered ? 'document' : 'subtree',
            directEvidenceLikely: directEvidence.likelySupported,
            directCitationPresent: directEvidence.directCitationPresent,
            retrievedEvidenceSufficient,
            retrievedEvidenceCited,
            evidenceToolSatisfied,
            ...(boundedRepeatedFinalAnswer ? { boundedRepeatedFinalAnswer: true } : {}),
            ...(decision.stopReason ? { stopReason: decision.stopReason } : {}),
          },
        };
      },
      onRound: (roundEvent) => {
        if (roundEvent.state === 'rejected' || roundEvent.state === 'failed') {
          scopePolicy.noteRejectedSearch(roundEvent.tool, roundEvent.message);
        }
        const searchRange = resolveWikiToolSearchRange(roundEvent.tool);
        const mapped: CurrentNotePublicToolEvent = {
          tool: WIKI_AGENT_TOOL_EVENT_NAMES[roundEvent.tool] ?? 'knowledge_agent_search',
          state: roundEvent.state === 'failed' ? 'rejected' : roundEvent.state,
          message: roundEvent.message,
          round: roundEvent.round,
          ...(roundEvent.referenceCount !== undefined ? { outputSummary: `新增引用 ${roundEvent.referenceCount} 条` } : {}),
          ...(roundEvent.publicResults?.length ? { publicResults: roundEvent.publicResults } : {}),
          ...(searchRange ? {
            wikiScopeProgress: buildWikiScopeProgress({
              phase: roundEvent.state === 'started' ? 'searching' : 'completed',
              range: searchRange,
              scopeDecision,
              scopeState,
              ...(roundEvent.state === 'started'
                ? { currentCycle: scopeState.retrievalCycleCount + 1 }
                : {}),
              ...(roundEvent.referenceCount !== undefined ? { newEvidenceCount: roundEvent.referenceCount } : {}),
            }),
          } : {}),
          ...(roundEvent.elapsedMs !== undefined ? { elapsedMs: roundEvent.elapsedMs } : {}),
        };
        emitToolEvent(mapped);
      },
      onTrace: (entry) => {
        input.onDetailedTrace({ stage: 'react', action: entry.action, status: entry.status, ...(entry.detail ? { output: entry.detail } : {}) });
      },
      collectCitations: () => session.ledgerEntries(),
      onAnswerDelta: (text) => { pendingAnswerDeltas += text; },
      onThinkingDelta: emitThinkingDelta,
      onAnswerReset: resetPendingOrVisibleAnswer,
    });
  } catch (error) {
    if (controller.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    input.onDetailedTrace({ stage: 'react', action: 'loop', status: 'failed', error: message });
    return runFallback(`agent-error: ${message}`);
  }

  if (loopResult.stopReason === 'budget-synthesized' && !scopeState.stopReason) {
    scopePolicy.noteBudgetExhausted();
  }

  const guardedAnswer = guardWikiDirectEvidenceAnswer({
    answer: loopResult.finalAnswer,
    question: resolvedQuestion,
    nodeMarkdown,
    actionKind: wikiTarget.actionKind,
    ledgerEntries: loopResult.citations,
    searchedDocument: scopeState.documentScopeEntered,
    evidenceToolSatisfied: scopeState.retrievalCycleCount > 0 || loopResult.citations.some(isWikiEvidenceEntry),
  });
  const answer = guardedAnswer.answer;
  // 引擎已流式投影的部分不重发；未提供流式回调时全量补发。
  if (guardedAnswer.corrected) {
    resetPendingOrVisibleAnswer();
    input.onDetailedTrace({
      stage: 'result',
      action: 'wiki-direct-evidence-guard',
      status: 'completed',
      output: guardedAnswer.assessment,
    });
  }
  const streamedChars = guardedAnswer.corrected ? 0 : Math.min(visibleStreamedAnswerChars, answer.length);
  for (let index = streamedChars; index < answer.length; index += 64) {
    emitDelta(answer.slice(index, index + 64));
  }

  // 引用投影（方案 §4.6）：[0] 为节点直载全文，工具证据取台账 [n]（n≥1）。
  // nodePath 取当前节点面包屑：Wiki 作用域检索默认锁定本章节子树，证据归属该章节路径；
  // cross-links 的跨节点证据亦以锚点节点路径展开（P4 简化，不做逐块章节归属）。
  const projected = projectWikiCitations({
    answer,
    ledgerEntries: loopResult.citations,
    nodeMarkdown,
    nodeBreadcrumb,
    documentName,
    nodeTitle: node.title,
    sourcePath,
    anchorNodeId: wikiTarget.nodeId,
    outlineNodes: outline.nodes,
  });
  const { knowledgeBaseCitations, sourceNotes } = projected;

  if (scopeState.stopReason === 'budget-exhausted' && hasQuestionAlignedRetrievedEvidence({
    question: resolvedQuestion,
    actionKind: wikiTarget.actionKind,
    ledgerEntries: loopResult.citations,
  })) {
    scopePolicy.markEvidenceSufficient();
    input.onDetailedTrace({
      stage: 'result',
      action: 'wiki-post-synthesis-evidence-reconciliation',
      status: 'completed',
      output: { previousStopReason: 'budget-exhausted', reconciledStopReason: 'evidence-sufficient' },
    });
  }

  const completeness = resolveWikiCompleteness(knowledgeBaseCitations.length, scopeState.stopReason);
  const wikiScopeResult = buildWikiScopeResult({
    scopeDecision,
    scopeState,
    nodeBreadcrumb,
    outlineNodes: outline.nodes,
    ledgerEntries: loopResult.citations,
    citations: knowledgeBaseCitations,
    anchorNodeId: wikiTarget.nodeId,
  });

  // 上下文窗口用量：优先取服务商上报，否则回退末次 prompt 本地估算 + 回答估算。
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

  const metrics: WikiNodeAgentTurnMetrics = {
    rounds: loopResult.rounds,
    modelCalls: loopResult.modelCalls,
    toolCalls: loopResult.toolCalls,
    stopReason: loopResult.stopReason,
    ...(loopResult.stopDetail ? { stopDetail: loopResult.stopDetail } : {}),
    evidenceParentChunks: session.ledgerEntries().length,
    retrievalCycles: scopeState.retrievalCycleCount,
    maxRetrievalCycles: scopeState.maxRetrievalCycles,
    finalScope: scopeState.documentScopeEntered ? 'document' : 'subtree',
    ...(scopeState.stopReason ? { scopeStopReason: scopeState.stopReason } : {}),
  };

  input.onDetailedTrace({
    stage: 'result',
    action: 'wiki-scope-result',
    status: 'completed',
    output: { ...wikiScopeResult, completeness },
  });

  const wikiDraft = await createWikiDraft({
    input,
    answer,
    nodeTitle: node.title,
    nodePath,
    nodeMarkdown,
    emitStatus,
  });

  return {
    metrics,
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
      wikiScopeResult,
      toolEvents,
      modelEvents,
      executionElapsedMs: Math.max(0, Date.now() - executionStartedAt),
      contextUsage,
      wikiDraft,
      cacheUsage: {
        providerReported: contextUsage.source === 'provider' && contextUsage.cachedInputTokens !== undefined,
        ...(contextUsage.cachedInputTokens !== undefined ? { cachedInputTokens: contextUsage.cachedInputTokens } : {}),
      },
    },
  };
}

async function createWikiDraft(input: {
  input: WikiNodeAgentTurnInput;
  answer: string;
  nodeTitle: string;
  nodePath: string;
  nodeMarkdown: string;
  emitStatus: (message: string) => void;
}): Promise<AssistantWikiDraft> {
  const { input: turnInput } = input;
  let proposedChildren: AssistantWikiDraftChild[] = [];
  if (turnInput.wikiTarget.actionKind === 'split-children' && !turnInput.controller.signal.aborted) {
    input.emitStatus('正在提炼可拆分的子节点…');
    try {
      proposedChildren = await generateWikiSplitProposal({
        nodeTitle: input.nodeTitle,
        nodePath: input.nodePath,
        nodeMarkdown: input.nodeMarkdown,
        answer: input.answer,
        model: turnInput.model,
        providerConfig: turnInput.providerConfig,
        contextWindowTokens: turnInput.contextWindowTokens,
        signal: turnInput.controller.signal,
        onRawOutput: (raw) => turnInput.onDetailedTrace({
          stage: 'react',
          action: 'wiki-split-proposal',
          status: 'completed',
          output: { rawOutput: raw.slice(0, 2_000) },
        }),
      });
    } catch (error) {
      if (turnInput.controller.signal.aborted) throw error;
      turnInput.onDetailedTrace({
        stage: 'react',
        action: 'wiki-split-proposal',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { title: input.nodeTitle, markdown: input.answer, proposedChildren };
}

function projectWikiCitations(input: {
  answer: string;
  ledgerEntries: ReActCitationLedgerEntry[];
  nodeMarkdown: string;
  nodeBreadcrumb: string[];
  documentName: string;
  nodeTitle: string;
  sourcePath: string;
  anchorNodeId: string;
  outlineNodes: WikiDocumentOutline['nodes'];
}): { knowledgeBaseCitations: AssistantKnowledgeBaseCitation[]; sourceNotes: AssistantTurnSource[] } {
  const knowledgeBaseCitations: AssistantKnowledgeBaseCitation[] = [];
  const sourceNotes: AssistantTurnSource[] = [];
  if (input.answer.includes('[0]')) {
    knowledgeBaseCitations.push({
      reference: 0,
      documentName: input.documentName,
      parentOrdinal: 0,
      content: input.nodeMarkdown.slice(0, 2_000),
      nodePath: input.nodeBreadcrumb,
      nodeId: input.anchorNodeId,
    });
    sourceNotes.push({
      path: input.sourcePath,
      reference: 0,
      parentOrdinal: 0,
      title: input.documentName,
      snippet: input.nodeMarkdown.replace(/\s+/g, ' ').trim().slice(0, 220),
      score: 1,
      methods: ['semantic'],
      sourceType: 'knowledge-base',
    });
  }
  for (const entry of input.ledgerEntries) {
    if (entry.kind === 'web' || !input.answer.includes(entry.reference)) continue;
    const reference = Number(entry.reference.replace(/[[\]]/g, ''));
    if (!Number.isFinite(reference) || reference <= 0) continue;
    const nodePath = parseWikiCitationPath(entry.sectionContext, input.nodeBreadcrumb);
    const nodeId = resolveWikiNodeIdForPath(input.outlineNodes, nodePath);
    knowledgeBaseCitations.push({
      reference,
      documentName: input.documentName,
      parentOrdinal: entry.ordinal ?? 0,
      content: entry.sourceText ?? '',
      nodePath,
      ...(nodeId ? { nodeId } : {}),
    });
    sourceNotes.push({
      path: input.sourcePath,
      reference,
      parentOrdinal: entry.ordinal ?? 0,
      title: input.documentName,
      snippet: (entry.sourceText ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
      score: entry.score ?? 0,
      methods: ['semantic'],
      sourceType: 'knowledge-base',
    });
  }
  knowledgeBaseCitations.sort((first, second) => first.reference - second.reference);
  return { knowledgeBaseCitations, sourceNotes };
}

function guardWikiDirectEvidenceAnswer(input: {
  answer: string;
  question: string;
  nodeMarkdown: string;
  actionKind: WikiActionKind;
  ledgerEntries: ReActCitationLedgerEntry[];
  searchedDocument: boolean;
  evidenceToolSatisfied: boolean;
}): { answer: string; corrected: boolean; assessment: ReturnType<typeof assessWikiDirectEvidence> } {
  const assessment = assessWikiDirectEvidence({
    question: input.question,
    nodeMarkdown: input.nodeMarkdown,
    answer: input.answer,
    actionKind: input.actionKind,
  });
  if (!assessment.requiresEvidence) {
    return { answer: input.answer, corrected: false, assessment };
  }

  const alignedRetrievedEvidence = selectQuestionAlignedRetrievedEvidence({
    question: input.question,
    actionKind: input.actionKind,
    ledgerEntries: input.ledgerEntries,
  });
  const citedRetrievedEvidence = alignedRetrievedEvidence.filter((entry) => input.answer.includes(entry.reference));
  if (!input.evidenceToolSatisfied || alignedRetrievedEvidence.length === 0) {
    return {
      answer: '本轮未完成事实性 Wiki 问答所需的章节检索或深读，无法生成有证据链的回答。请重试。',
      corrected: true,
      assessment,
    };
  }

  if (assessment.likelySupported) {
    if (citedRetrievedEvidence.length > 0) {
      return { answer: input.answer, corrected: false, assessment };
    }
    const missingReferences = alignedRetrievedEvidence.slice(0, 3).map((entry) => entry.reference);
    const references = assessment.directCitationPresent ? missingReferences : ['[0]', ...missingReferences];
    return { answer: appendWikiReferences(input.answer, references), corrected: true, assessment };
  }

  if (alignedRetrievedEvidence.length > 0) {
    const withoutUnsupportedDirectCitation = input.answer.replace(/\s*\[0\]/gu, '').trim();
    const missingReferences = alignedRetrievedEvidence
      .filter((entry) => !withoutUnsupportedDirectCitation.includes(entry.reference))
      .slice(0, 3)
      .map((entry) => entry.reference);
    const answer = appendWikiReferences(withoutUnsupportedDirectCitation, missingReferences);
    return { answer, corrected: answer !== input.answer, assessment };
  }
  const searchedRange = input.searchedDocument ? '当前文档' : '当前章节及其子章节';
  return {
    answer: `在${searchedRange}中没有找到能够支持这个问题的内容。`,
    corrected: true,
    assessment,
  };
}

function hasQuestionAlignedRetrievedEvidence(input: {
  question: string;
  actionKind: WikiActionKind;
  ledgerEntries: ReActCitationLedgerEntry[];
}): boolean {
  return selectQuestionAlignedRetrievedEvidence(input).length > 0;
}

function selectQuestionAlignedRetrievedEvidence(input: {
  question: string;
  actionKind: WikiActionKind;
  ledgerEntries: ReActCitationLedgerEntry[];
}): ReActCitationLedgerEntry[] {
  const candidates = input.ledgerEntries.filter((entry) => (
    entry.kind !== 'web'
    && Boolean(entry.reference)
    && Boolean(entry.sourceText?.trim())
  ));
  if (candidates.length === 0) return [];
  const individuallyAligned = candidates.filter((entry) => assessWikiDirectEvidence({
    question: input.question,
    nodeMarkdown: entry.sourceText ?? '',
    answer: '[0]',
    actionKind: input.actionKind,
  }).likelySupported);
  if (individuallyAligned.length > 0) return individuallyAligned;
  const combinedLikelySupported = assessWikiDirectEvidence({
    question: input.question,
    nodeMarkdown: candidates.map((entry) => entry.sourceText).join('\n'),
    answer: '[0]',
    actionKind: input.actionKind,
  }).likelySupported;
  return combinedLikelySupported ? candidates : [];
}

function appendWikiReferences(answer: string, references: string[]): string {
  const trimmed = answer.trim();
  const missing = [...new Set(references.filter((reference) => reference && !trimmed.includes(reference)))];
  if (missing.length === 0) return trimmed;
  return `${trimmed}${/[.!?。！？]$/u.test(trimmed) ? '' : '。'} ${missing.join('')}`;
}

function isWikiEvidenceEntry(entry: ReActCitationLedgerEntry): boolean {
  return entry.kind !== 'web' && Boolean(entry.reference) && Boolean(entry.sourceText?.trim());
}

function resolveWikiNodeIdForPath(outlineNodes: WikiDocumentOutline['nodes'], nodePath: string[]): string | undefined {
  if (nodePath.length === 0) return undefined;
  return outlineNodes.find((candidate) => {
    const candidatePath = getWikiNodeBreadcrumb(outlineNodes, candidate.id);
    return candidatePath.length === nodePath.length && candidatePath.every((title, index) => title === nodePath[index]);
  })?.id;
}

function resolveWikiToolSearchRange(toolName: string): WikiSearchRange | undefined {
  if (toolName === 'wiki_search_document') return 'document';
  if (toolName === 'wiki_node_search' || toolName === 'wiki_grep_node') return 'subtree';
  return undefined;
}

function buildWikiScopeProgress(input: {
  phase: AssistantWikiScopeProgress['phase'];
  range: WikiSearchRange;
  scopeDecision: WikiScopeDecision;
  scopeState: WikiScopeState;
  currentCycle?: number;
  newEvidenceCount?: number;
}): AssistantWikiScopeProgress {
  const currentCycle = Math.max(1, Math.min(
    input.currentCycle ?? input.scopeState.retrievalCycleCount,
    input.scopeState.maxRetrievalCycles,
  ));
  const escalationReason = resolvePublicEscalationReason(input.scopeDecision, input.scopeState);
  return {
    phase: input.phase,
    scopeMode: input.scopeDecision.mode,
    activeRange: input.range,
    currentCycle,
    maxRetrievalCycles: input.scopeState.maxRetrievalCycles,
    documentScopeEntered: input.scopeState.documentScopeEntered || input.range === 'document',
    localSearchCount: input.scopeState.localSearchCount + (
      input.phase === 'searching' && input.range === 'subtree' ? 1 : 0
    ),
    documentSearchCount: input.scopeState.documentSearchCount + (
      input.phase === 'searching' && input.range === 'document' ? 1 : 0
    ),
    ...(escalationReason ? { escalationReason } : {}),
    ...(input.newEvidenceCount !== undefined ? { newEvidenceCount: Math.max(0, input.newEvidenceCount) } : {}),
  };
}

function buildWikiScopeResult(input: {
  scopeDecision: WikiScopeDecision;
  scopeState: WikiScopeState;
  nodeBreadcrumb: string[];
  outlineNodes: WikiDocumentOutline['nodes'];
  ledgerEntries: ReActCitationLedgerEntry[];
  citations: AssistantKnowledgeBaseCitation[];
  anchorNodeId: string;
}): AssistantWikiScopeResult {
  const searchedSections: AssistantWikiScopeResult['searchedSections'] = [];
  const seenPaths = new Set<string>();
  const addSection = (nodePath: string[], nodeId?: string) => {
    if (nodePath.length === 0) return;
    const key = nodePath.join('\u001f');
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    searchedSections.push({ nodePath, ...(nodeId ? { nodeId } : {}) });
  };
  if (input.scopeState.localSearchCount > 0) addSection(input.nodeBreadcrumb, input.anchorNodeId);
  for (const entry of input.ledgerEntries) {
    if (entry.kind === 'web') continue;
    const nodePath = parseWikiCitationPath(entry.sectionContext, input.nodeBreadcrumb);
    addSection(nodePath, resolveWikiNodeIdForPath(input.outlineNodes, nodePath));
  }
  const usedOtherSections = input.citations.some((citation) => {
    if (!citation.nodePath || citation.nodePath.length === 0) return false;
    return !isWikiPathWithin(citation.nodePath, input.nodeBreadcrumb);
  });
  const escalationReason = resolvePublicEscalationReason(input.scopeDecision, input.scopeState);
  return {
    scopeMode: input.scopeDecision.mode,
    initialScope: resolveInitialWikiScope(input.scopeDecision, input.scopeState.anchorIsRoot),
    finalScope: input.scopeState.anchorIsRoot || input.scopeState.documentScopeEntered ? 'document' : 'subtree',
    retrievalCyclesUsed: input.scopeState.retrievalCycleCount,
    maxRetrievalCycles: input.scopeState.maxRetrievalCycles,
    localSearchCount: input.scopeState.localSearchCount,
    documentSearchCount: input.scopeState.documentSearchCount,
    usedOtherSections,
    searchedSections,
    stopReason: input.scopeState.stopReason ?? 'no-new-query',
    ...(escalationReason ? { escalationReason } : {}),
  };
}

function resolveInitialWikiScope(decision: WikiScopeDecision, anchorIsRoot: boolean): AssistantWikiScopeResult['initialScope'] {
  if (anchorIsRoot || decision.mode === 'document-first') return 'document';
  return 'subtree';
}

function resolvePublicEscalationReason(
  decision: WikiScopeDecision,
  state: WikiScopeState,
): AssistantWikiScopeResult['escalationReason'] | undefined {
  if (state.escalationReason) return state.escalationReason;
  if (decision.mode !== 'document-first') return undefined;
  return decision.reason === 'explicit-document-scope' ? 'explicit-document-scope' : 'explicit-section-reference';
}

function isWikiPathWithin(candidatePath: string[], anchorPath: string[]): boolean {
  return anchorPath.length <= candidatePath.length && anchorPath.every((title, index) => candidatePath[index] === title);
}

function resolveWikiCompleteness(
  citationCount: number,
  stopReason: WikiRetrievalStopReason | undefined,
): 'complete' | 'partial' | 'not-found' {
  if (citationCount === 0) return 'not-found';
  return stopReason === 'evidence-sufficient' ? 'complete' : 'partial';
}

function parseWikiCitationPath(sectionContext: string | undefined, fallback: string[]): string[] {
  if (!sectionContext?.trim()) return fallback;
  const pathLine = sectionContext.split(/\r?\n/u).find((line) => line.startsWith('章节路径：'));
  if (pathLine) {
    const path = pathLine
      .slice('章节路径：'.length)
      .split(/\s*(?:\/|›)\s*/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (path.length > 0) return path;
  }
  const titleLine = sectionContext.split(/\r?\n/u).find((line) => line.startsWith('章节：'));
  const title = titleLine?.slice('章节：'.length).trim();
  return title ? [...fallback.slice(0, -1), title] : fallback;
}

function escapeFallbackText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
