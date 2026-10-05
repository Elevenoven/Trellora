import type { LibraryChunkingConfig } from '../electron';

export type ChunkingDraftFieldErrors = Partial<Record<'parent' | 'parentOverlap' | 'childRecursive' | 'childFixed' | 'strategies' | 'regex' | 'llm', string>>;

export const RECOMMENDED_CHUNKING_DRAFT: LibraryChunkingConfig = {
  schemaVersion: 2,
  mode: 'recommended',
  parentStrategies: ['STRUCTURE', 'RECURSIVE'],
  childStrategies: [],
  parentMinChars: 1200,
  parentTargetChars: 2400,
  parentMaxChars: 3500,
  parentOverlapChars: 200,
  childRecursiveMaxChars: 700,
  childRecursiveOverlapChars: 100,
  semanticMaxChars: 700,
  semanticMinChars: 240,
  semanticSimilarityThreshold: 0.18,
  llmEnabled: false,
  llmMaxChars: 3500,
  llmTimeoutMs: 45_000,
  llmMaxOutputTokens: 2_000,
  llmPromptVersion: 'chunk-boundary-v1',
  recommendLlmWhenLowQuality: true,
  pageMinMetadataCoverage: 0.8,
  regexPattern: '',
  regexFlags: [],
  regexBoundary: 'before',
  regexKeepDelimiter: true,
  childFixedTargetChars: 700,
  childFixedMinChars: 160,
  childFixedMaxChars: 900,
  childFixedOverlapChars: 100,
};

export function cloneChunkingDraft(config: LibraryChunkingConfig = RECOMMENDED_CHUNKING_DRAFT): LibraryChunkingConfig {
  return JSON.parse(JSON.stringify(config)) as LibraryChunkingConfig;
}

export function validateChunkingDraft(config: LibraryChunkingConfig): ChunkingDraftFieldErrors {
  const errors: ChunkingDraftFieldErrors = {};
  if (config.parentMinChars > config.parentTargetChars || config.parentTargetChars > config.parentMaxChars) {
    errors.parent = '父块长度需满足：最低字数 ≤ 目标字数 ≤ 最大字数。';
  }
  if (config.parentOverlapChars >= config.parentMaxChars) errors.parentOverlap = '父块 overlap 必须小于最大字数。';
  if (config.childRecursiveOverlapChars >= config.childRecursiveMaxChars) errors.childRecursive = '子块 overlap 必须小于子块最大字数。';
  if (config.childFixedMinChars > config.childFixedTargetChars || config.childFixedTargetChars > config.childFixedMaxChars || config.childFixedOverlapChars >= config.childFixedMaxChars) {
    errors.childFixed = '固定长度子块需满足 min ≤ target ≤ max，且 overlap 小于 max。';
  }
  if (config.mode === 'custom' && (!config.parentStrategies.length || !config.childStrategies.length)) errors.strategies = '自定义策略需各选择一个父块与子块策略。';
  if ((config.parentStrategies.includes('REGEX') || config.childStrategies.includes('REGEX')) && !config.regexPattern.trim()) errors.regex = '选择正则切块后，请填写用于识别边界的表达式。';
  if (config.mode === 'custom' && config.childStrategies.includes('LLM') && !config.llmEnabled) errors.llm = '使用 LLM 子块前，需先开启 LLM 智能切块。';
  return errors;
}
