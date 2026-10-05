import type { LexicalMatchTrace } from './lexicalMatchPolicy';

export type UnifiedSearchMode = 'keyword';

export interface UnifiedSearchResult {
  path: string;
  title: string;
  relativePath: string;
  snippet?: string;
  heading?: string;
  matchTypes: Array<'关键词'>;
  score: number;
  searchTerm?: string;
  matchTrace?: LexicalMatchTrace[];
}

export interface UnifiedSearchOutcome {
  results: UnifiedSearchResult[];
  mode: UnifiedSearchMode;
  used: '关键词搜索';
  notice?: string;
}
