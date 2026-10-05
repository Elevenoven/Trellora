import MiniSearch from 'minisearch';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import {
  buildLexicalMatchTrace,
  lexicalMatchPriority,
  rejectsNumericVersionMismatch,
  resolveFuzzyRatio,
  type LexicalMatchTrace,
} from './lexicalMatchPolicy';
import { isCurrentNoteIdentifier, normalizeCurrentNoteText, tokenizeCurrentNoteText } from './currentNoteStructure';
import type { CurrentNoteSearchScope, CurrentNoteScopeMode } from './currentNoteSearchScope';

export type CurrentNoteMatchType = 'exact' | 'heading' | 'prefix' | 'keyword' | 'fuzzy' | 'identifier';

export interface CurrentNoteSearchHit {
  hitId: string;
  blockId: string;
  /** Undefined means the block belongs to the preamble rather than a heading. */
  headingId?: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  snippet: string;
  matchedTerms: string[];
  matchTypes: CurrentNoteMatchType[];
  matchTrace: LexicalMatchTrace[];
  score: number;
  /** Stable rank from the first-stage lexical ordering, before diversity selection. */
  relevanceRank: number;
}

/** Stable ordering contract used by the current-note search cursor. */
export const CURRENT_NOTE_SEARCH_SORT_VERSION = 'current-note-lexical-rerank-v2';

export interface CurrentNoteSearchIndexPage {
  hits: CurrentNoteSearchHit[];
  total: number;
}

export type CurrentNoteSearchScopeInput = Pick<CurrentNoteSearchScope, 'mode' | 'targetTopic' | 'targetAspects'> | CurrentNoteScopeMode;

export const CURRENT_NOTE_SEARCH_RERANK_WEIGHTS = Object.freeze({
  focused: Object.freeze({ relevance: 0.70, scopeFit: 0.20, aspectGain: 0.10, sectionNovelty: 0, duplicatePenalty: 0.20 }),
  'topic-wide': Object.freeze({ relevance: 0.45, scopeFit: 0.20, aspectGain: 0.15, sectionNovelty: 0.20, duplicatePenalty: 0.20 }),
} as const);

export const CURRENT_NOTE_PREAMBLE_GROUP = '__preamble__';

interface IndexedCurrentNoteBlock {
  id: string;
  heading: string;
  content: string;
  identifiers: string;
}

type CurrentNoteQueryIntent = 'definition' | 'general';

interface CurrentNoteQueryProfile {
  intent: CurrentNoteQueryIntent;
  searchQuery: string;
  normalizedQuery: string;
  queryTerms: string[];
  focusTerms: string[];
}

