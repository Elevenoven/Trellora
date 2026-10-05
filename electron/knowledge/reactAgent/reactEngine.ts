import type { ReActChatMessage, ReActChatRequest, ReActToolSchema } from './reactChatTransport';
import type { ReActToolCall } from './reactChatTransport';
import { reactToolCallSignature } from './toolRegistry';
import {
  ObservationBudgetTracker,
  estimateReActMessagesTokens,
  projectCurrentTurnToolResults,
} from './toolResultBudget';
import type { AssistantTokenUsage } from '../tokenEstimator';
import { estimateTokenCount } from '../tokenEstimator';
import type { AssistantModelInputCompression } from '../assistantTurnTypes';
import { observeToolObservationS0 } from '../dynamicMemoryS0Observe';
import { stripInlineThinkBlocks } from '../qaCanonicalHistory';
import {
  DEFAULT_REACT_BUDGET,
  DEFAULT_REACT_TERMINAL_POLICY,
  type ReActBudget,
  type ReActEngineInput,
  type ReActResult,
  type ReActStopReason,
  type ReActTerminalPolicy,
} from './reactEngineTypes';

export { DEFAULT_REACT_BUDGET, DEFAULT_REACT_TERMINAL_POLICY } from './reactEngineTypes';

const DUPLICATE_ACTION_REPLY = '该检索在本会话已执行过，结果见上；请换一个角度或直接作答。';
/** 轮内固化摘要提示（对齐 WeKnora consolidator：低温度、只出摘要、失败降级原文归档）。 */
const CONSOLIDATION_SYSTEM_PROMPT = '你是对话历史压缩器。请把下面的多轮对话记录压缩成一份紧凑中文摘要：保留任务目标、已确认的事实与结论、检索证据要点及其引用号，省略寒暄、重复与过程性描述。只输出摘要本身，不要输出解释。';
const CONSOLIDATION_TEMPERATURE = 0.3;
const MEMORY_SUMMARY_PREFIX = '[Memory Summary -';

interface LoopCounters {
  modelCalls: number;
  maintenanceModelCalls: number;
  toolCalls: number;
  emptyRetries: number;
  rounds: number;
  consolidations: number;
}

