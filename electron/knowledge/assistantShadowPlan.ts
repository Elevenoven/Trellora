import type { AssistantConversationMessage } from './assistantTurnTypes';
import type { AiProviderKind } from './aiTypes';
import { ModelCallCoordinator } from './modelCallCoordinator';
import type { ModelCallKind } from './modelCallBudget';
import { estimateTokenCount, type AssistantTokenUsage } from './tokenEstimator';
import { sharedTokenCalibrationStore } from './tokenCalibration';
import { createFallbackCurrentNoteSearchScope, resolveCurrentNoteSearchScope, type CurrentNoteSearchScope } from './currentNoteSearchScope';

export type ShadowPlanStatus = 'ran' | 'shadowSkipped' | 'shadowFailure';
export type ShadowPlanSkipReason = 'model-budget' | 'wall-time' | 'cancelled' | 'stale';

export interface ShadowPlanResult {
  status: ShadowPlanStatus;
  reason?: ShadowPlanSkipReason | 'context-overflow';
  promptTokens?: number;
  scopeComparison?: ShadowScopeComparison;
}

export interface ShadowScopeComparison {
  previous: CurrentNoteSearchScope;
  proposed: CurrentNoteSearchScope;
  changed: boolean;
}

/**
 * Runs one side-effect-free Planner after the legacy answer is complete. The
 * same turn coordinator is deliberately used, so shadow can only spend the
 * calls and wall time that the legacy route left behind.
 */
export async function runShadowPlan(input: {
  question: string;
  conversation: readonly AssistantConversationMessage[];
  providerKind: AiProviderKind;
  model: string;
  coordinator: ModelCallCoordinator;
  signal: AbortSignal;
  isSnapshotCurrent: () => boolean;
  sourceSummaries?: readonly string[];
  /** Legacy route scope used only for shadow telemetry; never changes the answer. */
  legacyScope?: CurrentNoteSearchScope;
  generateJson: (request: { prompt: string; signal: AbortSignal; maxOutputTokens: number; callKind: ModelCallKind; onUsage: (usage: AssistantTokenUsage) => void }) => Promise<unknown>;
}): Promise<ShadowPlanResult> {
  if (input.signal.aborted) return { status: 'shadowSkipped', reason: 'cancelled' };
  if (!input.isSnapshotCurrent()) return { status: 'shadowSkipped', reason: 'stale' };
  const prompt = [
    '[Shadow Planner：只观测，不改变旧回答]',
    `provider=${input.providerKind} model=${input.model}`,
    '旧链路已经完成。只输出一个结构化 plan JSON；不得执行工具、写入 Ledger、持久化计划或产生 UI 事件。',
    'scope 只能包含 mode、coveragePolicy、targetTopic、targetAspects；不要输出 origin、confidence 或其他字段。',
    'Planner 输入仅用于比较候选分区和预计调用成本，旧链路答案与工具序列必须保持不变。',
    `[问题]\n${input.question.trim()}`,
    input.conversation.length ? `[最近会话]\n${input.conversation.slice(-3).map((message) => `${message.role}：${message.content.trim().slice(-600)}`).join('\n')}` : '',
    input.sourceSummaries?.length ? `[旧链路摘要]\n${input.sourceSummaries.slice(0, 8).join('\n')}` : '',
    '[输出约束]\n{"type":"object","additionalProperties":false,"required":["scope","goals"]}',
  ].filter(Boolean).join('\n\n');
  const prepared = input.coordinator.prepare({ callKind: 'shadow-plan', prompt });
  if (!prepared.ready) {
    return { status: 'shadowSkipped', reason: prepared.reason === 'timeout' ? 'wall-time' : 'model-budget' };
  }
  try {
    const value = await input.generateJson({
      prompt,
      signal: input.signal,
      maxOutputTokens: prepared.call.plan.maxOutputTokens,
      callKind: 'shadow-plan',
      onUsage: (usage) => sharedTokenCalibrationStore.observeUsage({ providerKind: input.providerKind, model: input.model, callKind: 'shadow-plan' }, estimateTokenCount(prompt), usage),
    });
    const previous = input.legacyScope ?? createFallbackCurrentNoteSearchScope(input.question);
    let proposed: CurrentNoteSearchScope;
    try {
      const rawScope = value && typeof value === 'object' && !Array.isArray(value) ? (value as { scope?: unknown }).scope : undefined;
      proposed = resolveCurrentNoteSearchScope(input.question, rawScope);
    } catch {
      proposed = createFallbackCurrentNoteSearchScope(input.question);
    }
    return {
      status: 'ran',
      promptTokens: prepared.call.plan.predictedPromptTokens,
      scopeComparison: { previous, proposed, changed: !sameScope(previous, proposed) },
    };
  } catch (error) {
    // Shadow never retries: a provider overflow is telemetry, not a reason to
    // spend another call or affect the already completed legacy answer.
    if (isContextOverflow(error)) return { status: 'shadowFailure', reason: 'context-overflow', promptTokens: prepared.call.plan.predictedPromptTokens };
    return { status: 'shadowFailure', promptTokens: prepared.call.plan.predictedPromptTokens };
  }
}

function sameScope(left: CurrentNoteSearchScope, right: CurrentNoteSearchScope): boolean {
  return left.mode === right.mode
    && left.coveragePolicy === right.coveragePolicy
    && left.targetTopic === right.targetTopic
    && left.targetAspects.length === right.targetAspects.length
    && left.targetAspects.every((aspect, index) => aspect === right.targetAspects[index]);
}

function isContextOverflow(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'AI_CONTEXT_OVERFLOW' || code === 'context_length_exceeded' || code === 'AI_CONTEXT_BUDGET_EXCEEDED';
}
