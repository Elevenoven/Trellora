import type { AiProviderKind } from './aiTypes';
import type { MemoryUsedSnapshot } from './memory/memoryTypes';
import type { LearningPlan, OrganizationSuggestion } from './libraryAiTypes';
import type { LexicalMatchTrace } from './lexicalMatchPolicy';
import type { AssistantContextUsage } from './tokenEstimator';
import type { SummaryRunCheckpoint } from './summaryRunBudget';
import type { ShadowScopeComparison } from './assistantShadowPlan';
import type { SearchEvidenceKind, SearchQueryTermSource } from './searchPlanTypes';
import type { QaMemoryZoneTokens } from './qaMemoryTypes';
import type { ContextProjectionDiagnostics } from './contextRuntimeTypes';
import { isWikiActionKind, type WikiActionKind } from '../wiki/wikiQuickActions';

export type { AssistantEvidenceContextStats } from './tokenEstimator';

export const assistantIntents = ['ask', 'learning-plan', 'organize'] as const;
export type AssistantIntent = typeof assistantIntents[number];

export const assistantScopes = ['chat', 'current-note', 'library-search', 'library-structure', 'wiki-node'] as const;
export type AssistantScope = typeof assistantScopes[number];

export const assistantThinkingModes = ['simple', 'advanced'] as const;
export type AssistantThinkingMode = typeof assistantThinkingModes[number];

export const assistantAnswerDepths = ['auto', 'concise', 'detailed'] as const;
export type AssistantAnswerDepth = typeof assistantAnswerDepths[number];

export const assistantContextSourceKinds = ['note-library', 'knowledge-base'] as const;
export type AssistantContextSourceKind = typeof assistantContextSourceKinds[number];

export interface AssistantContextSource {
  kind: AssistantContextSourceKind;
  libraryPath: string;
  label?: string;
}

/**
 * 多模态附件判别联合（多模态开发方案 §5.1）：
 * - image：剪贴板/拖拽/文件对话框采集的图片，携带 base64 dataUrl，仅存活于本轮请求；主进程不落盘。
 * - document：PDF / DOCX 文档；主进程解析后注入 AttachmentContextProvider。
 * - text：现有 Markdown / TXT / CSV / JSON 等纯文本附件；主进程直接读取。
 * 三种类型都携带稳定的 attachmentId，前端按 id 去重与移除。
 */
export const assistantAttachmentKinds = ['image', 'document', 'text'] as const;
export type AssistantAttachmentKind = typeof assistantAttachmentKinds[number];

export const assistantImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AssistantImageMimeType = typeof assistantImageMimeTypes[number];

export interface AssistantImageAttachment {
  kind: 'image';
  attachmentId: string;
  name: string;
  mimeType: AssistantImageMimeType;
  sizeBytes: number;
  /** base64 dataUrl，仅存活于本轮请求；历史轮次不保留。 */
  dataUrl: string;
}

export interface AssistantDocumentAttachment {
  kind: 'document';
  attachmentId: string;
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AssistantTextAttachment {
  kind: 'text';
  attachmentId: string;
  path: string;
  name: string;
  sizeBytes: number;
}

export type AssistantAttachment =
  | AssistantImageAttachment
  | AssistantDocumentAttachment
  | AssistantTextAttachment;

/** 单张图片原始字节上限（未 base64 编码前）。 */
export const maxAssistantImageBytes = 5_000_000;
/** 单轮所有图片原始字节合计上限。 */
export const maxAssistantImageTotalBytes = 20_000_000;
/** 单个文档附件字节上限（PDF / DOCX 放宽到 20 MB）。 */
export const maxAssistantDocumentBytes = 20_000_000;
/** 单轮附件总数上限（图片 + 文档 + 文本合计）。 */
export const maxAssistantAttachmentCount = 6;
/** 单个文本附件字节上限（保持历史 2 MB）。 */
export const maxAssistantAttachmentBytes = 2_000_000;
/** 单轮所有文本附件合计字节上限（保持历史 5 MB）。 */
export const maxAssistantAttachmentTotalBytes = 5_000_000;

/** 图片附件扩展名白名单（小写、包含点）。 */
export const assistantImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** 文档附件扩展名白名单（需走解析流水线）。 */
export const assistantDocumentExtensions = new Set(['.pdf', '.docx']);
/** 文本附件扩展名白名单（直接读取）。 */
export const assistantTextExtensions = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log']);

export function resolveImageMimeTypeFromExtension(extension: string): AssistantImageMimeType | null {
  const normalized = extension.toLowerCase();
  if (normalized === '.png') return 'image/png';
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  return null;
}

export function resolveDocumentMimeTypeFromExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === '.pdf') return 'application/pdf';
  if (normalized === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (normalized === '.doc') return 'application/msword';
  return 'application/octet-stream';
}

export interface AssistantConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Wiki 节点问答作用域目标（方案 §4.2）：把检索范围锁定到某个文档的某个章节子树，
 * 并携带本轮快捷动作类型。仅 scope === 'wiki-node' 时存在。
 */
export interface AssistantWikiTarget {
  libraryPath: string;
  documentId: string;
  /** 形如 wiki:<documentId>:<structureNodeId>。 */
  nodeId: string;
  actionKind: WikiActionKind;
}

/**
 * Wiki 快捷动作终答后的草稿载荷（方案 §5）：markdown 为终答全文，
 * proposedChildren 仅 `split-children` 动作经结构化小调用产出，其余动作为空数组。
 * 随 `complete` 事件的 result 下发，渲染进程映射为 `draft-ready` WikiEvent。
 */
export interface AssistantWikiDraftChild {
  title: string;
  summary: string;
}

