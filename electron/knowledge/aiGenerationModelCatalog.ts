import type { AiGenerationApi, AiRemoteProviderId } from './aiTypes';

type RemoteGenerationApi = Exclude<AiGenerationApi, 'ollama-chat'>;

export interface GenerationModelCatalogRequest {
  url: string;
  headers: Record<string, string>;
}

export interface GenerationModelCatalogConfig {
  provider: AiRemoteProviderId;
  api: RemoteGenerationApi;
  endpoint: string;
  apiKey: string;
}

/** Resolve the vendor-native model catalog used by the language-model selector. */
export function resolveGenerationModelCatalogRequest(config: GenerationModelCatalogConfig): GenerationModelCatalogRequest {
  const endpoint = normalizeEndpoint(config.endpoint);
  if (config.provider === 'qwen') {
    const nativeUrl = resolveBailianGenerationCatalogUrl(endpoint);
    if (nativeUrl) {
      return {
        url: nativeUrl,
        headers: { authorization: `Bearer ${config.apiKey}` },
      };
    }
  }
  if (config.api === 'anthropic-messages') {
    return {
      url: /\/v1$/u.test(endpoint) ? `${endpoint}/models` : `${endpoint}/v1/models`,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  if (config.api === 'google-generate-content') {
    return {
      url: `${endpoint}/models?pageSize=1000`,
      headers: { 'x-goog-api-key': config.apiKey },
    };
  }
  return {
    url: `${endpoint}/models`,
    headers: { authorization: `Bearer ${config.apiKey}` },
  };
}

export function readGenerationModelCatalogItems(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 3 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  }
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'models', 'output', 'result', 'items']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      const items = candidate.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
      if (items.length) return items;
    }
    const nested = readGenerationModelCatalogItems(candidate, depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

export function readGenerationModelCatalogName(value: Record<string, unknown>, api: RemoteGenerationApi): string | undefined {
  for (const key of ['id', 'model', 'model_name', 'name']) {
    const candidate = value[key];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const name = candidate.trim();
    return api === 'google-generate-content' ? name.replace(/^models\//u, '') : name;
  }
  return undefined;
}

/**
 * Prefer declared capabilities. Name-based exclusion is only a compatibility
 * fallback for model-list APIs that expose identifiers without task metadata.
 */
export function supportsLanguageGeneration(
  provider: AiRemoteProviderId,
  api: RemoteGenerationApi,
  item: Record<string, unknown>,
  model: string,
): boolean {
  if (api === 'google-generate-content') {
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods)) return methods.some((method) => method === 'generateContent');
  }

  const capabilities = readStringArray(item.capabilities);
  if (capabilities.some((capability) => /^(?:tg|text[-_ ]?generation|chat|completion)$/iu.test(capability))) return true;
  if (capabilities.some((capability) => /^(?:tr|me|ig|vg|asr|tts|realtime-omni|realtime-text-to-speech|realtime-asr|realtime-audio-translate|3d-generation)$/iu.test(capability)
    || /(?:embedding|rerank|moderation|image|video|audio|speech|transcri|realtime)/iu.test(capability))) return false;

  const inferenceMetadata = readRecord(item.inference_metadata) ?? readRecord(item.inferenceMetadata);
  const responseModalities = readStringArray(inferenceMetadata?.response_modality ?? inferenceMetadata?.responseModality);
  if (responseModalities.length && !responseModalities.some((modality) => /^text$/iu.test(modality))) return false;

  const declaredPurpose = readDeclaredPurpose(item);
  if (declaredPurpose === 'generation') return true;
  if (declaredPurpose === 'other') return false;

  return !isKnownNonLanguageModel(model, provider);
}

function resolveBailianGenerationCatalogUrl(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    const officialHost = hostname === 'dashscope.aliyuncs.com'
      || hostname.endsWith('.dashscope.aliyuncs.com')
      || hostname.endsWith('.maas.aliyuncs.com');
    if (!officialHost) return undefined;
    url.pathname = '/api/v1/models';
    url.search = '';
    url.searchParams.set('capabilities', 'TG');
    url.searchParams.set('page_no', '1');
    url.searchParams.set('page_size', '100');
    return url.toString();
  } catch {
    return undefined;
  }
}

function readDeclaredPurpose(item: Record<string, unknown>): 'generation' | 'other' | undefined {
  for (const key of ['task', 'model_type', 'modelType', 'purpose']) {
    const values = typeof item[key] === 'string' ? [item[key] as string] : readStringArray(item[key]);
    if (values.some((value) => /(?:chat|completion|text[-_ ]?generation|language|reasoning)/iu.test(value))) return 'generation';
    if (values.some((value) => /(?:embedding|rerank|moderation|image|video|audio|speech|transcri|realtime|tts|asr)/iu.test(value))) return 'other';
  }
  return undefined;
}

function isKnownNonLanguageModel(model: string, provider: AiRemoteProviderId): boolean {
  const normalized = model.toLowerCase();
  if (provider === 'openai') {
    return /(?:^|[-_/])(?:embedding|moderation|whisper|transcri(?:be|ption)|tts|realtime|audio|image|dall-e|sora)(?:[-_/]|$)/u.test(normalized);
  }
  return /(?:^|[-_/])(?:embedding|rerank|moderation|whisper|transcri(?:be|ption)|tts|asr|realtime|audio|speech|image|video|dall-e|sora)(?:[-_/]|$)/u.test(normalized);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}
