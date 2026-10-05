import {
  createCoordinatorPlanId,
  createCurrentNoteSelectionEditRequest,
  runSelectionEditCoordinator,
} from './selectionEditCoordinator';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import type { SelectionEditExtendedSourceRuntime } from './selectionEditSources/extendedSources';
import type { SelectionEditContextPlan, SelectionEvidenceItem } from './selectionEditTypes';
import type {
  SelectionExpansionEvidence,
  SelectionExpansionEventPayload,
  SelectionExpansionPlan,
  SelectionExpansionRequest,
  SelectionExpansionResult,
} from './selectionExpansionTypes';
import { validateSelectionExpansionSettings } from './selectionExpansionSettings';
import type { SelectionExpansionCapabilities } from './selectionExpansionTypes';
import { resolveExpansionTarget } from '../../shared/selectionExpansionPolicy';
import { validateSelectionLocatorCapture } from './selectionEditLocator';

export interface SelectionExpansionCoordinatorInput {
  requestId: string;
  sessionId: string;
  request: SelectionExpansionRequest;
  snapshot: CurrentNoteSnapshot;
  signal: AbortSignal;
  isSnapshotCurrent: () => boolean;
  emit: (event: SelectionExpansionEventPayload) => void;
  extendedSources?: SelectionEditExtendedSourceRuntime;
}

export function validateSelectionExpansionRequest(value: unknown, capabilities: SelectionExpansionCapabilities): SelectionExpansionRequest {
  if (!isRecord(value)) throw new Error('选区扩写请求格式无效。');
  const selectionSnapshotId = readBoundedString(value.selectionSnapshotId, '选区快照标识', 200);
  const sourceSnapshotId = readBoundedString(value.sourceSnapshotId, '来源快照标识', 200);
  const currentPath = readBoundedString(value.currentPath, '当前笔记路径', 4_096);
  const selectedText = readBoundedString(value.selectedText, '选中文字', 20_000);
  if (!selectedText.trim()) throw new Error('请先选择要扩写的文字。');
  const expectedContentHash = readBoundedString(value.expectedContentHash, '内容哈希', 64);
  if (!/^[a-f0-9]{64}$/iu.test(expectedContentHash)) throw new Error('内容哈希格式无效。');
  return {
    selectionSnapshotId,
    sourceSnapshotId,
    currentPath,
    selectedText,
    selectionLocator: validateSelectionLocatorCapture(value.selectionLocator),
    expectedContentHash: expectedContentHash.toLowerCase(),
    settings: validateSelectionExpansionSettings(value.settings, capabilities),
  };
}

/**
 * Current-note-only first slice of the expansion workflow.  The model plans
 * evidence goals, while candidate discovery and source reads stay deterministic
 * in the main process.  Later phases add other source adapters without widening
 * this coordinator's write authority (it has none).
 */
