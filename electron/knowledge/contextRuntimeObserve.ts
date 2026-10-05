import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ContextArtifactStore } from './contextArtifactStore';
import { ContextPressureCircuitBreaker } from './contextPressureCircuitBreaker';
import { ContextPressureController } from './contextPressureController';
import { collectContextProjectionInvariantViolations } from './contextProjectionInvariants';
import { createContextProjectionDiagnostics } from './contextProjectionDiagnostics';
import { LazyContextLoader } from './lazyContextLoader';
import type { QaResidualMemoryObservationInput } from './qaMemoryTypes';
import { observeQaResidualMemory } from './qaResidualMemoryObserve';
import { applyDynamicMemoryS0ProviderUsage } from './dynamicMemoryS0Observe';
import {
  CONTEXT_REQUEST_ENVELOPE_VERSION,
  normalizeAssistantContextRuntimeMode,
  type AssistantContextRuntimeMode,
  type ContextChannel,
  type ContextEnvelope,
  type ContextAdmissionDiagnostics,
  type ContextPressureEpisodeDiagnostics,
  type ContextProjection,
  type QaResidualMemoryEnforcementDiagnostics,
  type ContextRuntimeObservationReport,
  type ContextRuntimeObservationResult,
  type ContextRuntimePromptDigest,
} from './contextRuntimeTypes';
import { estimateTokenCount } from './tokenEstimator';
import type { AssistantTokenUsage } from './tokenEstimator';

const maxRecordedObservations = 100;
const observationBuffer: ContextRuntimeObservationReport[] = [];
const sharedPressureCircuitBreaker = new ContextPressureCircuitBreaker();

export interface ObserveContextRuntimeInput {
  mode?: AssistantContextRuntimeMode;
  envelope: ContextEnvelope;
  sendPath?: ContextRuntimeObservationReport['sendPath'];
  legacy: {
    combinedPrompt: string;
    systemPrompt?: string;
    userPrompt: string;
  };
  qaResidualMemory?: QaResidualMemoryObservationInput;
  calibrationMultiplier?: number;
  activeToolPhases?: readonly string[];
  selectedSkillIds?: readonly string[];
  requestedAttachmentIds?: readonly string[];
  artifactStore?: ContextArtifactStore;
  pressureCircuitBreaker?: ContextPressureCircuitBreaker;
  materialFingerprint?: string;
  preparedProjection?: ContextProjection;
  preparedAdmission?: ContextAdmissionDiagnostics;
  preparedPressureEpisode?: ContextPressureEpisodeDiagnostics;
  qaResidualMemoryEnforcement?: QaResidualMemoryEnforcementDiagnostics;
  modelCallsAdded?: number;
  memoryWritesAdded?: number;
}

export interface ProjectContextRuntimeEnvelopeInput {
  envelope: ContextEnvelope;
  calibrationMultiplier?: number;
  activeToolPhases?: readonly string[];
  selectedSkillIds?: readonly string[];
  requestedAttachmentIds?: readonly string[];
  artifactStore?: ContextArtifactStore;
  pressureCircuitBreaker?: ContextPressureCircuitBreaker;
  materialFingerprint?: string;
}

export interface ProjectContextRuntimeEnvelopeResult {
  envelope: ContextEnvelope;
  projection: ContextProjection;
  admission: ContextAdmissionDiagnostics;
  pressureEpisode: ContextPressureEpisodeDiagnostics;
}

/** Shared Pass-A admission plus P1/P2 projection. It never mutates conversation materials. */
export function projectContextRuntimeEnvelope(input: ProjectContextRuntimeEnvelopeInput): ProjectContextRuntimeEnvelopeResult {
  const admission = new LazyContextLoader().admit(input.envelope, {
    activePhases: input.activeToolPhases,
    selectedSkillIds: input.selectedSkillIds,
    requestedAttachmentIds: input.requestedAttachmentIds,
  });
  const artifactStore = input.artifactStore ?? createDefaultArtifactStore(admission.envelope);
  const relieved = new ContextPressureController({
    ...(artifactStore ? { artifactStore } : {}),
    canReadSource: (material) => Boolean(material.lifecycle?.rereadable || material.source.contentHash),
  }).relieveNonConversation({
    envelope: admission.envelope,
    calibrationMultiplier: input.calibrationMultiplier,
    circuitBreaker: input.pressureCircuitBreaker ?? sharedPressureCircuitBreaker,
    materialFingerprint: input.materialFingerprint,
  });
  return {
    envelope: relieved.envelope,
    projection: {
      ...relieved.projection,
      omitted: [...admission.omissions, ...relieved.projection.omitted],
      stats: {
        ...relieved.projection.stats,
        candidateMaterials: input.envelope.materials.length,
        omittedMaterials: admission.omissions.length + relieved.projection.omitted.length,
      },
    },
    admission: admission.diagnostics,
    pressureEpisode: relieved.diagnostics,
  };
}

