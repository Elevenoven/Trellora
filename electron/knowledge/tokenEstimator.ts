import type { EffectiveContextWindowConfidence, EffectiveContextWindowSource } from '../../shared/effectiveContextWindow';
import type { AssistantEvidenceProjectionMode, EvidenceCompressionMode } from './assistantMode';

export interface AssistantEvidenceContextStats {
  /** Stage 1 deliberately exposes estimates only; exact values belong to Stage 2+. */
  accuracy: 'estimate' | 'exact';
  projectionMode: AssistantEvidenceProjectionMode;
  compressionMode: EvidenceCompressionMode;
  manifestStatus: 'not-materialized' | 'materialized';
  /** Includes repeated search-hit events, matching the search observation rail. */
  searchHitCount: number;
  uniqueSearchHitCount: number;
  estimatedRawEvidenceTokens: number;
  mayNeedCompression: boolean;
  evidenceBudgetTokens?: number;
  /** Exact Stage 2+ values are optional until the source evidence is materialized. */
  retrievedCount?: number;
  representedCount?: number;
  rawCount?: number;
  compressedCount?: number;
  rawTokens?: number;
  finalEvidenceTokens?: number;
  compressionRatio?: number;
  compressionRounds?: number;
  compressionBatchCount?: number;
  representationCoverage?: number;
}

export interface AssistantTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface AssistantPromptPartitionStat {
  zone: string;
  tokens: number;
  protectedTokens: number;
  segmentIds: string[];
}

export interface AssistantPromptStats {
  callKind: string;
  projectionLevel: 0 | 1 | 3 | 4;
  planId?: string;
  planVersion?: number;
  activeGoalId?: string | null;
  predictedPromptTokens: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  safetyReserveTokens?: number;
  protectedTokens: number;
  evidenceHotTokens: number;
  evidenceWarmTokens: number;
  evidenceColdTokens: number;
  partitions: AssistantPromptPartitionStat[];
  evidenceContextStats?: AssistantEvidenceContextStats;
}

export interface AssistantContextUsage {
  inputTokens: number;
  contextWindowTokens?: number;
  contextWindowSource?: EffectiveContextWindowSource;
  contextWindowConfidence?: EffectiveContextWindowConfidence;
  contextWindowWarning?: string;
  estimated: boolean;
  source: 'estimate' | 'provider';
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  promptStats?: AssistantPromptStats;
}

/**
 * Estimates prompt tokens without shipping a provider-specific tokenizer to
 * the desktop app. CJK characters are counted individually; Latin runs use
 * a conservative four-characters-per-token approximation.
 */
export function estimateTokenCount(value: string): number {
  let tokens = 0;
  let latinRun = 0;

  const flushLatinRun = () => {
    if (latinRun > 0) {
      tokens += Math.ceil(latinRun / 4);
      latinRun = 0;
    }
  };

  for (const character of value) {
    if (/\s/u.test(character)) {
      flushLatinRun();
      continue;
    }
    if (/^[\u3400-\u9fff]$/u.test(character)) {
      flushLatinRun();
      tokens += 1;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code <= 0x7f && /[A-Za-z0-9]/u.test(character)) {
      latinRun += 1;
      continue;
    }
    flushLatinRun();
    tokens += 1;
  }

  flushLatinRun();
  return tokens;
}

export interface SearchHitEvidenceTokenMetadata {
  blockId?: string;
  lineFrom: number;
  lineTo: number;
  snippet: string;
  headingPath?: readonly string[];
}

export interface AssistantEvidenceObserveInput {
  projectionMode: AssistantEvidenceProjectionMode;
  compressionMode: EvidenceCompressionMode;
  searchHits: readonly SearchHitEvidenceTokenMetadata[];
  evidenceBudgetTokens?: number;
}

/**
 * Estimates the original block size from search metadata only. The snippet is
 * a lower-bound signal; line span and heading metadata add a conservative,
 * deterministic allowance. It must never be presented as materialized text.
 */
