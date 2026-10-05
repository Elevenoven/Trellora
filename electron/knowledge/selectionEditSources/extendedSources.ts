import { createHash } from 'node:crypto';
import { findMaterialsDocument } from '../../materialsLibrary';
import { readMaterialParentWindow, searchMaterialChunks } from '../../pipeline/materialChunkSearch';
import type { MaterialEmbeddingAdapter } from '../../pipeline/materialEmbeddingAdapters';
import { retrieveKnowledgeBaseEvidence } from '../knowledgeBaseRag';
import { LibraryEvidenceLedger } from '../libraryEvidenceLedger';
import { getLibraryNoteRecord, type LibraryNoteSnapshotMap } from '../libraryNoteSnapshot';
import { createLibraryNoteTools, searchLibraryNoteCandidates } from '../libraryNoteTools';
import type { SearchCandidate } from '../keywordSearch';
import {
  collectSelectionEditWebSources,
  type SelectionEditWebSourceRuntime,
} from './webSources';
import type { SelectionEditPersonalizationRuntime } from './personalizationSource';
import type {
  SelectionContextReceipt,
  SelectionEditContextGoal,
  SelectionEvidenceItem,
} from '../selectionEditTypes';

const MAX_NOTE_CANDIDATES = 4;
const MAX_MATERIAL_CANDIDATES = 4;
const MAX_RAW_READ_CHARS = 2_200;
const MAX_RAW_READ_LINES = 48;

export interface SelectionEditExtendedGoal extends SelectionEditContextGoal {
  question: string;
}

/** Dependencies are assembled by Electron main, so this adapter never reaches into process singletons. */
export interface SelectionEditExtendedSourceRuntime {
  noteLibrary?: {
    snapshotMap: LibraryNoteSnapshotMap;
    sessionId: string;
    currentNotePath: string;
    keywordSearch: (query: string) => SearchCandidate[];
    /** Locks same-library candidate IDs to this task's index revision. */
    isSnapshotCurrent?: () => boolean;
  };
  materialsLibrary?: {
    libraryPath: string;
    prepareQueryContext: (query: string) => Promise<{
      targetPath: string;
      queryTerms?: string[];
      lexicalError?: string;
      adapter?: MaterialEmbeddingAdapter;
      embeddingError?: string;
    }>;
  };
  /** 主进程仅在本次任务显式授权、全局同意且厂商就绪时注入。 */
  web?: SelectionEditWebSourceRuntime;
  /** 仅在用户显式勾选时注入；永不作为事实来源。 */
  personalization?: SelectionEditPersonalizationRuntime;
}

export interface CollectSelectionEditExtendedSourcesInput {
  goals: readonly SelectionEditExtendedGoal[];
  enabled: { noteLibrary: boolean; materialsLibrary: boolean; web: boolean };
  runtime: SelectionEditExtendedSourceRuntime;
  signal: AbortSignal;
  maxEvidenceCharacters: number;
  onProgress?: (message: string) => void;
}

export interface SelectionEditExtendedSourcesResult {
  evidence: SelectionEvidenceItem[];
  receipt: Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates' | 'conflicts'>;
}

/**
 * SE-5 local external sources. Candidate cards are emitted through the receipt
 * only; the model receives exclusively the bounded reads stored in `evidence`.
 */