export interface AssistantWikiDraft {
  /** 草稿标题（默认取当前节点标题）。 */
  title: string;
  /** 终答全文，作为「保留在当前节点」的草稿正文。 */
  markdown: string;
  /** 建议子节点（标题 + 概述）；概述将作为派生节点 markdown。 */
  proposedChildren: AssistantWikiDraftChild[];
}

export interface AssistantTurnRequest {
  requestId: string;
  intent: AssistantIntent;
  scope: AssistantScope;
  userText: string;
  currentNotePath?: string;
  /** Current-note and dedicated knowledge-base conversations may opt into a persisted session. */
  sessionId?: string;
  contextSources?: AssistantContextSource[];
  attachments?: AssistantAttachment[];
  conversation: AssistantConversationMessage[];
  modelProfileId?: string;
  thinkingMode?: AssistantThinkingMode;
  answerDepth?: AssistantAnswerDepth;
  skillIds?: string[];
  /** 本轮联网搜索开关（联网搜索设计方案 §8）；'off' 时即使全局已启用也不注册联网工具。 */
  webSearch?: 'on' | 'off';
  summaryCheckpoint?: SummaryRunCheckpoint;
  /** Wiki 节点问答目标；仅 scope === 'wiki-node' 时存在（方案 §4.2）。 */
  wikiTarget?: AssistantWikiTarget;
}

export interface AssistantTurnSource {
  path: string;
  /** 知识库来源对应的真实引用号；不再依赖数组下标推断。 */
  reference?: number;
  /** 知识库来源的稳定文档 id；展示标题不得承载该定位信息。 */
  documentId?: string;
  /** 知识库父块序号；仅用于引用定位和独立的位置展示。 */
  parentOrdinal?: number;
  title: string;
  snippet: string;
  score: number;
  methods: Array<'keyword' | 'semantic'>;
  sourceType?: 'note' | 'knowledge-base' | 'attachment';
  matchTrace?: LexicalMatchTrace[];
}

export const currentNoteContextModes = ['direct-full', 'memory-reuse', 'react-search', 'structured-summary'] as const;
export type CurrentNoteContextMode = typeof currentNoteContextModes[number];

export const agentStopReasons = [
  'answered',
  'max-decision-rounds',
  'max-model-calls',
  'max-tool-calls',
  'no-progress',
  'repeated-action',
  'empty-searches',
  'invalid-action',
  'context-budget',
  'timeout',
  'cancelled',
  'snapshot-stale',
] as const;
export type AgentStopReason = typeof agentStopReasons[number];

/** Local-only location metadata. Absolute paths must never enter model prompts. */
export interface AssistantEvidenceCitation {
  evidenceId: string;
  notePath: string;
  /** Present for cross-note citations; omitted by current-note citations. */
  libraryId?: string;
  noteId?: string;
  contentHash: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  quoteHash: string;
  preview: string;
}

export type AssistantCitationValidation =
  | { status: 'valid' }
  | { status: 'stale'; message: string };

/**
 * Renderer-facing evidence for the dedicated material knowledge-base RAG
 * route. Its reference number is the exact `[N]` label that appeared in the
 * prompt, and `content` is the exact parent-block text sent to the model.
 */
export interface AssistantKnowledgeBaseCitation {
  reference: number;
  /** 稳定资料文档 id；仅主进程用于回答完成后的文档亲和度记账。 */
  documentId?: string;
  documentName: string;
  parentOrdinal: number;
  content: string;
  /** 来源章节路径（根→当前章节标题数组）；仅 Wiki 节点问答注入，用于引用展开到章节路径（方案 §4.6）。 */
  nodePath?: string[];
  /** Wiki 真实来源节点；仅当前文档内的已解析节点可下发，用于引用定位。 */
  nodeId?: string;
}

export type AssistantWikiScopeMode = 'node-locked' | 'node-first' | 'document-first';
export type AssistantWikiScopeRange = 'anchor' | 'subtree' | 'document';
export type AssistantWikiScopeStopReason = 'evidence-sufficient' | 'cycle-limit' | 'no-new-query' | 'budget-exhausted' | 'cancelled';
export type AssistantWikiScopeEscalationReason = 'explicit-document-scope' | 'explicit-section-reference' | 'local-no-hit' | 'local-evidence-incomplete';

/** Wiki 搜索工具事件附带的实时、可公开范围进度。 */
export interface AssistantWikiScopeProgress {
  phase: 'searching' | 'completed';
  scopeMode: AssistantWikiScopeMode;
  activeRange: Exclude<AssistantWikiScopeRange, 'anchor'>;
  currentCycle: number;
  maxRetrievalCycles: 5;
  documentScopeEntered: boolean;
  localSearchCount: number;
  documentSearchCount: number;
  escalationReason?: AssistantWikiScopeEscalationReason;
  newEvidenceCount?: number;
}

export interface AssistantWikiSearchedSection {
  nodePath: string[];
  nodeId?: string;
}

/** Wiki 终答的范围与循环结果；只含当前文档内可展示、可导航的信息。 */
export interface AssistantWikiScopeResult {
  scopeMode: AssistantWikiScopeMode;
  initialScope: AssistantWikiScopeRange;
  finalScope: AssistantWikiScopeRange;
  retrievalCyclesUsed: number;
  maxRetrievalCycles: 5;
  localSearchCount: number;
  documentSearchCount: number;
  usedOtherSections: boolean;
  searchedSections: AssistantWikiSearchedSection[];
  stopReason: AssistantWikiScopeStopReason;
  escalationReason?: AssistantWikiScopeEscalationReason;
}

/** 联网证据引用投影（联网搜索设计方案 §7.2）；与知识库引用共享递增序列。 */
export interface AssistantWebCitation {
  reference: number;
  title: string;
  url: string;
  /** 厂商适配器 id，如 'zhipu'。 */
  source: string;
  /** 是否已经 web_fetch 全文核对；false 时仅为摘要级证据。 */
  pageVerified: boolean;
  content: string;
}

