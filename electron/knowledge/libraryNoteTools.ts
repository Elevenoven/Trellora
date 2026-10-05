import { createKeywordSearchOutcome, type SearchCandidate } from './keywordSearch';
import { getCurrentNoteMap, readCurrentNoteRange, readCurrentNoteSection, type CurrentNoteReadLimits } from './currentNoteTools';
import { CurrentNoteLexicalIndex, type CurrentNoteSearchHit } from './currentNoteLexicalIndex';
import {
  createLibrarySectionExclusionFingerprint,
  createLibrarySectionQueryTermFingerprint,
  LibrarySectionRanker,
  type LibrarySectionRankResult,
} from './librarySectionRanker';
import { getLibraryNoteRecord, type LibraryNoteSnapshotMap, type LibraryNoteSnapshotRecord } from './libraryNoteSnapshot';
import type { SearchQueryTerm } from './searchPlanTypes';

export interface LibraryNoteCandidate {
  noteId: string;
  title: string;
  contentHash: string;
  score: number;
  snippet?: string;
  methods: ['keyword'];
  matchTrace?: SearchCandidate['matchTrace'];
}

export interface LibraryNoteBlockHit extends CurrentNoteSearchHit {
  noteId: string;
  title: string;
  contentHash: string;
}

export interface LibrarySearchCallbacks {
  keywordSearch: (query: string) => SearchCandidate[];
}

export type LibraryAdjacentSectionDirection = 'previous' | 'next';

export interface LibraryAdjacentSectionTarget {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  level: number;
  lineFrom: number;
  lineTo: number;
}

/** Main-process-only quota; the model-visible tool schema never exposes it. */
export type LibraryNoteReadLimits = CurrentNoteReadLimits;

export async function searchLibraryNoteCandidates(input: {
  snapshotMap: LibraryNoteSnapshotMap;
  sessionId: string;
  query: string;
  limit?: number;
  callbacks: LibrarySearchCallbacks;
}): Promise<{ results: LibraryNoteCandidate[]; mode: 'keyword' | 'none' }> {
  if (input.snapshotMap.sessionId !== input.sessionId) throw new Error('整库搜索不属于当前助手会话。');
  const query = input.query.trim();
  if (!query) return { results: [], mode: 'none' };
  const limit = input.limit ?? 8;
  const outcome = createKeywordSearchOutcome(input.callbacks.keywordSearch(query), limit);
  const byPath = new Map([...input.snapshotMap.records.values()].map((record) => [record.localSnapshot.notePath, record]));
  const results = outcome.results.flatMap((result) => {
    const record = byPath.get(result.path);
    if (!record) return [];
    return [{
      noteId: record.noteId,
      title: record.title,
      contentHash: record.contentHash,
      score: result.score,
      ...(result.snippet ? { snippet: result.snippet } : {}),
      methods: result.methods,
      ...(result.matchTrace?.length ? { matchTrace: result.matchTrace } : {}),
    }];
  }).slice(0, Math.max(1, Math.min(20, limit)));
  return { results, mode: outcome.mode };
}

