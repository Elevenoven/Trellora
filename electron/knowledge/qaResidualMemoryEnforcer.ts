import { randomUUID } from 'node:crypto';
import { generateAiJson, type AiJsonGenerationOptions } from './aiProvider';
import { resolveAiModelDescriptor } from './aiModelCapabilities';
import type { AiProviderConfig } from './aiTypes';
import { ContextPressureCircuitBreaker, createContextMaterialFingerprint } from './contextPressureCircuitBreaker';
import { renderContextEnvelope } from './contextRenderer';
import { projectContextRuntimeEnvelope } from './contextRuntimeObserve';
import type {
  ContextAdmissionDiagnostics,
  ContextEnvelope,
  ContextMaterial,
  ContextPressureEpisodeDiagnostics,
  ContextProjection,
  QaResidualMemoryEnforcementDiagnostics,
  QaResidualPressureLevel,
} from './contextRuntimeTypes';
import { MaintenanceModelCallCoordinator } from './modelCallCoordinator';
import {
  QA_CHECKPOINT_COMPRESSION_JSON_SCHEMA,
  buildQaCheckpointCompressionPrompt,
  buildQaFallbackCheckpointCandidate,
  calculateQaCheckpointSourceHash,
  calculateQaCheckpointSourceTokens,
  calculateQaCheckpointTargets,
  createQaConversationCheckpointCandidate,
  renderQaCheckpointSourceTurn,
} from './qaConversationCheckpoint';
import type { QaMemoryRepository } from './qaMemoryRepository';
import type {
  QaConversationCheckpoint,
  QaConversationCheckpointCandidate,
  QaStoredTurn,
} from './qaMemoryTypes';
import {
  calculateQaRawConversationTokens,
  calculateResidualConversationBudget,
  selectOldestQaConversationPrefix,
} from './residualConversationBudget';

const conversationZones = new Set(['conversation-summary', 'conversation-hot', 'conversation-recall']);
const SEMANTIC_COMPACT_AT = 0.95;
const REENTRY_TARGET = 0.92;
const HARD_REJECT_AT = 1;
const MAX_COMPACTION_ATTEMPTS = 3;
const MAX_CHECKPOINT_OUTPUT_TOKENS = 8_192;

type GenerateCheckpointJson = (input: AiJsonGenerationOptions) => Promise<unknown>;

export interface QaResidualMemoryEnforcerOptions {
  maintenanceCoordinator?: MaintenanceModelCallCoordinator;
  generateJson?: GenerateCheckpointJson;
  pressureCircuitBreaker?: ContextPressureCircuitBreaker;
}

export interface QaResidualMemoryEnforcementInput {
  sessionId: string;
  envelope: ContextEnvelope;
  model: string;
  providerConfig: AiProviderConfig;
  calibrationMultiplier?: number;
  signal?: AbortSignal;
}

export interface QaResidualMemoryEnforcementResult {
  /** Candidate envelope for renderer-safe diagnostics; the projection is the only send authority. */
  envelope: ContextEnvelope;
  projection: ContextProjection;
  admission: ContextAdmissionDiagnostics;
  pressureEpisode: ContextPressureEpisodeDiagnostics;
  diagnostics: QaResidualMemoryEnforcementDiagnostics;
  sendAllowed: boolean;
  errorCode?: 'QA_CHECKPOINT_COMPACTION_FAILED' | 'CONTEXT_PRESSURE_THRASHING';
}

interface ProjectionState {
  sendEnvelope: ContextEnvelope;
  diagnosticEnvelope: ContextEnvelope;
  projection: ContextProjection;
  checkpoint?: QaConversationCheckpoint;
  rawTail: QaStoredTurn[];
  pressureEpisode: ContextPressureEpisodeDiagnostics;
  admission: ContextAdmissionDiagnostics;
  measurement: WindowMeasurement;
}

interface WindowMeasurement {
  rawPromptTokens: number;
  predictedPromptTokens: number;
  UWindow: number;
  pressureLevel: QaResidualPressureLevel;
}

interface CompactionCounters {
  attempts: number;
  llmAttempts: number;
  modelCalls: number;
  memoryWrites: number;
  casConflicts: number;
  fallbackUsed: boolean;
  releasedTokens: number;
  compactedFromSeq?: number;
  compactedThroughSeq?: number;
  sourceTokens?: number;
  outputTokens?: number;
  compressionRatio?: number;
  errorCode?: string;
}

