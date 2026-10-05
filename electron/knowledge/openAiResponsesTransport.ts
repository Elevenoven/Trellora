import { createParser } from 'eventsource-parser';
import type { AssistantTokenUsage } from './tokenEstimator';
import type { AiProviderConfig } from './aiTypes';
import {
  assertRemoteGenerationRequest,
  createGenerationRequestSignal,
  normalizeGenerationEndpoint,
  readNonNegativeTokenCount,
  resolveGenerationTemperature,
  type AiGenerationTransportInput,
  type AiStreamingTransportInput,
  type AiTransportImage,
} from './aiGenerationTransport';
import { createAiProviderHttpError, createAiProviderMessageError } from './aiProviderError';
import { resolveAiModelDescriptor, resolveMaxOutputTokensOptions, resolveThinkingOptions } from './aiModelCapabilities';

export async function generateOpenAiResponse(
  config: AiProviderConfig,
  input: AiGenerationTransportInput,
): Promise<{ text: string; usage?: AssistantTokenUsage }> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      input: resolveOpenAiResponseInput(input.prompt, input.images),
      ...(input.systemPrompt?.trim() ? { instructions: input.systemPrompt.trim() } : {}),
      store: false,
      ...(descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...resolveOpenAiTextConfig(input),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  const payload = await response.json() as OpenAiResponsePayload;
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  input.onFinishReason?.(payload.incomplete_details?.reason === 'max_output_tokens' ? 'length' : payload.status);
  return { text: readOpenAiResponseText(payload), usage: normalizeOpenAiResponseUsage(payload.usage) };
}

export async function streamOpenAiResponse(
  config: AiProviderConfig,
  input: AiStreamingTransportInput,
): Promise<AssistantTokenUsage | undefined> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      input: resolveOpenAiResponseInput(input.prompt, input.images),
      ...(input.systemPrompt?.trim() ? { instructions: input.systemPrompt.trim() } : {}),
      store: false,
      stream: true,
      ...(descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  if (!response.body) throw new Error('OpenAI 未返回流式内容。');

  let parseError: Error | null = null;
  let usage: AssistantTokenUsage | undefined;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      let payload: OpenAiResponseStreamEvent;
      try {
        payload = JSON.parse(event.data) as OpenAiResponseStreamEvent;
      } catch {
        parseError = new Error('OpenAI 返回了无法识别的流式数据。');
        return;
      }
      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta) {
        input.onDelta(payload.delta);
      }
      if (payload.type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string' && payload.delta) {
        input.onThinkingDelta?.(payload.delta);
      }
      if (payload.type === 'response.completed' && payload.response) {
        usage = normalizeOpenAiResponseUsage(payload.response.usage) ?? usage;
      }
      const message = payload.error?.message ?? payload.response?.error?.message;
      if (typeof message === 'string' && message.trim()) parseError = createAiProviderMessageError(message.trim());
    },
    onError: () => {
      parseError = new Error('OpenAI 返回了格式错误的流式数据。');
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

interface OpenAiResponsePayload {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: unknown;
  output?: unknown;
  usage?: Record<string, unknown> | null;
  error?: { message?: string } | null;
}

interface OpenAiResponseStreamEvent {
  type?: string;
  delta?: unknown;
  error?: { message?: string } | null;
  response?: OpenAiResponsePayload;
}

/**
 * Responses API 多模态 input：与 Chat Completions **不同构**。
 * 无图时 input 仍为纯字符串（请求体与既有文本轮次一致）；有图时 input 变为消息项数组，
 * content part 用 `input_text` / `input_image`，且 `input_image.image_url` 是**字符串** data URL
 * （而非 Completions 的 `{ url }` 对象），这是 Responses API 视觉输入的官方格式。
 */
function resolveOpenAiResponseInput(prompt: string, images: AiTransportImage[] | undefined): string | Array<Record<string, unknown>> {
  if (!images?.length) return prompt;
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: prompt },
      ...images.map((image) => ({ type: 'input_image', image_url: image.dataUrl })),
    ],
  }];
}

function resolveOpenAiTextConfig(input: AiGenerationTransportInput): Record<string, unknown> {
  if (input.structuredOutput?.transport === 'native-json-schema') {
    return {
      text: {
        format: {
          type: 'json_schema',
          name: input.structuredOutput.schema.name,
          strict: input.structuredOutput.schema.strict,
          schema: input.structuredOutput.schema.schema,
        },
      },
    };
  }
  if (input.format) return { text: { format: { type: 'json_object' } } };
  return {};
}

function readOpenAiResponseText(payload: OpenAiResponsePayload): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  if (!Array.isArray(payload.output)) return '';
  return payload.output.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record.type === 'output_text' && typeof record.text === 'string' ? [record.text] : [];
    });
  }).join('').trim();
}

function normalizeOpenAiResponseUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  const inputTokens = readNonNegativeTokenCount(value.input_tokens);
  const outputTokens = readNonNegativeTokenCount(value.output_tokens);
  const totalTokens = readNonNegativeTokenCount(value.total_tokens);
  const details = value.input_tokens_details;
  const cachedInputTokens = readNonNegativeTokenCount(details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>).cached_tokens
    : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}
