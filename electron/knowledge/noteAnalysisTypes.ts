import type { AiProviderKind } from './aiTypes';

export type TagSuggestionConfidence = 'high' | 'medium' | 'low';
export type NoteAnalysisProcessingMode = 'full-document' | 'batched';

export interface NoteAnalysisPreparationStats {
  sourceCharacters: number;
  originalBodyCharacters: number;
  cleanedBodyCharacters: number;
  duplicateBlocks: number;
  duplicateCharacters: number;
  removedBlocks: number;
}

export interface NoteAnalysisTagCandidate {
  name: string;
  confidence: TagSuggestionConfidence;
  evidence: string;
  sourceBatchIds?: string[];
}

export interface NoteAnalysisPayload {
  summary: string;
  keyPoints: string[];
  tagCandidates: NoteAnalysisTagCandidate[];
  analysisVersion?: 2;
  runId?: string;
  totalBatches?: number;
  completedBatches?: number;
  batches?: NoteAnalysisBatchResult[];
  processingMode?: NoteAnalysisProcessingMode;
  preparationVersion?: string;
  preparationStats?: NoteAnalysisPreparationStats;
}

export type NoteAnalysisRunState = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type NoteAnalysisBatchState = 'pending' | 'running' | 'retrying-length' | 'succeeded' | 'failed' | 'cancelled';
export type NoteAnalysisLengthHandling = 'within-limit' | 'retry-within-limit' | 'truncated' | 'structured-over-limit-accepted';

export interface NoteAnalysisSourceSpan {
  startOffset: number;
  endOffset: number;
  lineFrom: number;
  lineTo: number;
  unitId: string;
  unitIndex: number;
  kind: 'paragraph' | 'list' | 'quote' | 'code' | 'table' | 'other';
  partIndex?: number;
  partCount?: number;
  /** 清洗后的单位内UTF-16坐标；原始start/endOffset仍指向未改写笔记。 */
  cleanedFrom?: number;
  cleanedTo?: number;
}

export interface NoteAnalysisBatchSection {
  headingPath: string[];
  headingId?: string;
  coreSpans: NoteAnalysisSourceSpan[];
  duplicateSpans: NoteAnalysisSourceSpan[];
}

export interface NoteAnalysisBatchPlan {
  batchId: string;
  batchIndex: number;
  mode: 'structured' | 'plain';
  headingPath: string[];
  sourceLabel: string;
  coreSpans: NoteAnalysisSourceSpan[];
  contextSpans: NoteAnalysisSourceSpan[];
  inputHash: string;
  inputCharacterCount: number;
  overlapCharacterCount: number;
  processingMode?: NoteAnalysisProcessingMode;
  sections?: NoteAnalysisBatchSection[];
}

export interface NoteAnalysisBatchResult extends NoteAnalysisBatchPlan {
  status: NoteAnalysisBatchState;
  summary?: string;
  summaryCharacterCount?: number;
  keyPoints: string[];
  tagCandidates: NoteAnalysisTagCandidate[];
  generationAttempts: number;
  firstSummaryCharacterCount?: number;
  retrySummaryCharacterCount?: number;
  lengthHandling?: NoteAnalysisLengthHandling;
  generatedAt?: string;
  error?: { code: string; message: string };
}

/** 可发送给渲染进程的任务信息；不包含原文快照、密钥或模型连接配置。 */
export interface NoteAnalysisRunDetail {
  runId: string;
  notePath: string;
  sourceHash: string;
  inputTextHash: string;
  policyVersion: string;
  promptVersion: string;
  planHash: string;
  providerFingerprint: string;
  provider: AiProviderKind;
  model: string;
  state: NoteAnalysisRunState;
  totalBatches: number;
  completedBatches: number;
  createdAt: string;
  updatedAt: string;
  isStale?: boolean;
  error?: { code: string; message: string };
  batches: NoteAnalysisBatchResult[];
  processingMode?: NoteAnalysisProcessingMode;
  preparationVersion?: string;
  preparationStats?: NoteAnalysisPreparationStats;
}

export interface NoteAnalysisProgress {
  runId: string;
  notePath: string;
  sourceHash: string;
  state: NoteAnalysisRunState;
  totalBatches: number;
  completedBatches: number;
  batchIndex?: number;
  batchStatus?: NoteAnalysisBatchState;
  error?: { code: string; message: string };
}

export interface NoteAnalysis extends NoteAnalysisPayload {
  notePath: string;
  sourceHash: string;
  provider: AiProviderKind;
  model: string;
  generatedAt: string;
  isStale?: boolean;
}
