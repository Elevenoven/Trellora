import { createParser } from 'eventsource-parser';
import type { AiProviderConfig } from '../aiTypes';
import type { AssistantTokenUsage } from '../tokenEstimator';
import {
  assertRemoteGenerationRequest,
  createGenerationRequestSignal,
  normalizeGenerationEndpoint,
  readNonNegativeTokenCount,
  resolveGenerationTemperature,
  splitImageDataBase64,
} from '../aiGenerationTransport';
import { createAiProviderHttpError, createAiProviderMessageError } from '../aiProviderError';
import { resolveAiModelDescriptor, resolveMaxOutputTokensOptions, resolveMaxOutputTokensValue, resolveThinkingOptions } from '../aiModelCapabilities';
import type { ReActChatMessage, ReActChatRequest, ReActChatResponse, ReActToolCall, ReActToolSchema } from './reactChatTransport';

let syntheticToolCallCounter = 0;

/** Gemini 等无原生调用 id 的协议需要引擎侧补齐稳定 id，用于 tool 结果回填。 */
function createSyntheticToolCallId(): string {
  syntheticToolCallCounter += 1;
  return `mh_call_${Date.now().toString(36)}_${syntheticToolCallCounter.toString(36)}`;
}

function splitSystemMessages(messages: ReActChatMessage[]): { systemText: string; conversation: ReActChatMessage[] } {
  const systemParts: string[] = [];
  const conversation: ReActChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content.trim());
      continue;
    }
    conversation.push(message);
  }
  return { systemText: systemParts.join('\n\n'), conversation };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeChatUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  const inputTokens = readNonNegativeTokenCount(value.prompt_tokens ?? value.input_tokens ?? value.promptTokenCount);
  const outputTokens = readNonNegativeTokenCount(value.completion_tokens ?? value.output_tokens ?? value.candidatesTokenCount ?? value.responseTokenCount);
  const totalTokens = readNonNegativeTokenCount(value.total_tokens ?? value.totalTokenCount);
  const promptDetails = value.prompt_tokens_details;
  const inputDetails = value.input_tokens_details;
  const cachedInputTokens = readNonNegativeTokenCount(value.cached_input_tokens ?? value.cached_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount
    ?? (promptDetails && typeof promptDetails === 'object' && !Array.isArray(promptDetails)
      ? (promptDetails as Record<string, unknown>).cached_tokens
      : undefined)
    ?? (inputDetails && typeof inputDetails === 'object' && !Array.isArray(inputDetails)
      ? (inputDetails as Record<string, unknown>).cached_tokens
      : undefined));
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

// ---------- 流式（SSE）公共件 ----------

/** 流式 tool_calls 增量聚合槽；各协议按自身 delta 语义逐步补齐。 */
interface StreamToolCallSlot {
  id: string;
  name: string;
  arguments: string;
}

function finalizeStreamToolCalls(slots: StreamToolCallSlot[]): ReActToolCall[] {
  return slots
    .filter((slot) => slot.name.trim())
    .map((slot) => ({
      id: slot.id.trim() ? slot.id : createSyntheticToolCallId(),
      name: slot.name.trim(),
      arguments: parseToolArguments(slot.arguments),
    }));
}

async function consumeSseStream(response: Response, onPayload: (payload: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) throw new Error('远程服务未返回流式内容。');
  let parseError: Error | null = null;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        parseError = parseError ?? new Error('远程服务返回了无法识别的流式数据。');
        return;
      }
      try {
        onPayload(payload);
      } catch (error) {
        parseError = parseError ?? (error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError: () => {
      parseError = parseError ?? new Error('远程服务返回了格式错误的流式数据。');
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      parser.feed(decoder.decode(value, { stream: !done }));
      if (parseError) throw parseError;
      if (done) break;
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
    if (parseError) throw parseError;
  } finally {
    reader.releaseLock();
  }
}

// ---------- OpenAI Completions（OpenAI 兼容网关：DeepSeek / Qwen / Moonshot / OpenRouter / 自建） ----------

export async function chatOpenAiCompletion(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  if (input.onDelta || input.onThinkingDelta) return streamOpenAiCompletionChat(config, input);
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [
        ...(systemText ? [{ role: 'system', content: systemText }] : []),
        ...conversation.map(toOpenAiCompletionMessage),
      ],
      // 推理模型（OpenAI o/gpt-5 系）不接受 temperature；与单轮生成保持一致。
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(input.tools.length ? { tools: input.tools.map(toOpenAiFunctionTool) } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }>;
    usage?: Record<string, unknown> | null;
  };
  const message = payload.choices?.[0]?.message;
  return {
    content: readStringContent(message?.content),
    ...(typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? { reasoningContent: message.reasoning_content }
      : {}),
    toolCalls: readOpenAiCompletionToolCalls(message?.tool_calls),
    usage: normalizeChatUsage(payload.usage),
  };
}