export async function collectSelectionEditExtendedSources(
  input: CollectSelectionEditExtendedSourcesInput,
): Promise<SelectionEditExtendedSourcesResult> {
  const planned: SelectionContextReceipt['planned'] = [];
  const used: SelectionContextReceipt['used'] = [];
  const skipped: SelectionContextReceipt['skipped'] = [];
  const candidates: SelectionContextReceipt['candidates'] = [];
  const evidence: SelectionEvidenceItem[] = [];
  let remainingCharacters = assertEvidenceBudget(input.maxEvidenceCharacters);

  if (input.enabled.noteLibrary) {
    if (!input.runtime.noteLibrary) {
      skipped.push({ sourceKind: 'note-library', reason: '同库笔记来源尚未准备就绪。' });
    } else {
      planned.push({ sourceKind: 'note-library', reason: '先定位同库笔记候选，再按块受限深读原文。' });
      const result = await collectNoteLibraryEvidence({
        runtime: input.runtime.noteLibrary,
        goals: input.goals,
        signal: input.signal,
        remainingCharacters,
        onProgress: input.onProgress,
      });
      candidates.push(...result.candidates);
      evidence.push(...result.evidence);
      used.push(...toUsed(result.evidence));
      skipped.push(...result.skipped);
      remainingCharacters -= result.evidence.reduce((total, item) => total + item.content.length, 0);
    }
  }

  if (input.enabled.materialsLibrary) {
    if (!input.runtime.materialsLibrary) {
      skipped.push({ sourceKind: 'materials', reason: '尚未选择可用资料库，未执行资料检索。' });
    } else if (remainingCharacters < 1) {
      skipped.push({ sourceKind: 'materials', reason: '本轮原文证据预算已由其他来源用尽。' });
    } else {
      planned.push({ sourceKind: 'materials', reason: '依次执行 knowledge_search / grep_chunks 定位，再用 list_knowledge_chunks 受限深读。' });
      const result = await collectMaterialsEvidence({
        runtime: input.runtime.materialsLibrary,
        goals: input.goals,
        signal: input.signal,
        remainingCharacters,
        onProgress: input.onProgress,
      });
      candidates.push(...result.candidates);
      evidence.push(...result.evidence);
      used.push(...toUsed(result.evidence));
      skipped.push(...result.skipped);
      remainingCharacters -= result.evidence.reduce((total, item) => total + item.content.length, 0);
    }
  }

  if (input.enabled.web) {
    if (remainingCharacters < 1) {
      skipped.push({ sourceKind: 'web', reason: '本轮原文证据预算已由其他来源用尽，未发送联网搜索请求。' });
    } else {
      const result = await collectSelectionEditWebSources({
        goals: input.goals,
        runtime: input.runtime.web,
        signal: input.signal,
        remainingCharacters,
        onProgress: input.onProgress,
      });
      candidates.push(...result.receipt.candidates);
      evidence.push(...result.evidence);
      used.push(...result.receipt.used);
      skipped.push(...result.receipt.skipped);
    }
  }

  return {
    evidence,
    receipt: {
      planned,
      used,
      skipped,
      candidates,
      conflicts: detectSelectionSourceConflicts(evidence),
    },
  };
}