/** Validates the renderer-facing shape before the main process reads a note. */
export function validateAssistantEvidenceCitation(value: unknown): AssistantEvidenceCitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 引用格式无效。');
  const input = value as Record<string, unknown>;
  const evidenceId = readString(input.evidenceId, '引用标识', 128);
  const notePath = readString(input.notePath, '引用笔记路径', 4_000);
  const libraryId = input.libraryId === undefined ? undefined : readString(input.libraryId, '引用库标识', 128);
  const noteId = input.noteId === undefined ? undefined : readString(input.noteId, '引用笔记标识', 128);
  const contentHash = readString(input.contentHash, '引用内容哈希', 64);
  const quoteHash = readString(input.quoteHash, '引用原文哈希', 64);
  const preview = readString(input.preview, '引用预览', 240);
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,127}$/u.test(evidenceId)
    || (libraryId !== undefined && !/^library-[a-f0-9]{24}$/u.test(libraryId))
    || (noteId !== undefined && !/^note-[a-f0-9]{24}$/u.test(noteId))
    || !/^[a-f0-9]{64}$/u.test(contentHash)
    || !/^[a-f0-9]{64}$/u.test(quoteHash)
    || typeof input.lineFrom !== 'number' || typeof input.lineTo !== 'number'
    || !Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo)
    || input.lineFrom < 1 || input.lineTo < input.lineFrom) {
    throw new Error('AI 引用格式无效。');
  }
  if (!Array.isArray(input.headingPath) || input.headingPath.length > 8
    || input.headingPath.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 300)) {
    throw new Error('AI 引用标题路径无效。');
  }
  return {
    evidenceId,
    notePath,
    ...(libraryId ? { libraryId } : {}),
    ...(noteId ? { noteId } : {}),
    contentHash,
    headingPath: [...input.headingPath],
    lineFrom: input.lineFrom,
    lineTo: input.lineTo,
    quoteHash,
    preview,
  };
}

export interface CurrentNoteToolStats {
  calls: number;
  searchedBlocks: number;
  readCharacters: number;
  elapsedMs: number;
}

/** Main-process-only evidence inventory contract for Stage 2+ materialization. */
export interface EvidencePromptManifest {
  snapshotId: string;
  contentHash: string;
  searchRetrievedEvidenceIds: string[];
  turnRetrievedEvidenceIds: string[];
  rawEvidenceIds: string[];
  compressedSourceEvidenceIds: string[];
  compressionArtifactIds: string[];
  representedEvidenceIds: string[];
  missingEvidenceIds: string[];
  rawTokens: number;
  compressedSourceTokens: number;
  compressedOutputTokens: number;
  finalEvidenceTokens: number;
  evidenceBudgetTokens: number;
  /** Structural ID coverage, not a semantic-loss score. */
  representationCoverage: number;
  compressionRounds: number;
  compressionBatchCount: number;
}

export interface CurrentNotePublicToolContentPreview {
  kind: 'candidate' | 'evidence';
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  /** Bounded original-text excerpt shown only in the local audit rail. */
  text: string;
  truncated: boolean;
}

/**
 * 工具返回结果的结构化安全投影（仅本地调试轨道展示）。
 * 截断上限由工具侧执行；不含密钥、绝对路径与模型推理内容。
 */
export interface AssistantPublicToolResultView {
  /** 台账登记的引用号（如 '[1]'）；未登记的结果缺省。 */
  reference?: string;
  title?: string;
  /** 知识库块等结果的可读位置，不承载绝对路径。 */
  location?: string;
  /** 检索相关度；仅在工具真实返回时提供。 */
  score?: number;
  /** 知识库检索命中所使用的方法。 */
  methods?: Array<'keyword' | 'semantic'>;
  /** 当前会话中已返回过该结果，本次工具观察未重复展开正文。 */
  seen?: boolean;
  url?: string;
  /** 摘要级摘录（web_search）；有上限截断。 */
  snippet?: string;
  publishedAt?: string;
  /** 产出该结果的厂商适配器 id。 */
  source?: string;
  /** web_fetch 全文核对成功为 true；摘要级证据为 false。 */
  pageVerified?: boolean;
  /** 正文摘录（web_fetch 成功）；有上限截断。 */
  excerpt?: string;
}

export interface LibrarySectionNavigationCandidate {
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  score: number;
  matchedTerms: string[];
}

/** Renderer-safe navigation state. These candidates are not Ledger evidence. */
export interface LibrarySectionNavigationObservation {
  queryTermCount: number;
  evaluatedSectionCount: number;
  ambiguous: boolean;
  fallbackUsed: boolean;
  candidates: LibrarySectionNavigationCandidate[];
}

/**
 * Public progress only. Debug fields are bounded and intended for the local
 * renderer. They may include short excerpts explicitly returned by read/search
 * tools, but never model reasoning, absolute paths or provider request details.
 */