async function streamOpenAiCompletionChat(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [
        ...(systemText ? [{ role: 'system', content: systemText }] : []),
        ...conversation.map(toOpenAiCompletionMessage),
      ],
      // 推理模型（OpenAI o/gpt-5 系）不接受 temperature；与单轮生成保持一致。
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(input.tools.length ? { tools: input.tools.map(toOpenAiFunctionTool) } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
      stream: true,
      ...(descriptor.supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  let content = '';
  let reasoningContent = '';
  let usage: AssistantTokenUsage | undefined;
  let toolCallStarted = false;
  const toolCallSlots = new Map<number, StreamToolCallSlot>();
  await consumeSseStream(response, (payload) => {
    const record = payload as {
      choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }>;
      usage?: Record<string, unknown> | null;
      error?: { message?: unknown };
    };
    if (typeof record.error?.message === 'string' && record.error.message.trim()) throw createAiProviderMessageError(record.error.message.trim());
    usage = normalizeChatUsage(record.usage) ?? usage;
    const delta = record.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
      input.onThinkingDelta?.(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      input.onDelta?.(delta.content);
    }
    if (!Array.isArray(delta.tool_calls)) return;
    for (const call of delta.tool_calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      const callRecord = call as { index?: unknown; id?: unknown; function?: unknown };
      const index = typeof callRecord.index === 'number' && Number.isSafeInteger(callRecord.index) ? callRecord.index : toolCallSlots.size;
      let slot = toolCallSlots.get(index);
      if (!slot) {
        slot = { id: '', name: '', arguments: '' };
        toolCallSlots.set(index, slot);
      }
      if (!toolCallStarted) {
        toolCallStarted = true;
        input.onToolCallStart?.();
      }
      if (typeof callRecord.id === 'string' && callRecord.id) slot.id = callRecord.id;
      const fn = callRecord.function;
      if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
        const fnRecord = fn as { name?: unknown; arguments?: unknown };
        if (typeof fnRecord.name === 'string') slot.name += fnRecord.name;
        if (typeof fnRecord.arguments === 'string') slot.arguments += fnRecord.arguments;
      }
    }
  });
  return {
    content: content.trim(),
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: finalizeStreamToolCalls([...toolCallSlots.entries()].sort((left, right) => left[0] - right[0]).map(([, slot]) => slot)),
    usage,
  };
}

function toOpenAiCompletionMessage(message: ReActChatMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      } : {}),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
  }
  return {
    role: 'user',
    content: message.images?.length
      ? [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
      ]
      : message.content,
  };
}

function toOpenAiFunctionTool(tool: ReActToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function readOpenAiCompletionToolCalls(value: unknown): ReActToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return [];
    const fnRecord = fn as Record<string, unknown>;
    const name = typeof fnRecord.name === 'string' ? fnRecord.name.trim() : '';
    if (!name) return [];
    return [{
      id: typeof record.id === 'string' && record.id.trim() ? record.id : createSyntheticToolCallId(),
      name,
      arguments: parseToolArguments(fnRecord.arguments),
    }];
  });
}

// ---------- OpenAI Responses（OpenAI 官方 /responses 协议） ----------

