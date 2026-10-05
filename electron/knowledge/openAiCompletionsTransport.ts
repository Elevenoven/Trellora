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
  type AiStructuredOutputRequest,
  type AiStructuredOutputTransport,
  type AiTransportImage,
} from './aiGenerationTransport';
import { createAiProviderHttpError, createAiProviderMessageError } from './aiProviderError';
import { resolveAiModelDescriptor, resolveMaxOutputTokensOptions, resolveThinkingOptions } from './aiModelCapabilities';
import { StructuredOutputContractError } from './structuredOutputContract';

export type OpenAiStructuredOutputTransport = AiStructuredOutputTransport;
export type OpenAiStructuredOutputRequest = AiStructuredOutputRequest;
export type OpenAiCompletionInput = AiGenerationTransportInput;

export async function generateOpenAiCompletion(
  config: AiProviderConfig,
  input: OpenAiCompletionInput,
): Promise<{ text: string; usage?: AssistantTokenUsage }> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const useNativeJsonSchema = input.structuredOutput?.transport === 'native-json-schema';
  const useStructuredTool = input.structuredOutput?.transport === 'tool-call';
  const useJsonObject = Boolean(input.format && (!input.structuredOutput || input.structuredOutput.transport === 'json-object'));
  const prompt = useJsonObject && !/json/iu.test(input.prompt)
    ? `${input.prompt}\n只输出一个有效 JSON 对象。`
    : input.prompt;
  const systemPrompt = input.systemPrompt?.trim();
  const structuredTool = useStructuredTool && input.structuredOutput
    ? {
      type: 'function' as const,
      function: {
        name: input.structuredOutput.schema.name,
        description: '提交本轮唯一的最终结构化结果。参数必须严格匹配 JSON Schema。',
        parameters: input.structuredOutput.schema.schema,
        ...(input.structuredOutput.strictToolSchema ? { strict: true } : {}),
      },
    }
    : undefined;
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: resolveOpenAiCompletionUserContent(prompt, input.images) }],
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(useNativeJsonSchema && input.structuredOutput
        ? { response_format: { type: 'json_schema', json_schema: input.structuredOutput.schema } }
        : useJsonObject ? { response_format: { type: 'json_object' } } : {}),
      ...(structuredTool && input.structuredOutput ? {
        tools: [structuredTool],
        tool_choice: { type: 'function', function: { name: input.structuredOutput.schema.name } },
      } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  const payload = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown } }>;
    usage?: Record<string, unknown> | null;
  };
  input.onFinishReason?.(payload.choices?.[0]?.finish_reason);
  const message = payload.choices?.[0]?.message;
  const text = useStructuredTool && input.structuredOutput
    ? readStructuredToolArguments(message?.tool_calls, input.structuredOutput.schema.name)
    : readMessageContent(message?.content);
  return { text, usage: normalizeTokenUsage(payload.usage) };
}

export async function streamOpenAiCompletion(
  config: AiProviderConfig,
  input: AiStreamingTransportInput,
): Promise<AssistantTokenUsage | undefined> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const systemPrompt = input.systemPrompt?.trim();
  const response = await fetch(`${normalizeGenerationEndpoint(config.endpoint || '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: resolveOpenAiCompletionUserContent(input.prompt, input.images) }],
      ...(descriptor.provider === 'openai' && descriptor.reasoning ? {} : { temperature: resolveGenerationTemperature(input.temperature) }),
      stream: true,
      ...resolveMaxOutputTokensOptions(descriptor, input.maxOutputTokens),
      ...(descriptor.supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
      ...resolveThinkingOptions(descriptor, input.thinkingMode),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  if (!response.body) throw new Error('远程服务未返回流式内容。');

  let parseError: Error | null = null;
  let usage: AssistantTokenUsage | undefined;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      let payload: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; message?: { content?: unknown } }>; usage?: Record<string, unknown> | null; error?: { message?: unknown } };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        parseError = new Error('远程服务返回了无法识别的流式数据。');
        return;
      }
      if (typeof payload.error?.message === 'string' && payload.error.message.trim()) {
        parseError = createAiProviderMessageError(payload.error.message.trim());
        return;
      }
      usage = normalizeTokenUsage(payload.usage) ?? usage;
      const choice = payload.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) input.onThinkingDelta?.(reasoning);
      const content = choice?.delta?.content ?? choice?.message?.content;
      if (typeof content === 'string' && content) input.onDelta(content);
    },
    onError: () => {
      parseError = new Error('远程服务返回了格式错误的流式数据。');
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

/**
 * Chat Completions 多模态 content：无图时保持纯字符串（请求体与既有文本轮次逐字节一致），
 * 有图时组装为 `[{text}, {image_url}]` 数组，image_url 直接消费渲染进程生成的 data URL。
 */
function resolveOpenAiCompletionUserContent(prompt: string, images: AiTransportImage[] | undefined): string | Array<Record<string, unknown>> {
  if (!images?.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ];
}

function readStructuredToolArguments(value: unknown, expectedName: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StructuredOutputContractError('missing-tool-call', `模型未调用结构化输出工具 ${expectedName}。`);
  }
  if (value.length !== 1) {
    throw new StructuredOutputContractError('multiple-tool-calls', `模型返回了 ${value.length} 个工具调用；结构化输出只能提交一次。`);
  }
  const call = value[0];
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new StructuredOutputContractError('unexpected-tool-call', '模型返回的结构化工具调用无效。');
  }
  const fn = (call as Record<string, unknown>).function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    throw new StructuredOutputContractError('unexpected-tool-call', '模型返回的工具调用缺少 function。');
  }
  const functionCall = fn as Record<string, unknown>;
  if (functionCall.name !== expectedName) {
    throw new StructuredOutputContractError('unexpected-tool-call', `模型调用了非预期工具；需要 ${expectedName}。`);
  }
  if (typeof functionCall.arguments === 'string' && functionCall.arguments.trim()) return functionCall.arguments.trim();
  if (functionCall.arguments && typeof functionCall.arguments === 'object') return JSON.stringify(functionCall.arguments);
  throw new StructuredOutputContractError('invalid-tool-arguments', '结构化输出工具参数不是有效 JSON 文本。');
}

function readMessageContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  }).join('').trim();
}

function normalizeTokenUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  const inputTokens = readNonNegativeTokenCount(value.prompt_tokens ?? value.input_tokens);
  const outputTokens = readNonNegativeTokenCount(value.completion_tokens ?? value.output_tokens);
  const totalTokens = readNonNegativeTokenCount(value.total_tokens);
  const promptDetails = value.prompt_tokens_details;
  const cachedInputTokens = readNonNegativeTokenCount(value.cached_input_tokens ?? value.cached_tokens
    ?? (promptDetails && typeof promptDetails === 'object' && !Array.isArray(promptDetails)
      ? (promptDetails as Record<string, unknown>).cached_tokens
      : undefined));
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}
