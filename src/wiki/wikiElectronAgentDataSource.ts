import type {
  AssistantAttachment,
  AssistantConversationMessage,
  AssistantKnowledgeBaseCitation,
  AssistantPublicModelEvent,
  AssistantTurnEvent,
  AssistantTurnRequest,
  AssistantWikiScopeProgress,
  AssistantWikiScopeResult,
  CurrentNotePublicToolEvent,
} from '../../electron/knowledge/assistantTurnTypes';
import type { WikiActionKind } from '../../electron/wiki/wikiQuickActions';
import type { WikiAiMemory, WikiDerivedNodeView, WikiNodeQuestionsResult } from '../electron';
import { assistantStreamRenderPolicy, takeAssistantStreamFrame } from '../components/assistant/useAssistantStreamBuffer';
import { createMockWikiDataSource } from './wikiMockDataSource';
import type {
  WikiBuildMode,
  WikiDataSource,
  WikiDocumentSummary,
  WikiEvent,
  WikiGenerationJob,
  WikiAiMessage,
  WikiMapNode,
  WikiNodeAiRequestOptions,
  WikiNodeCitation,
  WikiNodeQuestionsView,
  WikiRetrievalState,
  WikiSiblingOrderCommit,
  WikiWorkspaceSnapshot,
} from './wikiTypes';

/** 节点内多轮对话保留的历史消息条数上限（与主进程 IPC 契约一致：最近 6 条）。 */
const WIKI_CONVERSATION_MAX_MESSAGES = 6;
/** 单条历史消息字符上限（超长保留尾部）。 */
const WIKI_CONVERSATION_MESSAGE_CHARS = 2_000;
/** 历史消息总字符上限。 */
const WIKI_CONVERSATION_TOTAL_CHARS = 4_000;
/** 整篇自动生成为本期非目标（方案 §1）：Electron 数据源返回明确中文失败事件。 */
const WIKI_FULL_GENERATION_UNAVAILABLE = '整篇生成暂未接入，请先使用节点分析。';

/**
 * Wiki 数据源的 Electron 实现（方案 §2、§4.2）。
 *
 * - `analyzeNode` 把 assistant-turn 事件流按 requestId 过滤后映射为 `WikiEvent`，
 *   WikiView 与 UI 组件零改动消费（与 Mock 契约一致）。
 * - `cancelOperation` 维护 operationId → requestId 映射，转调 `cancelAssistantTurn`。
 * - 派生节点、整篇生成等尚未接入真实 IPC 的能力，本期委托内部 Mock 兜底或返回
 *   明确失败事件，避免真实工作区出现「假装成功」的行为漂移（P2 起逐项替换）。
 */
export class ElectronWikiDataSource implements WikiDataSource {
  private readonly fallback: WikiDataSource = createMockWikiDataSource();
  private libraryPath: string;
  private readonly activeRequestIds = new Map<string, string>();
  private readonly conversationByNode = new Map<string, AssistantConversationMessage[]>();
  private readonly memoriesById = new Map<string, WikiAiMemory>();
  private readonly activeMemoryIdByNode = new Map<string, string>();
  private currentDocumentId: string | null = null;
  private memoriesDocumentId: string | null = null;

  constructor(libraryPath: string) {
    this.libraryPath = libraryPath;
  }

  /** Rebind a copied library after migration while retaining node conversations and memory selections. */
  relocateLibrary(libraryPath: string): void {
    this.libraryPath = libraryPath;
  }

  attachWorkspace(workspace: WikiWorkspaceSnapshot): void {
    if (this.currentDocumentId !== workspace.document.id) {
      this.currentDocumentId = workspace.document.id;
      this.conversationByNode.clear();
      this.memoriesById.clear();
      this.activeMemoryIdByNode.clear();
      this.memoriesDocumentId = null;
    }
    this.fallback.attachWorkspace(workspace);
  }

  listDocuments(): Promise<WikiDocumentSummary[]> {
    return this.fallback.listDocuments();
  }

  loadWorkspace(documentId: string): Promise<WikiWorkspaceSnapshot> {
    return this.fallback.loadWorkspace(documentId);
  }