/** Phase 3/4 residual projector shared by direct chat and dedicated knowledge-base QA. */
export class QaResidualMemoryEnforcer {
  private readonly maintenanceCoordinator: MaintenanceModelCallCoordinator;
  private readonly generateJson: GenerateCheckpointJson;
  private readonly pressureCircuitBreaker: ContextPressureCircuitBreaker;
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: QaMemoryRepository,
    options: QaResidualMemoryEnforcerOptions = {},
  ) {
    this.maintenanceCoordinator = options.maintenanceCoordinator ?? new MaintenanceModelCallCoordinator({
      maxConcurrent: 1,
      maxModelCallsPerJob: 1,
      maxWallTimeMs: 45_000,
    });
    this.generateJson = options.generateJson ?? generateAiJson;
    this.pressureCircuitBreaker = options.pressureCircuitBreaker ?? new ContextPressureCircuitBreaker();
  }

  enforce(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    const prior = this.sessionQueues.get(input.sessionId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.run(input));
    const tail = run.then(() => undefined, () => undefined);
    this.sessionQueues.set(input.sessionId, tail);
    void tail.finally(() => {
      if (this.sessionQueues.get(input.sessionId) === tail) this.sessionQueues.delete(input.sessionId);
    });
    return run;
  }

  cancelSession(sessionId: string): void {
    this.maintenanceCoordinator.cancelSession(sessionId);
  }

  abortAll(): void {
    this.maintenanceCoordinator.abortAll();
  }

  private async run(input: QaResidualMemoryEnforcementInput): Promise<QaResidualMemoryEnforcementResult> {
    throwIfAborted(input.signal);
    if (input.envelope.route !== 'chat' && input.envelope.route !== 'knowledge-base') {
      throw new Error('QA 剩余窗口只允许接管 chat 或 knowledge-base Route。');
    }
    const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
    const initialCheckpoint = this.repository.getConversationCheckpoint(input.sessionId);
    const initialRawTail = this.repository.loadMemorableTurnsAfter(
      input.sessionId,
      initialCheckpoint?.coveredThroughSeq ?? 0,
    );
    const initialCandidate = replaceConversation(input.envelope, initialCheckpoint, initialRawTail);
    const pressureFingerprint = createContextMaterialFingerprint({
      ...initialCandidate,
      materials: initialCandidate.materials.filter((material) => material.zone !== 'current-request'),
    });
    const passA = projectContextRuntimeEnvelope({
      envelope: initialCandidate,
      calibrationMultiplier,
      pressureCircuitBreaker: this.pressureCircuitBreaker,
      materialFingerprint: pressureFingerprint,
    });
    const optimizedNonConversation = passA.envelope.materials.filter((material) => !isConversationMaterial(material));
    const originalNonConversation = initialCandidate.materials.filter((material) => !isConversationMaterial(material));
    let state = buildProjectionState({
      baseEnvelope: input.envelope,
      originalNonConversation,
      optimizedNonConversation,
      checkpoint: initialCheckpoint,
      rawTail: initialRawTail,
      admission: passA.admission,
      pressureEpisode: passA.pressureEpisode,
      pressureOmissions: passA.projection.omitted.filter((omission) => !initialCandidate.materials
        .find((material) => material.id === omission.materialId && isConversationMaterial(material))),
      calibrationMultiplier,
    });
    const initialPressureLevel = resolvePressureLevel(passA.pressureEpisode.initialUWindow);
    const counters: CompactionCounters = {
      attempts: 0,
      llmAttempts: 0,
      modelCalls: 0,
      memoryWrites: 0,
      casConflicts: 0,
      fallbackUsed: false,
      releasedTokens: 0,
    };

    if (state.measurement.UWindow < SEMANTIC_COMPACT_AT) {
      return finishResult({
        state,
        initialPressureLevel,
        counters,
        calibrationMultiplier,
        resultState: passA.pressureEpisode.actions.some((action) => action.releasedTokens > 0) ? 'optimized' : 'stable',
      });
    }

    const episode = this.pressureCircuitBreaker.begin({ envelope: initialCandidate, fingerprint: pressureFingerprint });
    let minimumPrefixTurns = 1;
    let strictJsonRetry = false;
    let compactionFailure = false;
    while (counters.attempts < MAX_COMPACTION_ATTEMPTS && state.measurement.UWindow >= SEMANTIC_COMPACT_AT) {
      throwIfAborted(input.signal);
      const checkpoint = this.repository.getConversationCheckpoint(input.sessionId);
      const rawTail = this.repository.loadMemorableTurnsAfter(input.sessionId, checkpoint?.coveredThroughSeq ?? 0);
      state = buildProjectionState({
        baseEnvelope: input.envelope,
        originalNonConversation,
        optimizedNonConversation,
        checkpoint,
        rawTail,
        admission: passA.admission,
        pressureEpisode: state.pressureEpisode,
        pressureOmissions: state.projection.omitted,
        calibrationMultiplier,
      });
      if (state.measurement.UWindow < SEMANTIC_COMPACT_AT) break;

      const pool = calculateConversationPool(state, optimizedNonConversation, calibrationMultiplier);
      const rawTargetConversationPool = Math.max(0, Math.floor(pool.targetConversationPool / calibrationMultiplier));
      const rawCheckpointTokens = checkpoint?.summaryTokens ?? 0;
      const originalShortTermCapacity = Math.max(0, rawTargetConversationPool - rawCheckpointTokens);
      if (!rawTail.length || originalShortTermCapacity <= 0) break;
      const selection = selectPrefixForAttempt({
        rawTail,
        coveredThroughSeq: checkpoint?.coveredThroughSeq ?? 0,
        previousCheckpointTokens: rawCheckpointTokens,
        originalShortTermCapacity,
        targetConversationPoolTokens: rawTargetConversationPool,
        minimumPrefixTurns,
      });
      if (!selection.length) break;
      minimumPrefixTurns = selection.length;
      const sourceInput = {
        sessionId: input.sessionId,
        ...(checkpoint ? { previousCheckpoint: checkpoint } : {}),
        selectedTurns: selection,
        originalShortTermCapacity,
        modelProfile: `${resolveProviderId(input.providerConfig)}:${input.model}`,
      };
      const sourceTokens = calculateQaCheckpointSourceTokens(sourceInput);
      const targets = calculateQaCheckpointTargets(originalShortTermCapacity, sourceTokens);
      const sourceHash = calculateQaCheckpointSourceHash(sourceInput);
      const runId = `qa-checkpoint-${randomUUID()}`;
      this.repository.createCompactionRun({
        runId,
        sessionId: input.sessionId,
        baseCheckpointVersion: checkpoint?.checkpointVersion ?? 0,
        sourceFromSeq: selection[0].turnSeq,
        sourceToSeq: selection.at(-1)!.turnSeq,
        sourceHash,
        sourceTokens,
        targetTokens: targets.summaryTargetTokens,
      });
      counters.attempts += 1;

      let candidate: QaConversationCheckpointCandidate;
      try {
        const useFallback = counters.llmAttempts >= 2;
        if (useFallback) {
          counters.fallbackUsed = true;
          candidate = buildQaFallbackCheckpointCandidate(sourceInput);
        } else {
          const prompt = [
            buildQaCheckpointCompressionPrompt(sourceInput),
            ...(strictJsonRetry ? ['[严格修复] 上一次输出未通过契约。本次只返回符合 Schema、双 20% 与保留契约的 JSON。'] : []),
          ].join('\n\n');
          counters.llmAttempts += 1;
          const value = await this.runCheckpointModel({
            input,
            prompt,
            runId,
            requestedMaxOutputTokens: Math.max(1, Math.min(MAX_CHECKPOINT_OUTPUT_TOKENS, targets.summaryHardMaxTokens)),
            onProviderCall: () => { counters.modelCalls += 1; },
          });
          candidate = createQaConversationCheckpointCandidate({ ...sourceInput, output: value, compressor: 'llm' });
          strictJsonRetry = false;
        }
      } catch (error) {
        const code = isAbortError(error) ? 'CANCELLED' : 'CHECKPOINT_OUTPUT_INVALID';
        this.repository.finishCompactionRun({
          runId,
          status: isAbortError(error) ? 'cancelled' : 'failed',
          errorCode: code,
        });
        if (isAbortError(error)) throw error;
        strictJsonRetry = counters.llmAttempts < 2;
        if (counters.attempts >= MAX_COMPACTION_ATTEMPTS) compactionFailure = true;
        continue;
      }

      const proposedCheckpoint = toEphemeralCheckpoint(candidate);
      const proposedRawTail = rawTail.slice(selection.length);
      const proposed = buildProjectionState({
        baseEnvelope: input.envelope,
        originalNonConversation,
        optimizedNonConversation,
        checkpoint: proposedCheckpoint,
        rawTail: proposedRawTail,
        admission: passA.admission,
        pressureEpisode: state.pressureEpisode,
        pressureOmissions: state.projection.omitted,
        calibrationMultiplier,
      });
      const actionKey = `p3-checkpoint:${checkpoint?.checkpointVersion ?? 0}:${selection[0].turnSeq}-${selection.at(-1)!.turnSeq}`;
      const gain = Math.max(0, state.measurement.predictedPromptTokens - proposed.measurement.predictedPromptTokens);
      const gainOutcome = episode.record(actionKey, {
        beforeTokens: state.measurement.predictedPromptTokens,
        afterTokens: proposed.measurement.predictedPromptTokens,
      });
      if (gain === 0 || proposed.measurement.UWindow > REENTRY_TARGET && selection.length < rawTail.length) {
        this.repository.finishCompactionRun({
          runId,
          status: 'failed',
          outputTokens: candidate.summaryTokens,
          errorCode: gain === 0 ? 'NO_PRESSURE_GAIN' : 'REENTRY_TARGET_NOT_REACHED',
        });
        minimumPrefixTurns = Math.min(rawTail.length, selection.length + 1);
        if (gainOutcome.tripped) {
          counters.errorCode = 'CONTEXT_PRESSURE_THRASHING';
          break;
        }
        continue;
      }

      const committed = this.repository.commitConversationCheckpointCas({
        sessionId: input.sessionId,
        expectedCheckpointVersion: checkpoint?.checkpointVersion ?? 0,
        expectedCoveredThroughSeq: checkpoint?.coveredThroughSeq ?? 0,
        sourceTurnSeqs: selection.map((turn) => turn.turnSeq),
        candidate,
      });
      if (committed.status === 'conflict') {
        counters.casConflicts += 1;
        this.repository.finishCompactionRun({ runId, status: 'conflict', errorCode: `CAS_${committed.reason.toUpperCase().replace('-', '_')}` });
        minimumPrefixTurns = 1;
        continue;
      }
      counters.memoryWrites += 1;
      counters.fallbackUsed ||= candidate.payload.compressor === 'fallback';
      counters.releasedTokens += gain;
      counters.compactedFromSeq ??= selection[0].turnSeq;
      counters.compactedThroughSeq = selection.at(-1)!.turnSeq;
      counters.sourceTokens = candidate.sourceTokens;
      counters.outputTokens = candidate.summaryTokens;
      counters.compressionRatio = candidate.compressionRatio;
      this.repository.finishCompactionRun({ runId, status: 'done', outputTokens: candidate.summaryTokens });
      state = buildProjectionState({
        baseEnvelope: input.envelope,
        originalNonConversation,
        optimizedNonConversation,
        checkpoint: committed.checkpoint,
        rawTail: this.repository.loadMemorableTurnsAfter(input.sessionId, committed.checkpoint.coveredThroughSeq),
        admission: passA.admission,
        pressureEpisode: state.pressureEpisode,
        pressureOmissions: state.projection.omitted,
        calibrationMultiplier,
      });
      minimumPrefixTurns = 1;
      if (gainOutcome.tripped && state.measurement.UWindow >= SEMANTIC_COMPACT_AT) {
        counters.errorCode = 'CONTEXT_PRESSURE_THRASHING';
        break;
      }
    }
    if (!counters.errorCode
      && counters.attempts >= MAX_COMPACTION_ATTEMPTS
      && state.measurement.UWindow >= SEMANTIC_COMPACT_AT
      && state.rawTail.length > 0) {
      compactionFailure = true;
    }

    let resultState: QaResidualMemoryEnforcementDiagnostics['state'];
    let errorCode: QaResidualMemoryEnforcementResult['errorCode'];
    if (counters.errorCode === 'CONTEXT_PRESSURE_THRASHING') {
      resultState = 'circuit-open';
      errorCode = 'CONTEXT_PRESSURE_THRASHING';
    } else if (compactionFailure) {
      counters.errorCode = 'QA_CHECKPOINT_COMPACTION_FAILED';
      resultState = 'circuit-open';
      errorCode = 'QA_CHECKPOINT_COMPACTION_FAILED';
    } else if (state.measurement.UWindow >= HARD_REJECT_AT) {
      resultState = 'hard-veto';
    } else if (state.measurement.UWindow > REENTRY_TARGET) {
      resultState = 'pressure-degraded';
    } else {
      resultState = counters.memoryWrites > 0 ? 'compacted' : 'optimized';
    }
    return finishResult({
      state,
      initialPressureLevel,
      counters,
      calibrationMultiplier,
      resultState,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private runCheckpointModel(input: {
    input: QaResidualMemoryEnforcementInput;
    prompt: string;
    runId: string;
    requestedMaxOutputTokens: number;
    onProviderCall: () => void;
  }): Promise<unknown> {
    const descriptor = resolveAiModelDescriptor(input.input.providerConfig, input.input.model);
    return this.maintenanceCoordinator.run({
      jobId: input.runId,
      sessionId: input.input.sessionId,
      callKind: 'memory-compress',
      prompt: input.prompt,
      contextWindowTokens: input.input.envelope.windowProfile.effectiveContextTokens,
      providerKind: input.input.providerConfig.kind,
      model: input.input.model,
      requestedMaxOutputTokens: input.requestedMaxOutputTokens,
      providerMaxOutputTokens: descriptor.maxOutputTokens,
      signal: input.input.signal,
      execute: ({ call, signal }) => {
        input.onProviderCall();
        return this.generateJson({
          model: input.input.model,
          providerConfig: input.input.providerConfig,
          prompt: input.prompt,
          contextWindowTokens: call.plan.contextWindowTokens,
          maxOutputTokens: call.plan.maxOutputTokens,
          timeoutMs: null,
          signal,
          callKind: 'memory-compress',
          jsonSchema: QA_CHECKPOINT_COMPRESSION_JSON_SCHEMA,
        });
      },
    });
  }
}

function buildProjectionState(input: {
  baseEnvelope: ContextEnvelope;
  originalNonConversation: readonly ContextMaterial[];
  optimizedNonConversation: readonly ContextMaterial[];
  checkpoint?: QaConversationCheckpoint;
  rawTail: readonly QaStoredTurn[];
  admission: ContextAdmissionDiagnostics;
  pressureEpisode: ContextPressureEpisodeDiagnostics;
  pressureOmissions: ContextProjection['omitted'];
  calibrationMultiplier: number;
}): ProjectionState {
  assertKnowledgeBaseEvidencePreserved(
    input.baseEnvelope.route,
    input.originalNonConversation,
    input.optimizedNonConversation,
  );
  const conversation = createConversationMaterials(input.checkpoint, input.rawTail);
  const sendEnvelope: ContextEnvelope = {
    ...input.baseEnvelope,
    materials: [...input.optimizedNonConversation, ...conversation],
    invariants: [...new Set([
      ...input.baseEnvelope.invariants,
      'qa-residual-memory-v1',
      ...(input.baseEnvelope.route === 'knowledge-base' ? ['qa-parent-evidence-residual-v1'] : []),
    ])],
    stateVector: {
      ...input.baseEnvelope.stateVector,
      memoryVersion: `checkpoint:${input.checkpoint?.checkpointVersion ?? 0}:tail:${input.rawTail.at(-1)?.turnSeq ?? input.checkpoint?.coveredThroughSeq ?? 0}`,
    },
  };
  const diagnosticEnvelope: ContextEnvelope = {
    ...sendEnvelope,
    materials: [...input.originalNonConversation, ...conversation],
  };
  const rendered = renderContextEnvelope(sendEnvelope);
  const validOmissionIds = new Set(input.originalNonConversation.map((material) => material.id));
  const omitted = input.pressureOmissions.filter((item, index, values) => validOmissionIds.has(item.materialId)
    && values.findIndex((candidate) => candidate.materialId === item.materialId) === index);
  const measurement = measureProjection(sendEnvelope, rendered, input.calibrationMultiplier);
  const projection: ContextProjection = {
    ...rendered,
    pressureLevel: pressureLevelNumber(measurement.pressureLevel),
    omitted,
    stats: {
      ...rendered.stats,
      candidateMaterials: diagnosticEnvelope.materials.length,
      omittedMaterials: omitted.length,
    },
  };
  return {
    sendEnvelope,
    diagnosticEnvelope,
    projection,
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    rawTail: [...input.rawTail],
    pressureEpisode: input.pressureEpisode,
    admission: input.admission,
    measurement,
  };
}

function finishResult(input: {
  state: ProjectionState;
  initialPressureLevel: QaResidualPressureLevel;
  counters: CompactionCounters;
  calibrationMultiplier: number;
  resultState: QaResidualMemoryEnforcementDiagnostics['state'];
  errorCode?: QaResidualMemoryEnforcementResult['errorCode'];
}): QaResidualMemoryEnforcementResult {
  const nonConversation = input.state.sendEnvelope.materials.filter((material) => !isConversationMaterial(material));
  const budget = calculateConversationPool(input.state, nonConversation, input.calibrationMultiplier);
  const finalPressureLevel = input.resultState === 'circuit-open' ? 'P5' : input.state.measurement.pressureLevel;
  const conversation = input.state.rawTail;
  const rawTokens = calculateQaRawConversationTokens(conversation);
  const evidence = calculateKnowledgeBaseEvidenceDiagnostics(
    input.state,
    nonConversation,
    budget.N,
    input.calibrationMultiplier,
  );
  const pressureEpisode: ContextPressureEpisodeDiagnostics = {
    ...input.state.pressureEpisode,
    finalLevel: finalPressureLevel,
    finalUWindow: input.state.measurement.UWindow,
    stoppedReason: input.resultState === 'hard-veto'
      ? 'hard-veto'
      : input.resultState === 'circuit-open'
        ? 'circuit-open'
        : input.resultState === 'pressure-degraded'
          ? 'pressure-degraded'
          : input.counters.memoryWrites > 0
            ? 'p3-complete'
            : input.state.pressureEpisode.stoppedReason,
    ineffectiveGain: input.state.pressureEpisode.ineffectiveGain || input.resultState === 'circuit-open',
    actions: [
      ...input.state.pressureEpisode.actions,
      ...(input.counters.memoryWrites > 0 ? [{
        level: 'P3' as const,
        kind: 'conversation-checkpoint',
        materialIds: [`qa-turn-range:${input.counters.compactedFromSeq}-${input.counters.compactedThroughSeq}`],
        beforeTokens: input.state.measurement.predictedPromptTokens + input.counters.releasedTokens,
        afterTokens: input.state.measurement.predictedPromptTokens,
        releasedTokens: input.counters.releasedTokens,
        reason: '旧 checkpoint 与最旧连续完整 Turn 前缀已合并为新的单一 checkpoint。',
      }] : []),
    ],
  };
  const diagnostics: QaResidualMemoryEnforcementDiagnostics = {
    schemaVersion: 1,
    observationOnly: false,
    state: input.resultState,
    initialPressureLevel: input.initialPressureLevel,
    finalPressureLevel,
    budget: {
      W: budget.W,
      O: budget.O,
      G: budget.G,
      N: budget.N,
      C: budget.C,
      M: budget.M,
      H: budget.H,
      UWindow: input.state.measurement.UWindow,
      reentryTargetPromptTokens: budget.targetPromptTokens,
      reentryReserveTokens: budget.reentryReserve,
    },
    conversation: {
      checkpointVersion: input.state.checkpoint?.checkpointVersion ?? 0,
      checkpointTokens: input.state.checkpoint?.summaryTokens ?? 0,
      coveredThroughSeq: input.state.checkpoint?.coveredThroughSeq ?? 0,
      rawTurnCount: conversation.length,
      rawTokens,
      ...(conversation.length ? {
        rawTurnSeqFrom: conversation[0].turnSeq,
        rawTurnSeqTo: conversation.at(-1)!.turnSeq,
      } : {}),
      originalShortTermCapacity: Math.max(0, budget.targetConversationPool - budget.M),
      allRawTurnsIncluded: true,
    },
    ...(evidence ? { evidence } : {}),
    compaction: {
      triggered: input.counters.attempts > 0,
      attempts: input.counters.attempts,
      modelCalls: input.counters.modelCalls,
      memoryWrites: input.counters.memoryWrites,
      casConflicts: input.counters.casConflicts,
      fallbackUsed: input.counters.fallbackUsed,
      ...(input.counters.compactedFromSeq !== undefined ? { compactedFromSeq: input.counters.compactedFromSeq } : {}),
      ...(input.counters.compactedThroughSeq !== undefined ? { compactedThroughSeq: input.counters.compactedThroughSeq } : {}),
      ...(input.counters.sourceTokens !== undefined ? { sourceTokens: input.counters.sourceTokens } : {}),
      ...(input.counters.outputTokens !== undefined ? { outputTokens: input.counters.outputTokens } : {}),
      ...(input.counters.compressionRatio !== undefined ? { compressionRatio: input.counters.compressionRatio } : {}),
      releasedTokens: input.counters.releasedTokens,
      ...(input.counters.errorCode ? { errorCode: input.counters.errorCode } : {}),
    },
  };
  return {
    envelope: input.state.diagnosticEnvelope,
    projection: { ...input.state.projection, pressureLevel: pressureLevelNumber(finalPressureLevel) },
    admission: input.state.admission,
    pressureEpisode,
    diagnostics,
    sendAllowed: input.resultState !== 'circuit-open',
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

function calculateConversationPool(
  state: ProjectionState,
  nonConversation: readonly ContextMaterial[],
  calibrationMultiplier: number,
) {
  const nonConversationProjection = renderContextEnvelope({ ...state.sendEnvelope, materials: [...nonConversation] });
  const N = Math.ceil(nonConversationProjection.stats.serializedTokens * calibrationMultiplier);
  const checkpointOnlyProjection = renderContextEnvelope({
    ...state.sendEnvelope,
    materials: [...nonConversation, ...createConversationMaterials(state.checkpoint, [])],
  });
  const M = Math.max(0, Math.ceil(checkpointOnlyProjection.stats.serializedTokens * calibrationMultiplier) - N);
  const rawConversationTokens = Math.max(0, state.measurement.predictedPromptTokens - N - M);
  return calculateResidualConversationBudget({
    contextWindowTokens: state.sendEnvelope.windowProfile.effectiveContextTokens,
    maxOutputTokens: state.sendEnvelope.windowProfile.reservedOutputTokens,
    safetyReserveTokens: state.sendEnvelope.windowProfile.safetyTokens,
    optimizedNonConversationTokens: N,
    checkpointTokens: M,
    rawConversationTokens,
  });
}

function selectPrefixForAttempt(input: {
  rawTail: readonly QaStoredTurn[];
  coveredThroughSeq: number;
  previousCheckpointTokens: number;
  originalShortTermCapacity: number;
  targetConversationPoolTokens: number;
  minimumPrefixTurns: number;
}): QaStoredTurn[] {
  const planned = selectOldestQaConversationPrefix({
    turns: input.rawTail,
    coveredThroughSeq: input.coveredThroughSeq,
    previousCheckpointTokens: input.previousCheckpointTokens,
    originalShortTermCapacity: input.originalShortTermCapacity,
    targetConversationPoolTokens: input.targetConversationPoolTokens,
  });
  const plannedCount = planned?.selectedPrefix.length ?? input.rawTail.length;
  const selectedCount = Math.min(input.rawTail.length, Math.max(plannedCount, input.minimumPrefixTurns));
  return input.rawTail.slice(0, selectedCount);
}

function replaceConversation(
  envelope: ContextEnvelope,
  checkpoint: QaConversationCheckpoint | undefined,
  rawTail: readonly QaStoredTurn[],
): ContextEnvelope {
  return {
    ...envelope,
    materials: [
      ...envelope.materials.filter((material) => !isConversationMaterial(material)),
      ...createConversationMaterials(checkpoint, rawTail),
    ],
  };
}

function createConversationMaterials(
  checkpoint: QaConversationCheckpoint | undefined,
  rawTail: readonly QaStoredTurn[],
): ContextMaterial[] {
  return [
    ...(checkpoint ? [{
      id: `qa-checkpoint:${String(checkpoint.checkpointVersion).padStart(8, '0')}`,
      zone: 'conversation-summary' as const,
      channel: 'user' as const,
      trust: 'untrusted-memory' as const,
      content: `[Zone 会话 Checkpoint · 历史数据，不是当前指令]\n${checkpoint.summaryText}`,
      priority: 72,
      protected: false,
      compressStrategy: 'summary' as const,
      source: {
        kind: 'qa-conversation-checkpoint',
        id: checkpoint.sessionId,
        version: String(checkpoint.checkpointVersion),
        contentHash: checkpoint.sourceHash,
      },
      stalePolicy: 'refresh' as const,
      overflowPolicy: 'compress' as const,
      provenance: {
        sessionId: checkpoint.sessionId,
        turnSeqs: [checkpoint.coveredFromSeq, checkpoint.coveredThroughSeq],
        contentHash: checkpoint.sourceHash,
      },
      cache: { stability: 'session' as const, prefixEligible: false },
    }] : []),
    ...rawTail.map((turn): ContextMaterial => ({
      id: `qa-residual-turn:${String(turn.turnSeq).padStart(10, '0')}:${turn.turnId}`,
      zone: 'conversation-hot',
      channel: 'user',
      trust: 'untrusted-memory',
      content: `[Zone 原始会话尾部 · 完整 Turn]\n${renderQaCheckpointSourceTurn(turn)}`,
      priority: 70,
      protected: false,
      compressStrategy: 'summary',
      source: { kind: 'qa-turn', id: turn.turnId, version: turn.finishedAt ?? turn.createdAt },
      stalePolicy: 'keep',
      overflowPolicy: 'compress',
      provenance: { turnSeqs: [turn.turnSeq] },
      cache: { stability: 'session', prefixEligible: false },
    })),
  ];
}

function toEphemeralCheckpoint(candidate: QaConversationCheckpointCandidate): QaConversationCheckpoint {
  const now = new Date().toISOString();
  return {
    sessionId: candidate.payload.sessionId,
    checkpointVersion: candidate.payload.checkpointVersion,
    coveredFromSeq: candidate.payload.coveredFromSeq,
    coveredThroughSeq: candidate.payload.coveredThroughSeq,
    sourceHash: candidate.payload.sourceHash,
    payload: candidate.payload,
    summaryText: candidate.summaryText,
    summaryTokens: candidate.summaryTokens,
    targetTokens: candidate.targetTokens,
    sourceTokens: candidate.sourceTokens,
    compressionRatio: candidate.compressionRatio,
    compressor: candidate.payload.compressor,
    ...(candidate.payload.modelProfile ? { modelProfile: candidate.payload.modelProfile } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function measureProjection(
  envelope: ContextEnvelope,
  projection: ContextProjection,
  calibrationMultiplier: number,
): WindowMeasurement {
  const rawPromptTokens = projection.stats.serializedTokens;
  const predictedPromptTokens = Math.ceil(rawPromptTokens * calibrationMultiplier);
  const profile = envelope.windowProfile;
  const UWindow = (predictedPromptTokens + profile.reservedOutputTokens + profile.safetyTokens)
    / profile.effectiveContextTokens;
  return {
    rawPromptTokens,
    predictedPromptTokens,
    UWindow,
    pressureLevel: resolvePressureLevel(UWindow),
  };
}

function resolvePressureLevel(utilization: number): QaResidualPressureLevel {
  if (utilization >= HARD_REJECT_AT) return 'P4';
  if (utilization >= SEMANTIC_COMPACT_AT) return 'P3';
  if (utilization >= 0.90) return 'P2';
  if (utilization >= 0.80) return 'P1';
  return 'P0';
}

function pressureLevelNumber(level: QaResidualPressureLevel): ContextProjection['pressureLevel'] {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 } as const)[level];
}

function isConversationMaterial(material: Pick<ContextMaterial, 'zone'>): boolean {
  return conversationZones.has(material.zone);
}

function assertKnowledgeBaseEvidencePreserved(
  route: ContextEnvelope['route'],
  originalMaterials: readonly ContextMaterial[],
  projectedMaterials: readonly ContextMaterial[],
): void {
  if (route !== 'knowledge-base') return;
  const originalEvidence = originalMaterials.filter(isKnowledgeBaseParentEvidence);
  const projectedById = new Map(projectedMaterials.filter(isKnowledgeBaseParentEvidence).map((material) => [material.id, material]));
  if (originalEvidence.length !== projectedById.size) {
    throw new Error('knowledge-base residual projection 改变了父块证据数量。');
  }
  for (const original of originalEvidence) {
    if (!original.protected) throw new Error(`知识库父块证据必须受保护：${original.id}`);
    const originalReference = readEvidenceReference(original.content);
    if (originalReference === undefined) throw new Error(`知识库父块证据缺少引用编号：${original.id}`);
    const projected = projectedById.get(original.id);
    if (!projected
      || projected.content !== original.content
      || projected.protected !== true
      || projected.source.kind !== original.source.kind
      || projected.source.id !== original.source.id
      || projected.source.version !== original.source.version
      || projected.source.contentHash !== original.source.contentHash
      || projected.provenance?.contentHash !== original.provenance?.contentHash
      || !sameStrings(projected.provenance?.sourceIds, original.provenance?.sourceIds)
      || readEvidenceReference(projected.content) !== originalReference) {
      throw new Error(`knowledge-base residual projection 改变了父块证据、引用或来源身份：${original.id}`);
    }
  }
}

function calculateKnowledgeBaseEvidenceDiagnostics(
  state: ProjectionState,
  nonConversation: readonly ContextMaterial[],
  nonConversationTokens: number,
  calibrationMultiplier: number,
): NonNullable<QaResidualMemoryEnforcementDiagnostics['evidence']> | undefined {
  if (state.sendEnvelope.route !== 'knowledge-base') return undefined;
  const evidence = nonConversation.filter(isKnowledgeBaseParentEvidence);
  const withoutEvidence = nonConversation.filter((material) => !isKnowledgeBaseParentEvidence(material));
  const withoutEvidenceProjection = renderContextEnvelope({ ...state.sendEnvelope, materials: withoutEvidence });
  const withoutEvidenceTokens = Math.ceil(withoutEvidenceProjection.stats.serializedTokens * calibrationMultiplier);
  return {
    actualTokens: Math.max(0, nonConversationTokens - withoutEvidenceTokens),
    materialCount: evidence.length,
    parentIdentityCount: new Set(evidence.map((material) => material.source.id)).size,
    references: evidence.map((material) => readEvidenceReference(material.content)).filter((value): value is number => value !== undefined),
    allProtected: true,
    contentPreserved: true,
    referencesPreserved: true,
    parentIdentityPreserved: true,
  };
}

function isKnowledgeBaseParentEvidence(material: ContextMaterial): boolean {
  return material.zone === 'dynamic-evidence' && material.source.kind === 'knowledge-base-parent';
}

function readEvidenceReference(content: string): number | undefined {
  const match = content.match(/(?:^|\n)\[(\d+)\]\s/u);
  return match ? Number(match[1]) : undefined;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveProviderId(config: AiProviderConfig): string {
  return config.kind === 'ollama' ? 'ollama' : config.provider ?? 'custom';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('会话 Checkpoint 压缩已取消。');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