export async function chatOpenAiResponse(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  if (input.onDelta || input.onThinkingDelta) return streamOpenAiResponseChat(config, input);
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      input: conversation.flatMap(toOpenAiResponseItems),
      ...(systemText ? { instructions: systemText } : {}),
      store: false,
      ...(descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
      // Responses 的 reasoning item 尚未进入 ReAct 回放消息；启用前必须先保留原始 item。
      ...resolveThinkingOptions(descriptor, undefined),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  const payload = await response.json() as {
    output?: unknown;
    usage?: Record<string, unknown> | null;
    error?: { message?: string } | null;
  };
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  const items = Array.isArray(payload.output) ? payload.output : [];
  const contentParts: string[] = [];
  const toolCalls: ReActToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'message' && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== 'object') continue;
        const partRecord = part as Record<string, unknown>;
        if ((partRecord.type === 'output_text' || partRecord.type === 'input_text') && typeof partRecord.text === 'string') {
          contentParts.push(partRecord.text);
        }
      }
      continue;
    }
    if (record.type === 'function_call' && typeof record.name === 'string' && record.name.trim()) {
      toolCalls.push({
        id: typeof record.call_id === 'string' && record.call_id.trim() ? record.call_id : createSyntheticToolCallId(),
        name: record.name.trim(),
        arguments: parseToolArguments(record.arguments),
      });
    }
  }
  return { content: contentParts.join('').trim(), toolCalls, usage: normalizeChatUsage(payload.usage) };
}

async function streamOpenAiResponseChat(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      input: conversation.flatMap(toOpenAiResponseItems),
      ...(systemText ? { instructions: systemText } : {}),
      store: false,
      ...(descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
      // Responses 的 reasoning item 尚未进入 ReAct 回放消息；启用前必须先保留原始 item。
      ...resolveThinkingOptions(descriptor, undefined),
      stream: true,
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  let content = '';
  let usage: AssistantTokenUsage | undefined;
  let toolCallStarted = false;
  const slotById = new Map<string, StreamToolCallSlot>();
  const orderedSlots: StreamToolCallSlot[] = [];
  const resolveSlot = (itemId: unknown): StreamToolCallSlot | undefined =>
    (typeof itemId === 'string' && itemId ? slotById.get(itemId) : undefined) ?? orderedSlots[orderedSlots.length - 1];
  await consumeSseStream(response, (payload) => {
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'error') {
      const message = (payload.error as { message?: unknown } | undefined)?.message;
      if (typeof message === 'string' && message.trim()) throw createAiProviderMessageError(message.trim());
      return;
    }
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta) {
      content += payload.delta;
      input.onDelta?.(payload.delta);
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string' && payload.delta) {
      input.onThinkingDelta?.(payload.delta);
      return;
    }
    if (type === 'response.output_item.added') {
      const item = payload.item;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const itemRecord = item as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown };
      if (itemRecord.type !== 'function_call' || typeof itemRecord.name !== 'string' || !itemRecord.name.trim()) return;
      const slot: StreamToolCallSlot = {
        id: typeof itemRecord.call_id === 'string' && itemRecord.call_id.trim()
          ? itemRecord.call_id
          : (typeof itemRecord.id === 'string' ? itemRecord.id : ''),
        name: itemRecord.name,
        arguments: '',
      };
      const key = typeof itemRecord.id === 'string' && itemRecord.id ? itemRecord.id : `mh_item_${orderedSlots.length}`;
      slotById.set(key, slot);
      orderedSlots.push(slot);
      if (!toolCallStarted) {
        toolCallStarted = true;
        input.onToolCallStart?.();
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
      const slot = resolveSlot(payload.item_id);
      if (slot) slot.arguments += payload.delta;
      return;
    }
    if (type === 'response.function_call_arguments.done' && typeof payload.arguments === 'string') {
      const slot = resolveSlot(payload.item_id);
      if (slot) slot.arguments = payload.arguments;
      return;
    }
    if (type === 'response.completed') {
      const completed = payload.response as { usage?: Record<string, unknown> | null; error?: { message?: unknown } | null } | undefined;
      if (typeof completed?.error?.message === 'string' && completed.error.message.trim()) throw createAiProviderMessageError(completed.error.message.trim());
      usage = normalizeChatUsage(completed?.usage) ?? usage;
    }
  });
  return { content: content.trim(), toolCalls: finalizeStreamToolCalls(orderedSlots), usage };
}

function toOpenAiResponseItems(message: ReActChatMessage): Array<Record<string, unknown>> {
  if (message.role === 'assistant') {
    return [
      ...(message.content.trim() ? [{ role: 'assistant', content: [{ type: 'output_text', text: message.content }] }] : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    ];
  }
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.content }];
  }
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: message.content },
      ...(message.images ?? []).map((image) => ({ type: 'input_image', image_url: image.dataUrl })),
    ],
  }];
}