export interface CurrentNotePublicToolEvent {
  tool:
    | 'read_current_note'
    | 'search_note_library'
    | 'search_knowledge_base'
    | 'rerank_knowledge_evidence'
    | 'read_attachments'
    | 'search_attachment'
    | 'read_attachment_range'
    | 'get_note_map'
    | 'search_note'
    | 'read_note_range'
    | 'read_note_section'
    | 'expand_evidence'
    | 'get_library_note_map'
    | 'search_library_note_blocks'
    | 'read_library_note_range'
    | 'read_library_note_section'
    | 'expand_library_evidence'
    | 'read_library_adjacent_section'
    | 'rewrite_question'
    | 'knowledge_agent_search'
    | 'knowledge_agent_grep'
    | 'knowledge_agent_deep_read'
    | 'knowledge_agent_doc_info'
    | 'knowledge_agent_skill'
    | 'knowledge_agent_graph_search'
    | 'knowledge_agent_graph_global_search'
    | 'knowledge_agent_web_search'
    | 'knowledge_agent_web_fetch'
    | 'assistant_web_search'
    | 'assistant_web_fetch'
    /** 模型调用未注册工具时的公开错误轨迹，不应伪装为某个真实工具。 */
    | 'assistant_tool_error'
    | 'search_conversations';
  state: 'started' | 'completed' | 'rejected';
  message: string;
  /** ReAct decision round that produced this tool call; preprocessing tools omit it. */
  round?: number;
  /** Safe, human-readable request parameters shown in the local debug rail. */
  inputSummary?: string;
  /** Safe, human-readable result summary shown in the local debug rail. */
  outputSummary?: string;
  /** Bounded, renderer-safe excerpts from the tool result. */
  contentPreviews?: CurrentNotePublicToolContentPreview[];
  /** 工具返回结果的结构化投影（联网搜索/抓取等），调试轨道逐条展示。 */
  publicResults?: AssistantPublicToolResultView[];
  /** Stage 5 navigation-only projection. It never carries evidence IDs or source text. */
  sectionNavigation?: LibrarySectionNavigationObservation;
  /** Wiki 节点问答检索的实时范围与周期；其他助手链路不设置。 */
  wikiScopeProgress?: AssistantWikiScopeProgress;
  elapsedMs?: number;
}

export interface AssistantPublicModelText {
  /** Bounded, renderer-safe text copied from the real provider input/output. */
  text: string;
  /** Character count before redaction and bounded projection. */
  originalCharacters: number;
  truncated: boolean;
}

export interface AssistantModelInputCompressionAction {
  kind: 'tool-result-budget' | 'history-consolidation' | 'atomic-history-trim';
  affectedItems: number;
  affectedGroups?: number;
  method?: 'llm' | 'raw-archive';
}

/**
 * Renderer-safe receipt proving that the real provider input was reduced before
 * a model call. It contains counts only and must never carry prompt content.
 */
export interface AssistantModelInputCompression {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  releasedTokens: number;
  actions: AssistantModelInputCompressionAction[];
}

/**
 * Session-only public trace for a real ReAct model call. It deliberately omits
 * provider transport details, credentials, absolute paths and hidden reasoning.
 */
export interface AssistantPublicModelEvent {
  callId: string;
  round: number;
  callKind: 'decide' | 'synthesize';
  state: 'started' | 'completed' | 'rejected';
  input: AssistantPublicModelText;
  /** Present only when the provider received a genuinely reduced context. */
  inputCompression?: AssistantModelInputCompression;
  output?: AssistantPublicModelText;
  errorCode?: string;
  elapsedMs?: number;
}

export const assistantPlanStatuses = ['active', 'completed', 'partial', 'not-found', 'failed', 'cancelled', 'stale', 'interrupted'] as const;
export type AssistantPlanStatus = typeof assistantPlanStatuses[number];

export const assistantPlanGoalStatuses = ['pending', 'searching', 'partial', 'covered', 'conflicted', 'not-found'] as const;
export type AssistantPlanGoalStatus = typeof assistantPlanGoalStatuses[number];

export interface CurrentNotePublicPlanGoal {
  label: string;
  status: AssistantPlanGoalStatus;
  evidenceCount: number;
}

export interface CurrentNotePublicQueryTerm {
  term: string;
  source: SearchQueryTermSource;
}

export interface CurrentNotePublicSearchPlanGoal extends CurrentNotePublicPlanGoal {
  evidenceKind: SearchEvidenceKind;
  requirements: Array<{ label: string; minEvidence: number }>;
  queryTermCount: number;
  queryTerms: CurrentNotePublicQueryTerm[];
}

/** Renderer-safe SearchPlan projection; it intentionally omits IDs, paths and evidence text. */
export interface CurrentNotePublicSearchPlan {
  version: number;
  originalQuestion: string;
  status: AssistantPlanStatus;
  activeGoalLabel?: string;
  goals: CurrentNotePublicSearchPlanGoal[];
}

export interface CurrentNotePublicPlanEvent {
  phase: 'started' | 'updated' | 'finished';
  status: AssistantPlanStatus;
  goals: CurrentNotePublicPlanGoal[];
  /**
   * The validated Planner response for this turn. It is emitted only when the
   * plan starts, after local path redaction; later progress events remain
   * compact state updates.
   */
  plannerOutputJson?: string;
  /** Validated, renderer-safe SearchPlan details for the local audit rail. */
  searchPlan?: CurrentNotePublicSearchPlan;
  /** The last validated lexical query actually sent to a search tool. */
  finalQueryTerms?: string[];
  /** Numeric, estimate-labelled evidence telemetry; never carries text, paths or provider payloads. */
  evidenceContextStats?: import('./tokenEstimator').AssistantEvidenceContextStats;
}

export interface CurrentNoteAgentStats {
  decisionRounds: number;
  modelCalls: number;
  stopReason: AgentStopReason;
}

export interface CurrentNoteCacheUsage {
  cachedInputTokens?: number;
  providerReported: boolean;
}

export interface CurrentNoteSummaryCoverage {
  mode: 'summary-quick' | 'summary-complete';
  completed: number;
  total: number;
  reused: number;
  generated: number;
}

/**
 * Renderer-safe projection of the main-process current-note scope.  The
 * internal origin, confidence and target aspects stay on the main-process
 * side; only labels needed for the existing plan/trace UI cross the IPC
 * boundary.
 */
export interface CurrentNotePublicSearchScope {
  mode: 'focused' | 'topic-wide';
  coveragePolicy: 'sufficient' | 'aspect-complete' | 'occurrence-complete';
}

