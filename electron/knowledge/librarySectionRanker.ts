import { createHash } from 'node:crypto';
import MiniSearch from 'minisearch';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import {
  isCurrentNoteIdentifier,
  normalizeCurrentNoteText,
  tokenizeCurrentNoteText,
  type CurrentNoteEvidenceBlock,
  type CurrentNoteHeadingRange,
} from './currentNoteStructure';
import { SEARCH_QUERY_TERM_BATCH_SIZE, type SearchQueryTerm } from './searchPlanTypes';

const HEADING_DF_SUPPRESSION_RATIO = 0.8;
const RELATED_SECTION_LIMIT = 3;
const SECTION_PREVIEW_CHARACTERS = 240;
const INDEX_TOKEN_SEPARATOR = '\u0001';

export interface LibrarySectionSearchDocument {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  level: number;
  lineFrom: number;
  lineTo: number;
  headingText: string;
  directBodyText: string;
  directBodyTerms: string[];
  identifiers: string[];
  directBlockIds: string[];
}

export interface NormalizedLibrarySectionQueryTerm {
  term: string;
  normalizedTerm: string;
  source: SearchQueryTerm['source'];
}

export interface LibraryRelatedSectionCandidate {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  headingId: string;
  headingPath: string[];
  lineFrom: number;
  lineTo: number;
  score: number;
  scoreBreakdown: {
    bodyBm25: number;
    headingBm25: number;
    queryCoverage: number;
    exactBodyOrIdentifier: number;
  };
  matchedQueryTerms: string[];
  suppressedHeadingTerms: string[];
  preview: string;
}

export interface LibrarySectionRankResult {
  noteId: string;
  snapshotId: string;
  contentHash: string;
  queryTermFingerprint: string;
  processedQueryTerms: readonly Readonly<NormalizedLibrarySectionQueryTerm>[];
  processedQueryTermCount: number;
  queryTermBatchCount: number;
  evaluatedSectionCount: number;
  suppressedHeadingTerms: readonly string[];
  ambiguous: boolean;
  fallbackUsed: false;
  reason?: 'no-query-terms' | 'all-query-terms-non-discriminative';
  topSections: readonly Readonly<LibraryRelatedSectionCandidate>[];
}

/** Navigation-only recommendation. Candidates are not Evidence Ledger records. */
export interface LibrarySectionRecommendationObservation {
  goalId: string;
  sourceEvidenceId: string;
  noteId: string;
  snapshotId: string;
  contentHash: string;
  queryTermCount: number;
  evaluatedSectionCount: number;
  ambiguous: boolean;
  fallbackUsed: boolean;
  topSections: readonly Readonly<LibraryRelatedSectionCandidate>[];
}

interface SectionIndexDocument {
  id: string;
  bodyChannel: string;
  headingChannel: string;
}

interface QueryTermStats {
  term: PreparedLibrarySectionQueryTerm;
  bodyDfRatio: number;
  headingDfRatio: number;
  suppressHeading: boolean;
}

interface PreparedLibrarySectionQueryTerm extends NormalizedLibrarySectionQueryTerm {
  comparableTerm: string;
  identifier: boolean;
}

interface PreparedLibrarySectionDocument {
  source: Readonly<LibrarySectionSearchDocument>;
  normalizedBodyText: string;
  normalizedHeadingText: string;
  normalizedIdentifiers: ReadonlySet<string>;
  normalizedHeadingTokens: ReadonlySet<string>;
  bodyIndexText: string;
  headingIndexText: string;
}

interface ScoredSection {
  candidate: LibraryRelatedSectionCandidate;
  internalScore: number;
  bodyBm25: number;
  queryCoverage: number;
  admitted: boolean;
}

export class LibrarySectionRanker {
  readonly documents: readonly Readonly<LibrarySectionSearchDocument>[];
  private readonly preparedDocuments: readonly PreparedLibrarySectionDocument[];
  private readonly sectionIndex: MiniSearch<SectionIndexDocument>;
  private readonly noteId: string;
  private readonly snapshotId: string;
  private readonly contentHash: string;

