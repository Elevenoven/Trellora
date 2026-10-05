import { estimateTokenCount } from './tokenEstimator';
import { ASSISTANT_CONTEXT_BUDGET_TOKENS } from '../../shared/assistantContextBudget';
import type { QaSessionScope, QaStoredTurn, QaSummaryBlock } from './qaMemoryTypes';
import { QA_HOT_TURN_COUNT } from './qaMemoryRepository';

/** 设计 §4.2 分区预算表（绝对上限，128K 基准）。 */
export const QA_ZONE_ABSOLUTE_LIMITS = Object.freeze({
  staticPrefix: 2_000,
  rollingSummary: 4_000,
  shortTerm: 8_000,
  /** chat 剖面 M2 弹性上限（只消耗 D 空闲预留中的 4,000，设计 §4.4）。 */
  shortTermChatElastic: 12_000,
  dynamic: 20_000,
  questionConstraint: 1_500,
  /** 知识库 ReAct 记忆信封（M1 摘要 + 用户画像）绝对上限，常态取值由剖面比例决定。 */
  memoryEnvelope: 6_000,
  /** 知识库 ReAct 轮内固化摘要输出绝对上限（P2），常态取值由剖面比例决定。 */
  consolidationSummary: 2_000,
});

/** 每轮封顶：问 ≤500，答 ≤1,000（设计 §2.1）。 */
export const QA_TURN_QUESTION_MAX_TOKENS = 500;
export const QA_TURN_ANSWER_MAX_TOKENS = 1_000;

export interface QaZoneBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  promptBudgetTokens: number;
  staticPrefix: number;
  rollingSummary: number;
  shortTerm: number;
  dynamic: number;
  questionConstraint: number;
  /** 知识库 ReAct 记忆信封预算；非知识库剖面为 0。 */
  memoryEnvelope: number;
  /** 知识库 ReAct 轮内固化摘要输出预算（P2）；非知识库剖面为 0。 */
  consolidationSummary: number;
}

/**
 * 场景化预算剖面（设计 §4.1–§4.4）。
 * 组件上限 = min(绝对上限, 比例 × P)；知识库剖面 D 为固定预留，
 * 实际证据不足时差额归 headroom，不回分给记忆分区。
 */
export function resolveQaZoneBudget(scope: QaSessionScope, contextWindowTokens?: number): QaZoneBudget {
  const windowTokens = Number.isSafeInteger(contextWindowTokens) && (contextWindowTokens ?? 0) > 0
    ? contextWindowTokens!
    : ASSISTANT_CONTEXT_BUDGET_TOKENS;
  const outputReserveTokens = Math.min(8_192, Math.floor(windowTokens * 0.125));
  const safetyReserveTokens = Math.max(2_048, Math.floor(windowTokens * 0.04));
  const promptBudgetTokens = Math.max(0, windowTokens - outputReserveTokens - safetyReserveTokens);
  const proportional = (ratio: number) => Math.floor(promptBudgetTokens * ratio);
  const staticPrefix = Math.min(QA_ZONE_ABSOLUTE_LIMITS.staticPrefix, Math.max(500, proportional(0.017)));
  const rollingSummary = Math.min(QA_ZONE_ABSOLUTE_LIMITS.rollingSummary, proportional(0.034));
  const shortTerm = scope === 'chat'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.shortTermChatElastic, proportional(0.102))
    : Math.min(QA_ZONE_ABSOLUTE_LIMITS.shortTerm, proportional(0.068));
  const dynamic = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.dynamic, proportional(0.17))
    : 0;
  const questionConstraint = Math.min(QA_ZONE_ABSOLUTE_LIMITS.questionConstraint, proportional(0.013));
  const memoryEnvelope = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.memoryEnvelope, proportional(0.05))
    : 0;
  const consolidationSummary = scope === 'knowledge-base'
    ? Math.min(QA_ZONE_ABSOLUTE_LIMITS.consolidationSummary, proportional(0.025))
    : 0;
  return {
    contextWindowTokens: windowTokens,
    outputReserveTokens,
    safetyReserveTokens,
    promptBudgetTokens,
    staticPrefix,
    rollingSummary,
    shortTerm,
    dynamic,
    questionConstraint,
    memoryEnvelope,
    consolidationSummary,
  };
}

export interface QaShortTermZone {
  text: string;
  tokens: number;
  includedTurnSeqs: number[];
}

export interface QaShortTermEntry {
  turn: QaStoredTurn;
  question: string;
  answer: string;
  content: string;
}

/**
 * M2 短期记忆装配（设计 §2.3，保新弃旧）：
 * 从最新轮开始填充预算，超额时最旧轮先被截短再整体丢弃；
 * 渲染时反转为时间正序。用户问题保尾部，助手回答保头部。
 */
export function buildQaShortTermZone(hotTurnsNewestFirst: QaStoredTurn[], budgetTokens: number): QaShortTermZone {
  const entries = selectQaShortTermEntries(hotTurnsNewestFirst, budgetTokens);
  if (entries.length === 0) return { text: '', tokens: 0, includedTurnSeqs: [] };
  const text = ['[Zone M2 短期记忆]', ...entries.map((entry) => entry.content)].join('\n');
  return { text, tokens: estimateTokenCount(text), includedTurnSeqs: entries.map((entry) => entry.turn.turnSeq) };
}

