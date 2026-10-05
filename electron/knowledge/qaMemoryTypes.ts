import type { AssistantTurnResult } from './assistantTurnTypes';
import type { ContextMemoryResult, ContextProjectInput } from './contextMemoryTypes';
import type { MemoryProjectionMode, MemoryProjectionReadDiagnostics } from './memory/memoryCutover';
import type { MemoryUsedSnapshot } from './memory/memoryTypes';

/**
 * 问答区统一记忆链路类型。该链路与 assistant-memory.db /
 * conversation-memory.db 零交叉；开放式问答和知识库问答使用独立会话。
 */

/** 会话固定的问答模式；一个有内容的会话不得跨模式继续写入。 */
export type QaSessionScope = 'chat' | 'knowledge-base';

export type QaTurnStatus =
  | 'pending'
  | 'complete'
  | 'partial'
  | 'not-found'
  | 'cancelled'
  | 'error'
  | 'interrupted';

/** 进入短期记忆窗口的轮次状态；取消/失败轮不入窗。 */
export const QA_HOT_TURN_STATUSES: readonly QaTurnStatus[] = ['complete', 'partial', 'not-found'];

export type QaSummaryCompressor = 'llm' | 'fallback';
export type QaSummaryStatus = 'done' | 'failed';
export type QaSummaryRollupLevel = 2 | 3;
export type QaSummaryRollupStatus = 'done' | 'failed' | 'stale';