  constructor(input: { noteId: string; snapshot: CurrentNoteSnapshot }) {
    this.noteId = input.noteId;
    this.snapshotId = input.snapshot.snapshotId;
    this.contentHash = input.snapshot.contentHash;
    this.documents = projectLibrarySectionSearchDocuments(input);
    this.preparedDocuments = this.documents.map(prepareLibrarySectionDocument);
    this.sectionIndex = new MiniSearch<SectionIndexDocument>({
      fields: ['bodyChannel', 'headingChannel'],
      tokenize: tokenizePreparedIndexText,
    });
    this.sectionIndex.addAll(this.preparedDocuments.map((document) => ({
      id: document.source.headingId,
      bodyChannel: document.bodyIndexText,
      headingChannel: document.headingIndexText,
    })));
  }

  rankRelatedSections(
    queryTerms: readonly SearchQueryTerm[],
    excludedHeadingIds: ReadonlySet<string> = new Set(),
  ): LibrarySectionRankResult {
    const normalizedTerms = normalizeLibrarySectionQueryTerms(queryTerms);
    const preparedTerms = normalizedTerms.map(prepareLibrarySectionQueryTerm);
    const queryTermFingerprint = fingerprintNormalizedQueryTerms(normalizedTerms);
    const baseResult = {
      noteId: this.noteId,
      snapshotId: this.snapshotId,
      contentHash: this.contentHash,
      queryTermFingerprint,
      processedQueryTerms: normalizedTerms,
      processedQueryTermCount: normalizedTerms.length,
      queryTermBatchCount: Math.ceil(normalizedTerms.length / SEARCH_QUERY_TERM_BATCH_SIZE),
      evaluatedSectionCount: this.documents.length,
      fallbackUsed: false as const,
    };
    if (normalizedTerms.length === 0) {
      return freezeRankResult({
        ...baseResult,
        suppressedHeadingTerms: [],
        ambiguous: false,
        reason: 'no-query-terms',
        topSections: [],
      });
    }

    const termStats = calculateQueryTermStats(this.preparedDocuments, preparedTerms);
    const suppressedKeys = new Set(termStats.filter((stats) => stats.suppressHeading).map((stats) => stats.term.normalizedTerm));
    const bodyScores = initializeScoreMap(this.documents);
    const headingScores = initializeScoreMap(this.documents);

    for (const batch of chunkQueryTerms(normalizedTerms)) {
      accumulateMiniSearchScores(this.sectionIndex, batch, bodyScores, ['bodyChannel']);
      const headingBatch = batch.filter((term) => !suppressedKeys.has(term.normalizedTerm));
      if (headingBatch.length > 0) accumulateMiniSearchScores(this.sectionIndex, headingBatch, headingScores, ['headingChannel']);
    }

    const maximumBodyScore = maximumScore(bodyScores);
    const maximumHeadingScore = maximumScore(headingScores);
    const eligibleDocuments = this.documents.filter((document) => !excludedHeadingIds.has(document.headingId));
    const scoredSections = this.preparedDocuments.map((document) => scoreSection({
      document,
      normalizedTerms: preparedTerms,
      suppressedKeys,
      bodyBm25: normalizeScore(bodyScores.get(document.source.headingId) ?? 0, maximumBodyScore),
      headingBm25: normalizeScore(headingScores.get(document.source.headingId) ?? 0, maximumHeadingScore),
    }));
    const admittedSections = scoredSections.filter((section) => section.admitted
      && !excludedHeadingIds.has(section.candidate.headingId));
    const allScoresZero = admittedSections.length === 0;
    const allTermsNonDiscriminative = termStats.every((stats) => stats.bodyDfRatio >= HEADING_DF_SUPPRESSION_RATIO
      || (stats.suppressHeading && stats.bodyDfRatio === 0));
    const allContentSectionsTie = admittedSections.length > 1
      && admittedSections.length === eligibleDocuments.length
      && admittedSections.every((section) => nearlyEqual(section.internalScore, admittedSections[0]?.internalScore ?? 0));
    const ambiguous = allScoresZero || allTermsNonDiscriminative || allContentSectionsTie;
    const topSections = ambiguous ? [] : admittedSections
      .sort(compareScoredSections)
      .slice(0, RELATED_SECTION_LIMIT)
      .map((section) => section.candidate);

    return freezeRankResult({
      ...baseResult,
      suppressedHeadingTerms: termStats.filter((stats) => stats.suppressHeading).map((stats) => stats.term.term),
      ambiguous,
      ...(ambiguous ? { reason: 'all-query-terms-non-discriminative' as const } : {}),
      topSections,
    });
  }

