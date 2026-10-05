import { estimateTokenCount } from './tokenEstimator';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS, ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS } from '../../shared/assistantContextBudget';

/**
 * Context capacity is a veto only. It never decides that a note may be sent
 * in full; that authorization remains exclusively in currentNotePolicy.
 */
export interface CurrentNoteContextBudgetConfig {
  contextWindowTokens?: number;
  reservedOutputTokens: number;
  reservedHistoryTokens: number;
  reservedDynamicTokens: number;
}

export interface CurrentNoteContextBudgetAssessment {
  stablePrefixTokens: number;
  contextWindowKnown: boolean;
  maxStablePrefixTokens?: number;
  fits: boolean;
  rejection?: 'stable-prefix-over-budget';
}

export interface CurrentNotePromptBudgetAssessment {
  inputTokens: number;
  contextWindowKnown: boolean;
  maxInputTokens?: number;
  fits: boolean;
  rejection?: 'prompt-over-budget';
}

export type PromptCallKind = 'plan' | 'decide' | 'synthesize' | 'citation-repair' | 'summary-map' | 'summary-reduce' | 'shadow-plan' | 'conversation-maintenance' | 'route-classify' | 'query-rewrite' | 'chat' | 'follow-up-suggest' | 'user-profile-extract' | 'direct' | 'learning-plan' | 'organize' | 'memory-compress';

export interface PromptBudgetPlan {
  callKind: PromptCallKind;
  contextWindowTokens: number;
  predictedPromptTokens: number;
  maxPromptTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  rawPromptTokens: number;
  calibrationMultiplier: number;
  requestEnvelopeVersion: string;
  budgetTextSource: 'serialized-envelope' | 'legacy-prompt';
  utilization: number;
  fits: boolean;
  rejection?: 'prompt-over-budget';
}

/**
 * Stage 3 keeps the scheduler's provider safety reserve intact and allocates
 * the remaining prompt space from the same complete-prompt budget.
 */
export function calculateEvidencePayloadBudgetTokens(
  maxPromptTokens: number,
  allNonEvidenceAndFramingTokens: number,
): number {
  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 0) throw new Error('maxPromptTokens 必须是非负整数。');
  if (!Number.isSafeInteger(allNonEvidenceAndFramingTokens) || allNonEvidenceAndFramingTokens < 0) {
    throw new Error('非证据与包装 token 数必须是非负整数。');
  }
  return Math.max(0, Math.floor(maxPromptTokens * 0.98) - allNonEvidenceAndFramingTokens);
}

const callKindOutputLimits: Record<PromptCallKind, number> = {
  plan: 4_096,
  decide: 4_096,
  synthesize: 16_384,
  'citation-repair': 4_096,
  'summary-map': 4_096,
  'summary-reduce': 8_192,
  'shadow-plan': 4_096,
  'conversation-maintenance': 4_096,
  'route-classify': 4_096,
  'query-rewrite': 1_024,
  chat: 8_192,
  'follow-up-suggest': 1_024,
  'user-profile-extract': 800,
  direct: 16_384,
  'learning-plan': 8_192,
  organize: 8_192,
  'memory-compress': 8_192,
};

/** Counts the complete prompt immediately before an authorized send. */
export class PromptBudgetScheduler {
  plan(input: {
    prompt: string;
    /** Exact role/envelope serialization used for budget accounting. */
    serializedBudgetText?: string;
    requestEnvelopeVersion?: string;
    contextWindowTokens?: number;
    callKind: PromptCallKind;
    requestedMaxOutputTokens?: number;
    providerMaxOutputTokens?: number;
    safetyRatio?: number;
    calibrationMultiplier?: number;
  }): PromptBudgetPlan {
    const contextWindowTokens = input.contextWindowTokens ?? ASSISTANT_UNKNOWN_MODEL_CONTEXT_TOKENS;
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) throw new Error('上下文窗口必须是正整数。');
    const scaledOutputCeiling = Math.max(1_024, Math.floor(contextWindowTokens * 0.125));
    const maxOutputTokens = Math.min(
      callKindOutputLimits[input.callKind],
      scaledOutputCeiling,
      input.providerMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
      input.requestedMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
    );
    const safetyRatio = input.safetyRatio ?? (contextWindowTokens < ASSISTANT_CONTEXT_BUDGET_TOKENS ? 0.05 : 0.03125);
    const safetyReserveTokens = Math.max(2_048, Math.floor(contextWindowTokens * safetyRatio));
    const maxPromptTokens = Math.max(0, contextWindowTokens - maxOutputTokens - safetyReserveTokens);
    const budgetTextSource = input.serializedBudgetText === undefined ? 'legacy-prompt' : 'serialized-envelope';
    const rawPromptTokens = estimateTokenCount(input.serializedBudgetText ?? input.prompt);
    const calibrationMultiplier = Math.max(1, input.calibrationMultiplier ?? 1);
    const predictedPromptTokens = Math.ceil(rawPromptTokens * calibrationMultiplier);
    const fits = predictedPromptTokens <= maxPromptTokens;
    return {
      callKind: input.callKind,
      contextWindowTokens,
      predictedPromptTokens,
      maxPromptTokens,
      maxOutputTokens,
      safetyReserveTokens,
      rawPromptTokens,
      calibrationMultiplier,
      requestEnvelopeVersion: input.requestEnvelopeVersion?.trim() || (budgetTextSource === 'serialized-envelope' ? 'context-envelope-unknown' : 'legacy-prompt-v1'),
      budgetTextSource,
      utilization: contextWindowTokens > 0 ? predictedPromptTokens / contextWindowTokens : 1,
      fits,
      ...(fits ? {} : { rejection: 'prompt-over-budget' as const }),
    };
  }
}

