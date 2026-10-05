import {
  MEMORY_CONSTANTS,
  MEMORY_WRITE_MODES,
  type MemoryWriteMode,
} from './memoryConstants';
import type {
  AgentMemoryConfig,
  LongTermMemoryAvailability,
  PrincipalMemoryConfig,
  WorkspaceMemoryConfig,
} from './memoryTypes';

const workspaceDefaults = MEMORY_CONSTANTS.workspaceConfig;

export const DEFAULT_WORKSPACE_MEMORY_CONFIG: Readonly<WorkspaceMemoryConfig> = Object.freeze({
  enabled: workspaceDefaults.enabledByDefault,
  writeMode: workspaceDefaults.defaultWriteMode,
  extractModelId: workspaceDefaults.defaultExtractModelId,
  maxItems: workspaceDefaults.maxItems.default,
  extractDelaySeconds: workspaceDefaults.extractDelaySeconds.default,
  extractMinIntervalSeconds: workspaceDefaults.extractMinIntervalSeconds.default,
  extractInstructions: '',
  interestThreshold: workspaceDefaults.interestThreshold.default,
  retrievalConditioning: workspaceDefaults.retrievalConditioningByDefault,
  embeddingModelId: workspaceDefaults.defaultEmbeddingModelId,
  vectorRecall: workspaceDefaults.vectorRecallByDefault,
});

export const DEFAULT_PRINCIPAL_MEMORY_CONFIG: Readonly<PrincipalMemoryConfig> = Object.freeze({
  enabled: true,
});

export function normalizeWorkspaceMemoryConfig(
  value: unknown,
  base: WorkspaceMemoryConfig = { ...DEFAULT_WORKSPACE_MEMORY_CONFIG },
): WorkspaceMemoryConfig {
  const input = asRecord(value);
  return {
    enabled: normalizeBoolean(input.enabled, base.enabled),
    writeMode: normalizeWriteMode(input.writeMode, base.writeMode),
    extractModelId: normalizeOptionalId(input.extractModelId, base.extractModelId),
    maxItems: normalizeMaxItems(input.maxItems, base.maxItems),
    extractDelaySeconds: normalizeClampedInteger(
      input.extractDelaySeconds,
      base.extractDelaySeconds,
      workspaceDefaults.extractDelaySeconds.min,
      workspaceDefaults.extractDelaySeconds.max,
    ),
    extractMinIntervalSeconds: normalizeMinInterval(input.extractMinIntervalSeconds, base.extractMinIntervalSeconds),
    extractInstructions: truncateCodePoints(
      typeof input.extractInstructions === 'string' ? input.extractInstructions : base.extractInstructions,
      workspaceDefaults.extractInstructionsMaxCodePoints,
    ),
    interestThreshold: normalizeClampedInteger(
      input.interestThreshold,
      base.interestThreshold,
      workspaceDefaults.interestThreshold.min,
      workspaceDefaults.interestThreshold.max,
    ),
    retrievalConditioning: normalizeBoolean(input.retrievalConditioning, base.retrievalConditioning),
    embeddingModelId: normalizeOptionalId(input.embeddingModelId, base.embeddingModelId),
    vectorRecall: normalizeBoolean(input.vectorRecall, base.vectorRecall),
  };
}

export function resolveLongTermMemoryAvailability(
  workspace: WorkspaceMemoryConfig,
  principal: PrincipalMemoryConfig,
  agent: AgentMemoryConfig = {},
): LongTermMemoryAvailability {
  if (!workspace.enabled) return { enabled: false, reason: 'workspace-disabled' };
  if (!principal.enabled) return { enabled: false, reason: 'principal-disabled' };
  if (agent.memoryEnabled === false) return { enabled: false, reason: 'agent-disabled' };
  return { enabled: true };
}

/** L3 conversation memory remains available independently from the L4 switch. */
export function isConversationMemoryEnabled(): true {
  return true;
}

function normalizeMaxItems(value: unknown, fallback: number): number {
  const numeric = toFiniteInteger(value);
  if (numeric === undefined) return fallback;
  if (numeric <= 0) return workspaceDefaults.maxItems.default;
  return Math.min(numeric, workspaceDefaults.maxItems.serviceMax);
}

function normalizeMinInterval(value: unknown, fallback: number): number {
  const numeric = toFiniteInteger(value);
  if (numeric === undefined) return fallback;
  if (numeric <= 0) return workspaceDefaults.extractMinIntervalSeconds.default;
  return Math.min(numeric, workspaceDefaults.extractMinIntervalSeconds.max);
}

function normalizeClampedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = toFiniteInteger(value);
  if (numeric === undefined) return fallback;
  return Math.max(minimum, Math.min(numeric, maximum));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fallback;
}

function normalizeWriteMode(value: unknown, fallback: MemoryWriteMode): MemoryWriteMode {
  return typeof value === 'string' && (MEMORY_WRITE_MODES as readonly string[]).includes(value)
    ? value as MemoryWriteMode
    : fallback;
}

function normalizeOptionalId(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function toFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