export async function runReActLoop<TContext>(input: ReActEngineInput<TContext>): Promise<ReActResult> {
  const budget: ReActBudget = { ...DEFAULT_REACT_BUDGET, ...(input.budget ?? {}) };
  const terminalPolicy: ReActTerminalPolicy = { ...DEFAULT_REACT_TERMINAL_POLICY, ...(input.terminalPolicy ?? {}) };
  const tracker = input.observationTracker ?? new ObservationBudgetTracker(budget);
  const messages: ReActChatMessage[] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history,
    { role: 'user', content: input.question, ...(input.images?.length ? { images: input.images } : {}) },
  ];
  // 本轮问题位置：固化只能触碰它之前的消息，本轮尾部完整保留。
  let questionIndex = messages.length - 1;
  const counters: LoopCounters = { modelCalls: 0, maintenanceModelCalls: 0, toolCalls: 0, emptyRetries: 0, rounds: 0, consolidations: 0 };
  const executedSignatures = new Set<string>();
  const collectedObservations: Array<{ tool: string; observation: string }> = [];
  const agentMessages: ReActChatMessage[] = [];
  let usage: AssistantTokenUsage | undefined;
  let lastUsage: AssistantTokenUsage | undefined;
  let lastPromptTokens = 0;
  let workingMemoryTokenAdjustment = 0;
  let workingMemoryTokenSource: 'estimate' | 'provider-anchored' = 'estimate';
  /** 已流式投影到 UI 的答案字符数；只有模型转工具调用时才清零并收回。 */
  let uiAnswerChars = 0;
  let consecutiveSameContent = 0;
  let lastContent = '';
  let stopDetail: string | undefined;

  const citations = () => input.collectCitations?.() ?? [];
  const finish = (
    finalAnswer: string,
    stopReason: ReActStopReason,
    detail?: string,
    finalReasoningContent?: string,
  ): ReActResult => {
    const normalizedAnswer = normalizeReActFinalAnswer(finalAnswer, terminalPolicy);
    if (normalizedAnswer !== finalAnswer.trim() && uiAnswerChars > 0) {
      uiAnswerChars = 0;
      input.onAnswerReset?.();
    }
    return {
      finalAnswer: normalizedAnswer,
      agentMessages: agentMessages.map(copyReplayMessage),
      ...(finalReasoningContent ? { finalReasoningContent } : {}),
      stopReason,
      rounds: counters.rounds,
      modelCalls: counters.modelCalls,
      maintenanceModelCalls: counters.maintenanceModelCalls,
      toolCalls: counters.toolCalls,
      consolidations: counters.consolidations,
      citations: citations(),
      usage,
      ...(lastUsage ? { lastUsage } : {}),
      ...(lastPromptTokens > 0 ? { lastPromptTokens } : {}),
      streamedAnswerChars: Math.min(uiAnswerChars, normalizedAnswer.length),
      ...(detail ? { stopDetail: detail } : {}),
    };
  };

  // 用户取消只停止后续工作。已经投影到 UI 的正文由调用方保留，不再清空或改写成兜底回答。
  const cancelLoop = (detail: string): never => {
    const error = new Error(detail);
    error.name = 'AbortError';
    throw error;
  };

  for (let round = 0; round < budget.maxIterations; round += 1) {
    counters.rounds = round + 1;
    if (input.signal.aborted) {
      cancelLoop('任务已取消。');
    }
    if (counters.modelCalls >= budget.maxModelCalls) {
      stopDetail = `模型调用次数达到上限 ${budget.maxModelCalls}，触发兜底合成。`;
      break;
    }

    const workingMemory = await prepareWorkingMemory({
      input: input as ReActEngineInput<unknown>,
      budget,
      messages,
      questionIndex,
      counters,
      tokenAdjustment: workingMemoryTokenAdjustment,
      tokenSource: workingMemoryTokenSource,
      onUsage: (incoming) => {
        usage = mergeUsage(usage, incoming);
      },
    });
    if (workingMemory.aborted) {
      cancelLoop('任务在轮内固化期间被取消。');
    }
    questionIndex = workingMemory.questionIndex;
    const providerMessages = workingMemory.providerMessages;

    // 1. Think：带 tools 的 function calling
    const toolSchemas = input.registry.schemas();
    lastPromptTokens = estimateProviderPromptTokens(providerMessages, toolSchemas);
    const serializedPromptText = serializeMessagesForBudget(providerMessages, toolSchemas);
    const prepared = input.onModelCall?.({
      callIndex: counters.modelCalls + 1,
      estimatedPromptChars: estimateMessageChars(providerMessages),
      estimatedPromptTokens: lastPromptTokens,
      serializedPromptText,
    }) ?? { ready: true };
    if (!prepared.ready) {
      if (prepared.reason === 'context-budget') {
        return finish(terminalPolicy.contextHardLimitReply, 'budget-synthesized', '最终模型发送被 maxPromptTokens 硬门禁拒绝。');
      }
      stopDetail = prepared.reason ?? '模型调用计费熔断，触发兜底合成。';
      break;
    }
    if (prepared.maxPromptTokens !== undefined && lastPromptTokens > prepared.maxPromptTokens) {
      return finish(terminalPolicy.contextHardLimitReply, 'budget-synthesized', `工作记忆 ${lastPromptTokens} token 超过 provider maxPromptTokens ${prepared.maxPromptTokens}。`);
    }
    counters.modelCalls += 1;
    input.onTrace?.({ stage: 'react', action: 'think', status: 'started', detail: { round: counters.rounds, model: input.model, promptChars: estimateMessageChars(providerMessages), promptTokens: lastPromptTokens } });
    const modelCallStartedAt = Date.now();
    input.onModelRound?.({
      round: counters.rounds,
      callKind: 'decide',
      state: 'started',
      messages: providerMessages,
      ...(workingMemory.inputCompression ? { inputCompression: workingMemory.inputCompression } : {}),
    });
    let toolCallStarted = false;
    let response;
    const providerRequest: ReActChatRequest = {
      messages: providerMessages,
      tools: toolSchemas,
      model: input.model,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
      signal: input.signal,
      // 流式投影：文本增量直转 UI；模型转工具调用时由适配器回调 onToolCallStart 收回。
      ...(input.onAnswerDelta || input.onThinkingDelta ? {
        onDelta: (text: string) => {
          if (toolCallStarted || !input.onAnswerDelta) return;
          uiAnswerChars += text.length;
          input.onAnswerDelta(text);
        },
        ...(input.onThinkingDelta ? { onThinkingDelta: input.onThinkingDelta } : {}),
        onToolCallStart: () => {
          toolCallStarted = true;
          if (uiAnswerChars > 0) {
            uiAnswerChars = 0;
            input.onAnswerReset?.();
          }
        },
      } : {}),
    };
    try {
      response = await input.transport.chat(input.config, providerRequest);
      notifyProviderObservation(input, {
        callKind: 'react-decide',
        round: counters.rounds,
        request: providerRequest,
        responseCompleted: true,
        usage: response.usage,
      });
    } catch (error) {
      notifyProviderObservation(input, {
        callKind: 'react-decide',
        round: counters.rounds,
        request: providerRequest,
        responseCompleted: false,
      });
      input.onModelRound?.({
        round: counters.rounds,
        callKind: 'decide',
        state: 'rejected',
        messages: providerMessages,
        ...(workingMemory.inputCompression ? { inputCompression: workingMemory.inputCompression } : {}),
        errorCode: input.signal.aborted ? 'cancelled' : 'provider-or-transport-error',
        elapsedMs: Date.now() - modelCallStartedAt,
      });
      input.onTrace?.({ stage: 'react', action: 'think', status: 'failed', detail: { round: counters.rounds, error: error instanceof Error ? error.message : String(error) } });
      if (input.signal.aborted) {
        cancelLoop('任务已取消。');
      }
      throw error;
    }
    input.onModelRound?.({
      round: counters.rounds,
      callKind: 'decide',
      state: 'completed',
      messages: providerMessages,
      ...(workingMemory.inputCompression ? { inputCompression: workingMemory.inputCompression } : {}),
      response: { content: response.content, toolCalls: response.toolCalls },
      elapsedMs: Date.now() - modelCallStartedAt,
    });
    input.onTrace?.({ stage: 'react', action: 'think', status: 'completed', detail: { round: counters.rounds, toolCallCount: response.toolCalls.length, contentLength: response.content.length } });
    usage = mergeUsage(usage, response.usage);
    lastUsage = response.usage;
    if (response.usage?.inputTokens !== undefined) {
      workingMemoryTokenAdjustment = response.usage.inputTokens - estimateReActMessagesTokens(providerMessages);
      workingMemoryTokenSource = 'provider-anchored';
    }

    // 2. Analyze：无 tool_calls 且有文本 → 终答；空回答 → 有限重试
    if (response.toolCalls.length === 0) {
      const text = response.content.trim();
      if (text) {
        const gate = input.onBeforeFinalAnswer?.({
          round: counters.rounds,
          answer: response.content,
          toolCalls: counters.toolCalls,
          citations: citations(),
        });
        if (gate && !gate.accept) {
          if (uiAnswerChars > 0) {
            uiAnswerChars = 0;
            input.onAnswerReset?.();
          }
          const nudge = gate.nudge?.trim() || '现有证据还不足以结束，请继续执行一次新的合法检索，再评估是否可以作答。';
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: nudge });
          input.onTrace?.({
            stage: 'react',
            action: 'final-answer-gate',
            status: 'completed',
            detail: { round: counters.rounds, accepted: false, ...gate.detail },
          });
          consecutiveSameContent = 0;
          lastContent = '';
          continue;
        }
        if (gate) {
          input.onTrace?.({
            stage: 'react',
            action: 'final-answer-gate',
            status: 'completed',
            detail: { round: counters.rounds, accepted: true, ...gate.detail },
          });
        }
        if (text === lastContent) {
          consecutiveSameContent += 1;
          if (consecutiveSameContent >= budget.maxRepeatedContentRounds) {
            stopDetail = `连续 ${budget.maxRepeatedContentRounds} 轮输出相同内容，判定为卡死并采用该回答。`;
            return finish(response.content, 'natural', stopDetail, response.reasoningContent);
          }
        } else {
          consecutiveSameContent = 1;
        }
        lastContent = text;
        return finish(response.content, 'natural', undefined, response.reasoningContent);
      }
      counters.emptyRetries += 1;
      if (counters.emptyRetries > budget.maxEmptyRetries) {
        stopDetail = '模型连续返回空内容且重试耗尽，触发兜底合成。';
        break;
      }
      messages.push({ role: 'user', content: terminalPolicy.emptyRetryNudge });
      continue;
    }

    consecutiveSameContent = 0;
    lastContent = response.content;
    const assistantToolMessage: ReActChatMessage = {
      role: 'assistant',
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      toolCalls: response.toolCalls,
    };
    messages.push(assistantToolMessage);
    agentMessages.push(copyReplayMessage(assistantToolMessage));

    // 3. Act：逐个执行工具（第一期串行，保持事件顺序与可取消性）
    for (const call of response.toolCalls) {
      if (input.signal.aborted) {
        cancelLoop('任务已取消。');
      }
      counters.toolCalls += 1;
      const toolOutcome = await executeSingleTool(call, {
        input: input as ReActEngineInput<unknown>, budget, terminalPolicy, tracker, executedSignatures, collectedObservations, counters,
        onRoundEvent: (state, message, referenceCount, publicResults) => input.onRound?.({ round: counters.rounds, tool: call.name, state, message, ...(referenceCount !== undefined ? { referenceCount } : {}), ...(publicResults?.length ? { publicResults } : {}) }),
      });
      // 4. Observe：tool message 追加，进入下一轮
      const toolMessage: ReActChatMessage = { role: 'tool', toolCallId: call.id, toolName: call.name, content: toolOutcome.observation };
      messages.push(toolMessage);
      agentMessages.push(copyReplayMessage(toolMessage));
      if (toolOutcome.images.length > 0) {
        const questionMessage = messages[questionIndex];
        if (questionMessage?.role === 'user') {
          questionMessage.images = mergeTransportImages(questionMessage.images ?? [], toolOutcome.images);
        }
      }
      if (counters.toolCalls >= budget.maxToolCalls && round < budget.maxIterations - 1) {
        messages.push({ role: 'user', content: terminalPolicy.toolCallLimitReply });
      }
    }
  }

  // 超轮次 / 熔断：抢救合成（对应 WeKnora handleMaxIterations）
  const synthesized = await synthesizeFromEvidence(input, messages, questionIndex, budget, terminalPolicy, counters, workingMemoryTokenAdjustment, workingMemoryTokenSource, collectedObservations, usage, input.onAnswerDelta
    ? (text) => {
      uiAnswerChars += text.length;
      input.onAnswerDelta?.(text);
    }
    : undefined);
  usage = synthesized.usage ?? usage;
  if (synthesized.lastUsage) lastUsage = synthesized.lastUsage;
  if (synthesized.lastPromptTokens) lastPromptTokens = synthesized.lastPromptTokens;
  return finish(
    synthesized.answer,
    'budget-synthesized',
    stopDetail ?? `ReAct 循环轮数达到上限 ${budget.maxIterations}，触发兜底合成。`,
    synthesized.reasoningContent,
  );
}

