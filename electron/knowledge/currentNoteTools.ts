import { randomBytes } from 'node:crypto';
import { getCurrentNoteSnapshotBlock, type CurrentNoteSnapshot } from './currentNoteSnapshot';
import {
  CURRENT_NOTE_SEARCH_SORT_VERSION,
  CurrentNoteLexicalIndex,
  normalizeCurrentNoteSearchQuery,
  type CurrentNoteSearchHit,
  type CurrentNoteSearchScopeInput,
} from './currentNoteLexicalIndex';
import type { CurrentNoteScopeMode } from './currentNoteSearchScope';
import { SEARCH_QUERY_TERM_BATCH_SIZE } from './searchPlanTypes';
import { readMarkdownLineRange } from './currentNoteStructure';
import { estimateTokenCount } from './tokenEstimator';

export type CurrentNoteMapDetail = 'outline' | 'stats' | 'terms';

export interface CurrentNoteMap {
  snapshotId: string;
  title: string;
  lineCount: number;
  detail: CurrentNoteMapDetail;
  headings: Array<{
    headingId: string;
    level: number;
    text: string;
    path: string[];
    lineFrom: number;
    lineTo: number;
    blockCount: number;
  }>;
  structureCounts?: Record<string, number>;
  topTerms?: string[];
}

export interface CurrentNoteRangeRead {
  snapshotId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  requestedLineFrom: number;
  requestedLineTo: number;
  blockIds: string[];
  text: string;
  nextCursor?: number;
}

export interface CurrentNoteSectionRead {
  snapshotId: string;
  headingId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  blockIds: string[];
  text: string;
  nextCursor?: number;
}

export interface CurrentNoteSearchPage {
  snapshotId: string;
  hits: CurrentNoteSearchHit[];
  nextCursor?: string;
  candidateExhausted: boolean;
}

const MAX_SEARCH_TERMS = SEARCH_QUERY_TERM_BATCH_SIZE;
const MAX_SEARCH_TERM_CHARS = 80;
const MAX_SEARCH_HITS = 20;
const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 8_000;
const MAX_SECTION_CHARS = 12_000;
const MAX_SEARCH_CURSOR_LENGTH = 160;
const MAX_SEARCH_CURSOR_STORE = 256;

interface CurrentNoteSearchCursorPayload {
  snapshotId: string;
  normalizedQuery: string;
  scopeMode: CurrentNoteScopeMode;
  scopeFingerprint: string;
  sortVersion: string;
  offset: number;
}

export type CurrentNoteSearchCursorStore = Map<string, CurrentNoteSearchCursorPayload>;

const defaultSearchCursorStore: CurrentNoteSearchCursorStore = new Map();

/** Maximum number of terms accepted by one lexical search call. */
export const CURRENT_NOTE_SEARCH_TERM_LIMIT = MAX_SEARCH_TERMS;

export interface CurrentNoteSearchHitOriginal {
  snapshotId: string;
  blockId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  text: string;
}

/** Internal controller limits. They are never included in model-visible tool arguments. */
export interface CurrentNoteReadLimits {
  maxTokens?: number;
  maxChars?: number;
  maxLines?: number;
}

export function getCurrentNoteMap(snapshot: CurrentNoteSnapshot, detail: CurrentNoteMapDetail = 'outline'): CurrentNoteMap {
  const headings = snapshot.headings.map((heading) => ({
    headingId: heading.headingId,
    level: heading.level,
    text: heading.text,
    path: [...heading.path],
    lineFrom: heading.lineFrom,
    lineTo: heading.lineTo,
    blockCount: snapshot.blocks.filter((block) => block.lineFrom >= heading.lineFrom && block.lineTo <= heading.lineTo).length,
  }));
  const result: CurrentNoteMap = { snapshotId: snapshot.snapshotId, title: snapshot.title, lineCount: snapshot.lineCount, detail, headings };
  if (detail === 'stats') result.structureCounts = countStructures(snapshot);
  if (detail === 'terms') result.topTerms = getTopTerms(snapshot);
  return result;
}

export function searchCurrentNote(index: CurrentNoteLexicalIndex, terms: readonly string[], limit = 8, scope?: CurrentNoteSearchScopeInput): CurrentNoteSearchHit[] {
  const normalizedTerms = normalizeSearchTerms(terms);
  assertSearchLimit(limit);
  return index.search(normalizedTerms.join(' '), limit, scope);
}

/**
 * Materializes the complete block represented by a lexical hit. The hit is
 * only a locator; snippets are deliberately never admitted as evidence.
 */
