import { createHash } from 'node:crypto';
import { ASSISTANT_RELEASE_DEFAULTS } from '../../../shared/assistantReleaseDefaults';
import { estimateTokenCount } from '../tokenEstimator';
import type { ContextMemoryResult } from '../contextMemoryTypes';
import type { ContextMaterial } from '../contextRuntimeTypes';
import type { ReActChatMessage } from '../reactAgent/reactChatTransport';
import { MEMORY_ROUTES, type MemoryRoute } from './memoryLegacyContract';

export const MEMORY_PROJECTION_MODES = Object.freeze(['legacy', 'observe', 'canonical'] as const);
export type MemoryProjectionMode = (typeof MEMORY_PROJECTION_MODES)[number];
export type MemoryProjectionRouteMode = MemoryProjectionMode | 'inherit';

export interface MemoryProjectionSelection<T> {
  mode: MemoryProjectionMode;
  activeReader: 'legacy' | 'canonical';
  active: T;
  shadow?: T;
}

export interface MemoryProjectionReadDiagnostics {
  legacyReadMs: number;
  canonicalReadMs: number;
}

export interface MemoryCutoverObservationInput {
  route: MemoryRoute;
  mode: MemoryProjectionMode;
  sessionId: string;
  legacyContext?: ContextMemoryResult;
  canonicalContext: ContextMemoryResult;
  legacyHistory?: readonly ReActChatMessage[];
  canonicalHistory?: readonly ReActChatMessage[];
  recallItemIds?: readonly string[];
  readDiagnostics?: MemoryProjectionReadDiagnostics;
}

export interface MemoryCutoverObservation {
  id: string;
  route: MemoryRoute;
  mode: MemoryProjectionMode;
  activeReader: 'legacy' | 'canonical';
  sessionIdHash: string;
  completedTurnCount: { legacy: number; canonical: number };
  duplicateContentCount: { legacy: number; canonical: number; crossProjection: number };
  scopeLeakCount: { legacy: number; canonical: number };
  recalledItemIds: string[];
  prompt: {
    legacyRunes: number;
    legacyTokens: number;
    canonicalRunes: number;
    canonicalTokens: number;
  };
  toolAtomicityViolations: { legacy: number; canonical: number };
  readerLatencyMs: MemoryProjectionReadDiagnostics;
  doubleProjectionViolation: 0;
  recordedAt: string;
}

export interface MemoryCutoverReport {
  schemaVersion: 1;
  generatedAt: string;
  defaultMode: MemoryProjectionMode;
  routeOrder: readonly MemoryRoute[];
  observationCount: number;
  hardViolations: {
    scopeLeaks: number;
    duplicateCanonicalContent: number;
    orphanCanonicalToolResults: number;
    doubleProjection: number;
  };
  observations: MemoryCutoverObservation[];
}

const MAX_RETAINED_OBSERVATIONS = 200;
const observations: MemoryCutoverObservation[] = [];

export function normalizeMemoryProjectionMode(value: unknown, fallback: MemoryProjectionMode = ASSISTANT_RELEASE_DEFAULTS.assistantMemoryProjectionMode): MemoryProjectionMode {
  return typeof value === 'string' && MEMORY_PROJECTION_MODES.includes(value as MemoryProjectionMode)
    ? value as MemoryProjectionMode
    : fallback;
}

export function normalizeMemoryProjectionRouteMode(value: unknown): MemoryProjectionRouteMode {
  return value === 'inherit' || (typeof value === 'string' && MEMORY_PROJECTION_MODES.includes(value as MemoryProjectionMode))
    ? value as MemoryProjectionRouteMode
    : 'inherit';
}

export function selectMemoryProjection<T>(mode: MemoryProjectionMode, legacy: T, canonical: T): MemoryProjectionSelection<T> {
  // Observe follows the §14.3 gray-period contract: compare both readers while
  // only the legacy value is projected. Canonical cutover never merges them.
  return mode === 'canonical'
    ? { mode, activeReader: 'canonical', active: canonical, shadow: legacy }
    : { mode, activeReader: 'legacy', active: legacy, shadow: canonical };
}

export function isCanonicalMemoryProjection(mode: MemoryProjectionMode): boolean {
  return mode === 'canonical';
}

