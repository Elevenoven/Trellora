import { CurrentNoteEvidenceLedger } from '../currentNoteEvidenceLedger';
import { evaluateStrictSmallNotePolicy, type CurrentNoteContextCapacity, type StrictSmallNoteDecision } from '../currentNotePolicy';
import type { CurrentNoteSnapshot } from '../currentNoteSnapshot';
import { createCurrentNoteTools, materializeCurrentNoteSearchHit } from '../currentNoteTools';
import { tokenizeCurrentNoteText } from '../currentNoteStructure';
import { estimateTokenCount } from '../tokenEstimator';
import type { SelectionContextReceipt, SelectionEvidenceItem } from '../selectionEditTypes';

const DEFAULT_MAX_EVIDENCE_CHARACTERS = 9_000;
const DEFAULT_MAX_EVIDENCE_TOKENS = 2_048;
const DEFAULT_MAX_EVIDENCE_PER_GOAL = 2;
const DEFAULT_MAX_SOURCE_RECORDS = 8;
const SEARCH_PAGE_SIZE = 8;

export interface SelectionEditCurrentNoteGoal {
  goalId: string;
  question: string;
  queryTerms: readonly string[];
}

export interface SelectionEditCurrentNoteSourceLimits {
  maxEvidenceCharacters?: number;
  maxEvidenceTokens?: number;
  maxEvidencePerGoal?: number;
  maxSourceEvidenceRecords?: number;
}

/**
 * A receipt describes what this source adapter really read. Search hits are
 * deliberately kept separate from `used`: only Ledger-admitted raw text is
 * allowed to enter the synthesis prompt.
 */
export interface CurrentNoteSelectionContextReceipt extends SelectionContextReceipt {
  snapshotId: string;
  contentHash: string;
  strictSmallNote: StrictSmallNoteDecision;
  noteMap: {
    read: true;
    headingCount: number;
    lineCount: number;
  };
  candidateSearches: Array<{
    goalId: string;
    queryTerms: string[];
    candidateCount: number;
    candidateExhausted: boolean;
    nextCursorAvailable: boolean;
    materializedCount: number;
  }>;
  evidenceCharacters: number;
  evidenceTokens: number;
  evidenceTokenBudget: number;
}

export interface SelectionEditCurrentNoteSourceResult {
  evidence: SelectionEvidenceItem[];
  receipt: CurrentNoteSelectionContextReceipt;
}

export interface CollectSelectionEditCurrentNoteContextInput {
  snapshot: CurrentNoteSnapshot;
  selectedText: string;
  goals: readonly SelectionEditCurrentNoteGoal[];
  capacity: CurrentNoteContextCapacity;
  limits?: SelectionEditCurrentNoteSourceLimits;
  isSnapshotCurrent?: () => boolean;
  onProgress?: (message: string) => void;
}

/**
 * Current-note adapter for selection editing. It has no model, IPC, filesystem
 * or writeback authority. A full note is admissible only under the strict
 * policy; every other path is map -> paged candidate search -> raw deep read
 * -> Evidence Ledger.
 */
