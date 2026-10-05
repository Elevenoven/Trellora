import type {
  SelectionEditAction,
  SelectionEditQualityIssue,
  SelectionEditQualityIssueCode,
  SelectionEditQualityReceipt,
  SelectionEditValidation,
  SelectionEvidenceItem,
} from './selectionEditTypes';

import { createSelectionLengthReceipt } from '../../shared/selectionExpansionPolicy';

const issueLabels: Record<SelectionEditQualityIssueCode, string> = {
  EXPAND_NOT_LONGER: '扩写未达到目标长度',
  TARGET_LENGTH_MISSED: '扩写未达到目标长度',
  MARKDOWN_FORMAT_LOST: '扩写未保留原文 Markdown 格式',
  PROTECTED_ANCHOR_LOST: '原文关键信息未完整保留',
  UNSUPPORTED_ADDITION: '新增内容缺少原文依据',
  EVIDENCE_GOAL_UNCOVERED: '证据覆盖不足',
  WEB_PAGE_UNVERIFIED: '网页来源尚未全文核验',
  TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT: '目标长度超出当前模型输出能力',
};

const issuePriority: SelectionEditQualityIssueCode[] = [
  'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
  'EXPAND_NOT_LONGER',
  'TARGET_LENGTH_MISSED',
  'MARKDOWN_FORMAT_LOST',
  'PROTECTED_ANCHOR_LOST',
  'UNSUPPORTED_ADDITION',
  'WEB_PAGE_UNVERIFIED',
  'EVIDENCE_GOAL_UNCOVERED',
];

export interface SelectionEditQualityGateInput {
  action: SelectionEditAction;
  selectedText: string;
  candidateText: string;
  targetCharacters?: number;
  requiredGoalIds: readonly string[];
  evidence: readonly SelectionEvidenceItem[];
  validation: SelectionEditValidation;
  targetExceedsModelOutput?: boolean;
}

export interface SelectionEditQualityGateResult {
  validation: SelectionEditValidation;
  receipt: SelectionEditQualityReceipt;
}

/**
 * Applies the final, deterministic result policy after a generator or ReAct
 * loop has produced a candidate. This function never grants write authority;
 * callers must still require `validation.passed` before exposing writeback.
 */
export function applySelectionEditQualityGate(input: SelectionEditQualityGateInput): SelectionEditQualityGateResult {
  const validation = input.validation;
  applyExpansionLengthBoundary(validation, input);
  const evidenceCoverage = applyEvidenceCoverageBoundary(validation, input.requiredGoalIds, input.evidence);
  applyWebVerificationBoundary(validation, input.evidence);
  if (input.targetExceedsModelOutput) {
    addIssue(validation, {
      code: 'TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT',
      message: issueLabels.TARGET_EXCEEDS_MODEL_OUTPUT_LIMIT,
      retryable: false,
    });
  }
  return {
    validation,
    receipt: {
      generation: !input.candidateText.trim() ? 'empty' : validation.passed ? 'complete' : 'partial',
      evidenceCoverage,
      validation: validation.passed ? 'passed' : 'failed',
      issues: sortIssues(validation.issues ?? []),
      ...(input.action === 'expand' ? { lengthReceipt: createSelectionLengthReceipt(input.selectedText, input.candidateText, input.targetCharacters) } : {}),
    },
  };
}

export function selectionEditQualityIssueLabel(issue: Pick<SelectionEditQualityIssue, 'code'>): string {
  return issueLabels[issue.code];
}

/** Picks one human-facing reason without collapsing machine-readable issues. */
export function primarySelectionEditQualityIssue(
  receipt: Pick<SelectionEditQualityReceipt, 'issues'> | undefined,
): SelectionEditQualityIssue | undefined {
  if (!receipt?.issues.length) return undefined;
  return [...receipt.issues].sort((left, right) => issuePriority.indexOf(left.code) - issuePriority.indexOf(right.code))[0];
}

function applyExpansionLengthBoundary(validation: SelectionEditValidation, input: SelectionEditQualityGateInput): void {
  if (input.action !== 'expand') return;
  const { originalCharacters: originalLength, actualCharacters: candidateLength, minimumCharacters: targetLength } = createSelectionLengthReceipt(input.selectedText, input.candidateText, input.targetCharacters);
  if (candidateLength >= targetLength) return;
  const code: SelectionEditQualityIssueCode = candidateLength <= originalLength
    ? 'EXPAND_NOT_LONGER'
    : 'TARGET_LENGTH_MISSED';
  addIssue(validation, { code, message: issueLabels[code], retryable: !input.targetExceedsModelOutput });
}

function applyEvidenceCoverageBoundary(
  validation: SelectionEditValidation,
  requiredGoalIds: readonly string[],
  evidence: readonly SelectionEvidenceItem[],
): SelectionEditQualityReceipt['evidenceCoverage'] {
  const required = [...new Set(requiredGoalIds.filter(Boolean))];
  if (required.length === 0) return 'not-required';
  const covered = new Set(evidence.flatMap((item) => item.goalIds));
  const missing = required.filter((goalId) => !covered.has(goalId));
  if (missing.length === 0) return 'complete';
  addIssue(validation, {
    code: 'EVIDENCE_GOAL_UNCOVERED',
    message: issueLabels.EVIDENCE_GOAL_UNCOVERED,
    retryable: true,
  });
  return covered.size === 0 ? 'none' : 'partial';
}

/** Defense in depth: a search snippet is not webpage evidence. */
export function applyWebVerificationBoundary(validation: SelectionEditValidation, evidence: readonly SelectionEvidenceItem[]): void {
  if (!evidence.some((item) => item.sourceKind === 'web' && item.pageVerified !== true)) return;
  addIssue(validation, {
    code: 'WEB_PAGE_UNVERIFIED',
    message: issueLabels.WEB_PAGE_UNVERIFIED,
    retryable: true,
  });
}

function addIssue(validation: SelectionEditValidation, issue: SelectionEditQualityIssue): void {
  const existingIssues = validation.issues ?? [];
  if (existingIssues.some((entry) => entry.code === issue.code)) return;
  validation.issues = [...existingIssues, issue];
  validation.passed = false;
}

function sortIssues(issues: readonly SelectionEditQualityIssue[]): SelectionEditQualityIssue[] {
  return [...issues].sort((left, right) => issuePriority.indexOf(left.code) - issuePriority.indexOf(right.code));
}
