import { resolveWorkingMemoryWindowTokens } from '../../../shared/effectiveContextWindow';
import { estimateTokenCount } from '../tokenEstimator';
import type { ReActChatMessage } from './reactChatTransport';

/**
 * 旧观察预算字段继续供灰度诊断和工具侧兼容使用。WK-M7 的实际发送预算
 * 由当前轮工具结果投影承担，不再因这里的固定值拒绝工具或污染规范化消息。
 */

export const OBSERVATION_TRUNCATION_MARKER = '…[内容已按观察预算截断]';

export interface ObservationBudget {
  /** 单条观察上限（字符）。 */
  maxSingleObservationChars: number;
  /** 全轮观察总量上限（估算 token）。 */
  maxTotalObservationTokens: number;
}

export const CURRENT_TURN_TOOL_RESULT_RATIO = 0.2;
export const CURRENT_TURN_TOOL_RESULT_MIN_TOKENS = 8_192;
export const CURRENT_TURN_TOOL_RESULT_MAX_TOKENS = 32_768;
export const TOOL_RESULT_PREVIEW_HEAD_RATIO = 0.25;
export const TOOL_RESULT_BUDGET_MARKER = '[tool result omitted by current-turn working-memory budget]';

export interface ToolResultBudgetProjection {
  messages: ReActChatMessage[];
  workingMemoryWindowTokens: number;
  budgetTokens: number;
  projectedToolResultTokens: number;
  toolResultCount: number;
  truncatedCount: number;
}

/** 与项目既有启发式一致的粗估：中文按 1 字符 ≈ 1 token，其余 ≈ 0.3。 */
export function estimateObservationTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    tokens += code >= 0x2e80 ? 1 : 0.35;
  }
  return Math.ceil(tokens);
}

