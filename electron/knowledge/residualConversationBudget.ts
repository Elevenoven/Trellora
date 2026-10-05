import type { QaStoredTurn } from './qaMemoryTypes';
import { QA_HOT_TURN_STATUSES } from './qaMemoryTypes';
import {
  calculateQaCheckpointTargets,
  renderQaCheckpointSourceTurn,
} from './qaConversationCheckpoint';
import { estimateTokenCount } from './tokenEstimator';

export interface ResidualConversationBudgetInput {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  optimizedNonConversationTokens: number;
  checkpointTokens: number;
  rawConversationTokens?: number;
  hardPromptRatio?: number;
  targetPromptRatio?: number;
}

export interface ResidualConversationBudget {
  W: number;
  O: number;
  G: number;
  N: number;
  C: number;
  M: number;
  H: number;
  UWindow: number;
  hardMaxPromptTokens: number;
  targetPromptTokens: number;
  hardConversationPool: number;
  targetConversationPool: number;
  reentryReserve: number;
}

export interface QaConversationPrefixSelection {
  selectedPrefix: QaStoredTurn[];
  recentSuffix: QaStoredTurn[];
  selectedThroughSeq: number;
  selectedRawTokens: number;
  recentSuffixTokens: number;
  sourceTokens: number;
  summaryHardMaxTokens: number;
  summaryTargetTokens: number;
  projectedConversationTokens: number;
}

/** 以优化后的非会话占用重算剩余窗口；不保留固定 M1/M2 槽位。 */
export function calculateResidualConversationBudget(input: ResidualConversationBudgetInput): ResidualConversationBudget {
  const W = positiveInteger(input.contextWindowTokens, '上下文窗口');
  const O = nonNegativeInteger(input.maxOutputTokens, '输出预算');
  const G = nonNegativeInteger(input.safetyReserveTokens, '安全余量');
  const N = nonNegativeInteger(input.optimizedNonConversationTokens, '非会话材料');
  const M = nonNegativeInteger(input.checkpointTokens, 'Checkpoint');
  const rawConversationTokens = nonNegativeInteger(input.rawConversationTokens ?? 0, '原始会话尾部');
  const hardPromptRatio = validRatio(input.hardPromptRatio ?? 1, 'Prompt 硬上限比例');
  const targetPromptRatio = validRatio(input.targetPromptRatio ?? 0.92, '回滞目标比例');
  if (targetPromptRatio > hardPromptRatio) throw new Error('会话回滞目标不得高于 Prompt 硬上限。');

  const hardMaxPromptTokens = Math.max(0, Math.floor(W * hardPromptRatio) - O - G);
  const targetPromptTokens = Math.max(0, Math.floor(W * targetPromptRatio) - O - G);
  const C = Math.max(0, hardMaxPromptTokens - N);
  const H = Math.max(0, C - M);
  const hardConversationPool = C;
  const targetConversationPool = Math.max(0, targetPromptTokens - N);
  return {
    W,
    O,
    G,
    N,
    C,
    M,
    H,
    UWindow: (N + M + rawConversationTokens + O + G) / W,
    hardMaxPromptTokens,
    targetPromptTokens,
    hardConversationPool,
    targetConversationPool,
    reentryReserve: Math.max(0, hardConversationPool - targetConversationPool),
  };
}

/**
 * 选择满足回滞目标的最小、最旧、Turn 原子前缀。数字 seq 可因失败轮而有空洞，
 * 但输入必须是 coveredThroughSeq 之后完整的可记忆终态流。
 */
export function selectOldestQaConversationPrefix(input: {
  turns: readonly QaStoredTurn[];
  coveredThroughSeq: number;
  previousCheckpointTokens: number;
  originalShortTermCapacity: number;
  targetConversationPoolTokens: number;
}): QaConversationPrefixSelection | undefined {
  const coveredThroughSeq = nonNegativeInteger(input.coveredThroughSeq, 'Checkpoint 覆盖边界');
  const previousCheckpointTokens = nonNegativeInteger(input.previousCheckpointTokens, '上一版 Checkpoint token');
  const originalShortTermCapacity = nonNegativeInteger(input.originalShortTermCapacity, '原短期会话容量');
  const targetConversationPoolTokens = nonNegativeInteger(input.targetConversationPoolTokens, '目标会话池');
  validateTurns(input.turns, coveredThroughSeq);
  if (input.turns.length === 0) return undefined;

  const turnTokens = input.turns.map((turn) => estimateTokenCount(renderQaCheckpointSourceTurn(turn)));
  let selectedRawTokens = 0;
  let recentSuffixTokens = turnTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (previousCheckpointTokens + recentSuffixTokens <= targetConversationPoolTokens) return undefined;
  for (let index = 0; index < input.turns.length; index += 1) {
    selectedRawTokens += turnTokens[index];
    recentSuffixTokens -= turnTokens[index];
    const sourceTokens = previousCheckpointTokens + selectedRawTokens;
    const targets = calculateQaCheckpointTargets(originalShortTermCapacity, sourceTokens);
    const projectedConversationTokens = targets.summaryTargetTokens + recentSuffixTokens;
    if (projectedConversationTokens <= targetConversationPoolTokens) {
      const selectedPrefix = input.turns.slice(0, index + 1);
      return {
        selectedPrefix,
        recentSuffix: input.turns.slice(index + 1),
        selectedThroughSeq: selectedPrefix.at(-1)!.turnSeq,
        selectedRawTokens,
        recentSuffixTokens,
        sourceTokens,
        ...targets,
        projectedConversationTokens,
      };
    }
  }
  return undefined;
}

export function calculateQaRawConversationTokens(turns: readonly QaStoredTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateTokenCount(renderQaCheckpointSourceTurn(turn)), 0);
}

function validateTurns(turns: readonly QaStoredTurn[], coveredThroughSeq: number): void {
  let previous = coveredThroughSeq;
  const ids = new Set<string>();
  for (const turn of turns) {
    if (!Number.isSafeInteger(turn.turnSeq) || turn.turnSeq <= previous
      || ids.has(turn.turnId) || !QA_HOT_TURN_STATUSES.includes(turn.status)) {
      throw new Error('会话压缩候选必须是覆盖边界后的升序、唯一、可记忆终态 Turn。');
    }
    previous = turn.turnSeq;
    ids.add(turn.turnId);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正整数。`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数。`);
  return value;
}

function validRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${label}必须位于 (0, 1]。`);
  return value;
}
