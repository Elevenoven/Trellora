import type { WikiActionKind } from '../../electron/wiki/wikiQuickActions';
import type { AssistantAttachment, AssistantPublicModelEvent, AssistantThinkingMode, CurrentNotePublicToolEvent, WikiAiMemory } from '../electron';

export type { WikiActionKind };

export type WikiBuildMode = 'guided' | 'auto';

export type WikiMapInteractionMode = 'browse' | 'reorder';

export type WikiOrderPersistence = 'local' | 'session';

export type WikiNodeKind = 'source' | 'derived';

export type WikiNodeStatus = 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'stale' | 'cancelled';

export type WikiTaskStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export type WikiOperationKind = 'full-generation' | 'node-analysis' | 'chapter-retry';

export type WikiOperationOutcome = 'complete' | 'partial' | 'failed' | 'cancelled';

export interface WikiDocumentSummary {
  id: string;
  title: string;
  sourceName: string;
  description: string;
  updatedAt: string;
  nodeCount: number;
}

export interface WikiSourceReference {
  sourceName: string;
  sourcePath?: string;
  headingId: string;
  updatedAt: string;
}

export interface WikiMapNode {
  id: string;
  documentId: string;
  parentId: string | null;
  title: string;
  order: number;
  depth: number;
  kind: WikiNodeKind;
  status: WikiNodeStatus;
  markdown: string;
  sourceRef: WikiSourceReference;
  collapsed?: boolean;
}

export interface WikiChapterTask {
  id: string;
  chapterNodeId: string;
  title: string;
  status: WikiTaskStatus;
  progress: number;
  stage: string;
  error?: string;
}

export interface WikiGenerationJob {
  id: string;
  operationId: string;
  status: 'running' | WikiOperationOutcome;
  stage: string;
  progress: number;
  etaSeconds: number | null;
  tasks: WikiChapterTask[];
}

export interface WikiAiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  streaming?: boolean;
  /** 仅用户本轮发送时回显；不会写入 Wiki 多轮文本历史或持久化。 */
  attachments?: AssistantAttachment[];
  /** 回答引用（方案 §4.6）：[0] 为节点直载全文，[n≥1] 为工具台账证据；仅 assistant 终答携带。 */
  citations?: WikiNodeCitation[];
  /** 本轮回答的范围、循环次数与检索章节；仅 assistant 终答携带。 */
  retrieval?: WikiRetrievalState;
  /** 与问答 AI 一致的、可公开展示的本轮工具调用事件。 */
  toolEvents?: CurrentNotePublicToolEvent[];
  /** 与问答 AI 一致的、已脱敏且有长度上限的 ReAct 模型轮次输出。 */
  modelEvents?: AssistantPublicModelEvent[];
  /** 本轮工具与模型执行的总耗时。 */
  executionElapsedMs?: number;
  /** 高级思考模式下模型返回的思考文本；仅在提供商明确返回时存在。 */
  thinkingText?: string;
  thinkingElapsedMs?: number;
}

/** Wiki 节点引用条目（方案 §4.6）：随 result 事件下发，UI 折叠展示章节路径。 */
export interface WikiNodeCitation {
  reference: number;
  /** 当前文档内的真实来源节点；存在时可直接定位到章节。 */
  nodeId?: string;
  /** 来源章节路径（根→章节标题数组）。 */
  nodePath: string[];
  /** 父块序号（[0] 直载全文为 0）。 */
  ordinal: number;
  /** 引用内容预览（已压缩空白、截断）。 */
  preview: string;
}

export type WikiRetrievalRange = 'anchor' | 'subtree' | 'document';

export interface WikiRetrievalSection {
  nodePath: string[];
  nodeId?: string;
}

/** Wiki UI 使用的实时/终态证据航迹。 */
export interface WikiRetrievalState {
  phase: 'searching' | 'completed';
  scopeMode: 'node-locked' | 'node-first' | 'document-first';
  currentCycle: number;
  maxRetrievalCycles: 5;
  activeRange: Exclude<WikiRetrievalRange, 'anchor'>;
  initialScope?: WikiRetrievalRange;
  finalScope?: WikiRetrievalRange;
  localSearchCount?: number;
  documentSearchCount?: number;
  usedOtherSections?: boolean;
  searchedSections: WikiRetrievalSection[];
  stopReason?: 'evidence-sufficient' | 'cycle-limit' | 'no-new-query' | 'budget-exhausted' | 'cancelled';
  escalationReason?: 'explicit-document-scope' | 'explicit-section-reference' | 'local-no-hit' | 'local-evidence-incomplete';
  completeness?: 'complete' | 'partial' | 'not-found';
  newEvidenceCount?: number;
}

export interface WikiNodeDraft {
  id: string;
  nodeId: string;
  title: string;
  markdown: string;
  proposedChildren: string[];
  /** 与 proposedChildren 同序的子节点概述（方案 §5：derived markdown=summary）；仅 split-children 产出。 */
  proposedChildSummaries?: string[];
  status: 'pending' | 'applied' | 'discarded';
}