export function materializeCurrentNoteSearchHit(snapshot: CurrentNoteSnapshot, hit: CurrentNoteSearchHit): CurrentNoteSearchHitOriginal {
  const block = getCurrentNoteSnapshotBlock(snapshot, hit.blockId);
  if (!block || block.lineFrom !== hit.lineFrom || block.lineTo !== hit.lineTo) {
    throw new Error('搜索命中无法映射到当前笔记快照原文。');
  }
  const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, block.lineFrom, block.lineTo);
  if (text !== block.text) throw new Error('搜索命中对应的当前快照原文不一致。');
  return {
    snapshotId: snapshot.snapshotId,
    blockId: block.blockId,
    headingPath: [...block.headingPath],
    lineFrom: block.lineFrom,
    lineTo: block.lineTo,
    text,
  };
}

/** Validates an entire hit page before any caller admits it to a Ledger. */
export function materializeCurrentNoteSearchHits(
  snapshot: CurrentNoteSnapshot,
  hits: readonly CurrentNoteSearchHit[],
): CurrentNoteSearchHitOriginal[] {
  return hits.map((hit) => materializeCurrentNoteSearchHit(snapshot, hit));
}

/** Mechanical batching only; it does not normalize or rewrite query terms. */
export function batchCurrentNoteSearchTerms(
  terms: readonly string[],
  maxTerms = CURRENT_NOTE_SEARCH_TERM_LIMIT,
): string[][] {
  if (!Number.isInteger(maxTerms) || maxTerms < 1) throw new Error('搜索词批次上限无效。');
  const ordered = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  const batches: string[][] = [];
  for (let index = 0; index < ordered.length; index += maxTerms) batches.push(ordered.slice(index, index + maxTerms));
  return batches;
}

/**
 * Plan-only paging API. The cursor is intentionally an opaque main-process
 * token; its bound payload never crosses the renderer/model boundary.
 */
export function searchCurrentNotePage(
  index: CurrentNoteLexicalIndex,
  terms: readonly string[],
  limit = 8,
  cursor?: string,
  scope?: CurrentNoteSearchScopeInput,
  cursorStore: CurrentNoteSearchCursorStore = defaultSearchCursorStore,
): CurrentNoteSearchPage {
  const normalizedTerms = normalizeSearchTerms(terms);
  assertSearchLimit(limit);
  const normalizedQuery = normalizeCurrentNoteSearchQuery(normalizedTerms.join(' '));
  const scopeBinding = getSearchCursorScopeBinding(scope);
  let offset = 0;
  let consumedCursor: string | undefined;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_SEARCH_CURSOR_LENGTH) {
      throw new Error('search_note cursor 无效。');
    }
    const payload = cursorStore.get(cursor);
    if (!payload) throw new Error('search_note cursor 不是主进程发出的 nextCursor。');
    if (payload.snapshotId !== index.snapshotId
      || payload.normalizedQuery !== normalizedQuery
      || payload.scopeMode !== scopeBinding.mode
      || payload.scopeFingerprint !== scopeBinding.fingerprint
      || payload.sortVersion !== CURRENT_NOTE_SEARCH_SORT_VERSION) {
      throw new Error('search_note cursor 与当前快照、查询、范围或排序版本不匹配。');
    }
    offset = payload.offset;
    consumedCursor = cursor;
  }
  const page = index.searchPage(normalizedTerms.join(' '), limit, offset, scope);
  const candidateExhausted = offset + page.hits.length >= page.total;
  const nextCursor = candidateExhausted
    ? undefined
    : issueSearchCursor(cursorStore, {
      snapshotId: index.snapshotId,
      normalizedQuery,
      scopeMode: scopeBinding.mode,
      scopeFingerprint: scopeBinding.fingerprint,
      sortVersion: CURRENT_NOTE_SEARCH_SORT_VERSION,
      offset: offset + page.hits.length,
    });
  if (consumedCursor) cursorStore.delete(consumedCursor);
  return {
    snapshotId: index.snapshotId,
    hits: page.hits,
    ...(nextCursor ? { nextCursor } : {}),
    candidateExhausted,
  };
}