  setMode(documentId: string, mode: WikiBuildMode): Promise<void> {
    return this.fallback.setMode(documentId, mode);
  }

  startFullGeneration(): AsyncIterable<WikiEvent> {
    return this.unavailableGeneration('full-generation');
  }

  retryChapter(): AsyncIterable<WikiEvent> {
    return this.unavailableGeneration('chapter-retry');
  }

  async *analyzeNode(
    documentId: string,
    nodeId: string,
    prompt: string,
    actionKind: WikiActionKind = 'free',
    attachments: AssistantAttachment[] = [],
    options: WikiNodeAiRequestOptions = {},
  ): AsyncIterable<WikiEvent> {
    const api = requireElectronApi();
    const requestId = createWikiRequestId();
    // operationId 与 requestId 同值：cancelOperation 直接据此转调 cancelAssistantTurn。
    const operationId = requestId;
    this.activeRequestIds.set(operationId, requestId);

    await this.ensureMemoriesLoaded(documentId);
    const conversation = this.takeConversation(nodeId);
    const queue: WikiEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let seq = 0;
    const emit = (event: WikiEvent) => {
      queue.push(event);
      notify?.();
    };
    const close = () => {
      finished = true;
      notify?.();
    };
    const nextEvent = <T extends Omit<WikiEvent, 'operationId' | 'seq' | 'timestamp'>>(event: T) => {
      emit(createWikiEvent(operationId, ++seq, event));
    };

    const userMessageId = `${operationId}:user`;
    const assistantMessageId = `${operationId}:assistant`;
    const assistantMessageCreatedAt = new Date().toISOString();
    let receivedAssistantText = '';
    let renderedAssistantText = '';
    let pendingAssistantText = '';
    let toolEvents: CurrentNotePublicToolEvent[] = [];
    let modelEvents: AssistantPublicModelEvent[] = [];
    let receivedThinkingText = '';
    let renderedThinkingText = '';
    let pendingThinkingText = '';
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let finalizeTerminalMessage: (() => void) | null = null;
    let memorySave: Promise<void> | null = null;
    const emitAssistantMessage = (overrides: Partial<WikiAiMessage> = {}) => {
      nextEvent({
        type: 'message-added',
        nodeId,
        message: {
          id: assistantMessageId,
          role: 'assistant',
          content: renderedAssistantText,
          createdAt: assistantMessageCreatedAt,
          streaming: true,
          ...(toolEvents.length ? { toolEvents: [...toolEvents] } : {}),
          ...(modelEvents.length ? { modelEvents: [...modelEvents] } : {}),
          ...(renderedThinkingText ? { thinkingText: renderedThinkingText } : {}),
          ...overrides,
        },
      });
    };
    const cancelScheduledStreamFlush = () => {
      if (streamFlushTimer === null) return;
      globalThis.clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    };
    const finishTerminalMessageIfDrained = () => {
      if (pendingAssistantText || pendingThinkingText || !finalizeTerminalMessage) return;
      const finalize = finalizeTerminalMessage;
      finalizeTerminalMessage = null;
      finalize();
    };
    const scheduleStreamFlush = () => {
      if (streamFlushTimer !== null || (!pendingAssistantText && !pendingThinkingText)) return;
      streamFlushTimer = globalThis.setTimeout(() => {
        streamFlushTimer = null;
        flushStreamFrame(false);
      }, assistantStreamRenderPolicy.frameIntervalMs);
    };
    const flushStreamFrame = (flushAll: boolean) => {
      cancelScheduledStreamFlush();
      const next = flushAll
        ? {
            flush: { contentDelta: pendingAssistantText, thinkingDelta: pendingThinkingText },
            remaining: { content: '', thinking: '' },
          }
        : takeAssistantStreamFrame({ content: pendingAssistantText, thinking: pendingThinkingText });
      pendingAssistantText = next.remaining.content;
      pendingThinkingText = next.remaining.thinking;
      if (next.flush.contentDelta || next.flush.thinkingDelta) {
        renderedAssistantText += next.flush.contentDelta;
        renderedThinkingText += next.flush.thinkingDelta;
        emitAssistantMessage();
      }
      if (pendingAssistantText || pendingThinkingText) scheduleStreamFlush();
      else finishTerminalMessageIfDrained();
    };
    const reconcileTerminalText = (answer: string, thinking: string) => {
      let resetVisibleMessage = false;
      if (answer.startsWith(receivedAssistantText)) {
        pendingAssistantText += answer.slice(receivedAssistantText.length);
      } else {
        renderedAssistantText = '';
        pendingAssistantText = answer;
        resetVisibleMessage = true;
      }
      receivedAssistantText = answer;
      if (thinking.startsWith(receivedThinkingText)) {
        pendingThinkingText += thinking.slice(receivedThinkingText.length);
      } else {
        renderedThinkingText = '';
        pendingThinkingText = thinking;
        resetVisibleMessage = true;
      }
      receivedThinkingText = thinking;
      if (resetVisibleMessage) emitAssistantMessage();
    };

    const unsubscribe = api.onAssistantTurnEvent((turnEvent: AssistantTurnEvent) => {
      if (turnEvent.requestId !== requestId) return;
      switch (turnEvent.type) {
        case 'started':
          nextEvent({ type: 'operation-started', kind: 'node-analysis', nodeId });
          nextEvent({
            type: 'message-added',
            nodeId,
            message: {
              id: userMessageId,
              role: 'user',
              content: prompt,
              createdAt: new Date().toISOString(),
              ...(attachments.length ? { attachments: [...attachments] } : {}),
            },
          });
          emitAssistantMessage();
          break;
        case 'delta': {
          receivedAssistantText += turnEvent.text;
          pendingAssistantText += turnEvent.text;
          scheduleStreamFlush();
          break;
        }
        case 'delta-reset':
          // 模型转入工具调用，收回已流式输出的文本（方案 §2）。
          cancelScheduledStreamFlush();
          receivedAssistantText = '';
          renderedAssistantText = '';
          pendingAssistantText = '';
          emitAssistantMessage();
          break;
        case 'tool': {
          toolEvents = [...toolEvents, turnEvent.event];
          const retrieval = turnEvent.event.wikiScopeProgress
            ? toWikiRetrievalProgress(turnEvent.event.wikiScopeProgress)
            : undefined;
          if (retrieval) nextEvent({ type: 'retrieval-updated', nodeId, retrieval });
          emitAssistantMessage();
          break;
        }
        case 'model':
          modelEvents = [...modelEvents, turnEvent.event];
          emitAssistantMessage();
          break;
        case 'thinking-delta':
          receivedThinkingText += turnEvent.text;
          pendingThinkingText += turnEvent.text;
          scheduleStreamFlush();
          break;
        case 'complete': {
          const answer = turnEvent.result.type === 'answer' ? turnEvent.result.answer : '';
          // 引用投影（方案 §4.6）：knowledgeBaseCitations → WikiAiMessage.citations，随终答消息一并下发。
          const citations = turnEvent.result.type === 'answer'
            ? toWikiNodeCitations(turnEvent.result.knowledgeBaseCitations)
            : [];
          const retrieval = turnEvent.result.type === 'answer' && turnEvent.result.wikiScopeResult
            ? toWikiRetrievalResult(turnEvent.result.wikiScopeResult, turnEvent.result.completeness)
            : undefined;
          if (retrieval) nextEvent({ type: 'retrieval-updated', nodeId, retrieval });
          toolEvents = turnEvent.result.type === 'answer' ? turnEvent.result.toolEvents ?? toolEvents : toolEvents;
          modelEvents = turnEvent.result.type === 'answer' ? turnEvent.result.modelEvents ?? modelEvents : modelEvents;
          const finalThinkingText = turnEvent.result.type === 'answer'
            ? turnEvent.result.thinkingText ?? receivedThinkingText
            : receivedThinkingText;
          reconcileTerminalText(answer, finalThinkingText);
          memorySave = this.appendConversation(documentId, nodeId, prompt, answer);
          const wikiDraft = turnEvent.result.type === 'answer' ? turnEvent.result.wikiDraft : undefined;
          finalizeTerminalMessage = () => {
            emitAssistantMessage({
              streaming: false,
              ...(citations.length > 0 ? { citations } : {}),
              ...(retrieval ? { retrieval } : {}),
              ...(turnEvent.result.type === 'answer' && turnEvent.result.executionElapsedMs !== undefined
                ? { executionElapsedMs: turnEvent.result.executionElapsedMs }
                : {}),
              ...(turnEvent.result.type === 'answer' && turnEvent.result.thinkingElapsedMs !== undefined
                ? { thinkingElapsedMs: turnEvent.result.thinkingElapsedMs }
                : {}),
            });
            // 快捷动作草稿（方案 §5）：等终答可见缓冲排空后再展示，避免答案与草稿同时跳变。
            if (wikiDraft) {
              nextEvent({
                type: 'draft-ready',
                nodeId,
                draft: {
                  id: `${operationId}:draft`,
                  nodeId,
                  title: wikiDraft.title,
                  markdown: wikiDraft.markdown,
                  proposedChildren: wikiDraft.proposedChildren.map((child) => child.title),
                  proposedChildSummaries: wikiDraft.proposedChildren.map((child) => child.summary),
                  status: 'pending',
                },
              });
            }
            nextEvent({ type: 'operation-finished', kind: 'node-analysis', outcome: 'complete', nodeId });
            close();
          };
          if (pendingAssistantText || pendingThinkingText) scheduleStreamFlush();
          else finishTerminalMessageIfDrained();
          break;
        }
        case 'error':
          finalizeTerminalMessage = null;
          flushStreamFrame(true);
          nextEvent({ type: 'operation-finished', kind: 'node-analysis', outcome: 'failed', nodeId, error: turnEvent.message });
          close();
          break;
        case 'cancelled':
          finalizeTerminalMessage = null;
          flushStreamFrame(true);
          nextEvent({ type: 'operation-finished', kind: 'node-analysis', outcome: 'cancelled', nodeId });
          close();
          break;
        default:
          // 状态、路由、计划与建议问题不进入 Wiki 消息流；工具、模型与思考事件已在上方投影到当前回复。
          break;
      }
    });

    try {
      const request: AssistantTurnRequest = {
        requestId,
        intent: 'ask',
        scope: 'wiki-node',
        userText: prompt,
        conversation,
        ...(options.modelProfileId ? { modelProfileId: options.modelProfileId } : {}),
        ...(options.thinkingMode ? { thinkingMode: options.thinkingMode } : {}),
        ...(attachments.length ? { attachments } : {}),
        wikiTarget: { libraryPath: this.libraryPath, documentId, nodeId, actionKind },
      };
      await api.startAssistantTurn(request);
    } catch (error) {
      // startAssistantTurn 同步校验失败（如节点/模型不可用）：补一组失败事件，保证 UI 有中文提示。
      nextEvent({ type: 'operation-started', kind: 'node-analysis', nodeId });
      nextEvent({
        type: 'message-added',
        nodeId,
        message: {
          id: userMessageId,
          role: 'user',
          content: prompt,
          createdAt: new Date().toISOString(),
          ...(attachments.length ? { attachments: [...attachments] } : {}),
        },
      });
      nextEvent({ type: 'operation-finished', kind: 'node-analysis', outcome: 'failed', nodeId, error: toMessage(error) });
      close();
    }

    try {
      for (;;) {
        const pending = queue.shift();
        if (pending) {
          yield pending;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      if (memorySave) await memorySave;
    } finally {
      cancelScheduledStreamFlush();
      unsubscribe();
      this.activeRequestIds.delete(operationId);
    }
  }

  async cancelOperation(operationId: string): Promise<void> {
    const requestId = this.activeRequestIds.get(operationId);
    if (requestId) {
      this.activeRequestIds.delete(operationId);
      const api = requireElectronApi();
      await api.cancelAssistantTurn(requestId);
      return;
    }
    await this.fallback.cancelOperation(operationId);
  }

  async addDerivedNode(documentId: string, parentId: string, title: string, markdown?: string): Promise<WikiMapNode> {
    const api = requireElectronApi();
    const result = await api.addWikiDerivedNode(this.libraryPath, { documentId, parentId, title, markdown });
    if (!result.ok) throw new Error(result.error.message);
    return toDerivedMapNode(documentId, result.node);
  }

  async renameDerivedNode(documentId: string, nodeId: string, title: string): Promise<WikiMapNode> {
    const api = requireElectronApi();
    const result = await api.renameWikiDerivedNode(this.libraryPath, { documentId, nodeId, title });
    if (!result.ok) throw new Error(result.error.message);
    return toDerivedMapNode(documentId, result.node);
  }

  async deleteDerivedNode(documentId: string, nodeId: string): Promise<string[]> {
    const api = requireElectronApi();
    const result = await api.deleteWikiDerivedNode(this.libraryPath, { documentId, nodeId });
    if (!result.ok) throw new Error(result.error.message);
    return result.deletedNodeIds;
  }

  async listAiMemories(documentId: string): Promise<WikiAiMemory[]> {
    const api = requireElectronApi();
    const result = await api.listWikiAiMemories(this.libraryPath, documentId);
    if (!result.ok) throw new Error(result.error.message);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      this.applyAiMemories(documentId, result.memories);
    }
    return result.memories;
  }

  async renameAiMemory(documentId: string, memoryId: string, title: string): Promise<WikiAiMemory> {
    const api = requireElectronApi();
    const result = await api.renameWikiAiMemory(this.libraryPath, { documentId, memoryId, title });
    if (!result.ok) throw new Error(result.error.message);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      this.memoriesById.set(result.memory.id, result.memory);
      if (this.activeMemoryIdByNode.get(result.memory.nodeId) === result.memory.id) {
        this.conversationByNode.set(result.memory.nodeId, result.memory.conversation);
      }
      this.memoriesDocumentId = documentId;
    }
    return result.memory;
  }