  /** Maps successful read block IDs back to the deepest content sections that own them. */
  findContentHeadingIdsByBlockIds(blockIds: readonly string[]): string[] {
    const selectedBlockIds = new Set(blockIds);
    if (selectedBlockIds.size === 0) return [];
    return this.documents
      .filter((document) => document.directBlockIds.some((blockId) => selectedBlockIds.has(blockId)))
      .map((document) => document.headingId);
  }
}

export function projectLibrarySectionSearchDocuments(input: {
  noteId: string;
  snapshot: CurrentNoteSnapshot;
}): LibrarySectionSearchDocument[] {
  const headings = [...input.snapshot.headings]
    .sort((first, second) => first.lineFrom - second.lineFrom || first.level - second.level || first.headingId.localeCompare(second.headingId));
  const blocksByHeadingId = new Map(headings.map((heading) => [heading.headingId, [] as CurrentNoteEvidenceBlock[]]));

  for (const block of input.snapshot.blocks) {
    if (block.kind === 'heading' || block.kind === 'frontmatter' || !block.text.trim()) continue;
    const owner = findDeepestHeading(headings, block.lineFrom);
    if (owner) blocksByHeadingId.get(owner.headingId)?.push(block);
  }

  return headings.flatMap((heading) => {
    const directBlocks = blocksByHeadingId.get(heading.headingId) ?? [];
    if (directBlocks.length === 0) return [];
    return [{
      noteId: input.noteId,
      snapshotId: input.snapshot.snapshotId,
      contentHash: input.snapshot.contentHash,
      headingId: heading.headingId,
      headingPath: [...heading.path],
      level: heading.level,
      lineFrom: heading.lineFrom,
      lineTo: heading.lineTo,
      headingText: heading.text,
      directBodyText: directBlocks.map((block) => block.text).join('\n\n'),
      directBodyTerms: stableUnique(directBlocks.flatMap((block) => block.normalizedTerms)),
      identifiers: stableUnique(directBlocks.flatMap((block) => block.normalizedTerms.filter(isCurrentNoteIdentifier))),
      directBlockIds: directBlocks.map((block) => block.blockId),
    }];
  });
}

export function normalizeLibrarySectionQueryTerms(
  queryTerms: readonly SearchQueryTerm[],
): NormalizedLibrarySectionQueryTerm[] {
  const seen = new Set<string>();
  const normalized: NormalizedLibrarySectionQueryTerm[] = [];
  for (const queryTerm of queryTerms) {
    const term = queryTerm.term.trim();
    const normalizedTerm = term.normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').trim();
    if (!normalizedTerm || seen.has(normalizedTerm)) continue;
    seen.add(normalizedTerm);
    normalized.push({ term, normalizedTerm, source: queryTerm.source });
  }
  return normalized;
}

export function createLibrarySectionQueryTermFingerprint(queryTerms: readonly SearchQueryTerm[]): string {
  return fingerprintNormalizedQueryTerms(normalizeLibrarySectionQueryTerms(queryTerms));
}

export function createLibrarySectionExclusionFingerprint(headingIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(stableUnique(headingIds.filter(Boolean)).sort()), 'utf8')
    .digest('hex');
}

function calculateQueryTermStats(
  documents: readonly PreparedLibrarySectionDocument[],
  queryTerms: readonly PreparedLibrarySectionQueryTerm[],
): QueryTermStats[] {
  return queryTerms.map((term) => {
    const bodyDocumentFrequency = documents.filter((document) => matchesBody(document, term)).length;
    const headingDocumentFrequency = documents.filter((document) => matchesHeading(document, term)).length;
    const bodyDfRatio = documents.length > 0 ? bodyDocumentFrequency / documents.length : 0;
    const headingDfRatio = documents.length > 0 ? headingDocumentFrequency / documents.length : 0;
    return {
      term,
      bodyDfRatio,
      headingDfRatio,
      suppressHeading: headingDfRatio >= HEADING_DF_SUPPRESSION_RATIO,
    };
  });
}