export async function runSelectionExpansionCoordinator(input: SelectionExpansionCoordinatorInput): Promise<SelectionExpansionResult> {
  const { request, snapshot, signal, emit } = input;
  let plan: SelectionExpansionPlan = {
    planId: createCoordinatorPlanId(),
    outline: ['依据当前笔记中已读取的原文补充必要说明。'],
    goals: [],
    fallback: true,
  };
  const unified = await runSelectionEditCoordinator({
    request: createCurrentNoteSelectionEditRequest({
      requestId: input.requestId,
      action: 'expand',
      sourceSnapshotId: request.sourceSnapshotId,
      snapshot,
      selectedText: request.selectedText,
      selectionLocator: request.selectionLocator,
      customInstruction: request.settings.customInstruction,
      outputPreference: 'insert-below',
      contextScope: request.settings.sources.noteLibrary || request.settings.sources.materialsLibrary || request.settings.sources.web ? 'extended' : 'current-note',
      allowedSources: {
        currentNote: request.settings.sources.currentNote,
        noteLibrary: request.settings.sources.noteLibrary,
        materialsLibrary: request.settings.sources.materialsLibrary,
        web: request.settings.sources.web !== 'off',
        personalization: request.settings.sources.personalization,
      },
    }),
    snapshot,
    extendedSources: input.extendedSources,
    signal,
    isSnapshotCurrent: input.isSnapshotCurrent,
    synthesis: {
      forceCurrentNoteResearch: true,
      targetCharacters: resolveExpansionTarget(request.selectedText,
        request.settings.targetLength.mode === 'characters' ? request.settings.targetLength.characters : undefined,
        request.settings.targetLength.mode === 'ratio' ? request.settings.targetLength.ratio : undefined),
      style: request.settings.style,
      audience: request.settings.audience,
      reasoningDepth: request.settings.reasoningDepth === 'standard' ? 'balanced' : request.settings.reasoningDepth,
      customInstruction: request.settings.customInstruction,
    },
    emit: (event) => {
      if (event.type === 'status') {
        const phase = event.stage === 'planning' ? 'planning'
          : event.stage === 'reading' ? 'researching'
            : event.stage === 'generating' ? 'synthesizing'
              : event.stage === 'cancelled' ? 'cancelled'
                : event.stage === 'failed' ? 'error'
                  : 'configuring';
        emit({ type: 'status', phase, message: event.message });
        return;
      }
      if (event.type === 'plan') {
        plan = toSelectionExpansionPlan(event.plan);
        emit({ type: 'plan', plan });
        return;
      }
      if (event.type === 'evidence') emit({ type: 'evidence', evidence: toSelectionExpansionEvidence(event.evidence) });
    },
  });
  const evidence = unified.evidence.map((item) => toSelectionExpansionEvidence(item));
  const coveredGoalIds = new Set(evidence.flatMap((item) => item.goalIds));
  const completeCoverage = plan.goals.length > 0 && plan.goals.every((goal) => coveredGoalIds.has(goal.goalId));
  const result: SelectionExpansionResult = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    selectionSnapshotId: request.selectionSnapshotId,
    text: unified.text,
    completeness: !unified.text ? 'not-found' : unified.validation.passed && completeCoverage ? 'complete' : 'partial',
    plan,
    evidence,
    receipt: unified.receipt,
    validation: unified.validation,
    qualityReceipt: unified.qualityReceipt,
    execution: unified.execution,
    provider: unified.provider,
    model: unified.model,
    generatedAt: unified.generatedAt,
  };
  emit({ type: 'complete', result });
  return result;
}

function toSelectionExpansionPlan(plan: SelectionEditContextPlan): SelectionExpansionPlan {
  return {
    planId: createCoordinatorPlanId(),
    outline: ['依据已深读的本地来源原文补充必要说明。'],
    goals: plan.goals.map((goal, index) => ({
      goalId: goal.goalId,
      question: index === 0 ? '本地来源中的定义、背景或限定条件' : index === 1 ? '本地来源中的相关支撑原文' : '本地来源中的范围或例外条件',
      queryTerms: [...goal.queryTerms],
      requirements: [{ requirementId: `${goal.goalId}-req-1`, label: '已深读的本地来源原文' }],
    })),
    fallback: false,
  };
}

function toSelectionExpansionEvidence(evidence: SelectionEvidenceItem): SelectionExpansionEvidence {
  if (!evidence.locator.trim() || !evidence.readVerified) throw new Error('选区编辑证据回执无效。');
  return {
    evidenceId: evidence.evidenceId,
    sourceKind: evidence.sourceKind,
    title: evidence.title,
    locator: evidence.locator,
    content: evidence.content,
    ...(evidence.sourceContentHash ? { sourceContentHash: evidence.sourceContentHash } : {}),
    textHash: evidence.textHash,
    ...(evidence.headingPath?.length ? { headingPath: [...evidence.headingPath] } : {}),
    goalIds: [...evidence.goalIds],
    readVerified: evidence.readVerified,
    ...(evidence.pageVerified !== undefined ? { pageVerified: evidence.pageVerified } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  if (value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return value;
}