async function collectNoteLibraryEvidence(input: {
  runtime: NonNullable<SelectionEditExtendedSourceRuntime['noteLibrary']>;
  goals: readonly SelectionEditExtendedGoal[];
  signal: AbortSignal;
  remainingCharacters: number;
  onProgress?: (message: string) => void;
}): Promise<Pick<SelectionEditExtendedSourcesResult['receipt'], 'candidates' | 'skipped'> & { evidence: SelectionEvidenceItem[] }> {
  const candidates: SelectionContextReceipt['candidates'] = [];
  const skipped: SelectionContextReceipt['skipped'] = [];
  const tools = createLibraryNoteTools(input.runtime.snapshotMap, input.runtime.sessionId);
  const ledger = new LibraryEvidenceLedger(input.runtime.snapshotMap, input.runtime.sessionId, input.remainingCharacters);
  const candidateGoalIds = new Map<string, string[]>();

  for (const goal of input.goals) {
    throwIfAborted(input.signal);
    const queryTerms = normalizeQueryTerms(goal.queryTerms);
    if (queryTerms.length === 0) continue;
    input.onProgress?.(`正在定位同库笔记中“${goal.question.slice(0, 32)}”的候选。`);
    const searched = await searchLibraryNoteCandidates({
      snapshotMap: input.runtime.snapshotMap,
      sessionId: input.runtime.sessionId,
      query: queryTerms.join(' '),
      limit: MAX_NOTE_CANDIDATES,
      callbacks: { keywordSearch: input.runtime.keywordSearch },
    });
    for (const candidate of searched.results) {
      const record = getLibraryNoteRecord(input.runtime.snapshotMap, candidate.noteId, input.runtime.sessionId);
      if (record.localSnapshot.notePath === input.runtime.currentNotePath) continue;
      const candidateId = `note-library:${candidate.noteId}`;
      const existing = candidates.find((item) => item.candidateId === candidateId);
      if (existing) {
        existing.queryTerms = unique([...existing.queryTerms, ...queryTerms]);
        candidateGoalIds.set(candidateId, unique([...(candidateGoalIds.get(candidateId) ?? []), goal.goalId]));
        continue;
      }
      candidates.push({
        candidateId,
        sourceKind: 'note-library',
        title: candidate.title,
        locator: `笔记库 / ${record.localSnapshot.relativePath}`,
        queryTerms,
        retrievalMethod: '同库关键词定位',
        readState: 'candidate',
        score: candidate.score,
      });
      candidateGoalIds.set(candidateId, [goal.goalId]);
    }
  }

  let readCount = 0;
  for (const candidate of [...candidates]
    .sort((first, second) => (second.score ?? 0) - (first.score ?? 0) || first.candidateId.localeCompare(second.candidateId))
    .slice(0, MAX_NOTE_CANDIDATES)) {
    throwIfAborted(input.signal);
    if (ledger.totalChars >= input.remainingCharacters) break;
    const noteId = candidate.candidateId.slice('note-library:'.length);
    const hits = tools.searchNoteBlocks(noteId, candidate.queryTerms, 2);
    if (hits.length === 0) {
      candidate.readState = 'skipped';
      candidate.reason = '候选笔记中没有可定位的原文块。';
      continue;
    }
    for (const hit of hits) {
      if (ledger.totalChars >= input.remainingCharacters || readCount >= MAX_NOTE_CANDIDATES) break;
      input.onProgress?.(`正在深读同库笔记「${candidate.title}」第 ${hit.lineFrom}–${hit.lineTo} 行。`);
      const raw = tools.readNoteRange(noteId, { lineFrom: hit.lineFrom, lineTo: hit.lineTo }, {
        maxChars: Math.min(MAX_RAW_READ_CHARS, input.remainingCharacters - ledger.totalChars),
        maxLines: MAX_RAW_READ_LINES,
      });
      if (!raw.text.trim() || raw.text.length + ledger.totalChars > input.remainingCharacters) continue;
      const added = ledger.add({
        noteId,
        headingPath: raw.headingPath,
        anchorHeadingId: tools.findDeepestHeadingIdAtLine(noteId, raw.lineFrom),
        lineFrom: raw.lineFrom,
        lineTo: raw.lineTo,
        text: raw.text,
        matchedTerms: hit.matchedTerms,
        supports: (candidateGoalIds.get(candidate.candidateId) ?? []).map((goalId) => goalId),
        sourceToolCallId: `selection-edit:note-library:${candidate.candidateId}:read-range`,
      });
      if (added.added) {
        candidate.readState = 'deep-read';
        readCount += 1;
      }
      break;
    }
    if (candidate.readState === 'candidate') {
      candidate.readState = 'skipped';
      candidate.reason = '候选原文超过本轮受限读取预算。';
    }
  }

  const goalIdsByCandidate = new Map(candidates.map((candidate) => [candidate.candidateId, candidateGoalIds.get(candidate.candidateId) ?? []]));
  const evidence = ledger.list()
    .filter((record) => ledger.verifyEvidenceIds([record.evidenceId]).length === 1)
    .map((record) => {
      const source = getLibraryNoteRecord(input.runtime.snapshotMap, record.noteId, input.runtime.sessionId).localSnapshot;
      const candidateId = `note-library:${record.noteId}`;
      return {
        evidenceId: record.evidenceId,
        sourceKind: 'note-library' as const,
        title: source.title,
        locator: `笔记库 / ${source.relativePath} / L${record.lineFrom}-L${record.lineTo}`,
        headingPath: [...record.headingPath],
        content: record.text,
        sourceContentHash: record.contentHash,
        textHash: record.textHash,
        goalIds: [...(goalIdsByCandidate.get(candidateId) ?? [])],
        readVerified: true,
        pageVerified: true,
      };
    });
  if (evidence.length === 0) skipped.push({ sourceKind: 'note-library', reason: '未找到可在本轮预算内深读的同库笔记原文。' });
  return { evidence, candidates, skipped };
}