function scoreSection(input: {
  document: PreparedLibrarySectionDocument;
  normalizedTerms: readonly PreparedLibrarySectionQueryTerm[];
  suppressedKeys: ReadonlySet<string>;
  bodyBm25: number;
  headingBm25: number;
}): ScoredSection {
  const bodyMatches = input.normalizedTerms.filter((term) => matchesBody(input.document, term));
  const headingMatches = input.normalizedTerms.filter((term) => !input.suppressedKeys.has(term.normalizedTerm)
    && matchesHeading(input.document, term));
  const matchedTerms = input.normalizedTerms.filter((term) => bodyMatches.includes(term) || headingMatches.includes(term));
  const queryCoverage = matchedTerms.length / Math.max(1, input.normalizedTerms.length);
  const exactBodyOrIdentifier = Number(bodyMatches.length > 0);
  const internalScore = 100 * (0.55 * input.bodyBm25
    + 0.15 * input.headingBm25
    + 0.20 * queryCoverage
    + 0.10 * exactBodyOrIdentifier);
  return {
    internalScore,
    bodyBm25: input.bodyBm25,
    queryCoverage,
    admitted: bodyMatches.length > 0 || headingMatches.length > 0,
    candidate: {
      noteId: input.document.source.noteId,
      snapshotId: input.document.source.snapshotId,
      contentHash: input.document.source.contentHash,
      headingId: input.document.source.headingId,
      headingPath: [...input.document.source.headingPath],
      lineFrom: input.document.source.lineFrom,
      lineTo: input.document.source.lineTo,
      score: round(internalScore, 2),
      scoreBreakdown: {
        bodyBm25: round(input.bodyBm25, 6),
        headingBm25: round(input.headingBm25, 6),
        queryCoverage: round(queryCoverage, 6),
        exactBodyOrIdentifier,
      },
      matchedQueryTerms: matchedTerms.map((term) => term.term),
      suppressedHeadingTerms: input.normalizedTerms
        .filter((term) => input.suppressedKeys.has(term.normalizedTerm) && matchesHeading(input.document, term))
        .map((term) => term.term),
      preview: createPreview(input.document.source.directBodyText),
    },
  };
}

