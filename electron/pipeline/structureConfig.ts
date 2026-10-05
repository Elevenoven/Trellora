import type { PipelineStructureConfig } from './types';

const storeKey = 'pipelineStructure';

export const DEFAULT_PIPELINE_STRUCTURE_CONFIG: PipelineStructureConfig = {
  strategy: 'heading',
  targetChars: 800,
  overlapChars: 120,
  minChars: 160,
  maxChars: 1800,
};

export interface ConfigStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

export function readPipelineStructureConfig(store: ConfigStore): PipelineStructureConfig {
  return normalizePipelineStructureConfig(store.get(storeKey));
}

export function savePipelineStructureConfig(store: ConfigStore, patch: Partial<PipelineStructureConfig>): PipelineStructureConfig {
  const next = normalizePipelineStructureConfig({ ...readPipelineStructureConfig(store), ...patch });
  store.set(storeKey, next);
  return next;
}

export function normalizePipelineStructureConfig(value: unknown): PipelineStructureConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targetChars = clampInt(record.targetChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.targetChars, 200, 4000);
  const maxChars = clampInt(record.maxChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.maxChars, targetChars, 8000);
  return {
    strategy: record.strategy === 'fixed' ? 'fixed' : DEFAULT_PIPELINE_STRUCTURE_CONFIG.strategy,
    targetChars,
    overlapChars: clampInt(record.overlapChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.overlapChars, 0, Math.max(0, maxChars - 1)),
    minChars: clampInt(record.minChars, DEFAULT_PIPELINE_STRUCTURE_CONFIG.minChars, 0, targetChars),
    maxChars,
  };
}

export function structureConfigHash(config: PipelineStructureConfig): string {
  const normalized = normalizePipelineStructureConfig(config);
  return `p5-${JSON.stringify(normalized)}`;
}

function clampInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
