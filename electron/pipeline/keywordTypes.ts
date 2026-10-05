export const KEYWORD_CONTRACT_SCHEMA_VERSION = 1;
export const KEYWORD_OUTPUT_SCHEMA_VERSION = 3;
export const KEYWORD_BASELINE_ALGORITHM_VERSION = 'kw-baseline-1';

export interface KeywordChunkInput {
  schemaVersion: number;
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  legacyFlatChunk?: boolean;
  ordinal: number;
  text: string;
  sectionPath: readonly Record<string, unknown>[];
  nodeIds: readonly string[];
  sourceRefs: readonly Record<string, unknown>[];
  overlapFromChunkId: string | null;
  overlapChars: number;
}

export interface KeywordOccurrence {
  start: number;
  end: number;
  sentenceIndex: number;
}

export interface KeywordFeatures {
  tfidf: number;
  textRank: number;
  position: number;
  sentenceSpread: number;
  sectionMatch: number;
  termQuality: number;
  domainBoost: boolean;
  overlapOnly: boolean;
}

export interface KeywordItem {
  term: string;
  normalizedTerm: string;
  kind: 'word' | 'phrase' | 'term';
  rank: number;
  score: number;
  occurrences: readonly KeywordOccurrence[];
  features: KeywordFeatures;
  forcedTop1: boolean;
}

export interface KeywordAlgorithmMetadata {
  name: string;
  version: string;
  tokenizer: string;
  tokenizerVersion: string;
  dictionaryHash: string;
  stopwordHash: string;
}

export interface KeywordChunkOutput {
  schemaVersion: number;
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  chunkContentHash: string;
  algorithm: KeywordAlgorithmMetadata;
  /** Compact surface terms for the future semanticization input. */
  keyword: readonly string[];
  /** Ordered Jieba tokens used to build the FTS5 full-text projection. */
  searchTokens: readonly string[];
  keywords: readonly KeywordItem[];
  emptyReason: string | null;
}

export interface KeywordBaselineReport {
  schemaVersion: number;
  stage: 'keywords-baseline';
  algorithmVersion: string;
  fixtureCount: number;
  durationMs: number;
  avgMsPerChunk: number;
  precisionAt5: number;
  recallAt5: number;
  f1At5: number;
  offsetAccuracy: number;
  deterministic: boolean;
  outputsSha256: string;
}