export function readCurrentNoteRange(snapshot: CurrentNoteSnapshot, input: { lineFrom: number; lineTo: number }, limits: CurrentNoteReadLimits = {}): CurrentNoteRangeRead {
  assertLineRange(snapshot, input.lineFrom, input.lineTo);
  const overlappingBlocks = snapshot.blocks.filter((block) => block.lineFrom <= input.lineTo && block.lineTo >= input.lineFrom);
  const fullLineFrom = overlappingBlocks.length ? Math.min(...overlappingBlocks.map((block) => block.lineFrom)) : input.lineFrom;
  const fullLineTo = overlappingBlocks.length ? Math.max(...overlappingBlocks.map((block) => block.lineTo)) : input.lineTo;
  if (fullLineTo - fullLineFrom + 1 > MAX_READ_LINES) throw new Error(`扩展后的读取范围不能超过 ${MAX_READ_LINES} 行。`);
  const page = findBoundedPage(snapshot, fullLineFrom, fullLineTo, limits, MAX_READ_CHARS, MAX_READ_LINES);
  const lineFrom = page.lineFrom;
  const lineTo = page.lineTo;
  const text = page.text;
  const headingPath = overlappingBlocks[0]?.headingPath ?? getHeadingPath(snapshot, lineFrom);
  return {
    snapshotId: snapshot.snapshotId,
    headingPath: [...headingPath],
    lineFrom,
    lineTo,
    requestedLineFrom: input.lineFrom,
    requestedLineTo: input.lineTo,
    blockIds: snapshot.blocks.filter((block) => block.lineFrom <= lineTo && block.lineTo >= lineFrom).map((block) => block.blockId),
    text,
    ...(lineTo < fullLineTo ? { nextCursor: lineTo + 1 } : {}),
  };
}

/** Reads only a named section of the immutable snapshot, optionally page by page. */
export function readCurrentNoteSection(snapshot: CurrentNoteSnapshot, input: { headingId: string; cursor?: number }, limits: CurrentNoteReadLimits = {}): CurrentNoteSectionRead {
  const headingId = input.headingId.trim();
  const heading = snapshot.headings.find((entry) => entry.headingId === headingId);
  if (!heading) throw new Error('章节标识无效。');
  const lineFrom = input.cursor ?? heading.lineFrom;
  if (!Number.isInteger(lineFrom) || lineFrom < heading.lineFrom || lineFrom > heading.lineTo) throw new Error('章节游标无效。');
  const lineTo = findSectionPageEnd(snapshot, lineFrom, heading.lineTo, limits);
  const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo);
  const blockIds = snapshot.blocks
    .filter((block) => block.lineFrom <= lineTo && block.lineTo >= lineFrom)
    .map((block) => block.blockId);
  return {
    snapshotId: snapshot.snapshotId,
    headingId,
    headingPath: [...heading.path],
    lineFrom,
    lineTo,
    blockIds,
    text,
    ...(lineTo < heading.lineTo ? { nextCursor: lineTo + 1 } : {}),
  };
}

export function createCurrentNoteTools(snapshot: CurrentNoteSnapshot): {
  getNoteMap: (detail?: CurrentNoteMapDetail) => CurrentNoteMap;
  searchNote: (terms: readonly string[], limit?: number, scope?: CurrentNoteSearchScopeInput) => CurrentNoteSearchHit[];
  searchNotePage: (terms: readonly string[], limit?: number, cursor?: string, scope?: CurrentNoteSearchScopeInput) => CurrentNoteSearchPage;
  readNoteRange: (input: { lineFrom: number; lineTo: number }, limits?: CurrentNoteReadLimits) => CurrentNoteRangeRead;
  readNoteSection: (input: { headingId: string; cursor?: number }, limits?: CurrentNoteReadLimits) => CurrentNoteSectionRead;
} {
  const index = new CurrentNoteLexicalIndex(snapshot);
  const cursorStore: CurrentNoteSearchCursorStore = new Map();
  return {
    getNoteMap: (detail = 'outline') => getCurrentNoteMap(snapshot, detail),
    searchNote: (terms, limit = 8, scope) => searchCurrentNote(index, terms, limit, scope),
    searchNotePage: (terms, limit = 8, cursor, scope) => searchCurrentNotePage(index, terms, limit, cursor, scope, cursorStore),
    readNoteRange: (input, limits) => readCurrentNoteRange(snapshot, input, limits),
    readNoteSection: (input, limits) => readCurrentNoteSection(snapshot, input, limits),
  };
}

function assertSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_HITS) throw new Error(`搜索命中数必须在 1 到 ${MAX_SEARCH_HITS} 之间。`);
}

function getSearchCursorScopeBinding(scope?: CurrentNoteSearchScopeInput): { mode: CurrentNoteScopeMode; fingerprint: string } {
  const mode = typeof scope === 'string' ? scope : scope?.mode ?? 'focused';
  const targetTopic = typeof scope === 'string' ? '' : normalizeCurrentNoteSearchQuery(scope?.targetTopic ?? '');
  const targetAspects = typeof scope === 'string'
    ? []
    : [...(scope?.targetAspects ?? [])].map((aspect) => normalizeCurrentNoteSearchQuery(aspect)).filter(Boolean).sort();
  return { mode, fingerprint: JSON.stringify({ targetTopic, targetAspects }) };
}