/**
 * Knowledge ReAct prompts wrap the user-facing terminal answer so any provider
 * preamble stays out of the answer surface. Other ReAct callers remain backward
 * compatible because unwrapped answers pass through unchanged.
 */
function normalizeReActFinalAnswer(answer: string, terminalPolicy: ReActTerminalPolicy): string {
  const withoutThink = stripInlineThinkBlocks(answer);
  if (terminalPolicy.finalAnswerNormalization === 'trim') return withoutThink;
  const openingTag = '<final_answer>';
  const closingTag = '</final_answer>';
  const normalizedCase = withoutThink.toLocaleLowerCase('en-US');
  const openingIndex = normalizedCase.indexOf(openingTag);
  if (openingIndex < 0) return withoutThink;

  const contentStart = openingIndex + openingTag.length;
  const closingIndex = normalizedCase.indexOf(closingTag, contentStart);
  const extracted = withoutThink.slice(contentStart, closingIndex < 0 ? undefined : closingIndex).trim();
  return extracted || withoutThink;
}

function copyReplayMessage(message: ReActChatMessage): ReActChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.toolCalls?.length ? {
      toolCalls: message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: { ...call.arguments },
      })),
    } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

interface SingleToolContext {
  input: ReActEngineInput<unknown>;
  budget: ReActBudget;
  terminalPolicy: ReActTerminalPolicy;
  tracker: ObservationBudgetTracker;
  executedSignatures: Set<string>;
  collectedObservations: Array<{ tool: string; observation: string }>;
  counters: LoopCounters;
  onRoundEvent: (state: 'started' | 'completed' | 'failed' | 'rejected', message: string, referenceCount?: number, publicResults?: import('../assistantTurnTypes').AssistantPublicToolResultView[]) => void;
}