  async setAiMemoryPinned(documentId: string, memoryId: string, pinned: boolean): Promise<WikiAiMemory> {
    const api = requireElectronApi();
    const result = await api.setWikiAiMemoryPinned(this.libraryPath, { documentId, memoryId, pinned });
    if (!result.ok) throw new Error(result.error.message);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      this.memoriesById.set(result.memory.id, result.memory);
      this.memoriesDocumentId = documentId;
    }
    return result.memory;
  }

  async createAiMemory(documentId: string, nodeId: string): Promise<WikiAiMemory> {
    const api = requireElectronApi();
    const result = await api.createWikiAiMemory(this.libraryPath, { documentId, nodeId });
    if (!result.ok) throw new Error(result.error.message);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      this.memoriesById.set(result.memory.id, result.memory);
      this.activeMemoryIdByNode.set(nodeId, result.memory.id);
      this.conversationByNode.set(nodeId, []);
      this.memoriesDocumentId = documentId;
    }
    return result.memory;
  }

  async deleteAiMemory(documentId: string, memoryId: string): Promise<void> {
    const target = this.memoriesById.get(memoryId);
    const api = requireElectronApi();
    const result = await api.deleteWikiAiMemory(this.libraryPath, { documentId, memoryId });
    if (!result.ok) throw new Error(result.error.message);
    if (target && (!this.currentDocumentId || this.currentDocumentId === documentId)) {
      this.memoriesById.delete(target.id);
      if (this.activeMemoryIdByNode.get(target.nodeId) === target.id) {
        this.activateLatestMemoryForNode(target.nodeId);
      }
    }
    this.memoriesDocumentId = documentId;
  }

  async getNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView> {
    const api = requireElectronApi();
    return toQuestionsView(await api.getWikiNodeQuestions(this.libraryPath, documentId, nodeId));
  }

  async refreshNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView> {
    const api = requireElectronApi();
    return toQuestionsView(await api.refreshWikiNodeQuestions(this.libraryPath, documentId, nodeId));
  }

  reorderSiblingNodes(
    documentId: string,
    parentId: string,
    orderedNodeIds: string[],
    expectedRevision: string,
  ): Promise<WikiSiblingOrderCommit> {
    return this.fallback.reorderSiblingNodes(documentId, parentId, orderedNodeIds, expectedRevision);
  }

  private async *unavailableGeneration(kind: 'full-generation' | 'chapter-retry'): AsyncIterable<WikiEvent> {
    const operationId = createWikiRequestId();
    let seq = 0;
    const job: WikiGenerationJob = {
      id: `${operationId}:job`,
      operationId,
      status: 'running',
      stage: WIKI_FULL_GENERATION_UNAVAILABLE,
      progress: 0,
      etaSeconds: null,
      tasks: [],
    };
    yield createWikiEvent(operationId, ++seq, { type: 'operation-started', kind, job });
    yield createWikiEvent(operationId, ++seq, { type: 'operation-finished', kind, outcome: 'failed', error: WIKI_FULL_GENERATION_UNAVAILABLE });
  }

  private takeConversation(nodeId: string): AssistantConversationMessage[] {
    return applyConversationBudget(this.conversationByNode.get(nodeId) ?? []);
  }

  private async ensureMemoriesLoaded(documentId: string): Promise<void> {
    if (this.memoriesDocumentId === documentId) return;
    await this.listAiMemories(documentId);
  }

  private applyAiMemories(documentId: string, memories: WikiAiMemory[]): void {
    this.memoriesDocumentId = documentId;
    this.memoriesById.clear();
    this.activeMemoryIdByNode.clear();
    this.conversationByNode.clear();
    for (const memory of memories) this.memoriesById.set(memory.id, memory);
    for (const memory of sortAiMemories(memories)) {
      if (this.activeMemoryIdByNode.has(memory.nodeId)) continue;
      this.activeMemoryIdByNode.set(memory.nodeId, memory.id);
      this.conversationByNode.set(memory.nodeId, memory.conversation);
    }
  }

  private async appendConversation(documentId: string, nodeId: string, prompt: string, answer: string): Promise<void> {
    const history = this.conversationByNode.get(nodeId) ?? [];
    const next = applyConversationBudget([
      ...history,
      { role: 'user', content: prompt },
      ...(answer.trim() ? [{ role: 'assistant' as const, content: answer }] : []),
    ]);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      // 先更新内存，防止用户在保存完成前紧接着发起下一轮时遗漏刚完成的问答。
      this.conversationByNode.set(nodeId, next);
    }
    const api = requireElectronApi();
    const memoryId = this.activeMemoryIdByNode.get(nodeId);
    const result = await api.upsertWikiAiMemory(this.libraryPath, { documentId, nodeId, ...(memoryId ? { memoryId } : {}), conversation: next });
    if (!result.ok) throw new Error(result.error.message);
    if (!this.currentDocumentId || this.currentDocumentId === documentId) {
      this.memoriesById.set(result.memory.id, result.memory);
      this.activeMemoryIdByNode.set(nodeId, result.memory.id);
      this.conversationByNode.set(nodeId, result.memory.conversation);
      this.memoriesDocumentId = documentId;
    }
  }

  private activateLatestMemoryForNode(nodeId: string): void {
    const latest = sortAiMemories([...this.memoriesById.values()].filter((memory) => memory.nodeId === nodeId))[0];
    if (latest) {
      this.activeMemoryIdByNode.set(nodeId, latest.id);
      this.conversationByNode.set(nodeId, latest.conversation);
      return;
    }
    this.activeMemoryIdByNode.delete(nodeId);
    this.conversationByNode.delete(nodeId);
  }
}