export function recordMemoryCutoverObservation(input: MemoryCutoverObservationInput): MemoryCutoverObservation {
  const legacyMaterials = input.legacyContext?.materials ?? [];
  const canonicalMaterials = input.canonicalContext.materials;
  const legacyHistory = input.legacyHistory ?? [];
  const canonicalHistory = input.canonicalHistory ?? [];
  const legacyText = projectionText(legacyMaterials, legacyHistory);
  const canonicalText = projectionText(canonicalMaterials, canonicalHistory);
  const observation: MemoryCutoverObservation = {
    id: `memory-cutover-${createHash('sha256').update(`${input.route}\u0000${input.sessionId}\u0000${Date.now()}\u0000${observations.length}`, 'utf8').digest('hex').slice(0, 24)}`,
    route: input.route,
    mode: input.mode,
    activeReader: input.mode === 'canonical' ? 'canonical' : 'legacy',
    sessionIdHash: createHash('sha256').update(input.sessionId, 'utf8').digest('hex').slice(0, 16),
    completedTurnCount: {
      legacy: countCompletedTurns(legacyMaterials, legacyHistory),
      canonical: countCompletedTurns(canonicalMaterials, canonicalHistory),
    },
    duplicateContentCount: {
      legacy: countDuplicateText(legacyMaterials, legacyHistory),
      canonical: countDuplicateText(canonicalMaterials, canonicalHistory),
      crossProjection: countCrossProjectionDuplicates(legacyMaterials, canonicalMaterials),
    },
    scopeLeakCount: {
      legacy: countScopeLeaks(legacyMaterials, input.sessionId),
      canonical: countScopeLeaks(canonicalMaterials, input.sessionId),
    },
    recalledItemIds: [...new Set(input.recallItemIds ?? [])].sort(),
    prompt: {
      legacyRunes: Array.from(legacyText).length,
      legacyTokens: estimateTokenCount(legacyText),
      canonicalRunes: Array.from(canonicalText).length,
      canonicalTokens: estimateTokenCount(canonicalText),
    },
    toolAtomicityViolations: {
      legacy: countToolAtomicityViolations(legacyHistory),
      canonical: countToolAtomicityViolations(canonicalHistory),
    },
    readerLatencyMs: {
      legacyReadMs: Math.max(0, Math.round(input.readDiagnostics?.legacyReadMs ?? 0)),
      canonicalReadMs: Math.max(0, Math.round(input.readDiagnostics?.canonicalReadMs ?? 0)),
    },
    doubleProjectionViolation: 0,
    recordedAt: new Date().toISOString(),
  };
  observations.push(observation);
  if (observations.length > MAX_RETAINED_OBSERVATIONS) observations.splice(0, observations.length - MAX_RETAINED_OBSERVATIONS);
  return observation;
}

export function getMemoryCutoverReport(): MemoryCutoverReport {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    defaultMode: ASSISTANT_RELEASE_DEFAULTS.assistantMemoryProjectionMode,
    routeOrder: MEMORY_ROUTES,
    observationCount: observations.length,
    hardViolations: {
      scopeLeaks: observations.reduce((sum, item) => sum + item.scopeLeakCount.canonical, 0),
      duplicateCanonicalContent: observations.reduce((sum, item) => sum + item.duplicateContentCount.canonical, 0),
      orphanCanonicalToolResults: observations.reduce((sum, item) => sum + item.toolAtomicityViolations.canonical, 0),
      doubleProjection: 0,
    },
    observations: observations.map((item) => ({ ...item, recalledItemIds: [...item.recalledItemIds] })),
  };
}

export function resetMemoryCutoverReportForTest(): void {
  observations.length = 0;
}

function projectionText(materials: readonly ContextMaterial[], history: readonly ReActChatMessage[]): string {
  return [
    ...materials.map((material) => material.content),
    ...history.map((message) => message.content),
  ].filter(Boolean).join('\n');
}

function countCompletedTurns(materials: readonly ContextMaterial[], history: readonly ReActChatMessage[]): number {
  const turnIds = new Set(materials.flatMap((material) => material.provenance?.turnSeqs ?? []).map(String));
  if (turnIds.size > 0) return turnIds.size;
  return history.filter((message) => message.role === 'user').length;
}

function countDuplicateText(materials: readonly ContextMaterial[], history: readonly ReActChatMessage[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const value of [...materials.map((material) => material.content), ...history.map((message) => message.content)]) {
    const normalized = normalizeComparableText(value);
    if (!normalized) continue;
    if (seen.has(normalized)) duplicates += 1;
    else seen.add(normalized);
  }
  return duplicates;
}

function countCrossProjectionDuplicates(legacy: readonly ContextMaterial[], canonical: readonly ContextMaterial[]): number {
  const legacyText = new Set(legacy.map((material) => normalizeComparableText(material.content)).filter(Boolean));
  return canonical.reduce((count, material) => count + (legacyText.has(normalizeComparableText(material.content)) ? 1 : 0), 0);
}

function countScopeLeaks(materials: readonly ContextMaterial[], sessionId: string): number {
  return materials.filter((material) => material.provenance?.sessionId && material.provenance.sessionId !== sessionId).length;
}

function countToolAtomicityViolations(history: readonly ReActChatMessage[]): number {
  const pending = new Set<string>();
  let violations = 0;
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) pending.add(call.id);
      continue;
    }
    if (message.role !== 'tool') continue;
    if (!message.toolCallId || !pending.delete(message.toolCallId)) violations += 1;
  }
  return violations + pending.size;
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}