/** Same M2 selection as the legacy renderer, but keeps one record per Turn. */
export function selectQaShortTermEntries(hotTurnsNewestFirst: QaStoredTurn[], budgetTokens: number): QaShortTermEntry[] {
  if (budgetTokens <= 0 || hotTurnsNewestFirst.length === 0) return [];
  let remaining = budgetTokens - estimateTokenCount('[Zone M2 短期记忆]');
  if (remaining <= 0) return [];
  const selected: QaShortTermEntry[] = [];
  for (const turn of hotTurnsNewestFirst.slice(0, QA_HOT_TURN_COUNT)) {
    const question = truncateByTokens(turn.userText, Math.min(QA_TURN_QUESTION_MAX_TOKENS, remaining), 'tail');
    remaining -= estimateTokenCount(question);
    const answer = truncateByTokens(turn.assistantText ?? '', Math.min(QA_TURN_ANSWER_MAX_TOKENS, remaining), 'head');
    remaining -= estimateTokenCount(answer);
    if (!question && !answer) break;
    const lines: string[] = [];
    if (question) lines.push(`轮${turn.turnSeq} 用户：${question}`);
    if (answer) lines.push(`轮${turn.turnSeq} 助手：${answer}`);
    selected.push({ turn, question, answer, content: lines.join('\n') });
    if (remaining <= 0) break;
  }
  return selected.reverse();
}

export interface QaRollingSummaryZone {
  text: string;
  tokens: number;
  includedBatchCount: number;
}

export interface QaRollingSummarySelection {
  blocks: QaSummaryBlock[];
  tokens: number;
}

/**
 * M1 滚动摘要装配（设计 §3.3）：批次正序拼接、总封顶内
 * 从最新批次回填，超额时整块丢弃最旧批次（不做块内截断）。
 */
export function buildQaRollingSummaryZone(blocksAscending: QaSummaryBlock[], budgetTokens: number): QaRollingSummaryZone {
  const selected = selectQaRollingSummaryBlocks(blocksAscending, budgetTokens);
  if (selected.blocks.length === 0) return { text: '', tokens: 0, includedBatchCount: 0 };
  const text = ['[Zone M1 滚动摘要]', ...selected.blocks.map((block) => renderQaSummaryBlock(block))].join('\n');
  return { text, tokens: estimateTokenCount(text), includedBatchCount: selected.blocks.length };
}

/** Same M1 selection as the legacy renderer, retaining independent batches. */
export function selectQaRollingSummaryBlocks(blocksAscending: QaSummaryBlock[], budgetTokens: number): QaRollingSummarySelection {
  const usable = blocksAscending.filter((block) => block.status === 'done' && block.summaryText.trim() !== '');
  if (budgetTokens <= 0 || usable.length === 0) return { blocks: [], tokens: 0 };
  const selected: QaSummaryBlock[] = [];
  let used = estimateTokenCount('[Zone M1 滚动摘要]');
  if (used > budgetTokens) return { blocks: [], tokens: 0 };
  for (const block of [...usable].reverse()) {
    const blockTokens = estimateTokenCount(renderQaSummaryBlock(block));
    if (used + blockTokens > budgetTokens) {
      if (selected.length === 0) break;
      continue; // 超预算的更旧批次整块丢弃，不做块内截断（设计 §3.3）
    }
    selected.push(block);
    used += blockTokens;
  }
  selected.sort((left, right) => left.turnFrom - right.turnFrom);
  return { blocks: selected, tokens: used };
}

/** 摘要块渲染（设计 §3.5）：头行标注批次、轮次范围与压缩器。 */
export function renderQaSummaryBlock(block: QaSummaryBlock): string {
  const batchIndex = Math.floor((block.turnFrom - (QA_HOT_TURN_COUNT + 1)) / 3) + 1;
  return `[批次 #${batchIndex} · 轮${block.turnFrom}-${block.turnTo} · ${block.compressor}]\n${block.summaryText.trim()}`;
}

/** 按 §1 顺序拼接 M1 与 M2（静态策略与 D/Q/C 由调用方负责）。 */
export function combineQaMemoryZones(rollingSummary: QaRollingSummaryZone, shortTerm: QaShortTermZone): {
  memoryZonesText: string;
  rollingSummaryTokens: number;
  shortTermTokens: number;
} {
  const parts = [rollingSummary.text, shortTerm.text].filter((part) => part !== '');
  return {
    memoryZonesText: parts.join('\n\n'),
    rollingSummaryTokens: rollingSummary.tokens,
    shortTermTokens: shortTerm.tokens,
  };
}

/** token 级截断：keep='head' 保头部，keep='tail' 保尾部（设计 §2.2）。 */
export function truncateByTokens(value: string, maximumTokens: number, keep: 'head' | 'tail'): string {
  const trimmed = value.trim();
  if (maximumTokens <= 0 || !trimmed) return '';
  if (estimateTokenCount(trimmed) <= maximumTokens) return trimmed;
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const slice = keep === 'head' ? trimmed.slice(0, middle) : trimmed.slice(trimmed.length - middle);
    if (estimateTokenCount(slice) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  if (low <= 0) return '';
  const slice = keep === 'head' ? trimmed.slice(0, low) : trimmed.slice(trimmed.length - low);
  return keep === 'head' ? `${slice}…` : `…${slice}`;
}