// ---------- Anthropic Messages ----------

interface AnthropicChatPayload {
  content?: unknown;
  usage?: Record<string, unknown> | null;
  error?: { message?: string } | null;
}

export async function chatAnthropicMessages(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  if (input.onDelta || input.onThinkingDelta) return streamAnthropicMessagesChat(config, input);
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const maxTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens, 8_192) ?? 8_192;
  const response = await fetch(resolveAnthropicChatUrl(config.endpoint || ''), {
    method: 'POST',
    headers: { 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemText ? { system: systemText } : {}),
      messages: toAnthropicMessages(conversation),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      // Extended thinking 的签名块尚未进入 ReAct 回放消息；保持既有关闭行为。
      temperature: resolveGenerationTemperature(input.temperature),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  const payload = await response.json() as AnthropicChatPayload;
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const textParts: string[] = [];
  const toolCalls: ReActToolCall[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') textParts.push(record.text);
    if (record.type === 'tool_use' && typeof record.name === 'string' && record.name.trim()) {
      toolCalls.push({
        id: typeof record.id === 'string' && record.id.trim() ? record.id : createSyntheticToolCallId(),
        name: record.name.trim(),
        arguments: parseToolArguments(record.input),
      });
    }
  }
  return { content: textParts.join('').trim(), toolCalls, usage: normalizeAnthropicChatUsage(payload.usage) };
}

async function streamAnthropicMessagesChat(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const maxTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens, 8_192) ?? 8_192;
  const response = await fetch(resolveAnthropicChatUrl(config.endpoint || ''), {
    method: 'POST',
    headers: { 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemText ? { system: systemText } : {}),
      messages: toAnthropicMessages(conversation),
      ...(input.tools.length ? { tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      // Extended thinking 的签名块尚未进入 ReAct 回放消息；保持既有关闭行为。
      temperature: resolveGenerationTemperature(input.temperature),
      stream: true,
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  let content = '';
  let usage: AssistantTokenUsage | undefined;
  let toolCallStarted = false;
  const slotByIndex = new Map<number, StreamToolCallSlot>();
  await consumeSseStream(response, (payload) => {
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'error') {
      const message = (payload.error as { message?: unknown } | undefined)?.message;
      if (typeof message === 'string' && message.trim()) throw createAiProviderMessageError(message.trim());
      return;
    }
    if (type === 'message_start') {
      usage = mergeStreamAnthropicUsage(usage, (payload.message as { usage?: Record<string, unknown> | null } | undefined)?.usage);
      return;
    }
    if (type === 'message_delta') {
      usage = mergeStreamAnthropicUsage(usage, payload.usage as Record<string, unknown> | null | undefined);
      return;
    }
    if (type === 'content_block_start') {
      const block = payload.content_block;
      if (!block || typeof block !== 'object' || Array.isArray(block)) return;
      const blockRecord = block as { type?: unknown; id?: unknown; name?: unknown };
      if (blockRecord.type !== 'tool_use' || typeof blockRecord.name !== 'string' || !blockRecord.name.trim()) return;
      const index = typeof payload.index === 'number' && Number.isSafeInteger(payload.index) ? payload.index : slotByIndex.size;
      slotByIndex.set(index, {
        id: typeof blockRecord.id === 'string' ? blockRecord.id : '',
        name: blockRecord.name,
        arguments: '',
      });
      if (!toolCallStarted) {
        toolCallStarted = true;
        input.onToolCallStart?.();
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = payload.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return;
      const deltaRecord = delta as { type?: unknown; text?: unknown; thinking?: unknown; partial_json?: unknown };
      if (deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string' && deltaRecord.text) {
        content += deltaRecord.text;
        input.onDelta?.(deltaRecord.text);
        return;
      }
      if (deltaRecord.type === 'thinking_delta' && typeof deltaRecord.thinking === 'string' && deltaRecord.thinking) {
        input.onThinkingDelta?.(deltaRecord.thinking);
        return;
      }
      if (deltaRecord.type === 'input_json_delta' && typeof deltaRecord.partial_json === 'string') {
        const index = typeof payload.index === 'number' ? payload.index : -1;
        const slot = slotByIndex.get(index);
        if (slot) slot.arguments += deltaRecord.partial_json;
      }
    }
  });
  return {
    content: content.trim(),
    toolCalls: finalizeStreamToolCalls([...slotByIndex.entries()].sort((left, right) => left[0] - right[0]).map(([, slot]) => slot)),
    usage,
  };
}

/** Anthropic 流式用量分段上报（message_start 给入、message_delta 给出），按字段取最新非空值合并。 */
function mergeStreamAnthropicUsage(current: AssistantTokenUsage | undefined, value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  const next = normalizeAnthropicChatUsage(value);
  if (!next) return current;
  const inputTokens = next.inputTokens ?? current?.inputTokens;
  const outputTokens = next.outputTokens ?? current?.outputTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    ...(next.cachedInputTokens !== undefined || current?.cachedInputTokens !== undefined ? { cachedInputTokens: next.cachedInputTokens ?? current?.cachedInputTokens } : {}),
  };
}

/**
 * Anthropic 要求 messages 严格以 user 开头并交替出现；tool_result 归属
 * user 角色。这里把连续同角色消息合并为一条多块消息，避免协议报错。
 */
function toAnthropicMessages(conversation: ReActChatMessage[]): Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  const append = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>) => {
    if (!blocks.length) return;
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    merged.push({ role, content: blocks });
  };
  for (const message of conversation) {
    if (message.role === 'assistant') {
      append('assistant', [
        ...(message.content.trim() ? [{ type: 'text', text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ]);
      continue;
    }
    if (message.role === 'tool') {
      append('user', [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }]);
      continue;
    }
    append('user', [
      { type: 'text', text: message.content },
      ...(message.images ?? []).map((image) => {
        const { mimeType, base64 } = splitImageDataBase64(image);
        return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
      }),
    ]);
  }
  if (!merged.length || merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '（继续）' }] });
  }
  return merged;
}