export function collectSelectionEditCurrentNoteContext(
  input: CollectSelectionEditCurrentNoteContextInput,
): SelectionEditCurrentNoteSourceResult {
  const { snapshot, selectedText } = input;
  if (!selectedText.trim()) throw new Error('选区正文不能为空。');
  assertSnapshotCurrent(input);

  const limits = resolveLimits(input.limits, input.capacity);
  const strictSmallNote = evaluateStrictSmallNotePolicy({
    characters: snapshot.markdown.length,
    lineCount: snapshot.lineCount,
    tokenEstimate: snapshot.tokenEstimate,
  }, input.capacity);
  const tools = createCurrentNoteTools(snapshot);
  input.onProgress?.('已读取当前笔记结构。');
  const noteMap = tools.getNoteMap('outline');
  assertSnapshotCurrent(input);

  const ledger = new CurrentNoteEvidenceLedger(snapshot, limits.maxEvidenceCharacters, {
    enforceRawEvidenceChars: true,
    maxSourceEvidenceRecords: limits.maxSourceEvidenceRecords,
  });
  const candidateSearches: CurrentNoteSelectionContextReceipt['candidateSearches'] = [];
  let evidenceTokens = 0;
  const plannedReason = strictSmallNote.allowed
    ? '当前笔记满足严格小笔记全文直读门槛。'
    : '当前笔记未满足全文直读门槛，按结构、候选和原文深读取证。';

  if (strictSmallNote.allowed) {
    input.onProgress?.('当前笔记满足严格小笔记策略，正在读取全文原文。');
    const fullNote = tools.readNoteRange({ lineFrom: 1, lineTo: snapshot.lineCount });
    ledger.add({
      blockIds: fullNote.blockIds,
      headingPath: fullNote.headingPath,
      lineFrom: fullNote.lineFrom,
      lineTo: fullNote.lineTo,
      text: fullNote.text,
      matchedTerms: [],
      supports: input.goals.map((goal) => goal.question),
      sourceToolCallId: 'selection-edit:current-note:strict-full-read',
      admission: 'explicit-read',
    });
    evidenceTokens = estimateTokenCount(fullNote.text);
    assertSnapshotCurrent(input);
    return finalizeContext({
      snapshot,
      strictSmallNote,
      noteMap,
      candidateSearches,
      ledger,
      evidenceTokens,
      evidenceTokenBudget: limits.maxEvidenceTokens,
      plannedReason,
      fullNoteMode: 'strict-direct',
    });
  }

  const selectedFragments = splitSelectedFragments(selectedText);
  for (const goal of input.goals) {
    assertSnapshotCurrent(input);
    const queryTerms = resolveQueryTerms(goal.queryTerms, selectedText);
    if (queryTerms.length === 0) {
      candidateSearches.push({
        goalId: goal.goalId,
        queryTerms: [],
        candidateCount: 0,
        candidateExhausted: true,
        nextCursorAvailable: false,
        materializedCount: 0,
      });
      continue;
    }

    input.onProgress?.(`正在定位“${goal.question.slice(0, 48)}”的候选原文。`);
    const page = tools.searchNotePage(queryTerms, SEARCH_PAGE_SIZE);
    let materializedCount = 0;
    for (const hit of page.hits) {
      if (materializedCount >= limits.maxEvidencePerGoal || ledger.totalChars >= limits.maxEvidenceCharacters) break;
      const original = materializeCurrentNoteSearchHit(snapshot, hit);
      if (isSelectedBlock(original.text, selectedText, selectedFragments)) continue;
      if (original.text.length + ledger.totalChars > limits.maxEvidenceCharacters) continue;
      const originalTokens = estimateTokenCount(original.text);
      if (originalTokens + evidenceTokens > limits.maxEvidenceTokens) continue;
      input.onProgress?.(`正在读取第 ${original.lineFrom}–${original.lineTo} 行原文。`);
      const admitted = ledger.add({
        blockIds: [original.blockId],
        headingPath: original.headingPath,
        lineFrom: original.lineFrom,
        lineTo: original.lineTo,
        text: original.text,
        matchedTerms: hit.matchedTerms,
        supports: [goal.question],
        sourceToolCallId: `selection-edit:current-note:${goal.goalId}:search`,
        admission: 'search-hit',
        goalId: goal.goalId,
        searchHitId: hit.hitId,
        bestScore: hit.score,
      });
      if (admitted.added) {
        materializedCount += 1;
        evidenceTokens += originalTokens;
      }
      assertSnapshotCurrent(input);
    }
    candidateSearches.push({
      goalId: goal.goalId,
      queryTerms,
      candidateCount: page.hits.length,
      candidateExhausted: page.candidateExhausted,
      nextCursorAvailable: Boolean(page.nextCursor),
      materializedCount,
    });
  }

  return finalizeContext({
    snapshot,
    strictSmallNote,
    noteMap,
    candidateSearches,
    ledger,
    evidenceTokens,
    evidenceTokenBudget: limits.maxEvidenceTokens,
    plannedReason,
    fullNoteMode: 'map-and-read',
  });
}