function sortAiMemories(memories: WikiAiMemory[]): WikiAiMemory[] {
  return [...memories].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
  });
}

/** 与主进程 IPC 契约一致：最近 6 条、单条 ≤2000 字符、总量 ≤4000 字符，超长保留尾部。 */
function applyConversationBudget(history: AssistantConversationMessage[]): AssistantConversationMessage[] {
  const selected = history.slice(-WIKI_CONVERSATION_MAX_MESSAGES);
  const result: AssistantConversationMessage[] = [];
  let total = 0;
  for (const message of [...selected].reverse()) {
    const budget = Math.min(WIKI_CONVERSATION_TOTAL_CHARS - total, WIKI_CONVERSATION_MESSAGE_CHARS);
    if (budget <= 0) break;
    const content = message.content.slice(Math.max(0, message.content.length - budget)).trim();
    if (!content) continue;
    total += content.length;
    result.push({ role: message.role, content });
  }
  return result.reverse();
}

function createWikiRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/gu, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  // 需匹配主进程 requestId 校验：/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/。
  return `wiki_${random}`.slice(0, 128);
}

function createWikiEvent<T extends Omit<WikiEvent, 'operationId' | 'seq' | 'timestamp'>>(
  operationId: string,
  seq: number,
  event: T,
): WikiEvent {
  return { ...event, operationId, seq, timestamp: new Date().toISOString() } as unknown as WikiEvent;
}