/** 截断单条观察到预算内，并在截断处附标注。 */
export function truncateObservation(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - OBSERVATION_TRUNCATION_MARKER.length))}${OBSERVATION_TRUNCATION_MARKER}`;
}

/** Fallback chat framing: +3 tokens per message and +3 tokens at the tail. */
export function estimateReActMessagesTokens(messages: readonly ReActChatMessage[]): number {
  return 3 + messages.reduce((total, message) => {
    const toolCallTokens = message.toolCalls?.length
      ? estimateTokenCount(JSON.stringify(message.toolCalls))
      : 0;
    const metadataTokens = estimateTokenCount(`${message.role}\n${message.toolCallId ?? ''}\n${message.toolName ?? ''}`);
    const imageTokens = (message.images?.length ?? 0) * 85;
    return total
      + 3
      + estimateTokenCount(message.content)
      + estimateTokenCount(message.reasoningContent ?? '')
      + toolCallTokens
      + metadataTokens
      + imageTokens;
  }, 0);
}

export function resolveCurrentTurnToolResultBudgetTokens(contextWindowTokens?: number): number {
  const workingMemoryWindowTokens = resolveWorkingMemoryWindowTokens(contextWindowTokens);
  return Math.min(
    CURRENT_TURN_TOOL_RESULT_MAX_TOKENS,
    Math.max(CURRENT_TURN_TOOL_RESULT_MIN_TOKENS, Math.floor(workingMemoryWindowTokens * CURRENT_TURN_TOOL_RESULT_RATIO)),
  );
}

/**
 * Builds a provider-only projection. The canonical runtime/tool messages stay
 * untouched, newest tool results receive budget first, and partial previews
 * retain roughly 1/4 head + 3/4 tail while keeping tool ids/names intact.
 */
export function projectCurrentTurnToolResults(
  messages: readonly ReActChatMessage[],
  currentTurnStartIndex: number,
  contextWindowTokens?: number,
): ToolResultBudgetProjection {
  const projected = messages.map(copyMessage);
  const workingMemoryWindowTokens = resolveWorkingMemoryWindowTokens(contextWindowTokens);
  const budgetTokens = resolveCurrentTurnToolResultBudgetTokens(workingMemoryWindowTokens);
  const toolIndexes = projected
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index > currentTurnStartIndex && message.role === 'tool')
    .map(({ index }) => index);
  const placeholderTokens = toolIndexes.reduce(
    (sum, index) => sum + estimateTokenCount(buildToolBudgetPlaceholder(projected[index])),
    0,
  );
  let remainingTokens = Math.max(0, budgetTokens - placeholderTokens);
  let truncatedCount = 0;

  for (const index of [...toolIndexes].reverse()) {
    const message = projected[index];
    const placeholder = buildToolBudgetPlaceholder(message);
    const placeholderCost = estimateTokenCount(placeholder);
    const fullCost = estimateTokenCount(message.content);
    const extraCost = Math.max(0, fullCost - placeholderCost);
    if (extraCost <= remainingTokens) {
      remainingTokens -= extraCost;
      continue;
    }
    truncatedCount += 1;
    if (remainingTokens <= 0) {
      message.content = placeholder;
      continue;
    }
    message.content = truncateToolResultPreview(message.content, placeholderCost + remainingTokens, placeholder);
    remainingTokens = 0;
  }

  return {
    messages: projected,
    workingMemoryWindowTokens,
    budgetTokens,
    projectedToolResultTokens: toolIndexes.reduce((sum, index) => sum + estimateTokenCount(projected[index].content), 0),
    toolResultCount: toolIndexes.length,
    truncatedCount,
  };
}

export function truncateToolResultPreview(text: string, maxTokens: number, fallback = TOOL_RESULT_BUDGET_MARKER): string {
  if (estimateTokenCount(text) <= maxTokens) return text;
  if (estimateTokenCount(fallback) > maxTokens) return fallback;
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  let best = fallback;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const headLength = Math.ceil(keep * TOOL_RESULT_PREVIEW_HEAD_RATIO);
    const tailLength = Math.max(0, keep - headLength);
    const marker = `\n…[tool result truncated; ${codePoints.length - keep} code points omitted]…\n`;
    const candidate = `${codePoints.slice(0, headLength).join('')}${marker}${tailLength > 0 ? codePoints.slice(-tailLength).join('') : ''}`;
    if (estimateTokenCount(candidate) <= maxTokens) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}

function buildToolBudgetPlaceholder(message: ReActChatMessage): string {
  const identity = Array.from([message.toolName, message.toolCallId].filter(Boolean).join(':')).slice(0, 80).join('');
  return identity ? `${TOOL_RESULT_BUDGET_MARKER} (${identity})` : TOOL_RESULT_BUDGET_MARKER;
}

function copyMessage(message: ReActChatMessage): ReActChatMessage {
  return {
    ...message,
    ...(message.images?.length ? { images: [...message.images] } : {}),
    ...(message.toolCalls?.length ? {
      toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })),
    } : {}),
  };
}

/**
 * 旧观察预算执行器：保留 accept/canObserve 供兼容调用和灰度对照。
 * WK-M7 主引擎只调用 observe 记录原始规模，真实发送限制由 provider 投影完成。
 */
export class ObservationBudgetTracker {
  private totalTokens = 0;
  private totalChars = 0;

  constructor(private readonly budget: ObservationBudget) {}

  get usedTokens(): number {
    return this.totalTokens;
  }

  get usedChars(): number {
    return this.totalChars;
  }

  canObserve(): boolean {
    return this.totalTokens < this.budget.maxTotalObservationTokens;
  }

  /** WK-M7 diagnostic-only accounting; unlike accept(), this never truncates. */
  observe(text: string): void {
    this.totalTokens += estimateObservationTokens(text);
    this.totalChars += text.length;
  }

  /** 先截断再计入预算；返回实际写入消息的观察文本。 */
  accept(text: string): string {
    const remainingTokens = Math.max(0, this.budget.maxTotalObservationTokens - this.totalTokens);
    // 剩余预算很小时按剩余比例进一步压缩单条观察，避免一次性打满。
    const charCap = remainingTokens < 1500
      ? Math.min(this.budget.maxSingleObservationChars, Math.max(400, remainingTokens * 2))
      : this.budget.maxSingleObservationChars;
    const truncated = truncateObservation(text, Math.max(0, Math.floor(charCap)));
    this.totalTokens += estimateObservationTokens(truncated);
    this.totalChars += truncated.length;
    return truncated;
  }
}

/** 全局递增的引用号分配器：[1]、[2]、[3]… */
export class CitationReferenceAllocator {
  private next = 1;

  get count(): number {
    return this.next - 1;
  }

  allocate(): string {
    const reference = `[${this.next}]`;
    this.next += 1;
    return reference;
  }
}