export interface WikiNodeAiState {
  nodeId: string;
  operationId: string | null;
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  messages: WikiAiMessage[];
  draft: WikiNodeDraft | null;
  /** 当前执行或最近终答的证据航迹。 */
  retrieval?: WikiRetrievalState;
  /** 最近一次失败的中文提示；operation-finished(failed) 写入，重新开始分析时清空。 */
  lastError?: string;
  /** 节点建议问题（方案 §7.4）：选中节点后台生成，作为「猜你想问」芯片。 */
  suggestedQuestions?: string[];
  /** 建议问题加载态：idle 未请求；loading 生成中；ready 有问题；degraded 生成失败/无有效问题。 */
  questionsStatus?: 'idle' | 'loading' | 'ready' | 'degraded';
}

/** Wiki 节点问答的单轮模型设置；只影响当前发送，不会改写全局默认模型。 */
export interface WikiNodeAiRequestOptions {
  modelProfileId?: string;
  thinkingMode?: AssistantThinkingMode;
}

/** 数据源回传的建议问题结果（方案 §7.4）：degraded 表示生成失败或无有效问题。 */
export interface WikiNodeQuestionsView {
  questions: string[];
  degraded: boolean;
}

export interface WikiWorkspaceSnapshot {
  document: WikiDocumentSummary;
  mode: WikiBuildMode | null;
  nodes: WikiMapNode[];
  orderPersistence: WikiOrderPersistence;
  siblingOrderRevisions: Record<string, string>;
  generationJob: WikiGenerationJob | null;
  nodeAi: Record<string, WikiNodeAiState>;
}

export interface WikiSiblingOrderCommit {
  parentId: string;
  orderedNodeIds: string[];
  revision: string;
  persistence: WikiOrderPersistence;
}

interface WikiEventBase {
  operationId: string;
  seq: number;
  timestamp: string;
}

export type WikiEvent =
  | (WikiEventBase & {
    type: 'operation-started';
    kind: WikiOperationKind;
    nodeId?: string;
    job?: WikiGenerationJob;
  })
  | (WikiEventBase & { type: 'task-updated'; task: WikiChapterTask })
  | (WikiEventBase & { type: 'nodes-upserted'; nodes: WikiMapNode[] })
  | (WikiEventBase & { type: 'message-added'; nodeId: string; message: WikiAiMessage })
  | (WikiEventBase & { type: 'retrieval-updated'; nodeId: string; retrieval: WikiRetrievalState })
  | (WikiEventBase & { type: 'draft-ready'; nodeId: string; draft: WikiNodeDraft })
  | (WikiEventBase & { type: 'questions-loading'; nodeId: string })
  | (WikiEventBase & { type: 'questions-ready'; nodeId: string; questions: string[]; degraded: boolean })
  | (WikiEventBase & {
    type: 'operation-finished';
    kind: WikiOperationKind;
    outcome: WikiOperationOutcome;
    nodeId?: string;
    error?: string;
  });

export interface WikiDataSource {
  attachWorkspace(workspace: WikiWorkspaceSnapshot): void;
  listDocuments(): Promise<WikiDocumentSummary[]>;
  loadWorkspace(documentId: string): Promise<WikiWorkspaceSnapshot>;
  setMode(documentId: string, mode: WikiBuildMode): Promise<void>;
  startFullGeneration(documentId: string): AsyncIterable<WikiEvent>;
  retryChapter(documentId: string, taskId: string): AsyncIterable<WikiEvent>;
  analyzeNode(documentId: string, nodeId: string, prompt: string, actionKind?: WikiActionKind, attachments?: AssistantAttachment[], options?: WikiNodeAiRequestOptions): AsyncIterable<WikiEvent>;
  cancelOperation(operationId: string): Promise<void>;
  addDerivedNode(documentId: string, parentId: string, title: string, markdown?: string): Promise<WikiMapNode>;
  renameDerivedNode(documentId: string, nodeId: string, title: string): Promise<WikiMapNode>;
  deleteDerivedNode(documentId: string, nodeId: string): Promise<string[]>;
  listAiMemories(documentId: string): Promise<WikiAiMemory[]>;
  createAiMemory(documentId: string, nodeId: string): Promise<WikiAiMemory>;
  setAiMemoryPinned(documentId: string, memoryId: string, pinned: boolean): Promise<WikiAiMemory>;
  renameAiMemory(documentId: string, memoryId: string, title: string): Promise<WikiAiMemory>;
  deleteAiMemory(documentId: string, memoryId: string): Promise<void>;
  getNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView>;
  refreshNodeQuestions(documentId: string, nodeId: string): Promise<WikiNodeQuestionsView>;
  reorderSiblingNodes(documentId: string, parentId: string, orderedNodeIds: string[], expectedRevision: string): Promise<WikiSiblingOrderCommit>;
}