function requireElectronApi(): NonNullable<typeof window.electronAPI> {
  if (!window.electronAPI) throw new Error('桌面数据桥接不可用，请重新启动 Trellora。');
  return window.electronAPI;
}

/** 把主进程回传的派生节点视图映射为渲染层 WikiMapNode（kind:'derived'，无真实来源章节）。 */
function toDerivedMapNode(documentId: string, view: WikiDerivedNodeView): WikiMapNode {
  return {
    id: view.id,
    documentId,
    parentId: view.parentId,
    title: view.title,
    order: view.order,
    depth: view.depth,
    kind: 'derived',
    status: 'complete',
    markdown: view.markdown,
    sourceRef: { sourceName: '', headingId: view.id, updatedAt: view.updatedAt },
  };
}

/** 把主进程建议问题结果映射为渲染层视图：硬错误（ok:false）一律降级为空问题集。 */
function toQuestionsView(result: WikiNodeQuestionsResult): WikiNodeQuestionsView {
  return result.ok ? { questions: result.questions, degraded: result.degraded } : { questions: [], degraded: true };
}

/** 把主进程 knowledgeBaseCitations 映射为渲染层 WikiNodeCitation（方案 §4.6）：preview 压缩空白并截断。 */
function toWikiNodeCitations(citations: AssistantKnowledgeBaseCitation[] | undefined): WikiNodeCitation[] {
  if (!citations || citations.length === 0) return [];
  return [...citations]
    .sort((first, second) => first.reference - second.reference)
    .map((citation) => ({
      reference: citation.reference,
      ...(citation.nodeId ? { nodeId: citation.nodeId } : {}),
      nodePath: citation.nodePath ?? [],
      ordinal: citation.parentOrdinal,
      preview: citation.content.replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
}

function toWikiRetrievalProgress(progress: AssistantWikiScopeProgress): WikiRetrievalState {
  return {
    phase: progress.phase,
    scopeMode: progress.scopeMode,
    currentCycle: progress.currentCycle,
    maxRetrievalCycles: progress.maxRetrievalCycles,
    activeRange: progress.activeRange,
    searchedSections: [],
    localSearchCount: progress.localSearchCount,
    documentSearchCount: progress.documentSearchCount,
    ...(progress.escalationReason ? { escalationReason: progress.escalationReason } : {}),
    ...(progress.newEvidenceCount !== undefined ? { newEvidenceCount: progress.newEvidenceCount } : {}),
  };
}

function toWikiRetrievalResult(
  result: AssistantWikiScopeResult,
  completeness: 'complete' | 'partial' | 'not-found' | undefined,
): WikiRetrievalState {
  return {
    phase: 'completed',
    scopeMode: result.scopeMode,
    currentCycle: result.retrievalCyclesUsed,
    maxRetrievalCycles: result.maxRetrievalCycles,
    activeRange: result.finalScope === 'document' ? 'document' : 'subtree',
    initialScope: result.initialScope,
    finalScope: result.finalScope,
    localSearchCount: result.localSearchCount,
    documentSearchCount: result.documentSearchCount,
    usedOtherSections: result.usedOtherSections,
    searchedSections: result.searchedSections.map((section) => ({
      nodePath: [...section.nodePath],
      ...(section.nodeId ? { nodeId: section.nodeId } : {}),
    })),
    stopReason: result.stopReason,
    ...(result.escalationReason ? { escalationReason: result.escalationReason } : {}),
    ...(completeness ? { completeness } : {}),
  };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