/**
 * Builds a local shadow projection and records only hashes, counts and
 * invariant differences. It never calls a Provider or a memory repository.
 */
export function observeContextRuntime(input: ObserveContextRuntimeInput): ContextRuntimeObservationResult | undefined {
  const mode = normalizeAssistantContextRuntimeMode(input.mode);
  if (mode === 'off') return undefined;
  const legacy = createPromptDigest(
    input.legacy.systemPrompt ?? '',
    input.legacy.userPrompt,
    input.legacy.combinedPrompt,
  );
  let projection: ContextProjection | undefined;
  let pressureEnvelope = input.envelope;
  let invariantViolations: string[] = [];
  let admission: ReturnType<LazyContextLoader['admit']> | undefined;
  let pressureEpisode: ContextRuntimeObservationReport['diagnostics']['pressureEpisode'];
  try {
    if (input.preparedProjection) {
      projection = input.preparedProjection;
      admission = input.preparedAdmission ? { envelope: input.envelope, omissions: [], diagnostics: input.preparedAdmission } : undefined;
      pressureEpisode = input.preparedPressureEpisode;
    } else {
      const prepared = projectContextRuntimeEnvelope(input);
      pressureEnvelope = prepared.envelope;
      pressureEpisode = prepared.pressureEpisode;
      admission = { envelope: prepared.envelope, omissions: [], diagnostics: prepared.admission };
      projection = prepared.projection;
    }
    invariantViolations = collectContextProjectionInvariantViolations(input.envelope, projection);
  } catch (error) {
    invariantViolations = [error instanceof Error ? error.message : String(error)];
  }
  const projectionDigest = projection
    ? createPromptDigest(
      projection.systemPrompt,
      projection.userPrompt,
      combineRolePrompts(projection.systemPrompt, projection.userPrompt),
      projection.toolMessages?.length ? ['system', 'user', 'tool'] : undefined,
    )
    : undefined;
  const diagnostics = createContextProjectionDiagnostics({
    envelope: input.envelope,
    ...(projection ? { projection } : {}),
    mode,
    sendPath: input.sendPath ?? 'legacy-phase-1',
    invariantViolations,
  });
  if (admission) diagnostics.admission = admission.diagnostics;
  if (pressureEpisode) diagnostics.pressureEpisode = pressureEpisode;
  if (input.qaResidualMemory) {
    diagnostics.residualMemory = observeQaResidualMemory({
      envelope: pressureEnvelope,
      memory: input.qaResidualMemory,
      calibrationMultiplier: input.calibrationMultiplier,
    });
  }
  if (input.qaResidualMemoryEnforcement) diagnostics.residualMemoryEnforcement = input.qaResidualMemoryEnforcement;
  const report: ContextRuntimeObservationReport = {
    schemaVersion: 1,
    mode,
    route: input.envelope.route,
    callKind: input.envelope.callKind,
    requestEnvelopeVersion: projection?.requestEnvelopeVersion ?? CONTEXT_REQUEST_ENVELOPE_VERSION,
    legacy,
    ...(projectionDigest ? { projection: projectionDigest } : {}),
    differences: {
      systemPromptEqual: Boolean(projection && projection.systemPrompt === (input.legacy.systemPrompt ?? '')),
      userPromptEqual: Boolean(projection && projection.userPrompt === input.legacy.userPrompt),
      roleStructureEqual: Boolean(projectionDigest && equalRoles(legacy.roleStructure, projectionDigest.roleStructure)),
      ...(projection ? { serializedTokenDelta: projection.stats.serializedTokens - estimateTokenCount(input.legacy.combinedPrompt) } : {}),
    },
    invariantViolations,
    ...(projection ? { stablePrefixFingerprint: projection.stablePrefixFingerprint } : {}),
    candidateMaterials: input.envelope.materials.length,
    includedMaterials: projection?.included.length ?? 0,
    modelCallsAdded: input.modelCallsAdded ?? 0,
    memoryWritesAdded: input.memoryWritesAdded ?? 0,
    turnStateMutations: 0,
    sendPath: input.sendPath ?? 'legacy-phase-1',
    diagnostics,
  };
  recordContextRuntimeObservation(report);
  return { report, ...(projection ? { projection } : {}) };
}