interface SingleToolOutcome {
  observation: string;
  images: import('../aiGenerationTransport').AiTransportImage[];
}

async function executeSingleTool(call: ReActToolCall, ctx: SingleToolContext): Promise<SingleToolOutcome> {
  const { input, budget, terminalPolicy, tracker } = ctx;

  // 工具调用次数上限：直接回观察，不再执行。
  if (ctx.counters.toolCalls > budget.maxToolCalls) {
    ctx.onRoundEvent('rejected', `工具调用次数超过上限 ${budget.maxToolCalls}，已拒绝。`);
    return { observation: `<tool_error>${terminalPolicy.toolCallLimitReply}</tool_error>`, images: [] };
  }

  const validationError = input.registry.validate(call);
  if (validationError) {
    ctx.onRoundEvent('rejected', validationError);
    return { observation: `<tool_error>${validationError}</tool_error>`, images: [] };
  }

  const signature = reactToolCallSignature(call.name, call.arguments);
  if (ctx.executedSignatures.has(signature)) {
    ctx.onRoundEvent('rejected', '重复动作签名命中，已拒绝重复执行。');
    return { observation: `<tool_error>${DUPLICATE_ACTION_REPLY}</tool_error>`, images: [] };
  }

  const tool = input.registry.get(call.name);
  if (!tool) {
    ctx.onRoundEvent('rejected', `未知工具 ${call.name}。`);
    return { observation: `<tool_error>未知工具 ${call.name}。</tool_error>`, images: [] };
  }

  ctx.executedSignatures.add(signature);
  ctx.onRoundEvent('started', `正在执行 ${call.name}…`);
  const startedAt = Date.now();
  try {
    const execution = await tool.execute(call.arguments, input.toolContext);
    const observation = execution.observation;
    tracker.observe(observation);
    if (execution.ok) ctx.collectedObservations.push({ tool: call.name, observation });
    ctx.onRoundEvent(execution.ok ? 'completed' : 'failed', execution.message, execution.referenceCount, execution.publicResults);
    input.onTrace?.({
      stage: 'react', action: 'tool', status: execution.ok ? 'completed' : 'failed',
      detail: {
        tool: call.name,
        arguments: call.arguments,
        elapsedMs: Date.now() - startedAt,
        observationChars: observation.length,
        observationS0: observeToolObservationS0(execution.observation, observation),
        referenceCount: execution.referenceCount,
        imageCount: execution.images?.length ?? 0,
      },
    });
    return { observation, images: execution.images ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.onRoundEvent('failed', `${call.name} 执行失败：${message}`);
    input.onTrace?.({ stage: 'react', action: 'tool', status: 'failed', detail: { tool: call.name, arguments: call.arguments, error: message, elapsedMs: Date.now() - startedAt } });
    return { observation: `<tool_error>工具 ${call.name} 执行失败：${message}。可换一种方式重试或直接作答。</tool_error>`, images: [] };
  }
}

function mergeTransportImages(
  current: readonly import('../aiGenerationTransport').AiTransportImage[],
  incoming: readonly import('../aiGenerationTransport').AiTransportImage[],
): import('../aiGenerationTransport').AiTransportImage[] {
  const seen = new Set(current.map((image) => image.dataUrl));
  const merged = [...current];
  for (const image of incoming) {
    if (seen.has(image.dataUrl)) continue;
    seen.add(image.dataUrl);
    merged.push(image);
  }
  return merged;
}

/** 超轮次兜底：再做一次不带工具的合成调用；失败时静态回退。 */
async function synthesizeFromEvidence<TContext>(
  input: ReActEngineInput<TContext>,
  messages: ReActChatMessage[],
  questionIndex: number,
  budget: ReActBudget,
  terminalPolicy: ReActTerminalPolicy,
  counters: LoopCounters,
  tokenAdjustment: number,
  tokenSource: 'estimate' | 'provider-anchored',
  collectedObservations: Array<{ tool: string; observation: string }>,
  priorUsage: AssistantTokenUsage | undefined,
  streamAnswer?: (text: string) => void,
): Promise<{
  answer: string;
  reasoningContent?: string;
  usage?: AssistantTokenUsage;
  lastUsage?: AssistantTokenUsage;
  lastPromptTokens?: number;
}> {
  let accumulatedUsage = priorUsage;
  if (input.signal.aborted) {
    const error = new Error('任务已取消。');
    error.name = 'AbortError';
    throw error;
  }
  if (collectedObservations.length === 0) {
    return { answer: '很抱歉，本次未能在资料库中检索到足够内容。请换个问法，或先确认资料库已完成解析与索引。' };
  }
  const synthesisRuntimeMessages: ReActChatMessage[] = [...messages, { role: 'user', content: terminalPolicy.synthesisInstruction }];
  const workingMemory = await prepareWorkingMemory({
    input: input as ReActEngineInput<unknown>,
    budget,
    messages: synthesisRuntimeMessages,
    questionIndex,
    counters,
    tokenAdjustment,
    tokenSource,
    onUsage: (incoming) => {
      accumulatedUsage = mergeUsage(accumulatedUsage, incoming);
    },
  });
  if (workingMemory.aborted) {
    const error = new Error('任务在轮内固化期间被取消。');
    error.name = 'AbortError';
    throw error;
  }
  const synthesisMessages = workingMemory.providerMessages;
  const promptTokens = estimateReActMessagesTokens(synthesisMessages);
  const serializedPromptText = serializeMessagesForBudget(synthesisMessages);
  const prepared = input.onModelCall?.({
    callIndex: Number.MAX_SAFE_INTEGER,
    estimatedPromptChars: estimateMessageChars(synthesisMessages),
    estimatedPromptTokens: promptTokens,
    serializedPromptText,
  }) ?? { ready: true };
  if (!prepared.ready) {
    if (prepared.reason === 'context-budget') return { answer: terminalPolicy.contextHardLimitReply, lastPromptTokens: promptTokens };
    return { answer: salvageFromEvidence(collectedObservations) };
  }
  if (prepared.maxPromptTokens !== undefined && promptTokens > prepared.maxPromptTokens) {
    return { answer: terminalPolicy.contextHardLimitReply, lastPromptTokens: promptTokens };
  }
  try {
    const providerRequest: ReActChatRequest = {
      messages: synthesisMessages,
      tools: [],
      model: input.model,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.thinkingMode ? { thinkingMode: input.thinkingMode } : {}),
      signal: input.signal,
      // 兜底合成即终答：直接流式投影。
      ...(streamAnswer ? { onDelta: streamAnswer } : {}),
    };
    const response = await input.transport.chat(input.config, providerRequest);
    notifyProviderObservation(input, {
      callKind: 'react-synthesize',
      request: providerRequest,
      responseCompleted: true,
      usage: response.usage,
    });
    const answer = response.content.trim();
    if (!answer) return { answer: salvageFromEvidence(collectedObservations), usage: mergeUsage(accumulatedUsage, response.usage), ...(response.usage ? { lastUsage: response.usage } : {}), lastPromptTokens: promptTokens };
    return {
      answer: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      usage: mergeUsage(accumulatedUsage, response.usage),
      ...(response.usage ? { lastUsage: response.usage } : {}),
      lastPromptTokens: promptTokens,
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { answer: salvageFromEvidence(collectedObservations) };
  }
}

/** 合成调用失败时的静态抢救：把已有证据压成可读摘要。 */
function salvageFromEvidence(collectedObservations: Array<{ tool: string; observation: string }>): string {
  if (collectedObservations.length === 0) {
    return '本次未能基于现有检索结果生成回答，请重试。';
  }
  const lines = ['本次回答未能完成合成，以下是已检索到的证据原文，供参考：', ''];
  for (const [index, entry] of collectedObservations.entries()) {
    lines.push(`【证据 ${index + 1}（来自 ${entry.tool}）】`, entry.observation.slice(0, 2000), '');
  }
  return lines.join('\n').trim();
}

function estimateMessageChars(messages: ReActChatMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function mergeUsage(existing: AssistantTokenUsage | undefined, incoming?: AssistantTokenUsage): AssistantTokenUsage | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return {
    inputTokens: (existing.inputTokens ?? 0) + (incoming.inputTokens ?? 0),
    outputTokens: (existing.outputTokens ?? 0) + (incoming.outputTokens ?? 0),
    totalTokens: (existing.totalTokens ?? 0) + (incoming.totalTokens ?? 0),
    cachedInputTokens: (existing.cachedInputTokens ?? 0) + (incoming.cachedInputTokens ?? 0),
  };
}

function notifyProviderObservation<TContext>(
  input: ReActEngineInput<TContext>,
  event: Parameters<NonNullable<ReActEngineInput<TContext>['onProviderCallObserved']>>[0],
): void {
  try {
    input.onProviderCallObserved?.(event);
  } catch {
    // S0 diagnostics are isolated from the active Think→Act→Observe loop.
  }
}

// ── WK-M7 严格 L1 工作记忆 ────────────────────────────────────────────────────────

interface ConsolidationContext {
  input: ReActEngineInput<unknown>;
  budget: ReActBudget;
  messages: ReActChatMessage[];
  questionIndex: number;
  counters: LoopCounters;
  tokenAdjustment: number;
  tokenSource: 'estimate' | 'provider-anchored';
  onUsage: (incoming?: AssistantTokenUsage) => void;
}

interface ConsolidationOutcome {
  /** 固化后本轮问题在 messages 中的新下标。 */
  questionIndex: number;
  /** 摘要调用期间被取消；调用方应直接终止本轮。 */
  aborted: boolean;
  consolidation?: {
    affectedMessages: number;
    method: 'llm' | 'raw-archive';
  };
}

interface WorkingMemoryOutcome extends ConsolidationOutcome {
  providerMessages: ReActChatMessage[];
  inputCompression?: AssistantModelInputCompression;
}

async function prepareWorkingMemory(ctx: ConsolidationContext): Promise<WorkingMemoryOutcome> {
  const estimatedTokensBefore = applyTokenAdjustment(estimateReActMessagesTokens(ctx.messages), ctx.tokenAdjustment);
  let projection = projectCurrentTurnToolResults(ctx.messages, ctx.questionIndex, ctx.input.contextWindowTokens);
  if (projection.toolResultCount > 0) {
    ctx.input.onTrace?.({
      stage: 'react', action: 'tool-result-budget', status: 'completed',
      detail: {
        workingMemoryWindowTokens: projection.workingMemoryWindowTokens,
        budgetTokens: projection.budgetTokens,
        projectedToolResultTokens: projection.projectedToolResultTokens,
        toolResultCount: projection.toolResultCount,
        truncatedCount: projection.truncatedCount,
        tokenSource: ctx.tokenSource,
      },
    });
  }

  const consolidation = await maybeConsolidateContext(
    ctx,
    applyTokenAdjustment(estimateReActMessagesTokens(projection.messages), ctx.tokenAdjustment),
  );
  if (consolidation.aborted) {
    return { ...consolidation, providerMessages: projection.messages };
  }
  let questionIndex = consolidation.questionIndex;
  projection = projectCurrentTurnToolResults(ctx.messages, questionIndex, ctx.input.contextWindowTokens);
  const trimThresholdTokens = Math.floor(projection.workingMemoryWindowTokens * ctx.budget.contextAtomicTrimThreshold);
  const trim = trimOldestAtomicHistory(
    ctx.messages,
    questionIndex,
    trimThresholdTokens,
    projection.workingMemoryWindowTokens,
    ctx.tokenAdjustment,
  );
  questionIndex = trim.questionIndex;
  if (trim.removedMessages > 0) {
    ctx.input.onTrace?.({
      stage: 'react', action: 'atomic-history-trim', status: 'completed',
      detail: {
        thresholdTokens: trimThresholdTokens,
        removedGroups: trim.removedGroups,
        removedMessages: trim.removedMessages,
        estimatedTokensAfter: trim.estimatedTokens,
      },
    });
  }
  projection = projectCurrentTurnToolResults(ctx.messages, questionIndex, projection.workingMemoryWindowTokens);
  const actions: AssistantModelInputCompression['actions'] = [];
  if (projection.truncatedCount > 0) {
    actions.push({ kind: 'tool-result-budget', affectedItems: projection.truncatedCount });
  }
  if (consolidation.consolidation) {
    actions.push({
      kind: 'history-consolidation',
      affectedItems: consolidation.consolidation.affectedMessages,
      method: consolidation.consolidation.method,
    });
  }
  if (trim.removedMessages > 0) {
    actions.push({
      kind: 'atomic-history-trim',
      affectedItems: trim.removedMessages,
      affectedGroups: trim.removedGroups,
    });
  }
  const estimatedTokensAfter = applyTokenAdjustment(estimateReActMessagesTokens(projection.messages), ctx.tokenAdjustment);
  const inputCompression = actions.length ? {
    estimatedTokensBefore,
    estimatedTokensAfter,
    releasedTokens: Math.max(0, estimatedTokensBefore - estimatedTokensAfter),
    actions,
  } satisfies AssistantModelInputCompression : undefined;
  return {
    questionIndex,
    aborted: false,
    providerMessages: projection.messages,
    ...(inputCompression ? { inputCompression } : {}),
  };
}

/**
 * 估算超过 窗口 × 阈值 时，把本轮问题之前的旧消息压缩成一条摘要消息。
 * 硬边界：只碰 questionIndex 之前的消息；assistant(tool_calls)+tool 按组保留；
 * 摘要走最多三次独立维护调用，不占 ReAct maxModelCalls；失败后降级原文归档。
 */
async function maybeConsolidateContext(
  ctx: ConsolidationContext,
  projectedTokens: number,
): Promise<ConsolidationOutcome> {
  const { input, budget, messages, questionIndex, counters } = ctx;
  const unchanged: ConsolidationOutcome = { questionIndex, aborted: false };
  if (budget.contextConsolidationThreshold <= 0) return unchanged;
  const workingMemoryWindowTokens = projectCurrentTurnToolResults(messages, questionIndex, input.contextWindowTokens).workingMemoryWindowTokens;
  const thresholdTokens = Math.floor(workingMemoryWindowTokens * budget.contextConsolidationThreshold);
  const estimatedTokensBefore = projectedTokens;
  if (estimatedTokensBefore <= thresholdTokens) return unchanged;
  const history = messages.slice(1, questionIndex);
  if (history.length === 0 || history.some(isMemorySummary)) return unchanged;

  // 目标 = 50% × 0.6 = 工作窗口 30%，并为新摘要固定预留 500 token。
  const targetTokens = Math.floor(thresholdTokens * budget.contextConsolidationTargetRatio);
  const fixedTokens = applyTokenAdjustment(
    estimateReActMessagesTokens([messages[0], ...messages.slice(questionIndex)]),
    ctx.tokenAdjustment,
  )
    + budget.contextConsolidationSummaryReserveTokens;
  const keepBudgetTokens = Math.max(0, targetTokens - fixedTokens);
  const { keepCount } = findConsolidationKeepBoundary(history, keepBudgetTokens);
  const consolidatedSlice = history.slice(0, history.length - keepCount);
  if (consolidatedSlice.length === 0) return unchanged;

  const transcript = formatConsolidationTranscript(consolidatedSlice, budget);
  let summaryText = '';
  let mode: 'llm' | 'raw-archive' = 'raw-archive';
  let attempts = 0;
  for (let attempt = 1; attempt <= budget.contextConsolidationMaxAttempts && !summaryText; attempt += 1) {
    attempts = attempt;
    counters.maintenanceModelCalls += 1;
    input.onTrace?.({
      stage: 'react', action: 'consolidate', status: 'started',
      detail: { attempt, estimatedTokensBefore, thresholdTokens, targetTokens, consolidateCount: consolidatedSlice.length, tokenSource: ctx.tokenSource },
    });
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), budget.contextConsolidationTimeoutMs);
    const signal = AbortSignal.any([input.signal, timeoutController.signal]);
    try {
      const request: ReActChatRequest = {
        messages: [
          { role: 'system', content: CONSOLIDATION_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        tools: [],
        model: input.model,
        temperature: CONSOLIDATION_TEMPERATURE,
        maxOutputTokens: budget.contextConsolidationMaxTokens,
        timeoutMs: budget.contextConsolidationTimeoutMs,
        signal,
      };
      const response = await awaitWithAbort(input.transport.chat(input.config, request), signal);
      clearTimeout(timeoutId);
      ctx.onUsage(response.usage);
      summaryText = response.content.trim();
      if (summaryText) mode = 'llm';
      else input.onTrace?.({ stage: 'react', action: 'consolidate-attempt', status: 'failed', detail: { attempt, error: 'empty-summary' } });
    } catch (error) {
      clearTimeout(timeoutId);
      if (input.signal.aborted) {
        input.onTrace?.({ stage: 'react', action: 'consolidate', status: 'failed', detail: { error: '任务在轮内固化期间被取消' } });
        return { questionIndex, aborted: true };
      }
      input.onTrace?.({
        stage: 'react', action: 'consolidate-attempt', status: 'failed',
        detail: { attempt, error: timeoutController.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error) },
      });
    }
  }
  if (!summaryText) summaryText = buildConsolidationRawArchive(consolidatedSlice, budget.contextConsolidationFallbackCodePoints);

  const summaryMessage: ReActChatMessage = {
    role: 'system',
    content: `[Memory Summary - ${consolidatedSlice.length} earlier messages consolidated]\n${summaryText}`,
  };
  messages.splice(1, consolidatedSlice.length, summaryMessage);
  counters.consolidations += 1;
  input.onTrace?.({
    stage: 'react', action: 'consolidate', status: 'completed',
    detail: {
      mode,
      consolidatedCount: consolidatedSlice.length,
      keptCount: keepCount,
      summaryChars: summaryText.length,
      estimatedTokensBefore,
      thresholdTokens,
      targetTokens,
      attempts,
      maintenanceModelCalls: counters.maintenanceModelCalls,
      tokenSource: ctx.tokenSource,
    },
  });
  return {
    questionIndex: questionIndex - consolidatedSlice.length + 1,
    aborted: false,
    consolidation: { affectedMessages: consolidatedSlice.length, method: mode },
  };
}