function issueSearchCursor(store: CurrentNoteSearchCursorStore, payload: CurrentNoteSearchCursorPayload): string {
  let token = '';
  do {
    token = `search-cursor-${randomBytes(18).toString('base64url')}`;
  } while (store.has(token));
  store.set(token, payload);
  while (store.size > MAX_SEARCH_CURSOR_STORE) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
  return token;
}

function normalizeSearchTerms(terms: readonly string[]): string[] {
  if (!Array.isArray(terms) || terms.length === 0 || terms.length > MAX_SEARCH_TERMS) {
    throw new Error(`搜索词数量必须在 1 到 ${MAX_SEARCH_TERMS} 个之间。`);
  }
  const values = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error('搜索词不能为空。');
  for (const term of values) {
    if (term.length < 2 || term.length > MAX_SEARCH_TERM_CHARS) throw new Error(`每个搜索词必须在 2 到 ${MAX_SEARCH_TERM_CHARS} 个字符之间。`);
  }
  return values;
}

function assertLineRange(snapshot: CurrentNoteSnapshot, lineFrom: number, lineTo: number): void {
  if (!Number.isInteger(lineFrom) || !Number.isInteger(lineTo) || lineFrom < 1 || lineTo < lineFrom || lineTo > snapshot.lineCount) {
    throw new Error('读取行范围无效。');
  }
  if (lineTo - lineFrom + 1 > MAX_READ_LINES) throw new Error(`单次最多读取 ${MAX_READ_LINES} 行。`);
}

function countStructures(snapshot: CurrentNoteSnapshot): Record<string, number> {
  return Object.fromEntries(snapshot.blocks.reduce((counts, block) => {
    counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()));
}

function getTopTerms(snapshot: CurrentNoteSnapshot): string[] {
  const counts = new Map<string, number>();
  for (const block of snapshot.blocks) {
    for (const term of block.normalizedTerms) {
      if (term.length < 2) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], 'zh-Hans-CN'))
    .slice(0, 20)
    .map(([term]) => term);
}

function getHeadingPath(snapshot: CurrentNoteSnapshot, line: number): string[] {
  let match: CurrentNoteSnapshot['headings'][number] | undefined;
  for (const heading of snapshot.headings) {
    if (heading.lineFrom > line) break;
    if (heading.lineTo >= line) match = heading;
  }
  return match ? [...match.path] : [];
}

function findSectionPageEnd(snapshot: CurrentNoteSnapshot, lineFrom: number, maxLine: number, limits: CurrentNoteReadLimits): number {
  const maxChars = Math.min(MAX_SECTION_CHARS, positiveLimit(limits.maxChars, MAX_SECTION_CHARS));
  const maxTokens = positiveLimit(limits.maxTokens, Number.MAX_SAFE_INTEGER);
  const maxLines = Math.min(MAX_READ_LINES, positiveLimit(limits.maxLines, MAX_READ_LINES));
  const boundedMaxLine = Math.min(maxLine, lineFrom + maxLines - 1);
  let lineTo = lineFrom;
  for (let line = lineFrom; line <= boundedMaxLine; line += 1) {
    const candidate = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, line);
    if (candidate.length > maxChars || estimateTokenCount(candidate) > maxTokens) {
      if (line === lineFrom) throw new Error(`章节单行不能超过 ${MAX_SECTION_CHARS} 个字符。`);
      break;
    }
    lineTo = line;
  }
  return lineTo;
}

function findBoundedPage(
  snapshot: CurrentNoteSnapshot,
  lineFrom: number,
  fullLineTo: number,
  limits: CurrentNoteReadLimits,
  defaultMaxChars: number,
  defaultMaxLines: number,
): { lineFrom: number; lineTo: number; text: string } {
  const maxChars = Math.min(defaultMaxChars, positiveLimit(limits.maxChars, defaultMaxChars));
  const maxTokens = positiveLimit(limits.maxTokens, Number.MAX_SAFE_INTEGER);
  const maxLines = Math.min(defaultMaxLines, positiveLimit(limits.maxLines, defaultMaxLines));
  const boundedMaxLine = Math.min(fullLineTo, lineFrom + maxLines - 1);
  let lineTo = lineFrom;
  for (let line = lineFrom; line <= boundedMaxLine; line += 1) {
    const candidate = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, line);
    if (candidate.length > maxChars || estimateTokenCount(candidate) > maxTokens) {
      if (line === lineFrom) throw new Error('单行原文超过当前主进程读取额度。');
      break;
    }
    lineTo = line;
  }
  return { lineFrom, lineTo, text: readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, lineFrom, lineTo) };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