/** Adds Provider usage/error metrics to an existing report without changing the send path. */
export function observeContextRuntimeProviderUsage(input: {
  report: ContextRuntimeObservationReport;
  responseCompleted: boolean;
  usage?: AssistantTokenUsage;
  localRawInputTokens: number;
  localCalibratedInputTokens: number;
  calibrationMultiplierUsed: number;
}): void {
  const providerInputTokens = input.usage?.inputTokens;
  const reported = providerInputTokens !== undefined;
  const rawError = reported ? input.localRawInputTokens - providerInputTokens : undefined;
  const calibratedError = reported ? input.localCalibratedInputTokens - providerInputTokens : undefined;
  input.report.diagnostics.providerUsage = {
    responseCompleted: input.responseCompleted,
    reported,
    localRawInputTokens: input.localRawInputTokens,
    localCalibratedInputTokens: input.localCalibratedInputTokens,
    calibrationMultiplierUsed: input.calibrationMultiplierUsed,
    ...(providerInputTokens !== undefined ? { providerInputTokens } : {}),
    ...(input.usage?.outputTokens !== undefined ? { providerOutputTokens: input.usage.outputTokens } : {}),
    ...(input.usage?.totalTokens !== undefined ? { providerTotalTokens: input.usage.totalTokens } : {}),
    ...(input.usage?.cachedInputTokens !== undefined ? { providerCachedInputTokens: input.usage.cachedInputTokens } : {}),
    ...(rawError !== undefined ? {
      rawEstimateSignedErrorTokens: rawError,
      rawEstimateAbsoluteErrorTokens: Math.abs(rawError),
      ...(providerInputTokens && providerInputTokens > 0 ? { rawEstimateRelativeError: Math.abs(rawError) / providerInputTokens } : {}),
    } : {}),
    ...(calibratedError !== undefined ? {
      calibratedEstimateSignedErrorTokens: calibratedError,
      calibratedEstimateAbsoluteErrorTokens: Math.abs(calibratedError),
      ...(providerInputTokens && providerInputTokens > 0 ? { calibratedEstimateRelativeError: Math.abs(calibratedError) / providerInputTokens } : {}),
    } : {}),
  };
  if (input.report.diagnostics.dynamicMemoryS0) {
    applyDynamicMemoryS0ProviderUsage(
      input.report.diagnostics.dynamicMemoryS0,
      input.usage,
      input.responseCompleted,
    );
  }
  replaceRecordedObservation(input.report);
}

export function getContextRuntimeObservations(): ContextRuntimeObservationReport[] {
  return observationBuffer.map(copyReport);
}

export function clearContextRuntimeObservations(): void {
  observationBuffer.length = 0;
}

export function getContextProjectionDiagnostics(turnId?: string) {
  const normalizedTurnId = turnId?.trim();
  const reports = normalizedTurnId
    ? observationBuffer.filter((report) => report.diagnostics.turnId === normalizedTurnId)
    : observationBuffer;
  return reports.at(-1)?.diagnostics ? copyDiagnostics(reports.at(-1)!.diagnostics) : null;
}

function recordContextRuntimeObservation(report: ContextRuntimeObservationReport): void {
  observationBuffer.push(copyReport(report));
  if (observationBuffer.length > maxRecordedObservations) observationBuffer.splice(0, observationBuffer.length - maxRecordedObservations);
}

function replaceRecordedObservation(report: ContextRuntimeObservationReport): void {
  for (let index = observationBuffer.length - 1; index >= 0; index -= 1) {
    const current = observationBuffer[index];
    if (current.diagnostics.recordedAt === report.diagnostics.recordedAt
      && current.route === report.route
      && current.callKind === report.callKind
      && current.diagnostics.turnId === report.diagnostics.turnId) {
      observationBuffer[index] = copyReport(report);
      return;
    }
  }
  recordContextRuntimeObservation(report);
}

function createPromptDigest(
  systemPrompt: string,
  userPrompt: string,
  combinedPrompt: string,
  forcedRoles?: ContextChannel[],
): ContextRuntimePromptDigest {
  return {
    roleStructure: forcedRoles ?? [
      ...(systemPrompt ? ['system' as const] : []),
      ...(userPrompt ? ['user' as const] : []),
    ],
    system: createRoleDigest(systemPrompt),
    user: createRoleDigest(userPrompt),
    combined: createRoleDigest(combinedPrompt),
  };
}

function createRoleDigest(value: string) {
  return {
    chars: value.length,
    estimatedTokens: estimateTokenCount(value),
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
  };
}

