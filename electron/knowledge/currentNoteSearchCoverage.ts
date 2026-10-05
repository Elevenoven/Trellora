import type { CurrentNoteSearchScope, CurrentNoteCoveragePolicy } from './currentNoteSearchScope';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import type { CurrentNoteSearchHit } from './currentNoteLexicalIndex';
import type { AssistantSearchGoalCoverage } from './assistantMemoryTypes';

const TURN_GOAL_ID = '__turn__';
const MAX_SUMMARY_ASPECTS = 6;

export type CurrentNoteCoverageStatus = 'complete' | 'partial' | 'insufficient';

export interface CurrentNoteCoverageReadInput {
  snapshotId?: string;
  evidenceId: string;
  blockIds: readonly string[];
  headingPath: readonly string[];
  lineFrom: number;
  lineTo: number;
  text: string;
  headingId?: string;
  nextCursor?: number;
}

export interface CurrentNoteGoalCoverageSummary {
  goalId: string;
  mode: CurrentNoteSearchScope['mode'];
  coveragePolicy: CurrentNoteCoveragePolicy;
  discoveredHeadingCount: number;
  readHeadingCount: number;
  matchedBlockCount: number;
  searchedBlockCount: number;
  materializedBlockCount: number;
  materializedEvidenceCount: number;
  evidenceCount: number;
  targetAspectCount: number;
  coveredAspectCount: number;
  remainingAspects: readonly string[];
  candidateTruncated: boolean;
  candidateExhausted: boolean;
  plannedQueryTerms: readonly string[];
  executedQueryTerms: readonly string[];
  unexecutedQueryTerms: readonly string[];
  status: CurrentNoteCoverageStatus;
  reason: string;
}

export interface CurrentNoteSearchCoverageSummary extends CurrentNoteGoalCoverageSummary {
  goalSummaries: readonly CurrentNoteGoalCoverageSummary[];
}

interface MutableGoalCoverage {
  discoveredHeadingIds: Set<string>;
  readHeadingIds: Set<string>;
  matchedBlockIds: Set<string>;
  materializedBlockIds: Set<string>;
  materializedEvidenceIds: Set<string>;
  evidenceIds: Set<string>;
  discoveredAspects: Set<string>;
  coveredAspects: Set<string>;
  candidateTruncated: boolean;
  candidateExhausted: boolean;
  truncatedHeadingIds: Set<string>;
  queryFingerprint?: string;
  nextSearchCursor?: string;
  plannedQueryTerms: string[];
  executedQueryTerms: Set<string>;
}

/**
 * Main-process-only coverage state. Search observations can add candidates,
 * but only successful reads which have already been accepted by Evidence
 * Ledger can add readable coverage. No model-facing patch can mutate this
 * object or submit counts.
 */
export class CurrentNoteSearchCoverageLedger {
  private scope: CurrentNoteSearchScope;
  private readonly goals = new Map<string, MutableGoalCoverage>();

  constructor(private readonly snapshot: CurrentNoteSnapshot, scope: CurrentNoteSearchScope) {
    this.scope = cloneScope(scope);
  }

  /** Called by the main-process scope resolver after Planner validation. */
  adoptResolvedScope(scope: CurrentNoteSearchScope): void {
    this.scope = cloneScope(scope);
  }

