/**
 * SE-0 shared contract for the future unified selection-edit workflow.
 *
 * This file intentionally has no IPC, model, filesystem, or editor mutation
 * behavior. SE-1 through SE-7 must migrate existing selection transform and
 * selection expansion code to this contract behind their respective gates.
 */

import type { SelectionLengthReceipt } from '../../shared/selectionExpansionPolicy';

export const selectionEditActions = [
  'polish',
  'shorten',
  'expand',
  'proofread',
  'explain',
  'translate',
  'custom',
] as const;

export type SelectionEditAction = typeof selectionEditActions[number];

export const selectionEditContextScopes = ['auto', 'nearby', 'current-note', 'extended'] as const;
export type SelectionEditContextScope = typeof selectionEditContextScopes[number];

/** Facts may only be synthesized from source kinds listed here after a bounded read. */
export const selectionEditFactSourceKinds = ['current-note', 'note-library', 'materials', 'web'] as const;
export type SelectionEditFactSourceKind = typeof selectionEditFactSourceKinds[number];

/** Preferences may influence wording and terminology but can never support a factual claim. */
export const selectionEditPreferenceSourceKinds = ['personalization'] as const;
export type SelectionEditPreferenceSourceKind = typeof selectionEditPreferenceSourceKinds[number];

export interface SelectionEditSourceAuthorization {
  currentNote: boolean;
  noteLibrary: boolean;
  materialsLibrary: boolean;
  web: boolean;
  personalization: boolean;
}

export const selectionEditWritebackModes = ['replace', 'insert-below', 'copy-only'] as const;
export type SelectionEditWritebackMode = typeof selectionEditWritebackModes[number];

export const selectionEditWritebackKinds = ['inline-text', 'block-markdown', 'copy-only'] as const;
export type SelectionEditWritebackKind = typeof selectionEditWritebackKinds[number];

/**
 * Main-process snapshot contract. The renderer's SE-2 structure receipt is
 * promoted here only after a saved-note locator supplies the library, hash,
 * line, and heading identity fields. `sliceJson` remains opaque to IPC.
 */
export interface SelectionSnapshotV2 {
  editorSessionId: string;
  libraryId: string;
  currentPath: string;
  docRevision: number;
  noteContentHash: string;
  from: number;
  to: number;
  selectedText: string;
  selectedTextHash: string;
  markdownFragment: string;
  sliceJson: unknown;
  canonicalSliceJson: string;
  selectionStructureSignature: string;
  documentStructureSignature: string;
  lineFrom: number;
  lineTo: number;
  headingPath: Array<{ id: string; text: string }>;
  blockKinds: string[];
  rect: { left: number; top: number; right: number; bottom: number };
}

export interface SelectionEditRequest {
  requestId: string;
  action: SelectionEditAction;
  snapshot: SelectionSnapshotV2;
  sourceSnapshotId: string;
  contextScope: SelectionEditContextScope;
  allowedSources: SelectionEditSourceAuthorization;
  targetLanguage?: string;
  customInstruction?: string;
  outputPreference: SelectionEditWritebackMode;
  modelProfileId?: string;
}

export const selectionEditRoutes = ['local-transform', 'current-note-research', 'extended-research'] as const;
export type SelectionEditRoute = typeof selectionEditRoutes[number];

export interface SelectionEditContextGoal {
  goalId: string;
  kind: 'style' | 'terminology' | 'definition' | 'support' | 'conflict' | 'coverage';
  queryTerms: string[];
  required: boolean;
}

export interface SelectionEditContextPlan {
  action: SelectionEditAction;
  route: SelectionEditRoute;
  goals: SelectionEditContextGoal[];
  plannedSources: SelectionEditFactSourceKind[];
  budgets: {
    maxToolCalls: number;
    maxEvidenceCharacters: number;
    maxModelTokens: number;
  };
}

export interface SelectionEvidenceItem {
  evidenceId: string;
  sourceKind: SelectionEditFactSourceKind;
  title: string;
  locator: string;
  headingPath?: string[];
  content: string;
  sourceContentHash?: string;
  textHash: string;
  goalIds: string[];
  readVerified: boolean;
  pageVerified?: boolean;
}

