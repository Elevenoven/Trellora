import { resolveAssistantModelRuntimeProfile } from '../../shared/effectiveContextWindow';
import { assertContextEnvelopeInvariants } from './contextProjectionInvariants';
import {
  CONTEXT_RUNTIME_SCHEMA_VERSION,
  type AssistantModelRuntimeProfile,
  type ContextEnvelope,
  type ContextEnvelopeScope,
  type ContextMaterial,
  type ContextRoute,
} from './contextRuntimeTypes';
import type { PromptCallKind } from './currentNoteContextBudget';

const phaseOneInvariants = [
  'trust-channel-v1',
  'protected-material-v1',
  'stable-prefix-v1',
  'legacy-send-path-v1',
] as const;

export interface CreateContextEnvelopeInput {
  route: ContextRoute;
  callKind: PromptCallKind;
  scope: ContextEnvelopeScope;
  windowProfile: AssistantModelRuntimeProfile;
  materials: readonly ContextMaterial[];
  invariants?: readonly string[];
  stateVector?: ContextEnvelope['stateVector'];
}

export interface CreateLegacyRoleContextEnvelopeInput {
  route: ContextRoute;
  callKind: PromptCallKind;
  systemPrompt?: string;
  userPrompt: string;
  scope?: Partial<ContextEnvelopeScope>;
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number;
  windowProfile?: AssistantModelRuntimeProfile;
  stateVector?: ContextEnvelope['stateVector'];
}

export function createContextEnvelope(input: CreateContextEnvelopeInput): ContextEnvelope {
  const envelope: ContextEnvelope = {
    schemaVersion: CONTEXT_RUNTIME_SCHEMA_VERSION,
    route: input.route,
    callKind: input.callKind,
    scope: {
      workspaceId: input.scope.workspaceId,
      ...(input.scope.libraryId ? { libraryId: input.scope.libraryId } : {}),
      ...(input.scope.noteId ? { noteId: input.scope.noteId } : {}),
      ...(input.scope.sessionId ? { sessionId: input.scope.sessionId } : {}),
      ...(input.scope.turnId ? { turnId: input.scope.turnId } : {}),
    },
    windowProfile: {
      ...input.windowProfile,
      warnings: [...input.windowProfile.warnings],
    },
    materials: input.materials.map(copyContextMaterial),
    invariants: [...(input.invariants ?? phaseOneInvariants)],
    stateVector: { ...(input.stateVector ?? {}) },
  };
  assertContextEnvelopeInvariants(envelope);
  return envelope;
}

/**
 * Phase 1 wraps the already assembled role messages as opaque materials. This
 * preserves every byte on the active Provider path while the later memory
 * phases replace these legacy materials with finer-grained adapters.
 */
export function createLegacyRoleContextEnvelope(input: CreateLegacyRoleContextEnvelopeInput): ContextEnvelope {
  const materials: ContextMaterial[] = [];
  if (input.systemPrompt?.trim()) {
    materials.push({
      id: 'legacy-system-prompt',
      zone: 'stable-policy',
      channel: 'system',
      trust: 'trusted-policy',
      content: input.systemPrompt,
      priority: 100,
      protected: true,
      compressStrategy: 'none',
      source: { kind: 'legacy-role', id: `${input.route}:system`, version: 'legacy-role-v1' },
      stalePolicy: 'keep',
      overflowPolicy: 'fail',
      cache: { stability: 'stable', prefixEligible: true },
    });
  }
  materials.push({
    id: 'legacy-user-prompt',
    zone: 'current-request',
    channel: 'user',
    trust: input.route === 'knowledge-base' ? 'untrusted-evidence' : 'untrusted-memory',
    content: input.userPrompt,
    priority: 100,
    protected: true,
    compressStrategy: 'none',
    source: { kind: 'legacy-role', id: `${input.route}:user`, version: 'legacy-role-v1' },
    stalePolicy: 'keep',
    overflowPolicy: 'fail',
    cache: { stability: 'turn', prefixEligible: false },
  });
  return createContextEnvelope({
    route: input.route,
    callKind: input.callKind,
    scope: {
      workspaceId: input.scope?.workspaceId?.trim() || 'legacy-assistant-runtime',
      ...(input.scope?.libraryId ? { libraryId: input.scope.libraryId } : {}),
      ...(input.scope?.noteId ? { noteId: input.scope.noteId } : {}),
      ...(input.scope?.sessionId ? { sessionId: input.scope.sessionId } : {}),
      ...(input.scope?.turnId ? { turnId: input.scope.turnId } : {}),
    },
    windowProfile: input.windowProfile ?? createPhaseOneObservationRuntimeProfile({
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindowTokens: input.contextWindowTokens,
    }),
    materials,
    stateVector: input.stateVector,
  });
}

export function createPhaseOneObservationRuntimeProfile(input: {
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number;
}): AssistantModelRuntimeProfile {
  return resolveAssistantModelRuntimeProfile({
    providerId: input.providerId?.trim() || 'unknown-provider',
    modelId: input.modelId?.trim() || 'unknown-model',
    knownModelWindow: input.contextWindowTokens,
  });
}

function copyContextMaterial(material: ContextMaterial): ContextMaterial {
  return {
    ...material,
    source: { ...material.source },
    ...(material.tokenBudget ? { tokenBudget: { ...material.tokenBudget } } : {}),
    ...(material.provenance ? {
      provenance: {
        ...material.provenance,
        ...(material.provenance.turnSeqs ? { turnSeqs: [...material.provenance.turnSeqs] } : {}),
        ...(material.provenance.sourceIds ? { sourceIds: [...material.provenance.sourceIds] } : {}),
        ...(material.provenance.goalIds ? { goalIds: [...material.provenance.goalIds] } : {}),
        ...(material.provenance.requirementIds ? { requirementIds: [...material.provenance.requirementIds] } : {}),
        ...(material.provenance.evidenceIds ? { evidenceIds: [...material.provenance.evidenceIds] } : {}),
      },
    } : {}),
    cache: { ...material.cache },
  } as ContextMaterial;
}
