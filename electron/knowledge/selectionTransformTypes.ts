import type {
  SelectionEditContextScope,
  SelectionEditExecutionReceipt,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
  SelectionContextReceipt,
} from './selectionEditTypes';

export const selectionTransformActions = [
  'polish',
  'shorten',
  'expand',
  'proofread',
  'explain',
  'translate',
  'custom',
] as const;

export type SelectionTransformAction = typeof selectionTransformActions[number];

export interface SelectionTransformContext {
  before: string;
  after: string;
}

export interface SelectionTransformRequest {
  requestId: string;
  action: SelectionTransformAction;
  selectedText: string;
  context?: SelectionTransformContext;
  targetLanguage?: string;
  instruction?: string;
  model?: string;
  /** Optional SE-4 source locator; omitted requests retain the local-only legacy behavior. */
  currentPath?: string;
  contextScope?: SelectionEditContextScope;
}

export interface SelectionTransformResult {
  requestId: string;
  text: string;
  provider: 'ollama' | 'openai-compatible';
  model: string;
  writebackKind: 'inline-text' | 'block-markdown' | 'copy-only';
  suggestedApplyMode: 'replace' | 'insert-below' | 'copy-only';
  validation: SelectionEditValidation;
  qualityReceipt: SelectionEditQualityReceipt;
  execution: SelectionEditExecutionReceipt;
  contextReceipt?: SelectionContextReceipt;
}