function resolveAnthropicChatUrl(endpoint: string): string {
  const normalized = normalizeGenerationEndpoint(endpoint);
  return /\/v1$/u.test(normalized) ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function normalizeAnthropicChatUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  const uncached = readNonNegativeTokenCount(value.input_tokens);
  const cacheCreation = readNonNegativeTokenCount(value.cache_creation_input_tokens) ?? 0;
  const cachedInputTokens = readNonNegativeTokenCount(value.cache_read_input_tokens);
  const outputTokens = readNonNegativeTokenCount(value.output_tokens);
  const inputTokens = uncached === undefined && cacheCreation === 0 && cachedInputTokens === undefined
    ? undefined
    : (uncached ?? 0) + cacheCreation + (cachedInputTokens ?? 0);
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

// ---------- Google GenerateContent（Gemini） ----------

export async function chatGoogleContent(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  if (input.onDelta || input.onThinkingDelta) return streamGoogleContentChat(config, input);
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const maxOutputTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens);
  const temperature = resolveGoogleChatTemperature(model, input.temperature);
  const response = await fetch(resolveGoogleChatUrl(config.endpoint || '', model), {
    method: 'POST',
    headers: { 'x-goog-api-key': config.apiKey || '', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents: toGoogleContents(conversation),
      ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
      // Gemini thinking 的 thought signature 尚未进入 ReAct 回放消息；保持既有关闭行为。
      ...(maxOutputTokens || temperature !== undefined
        ? { generationConfig: { ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) } }
        : {}),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown; functionCall?: unknown }> } }>;
    usageMetadata?: Record<string, unknown> | null;
    error?: { message?: string } | null;
  };
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  const parts = (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []);
  const textParts: string[] = [];
  const toolCalls: ReActToolCall[] = [];
  for (const part of parts) {
    if (part.thought === true) continue;
    if (typeof part.text === 'string') {
      textParts.push(part.text);
      continue;
    }
    const call = part.functionCall;
    if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
    const callRecord = call as Record<string, unknown>;
    const name = typeof callRecord.name === 'string' ? callRecord.name.trim() : '';
    if (!name) continue;
    toolCalls.push({ id: createSyntheticToolCallId(), name, arguments: parseToolArguments(callRecord.args) });
  }
  return { content: textParts.join('').trim(), toolCalls, usage: normalizeChatUsage(payload.usageMetadata) };
}