/** Renderer-safe, ledger-derived coverage counts and reason. */
export interface CurrentNotePublicSearchCoverage {
  discoveredHeadingCount: number;
  readHeadingCount: number;
  status: 'complete' | 'partial' | 'insufficient';
  reason: string;
}

export interface AssistantShadowPlanTelemetry {
  status: 'ran' | 'shadowSkipped' | 'shadowFailure';
  reason?: 'model-budget' | 'wall-time' | 'cancelled' | 'stale' | 'context-overflow';
  promptTokens?: number;
  scopeComparison?: ShadowScopeComparison;
}

/**
 * 知识库 ReAct Agent 影子对比遥测（方案 P2）：shadow 模式下与旧链路并行跑，
 * 只落详细轨迹不出回答；用于对比证据覆盖、轮次与耗时。
 */
export interface AssistantKnowledgeShadowTelemetry {
  status: 'ran' | 'skipped' | 'failure';
  skipReason?: 'transport-unavailable' | 'cancelled';
  error?: string;
  elapsedMs?: number;
  stopReason?: string;
  stopDetail?: string;
  /** Think 轮数 / 模型调用次数 / 工具调用次数。 */
  rounds?: number;
  modelCalls?: number;
  /** L1 摘要维护调用次数；不占 ReAct modelCalls。 */
  maintenanceModelCalls?: number;
  toolCalls?: number;
  /** 台账证据父块数（证据覆盖口径）。 */
  evidenceParentChunks?: number;
  /** 记忆信封实际注入 token（0/缺省表示未注入）。 */
  memoryEnvelopeTokens?: number;
  /** 轮内固化执行次数（P2）；0/缺省表示未触发。 */
  consolidations?: number;
  /** 终答实际引用到的父块数。 */
  citedParentChunks?: number;
  completeness?: 'complete' | 'partial' | 'not-found';
}

/** 知识库问答问题改写落痕记录（随 resultJson 存入 qa-memory.db）。 */
export interface QaQueryRewriteRecord {
  skipped: boolean;
  /** 排除原因：no-history / self-contained。 */
  reason?: string;
  /** 命中的放行信号。 */
  matchedSignals?: string[];
  /** 改写后问题（护栏回退时为原文）。 */
  rewrite?: string;
  shouldSplit?: boolean;
  subQuestions?: string[];
  /** 图意图门控（GraphRAG 方案 §4.3）：global/local/none。 */
  graphIntent?: 'global' | 'local' | 'none';
  /** 模型原始输出。 */
  rawOutput?: string;
  model?: string;
  elapsedMs: number;
  /** anti-divergence 等护栏触发。 */
  guardTriggered?: string;
  failed?: { code: string; message: string; rawOutput?: string };
}

export type AssistantTurnResult =
  | {
    type: 'answer';
    answer: string;
    provider: AiProviderKind;
    model: string;
    sourceNotes: AssistantTurnSource[];
    retrievalMode: 'hybrid' | 'semantic' | 'keyword' | 'none';
    /** The user-facing outcome of the one-shot assistant route classifier. */
    interactionRoute?: 'chat' | 'clarify' | 'react';
    contextUsage?: AssistantContextUsage;
    retrievalWarning?: string;
    /** P0 contracts only; the legacy path deliberately leaves these undefined. */
    contextMode?: CurrentNoteContextMode;
    evidence?: AssistantEvidenceCitation[];
    /** Dedicated material RAG only; these are expanded in place rather than navigated to a note. */
    knowledgeBaseCitations?: AssistantKnowledgeBaseCitation[];
    /** 联网证据引用（联网搜索设计方案 §7.2）；仅知识库 Agent 启用联网且命中网页证据时存在。 */
    webCitations?: AssistantWebCitation[];
    completeness?: 'complete' | 'partial' | 'not-found';
    toolStats?: CurrentNoteToolStats;
    agentStats?: CurrentNoteAgentStats;
    /** Public tool progress only; safe to render and persist for an execution trace. */
    toolEvents?: CurrentNotePublicToolEvent[];
    /** Public SearchPlan progress plus the validated, path-redacted Planner JSON when available. */
    planEvents?: CurrentNotePublicPlanEvent[];
    /** Session-only ReAct model input/output trace; assistant memory does not persist it. */
    modelEvents?: AssistantPublicModelEvent[];
    /** Main-process generated evidence telemetry; it is not model-authored. */
    evidenceContextStats?: import('./tokenEstimator').AssistantEvidenceContextStats;
    executionElapsedMs?: number;
    /** 模型深度思考原文（有上限）；仅当用户开启高级思考且模型返回思考内容时存在。 */
    thinkingText?: string;
    /** 思考阶段耗时（毫秒）。 */
    thinkingElapsedMs?: number;
    /** P5 only: quick and complete summaries report their real coverage separately. */
    summaryCoverage?: CurrentNoteSummaryCoverage;
    /** P6: safe projection of the main-process scope and Coverage Ledger. */
    searchScope?: CurrentNotePublicSearchScope;
    searchCoverage?: CurrentNotePublicSearchCoverage;
    summaryCheckpoint?: SummaryRunCheckpoint;
    shadowPlan?: AssistantShadowPlanTelemetry;
    prefixFingerprint?: string;
    cacheUsage?: CurrentNoteCacheUsage;
    isStale?: boolean;
    /** 问答区独立记忆链路：本轮各分区实际 token，供调试轨展示。 */
    qaMemoryZones?: QaMemoryZoneTokens;
    /** 问答区独立记忆链路：本轮所属会话（主进程自动建会话时回传给渲染进程）。 */
    qaSessionId?: string;
    /** Durable explicit-save result; assistant wording is never a save acknowledgement. */
    memorySave?: import('./memory/memoryTypes').MemorySaveReceipt;
    /** 知识库问答问题改写记录（设计 docs/Trellora-2.0-知识库问题改写设计.md）。 */
    queryRewrite?: QaQueryRewriteRecord;
    /** Phase 7: prompt-text-free context projection diagnostics safe for renderer and local persistence. */
    contextDiagnostics?: ContextProjectionDiagnostics;
    /** Wiki 节点快捷动作草稿载荷（方案 §5）；仅 scope === 'wiki-node' 时存在。 */
    wikiDraft?: AssistantWikiDraft;
    /** Wiki 节点问答的最终范围、循环上限与来源章节投影（范围优化方案 §7.2）。 */
    wikiScopeResult?: AssistantWikiScopeResult;
  }
  | { type: 'learning-plan'; plan: LearningPlan }
  | { type: 'organize'; suggestion: OrganizationSuggestion };