export interface SelectionContextReceipt {
  contextMode?: 'full-note' | 'related-original' | 'nearby' | 'legacy' | 'not-requested';
  fullNoteCharacters?: number;
  includedCharacters?: number;
  fullNoteIncluded?: boolean;
  planned: Array<{ sourceKind: SelectionEditFactSourceKind; reason: string }>;
  used: Array<{ sourceKind: SelectionEditFactSourceKind; title: string; locator: string; characterCount: number }>;
  skipped: Array<{ sourceKind: SelectionEditFactSourceKind; reason: string }>;
  /**
   * 检索命中只是导航线索。它们必须保留在回执中，且绝不能被当作
   * `used` 或模型可见证据；只有深读后才会产生 SelectionEvidenceItem。
   */
  candidates: Array<{
    candidateId: string;
    sourceKind: SelectionEditFactSourceKind;
    title: string;
    locator: string;
    queryTerms: string[];
    retrievalMethod: string;
    readState: 'candidate' | 'deep-read' | 'skipped';
    score?: number;
    /** 网页搜索摘要为 false；只有完成 web_fetch 后才可升级为 true。 */
    pageVerified?: boolean;
    /** Candidate-time identity check; never rendered or sent to the model. */
    sourceContentHash?: string;
    reason?: string;
  }>;
  /** 保守识别出的来源表述差异；仅提示人工核对，不能作为事实依据。 */
  conflicts: Array<{
    conflictId: string;
    evidenceIds: string[];
    summary: string;
    status: 'needs-review';
  }>;
  /**
   * 个性化资料与事实来源严格分开：仅提供写作风格和术语偏好，
   * 绝不进入 Evidence Ledger、引用或事实校验。
   */
  personalization: {
    requested: boolean;
    applied: boolean;
    itemCount: number;
    reason?: string;
  };
  fullNoteMode: 'not-requested' | 'strict-direct' | 'map-and-read';
}

export interface SelectionEditValidation {
  passed: boolean;
  warnings: string[];
  protectedAnchorLosses: string[];
  unsupportedClaims: string[];
  /**
   * RA-0 freezes machine-readable quality reasons without changing the legacy
   * warning arrays consumed by the current renderer. RA-4 will project these
   * issues into SelectionEditQualityReceipt and dedicated UI states.
   */
  issues: SelectionEditQualityIssue[];
}

export const selectionEditQualityIssueCodes = [
  'EXPAND_NOT_LONGER',
  'TARGET_LENGTH_MISSED',
  'MARKDOWN_FORMAT_LOST',
  'PROTECTED_ANCHOR_LOST',
  'UNSUPPORTED_ADDITION',
  'EVIDENCE_GOAL_UNCOVERED',
  'WEB_PAGE_UNVERIFIED',
  'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
] as const;

export type SelectionEditQualityIssueCode = typeof selectionEditQualityIssueCodes[number];

export interface SelectionEditQualityIssue {
  code: SelectionEditQualityIssueCode;
  message: string;
  retryable: boolean;
}

/** RA-0 type contract only; runtime/UI projection is implemented in RA-4. */
export interface SelectionEditQualityReceipt {
  lengthReceipt?: SelectionLengthReceipt;
  generation: 'complete' | 'partial' | 'empty';
  evidenceCoverage: 'complete' | 'partial' | 'none' | 'not-required';
  validation: 'passed' | 'failed';
  issues: SelectionEditQualityIssue[];
}

/**
 * Renderer-safe execution counters. They intentionally describe only work
 * actually used for this result: development-only shadow work is omitted.
 */
export interface SelectionEditExecutionReceipt {
  path: 'direct' | 'react';
  rounds: number;
  modelCalls: number;
  toolCalls: number;
  repairAttempts: number;
}

export interface SelectionEditResult {
  requestId: string;
  action: SelectionEditAction;
  text: string;
  markdown?: string;
  writebackKind: SelectionEditWritebackKind;
  suggestedApplyMode: SelectionEditWritebackMode;
  changes?: Array<{ kind: string; before: string; after: string; reason: string }>;
  receipt: SelectionContextReceipt;
  evidence: SelectionEvidenceItem[];
  validation: SelectionEditValidation;
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  sourceSnapshotId: string;
  selectedTextHash: string;
  /** Provider metadata is returned by the coordinator so legacy IPC adapters do not invent it. */
  provider: 'ollama' | 'openai-compatible';
  model: string;
  generatedAt: string;
}

export const selectionEditStages = [
  'preparing',
  'planning',
  'reading',
  'validating',
  'generating',
  'ready',
  'cancelled',
  'failed',
  'stale',
] as const;
export type SelectionEditStage = typeof selectionEditStages[number];

export type SelectionEditEventPayload =
  | { type: 'started' }
  | { type: 'status'; stage: SelectionEditStage; message: string }
  | { type: 'plan'; plan: SelectionEditContextPlan }
  | { type: 'evidence'; evidence: SelectionEvidenceItem }
  | { type: 'complete'; result: SelectionEditResult }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; message: string };

export type SelectionEditEvent = SelectionEditEventPayload & {
  requestId: string;
  sessionId: string;
  sequence: number;
};