export function estimateSearchHitEvidenceTokens(hits: readonly SearchHitEvidenceTokenMetadata[]): {
  searchHitCount: number;
  uniqueSearchHitCount: number;
  estimatedRawEvidenceTokens: number;
} {
  const seen = new Set<string>();
  let estimatedRawEvidenceTokens = 0;
  for (const hit of hits) {
    const lineFrom = Number.isSafeInteger(hit.lineFrom) ? hit.lineFrom : 1;
    const lineTo = Number.isSafeInteger(hit.lineTo) ? Math.max(lineFrom, hit.lineTo) : lineFrom;
    const key = `${hit.blockId ?? ''}:${lineFrom}:${lineTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineCount = Math.max(1, lineTo - lineFrom + 1);
    const snippetTokens = estimateTokenCount(hit.snippet);
    const headingTokens = estimateTokenCount((hit.headingPath ?? []).join(' '));
    const signalTokens = snippetTokens + Math.ceil(headingTokens / 2);
    const tokensPerLine = Math.max(8, Math.ceil(signalTokens / Math.min(lineCount, 4)));
    estimatedRawEvidenceTokens += Math.min(32_000, Math.max(snippetTokens, tokensPerLine * lineCount));
  }
  return {
    searchHitCount: hits.length,
    uniqueSearchHitCount: seen.size,
    estimatedRawEvidenceTokens,
  };
}

/**
 * Stage 1 side-channel only. It does not create a Manifest, read source text,
 * select prompt evidence, invoke a model, or change the provider prompt.
 */
export function estimateAssistantEvidenceContextStats(input: AssistantEvidenceObserveInput): AssistantEvidenceContextStats | undefined {
  if (input.compressionMode !== 'observe') return undefined;
  const estimate = estimateSearchHitEvidenceTokens(input.searchHits);
  const evidenceBudgetTokens = input.evidenceBudgetTokens !== undefined
    && Number.isSafeInteger(input.evidenceBudgetTokens)
    && input.evidenceBudgetTokens >= 0
    ? input.evidenceBudgetTokens
    : undefined;
  return {
    accuracy: 'estimate',
    projectionMode: input.projectionMode,
    compressionMode: input.compressionMode,
    manifestStatus: 'not-materialized',
    ...estimate,
    ...(evidenceBudgetTokens !== undefined ? { evidenceBudgetTokens } : {}),
    mayNeedCompression: evidenceBudgetTokens !== undefined && estimate.estimatedRawEvidenceTokens > evidenceBudgetTokens,
  };
}

export function estimateAssistantContextUsage(
  prompt: string,
  contextWindowTokens?: number,
  providerUsage?: AssistantTokenUsage,
  contextWindow?: { source: EffectiveContextWindowSource; confidence: EffectiveContextWindowConfidence; warning?: string },
): AssistantContextUsage {
  if (providerUsage?.inputTokens !== undefined) {
    return {
      inputTokens: providerUsage.inputTokens,
      contextWindowTokens,
      ...(contextWindow ? { contextWindowSource: contextWindow.source, contextWindowConfidence: contextWindow.confidence, ...(contextWindow.warning ? { contextWindowWarning: contextWindow.warning } : {}) } : {}),
      estimated: false,
      source: 'provider',
      ...(providerUsage.outputTokens !== undefined ? { outputTokens: providerUsage.outputTokens } : {}),
      ...(providerUsage.totalTokens !== undefined ? { totalTokens: providerUsage.totalTokens } : {}),
      ...(providerUsage.cachedInputTokens !== undefined ? { cachedInputTokens: providerUsage.cachedInputTokens } : {}),
    };
  }
  return {
    inputTokens: estimateTokenCount(prompt),
    contextWindowTokens,
    ...(contextWindow ? { contextWindowSource: contextWindow.source, contextWindowConfidence: contextWindow.confidence, ...(contextWindow.warning ? { contextWindowWarning: contextWindow.warning } : {}) } : {}),
    estimated: true,
    source: 'estimate',
  };
}