export interface QaSessionSummary {
  sessionId: string;
  /** 会话模式；用于阻止开放式问答与知识库问答共用历史。 */
  scope: QaSessionScope;
  title: string;
  pinned: boolean;
  libraryPath?: string;
  turnCount: number;
  lastTurnSeq: number;
  summarizedThroughSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface QaMemoryPage<T> {
  items: T[];
  nextCursor?: number;
}

export interface QaStoredTurn {
  turnId: string;
  requestId?: string;
  attemptNo?: number;
  turnSeq: number;
  userText: string;
  assistantText?: string;
  scopeLabel: string;
  status: QaTurnStatus;
  result?: AssistantTurnResult;
  createdAt: string;
  finishedAt?: string;
  usedMemories?: MemoryUsedSnapshot[];
}

export interface QaSummaryBlock {
  batchId: string;
  turnFrom: number;
  turnTo: number;
  summaryText: string;
  tokens: number;
  compressor: QaSummaryCompressor;
  status: QaSummaryStatus;
  retryCount: number;
  updatedAt: string;
}

export interface QaSessionDetail {
  session: QaSessionSummary;
  turns: QaStoredTurn[];
  summaries: QaSummaryBlock[];
}

/** 调试轨展示的各分区实际 token。 */
export interface QaMemoryZoneTokens {
  staticPrefix: number;
  rollingSummary: number;
  shortTerm: number;
  dynamic: number;
  questionConstraint: number;
}

/** 改写 prompt 的 <history> 原料：已完成轮次原文 + 回答头部（时间正序）。 */
export interface QaRecentTurn {
  userText: string;
  answerHead: string;
}

/** Main-process-only source data for the Phase 0 residual-window observer. */
export interface QaResidualMemoryObservationInput {
  memorableTurns: QaStoredTurn[];
  legacy: {
    rollingSummaryTokens: number;
    shortTermTokens: number;
    summaryMaterialCount: number;
    summaryTurnRanges?: Array<{ turnFrom: number; turnTo: number }>;
    hotTurnSeqs: number[];
  };
}

export interface QaMemoryPreparation {
  sessionId: string;
  /** Independent project, summary, and hot-history materials for ContextEnvelope. */
  contextMemory: ContextMemoryResult;
  zoneTokens: Pick<QaMemoryZoneTokens, 'rollingSummary' | 'shortTerm'>;
  /** 最近已完成轮次（正序），供问题改写 <history> 使用。 */
  recentTurns: QaRecentTurn[];
  /** Canonical L2 turns and their transport-neutral replay messages. */
  recentCompleteTurns: QaRecentCompleteTurn[];
  recentHistoryMessages: QaCanonicalHistoryMessage[];
  memoryProjection: {
    mode: MemoryProjectionMode;
    activeReader: 'legacy' | 'canonical';
    legacyContext: ContextMemoryResult;
    canonicalContext: ContextMemoryResult;
    readDiagnostics: MemoryProjectionReadDiagnostics;
  };
  /** Shadow-only input; it is never rendered into the active legacy Prompt. */
  residualObservation: QaResidualMemoryObservationInput;
  turnSeq: number;
  turnId: string;
}

export interface QaSummaryRollup {
  rollupId: string;
  level: QaSummaryRollupLevel;
  sourceStartSeq: number;
  sourceEndSeq: number;
  sourceIds: string[];
  sourceHash: string;
  summaryText: string;
  tokens: number;
  compressor: QaSummaryCompressor;
  status: QaSummaryRollupStatus;
  summaryVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface QaConversationCheckpointDecision {
  statement: string;
  status: 'active' | 'superseded' | 'uncertain';
  sourceTurnSeqs: number[];
}

export interface QaConversationCheckpointCorrection {
  corrected: string;
  replacement: string;
  sourceTurnSeq: number;
}

export interface QaConversationCheckpointArtifact {
  id: string;
  label: string;
  sourceTurnSeq: number;
}

/** 单一滚动会话 Checkpoint 的结构化、不可信记忆载荷。 */
export interface QaConversationCheckpointV1 {
  schemaVersion: 1;
  sessionId: string;
  checkpointVersion: number;
  coveredFromSeq: 1;
  coveredThroughSeq: number;
  sourceHash: string;
  userGoals: string[];
  activeConstraints: string[];
  decisions: QaConversationCheckpointDecision[];
  userCorrections: QaConversationCheckpointCorrection[];
  resolvedTopics: string[];
  unresolvedTopics: string[];
  referencedArtifacts: QaConversationCheckpointArtifact[];
  recentHandoff: string;
  summaryTokens: number;
  compressor: QaSummaryCompressor;
  modelProfile?: string;
}

export interface QaConversationCheckpoint {
  sessionId: string;
  checkpointVersion: number;
  coveredFromSeq: 1;
  coveredThroughSeq: number;
  sourceHash: string;
  payload: QaConversationCheckpointV1;
  summaryText: string;
  summaryTokens: number;
  targetTokens: number;
  sourceTokens: number;
  compressionRatio: number;
  compressor: QaSummaryCompressor;
  modelProfile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QaConversationCheckpointCandidate {
  payload: QaConversationCheckpointV1;
  summaryText: string;
  summaryTokens: number;
  summaryHardMaxTokens: number;
  targetTokens: number;
  sourceTokens: number;
  compressionRatio: number;
}

export type QaMemoryCompactionRunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'conflict'
  | 'interrupted';

export interface QaMemoryCompactionRun {
  runId: string;
  sessionId: string;
  baseCheckpointVersion: number;
  sourceFromSeq: number;
  sourceToSeq: number;
  sourceHash: string;
  sourceTokens: number;
  targetTokens: number;
  outputTokens?: number;
  status: QaMemoryCompactionRunStatus;
  errorCode?: string;
  createdAt: string;
  finishedAt?: string;
}

/** Historical attachment metadata; image bytes and local paths never persist. */
export interface QaTurnAttachmentDescriptor {
  attachmentId: string;
  kind: 'image' | 'document' | 'text';
  name: string;
  mimeType?: string;
  sizeBytes: number;
}

export interface QaAgentToolCall {
  callId: string;
  callSeq: number;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** One persisted assistant/tool message inside an Agent turn. */
export interface QaAgentMessage {
  messageId: string;
  messageSeq: number;
  role: 'assistant' | 'tool';
  content: string;
  reasoningContent: string;
  toolCallId?: string;
  toolName?: string;
  artifactRef?: Record<string, unknown>;
  toolCalls: QaAgentToolCall[];
  createdAt: string;
}

export interface QaAgentToolCallInput {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface QaAgentMessageInput {
  role: 'assistant' | 'tool';
  content?: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolName?: string;
  artifactRef?: Record<string, unknown>;
  toolCalls?: QaAgentToolCallInput[];
}

export type QaCanonicalRoute =
  | 'chat'
  | 'knowledge-base'
  | 'current-note-direct'
  | 'current-note-react';

export interface QaTurnMetadata {
  schemaVersion: 1;
  route: QaCanonicalRoute;
  attachments: QaTurnAttachmentDescriptor[];
  memoryExtractionGeneration?: number;
  memoryExtractionEligible?: boolean;
  /** New explicit requests only; old conversations are never retroactively claimed. */
  memoryExplicitSaveEnabled?: boolean;
  memoryExplicitSavePending?: boolean;
  memoryExtractionAgentId?: string;
  /** Trusted main-process scope used by the recoverable WK-M6 archive index. */
  memoryScope?: {
    workspaceId: string;
    principalId: string;
  };
}

/** Canonical, replayable L2 turn returned in chronological order. */
export interface QaRecentCompleteTurn {
  turnId: string;
  requestId: string;
  attemptNo: number;
  turnSeq: number;
  userText: string;
  assistantText: string;
  scopeLabel: string;
  status: Extract<QaTurnStatus, 'complete' | 'partial' | 'not-found'>;
  metadata: QaTurnMetadata;
  agentMessages: QaAgentMessage[];
  createdAt: string;
  finishedAt: string;
}

export interface QaCanonicalHistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  toolName?: string;
  artifactRef?: Record<string, unknown>;
}

export type QaProjectContextInput = ContextProjectInput;