/**
 * Emergency-only, deterministic projection compaction. It never edits the
 * ledger or plan; it only shortens non-protected prompt blocks while keeping
 * identifiers and the beginning/end of each observation visible to the model.
 */
export function compactPromptForOverflowRetry(prompt: string, callKind: PromptCallKind): string {
  const protectedMarkers = ['[Zone A', '[Zone D', '[Zone G', '[当前问题]', '[最终回答]', '输出 JSON'];
  const blocks = prompt.split(/\n{2,}/u);
  let changed = false;
  const compacted = blocks.map((block) => {
    if (block.length <= 1_800 || protectedMarkers.some((marker) => block.includes(marker))) return block;
    const limit = callKind === 'synthesize' ? 1_200 : 900;
    const head = Math.ceil(limit * 0.62);
    const tail = Math.floor(limit * 0.28);
    changed = true;
    return `${block.slice(0, head)}\n…（仅压缩本次模型投影，完整内容仍保留在主进程权威状态）…\n${block.slice(-tail)}`;
  });
  return changed ? compacted.join('\n\n') : prompt;
}

export const DEFAULT_CURRENT_NOTE_CONTEXT_BUDGET: Readonly<Omit<CurrentNoteContextBudgetConfig, 'contextWindowTokens'>> = Object.freeze({
  reservedOutputTokens: 1_200,
  reservedHistoryTokens: 800,
  reservedDynamicTokens: 400,
});

export class ContextBudgetManager {
  private readonly config: CurrentNoteContextBudgetConfig;

  constructor(config: CurrentNoteContextBudgetConfig) {
    assertNonNegativeInteger(config.reservedOutputTokens, '输出预留');
    assertNonNegativeInteger(config.reservedHistoryTokens, '历史预留');
    assertNonNegativeInteger(config.reservedDynamicTokens, '动态预留');
    if (config.contextWindowTokens !== undefined) assertPositiveInteger(config.contextWindowTokens, '上下文窗口');
    this.config = { ...config };
  }

  /** The policy can use this only as a second-level rejection condition. */
  hasOutputAndHistoryReserve(): boolean {
    const contextWindowTokens = this.config.contextWindowTokens;
    return contextWindowTokens !== undefined
      && contextWindowTokens > this.config.reservedOutputTokens + this.config.reservedHistoryTokens;
  }

  assessStablePrefix(stablePrefixTokens: number): CurrentNoteContextBudgetAssessment {
    assertNonNegativeInteger(stablePrefixTokens, '稳定前缀 token 数');
    const contextWindowTokens = this.config.contextWindowTokens;
    if (contextWindowTokens === undefined) {
      // An unknown window still rejects direct-full through StrictSmallNotePolicy.
      // A bounded Capsule remains usable because this class does not authorize
      // raw-note disclosure in either direction.
      return { stablePrefixTokens, contextWindowKnown: false, fits: true };
    }
    const maxStablePrefixTokens = contextWindowTokens
      - this.config.reservedOutputTokens
      - this.config.reservedHistoryTokens
      - this.config.reservedDynamicTokens;
    if (maxStablePrefixTokens < 0 || stablePrefixTokens > maxStablePrefixTokens) {
      return { stablePrefixTokens, contextWindowKnown: true, maxStablePrefixTokens: Math.max(0, maxStablePrefixTokens), fits: false, rejection: 'stable-prefix-over-budget' };
    }
    return { stablePrefixTokens, contextWindowKnown: true, maxStablePrefixTokens, fits: true };
  }

  assessPrompt(inputTokens: number): CurrentNotePromptBudgetAssessment {
    assertNonNegativeInteger(inputTokens, '提示词 token 数');
    const contextWindowTokens = this.config.contextWindowTokens;
    if (contextWindowTokens === undefined) return { inputTokens, contextWindowKnown: false, fits: true };
    const maxInputTokens = contextWindowTokens - this.config.reservedOutputTokens;
    if (maxInputTokens < 0 || inputTokens > maxInputTokens) {
      return { inputTokens, contextWindowKnown: true, maxInputTokens: Math.max(0, maxInputTokens), fits: false, rejection: 'prompt-over-budget' };
    }
    return { inputTokens, contextWindowKnown: true, maxInputTokens, fits: true };
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数。`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
}
