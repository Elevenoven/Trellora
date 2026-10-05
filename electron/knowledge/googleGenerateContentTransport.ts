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

export async function generateGoogleContent(
  config: AiProviderConfig,
  input: AiGenerationTransportInput,
): Promise<{ text: string; usage?: AssistantTokenUsage }> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const maxOutputTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens);
  const generationConfig = resolveGoogleGenerationConfig(input, descriptor, model, maxOutputTokens);
  const response = await fetch(resolveGoogleGenerationUrl(config.endpoint || '', model, false), {
    method: 'POST',
    headers: { 'x-goog-api-key': config.apiKey || '', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      ...(input.systemPrompt?.trim() ? { systemInstruction: { parts: [{ text: input.systemPrompt.trim() }] } } : {}),
      contents: [{ role: 'user', parts: resolveGoogleUserParts(input.prompt, input.images) }],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  const payload = await response.json() as GoogleGenerateContentPayload;
  if (payload.error?.message) throw createAiProviderMessageError(payload.error.message);
  input.onFinishReason?.(payload.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : payload.candidates?.[0]?.finishReason);
  return { text: readGoogleText(payload).trim(), usage: normalizeGoogleUsage(payload.usageMetadata) };
}

export async function streamGoogleContent(
  config: AiProviderConfig,
  input: AiStreamingTransportInput,
): Promise<AssistantTokenUsage | undefined> {
  const model = assertRemoteGenerationRequest(config, input.model);
  const descriptor = resolveAiModelDescriptor(config, model);
  const maxOutputTokens = resolveMaxOutputTokensValue(descriptor, input.maxOutputTokens);
  const thinking = resolveThinkingOptions(descriptor, input.thinkingMode, maxOutputTokens);
  const temperature = resolveGoogleTemperature(model, input.temperature);
  const generationConfig = {
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...thinking,
    ...(temperature === undefined ? {} : { temperature }),
  };
  const response = await fetch(resolveGoogleGenerationUrl(config.endpoint || '', model, true), {
    method: 'POST',
    headers: { 'x-goog-api-key': config.apiKey || '', 'content-type': 'application/json' },
    signal: createGenerationRequestSignal(input),
    body: JSON.stringify({
      ...(input.systemPrompt?.trim() ? { systemInstruction: { parts: [{ text: input.systemPrompt.trim() }] } } : {}),
      contents: [{ role: 'user', parts: resolveGoogleUserParts(input.prompt, input.images) }],
      generationConfig,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw createAiProviderHttpError(response.status, detail);
  }
  if (!response.body) throw new Error('Google Gemini 未返回流式内容。');

  let parseError: Error | null = null;
  let usage: AssistantTokenUsage | undefined;
  const parser = createParser({
    onEvent: (event) => {
      let payload: GoogleGenerateContentPayload;
      try {
        payload = JSON.parse(event.data) as GoogleGenerateContentPayload;
      } catch {
        parseError = new Error('Google Gemini 返回了无法识别的流式数据。');
        return;
      }
      if (payload.error?.message) {
        parseError = createAiProviderMessageError(payload.error.message);
        return;
      }
      const thinking = readGoogleThinking(payload);
      if (thinking) input.onThinkingDelta?.(thinking);
      const delta = readGoogleText(payload);
      if (delta) input.onDelta(delta);
      usage = normalizeGoogleUsage(payload.usageMetadata) ?? usage;
    },
    onError: () => {
      parseError = new Error('Google Gemini 返回了格式错误的流式数据。');
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

interface GoogleGenerateContentPayload {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
  usageMetadata?: Record<string, unknown> | null;
  error?: { message?: string } | null;
}

/**
 * Google Gemini 多模态 parts：无图时仅 `[{text}]`（请求体与既有文本轮次一致）；
 * 有图时追加 `inline_data` part，需从 data URL 拆出 base64 与 mime_type。
 */
function resolveGoogleUserParts(prompt: string, images: AiTransportImage[] | undefined): Array<Record<string, unknown>> {
  if (!images?.length) return [{ text: prompt }];
  return [
    { text: prompt },
    ...images.map((image) => {
      const { mimeType, base64 } = splitImageDataBase64(image);
      return { inline_data: { mime_type: mimeType, data: base64 } };
    }),
  ];
}

function resolveGoogleGenerationConfig(
  input: AiGenerationTransportInput,
  descriptor: ReturnType<typeof resolveAiModelDescriptor>,
  model: string,
  maxOutputTokens: number | undefined,
): Record<string, unknown> {
  const temperature = resolveGoogleTemperature(model, input.temperature);
  return {
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...resolveThinkingOptions(descriptor, input.thinkingMode, maxOutputTokens),
    ...(input.format ? { responseMimeType: 'application/json' } : {}),
    ...(input.structuredOutput?.transport === 'native-json-schema'
      ? { responseJsonSchema: input.structuredOutput.schema.schema }
      : {}),
  };
}

function resolveGoogleTemperature(model: string, requested: number | undefined): number | undefined {
  const modelId = model.replace(/^models\//u, '').trim();
  // Google recommends Gemini 3.x keep its optimized default temperature.
  if (/^gemini-3(?:[.-]|$)/iu.test(modelId)) return undefined;
  return resolveGenerationTemperature(requested);
}

function resolveGoogleGenerationUrl(endpoint: string, model: string, stream: boolean): string {
  const normalized = normalizeGenerationEndpoint(endpoint);
  const modelId = model.replace(/^models\//u, '');
  return `${normalized}/models/${encodeURIComponent(modelId)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}

function readGoogleText(payload: GoogleGenerateContentPayload): string {
  return (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).flatMap((part) => {
    if (part.thought === true) return [];
    return typeof part.text === 'string' ? [part.text] : [];
  }).join('');
}

function readGoogleThinking(payload: GoogleGenerateContentPayload): string {
  return (payload.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).flatMap((part) => {
    if (part.thought !== true) return [];
    return typeof part.text === 'string' ? [part.text] : [];
  }).join('');
}

function normalizeGoogleUsage(value: Record<string, unknown> | null | undefined): AssistantTokenUsage | undefined {
  if (!value) return undefined;
  const inputTokens = readNonNegativeTokenCount(value.promptTokenCount);
  const outputTokens = readNonNegativeTokenCount(value.candidatesTokenCount ?? value.responseTokenCount);
  const totalTokens = readNonNegativeTokenCount(value.totalTokenCount);
  const cachedInputTokens = readNonNegativeTokenCount(value.cachedContentTokenCount);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}