/**
 * 从历史尾部向前划定保留区（对齐 WeKnora findKeepBoundary）：
 * 末尾连续 tool 消息 + 触发它们的 assistant(tool_calls) 是不可拆分单元。
 */
export function findConsolidationKeepBoundary(
  history: readonly ReActChatMessage[],
  keepBudgetTokens: number,
): { keepCount: number; keepTokens: number } {
  let keepCount = 0;
  let keepTokens = 0;
  let cursor = history.length;
  while (cursor > 0) {
    let unitStart = cursor;
    while (unitStart > 0 && history[unitStart - 1].role === 'tool') {
      unitStart -= 1;
    }
    if (unitStart > 0 && history[unitStart - 1].role === 'assistant' && (history[unitStart - 1].toolCalls?.length ?? 0) > 0) {
      unitStart -= 1;
    }
    if (unitStart === cursor) {
      unitStart -= 1;
    }
    // Same conservative estimator as the full prompt, excluding its single chat-tail framing.
    const unitTokens = Math.max(0, estimateReActMessagesTokens(history.slice(unitStart, cursor)) - 3);
    if (keepTokens + unitTokens > keepBudgetTokens) break;
    keepTokens += unitTokens;
    keepCount += cursor - unitStart;
    cursor = unitStart;
  }
  return { keepCount: Math.min(keepCount, history.length), keepTokens };
}