function finalizeContext(input: {
  snapshot: CurrentNoteSnapshot;
  strictSmallNote: StrictSmallNoteDecision;
  noteMap: ReturnType<ReturnType<typeof createCurrentNoteTools>['getNoteMap']>;
  candidateSearches: CurrentNoteSelectionContextReceipt['candidateSearches'];
  ledger: CurrentNoteEvidenceLedger;
  evidenceTokens: number;
  evidenceTokenBudget: number;
  plannedReason: string;
  fullNoteMode: CurrentNoteSelectionContextReceipt['fullNoteMode'];
}): SelectionEditCurrentNoteSourceResult {
  const evidence = input.ledger.list().map((record) => ({
    evidenceId: record.evidenceId,
    sourceKind: 'current-note' as const,
    title: input.snapshot.title,
    locator: `当前笔记 L${record.lineFrom}-L${record.lineTo}`,
    headingPath: [...record.headingPath],
    content: record.text,
    sourceContentHash: input.snapshot.contentHash,
    textHash: record.textHash,
    goalIds: [...record.goalIds],
    readVerified: true,
    pageVerified: true,
  }));
  const skipped: SelectionContextReceipt['skipped'] = [];
  if (!input.strictSmallNote.allowed) {
    skipped.push({ sourceKind: 'current-note', reason: `未全文直读：${input.strictSmallNote.rejections.join('、')}。` });
  }
  if (evidence.length === 0) {
    skipped.push({ sourceKind: 'current-note', reason: '未找到可在当前读取预算内深读的原文证据。' });
  }
  return {
    evidence,
    receipt: {
      planned: [{ sourceKind: 'current-note', reason: input.plannedReason }],
      used: evidence.map((item) => ({
        sourceKind: 'current-note',
        title: item.title,
        locator: item.locator,
        characterCount: item.content.length,
      })),
      skipped,
      candidates: [],
      conflicts: [],
      personalization: { requested: false, applied: false, itemCount: 0 },
      fullNoteMode: input.fullNoteMode,
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      strictSmallNote: input.strictSmallNote,
      noteMap: {
        read: true,
        headingCount: input.noteMap.headings.length,
        lineCount: input.noteMap.lineCount,
      },
      candidateSearches: input.candidateSearches.map((item) => ({ ...item, queryTerms: [...item.queryTerms] })),
      evidenceCharacters: input.ledger.totalChars,
      evidenceTokens: input.evidenceTokens,
      evidenceTokenBudget: input.evidenceTokenBudget,
    },
  };
}

function resolveLimits(
  value: SelectionEditCurrentNoteSourceLimits | undefined,
  capacity: CurrentNoteContextCapacity,
): Required<SelectionEditCurrentNoteSourceLimits> {
  const contextDerivedTokenBudget = capacity.contextWindowTokens
    ? Math.max(256, Math.min(4_096, Math.floor(capacity.contextWindowTokens * 0.2)))
    : DEFAULT_MAX_EVIDENCE_TOKENS;
  return {
    maxEvidenceCharacters: readPositiveLimit(value?.maxEvidenceCharacters, DEFAULT_MAX_EVIDENCE_CHARACTERS),
    maxEvidenceTokens: readPositiveLimit(value?.maxEvidenceTokens, contextDerivedTokenBudget),
    maxEvidencePerGoal: readPositiveLimit(value?.maxEvidencePerGoal, DEFAULT_MAX_EVIDENCE_PER_GOAL),
    maxSourceEvidenceRecords: readPositiveLimit(value?.maxSourceEvidenceRecords, DEFAULT_MAX_SOURCE_RECORDS),
  };
}

function resolveQueryTerms(queryTerms: readonly string[], selectedText: string): string[] {
  const candidates = [...queryTerms, ...tokenizeCurrentNoteText(selectedText)];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (normalized.length < 2 || normalized.length > 80) continue;
    const key = normalized.toLocaleLowerCase('zh-CN');
    if (unique.has(key)) continue;
    unique.add(key);
    if (unique.size >= 6) break;
  }
  return [...unique];
}

function splitSelectedFragments(selectedText: string): string[] {
  return selectedText.split(/\n+/u).map((item) => item.trim()).filter((item) => item.length >= 4);
}

function isSelectedBlock(blockText: string, selectedText: string, selectedFragments: readonly string[]): boolean {
  return blockText.includes(selectedText)
    || selectedText.includes(blockText)
    || selectedFragments.some((fragment) => blockText.includes(fragment));
}

function readPositiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function assertSnapshotCurrent(input: CollectSelectionEditCurrentNoteContextInput): void {
  if (input.isSnapshotCurrent && !input.isSnapshotCurrent()) {
    throw new Error('当前笔记内容已变化，请重新选择文字后再生成。');
  }
}
