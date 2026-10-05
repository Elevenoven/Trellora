import { resolveAiModelDescriptor } from './aiModelCapabilities';
import type { AiProviderConfig } from './aiTypes';
import { estimateTokenCount } from './tokenEstimator';
import type { SelectionEditAction } from './selectionEditTypes';

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MIN_OUTPUT_TOKENS = 256;
const REQUEST_MARGIN_TOKENS = 64;
const MAX_SUGGESTION_CHARACTERS = 40_000;

export interface SelectionEditPromptBudget {
  contextWindowTokens: number;
  promptTokens: number;
  maxOutputTokens: number;
  totalTokens: number;
}

/**
 * This is deliberately evaluated on the fully assembled prompt immediately
 * before a provider request. Static text-length limits cannot account for
 * nearby context, verified evidence, or the selected model's real window.
 */
export function resolveSelectionEditPromptBudget(input: {
  config: AiProviderConfig;
  model: string;
  action: SelectionEditAction;
  selectedText: string;
  prompt: string;
  targetCharacters?: number;
}): SelectionEditPromptBudget {
  const descriptor = resolveAiModelDescriptor(input.config, input.model);
  const outputCharacters = input.targetCharacters ?? Math.max(
    input.selectedText.length * (input.action === 'expand' || input.action === 'explain' ? 2 : 1),
    320,
  );
  const expectedOutputTokens = estimateTokenCount('扩'.repeat(Math.min(MAX_SUGGESTION_CHARACTERS, outputCharacters))) + 128;
  const maxOutputTokens = Math.min(
    descriptor.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, expectedOutputTokens)),
  );
  const promptTokens = estimateTokenCount(input.prompt);
  return {
    contextWindowTokens: descriptor.contextWindowTokens,
    promptTokens,
    maxOutputTokens,
    totalTokens: promptTokens + maxOutputTokens + REQUEST_MARGIN_TOKENS,
  };
}

export function assertSelectionEditPromptFitsContext(input: Parameters<typeof resolveSelectionEditPromptBudget>[0]): SelectionEditPromptBudget {
  const budget = resolveSelectionEditPromptBudget(input);
  if (budget.totalTokens > budget.contextWindowTokens) {
    throw new Error(
      `AI 编辑请求预计需要 ${budget.totalTokens.toLocaleString('zh-CN')} token（提示词约 ${budget.promptTokens.toLocaleString('zh-CN')}，预留输出 ${budget.maxOutputTokens.toLocaleString('zh-CN')}），超过当前模型 ${budget.contextWindowTokens.toLocaleString('zh-CN')} token 的上下文窗口。请缩小选区、减少上下文范围，或切换上下文窗口更大的模型。`,
    );
  }
  return budget;
}
