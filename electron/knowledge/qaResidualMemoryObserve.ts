import { PromptBudgetScheduler } from './currentNoteContextBudget';
import { renderContextEnvelope } from './contextRenderer';
import type { QaResidualMemoryObservationInput, QaStoredTurn } from './qaMemoryTypes';
import { estimateTokenCount } from './tokenEstimator';
import type {
  ContextEnvelope,
  ContextMaterial,
  QaResidualMemoryDiagnostics,
  QaResidualPressureLevel,
} from './contextRuntimeTypes';

const TOOL_CLEANUP_AT = 0.80;
const ARTIFACT_SWEEP_AT = 0.90;
const SEMANTIC_COMPACT_AT = 0.95;
const HARD_REJECT_AT = 1.00;
const REENTRY_TARGET = 0.92;
const SUMMARY_HARD_RATIO = 0.20;
const SUMMARY_TARGET_RATIO = 0.12;

const conversationZones = new Set(['conversation-summary', 'conversation-hot', 'conversation-recall']);

/**
 * Phase 0 shadow calculator. It never writes memory, invokes a model, or
 * returns content that can replace the active legacy Prompt.
 */
export function observeQaResidualMemory(input: {
  envelope: ContextEnvelope;
  memory: QaResidualMemoryObservationInput;
  calibrationMultiplier?: number;
}): QaResidualMemoryDiagnostics {
  const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
  const nonConversationEnvelope: ContextEnvelope = {
    ...input.envelope,
    materials: input.envelope.materials.filter((material) => !conversationZones.has(material.zone)),
  };
  const shadowConversationMaterials = createShadowConversationMaterials(input.memory.memorableTurns);
  const fullShadowEnvelope: ContextEnvelope = {
    ...nonConversationEnvelope,
    materials: [...nonConversationEnvelope.materials, ...shadowConversationMaterials],
  };
  const scheduler = new PromptBudgetScheduler();
  const nonConversationProjection = renderContextEnvelope(nonConversationEnvelope);
  const fullShadowProjection = renderContextEnvelope(fullShadowEnvelope);
  const planInput = {
    contextWindowTokens: input.envelope.windowProfile.effectiveContextTokens,
    callKind: input.envelope.callKind,
    calibrationMultiplier,
  } as const;
  const nonConversationPlan = scheduler.plan({
    ...planInput,
    prompt: joinRolePrompts(nonConversationProjection.systemPrompt, nonConversationProjection.userPrompt),
    serializedBudgetText: nonConversationProjection.serializedBudgetText,
    requestEnvelopeVersion: nonConversationProjection.requestEnvelopeVersion,
  });
  const fullShadowPlan = scheduler.plan({
    ...planInput,
    prompt: joinRolePrompts(fullShadowProjection.systemPrompt, fullShadowProjection.userPrompt),
    serializedBudgetText: fullShadowProjection.serializedBudgetText,
    requestEnvelopeVersion: fullShadowProjection.requestEnvelopeVersion,
  });

  const W = nonConversationPlan.contextWindowTokens;
  const O = nonConversationPlan.maxOutputTokens;
  const G = nonConversationPlan.safetyReserveTokens;
  const N = nonConversationPlan.predictedPromptTokens;
  // Phase 0 deliberately has no checkpoint table; legacy M1 is recorded
  // separately and must not be mistaken for a valid continuous checkpoint.
  const M = 0;
  const C = Math.max(0, W - O - G - N);
  const H = Math.max(0, C - M);
  const rawConversationTokens = Math.max(0, fullShadowPlan.predictedPromptTokens - N);
  const UWindow = W > 0 ? (fullShadowPlan.predictedPromptTokens + O + G) / W : 1;
  const pressureLevel = resolvePressureLevel(UWindow);
  const targetPromptTokens = Math.max(0, Math.floor(W * REENTRY_TARGET) - O - G);
  const targetConversationPool = Math.max(0, targetPromptTokens - N - M);
  const compaction = projectCompactionBoundary({
    turns: input.memory.memorableTurns,
    rawConversationTokens,
    H,
    targetConversationPool,
    N,
    M,
    O,
    G,
    W,
    candidate: UWindow >= SEMANTIC_COMPACT_AT,
  });
  const includedTurns = input.memory.memorableTurns.slice(compaction.sourceTurnCount);
  const hotTurnSeqs = [...new Set(input.memory.legacy.hotTurnSeqs)].sort((left, right) => left - right);

  return {
    schemaVersion: 1,
    observationOnly: true,
    legacy: {
      M1: {
        tokens: input.memory.legacy.rollingSummaryTokens,
        materialCount: input.memory.legacy.summaryMaterialCount,
      },
      M2: {
        tokens: input.memory.legacy.shortTermTokens,
        turnCount: hotTurnSeqs.length,
        ...(hotTurnSeqs.length ? { turnSeqFrom: hotTurnSeqs[0], turnSeqTo: hotTurnSeqs.at(-1)! } : {}),
      },
    },
    budget: {
      W,
      O,
      G,
      N,
      C,
      M,
      H,
      UWindow,
      rawNonConversationTokens: nonConversationPlan.rawPromptTokens,
      rawConversationTokens,
      reentryTargetPromptTokens: targetPromptTokens,
    },
    wouldOptimize: {
      required: UWindow >= TOOL_CLEANUP_AT,
      pressureLevel,
      actions: [
        ...(UWindow >= TOOL_CLEANUP_AT ? ['cleanup-old-tool-output' as const] : []),
        ...(UWindow >= ARTIFACT_SWEEP_AT ? ['artifact-and-cold-reference' as const] : []),
      ],
    },
    wouldInclude: {
      allRawTurns: compaction.sourceTurnCount === 0,
      turnCount: includedTurns.length,
      ...(includedTurns.length ? {
        turnSeqFrom: includedTurns[0].turnSeq,
        turnSeqTo: includedTurns.at(-1)!.turnSeq,
      } : {}),
      estimatedTokens: compaction.includedRawTokens,
    },
    wouldCompact: {
      candidate: compaction.sourceTurnCount > 0,
      conditionalOnOptimizationInsufficient: true,
      sourceTurnCount: compaction.sourceTurnCount,
      sourceTokens: compaction.sourceTokens,
      estimatedSummaryTargetTokens: compaction.estimatedSummaryTargetTokens,
      ...(compaction.sourceTurnCount ? {
        compactThroughTurnSeq: input.memory.memorableTurns[compaction.sourceTurnCount - 1].turnSeq,
      } : {}),
      projectedUWindowAfter: compaction.projectedUWindowAfter,
      reachesReentryTarget: compaction.projectedUWindowAfter <= REENTRY_TARGET,
    },
  };
}

