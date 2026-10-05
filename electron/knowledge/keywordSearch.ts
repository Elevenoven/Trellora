import type { LexicalMatchTrace } from './lexicalMatchPolicy';

export interface SearchCandidate {
  path: string;
  title: string;
  score: number;
  relativePath?: string;
  snippet?: string;
  heading?: string;
  searchTerm?: string;
  matchTrace?: LexicalMatchTrace[];
}

export interface KeywordSearchResult extends SearchCandidate {
  methods: ['keyword'];
}

export interface KeywordSearchOutcome {
  results: KeywordSearchResult[];
  mode: 'keyword' | 'none';
}

export function createKeywordSearchOutcome(results: readonly SearchCandidate[], limit = 8): KeywordSearchOutcome {
  const limited = results.slice(0, Math.max(1, Math.min(40, limit))).map((result) => ({ ...result, methods: ['keyword'] as ['keyword'] }));
  return { results: limited, mode: limited.length ? 'keyword' : 'none' };
}
