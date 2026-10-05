import crypto from 'node:crypto';
import type { PipelineAmbiguityConfig } from './types';

const storeKey = 'pipelineAmbiguity';

export const DEFAULT_PIPELINE_AMBIGUITY_CONFIG: PipelineAmbiguityConfig = {
  enabled: false,
  minConfidence: 0.35,
  maxConfidence: 0.85,
  maxCandidatesPerBatch: 8,
  maxInputCharacters: 8_000,
  timeoutMs: 30_000,
  maxOutputTokens: 256,
  promptVersion: 'p4-ambiguity-2',
};

interface ConfigStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

export function readPipelineAmbiguityConfig(store: ConfigStore): PipelineAmbiguityConfig {
  const value = store.get(storeKey);
  return normalizePipelineAmbiguityConfig(value);
}

export function savePipelineAmbiguityConfig(store: ConfigStore, patch: Partial<PipelineAmbiguityConfig>): PipelineAmbiguityConfig {
  const next = normalizePipelineAmbiguityConfig({
    ...readPipelineAmbiguityConfig(store),
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
  store.set(storeKey, next);
  return next;
}

export function normalizePipelineAmbiguityConfig(value: unknown): PipelineAmbiguityConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const minConfidence = clampNumber(record.minConfidence, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.minConfidence, 0, 1);
  const maxConfidence = clampNumber(record.maxConfidence, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxConfidence, minConfidence, 1);
  const configuredPromptVersion = typeof record.promptVersion === 'string' && record.promptVersion.trim()
    ? record.promptVersion.trim().slice(0, 80)
    : '';
  return {
    enabled: record.enabled === true,
    minConfidence,
    maxConfidence,
    maxCandidatesPerBatch: Math.round(clampNumber(record.maxCandidatesPerBatch, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxCandidatesPerBatch, 1, 50)),
    maxInputCharacters: Math.round(clampNumber(record.maxInputCharacters, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxInputCharacters, 1_000, 20_000)),
    timeoutMs: Math.round(clampNumber(record.timeoutMs, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.timeoutMs, 1_000, 120_000)),
    maxOutputTokens: Math.round(clampNumber(record.maxOutputTokens, DEFAULT_PIPELINE_AMBIGUITY_CONFIG.maxOutputTokens, 32, 2_000)),
    promptVersion: configuredPromptVersion === 'p4-ambiguity-1' || !configuredPromptVersion
      ? DEFAULT_PIPELINE_AMBIGUITY_CONFIG.promptVersion
      : configuredPromptVersion,
  };
}

export function ambiguityConfigHash(config: PipelineAmbiguityConfig, model: { provider: string; model: string; available: boolean; fingerprint?: string }): string {
  if (!config.enabled) return 'disabled';
  return crypto.createHash('sha256').update(JSON.stringify({ config, model })).digest('hex');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