async function streamGoogleContentChat(config: AiProviderConfig, input: ReActChatRequest): Promise<ReActChatResponse> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const { systemText, conversation } = splitSystemMessages(input.messages);
  const maxOutputTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens);
  const temperature = resolveGoogleChatTemperature(model, input.temperature);
  const response = await fetch(resolveGoogleStreamUrl(config.endpoint || '', model), {
    method: 'POST',
    headers: { 'x-goog-api-key': config.apiKey || '', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents: toGoogleContents(conversation),
      ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
      // Gemini thinking 的 thought signature 尚未进入 ReAct 回放消息；保持既有关闭行为。
      ...(maxOutputTokens || temperature !== undefined
        ? { generationConfig: { ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) } }
        : {}),
    }),
  });
  if (!response.ok) throw createAiProviderHttpError(response.status, await readErrorDetail(response));
  let content = '';
  let usage: AssistantTokenUsage | undefined;
  let toolCallStarted = false;
  const toolCalls: ReActToolCall[] = [];
  await consumeSseStream(response, (payload) => {
    const record = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown; functionCall?: unknown }> } }>;
      usageMetadata?: Record<string, unknown> | null;
      error?: { message?: unknown } | null;
    };
    if (typeof record.error?.message === 'string' && record.error.message.trim()) throw createAiProviderMessageError(record.error.message.trim());
    usage = normalizeChatUsage(record.usageMetadata) ?? usage;
    for (const part of (record.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? [])) {
      if (part.thought === true) {
        if (typeof part.text === 'string' && part.text) input.onThinkingDelta?.(part.text);
        continue;
      }
      if (typeof part.text === 'string' && part.text) {
        content += part.text;
        input.onDelta?.(part.text);
        continue;
      }
      const call = part.functionCall;
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      const callRecord = call as { name?: unknown; args?: unknown };
      const name = typeof callRecord.name === 'string' ? callRecord.name.trim() : '';
      if (!name) continue;
      if (!toolCallStarted) {
        toolCallStarted = true;
        input.onToolCallStart?.();
      }
      toolCalls.push({ id: createSyntheticToolCallId(), name, arguments: parseToolArguments(callRecord.args) });
    }
  });
  return { content: content.trim(), toolCalls, usage };
}

/** Gemini 流式端点：streamGenerateContent + alt=sse。 */
function resolveGoogleStreamUrl(endpoint: string, model: string): string {
  const normalized = normalizeGenerationEndpoint(endpoint);
  const modelId = model.replace(/^models\//u, '');
  return `${normalized}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

/**
 * Gemini 的 functionResponse 按函数名配对而不是调用 id；同轮重复调用同名
 * 工具时结果按顺序回填（ReAct 引擎串行执行，顺序是稳定的）。
 */
function toGoogleContents(conversation: ReActChatMessage[]): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  const merged: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  const append = (role: 'user' | 'model', parts: Array<Record<string, unknown>>) => {
    if (!parts.length) return;
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    merged.push({ role, parts });
  };
  for (const message of conversation) {
    if (message.role === 'assistant') {
      append('model', [
        ...(message.content.trim() ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ functionCall: { name: call.name, args: call.arguments } })),
      ]);
      continue;
    }
    if (message.role === 'tool') {
      append('user', [{ functionResponse: { name: message.toolName ?? message.toolCallId ?? 'tool', response: { content: message.content } } }]);
      continue;
    }
    append('user', [
      { text: message.content },
      ...(message.images ?? []).map((image) => {
        const { mimeType, base64 } = splitImageDataBase64(image);
        return { inline_data: { mime_type: mimeType, data: base64 } };
      }),
    ]);
  }
  return merged;
}

function resolveGoogleChatTemperature(model: string, requested: number | undefined): number | undefined {
  const modelId = model.replace(/^models\//u, '').trim();
  // Gemini 3.x 保留官方推荐默认温度，与单轮生成保持一致。
  if (/^gemini-3(?:[.-]|$)/iu.test(modelId)) return undefined;
  return resolveGenerationTemperature(requested);
}

function resolveGoogleChatUrl(endpoint: string, model: string): string {
  const normalized = normalizeGenerationEndpoint(endpoint);
  const modelId = model.replace(/^models\//u, '');
  return `${normalized}/models/${encodeURIComponent(modelId)}:generateContent`;
}

// ---------- 公共响应解析 ----------

function readStringContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  }).join('').trim();
}