export type AssistantTurnEvent =
  | { requestId: string; type: 'started'; intent: AssistantIntent; scopeLabel: string }
  | { requestId: string; type: 'route'; interactionRoute: 'chat' | 'clarify' | 'react' }
  | { requestId: string; type: 'status'; message: string }
  | { requestId: string; type: 'tool'; event: CurrentNotePublicToolEvent }
  | { requestId: string; type: 'plan'; event: CurrentNotePublicPlanEvent }
  | { requestId: string; type: 'model'; event: AssistantPublicModelEvent }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'delta-reset' }
  | { requestId: string; type: 'thinking-delta'; text: string }
  | { requestId: string; type: 'context-diagnostics'; diagnostics: ContextProjectionDiagnostics }
  | { requestId: string; type: 'complete'; result: AssistantTurnResult }
  | { requestId: string; type: 'suggestions'; questions: string[] }
  | { requestId: string; type: 'profile-updated'; updatedItemCount: number; completedAt: string }
  /** M5 durable receipt; UI presentation is intentionally deferred to M8. */
  | { requestId: string; type: 'memory-used'; items: MemoryUsedSnapshot[] }
  | { requestId: string; type: 'memory-saved'; receipt: import('./memory/memoryTypes').MemorySaveReceipt }
  | { requestId: string; type: 'error'; message: string }
  | { requestId: string; type: 'cancelled' };

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const intentScopes: Record<AssistantIntent, AssistantScope[]> = {
  ask: ['chat', 'current-note', 'library-search', 'wiki-node'],
  'learning-plan': ['library-search'],
  organize: ['library-structure'],
};