function findDeepestHeading(
  headings: readonly CurrentNoteHeadingRange[],
  line: number,
): CurrentNoteHeadingRange | undefined {
  let left = 0;
  let right = headings.length - 1;
  let nearestIndex = -1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (headings[middle].lineFrom <= line) {
      nearestIndex = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  for (let index = nearestIndex; index >= 0; index -= 1) {
    const heading = headings[index];
    if (heading.lineTo >= line) return heading;
  }
  return undefined;
}

function initializeScoreMap(documents: readonly Readonly<LibrarySectionSearchDocument>[]): Map<string, number> {
  return new Map(documents.map((document) => [document.headingId, 0]));
}

function accumulateMiniSearchScores<T extends { id: string }>(
  index: MiniSearch<T>,
  queryTerms: readonly NormalizedLibrarySectionQueryTerm[],
  scores: Map<string, number>,
  fields: string[],
): void {
  const query = queryTerms.map((term) => term.normalizedTerm).join(' ');
  for (const result of index.search(query, { combineWith: 'OR', fields })) {
    const headingId = String(result.id);
    if (!scores.has(headingId)) continue;
    scores.set(headingId, (scores.get(headingId) ?? 0) + (Number(result.score) || 0));
  }
}

function chunkQueryTerms(
  queryTerms: readonly NormalizedLibrarySectionQueryTerm[],
): NormalizedLibrarySectionQueryTerm[][] {
  const batches: NormalizedLibrarySectionQueryTerm[][] = [];
  for (let index = 0; index < queryTerms.length; index += SEARCH_QUERY_TERM_BATCH_SIZE) {
    batches.push(queryTerms.slice(index, index + SEARCH_QUERY_TERM_BATCH_SIZE));
  }
  return batches;
}

function matchesBody(document: PreparedLibrarySectionDocument, term: PreparedLibrarySectionQueryTerm): boolean {
  if (!term.comparableTerm) return false;
  if (term.identifier) return document.normalizedIdentifiers.has(term.comparableTerm);
  return document.normalizedBodyText.includes(term.comparableTerm)
    || document.normalizedIdentifiers.has(term.comparableTerm);
}

function matchesHeading(document: PreparedLibrarySectionDocument, term: PreparedLibrarySectionQueryTerm): boolean {
  if (!term.comparableTerm) return false;
  if (term.identifier) return document.normalizedHeadingTokens.has(term.comparableTerm);
  return document.normalizedHeadingText.includes(term.comparableTerm);
}

function prepareLibrarySectionDocument(document: Readonly<LibrarySectionSearchDocument>): PreparedLibrarySectionDocument {
  const headingValue = `${document.headingPath.join(' ')} ${document.headingText}`;
  const bodyTokens = document.directBodyTerms;
  const headingPathTokens = tokenizeCurrentNoteText(document.headingPath.join(' / '));
  return {
    source: document,
    normalizedBodyText: normalizeCurrentNoteText(document.directBodyText),
    normalizedHeadingText: normalizeCurrentNoteText(headingValue),
    normalizedIdentifiers: new Set(document.identifiers.map((identifier) => normalizeCurrentNoteText(identifier))),
    normalizedHeadingTokens: new Set(headingPathTokens.map((term) => normalizeCurrentNoteText(term))),
    bodyIndexText: encodePreparedIndexTokens(bodyTokens),
    headingIndexText: encodePreparedIndexTokens(headingPathTokens),
  };
}

function tokenizePreparedIndexText(value: string): string[] {
  if (!value) return [];
  return value.startsWith(INDEX_TOKEN_SEPARATOR)
    ? value.slice(INDEX_TOKEN_SEPARATOR.length).split(INDEX_TOKEN_SEPARATOR).filter(Boolean)
    : tokenizeCurrentNoteText(value);
}

function encodePreparedIndexTokens(tokens: readonly string[]): string {
  return tokens.length ? `${INDEX_TOKEN_SEPARATOR}${tokens.join(INDEX_TOKEN_SEPARATOR)}` : '';
}

function prepareLibrarySectionQueryTerm(term: NormalizedLibrarySectionQueryTerm): PreparedLibrarySectionQueryTerm {
  return {
    ...term,
    comparableTerm: normalizeCurrentNoteText(term.normalizedTerm),
    identifier: isCurrentNoteIdentifier(term.normalizedTerm),
  };
}

function maximumScore(scores: ReadonlyMap<string, number>): number {
  return Math.max(0, ...scores.values());
}

function normalizeScore(score: number, maximum: number): number {
  return maximum > 0 ? score / maximum : 0;
}

function compareScoredSections(first: ScoredSection, second: ScoredSection): number {
  return second.internalScore - first.internalScore
    || second.bodyBm25 - first.bodyBm25
    || second.queryCoverage - first.queryCoverage
    || first.candidate.lineFrom - second.candidate.lineFrom
    || first.candidate.headingId.localeCompare(second.candidate.headingId);
}

function fingerprintNormalizedQueryTerms(queryTerms: readonly NormalizedLibrarySectionQueryTerm[]): string {
  return createHash('sha256')
    .update(JSON.stringify(queryTerms.map((term) => [term.normalizedTerm, term.source])), 'utf8')
    .digest('hex');
}

function createPreview(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, SECTION_PREVIEW_CHARACTERS);
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nearlyEqual(first: number, second: number): boolean {
  return Math.abs(first - second) < 1e-12;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function freezeRankResult(result: LibrarySectionRankResult): LibrarySectionRankResult {
  for (const term of result.processedQueryTerms) Object.freeze(term);
  for (const candidate of result.topSections) {
    Object.freeze(candidate.headingPath);
    Object.freeze(candidate.scoreBreakdown);
    Object.freeze(candidate.matchedQueryTerms);
    Object.freeze(candidate.suppressedHeadingTerms);
    Object.freeze(candidate);
  }
  Object.freeze(result.processedQueryTerms);
  Object.freeze(result.suppressedHeadingTerms);
  Object.freeze(result.topSections);
  return Object.freeze(result);
}