async function collectMaterialsEvidence(input: {
  runtime: NonNullable<SelectionEditExtendedSourceRuntime['materialsLibrary']>;
  goals: readonly SelectionEditExtendedGoal[];
  signal: AbortSignal;
  remainingCharacters: number;
  onProgress?: (message: string) => void;
}): Promise<Pick<SelectionEditExtendedSourcesResult['receipt'], 'candidates' | 'skipped'> & { evidence: SelectionEvidenceItem[] }> {
  const candidates: SelectionContextReceipt['candidates'] = [];
  const skipped: SelectionContextReceipt['skipped'] = [];
  const goalIds = new Map<string, string[]>();

  for (const goal of input.goals) {
    throwIfAborted(input.signal);
    const queryTerms = normalizeQueryTerms(goal.queryTerms);
    if (queryTerms.length === 0) continue;
    const query = queryTerms.join(' ');
    input.onProgress?.(`正在通过 knowledge_search 和 grep_chunks 定位资料库候选。`);
    const context = await input.runtime.prepareQueryContext(query);
    const [semantic, keyword] = await Promise.all([
      retrieveKnowledgeBaseEvidence({
        libraryPath: context.targetPath,
        query,
        queryTerms: context.queryTerms,
        lexicalError: context.lexicalError,
        adapter: context.adapter,
        embeddingError: context.embeddingError,
        parentTopK: 3,
        allowExpansion: false,
        directLoadEnabled: false,
        allowGraphExpansion: false,
      }),
      searchMaterialChunks({
        libraryPath: context.targetPath,
        query,
        queryTerms: context.queryTerms,
        lexicalError: context.lexicalError,
        mode: 'keyword',
        limit: 4,
        adapter: context.adapter,
        embeddingError: context.embeddingError,
      }),
    ]);
    for (const item of semantic.evidence) {
      addMaterialCandidate({
        candidates,
        goalIds,
        goalId: goal.goalId,
        queryTerms,
        libraryPath: context.targetPath,
        documentId: item.documentId,
        ordinal: item.parentOrdinal,
        score: item.score,
        retrievalMethod: 'knowledge_search',
      });
    }
    for (const item of keyword.results) {
      addMaterialCandidate({
        candidates,
        goalIds,
        goalId: goal.goalId,
        queryTerms,
        libraryPath: context.targetPath,
        documentId: item.documentId,
        ordinal: item.citation.parent?.ordinal ?? item.ordinal,
        score: item.score,
        retrievalMethod: 'grep_chunks',
      });
    }
  }

  let totalCharacters = 0;
  const evidence: SelectionEvidenceItem[] = [];
  for (const candidate of [...candidates]
    .sort((first, second) => (second.score ?? 0) - (first.score ?? 0) || first.candidateId.localeCompare(second.candidateId))
    .slice(0, MAX_MATERIAL_CANDIDATES)) {
    throwIfAborted(input.signal);
    if (totalCharacters >= input.remainingCharacters) break;
    const parsed = parseMaterialCandidateId(candidate.candidateId);
    if (!parsed) continue;
    const document = findMaterialsDocument(input.runtime.libraryPath, parsed.documentId);
    if (!document) {
      candidate.readState = 'skipped';
      candidate.reason = '资料文档已不存在，未将候选摘要作为证据。';
      continue;
    }
    const capturedHash = candidate.sourceContentHash ?? '';
    if (capturedHash && document.contentHash !== capturedHash) {
      candidate.readState = 'skipped';
      candidate.reason = '资料文档在候选定位后已变化，需要重新检索。';
      continue;
    }
    input.onProgress?.(`正在通过 list_knowledge_chunks 深读「${document.name}」父块 ${parsed.ordinal}。`);
    const raw = readMaterialParentWindow({ libraryPath: input.runtime.libraryPath, documentId: parsed.documentId, ordinal: parsed.ordinal, window: 0 })
      .find((item) => item.ordinal === parsed.ordinal);
    const verifiedDocument = findMaterialsDocument(input.runtime.libraryPath, parsed.documentId);
    if (!raw?.text.trim() || !verifiedDocument || verifiedDocument.contentHash !== document.contentHash) {
      candidate.readState = 'skipped';
      candidate.reason = '深读时资料文档不可用或内容已变化。';
      continue;
    }
    if (raw.text.length + totalCharacters > input.remainingCharacters || raw.text.length > MAX_RAW_READ_CHARS) {
      candidate.readState = 'skipped';
      candidate.reason = '深读块超过本轮原文预算。';
      continue;
    }
    const evidenceId = `evidence-${hashText(`${parsed.documentId}\u0000${parsed.ordinal}\u0000${document.contentHash}\u0000${raw.text}`).slice(0, 24)}`;
    evidence.push({
      evidenceId,
      sourceKind: 'materials',
      title: document.name,
      locator: `资料库 / ${document.name} / 父块 ${parsed.ordinal}`,
      content: raw.text,
      sourceContentHash: document.contentHash,
      textHash: hashText(raw.text),
      goalIds: [...(goalIds.get(candidate.candidateId) ?? [])],
      readVerified: true,
      pageVerified: true,
    });
    totalCharacters += raw.text.length;
    candidate.readState = 'deep-read';
    candidate.locator = `资料库 / ${document.name} / 父块 ${parsed.ordinal}`;
  }
  for (const candidate of candidates) {
    if (candidate.readState === 'candidate') {
      candidate.readState = 'skipped';
      candidate.reason = '候选未进入本轮受限深读配额。';
    }
  }
  if (evidence.length === 0) skipped.push({ sourceKind: 'materials', reason: '未找到可在本轮预算内深读的资料库原文。' });
  return { evidence, candidates, skipped };
}

