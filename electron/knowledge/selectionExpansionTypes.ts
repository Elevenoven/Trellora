import type { SelectionLocatorCapture } from '../../shared/selectionLocatorTypes';
import type {
  SelectionContextReceipt,
  SelectionEditExecutionReceipt,
  SelectionEditFactSourceKind,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
} from './selectionEditTypes';

export const selectionExpansionCapabilityModes = ['off', 'current-note', 'local-sources', 'full'] as const;
export type SelectionExpansionCapabilityMode = typeof selectionExpansionCapabilityModes[number];

export const selectionExpansionLengthRatios = [1.3, 1.8, 2.5] as const;
export type SelectionExpansionLengthRatio = typeof selectionExpansionLengthRatios[number];
export type SelectionExpansionTargetLength =
  | { mode: 'ratio'; ratio: SelectionExpansionLengthRatio }
  | { mode: 'characters'; characters: number };

export const selectionExpansionStyles = ['preserve', 'professional', 'academic', 'plain', 'proposal'] as const;
export type SelectionExpansionStyle = typeof selectionExpansionStyles[number];

export const selectionExpansionAudiences = ['preserve', 'beginner', 'professional', 'manager'] as const;
export type SelectionExpansionAudience = typeof selectionExpansionAudiences[number];

export const selectionExpansionReasoningDepths = ['fast', 'standard', 'deep'] as const;
export type SelectionExpansionReasoningDepth = typeof selectionExpansionReasoningDepths[number];

export const selectionExpansionCitationModes = ['source-cards', 'copy-with-sources'] as const;
export type SelectionExpansionCitationMode = typeof selectionExpansionCitationModes[number];

export interface SelectionExpansionSourceSettings {
  currentNote: boolean;
  noteLibrary: boolean;
  materialsLibrary: boolean;
  web: 'off' | 'inherit' | 'on';
  /** 只影响措辞/术语；不属于事实证据来源。 */
  personalization: boolean;
}

/**
 * 持久化的是新任务的默认值；一次任务中的草稿由 Renderer 单独管理，不能直接覆盖此对象。
 */
export interface SelectionExpansionSettings {
  schemaVersion: 2;
  targetLength: SelectionExpansionTargetLength;
  style: SelectionExpansionStyle;
  audience: SelectionExpansionAudience;
  reasoningDepth: SelectionExpansionReasoningDepth;
  modelProfileId?: string;
  sources: SelectionExpansionSourceSettings;
  citationMode: SelectionExpansionCitationMode;
  customInstruction: string;
}

export interface SelectionExpansionSettingsPatch {
  targetLength?: SelectionExpansionTargetLength;
  style?: SelectionExpansionStyle;
  audience?: SelectionExpansionAudience;
  reasoningDepth?: SelectionExpansionReasoningDepth;
  modelProfileId?: string | null;
  sources?: Partial<SelectionExpansionSourceSettings>;
  citationMode?: SelectionExpansionCitationMode;
  customInstruction?: string;
}

export interface SelectionExpansionCapabilities {
  mode: SelectionExpansionCapabilityMode;
  enabled: boolean;
  sources: {
    currentNote: boolean;
    noteLibrary: boolean;
    materialsLibrary: boolean;
    web: boolean;
    personalization: boolean;
  };
  limits: {
    maxSelectedCharacters: number;
    minTargetCharacters: number;
    maxTargetCharacters: number;
    maxCustomInstructionCharacters: number;
  };
}

export const SELECTION_EXPANSION_MAX_SELECTED_CHARACTERS = 20_000;
export const SELECTION_EXPANSION_MIN_TARGET_CHARACTERS = 100;
export const SELECTION_EXPANSION_MAX_TARGET_CHARACTERS = 40_000;
export const SELECTION_EXPANSION_MAX_CUSTOM_INSTRUCTION_CHARACTERS = 500;

export type SelectionExpansionPhase = 'configuring' | 'planning' | 'researching' | 'synthesizing' | 'completed' | 'partial' | 'not-found' | 'cancelled' | 'stale' | 'error';

export interface SelectionExpansionSourcePreparation {
  currentPath: string;
  contentHash: string;
  sourceSnapshotId: string;
}

export interface SelectionExpansionRequest {
  selectionLocator?: SelectionLocatorCapture;
  selectionSnapshotId: string;
  sourceSnapshotId: string;
  currentPath: string;
  selectedText: string;
  expectedContentHash: string;
  settings: SelectionExpansionSettings;
}

export interface SelectionExpansionGoal {
  goalId: string;
  question: string;
  queryTerms: string[];
  requirements: Array<{ requirementId: string; label: string }>;
}

export interface SelectionExpansionPlan {
  planId: string;
  outline: string[];
  goals: SelectionExpansionGoal[];
  fallback: boolean;
}

export interface SelectionExpansionEvidence {
  evidenceId: string;
  sourceKind: SelectionEditFactSourceKind;
  title: string;
  locator: string;
  content: string;
  sourceContentHash?: string;
  textHash: string;
  headingPath?: string[];
  goalIds: string[];
  readVerified: boolean;
  pageVerified?: boolean;
}

export interface SelectionExpansionResult {
  requestId: string;
  sessionId: string;
  selectionSnapshotId: string;
  text: string;
  completeness: 'complete' | 'partial' | 'not-found';
  plan: SelectionExpansionPlan;
  evidence: SelectionExpansionEvidence[];
  /** 实际读取回执；候选定位与已深读原文严格分层。 */
  receipt: SelectionContextReceipt;
  /** Unified coordinator validation controls whether this legacy result may be applied inline. */
  validation: SelectionEditValidation;
  /** RA-4 separates generated output quality from legacy completeness. */
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  provider: 'ollama' | 'openai-compatible';
  model: string;
  generatedAt: string;
}

/** 由主进程补齐任务标识和单调序列号后，才会发送给渲染进程。 */
export type SelectionExpansionEventPayload =
  | { type: 'started' }
  | { type: 'status'; phase: SelectionExpansionPhase; message: string }
  | { type: 'plan'; plan: SelectionExpansionPlan }
  | { type: 'evidence'; evidence: SelectionExpansionEvidence }
  | { type: 'complete'; result: SelectionExpansionResult }
  | { type: 'cancelled' }
  | { type: 'stale'; message: string }
  | { type: 'error'; code: string; message: string };

export type SelectionExpansionEvent = SelectionExpansionEventPayload & {
  requestId: string;
  sessionId: string;
  sequence: number;
};