export function formatConsolidationTranscript(slice: readonly ReActChatMessage[], budget: ReActBudget = DEFAULT_REACT_BUDGET): string {
  return slice
    .map((message) => {
      const label = message.role === 'user'
        ? '用户'
        : message.role === 'assistant'
          ? '助手'
          : message.role === 'tool'
            ? `工具结果（${message.toolName ?? 'tool'}）`
            : '系统';
      const toolNote = message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0
        ? `（调用工具：${message.toolCalls!.map((call) => call.name).join('、')}）`
        : '';
      const codePointLimit = message.role === 'tool' || message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0
        ? budget.contextConsolidationToolCodePoints
        : budget.contextConsolidationMessageCodePoints;
      return `[${label}]${toolNote}\n${truncateUnicodeCodePoints(normalizeArchiveText(message.content), codePointLimit)}`;
    })
    .join('\n\n');
}

export function buildConsolidationRawArchive(slice: readonly ReActChatMessage[], maxCodePoints = 500): string {
  return slice
    .map((message) => {
      const prefix = message.role === 'assistant'
        ? '助手'
        : message.role === 'user'
          ? '用户'
          : message.role === 'tool'
            ? `工具${message.toolName ? `（${message.toolName}）` : ''}`
            : '系统';
      return `[${prefix}] ${truncateUnicodeCodePoints(normalizeArchiveText(message.content), maxCodePoints)}`;
    })
    .join('\n');
}

