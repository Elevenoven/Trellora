import { createParser } from 'eventsource-parser';
import type { AssistantTokenUsage } from './tokenEstimator';
import type { AiProviderConfig } from './aiTypes';
import {
  assertRemoteGenerationRequest,
  createGenerationRequestSignal,
  normalizeGenerationEndpoint,
  readNonNegativeTokenCount,
  resolveGenerationTemperature,
  splitImageDataBase64,
  type AiGenerationTransportInput,
  type AiStreamingTransportInput,
  type AiTransportImage,
} from './aiGenerationTransport';
import { createAiProviderHttpError, createAiProviderMessageError } from './aiProviderError';
import { resolveAiModelDescriptor, resolveMaxOutputTokensValue, resolveThinkingOptions } from './aiModelCapabilities';

export async function generateAnthropicMessage(
  config: AiProviderConfig,
  input: AiGenerationTransportInput,
): Promise<{ text: string; usage?: AssistantTokenUsage }> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const maxTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens, 8_192) ?? 8_192;
  const thinking = resolveThinkingOptions(descriptor, input.thinkingMode, maxTokens);
  const response = await fetch(resolveAnthropicMessagesUrl(config.endpoint || ''), {
    method: 'POST',
    headers: anthropicHeaders(config.apiKey || ''),
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(input.systemPrompt?.trim() ? { system: input.systemPrompt.trim() } : {}),
      messages: [{ role: 'user', content: resolveAnthropicUserContent(resolveAnthropicPrompt(input), input.images) }],
      ...thinking,
      ...resolveAnthropicOutputConfig(input, thinking),
      ...(thinking.thinking ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  const payload = await response.json() as AnthropicMessagePayload;
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  input.onFinishReason?.(payload.stop_reason === 'max_tokens' ? 'length' : payload.stop_reason);
  return { text: readAnthropicText(payload.content), usage: normalizeAnthropicUsage(payload.usage) };
}

export async function streamAnthropicMessage(
  config: AiProviderConfig,
  input: AiStreamingTransportInput,
): Promise<AssistantTokenUsage | undefined> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const maxTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens, 8_192) ?? 8_192;
  const thinking = resolveThinkingOptions(descriptor, input.thinkingMode, maxTokens);
  const response = await fetch(resolveAnthropicMessagesUrl(config.endpoint || ''), {
    method: 'POST',
    headers: anthropicHeaders(config.apiKey || ''),
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(input.systemPrompt?.trim() ? { system: input.systemPrompt.trim() } : {}),
      messages: [{ role: 'user', content: resolveAnthropicUserContent(input.prompt, input.images) }],
      stream: true,
      ...thinking,
      ...(thinking.thinking ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  if (!response.body) throw new Error('Anthropic 未返回流式内容。');

  let parseError: Error | null = null;
  let usage: AssistantTokenUsage | undefined;
  const parser = createParser({
    onEvent: (event) => {
      let payload: AnthropicStreamEvent;
      try {
        payload = JSON.parse(event.data) as AnthropicStreamEvent;
      } catch {
        parseError = new Error('Anthropic 返回了无法识别的流式数据。');
        return;
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'thinking_delta' && typeof payload.delta.thinking === 'string' && payload.delta.thinking) {
        input.onThinkingDelta?.(payload.delta.thinking);
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
        input.onDelta(payload.delta.text);
      }
      if (payload.type === 'message_start') usage = mergeAnthropicUsage(usage, payload.message?.usage);
      if (payload.type === 'message_delta') usage = mergeAnthropicUsage(usage, payload.usage);
      if (payload.type === 'error' && payload.error?.message) parseError = createAiProviderMessageError(payload.error.message);
    },
    onError: () => {
      parseError = new Error('Anthropic 返回了格式错误的流式数据。');
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
  return usage;
}

interface AnthropicMessagePayload {
  stop_reason?: string;
  content?: unknown;
  usage?: Record<string, unknown> | null;
  error?: { message?: string } | null;
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: unknown; thinking?: unknown };
  message?: { usage?: Record<string, unknown> | null };
  usage?: Record<string, unknown> | null;
  error?: { message?: string };
}

function resolveAnthropicPrompt(input: AiGenerationTransportInput): string {
  if (!input.format || input.structuredOutput?.transport === 'native-json-schema' || /json/iu.test(input.prompt)) return input.prompt;
  return `${input.prompt}\n只输出一个有效 JSON 对象。`;
}

/**
 * Anthropic Messages 多模态 content：无图时保持纯字符串（请求体与既有文本轮次一致）；
 * 有图时组装为 `[{text}, {image}]` 数组，image.source 需从 data URL 拆出 base64 与 media_type。
 */
function resolveAnthropicUserContent(prompt: string, images: AiTransportImage[] | undefined): string | Array<Record<string, unknown>> {
  if (!images?.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => {
      const { mimeType, base64 } = splitImageDataBase64(image);
      return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
    }),
  ];
}

function resolveAnthropicOutputConfig(input: AiGenerationTransportInput, thinking: Record<string, unknown>): Record<string, unknown> {
  const current = thinking.output_config;
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
  const format = input.structuredOutput?.transport === 'native-json-schema'
    ? { type: 'json_schema', schema: input.structuredOutput.schema.schema }
    : undefined;
  if (!format && Object.keys(base).length === 0) return {};
  return { output_config: { ...base, ...(format ? { format } : {}) } };
}

function resolveAnthropicMessagesUrl(endpoint: string): string {
  const normalized = normalizeGenerationEndpoint(endpoint);
  return /\/v1$/u.test(normalized) ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}

function readAnthropicText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const record = block as Record<string, unknown>;
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  }).join('').trim();
}

function normalizeAnthropicUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
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

function mergeAnthropicUsage(current: AssistantTokenUsage | undefined, value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  const next = normalizeAnthropicUsage(value);
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