export function validateAssistantTurnRequest(value: unknown): AssistantTurnRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 助手请求格式无效。');
  const input = value as Record<string, unknown>;
  const requestId = readString(input.requestId, '请求标识', 128);
  if (!requestIdPattern.test(requestId)) throw new Error('请求标识格式无效。');
  if (typeof input.intent !== 'string' || !assistantIntents.includes(input.intent as AssistantIntent)) throw new Error('不支持的 AI 助手任务。');
  if (typeof input.scope !== 'string' || !assistantScopes.includes(input.scope as AssistantScope)) throw new Error('AI 助手范围无效。');
  const intent = input.intent as AssistantIntent;
  const scope = input.scope as AssistantScope;
  if (!intentScopes[intent].includes(scope)) throw new Error('当前任务不能使用该笔记范围。');
  if (input.model !== undefined || input.systemPrompt !== undefined || input.sources !== undefined || input.markdown !== undefined || input.mcp !== undefined || input.tools !== undefined) {
    throw new Error('AI 助手请求包含不允许的字段。');
  }
  const userText = readString(input.userText, '问题或目标', 2_000);
  if (!userText.trim()) throw new Error('请输入问题或目标。');
  const currentNotePath = input.currentNotePath === undefined ? undefined : readString(input.currentNotePath, '当前笔记路径', 4_000);
  if (scope === 'current-note' && !currentNotePath?.trim()) throw new Error('请先选择当前笔记。');
  if (scope !== 'current-note' && currentNotePath) throw new Error('当前任务不接受当前笔记路径。');
  const wikiTarget = input.wikiTarget === undefined ? undefined : readWikiTarget(input.wikiTarget);
  if (scope === 'wiki-node' && !wikiTarget) throw new Error('请先选择 Wiki 节点。');
  if (scope !== 'wiki-node' && wikiTarget) throw new Error('当前任务不接受 Wiki 节点目标。');
  const sessionId = input.sessionId === undefined ? undefined : readId(input.sessionId, '会话标识');
  const contextSources = input.contextSources === undefined ? [] : readContextSources(input.contextSources);
  const attachments = input.attachments === undefined ? [] : readAttachments(input.attachments);
  if (scope === 'chat' && contextSources.length) throw new Error('普通 AI 问答不接受资料库来源。');
  const hasDedicatedKnowledgeBaseSession = scope === 'library-search'
    && contextSources.length === 1
    && contextSources[0].kind === 'knowledge-base';
  if (scope !== 'current-note' && sessionId && !hasDedicatedKnowledgeBaseSession && scope !== 'chat') throw new Error('当前任务不接受 AI 会话标识。');
  const conversation = readConversation(input.conversation);
  const modelProfileId = input.modelProfileId === undefined ? undefined : readId(input.modelProfileId, '模型档案');
  const thinkingMode = input.thinkingMode === undefined
    ? undefined
    : assistantThinkingModes.includes(input.thinkingMode as AssistantThinkingMode)
      ? input.thinkingMode as AssistantThinkingMode
      : undefined;
  if (input.thinkingMode !== undefined && thinkingMode === undefined) throw new Error('思考强度无效。');
  const answerDepth = input.answerDepth === undefined
    ? 'auto'
    : assistantAnswerDepths.includes(input.answerDepth as AssistantAnswerDepth)
      ? input.answerDepth as AssistantAnswerDepth
      : undefined;
  if (!answerDepth) throw new Error('回答深度无效。');
  const skillIds = input.skillIds === undefined ? [] : readIds(input.skillIds, 'AI 助手技能', 3);
  const webSearch = input.webSearch === undefined
    ? undefined
    : input.webSearch === 'on' || input.webSearch === 'off'
      ? input.webSearch
      : undefined;
  if (input.webSearch !== undefined && webSearch === undefined) throw new Error('联网搜索开关无效。');
  const summaryCheckpoint = input.summaryCheckpoint === undefined ? undefined : readSummaryCheckpoint(input.summaryCheckpoint);
  return {
    requestId,
    intent,
    scope,
    userText,
    ...(currentNotePath ? { currentNotePath } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(contextSources.length ? { contextSources } : {}),
    ...(attachments.length ? { attachments } : {}),
    conversation,
    ...(modelProfileId ? { modelProfileId } : {}),
    ...(thinkingMode ? { thinkingMode } : {}),
    answerDepth,
    ...(skillIds.length ? { skillIds } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(summaryCheckpoint ? { summaryCheckpoint } : {}),
    ...(wikiTarget ? { wikiTarget } : {}),
  };
}

function readSummaryCheckpoint(value: unknown): SummaryRunCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('摘要续跑 checkpoint 格式无效。');
  const input = value as Record<string, unknown>;
  const read = (candidate: unknown, label: string, maxLength: number): string => {
    if (typeof candidate !== 'string' || candidate.length > maxLength) throw new Error(`${label}格式无效。`);
    return candidate;
  };
  const mode = input.mode === 'summary-quick' || input.mode === 'summary-complete' ? input.mode : undefined;
  if (input.schemaVersion !== 1 || !mode) throw new Error('摘要续跑 checkpoint 版本或模式无效。');
  if (!Array.isArray(input.completedSectionIds) || input.completedSectionIds.length > 128) throw new Error('摘要续跑章节进度无效。');
  const completedSectionIds = input.completedSectionIds.map((id) => read(id, '摘要章节标识', 160));
  const checkpoint: SummaryRunCheckpoint = {
    schemaVersion: 1,
    mode,
    snapshotId: read(input.snapshotId, '摘要快照标识', 160),
    contentHash: read(input.contentHash, '摘要内容哈希', 128),
    libraryId: read(input.libraryId, '摘要资料库标识', 160),
    relativePath: read(input.relativePath, '摘要笔记路径', 4_000),
    providerFingerprint: read(input.providerFingerprint, '摘要模型指纹', 320),
    model: read(input.model, '摘要模型', 160),
    completedSectionIds,
  };
  if (input.reduceLevel !== undefined || input.reduceBatchIndex !== undefined) {
    const reduceLevel = typeof input.reduceLevel === 'number' ? input.reduceLevel : undefined;
    const reduceBatchIndex = typeof input.reduceBatchIndex === 'number' ? input.reduceBatchIndex : undefined;
    if (reduceLevel === undefined || reduceBatchIndex === undefined || !Number.isInteger(reduceLevel) || !Number.isInteger(reduceBatchIndex) || reduceLevel < 0 || reduceLevel > 6 || reduceBatchIndex < 0 || reduceBatchIndex > 128) throw new Error('摘要归并 checkpoint 层级无效。');
    checkpoint.reduceLevel = reduceLevel;
    checkpoint.reduceBatchIndex = reduceBatchIndex;
  }
  if (input.reduceItems !== undefined) checkpoint.reduceItems = readSummaryReduceItems(input.reduceItems);
  if (input.reduceCompletedItems !== undefined) checkpoint.reduceCompletedItems = readSummaryReduceItems(input.reduceCompletedItems);
  return checkpoint;
}

function readSummaryReduceItems(value: unknown): NonNullable<SummaryRunCheckpoint['reduceItems']> {
  if (!Array.isArray(value) || value.length > 128) throw new Error('摘要归并 checkpoint 内容无效。');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('摘要归并 checkpoint 项无效。');
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.headingPath) || item.headingPath.length > 8 || item.headingPath.some((part) => typeof part !== 'string' || part.length > 300)) throw new Error('摘要标题路径无效。');
    if (typeof item.summary !== 'string' || item.summary.length > 4_000 || !Array.isArray(item.keyPoints) || item.keyPoints.length > 24 || item.keyPoints.some((point) => typeof point !== 'string' || point.length > 800)) throw new Error('摘要归并文本无效。');
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length > 64) throw new Error('摘要归并来源无效。');
    return {
      headingPath: [...item.headingPath] as string[],
      summary: item.summary,
      keyPoints: [...item.keyPoints] as string[],
      sourceRefs: item.sourceRefs.map((sourceRef) => {
        if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) throw new Error('摘要归并来源格式无效。');
        const ref = sourceRef as Record<string, unknown>;
        if (typeof ref.blockId !== 'string' || ref.blockId.length > 160 || typeof ref.textHash !== 'string' || ref.textHash.length > 128 || !Number.isInteger(ref.lineFrom) || !Number.isInteger(ref.lineTo)) throw new Error('摘要归并来源格式无效。');
        return { blockId: ref.blockId, lineFrom: ref.lineFrom as number, lineTo: ref.lineTo as number, textHash: ref.textHash };
      }),
    };
  });
}

function readWikiTarget(value: unknown): AssistantWikiTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wiki 节点目标格式无效。');
  const input = value as Record<string, unknown>;
  const libraryPath = readString(input.libraryPath, 'Wiki 资料库路径', 4_000);
  if (!libraryPath.trim()) throw new Error('Wiki 资料库路径无效。');
  const documentId = readString(input.documentId, 'Wiki 文档标识', 160);
  if (!documentId.trim()) throw new Error('Wiki 文档标识无效。');
  const nodeId = readString(input.nodeId, 'Wiki 节点标识', 320);
  if (!nodeId.trim()) throw new Error('Wiki 节点标识无效。');
  if (!isWikiActionKind(input.actionKind)) throw new Error('Wiki 快捷动作无效。');
  return { libraryPath, documentId, nodeId, actionKind: input.actionKind };
}