export interface AtomicHistoryTrimResult {
  questionIndex: number;
  removedGroups: number;
  removedMessages: number;
  estimatedTokens: number;
}

/** Removes only complete oldest history groups and protects system, Memory Summary and current turn. */
export function trimOldestAtomicHistory(
  messages: ReActChatMessage[],
  questionIndex: number,
  maxTokens: number,
  contextWindowTokens?: number,
  tokenAdjustment = 0,
): AtomicHistoryTrimResult {
  let removedGroups = 0;
  let removedMessages = 0;
  let estimatedTokens = applyTokenAdjustment(estimateReActMessagesTokens(
    projectCurrentTurnToolResults(messages, questionIndex, contextWindowTokens).messages,
  ), tokenAdjustment);
  while (estimatedTokens > maxTokens) {
    const groups = collectAtomicHistoryGroups(messages, questionIndex);
    const removable = groups.find((group) => !group.messages.some(isMemorySummary));
    if (!removable) break;
    const count = removable.end - removable.start;
    messages.splice(removable.start, count);
    questionIndex -= count;
    removedGroups += 1;
    removedMessages += count;
    estimatedTokens = applyTokenAdjustment(estimateReActMessagesTokens(
      projectCurrentTurnToolResults(messages, questionIndex, contextWindowTokens).messages,
    ), tokenAdjustment);
  }
  return { questionIndex, removedGroups, removedMessages, estimatedTokens };
}