function combineRolePrompts(systemPrompt: string, userPrompt: string): string {
  return [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
}

function equalRoles(first: readonly ContextChannel[], second: readonly ContextChannel[]): boolean {
  return first.length === second.length && first.every((role, index) => role === second[index]);
}

function copyReport(report: ContextRuntimeObservationReport): ContextRuntimeObservationReport {
  return {
    ...report,
    legacy: {
      ...report.legacy,
      roleStructure: [...report.legacy.roleStructure],
      system: { ...report.legacy.system },
      user: { ...report.legacy.user },
      combined: { ...report.legacy.combined },
    },
    ...(report.projection ? {
      projection: {
        ...report.projection,
        roleStructure: [...report.projection.roleStructure],
        system: { ...report.projection.system },
        user: { ...report.projection.user },
        combined: { ...report.projection.combined },
      },
    } : {}),
    differences: { ...report.differences },
    invariantViolations: [...report.invariantViolations],
    diagnostics: copyDiagnostics(report.diagnostics),
  };
}

function copyDiagnostics(diagnostics: ContextRuntimeObservationReport['diagnostics']): ContextRuntimeObservationReport['diagnostics'] {
  return {
    ...diagnostics,
    window: { ...diagnostics.window },
    tokens: { ...diagnostics.tokens },
    zones: diagnostics.zones.map((zone) => ({
      ...zone,
      channels: [...zone.channels],
      trusts: [...zone.trusts],
      compressionActions: [...zone.compressionActions],
    })),
    omissions: diagnostics.omissions.map((omission) => ({ ...omission })),
    stablePrefix: { ...diagnostics.stablePrefix },
    ...(diagnostics.residualMemory ? {
      residualMemory: {
        ...diagnostics.residualMemory,
        legacy: {
          M1: { ...diagnostics.residualMemory.legacy.M1 },
          M2: { ...diagnostics.residualMemory.legacy.M2 },
        },
        budget: { ...diagnostics.residualMemory.budget },
        wouldOptimize: {
          ...diagnostics.residualMemory.wouldOptimize,
          actions: [...diagnostics.residualMemory.wouldOptimize.actions],
        },
        wouldInclude: { ...diagnostics.residualMemory.wouldInclude },
        wouldCompact: { ...diagnostics.residualMemory.wouldCompact },
      },
    } : {}),
    ...(diagnostics.residualMemoryEnforcement ? {
      residualMemoryEnforcement: {
        ...diagnostics.residualMemoryEnforcement,
        budget: { ...diagnostics.residualMemoryEnforcement.budget },
        conversation: { ...diagnostics.residualMemoryEnforcement.conversation },
        compaction: { ...diagnostics.residualMemoryEnforcement.compaction },
      },
    } : {}),
    ...(diagnostics.providerUsage ? { providerUsage: { ...diagnostics.providerUsage } } : {}),
    ...(diagnostics.dynamicMemoryS0 ? {
      dynamicMemoryS0: {
        ...diagnostics.dynamicMemoryS0,
        budget: { ...diagnostics.dynamicMemoryS0.budget },
        partitions: { ...diagnostics.dynamicMemoryS0.partitions },
        providerPayload: { ...diagnostics.dynamicMemoryS0.providerPayload },
        coverage: {
          ...diagnostics.dynamicMemoryS0.coverage,
          summaryRanges: diagnostics.dynamicMemoryS0.coverage.summaryRanges.map((range) => ({ ...range })),
          hotTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.hotTurnSeqs],
          uncoveredTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.uncoveredTurnSeqs],
          multiplyCoveredTurnSeqs: [...diagnostics.dynamicMemoryS0.coverage.multiplyCoveredTurnSeqs],
          currentProjection: { ...diagnostics.dynamicMemoryS0.coverage.currentProjection },
          risks: [...diagnostics.dynamicMemoryS0.coverage.risks],
        },
        wiring: {
          ...diagnostics.dynamicMemoryS0.wiring,
          contextEnvelope: { ...diagnostics.dynamicMemoryS0.wiring.contextEnvelope },
          residualEnforcer: { ...diagnostics.dynamicMemoryS0.wiring.residualEnforcer },
          pressureController: { ...diagnostics.dynamicMemoryS0.wiring.pressureController },
          databases: { ...diagnostics.dynamicMemoryS0.wiring.databases },
        },
        sideEffects: { ...diagnostics.dynamicMemoryS0.sideEffects },
      },
    } : {}),
    ...(diagnostics.admission ? {
      admission: {
        ...diagnostics.admission,
        activationReasons: [...diagnostics.admission.activationReasons],
      },
    } : {}),
    ...(diagnostics.pressureEpisode ? {
      pressureEpisode: {
        ...diagnostics.pressureEpisode,
        actions: diagnostics.pressureEpisode.actions.map((action) => ({
          ...action,
          materialIds: [...action.materialIds],
        })),
        skippedZeroGainActions: [...diagnostics.pressureEpisode.skippedZeroGainActions],
      },
    } : {}),
    invariantViolations: [...diagnostics.invariantViolations],
  };
}

function createDefaultArtifactStore(envelope: ContextEnvelope): ContextArtifactStore | undefined {
  const workspacePath = envelope.scope.workspaceId;
  try {
    if (!path.isAbsolute(workspacePath) || !fs.statSync(workspacePath).isDirectory()) return undefined;
    return new ContextArtifactStore(workspacePath);
  } catch {
    return undefined;
  }
}