function addMaterialCandidate(input: {
  candidates: SelectionContextReceipt['candidates'];
  goalIds: Map<string, string[]>;
  goalId: string;
  queryTerms: string[];
  libraryPath: string;
  documentId: string;
  ordinal: number;
  score: number;
  retrievalMethod: 'knowledge_search' | 'grep_chunks';
}): void {
  const document = findMaterialsDocument(input.libraryPath, input.documentId);
  if (!document) return;
  const candidateId = `materials:${input.documentId}:${input.ordinal}`;
  const existing = input.candidates.find((candidate) => candidate.candidateId === candidateId);
  if (existing) {
    existing.queryTerms = unique([...existing.queryTerms, ...input.queryTerms]);
    existing.retrievalMethod = unique([existing.retrievalMethod, input.retrievalMethod]).join(' + ');
    existing.score = Math.max(existing.score ?? 0, input.score);
    input.goalIds.set(candidateId, unique([...(input.goalIds.get(candidateId) ?? []), input.goalId]));
    return;
  }
  input.candidates.push({
    candidateId,
    sourceKind: 'materials',
    title: document.name,
    locator: `资料库 / ${document.name} / 父块 ${input.ordinal}`,
    queryTerms: [...input.queryTerms],
    retrievalMethod: input.retrievalMethod,
    readState: 'candidate',
    score: input.score,
    sourceContentHash: document.contentHash,
  });
  input.goalIds.set(candidateId, [input.goalId]);
}

function parseMaterialCandidateId(candidateId: string): { documentId: string; ordinal: number } | undefined {
  const match = /^materials:(.+):(\d+)$/u.exec(candidateId);
  if (!match) return undefined;
  return { documentId: match[1]!, ordinal: Number(match[2]) };
}

function toUsed(evidence: readonly SelectionEvidenceItem[]): SelectionContextReceipt['used'] {
  return evidence.map((item) => ({
    sourceKind: item.sourceKind,
    title: item.title,
    locator: item.locator,
    characterCount: item.content.length,
  }));
}

function normalizeQueryTerms(terms: readonly string[]): string[] {
  return unique(terms.map((term) => term.trim()).filter((term) => term.length >= 2 && term.length <= 80)).slice(0, 6);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function assertEvidenceBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('外部来源证据预算无效。');
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('已取消 AI 编辑任务。', 'AbortError');
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The detector intentionally recognises only explicit positive/negative
 * wording over a shared meaningful term. It never resolves a conflict and
 * never turns a candidate into evidence.
 */
export function detectSelectionSourceConflicts(evidence: readonly SelectionEvidenceItem[]): SelectionContextReceipt['conflicts'] {
  const conflicts: SelectionContextReceipt['conflicts'] = [];
  for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
    const left = evidence[leftIndex]!;
    const leftPolarity = resolvePolarity(left.content);
    if (!leftPolarity) continue;
    const leftTerms = comparisonTerms(left.content);
    for (let rightIndex = leftIndex + 1; rightIndex < evidence.length; rightIndex += 1) {
      const right = evidence[rightIndex]!;
      if (left.title === right.title && left.sourceKind === right.sourceKind) continue;
      const rightPolarity = resolvePolarity(right.content);
      if (!rightPolarity || rightPolarity === leftPolarity) continue;
      const shared = [...leftTerms].find((term) => comparisonTerms(right.content).has(term));
      if (!shared) continue;
      conflicts.push({
        conflictId: `conflict-${hashText(`${left.evidenceId}\u0000${right.evidenceId}`).slice(0, 16)}`,
        evidenceIds: [left.evidenceId, right.evidenceId],
        summary: `“${shared}”在「${left.title}」与「${right.title}」中存在正反表述，需按原文定位人工核对。`,
        status: 'needs-review',
      });
    }
  }
  return conflicts;
}

function resolvePolarity(value: string): 'positive' | 'negative' | undefined {
  if (/(?:不支持|禁止|不能|不可用|未启用|无效)/u.test(value)) return 'negative';
  if (/(?:支持|允许|可以|可用|启用)/u.test(value)) return 'positive';
  return undefined;
}

function comparisonTerms(value: string): Set<string> {
  return new Set((value.match(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_.-]{2,}/gu) ?? [])
    .filter((term) => !['当前笔记', '资料库', '原文', '内容'].includes(term))
    .slice(0, 24));
}