const DEFINITION_QUESTION_PATTERN = /(?:是什么|是啥|什么是|定义|含义|指什么|什么意思|解释一下)/u;
const ENGLISH_DEFINITION_QUESTION_PATTERN = /\b(?:what\s+is|what's|define|definition\s+of|meaning\s+of)\b/iu;
const DEFINITION_QUESTION_SYNTAX_PATTERN = /(?:是什么|是啥|什么是|定义|含义|指什么|什么意思|解释一下)/gu;
const ENGLISH_DEFINITION_SYNTAX_PATTERN = /\b(?:what\s+is|what's|define|definition\s+of|meaning\s+of)\b/giu;
const DEFINITION_POLITE_WORD_PATTERN = /(?:请问|请|麻烦|帮我|一下|到底)/gu;
const DEFINITION_FIELD_BOOST = Object.freeze({ heading: 0.7, content: 2, identifiers: 2.4 });
const GENERAL_FIELD_BOOST = Object.freeze({ heading: 1.25, content: 1, identifiers: 1.6 });

export class CurrentNoteLexicalIndex {
  private readonly searchIndex: MiniSearch<IndexedCurrentNoteBlock>;
  private readonly blocks: Map<string, CurrentNoteSnapshot['blocks'][number]>;

  constructor(private readonly snapshot: CurrentNoteSnapshot) {
    this.blocks = new Map(snapshot.blocks.map((block) => [block.blockId, block]));
    this.searchIndex = new MiniSearch<IndexedCurrentNoteBlock>({
      fields: ['heading', 'content', 'identifiers'],
      storeFields: ['id'],
      tokenize: (text) => tokenizeCurrentNoteText(text),
    });
    this.searchIndex.addAll(snapshot.blocks.map((block) => ({
      id: block.blockId,
      heading: block.headingPath.join(' / '),
      content: block.text,
      identifiers: block.normalizedTerms.filter(isCurrentNoteIdentifier).join(' '),
    })));
  }

  search(query: string, limit = 20, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchHit[] {
    const firstStageHits = this.collectOrderedHits(query, Math.max(1, Math.min(20, limit)));
    // The legacy array API remains byte-for-byte ordered as before when no
    // controller scope is supplied. Scope-aware Plan routes opt into the
    // second-stage section selection explicitly.
    return scope ? rerankCurrentNoteSearchHits(firstStageHits, scope) : firstStageHits;
  }

  /**
   * Returns a deterministic page without changing the legacy array API. The
   * full lexical ordering is built before the scope-aware rerank so a later
   * page cannot duplicate or skip a hit because of the public 20-hit cap.
   */
  searchPage(query: string, limit = 20, offset = 0, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchIndexPage {
    const allHits = this.collectOrderedHits(query);
    const orderedHits = scope ? rerankCurrentNoteSearchHits(allHits, scope) : allHits;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('搜索分页偏移无效。');
    if (offset > orderedHits.length) throw new Error('搜索分页游标已超出候选范围。');
    return {
      hits: orderedHits.slice(offset, offset + Math.max(1, limit)),
      total: orderedHits.length,
    };
  }

  get snapshotId(): string {
    return this.snapshot.snapshotId;
  }

  private collectOrderedHits(query: string, maxHits?: number): CurrentNoteSearchHit[] {
    const profile = analyzeCurrentNoteQuery(query);
    if (!profile.normalizedQuery || profile.queryTerms.length === 0) return [];

    const rawResults = this.searchIndex.search(profile.searchQuery, {
      prefix: true,
      fuzzy: (term) => resolveFuzzyRatio(term),
      combineWith: 'OR',
      boost: profile.intent === 'definition' ? DEFINITION_FIELD_BOOST : GENERAL_FIELD_BOOST,
      boostDocument: profile.intent === 'definition'
        ? (documentId) => definitionDocumentBoost(this.blocks.get(String(documentId)), profile.focusTerms)
        : undefined,
    });
    const candidates = new Map<string, { bm25: number; matchedTerms: string[] }>();
    for (const result of rawResults) {
      const block = this.blocks.get(String(result.id));
      if (!block || rejectsNumericVersionMismatch(profile.searchQuery, `${block.headingPath.join(' ')}\n${block.text}`)) continue;
      candidates.set(String(result.id), {
        bm25: Number(result.score) || 0,
        matchedTerms: readStringArray((result as unknown as { terms?: unknown }).terms),
      });
    }
    if (profile.normalizedQuery.length >= 2) {
      for (const block of this.snapshot.blocks) {
        if (!rejectsNumericVersionMismatch(profile.searchQuery, `${block.headingPath.join(' ')}\n${block.text}`)
          && normalizeCurrentNoteText(`${block.headingPath.join(' ')}\n${block.text}`).includes(profile.normalizedQuery)) {
          candidates.set(block.blockId, candidates.get(block.blockId) ?? { bm25: 0, matchedTerms: [] });
        }
      }
    }

    const maximumBm25 = Math.max(...[...candidates.values()].map((candidate) => candidate.bm25), 0);
    const sortedHits = [...candidates.entries()]
      .flatMap(([blockId, candidate]) => {
        const block = this.blocks.get(blockId);
        return block ? [toSearchHit(this.snapshot, block, profile, candidate.matchedTerms, candidate.bm25, maximumBm25)] : [];
      })
      .sort((first, second) => lexicalMatchPriority(first.matchTrace) - lexicalMatchPriority(second.matchTrace)
        || second.score - first.score
        || first.lineFrom - second.lineFrom
        || first.blockId.localeCompare(second.blockId));
    const boundedHits = maxHits === undefined ? sortedHits : sortedHits.slice(0, maxHits);
    return boundedHits.map((hit, index) => ({ ...hit, relevanceRank: index + 1 }));
  }
}

export function groupCurrentNoteSearchHitsByHeading(hits: readonly CurrentNoteSearchHit[]): Map<string, CurrentNoteSearchHit[]> {
  const groups = new Map<string, CurrentNoteSearchHit[]>();
  for (const hit of hits) {
    const key = hit.headingId ?? CURRENT_NOTE_PREAMBLE_GROUP;
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  return groups;
}

/** Applies the deterministic second-stage selection after lexical ranking. */
export function rerankCurrentNoteSearchHits(
  hits: readonly CurrentNoteSearchHit[],
  scope?: CurrentNoteSearchScopeInput,
): CurrentNoteSearchHit[] {
  if (hits.length < 2) return [...hits];
  const resolvedScope = normalizeScopeInput(scope);
  const rankedHits = hits.map((hit, index) => ({
    hit,
    relevanceRank: hit.relevanceRank ?? index + 1,
    sectionKey: hit.headingId ?? CURRENT_NOTE_PREAMBLE_GROUP,
  }));
  const scopedCandidates = rankedHits.filter((candidate) => calculateScopeFit(candidate.hit, resolvedScope) > 0);
  const ranked = scopedCandidates.length > 0 ? scopedCandidates : rankedHits;
  const selected: typeof ranked = [];
  const selectedSections = new Set<string>();
  const selectedRanges: Array<{ lineFrom: number; lineTo: number }> = [];
  while (ranked.length > 0) {
    const unselectedSectionCandidates = resolvedScope.mode === 'topic-wide'
      ? ranked.filter((candidate) => !selectedSections.has(candidate.sectionKey))
      : ranked;
    const pool = unselectedSectionCandidates.length ? unselectedSectionCandidates : ranked;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];
      const score = selectionScore(candidate, resolvedScope, selectedSections, selectedRanges, hits.length);
      if (score > bestScore || (score === bestScore && candidate.relevanceRank < bestRank)
        || (score === bestScore && candidate.relevanceRank === bestRank && isEarlier(candidate.hit, pool[bestIndex].hit))) {
        bestIndex = index;
        bestScore = score;
        bestRank = candidate.relevanceRank;
      }
    }
    const chosen = pool[bestIndex];
    selected.push(chosen);
    selectedSections.add(chosen.sectionKey);
    selectedRanges.push({ lineFrom: chosen.hit.lineFrom, lineTo: chosen.hit.lineTo });
    const originalIndex = ranked.indexOf(chosen);
    if (originalIndex >= 0) ranked.splice(originalIndex, 1);
  }
  return selected.map((candidate) => candidate.hit);
}

function toSearchHit(
  snapshot: CurrentNoteSnapshot,
  block: CurrentNoteSnapshot['blocks'][number],
  profile: CurrentNoteQueryProfile,
  matchedIndexTerms: string[],
  bm25: number,
  maximumBm25: number,
): CurrentNoteSearchHit {
  const { focusTerms, intent, normalizedQuery, queryTerms } = profile;
  const definitionFocusTerms = [...new Set([
    ...focusTerms,
    ...matchedIndexTerms.filter(isCurrentNoteIdentifier).map((term) => normalizeCurrentNoteText(term)),
  ])];
  const normalizedHeading = normalizeCurrentNoteText(block.headingPath.join(' '));
  const normalizedBlock = normalizeCurrentNoteText(`${block.headingPath.join(' ')}\n${block.text}`);
  const matchedTerms = queryTerms.filter((term) => block.normalizedTerms.includes(term) || normalizedBlock.includes(term));
  const headingTerms = queryTerms.filter((term) => normalizedHeading.includes(term));
  const exact = normalizedQuery.length >= 2 && normalizedBlock.includes(normalizedQuery);
  const identifier = queryTerms.some((term) => isCurrentNoteIdentifier(term) && block.normalizedTerms.includes(term));
  const coverage = matchedTerms.length / Math.max(1, queryTerms.length);
  const headingCoverage = headingTerms.length / Math.max(1, queryTerms.length);
  const normalizedBm25 = maximumBm25 > 0 ? bm25 / maximumBm25 : 0;
  const matchTrace = buildLexicalMatchTrace(
    queryTerms,
    [...matchedIndexTerms, ...block.normalizedTerms, ...tokenizeCurrentNoteText(block.headingPath.join(' '))],
  );
  const prefix = matchTrace.some((trace) => trace.matchType === 'prefix');
  const fuzzy = matchTrace.some((trace) => trace.matchType === 'fuzzy');
  const matchTypes: CurrentNoteMatchType[] = [];
  if (exact) matchTypes.push('exact');
  if (headingTerms.length) matchTypes.push('heading');
  if (prefix) matchTypes.push('prefix');
  if (matchedTerms.length) matchTypes.push('keyword');
  if (identifier) matchTypes.push('identifier');
  if (fuzzy) matchTypes.push('fuzzy');
  const definitionAdjustment = intent === 'definition' ? 0.22 * definitionCandidateSignal(block, definitionFocusTerms) : 0;
  const score = 0.3 * Number(exact) + 0.22 * coverage + 0.16 * headingCoverage + 0.14 * normalizedBm25
    + 0.08 * Number(identifier) + definitionAdjustment;
  const headingId = findHeadingIdAtLine(snapshot, block.lineFrom);
  return {
    hitId: `hit-${hash(`${snapshot.snapshotId}\u0000${block.blockId}\u0000${normalizedQuery}`).slice(0, 24)}`,
    blockId: block.blockId,
    ...(headingId ? { headingId } : {}),
    headingPath: [...block.headingPath],
    lineFrom: block.lineFrom,
    lineTo: block.lineTo,
    snippet: createSnippet(block.text, normalizedQuery),
    matchedTerms,
    matchTypes,
    matchTrace,
    score: Number(score.toFixed(4)),
    relevanceRank: 0,
  };
}

function normalizeScopeInput(scope?: CurrentNoteSearchScopeInput): {
  mode: CurrentNoteScopeMode;
  targetTopic?: string;
  targetAspects: string[];
} {
  if (typeof scope === 'string') return { mode: scope, targetAspects: [] };
  return {
    mode: scope?.mode ?? 'focused',
    ...(scope?.targetTopic ? { targetTopic: scope.targetTopic } : {}),
    targetAspects: [...(scope?.targetAspects ?? [])],
  };
}

function selectionScore(
  candidate: { hit: CurrentNoteSearchHit; relevanceRank: number; sectionKey: string },
  scope: { mode: CurrentNoteScopeMode; targetTopic?: string; targetAspects: string[] },
  selectedSections: ReadonlySet<string>,
  selectedRanges: readonly { lineFrom: number; lineTo: number }[],
  candidateCount: number,
): number {
  const relevance01 = 1 - (candidate.relevanceRank - 1) / Math.max(1, candidateCount - 1);
  const scopeFit = calculateScopeFit(candidate.hit, scope);
  const aspectGain = calculateAspectGain(candidate.hit, scope.targetAspects);
  const sectionNovelty = selectedSections.has(candidate.sectionKey) ? 0 : 1;
  const duplicatePenalty = selectedSections.has(candidate.sectionKey)
    || selectedRanges.some((range) => candidate.hit.lineFrom <= range.lineTo && candidate.hit.lineTo >= range.lineFrom)
    ? 1
    : 0;
  const weights = CURRENT_NOTE_SEARCH_RERANK_WEIGHTS[scope.mode];
  return weights.relevance * relevance01
    + weights.scopeFit * scopeFit
    + weights.aspectGain * aspectGain
    + weights.sectionNovelty * sectionNovelty
    - weights.duplicatePenalty * duplicatePenalty;
}

function calculateScopeFit(
  hit: CurrentNoteSearchHit,
  scope: { targetTopic?: string; targetAspects: string[] },
): number {
  const normalizedText = normalizeCurrentNoteText(`${hit.headingPath.join(' ')} ${hit.snippet} ${hit.matchedTerms.join(' ')}`);
  const topicFit = scope.targetTopic ? Number(normalizedText.includes(normalizeCurrentNoteText(scope.targetTopic))) : 1;
  const aspectFit = scope.targetAspects.length
    ? scope.targetAspects.filter((aspect) => normalizedText.includes(normalizeCurrentNoteText(aspect))).length / scope.targetAspects.length
    : 1;
  if (scope.targetTopic && topicFit === 0 && (scope.targetAspects.length === 0 || aspectFit === 0)) return 0;
  return Math.min(1, 0.65 * topicFit + 0.35 * aspectFit);
}

function calculateAspectGain(hit: CurrentNoteSearchHit, targetAspects: readonly string[]): number {
  if (targetAspects.length === 0) return 1;
  const normalizedText = normalizeCurrentNoteText(`${hit.headingPath.join(' ')} ${hit.snippet} ${hit.matchedTerms.join(' ')}`);
  return targetAspects.filter((aspect) => normalizedText.includes(normalizeCurrentNoteText(aspect))).length / targetAspects.length;
}

function isEarlier(first: CurrentNoteSearchHit, second: CurrentNoteSearchHit): boolean {
  return first.lineFrom < second.lineFrom || (first.lineFrom === second.lineFrom && first.blockId.localeCompare(second.blockId) < 0);
}

function findHeadingIdAtLine(snapshot: CurrentNoteSnapshot, line: number): string | undefined {
  let headingId: string | undefined;
  for (const heading of snapshot.headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) headingId = heading.headingId;
  }
  return headingId;
}

function analyzeCurrentNoteQuery(query: string): CurrentNoteQueryProfile {
  const trimmedQuery = query.trim().replace(/[?？!！。]+$/gu, '').trim();
  const normalizedOriginal = normalizeCurrentNoteText(trimmedQuery);
  const intent: CurrentNoteQueryIntent = DEFINITION_QUESTION_PATTERN.test(normalizedOriginal)
    || ENGLISH_DEFINITION_QUESTION_PATTERN.test(trimmedQuery)
    ? 'definition'
    : 'general';
  let searchQuery = trimmedQuery;
  if (intent === 'definition') {
    const stripped = trimmedQuery
      .replace(ENGLISH_DEFINITION_SYNTAX_PATTERN, ' ')
      .replace(DEFINITION_QUESTION_SYNTAX_PATTERN, ' ')
      .replace(DEFINITION_POLITE_WORD_PATTERN, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (stripped) searchQuery = stripped;
  }
  const queryTerms = tokenizeCurrentNoteText(searchQuery);
  return {
    intent,
    searchQuery,
    normalizedQuery: normalizeCurrentNoteText(searchQuery),
    queryTerms,
    focusTerms: extractFocusTerms(searchQuery),
  };
}

export function normalizeCurrentNoteSearchQuery(query: string): string {
  return analyzeCurrentNoteQuery(query).normalizedQuery;
}

function extractFocusTerms(value: string): string[] {
  return [...new Set((value.match(/[\u3400-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_./:-]*|\d+(?:\.\d+)?/gu) ?? [])
    .map((term) => normalizeCurrentNoteText(term))
    .filter(Boolean))];
}

function definitionDocumentBoost(
  block: CurrentNoteSnapshot['blocks'][number] | undefined,
  focusTerms: readonly string[],
): number {
  if (!block) return 1;
  const signal = definitionCandidateSignal(block, focusTerms);
  if (signal >= 0.75) return 1.8;
  if (signal <= -0.5) return 0.3;
  if (block.kind === 'heading') return 0.75;
  return 1.05;
}

function definitionCandidateSignal(
  block: CurrentNoteSnapshot['blocks'][number],
  focusTerms: readonly string[],
): number {
  const normalizedText = normalizeCurrentNoteText(block.text);
  let signal = block.kind === 'heading' ? -0.35 : 0.1;
  for (const term of focusTerms) {
    if (!term || !normalizedText.includes(term)) continue;
    if (hasNearbyCue(normalizedText, term, ['是', '指', '即', '表示', '代表', '全称'], 'after', 2)
      || hasNearbyCue(normalizedText, term, ['所谓'], 'before', 2)) {
      signal += 0.9;
    }
    if (hasNearbyCue(normalizedText, term, ['不是', '并非', '不属于'], 'after', 4)
      || hasNearbyCue(normalizedText, term, ['不是', '并非', '不属于'], 'before', 4)) {
      signal -= 1.2;
    }
  }
  return Math.max(-1, Math.min(1, signal));
}

function hasNearbyCue(
  text: string,
  term: string,
  cues: readonly string[],
  position: 'before' | 'after',
  maxGap: number,
): boolean {
  let termAt = text.indexOf(term);
  while (termAt >= 0) {
    const adjacent = position === 'before'
      ? text.slice(Math.max(0, termAt - maxGap - 3), termAt)
      : text.slice(termAt + term.length, termAt + term.length + maxGap + 3);
    if (cues.some((cue) => {
      const cueAt = adjacent.indexOf(cue);
      if (cueAt < 0) return false;
      const gap = position === 'before'
        ? adjacent.length - cueAt - cue.length
        : cueAt;
      return gap <= maxGap;
    })) return true;
    termAt = text.indexOf(term, termAt + term.length);
  }
  return false;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function createSnippet(value: string, normalizedQuery: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= 360) return compact;
  const normalizedCompact = normalizeCurrentNoteText(compact);
  const matchedAt = normalizedQuery ? normalizedCompact.indexOf(normalizedQuery) : -1;
  const start = Math.max(0, matchedAt >= 0 ? matchedAt - 80 : 0);
  const end = Math.min(compact.length, start + 360);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

function hash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