function createShadowConversationMaterials(turns: readonly QaStoredTurn[]): ContextMaterial[] {
  if (turns.length === 0) return [];
  return [
    {
      id: 'qa-residual-shadow:header',
      zone: 'conversation-hot',
      channel: 'user',
      trust: 'untrusted-memory',
      content: '[Zone 会话原始尾部 · observe only]',
      priority: 70,
      protected: false,
      compressStrategy: 'summary',
      source: { kind: 'qa-residual-shadow', id: 'header', version: 'observe-v1' },
      stalePolicy: 'refresh',
      overflowPolicy: 'compress',
      cache: { stability: 'session', prefixEligible: false },
    },
    ...turns.map((turn): ContextMaterial => ({
      id: `qa-residual-shadow:${String(turn.turnSeq).padStart(10, '0')}`,
      zone: 'conversation-hot',
      channel: 'user',
      trust: 'untrusted-memory',
      content: renderFullTurn(turn),
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

function renderFullTurn(turn: QaStoredTurn): string {
  return [`轮${turn.turnSeq} 用户：${turn.userText}`, `轮${turn.turnSeq} 助手：${turn.assistantText ?? ''}`].join('\n');
}

function projectCompactionBoundary(input: {
  turns: readonly QaStoredTurn[];
  rawConversationTokens: number;
  H: number;
  targetConversationPool: number;
  N: number;
  M: number;
  O: number;
  G: number;
  W: number;
  candidate: boolean;
}): {
  sourceTurnCount: number;
  sourceTokens: number;
  estimatedSummaryTargetTokens: number;
  includedRawTokens: number;
  projectedUWindowAfter: number;
} {
  if (!input.candidate || input.turns.length === 0) {
    return {
      sourceTurnCount: 0,
      sourceTokens: 0,
      estimatedSummaryTargetTokens: 0,
      includedRawTokens: input.rawConversationTokens,
      projectedUWindowAfter: input.W > 0
        ? (input.N + input.M + input.rawConversationTokens + input.O + input.G) / input.W
        : 1,
    };
  }

  const weights = input.turns.map((turn) => Math.max(1, estimateTokenCount(renderFullTurn(turn))));
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  let sourceTokens = 0;
  let sourceWeight = 0;
  for (let index = 0; index < input.turns.length; index += 1) {
    sourceWeight += weights[index];
    sourceTokens = Math.min(
      input.rawConversationTokens,
      Math.round(input.rawConversationTokens * sourceWeight / totalWeight),
    );
    const estimatedSummaryTargetTokens = Math.min(
      Math.floor(input.H * SUMMARY_HARD_RATIO),
      Math.floor(sourceTokens * SUMMARY_HARD_RATIO),
      Math.floor(sourceTokens * SUMMARY_TARGET_RATIO),
    );
    const includedRawTokens = Math.max(0, input.rawConversationTokens - sourceTokens);
    if (estimatedSummaryTargetTokens + includedRawTokens <= input.targetConversationPool || index === input.turns.length - 1) {
      return {
        sourceTurnCount: index + 1,
        sourceTokens,
        estimatedSummaryTargetTokens,
        includedRawTokens,
        projectedUWindowAfter: input.W > 0
          ? (input.N + input.M + estimatedSummaryTargetTokens + includedRawTokens + input.O + input.G) / input.W
          : 1,
      };
    }
  }
  throw new Error('残余窗口 observe 未能计算候选压缩边界。');
}

function resolvePressureLevel(utilization: number): QaResidualPressureLevel {
  if (utilization >= HARD_REJECT_AT) return 'P4';
  if (utilization >= SEMANTIC_COMPACT_AT) return 'P3';
  if (utilization >= ARTIFACT_SWEEP_AT) return 'P2';
  if (utilization >= TOOL_CLEANUP_AT) return 'P1';
  return 'P0';
}

function joinRolePrompts(systemPrompt: string, userPrompt: string): string {
  return [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
}