function collectAtomicHistoryGroups(
  messages: readonly ReActChatMessage[],
  questionIndex: number,
): Array<{ start: number; end: number; messages: readonly ReActChatMessage[] }> {
  const groups: Array<{ start: number; end: number; messages: readonly ReActChatMessage[] }> = [];
  let cursor = 1;
  while (cursor < questionIndex) {
    const start = cursor;
    const message = messages[cursor];
    cursor += 1;
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      while (cursor < questionIndex && messages[cursor].role === 'tool') cursor += 1;
    } else if (message.role === 'tool') {
      // Missing/out-of-order tool results are conservatively grouped with adjacent tool results.
      while (cursor < questionIndex && messages[cursor].role === 'tool') cursor += 1;
    }
    groups.push({ start, end: cursor, messages: messages.slice(start, cursor) });
  }
  return groups;
}

function isMemorySummary(message: ReActChatMessage): boolean {
  return message.role === 'system' && message.content.startsWith(MEMORY_SUMMARY_PREFIX);
}

export function truncateUnicodeCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  const codePoints = Array.from(text);
  return codePoints.length <= maxCodePoints ? text : codePoints.slice(0, maxCodePoints).join('');
}

function normalizeArchiveText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/[\t ]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

function applyTokenAdjustment(estimatedTokens: number, adjustment: number): number {
  return Math.max(0, estimatedTokens + adjustment);
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The transport may synchronously abort while constructing its rejected Promise.
    void promise.catch(() => undefined);
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function createAbortError(): Error {
  const error = new Error('模型维护调用已取消或超时。');
  error.name = 'AbortError';
  return error;
}

function estimateProviderPromptTokens(messages: readonly ReActChatMessage[], tools: readonly ReActToolSchema[]): number {
  return estimateReActMessagesTokens(messages) + (tools.length ? estimateTokenCount(JSON.stringify(tools)) : 0);
}

function serializeMessagesForBudget(messages: readonly ReActChatMessage[], tools: readonly ReActToolSchema[] = []): string {
  const serializedMessages = messages.map((message) => [
    `<${message.role}${message.toolName ? ` tool="${message.toolName}"` : ''}${message.toolCallId ? ` call="${message.toolCallId}"` : ''}>`,
    message.content,
    message.toolCalls?.length ? JSON.stringify(message.toolCalls) : '',
    `</${message.role}>`,
  ].filter(Boolean).join('\n')).join('\n');
  return tools.length ? `${serializedMessages}\n<tools>\n${JSON.stringify(tools)}\n</tools>` : serializedMessages;
}
