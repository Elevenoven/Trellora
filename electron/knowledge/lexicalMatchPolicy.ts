export type LexicalMatchType = 'exact' | 'prefix' | 'fuzzy' | 'alias';

export interface LexicalMatchTrace {
  queryTerm: string;
  matchedTerm: string;
  matchType: LexicalMatchType;
  editDistance?: number;
  confidence: number;
}

const TECHNICAL_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_./:-]*$/u;
const PURE_NUMERIC_OR_VERSION_PATTERN = /^\d+(?:[._/-]\d+)*$/u;
const VERSION_PATTERN = /^v?\d+(?:\.\d+)+(?:[-+][a-z0-9.-]+)?$/u;
const DATE_PATTERN = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/u;
const NUMERIC_ID_PATTERN = /^[a-z]+[-_]\d+(?:[-_.]\d+)*$/u;
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PATH_FRAGMENT_PATTERN = /^[a-z0-9._-]+(?:[\\/][a-z0-9._-]+)+$/u;
const FUZZY_RATIO = 0.2;

/** Normalizes terms without removing separators that may be meaningful to an index. */
export function normalizeTechnicalTerm(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-Hans-CN').trim();
}

/** Returns true only for an ASCII technical identifier, not a free-form phrase. */
export function isTechnicalIdentifier(value: string): boolean {
  return TECHNICAL_IDENTIFIER_PATTERN.test(normalizeTechnicalTerm(value));
}

/** Numeric values, versions and dates must never enter the fuzzy path. */
export function isNumericOrVersionLike(value: string): boolean {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (PURE_NUMERIC_OR_VERSION_PATTERN.test(normalized)) return true;
  if (VERSION_PATTERN.test(normalized) || DATE_PATTERN.test(normalized)) return true;
  if (NUMERIC_ID_PATTERN.test(normalized) || UUID_PATTERN.test(normalized)) return true;
  if (PATH_FRAGMENT_PATTERN.test(normalized)) return true;
  return /\d+(?:\.\d+){1,}/u.test(normalized) && /^[a-z0-9._:+-]+$/u.test(normalized);
}

/** Short ASCII abbreviations are candidates, never silent spelling corrections. */
export function isShortTechnicalAbbreviation(value: string): boolean {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  return /^[a-z]{2,5}$/u.test(normalized);
}

/** Used only to keep near-identical acronym variants explicitly uncertain. */
export function isLikelyShortIdentifierCorrection(query: string, candidate: string): boolean {
  const normalizedQuery = normalizeTechnicalTerm(query).replace(/\s+/gu, '');
  const normalizedCandidate = normalizeTechnicalTerm(candidate).replace(/\s+/gu, '');
  if (!normalizedQuery || normalizedQuery === normalizedCandidate) return false;
  if (!isShortTechnicalAbbreviation(normalizedQuery) || !isShortTechnicalAbbreviation(normalizedCandidate)) return false;
  return boundedLevenshteinDistance(normalizedQuery, normalizedCandidate, 1) <= 1;
}

/** Returns the only fuzzy threshold used by local lexical indexes. */
export function resolveFuzzyRatio(value: string): number {
  const normalized = normalizeTechnicalTerm(value).replace(/\s+/gu, '');
  if (!isTechnicalIdentifier(normalized) || isNumericOrVersionLike(normalized) || normalized.length < 6) return 0;
  return FUZZY_RATIO;
}

/** Strictly rejects a numeric/version candidate that does not contain the full query. */
export function rejectsNumericVersionMismatch(query: string, candidateText: string): boolean {
  const normalizedQuery = normalizeTechnicalTerm(query).replace(/\s+/gu, '');
  if (!isNumericOrVersionLike(normalizedQuery)) return false;
  const normalizedCandidate = normalizeTechnicalTerm(candidateText).replace(/\s+/gu, '');
  return !normalizedCandidate.includes(normalizedQuery);
}

/** Builds explainable traces from the query terms and the terms returned by an index. */
export function buildLexicalMatchTrace(
  queryTerms: readonly string[],
  matchedTerms: readonly string[],
): LexicalMatchTrace[] {
  const normalizedQueries = uniqueNormalized(queryTerms);
  const normalizedMatches = uniqueNormalized(matchedTerms);
  const traces: LexicalMatchTrace[] = [];

  for (const queryTerm of normalizedQueries) {
    const exact = normalizedMatches.filter((term) => term === queryTerm);
    if (exact.length) {
      traces.push({ queryTerm, matchedTerm: exact[0], matchType: 'exact', confidence: 1 });
    }

    const prefixes = normalizedMatches.filter((term) => term !== queryTerm && term.startsWith(queryTerm));
    if (prefixes.length) {
      const matchedTerm = [...prefixes].sort(compareCodePointStrings)[0];
      traces.push({ queryTerm, matchedTerm, matchType: 'prefix', confidence: 1 });
    }
    if (exact.length || prefixes.length) {
      continue;
    }

    const ratio = resolveFuzzyRatio(queryTerm);
    if (ratio <= 0) continue;
    const maxDistance = Math.max(1, Math.round(queryTerm.length * ratio));
    const candidates = normalizedMatches
      .map((matchedTerm) => ({ matchedTerm, editDistance: boundedLevenshteinDistance(queryTerm, matchedTerm, maxDistance) }))
      .filter((candidate): candidate is { matchedTerm: string; editDistance: number } => candidate.editDistance <= maxDistance)
      .sort((first, second) => first.editDistance - second.editDistance || compareCodePointStrings(first.matchedTerm, second.matchedTerm));
    const best = candidates[0];
    if (best) {
      traces.push({
        queryTerm,
        matchedTerm: best.matchedTerm,
        matchType: 'fuzzy',
        editDistance: best.editDistance,
        confidence: Number((1 - best.editDistance / Math.max(queryTerm.length, best.matchedTerm.length)).toFixed(4)),
      });
    }
  }

  return traces;
}

/** Sort priority for lexical results; lower values are shown first. */
export function lexicalMatchPriority(traces: readonly LexicalMatchTrace[]): number {
  if (traces.some((trace) => trace.matchType === 'exact')) return 0;
  if (traces.some((trace) => trace.matchType === 'prefix')) return 1;
  if (traces.some((trace) => trace.matchType === 'alias')) return 2;
  if (traces.some((trace) => trace.matchType === 'fuzzy')) return 4;
  return 3;
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeTechnicalTerm(value).replace(/\s+/gu, '')).filter(Boolean))];
}

function boundedLevenshteinDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + Number(left[leftIndex - 1] !== right[rightIndex - 1]);
      const insertion = current[rightIndex - 1] + 1;
      const deletion = previous[rightIndex] + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}