export function createLibraryNoteTools(snapshotMap: LibraryNoteSnapshotMap, sessionId: string): {
  getNoteMap: (noteId: string, detail?: 'outline' | 'stats' | 'terms') => ReturnType<typeof getCurrentNoteMap>;
  searchNoteBlocks: (noteId: string, terms: readonly string[], limit?: number) => LibraryNoteBlockHit[];
  rankRelatedSections: (noteId: string, queryTerms: readonly SearchQueryTerm[], excludedHeadingIds?: readonly string[]) => LibrarySectionRankResult;
  findContentHeadingIdsByBlockIds: (noteId: string, blockIds: readonly string[]) => string[];
  findDeepestHeadingIdAtLine: (noteId: string, line: number) => string | undefined;
  findAdjacentSection: (noteId: string, anchorHeadingId: string, direction: LibraryAdjacentSectionDirection) => LibraryAdjacentSectionTarget | undefined;
  readNoteRange: (noteId: string, input: { lineFrom: number; lineTo: number }, limits?: LibraryNoteReadLimits) => ReturnType<typeof readCurrentNoteRange>;
  readNoteSection: (noteId: string, input: { headingId: string; cursor?: number }, limits?: LibraryNoteReadLimits) => ReturnType<typeof readCurrentNoteSection>;
} {
  const indexes = new Map<string, CurrentNoteLexicalIndex>();
  const sectionRankers = new Map<string, LibrarySectionRanker>();
  const sectionRankResults = new Map<string, LibrarySectionRankResult>();
  const getRecord = (noteId: string) => getLibraryNoteRecord(snapshotMap, noteId, sessionId);
  const getIndex = (noteId: string) => {
    const existing = indexes.get(noteId);
    if (existing) return existing;
    const created = new CurrentNoteLexicalIndex(getRecord(noteId).localSnapshot);
    indexes.set(noteId, created);
    return created;
  };
  const getSectionRanker = (record: LibraryNoteSnapshotRecord) => {
    const existing = sectionRankers.get(record.snapshotId);
    if (existing) return existing;
    const created = new LibrarySectionRanker({ noteId: record.noteId, snapshot: record.localSnapshot });
    sectionRankers.set(record.snapshotId, created);
    return created;
  };
  return {
    getNoteMap: (noteId, detail = 'outline') => getCurrentNoteMap(getRecord(noteId).localSnapshot, detail),
    searchNoteBlocks: (noteId, terms, limit = 8) => {
      const record = getRecord(noteId);
      return getIndex(noteId).search(terms.join(' '), limit).map((hit) => ({
        ...hit,
        noteId,
        title: record.title,
        contentHash: record.contentHash,
      }));
    },
    rankRelatedSections: (noteId, queryTerms, excludedHeadingIds = []) => {
      const record = getRecord(noteId);
      const queryTermFingerprint = createLibrarySectionQueryTermFingerprint(queryTerms);
      const excludedHeadingFingerprint = createLibrarySectionExclusionFingerprint(excludedHeadingIds);
      const cacheKey = `${record.snapshotId}\u0000${queryTermFingerprint}\u0000${excludedHeadingFingerprint}`;
      const cached = sectionRankResults.get(cacheKey);
      if (cached) return cached;
      const result = getSectionRanker(record).rankRelatedSections(queryTerms, new Set(excludedHeadingIds));
      sectionRankResults.set(cacheKey, result);
      return result;
    },
    findContentHeadingIdsByBlockIds: (noteId, blockIds) => {
      const record = getRecord(noteId);
      return getSectionRanker(record).findContentHeadingIdsByBlockIds(blockIds);
    },
    findDeepestHeadingIdAtLine: (noteId, line) => {
      const record = getRecord(noteId);
      if (!Number.isInteger(line) || line < 1 || line > record.localSnapshot.lineCount) throw new Error('章节锚点行号无效。');
      return [...record.localSnapshot.headings]
        .filter((heading) => heading.lineFrom <= line && heading.lineTo >= line)
        .sort((first, second) => second.level - first.level || second.lineFrom - first.lineFrom || first.headingId.localeCompare(second.headingId))[0]
        ?.headingId;
    },
    findAdjacentSection: (noteId, anchorHeadingId, direction) => {
      if (direction !== 'previous' && direction !== 'next') throw new Error('相邻章节方向无效。');
      const record = getRecord(noteId);
      const anchor = record.localSnapshot.headings.find((heading) => heading.headingId === anchorHeadingId);
      if (!anchor) throw new Error('证据章节锚点已不属于当前快照。');
      const parentPath = anchor.path.slice(0, -1);
      const siblings = record.localSnapshot.headings
        .filter((heading) => heading.level === anchor.level && arraysEqual(heading.path.slice(0, -1), parentPath))
        .sort((first, second) => first.lineFrom - second.lineFrom || first.headingId.localeCompare(second.headingId));
      const anchorIndex = siblings.findIndex((heading) => heading.headingId === anchor.headingId);
      if (anchorIndex < 0) throw new Error('证据章节锚点无法映射到同级章节。');
      const adjacent = siblings[anchorIndex + (direction === 'previous' ? -1 : 1)];
      if (!adjacent) return undefined;
      return {
        noteId,
        snapshotId: record.snapshotId,
        contentHash: record.contentHash,
        headingId: adjacent.headingId,
        headingPath: [...adjacent.path],
        level: adjacent.level,
        lineFrom: adjacent.lineFrom,
        lineTo: adjacent.lineTo,
      };
    },
    readNoteRange: (noteId, input, limits) => readCurrentNoteRange(getRecord(noteId).localSnapshot, input, limits),
    readNoteSection: (noteId, input, limits) => readCurrentNoteSection(getRecord(noteId).localSnapshot, input, limits),
  };
}

function arraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