function readContextSources(value: unknown): AssistantContextSource[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('AI 助手查询范围格式无效。');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 助手查询范围格式无效。');
    const input = entry as Record<string, unknown>;
    if (typeof input.kind !== 'string' || !assistantContextSourceKinds.includes(input.kind as AssistantContextSourceKind)) throw new Error('AI 助手查询范围类型无效。');
    const libraryPath = readString(input.libraryPath, '查询范围路径', 4_000);
    const label = input.label === undefined ? undefined : readString(input.label, '查询范围名称', 160);
    return { kind: input.kind as AssistantContextSourceKind, libraryPath, ...(label?.trim() ? { label: label.trim() } : {}) };
  });
}

function readAttachments(value: unknown): AssistantAttachment[] {
  if (!Array.isArray(value) || value.length > maxAssistantAttachmentCount) {
    throw new Error(`AI 附件数量不能超过 ${maxAssistantAttachmentCount} 个。`);
  }
  let imageTotalBytes = 0;
  let textTotalBytes = 0;
  const seenIds = new Set<string>();
  return value.map((entry): AssistantAttachment => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI 附件格式无效。');
    const input = entry as Record<string, unknown>;
    const attachmentId = readId(input.attachmentId, 'AI 附件');
    if (seenIds.has(attachmentId)) throw new Error('AI 附件标识重复。');
    seenIds.add(attachmentId);
    const name = readString(input.name, 'AI 附件名称', 255);
    if (input.kind === 'image') {
      const mimeType = input.mimeType;
      if (typeof mimeType !== 'string' || !assistantImageMimeTypes.includes(mimeType as AssistantImageMimeType)) {
        throw new Error('图片附件 MIME 类型无效。');
      }
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxAssistantImageBytes) {
        throw new Error(`图片附件“${name}”大小无效（上限 ${Math.floor(maxAssistantImageBytes / 1_000_000)} MB）。`);
      }
      imageTotalBytes += input.sizeBytes;
      if (imageTotalBytes > maxAssistantImageTotalBytes) {
        throw new Error(`图片附件总大小不能超过 ${Math.floor(maxAssistantImageTotalBytes / 1_000_000)} MB。`);
      }
      const dataUrl = readString(input.dataUrl, '图片附件数据', 32_000_000);
      if (!dataUrl.startsWith(`data:${mimeType};base64,`)) throw new Error('图片附件 dataUrl 格式无效。');
      return {
        kind: 'image',
        attachmentId,
        name,
        mimeType: mimeType as AssistantImageMimeType,
        sizeBytes: input.sizeBytes,
        dataUrl,
      };
    }
    if (input.kind === 'document') {
      const attachmentPath = readString(input.path, 'AI 附件路径', 4_000);
      const extension = attachmentPath.slice(attachmentPath.lastIndexOf('.')).toLowerCase();
      if (!assistantDocumentExtensions.has(extension)) throw new Error(`文档附件“${name}”扩展名不支持：${extension || '未知'}。`);
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxAssistantDocumentBytes) {
        throw new Error(`文档附件“${name}”大小无效（上限 ${Math.floor(maxAssistantDocumentBytes / 1_000_000)} MB）。`);
      }
      const mimeType = readString(input.mimeType, '文档附件 MIME', 160);
      return {
        kind: 'document',
        attachmentId,
        path: attachmentPath,
        name,
        mimeType,
        sizeBytes: input.sizeBytes,
      };
    }
    if (input.kind === 'text') {
      const attachmentPath = readString(input.path, 'AI 附件路径', 4_000);
      const extension = attachmentPath.slice(attachmentPath.lastIndexOf('.')).toLowerCase();
      if (!assistantTextExtensions.has(extension)) throw new Error(`文本附件“${name}”扩展名不支持：${extension || '未知'}。`);
      if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > maxAssistantAttachmentBytes) {
        throw new Error(`文本附件“${name}”大小无效（上限 ${Math.floor(maxAssistantAttachmentBytes / 1_000_000)} MB）。`);
      }
      textTotalBytes += input.sizeBytes;
      if (textTotalBytes > maxAssistantAttachmentTotalBytes) throw new Error('文本附件总大小不能超过 5 MB。');
      return {
        kind: 'text',
        attachmentId,
        path: attachmentPath,
        name,
        sizeBytes: input.sizeBytes,
      };
    }
    throw new Error('AI 附件类型无效。');
  });
}

function readConversation(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error('会话上下文格式无效。');
  let total = 0;
  const result: AssistantConversationMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('会话上下文格式无效。');
    const message = entry as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') throw new Error('会话角色无效。');
    if (typeof message.content !== 'string') throw new Error('会话内容格式无效。');
    // 历史消息只是辅助上下文：单条超长时保留尾部截断，避免应用自身产生的长回答阻断新一轮提问。
    const content = message.content.slice(Math.max(0, message.content.length - 2_000)).trim();
    if (!content) continue;
    total += content.length;
    if (total > 4_000) throw new Error('会话上下文不能超过 4000 字符。');
    result.push({ role: message.role, content });
  }
  return result;
}

function readString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}

function readId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{7,96}$/.test(value)) throw new Error(`${label}标识无效。`);
  return value;
}

function readIds(value: unknown, label: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength) throw new Error(`${label}格式无效。`);
  return Array.from(new Set(value.map((entry) => readId(entry, label))));
}