  recordSearch(
    goalId: string | undefined,
    hits: readonly CurrentNoteSearchHit[],
    limit: number,
    page?: {
      candidateExhausted: boolean;
      nextCursor?: string;
      queryFingerprint?: string;
      plannedQueryTerms?: readonly string[];
      executedQueryTerms?: readonly string[];
      materialized?: readonly CurrentNoteCoverageReadInput[];
    },
  ): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Coverage 搜索上限无效。');
    const state = this.stateFor(goalId);
    if (page?.plannedQueryTerms) state.plannedQueryTerms = appendOrderedTerms(state.plannedQueryTerms, page.plannedQueryTerms);
    if (page?.executedQueryTerms) {
      for (const term of orderedUniqueTerms(page.executedQueryTerms)) state.executedQueryTerms.add(term);
    }
    for (const hit of hits) {
      if (!hit.blockId || !Number.isInteger(hit.lineFrom) || !Number.isInteger(hit.lineTo)) continue;
      state.matchedBlockIds.add(hit.blockId);
      const headingId = hit.headingId ?? this.headingIdAtLine(hit.lineFrom);
      if (headingId) state.discoveredHeadingIds.add(headingId);
      for (const aspect of this.scope.targetAspects) {
        if (matchesAspect(aspect, [hit.snippet, ...hit.headingPath, ...hit.matchedTerms])) state.discoveredAspects.add(aspect);
      }
    }
    for (const materialized of page?.materialized ?? []) {
      if (materialized.snapshotId !== undefined && materialized.snapshotId !== this.snapshot.snapshotId) {
        throw new Error('Coverage 自动物化结果不属于当前笔记快照。');
      }
      state.evidenceIds.add(materialized.evidenceId);
      state.materializedEvidenceIds.add(materialized.evidenceId);
      for (const blockId of materialized.blockIds) {
        if (blockId) state.materializedBlockIds.add(blockId);
      }
      for (const readHeadingId of this.headingIdsForRangeRead(materialized)) state.readHeadingIds.add(readHeadingId);
      for (const aspect of this.scope.targetAspects) {
        if (matchesAspect(aspect, [materialized.text, ...materialized.headingPath])) state.coveredAspects.add(aspect);
      }
    }
    if (page) {
      // `page.candidateExhausted` only describes the current QueryTerm batch.
      // A goal is exhausted after every planned term has been executed and the
      // final batch has reached its last candidate page.
      const hasUnexecutedPlannedTerms = state.plannedQueryTerms.some((term) => !state.executedQueryTerms.has(term));
      state.candidateExhausted = page.candidateExhausted && !hasUnexecutedPlannedTerms;
      state.candidateTruncated = !state.candidateExhausted;
      state.nextSearchCursor = page.nextCursor;
      state.queryFingerprint = page.queryFingerprint;
    } else {
      // The legacy array API has no search cursor. Reaching the public limit
      // is therefore deliberately treated as a possible truncation.
      state.candidateExhausted = false;
      state.nextSearchCursor = undefined;
      state.queryFingerprint = undefined;
      if (hits.length >= limit || this.scope.coveragePolicy === 'occurrence-complete') state.candidateTruncated = true;
    }
  }

  recordRead(goalId: string | undefined, input: CurrentNoteCoverageReadInput): void {
    if (input.snapshotId !== undefined && input.snapshotId !== this.snapshot.snapshotId) throw new Error('Coverage 读取结果不属于当前笔记快照。');
    if (!/^evidence-[a-f0-9]{24}$/u.test(input.evidenceId)) throw new Error('Coverage 证据标识无效。');
    if (!Number.isInteger(input.lineFrom) || !Number.isInteger(input.lineTo) || input.lineFrom < 1 || input.lineTo < input.lineFrom) {
      throw new Error('Coverage 原文行范围无效。');
    }
    if (input.headingId && !this.snapshot.headings.some((heading) => heading.headingId === input.headingId && input.lineFrom <= heading.lineTo && input.lineTo >= heading.lineFrom)) {
      throw new Error('Coverage 章节不属于当前原文范围。');
    }
    const state = this.stateFor(goalId);
    state.evidenceIds.add(input.evidenceId);
    // A section tool result is authoritative: do not infer its parent from the
    // returned line range, otherwise one read is counted as both parent and
    // child. Range reads have no explicit heading and therefore derive one
    // most-specific heading per actually returned block.
    const readHeadingIds = input.headingId
      ? new Set([input.headingId])
      : this.headingIdsForRangeRead(input);
    for (const readHeadingId of readHeadingIds) state.readHeadingIds.add(readHeadingId);
    for (const aspect of this.scope.targetAspects) {
      if (matchesAspect(aspect, [input.text, ...input.headingPath])) state.coveredAspects.add(aspect);
    }
    for (const readHeadingId of readHeadingIds) {
      if (input.nextCursor !== undefined) state.truncatedHeadingIds.add(readHeadingId);
      else state.truncatedHeadingIds.delete(readHeadingId);
    }
  }

  hasGoal(goalId: string | undefined): boolean {
    return this.goals.has(normalizeGoalId(goalId));
  }

  isComplete(goalId: string | undefined, requiredEvidenceCount = 1): boolean {
    return this.evaluate(goalId, requiredEvidenceCount).status === 'complete';
  }

  hasUnexecutedPlannedTerms(): boolean {
    for (const state of this.goals.values()) {
      if (state.plannedQueryTerms.some((term) => !state.executedQueryTerms.has(term))) return true;
    }
    return false;
  }

  getQueryTermAudit(goalId?: string): {
    plannedQueryTerms: string[];
    executedQueryTerms: string[];
    unexecutedQueryTerms: string[];
  } {
    const state = this.stateFor(goalId);
    return {
      plannedQueryTerms: [...state.plannedQueryTerms],
      executedQueryTerms: [...state.executedQueryTerms],
      unexecutedQueryTerms: state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term)),
    };
  }

  evaluate(goalId: string | undefined, requiredEvidenceCount = 1): CurrentNoteGoalCoverageSummary {
    const normalizedRequiredEvidence = Number.isInteger(requiredEvidenceCount) && requiredEvidenceCount > 0 ? requiredEvidenceCount : 1;
    const key = normalizeGoalId(goalId);
    const state = this.stateFor(goalId);
    const targetAspects = this.completionTargetAspects();
    const remainingAspects = targetAspects.filter((aspect) => !state.coveredAspects.has(aspect));
    const coveredAspects = targetAspects.filter((aspect) => state.coveredAspects.has(aspect));
    const evidenceReady = state.evidenceIds.size >= normalizedRequiredEvidence;
    const minimumSections = this.minimumSections();
    let status: CurrentNoteCoverageStatus = 'insufficient';
    let reason = '尚未读取当前笔记原文证据。';
    if (this.scope.coveragePolicy === 'sufficient') {
      if (evidenceReady && remainingAspects.length === 0 && state.truncatedHeadingIds.size === 0) {
        status = 'complete';
        reason = '当前原文范围已达到进入合成的前提；最终答案完整性仍由模型判断。';
      } else if (evidenceReady && state.truncatedHeadingIds.size > 0) {
        status = 'partial';
        reason = '章节原文仍有未读取部分，不能结束当前原文读取。';
      } else if (state.evidenceIds.size > 0 && remainingAspects.length > 0) {
        status = 'partial';
        reason = `仍有 ${remainingAspects.length} 个方面未读取原文。`;
      } else if (state.evidenceIds.size > 0) {
        status = 'partial';
        reason = '已有原文证据，但数量尚未满足当前目标。';
      }
    } else if (state.evidenceIds.size > 0 && state.candidateTruncated) {
      status = 'partial';
      reason = '候选分页或 QueryTerm 批次尚未遍历完，不能声称已覆盖全部范围。';
    } else if (state.evidenceIds.size > 0 && state.truncatedHeadingIds.size > 0) {
      status = 'partial';
      reason = '章节原文仍有未读取部分，不能声称已完成覆盖。';
    } else if (state.evidenceIds.size > 0 && remainingAspects.length > 0) {
      status = 'partial';
      reason = `仍有 ${remainingAspects.length} 个方面未读取原文。`;
    } else if (state.evidenceIds.size > 0 && state.readHeadingIds.size < minimumSections) {
      status = 'partial';
      reason = `主题范围至少需要读取 ${minimumSections} 个不同章节。`;
    } else if (state.evidenceIds.size > 0 && this.scope.coveragePolicy === 'occurrence-complete' && !state.candidateExhausted) {
      status = 'partial';
      reason = '逐处覆盖需要遍历全部候选；搜索分页尚未到达末页。';
    } else if (evidenceReady) {
      status = 'complete';
      reason = '目标方面和章节范围已达到进入合成的前提；最终答案完整性仍由模型判断。';
    }
    return Object.freeze({
      goalId: key,
      mode: this.scope.mode,
      coveragePolicy: this.scope.coveragePolicy,
      discoveredHeadingCount: state.discoveredHeadingIds.size,
      readHeadingCount: state.readHeadingIds.size,
      matchedBlockCount: state.matchedBlockIds.size,
      searchedBlockCount: state.matchedBlockIds.size,
      materializedBlockCount: state.materializedBlockIds.size,
      materializedEvidenceCount: state.materializedEvidenceIds.size,
      evidenceCount: state.evidenceIds.size,
      targetAspectCount: targetAspects.length,
      coveredAspectCount: coveredAspects.length,
      remainingAspects: Object.freeze([...remainingAspects]),
      candidateTruncated: state.candidateTruncated,
      candidateExhausted: state.candidateExhausted,
      plannedQueryTerms: Object.freeze([...state.plannedQueryTerms]),
      executedQueryTerms: Object.freeze([...state.executedQueryTerms]),
      unexecutedQueryTerms: Object.freeze(state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term))),
      status,
      reason,
    });
  }

  toModelSummary(goalId?: string, requiredEvidenceCount = 1): CurrentNoteGoalCoverageSummary {
    // A compact immutable summary is the only representation sent to a model.
    return this.evaluate(goalId, requiredEvidenceCount);
  }

  toSummary(requiredEvidenceCount = 1): CurrentNoteSearchCoverageSummary {
    const goalSummaries = [...this.goals.keys()]
      .filter((goalId) => goalId !== TURN_GOAL_ID)
      .map((goalId) => this.evaluate(goalId, requiredEvidenceCount));
    if (goalSummaries.length === 0) {
      const primary = this.evaluate(undefined, requiredEvidenceCount);
      return Object.freeze({ ...primary, goalSummaries: Object.freeze([primary]) });
    }
    const remainingAspects = [...new Set(goalSummaries.flatMap((summary) => summary.remainingAspects))].slice(0, MAX_SUMMARY_ASPECTS);
    const status = goalSummaries.every((summary) => summary.status === 'complete')
      ? 'complete'
      : goalSummaries.some((summary) => summary.evidenceCount > 0)
        ? 'partial'
        : 'insufficient';
    const incomplete = goalSummaries.find((summary) => summary.status !== 'complete');
    return Object.freeze({
      goalId: 'all-goals',
      mode: this.scope.mode,
      coveragePolicy: this.scope.coveragePolicy,
      discoveredHeadingCount: goalSummaries.reduce((total, summary) => total + summary.discoveredHeadingCount, 0),
      readHeadingCount: goalSummaries.reduce((total, summary) => total + summary.readHeadingCount, 0),
      matchedBlockCount: goalSummaries.reduce((total, summary) => total + summary.matchedBlockCount, 0),
      searchedBlockCount: goalSummaries.reduce((total, summary) => total + summary.searchedBlockCount, 0),
      materializedBlockCount: goalSummaries.reduce((total, summary) => total + summary.materializedBlockCount, 0),
      materializedEvidenceCount: goalSummaries.reduce((total, summary) => total + summary.materializedEvidenceCount, 0),
      evidenceCount: goalSummaries.reduce((total, summary) => total + summary.evidenceCount, 0),
      targetAspectCount: goalSummaries.reduce((total, summary) => total + summary.targetAspectCount, 0),
      coveredAspectCount: goalSummaries.reduce((total, summary) => total + summary.coveredAspectCount, 0),
      remainingAspects: Object.freeze(remainingAspects),
      candidateTruncated: goalSummaries.some((summary) => summary.candidateTruncated),
      candidateExhausted: goalSummaries.every((summary) => summary.candidateExhausted),
      plannedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.plannedQueryTerms))]),
      executedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.executedQueryTerms))]),
      unexecutedQueryTerms: Object.freeze([...new Set(goalSummaries.flatMap((summary) => summary.unexecutedQueryTerms))]),
      status,
      reason: incomplete?.reason ?? '所有目标的原文范围均已达到进入合成的前提；最终答案完整性仍由模型判断。',
      goalSummaries: Object.freeze(goalSummaries),
    });
  }

  /** Stage 6 broad-coverage view: one current source is enough for navigation status. */
  toAllRetrievedSummary(): CurrentNoteSearchCoverageSummary {
    return this.toSummary(1);
  }

  /**
   * Main-process-only durable projection.  The returned data contains only
   * stable identifiers, hashes, counts and the opaque cursor token.
   */
  toPersistence(nextSearchCursors?: ReadonlyMap<string, string>): AssistantSearchGoalCoverage[] {
    return [...this.goals.entries()]
      .filter(([goalId]) => goalId !== TURN_GOAL_ID)
      .map(([goalId, state]) => {
        // Persistence describes the authoritative Search Scope. It must not
        // reuse the relaxed `sufficient` completion projection below.
        const targetAspects = this.scope.targetAspects.slice(0, MAX_SUMMARY_ASPECTS);
        const coveredAspects = targetAspects.filter((aspect) => state.coveredAspects.has(aspect));
        const nextSearchCursor = nextSearchCursors?.get(goalId) ?? state.nextSearchCursor;
        return {
          goalId,
          snapshotId: this.snapshot.snapshotId,
          contentHash: this.snapshot.contentHash,
          queryFingerprint: state.queryFingerprint ?? '',
          matchedBlockCount: state.matchedBlockIds.size,
          searchedBlockCount: state.matchedBlockIds.size,
          materializedBlockCount: state.materializedBlockIds.size,
          materializedEvidenceCount: state.materializedEvidenceIds.size,
          matchedHeadingCount: state.discoveredHeadingIds.size,
          readHeadingCount: state.readHeadingIds.size,
          coveredAspectCount: coveredAspects.length,
          targetAspectCount: targetAspects.length,
          discoveredHeadingIds: [...state.discoveredHeadingIds],
          readHeadingIds: [...state.readHeadingIds],
          coveredAspects,
          missingAspects: targetAspects.filter((aspect) => !state.coveredAspects.has(aspect)),
          candidateExhausted: state.candidateExhausted,
          candidateTruncated: state.candidateTruncated,
          plannedQueryTerms: [...state.plannedQueryTerms],
          executedQueryTerms: [...state.executedQueryTerms],
          unexecutedQueryTerms: state.plannedQueryTerms.filter((term) => !state.executedQueryTerms.has(term)),
          ...(nextSearchCursor ? { nextSearchCursor } : {}),
        };
      });
  }

  private stateFor(goalId: string | undefined): MutableGoalCoverage {
    const key = normalizeGoalId(goalId);
    const existing = this.goals.get(key);
    if (existing) return existing;
    const created: MutableGoalCoverage = {
      discoveredHeadingIds: new Set(),
      readHeadingIds: new Set(),
      matchedBlockIds: new Set(),
      materializedBlockIds: new Set(),
      materializedEvidenceIds: new Set(),
      evidenceIds: new Set(),
      discoveredAspects: new Set(),
      coveredAspects: new Set(),
      candidateTruncated: false,
      candidateExhausted: false,
      truncatedHeadingIds: new Set(),
      plannedQueryTerms: [],
      executedQueryTerms: new Set(),
    };
    this.goals.set(key, created);
    return created;
  }

  private minimumSections(): number {
    if (this.scope.mode !== 'topic-wide') return 1;
    const nonEmptyHeadings = this.snapshot.headings.filter((heading) => heading.lineTo >= heading.lineFrom).length;
    return Math.min(2, Math.max(1, nonEmptyHeadings));
  }

  private completionTargetAspects(): string[] {
    // `sufficient` asks whether the existing original evidence is enough to
    // answer the focused goal. Aspect labels remain navigation hints, not a
    // mandatory checklist; strict policies continue to enforce every aspect.
    return this.scope.coveragePolicy === 'sufficient'
      ? []
      : this.scope.targetAspects.slice(0, MAX_SUMMARY_ASPECTS);
  }

  private headingIdAtLine(line: number): string | undefined {
    return this.snapshot.headings
      .filter((heading) => line >= heading.lineFrom && line <= heading.lineTo)
      .sort((first, second) => {
        const firstSpan = first.lineTo - first.lineFrom;
        const secondSpan = second.lineTo - second.lineFrom;
        return firstSpan - secondSpan || second.level - first.level || second.lineFrom - first.lineFrom || first.headingId.localeCompare(second.headingId);
      })[0]?.headingId;
  }

  private headingIdsForRangeRead(input: CurrentNoteCoverageReadInput): Set<string> {
    const readHeadingIds = new Set<string>();
    const blocks = input.blockIds
      .map((blockId) => this.snapshot.blocks.find((candidate) => candidate.blockId === blockId))
      .filter((block): block is CurrentNoteSnapshot['blocks'][number] => block !== undefined);
    for (const block of blocks) {
      const headingId = this.headingIdAtLine(block.lineFrom);
      if (headingId) readHeadingIds.add(headingId);
    }
    // Heading-only ranges (or legacy callers without block IDs) still get a
    // deterministic line-based association, but never add an ancestor when a
    // concrete block already identified the read chapter(s).
    if (readHeadingIds.size === 0) {
      const headingId = this.headingIdAtLine(input.lineFrom);
      if (headingId) readHeadingIds.add(headingId);
    }
    return readHeadingIds;
  }
}

function normalizeGoalId(goalId: string | undefined): string {
  return goalId?.trim() || TURN_GOAL_ID;
}

function cloneScope(scope: CurrentNoteSearchScope): CurrentNoteSearchScope {
  return { ...scope, targetAspects: [...scope.targetAspects] };
}

function matchesAspect(aspect: string, values: readonly string[]): boolean {
  const normalizedAspect = normalize(aspect);
  if (!normalizedAspect) return false;
  return values.some((value) => normalize(value).includes(normalizedAspect));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function orderedUniqueTerms(values: readonly string[]): string[] {
  return appendOrderedTerms([], values);
}

function appendOrderedTerms(existing: readonly string[], values: readonly string[]): string[] {
  const result = [...existing];
  const seen = new Set(result);
  for (const value of values) {
    const term = value.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}
