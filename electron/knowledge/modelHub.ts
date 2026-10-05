import { safeStorage } from 'electron';
import type { AiGenerationApi, AiProviderConfig } from './aiTypes';
import type { ModelHub, ModelHubPatch, ModelSlot, ModelSlotId } from '../../shared/modelHubTypes';
export type { ModelHub, ModelHubPatch, ModelSlot, ModelSlotId, ProviderConnection } from '../../shared/modelHubTypes';

export const OLLAMA_SOURCE_ID = 'ollama';
export const NO_SOURCE_ID = 'none';

export interface ModelProviderCatalogEntry {
  id: string;
  label: string;
  endpoint: string;
  api: Exclude<AiGenerationApi, 'ollama-chat'>;
  generationOnly: boolean;
  embeddingPresets: string[];
  rerankPresets: string[];
}

/** 市面常用厂商目录：生成协议与厂商身份分离，presets 仅用于对应模型用途。 */
export const MODEL_PROVIDER_CATALOG: ModelProviderCatalogEntry[] = [
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', api: 'openai-responses', generationOnly: false, embeddingPresets: ['text-embedding-3-small', 'text-embedding-3-large'], rerankPresets: [] },
  { id: 'anthropic', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com', api: 'anthropic-messages', generationOnly: true, embeddingPresets: [], rerankPresets: [] },
  { id: 'google', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generate-content', generationOnly: true, embeddingPresets: [], rerankPresets: [] },
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'moonshot', label: 'Moonshot AI', endpoint: 'https://api.moonshot.cn/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'qwen', label: '通义千问（百炼）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['text-embedding-v3', 'text-embedding-v2'], rerankPresets: ['gte-rerank-v2'] },
  { id: 'zhipu', label: '智谱 AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', generationOnly: false, embeddingPresets: ['embedding-3'], rerankPresets: [] },
  { id: 'siliconflow', label: 'SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'], rerankPresets: ['BAAI/bge-reranker-v2-m3'] },
  { id: 'jina', label: 'Jina AI', endpoint: 'https://api.jina.ai/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['jina-embeddings-v3', 'jina-embeddings-v2-base-zh'], rerankPresets: ['jina-reranker-v2-base-multilingual'] },
  { id: 'voyage', label: 'Voyage AI', endpoint: 'https://api.voyageai.com/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: ['voyage-3', 'voyage-zh-3'], rerankPresets: ['rerank-2'] },
  { id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
  { id: 'custom', label: '自定义 OpenAI 兼容 API', endpoint: '', api: 'openai-completions', generationOnly: false, embeddingPresets: [], rerankPresets: [] },
];

export const OLLAMA_EMBEDDING_PRESETS = ['bge-m3', 'nomic-embed-text', 'm3e-base'];

export interface HubStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

interface StoredProvider {
  endpoint?: string;
  api?: Exclude<AiGenerationApi, 'ollama-chat'>;
  models?: string[];
}

const hubKey = 'modelHub';
const providersKey = 'modelProviders';
const secretsKey = 'modelProviderSecrets';

function readRecord(store: HubStore, key: string): Record<string, unknown> {
  const stored = store.get(key);
  return (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
}

function readStoredProviders(store: HubStore): Record<string, StoredProvider> {
  const record = readRecord(store, providersKey);
  const result: Record<string, StoredProvider> = {};
  for (const [id, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    result[id] = {
      endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : undefined,
      api: isRemoteGenerationApi(entry.api) ? entry.api : undefined,
      models: Array.isArray(entry.models) ? entry.models.filter((name): name is string => typeof name === 'string') : undefined,
    };
  }
  return result;
}

function readSecrets(store: HubStore): Record<string, string> {
  const record = readRecord(store, secretsKey);
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value === 'string' && value) result[id] = value;
  }
  return result;
}

function catalogEntry(id: string): ModelProviderCatalogEntry {
  return MODEL_PROVIDER_CATALOG.find((entry) => entry.id === id) ?? MODEL_PROVIDER_CATALOG[MODEL_PROVIDER_CATALOG.length - 1];
}

function normalizeSlot(value: unknown, fallback: ModelSlot, allowNone: boolean): ModelSlot {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source : fallback.source;
  return {
    source: source === OLLAMA_SOURCE_ID ? OLLAMA_SOURCE_ID : source === NO_SOURCE_ID && allowNone ? NO_SOURCE_ID : source,
    model: typeof record.model === 'string' ? record.model : fallback.model,
  };
}

/** 读取模型中枢；首读时把旧版单一 aiProvider 配置迁移为「厂商连接 + 用途槽位」结构。 */
export function readModelHub(store: HubStore): ModelHub {
  const stored = store.get(hubKey);
  const record = (stored && typeof stored === 'object' ? stored : null) as Record<string, unknown> | null;
  const providers = readStoredProviders(store);
  const secrets = readSecrets(store);

  let ollamaEndpoint = '';
  let remoteConsent = true;
  let slots: Record<ModelSlotId, ModelSlot> = {
    generation: { source: OLLAMA_SOURCE_ID, model: '' },
    embedding: { source: OLLAMA_SOURCE_ID, model: '' },
    rerank: { source: NO_SOURCE_ID, model: '' },
  };

  if (record) {
    ollamaEndpoint = typeof record.ollamaEndpoint === 'string' ? record.ollamaEndpoint : '';
    // 旧版开关不再暴露；读取时自动迁移为已同意，避免旧值形成不可见阻断。
    remoteConsent = true;
    const storedSlots = (record.slots && typeof record.slots === 'object' ? record.slots : {}) as Record<string, unknown>;
    slots = {
      generation: normalizeSlot(storedSlots.generation, slots.generation, false),
      embedding: normalizeSlot(storedSlots.embedding, slots.embedding, false),
      rerank: normalizeSlot(storedSlots.rerank, slots.rerank, true),
    };
  }

  return {
    ollamaEndpoint,
    ollamaEmbeddingPresets: OLLAMA_EMBEDDING_PRESETS,
    remoteConsent,
    slots,
    providers: MODEL_PROVIDER_CATALOG.map((entry) => {
      const storedProvider = providers[entry.id];
      return {
        id: entry.id,
        label: entry.label,
        endpoint: storedProvider?.endpoint ?? entry.endpoint,
        defaultEndpoint: entry.endpoint,
        api: storedProvider?.api ?? entry.api,
        generationOnly: entry.generationOnly,
        hasKey: Boolean(secrets[entry.id]),
        models: storedProvider?.models ?? [],
        embeddingPresets: entry.embeddingPresets,
        rerankPresets: entry.rerankPresets,
      };
    }),
  };
}

export interface LegacyModelConfig {
  provider?: (Omit<AiProviderConfig, 'apiKey'> & { hasApiKey?: boolean }) | null;
  providerSecret?: string;
  embeddingModel: string;
}

/** 旧版单一 aiProvider + semanticEmbeddingModel 迁移到模型中枢；已迁移则直接跳过。 */
export function ensureModelHubMigrated(store: HubStore, legacy: LegacyModelConfig): void {
  if (store.get(hubKey)) return;
  const providers: Record<string, StoredProvider> = {};
  const secrets: Record<string, string> = {};
  let generation: ModelSlot = { source: OLLAMA_SOURCE_ID, model: '' };
  let ollamaEndpoint = '';
  let remoteConsent = true;

  const previous = legacy.provider;
  if (previous?.kind === 'openai-compatible') {
    const id = MODEL_PROVIDER_CATALOG.some((entry) => entry.id === previous.provider) ? (previous.provider as string) : 'custom';
    providers[id] = {
      endpoint: previous.endpoint ?? '',
      models: (previous.availableModels ?? []).map((model) => model.name).filter(Boolean),
    };
    if (legacy.providerSecret) secrets[id] = legacy.providerSecret;
    generation = { source: id, model: previous.model ?? '' };
    remoteConsent = true;
  } else if (previous?.kind === 'ollama') {
    ollamaEndpoint = previous.endpoint ?? '';
    generation = { source: OLLAMA_SOURCE_ID, model: previous.model ?? '' };
  }

  store.set(providersKey, providers);
  if (Object.keys(secrets).length) store.set(secretsKey, secrets);
  store.set(hubKey, {
    version: 1,
    ollamaEndpoint,
    remoteConsent,
    slots: {
      generation,
      embedding: { source: OLLAMA_SOURCE_ID, model: legacy.embeddingModel },
      rerank: { source: NO_SOURCE_ID, model: '' },
    },
  });
}

export function saveModelHub(store: HubStore, patch: ModelHubPatch): ModelHub {
  const current = readModelHub(store);
  const slots: Record<ModelSlotId, ModelSlot> = {
    generation: normalizeSlot({ ...current.slots.generation, ...patch.slots?.generation }, current.slots.generation, false),
    embedding: normalizeSlot({ ...current.slots.embedding, ...patch.slots?.embedding }, current.slots.embedding, false),
    rerank: normalizeSlot({ ...current.slots.rerank, ...patch.slots?.rerank }, current.slots.rerank, true),
  };
  if (slots.generation.source === NO_SOURCE_ID) slots.generation = { ...slots.generation, source: OLLAMA_SOURCE_ID };
  if (slots.embedding.source === NO_SOURCE_ID) slots.embedding = { ...slots.embedding, source: OLLAMA_SOURCE_ID };
  const embeddingProvider = current.providers.find((provider) => provider.id === slots.embedding.source);
  if (embeddingProvider?.generationOnly) slots.embedding = { source: OLLAMA_SOURCE_ID, model: '' };
  const rerankProvider = current.providers.find((provider) => provider.id === slots.rerank.source);
  if (rerankProvider?.generationOnly) slots.rerank = { source: NO_SOURCE_ID, model: '' };
  store.set(hubKey, {
    version: 1,
    ollamaEndpoint: typeof patch.ollamaEndpoint === 'string' ? patch.ollamaEndpoint.trim() : current.ollamaEndpoint,
    remoteConsent: true,
    slots,
  });
  return readModelHub(store);
}

export function saveProviderConnection(store: HubStore, id: string, patch: { endpoint?: string; api?: Exclude<AiGenerationApi, 'ollama-chat'>; apiKey?: string | null; models?: string[] }): ModelHub {
  if (!MODEL_PROVIDER_CATALOG.some((entry) => entry.id === id)) throw new Error('未知的模型厂商。');
  const providers = readStoredProviders(store);
  const current = providers[id] ?? {};
  const next: StoredProvider = { ...current };
  if (typeof patch.endpoint === 'string') next.endpoint = patch.endpoint.trim() || catalogEntry(id).endpoint;
  if (patch.api && isRemoteGenerationApi(patch.api)) next.api = patch.api;
  if (Array.isArray(patch.models)) next.models = [...new Set(patch.models.map((name) => name.trim()).filter(Boolean))].slice(0, 300);
  providers[id] = next;
  store.set(providersKey, providers);

  const enteredKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    const secrets = readSecrets(store);
    secrets[id] = safeStorage.encryptString(enteredKey).toString('base64');
    store.set(secretsKey, secrets);
  }
  return readModelHub(store);
}

/** 主进程内部取用厂商凭据；渲染进程只能看到 hasKey。 */
export function resolveProviderCredentials(store: HubStore, id: string): { endpoint: string; apiKey?: string } {
  const hub = readModelHub(store);
  const provider = hub.providers.find((entry) => entry.id === id);
  const endpoint = provider?.endpoint || catalogEntry(id).endpoint;
  const encrypted = readSecrets(store)[id];
  if (!endpoint) return { endpoint: '' };
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return { endpoint };
  try {
    return { endpoint, apiKey: safeStorage.decryptString(Buffer.from(encrypted, 'base64')) };
  } catch {
    return { endpoint };
  }
}

export function storeProviderModels(store: HubStore, id: string, models: string[]): void {
  saveProviderConnection(store, id, { models });
}

/** 生成槽位 → 运行时 AiProviderConfig（供 configureAiProvider 使用）。 */
export function resolveGenerationConfig(store: HubStore): AiProviderConfig {
  const hub = readModelHub(store);
  const slot = hub.slots.generation;
  if (slot.source === OLLAMA_SOURCE_ID) {
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model: slot.model.trim() || undefined };
  }
  const credentials = resolveProviderCredentials(store, slot.source);
  const provider = hub.providers.find((entry) => entry.id === slot.source);
  return {
    kind: 'openai-compatible',
    provider: slot.source,
    api: provider?.api ?? catalogEntry(slot.source).api,
    endpoint: credentials.endpoint || catalogEntry(slot.source).endpoint,
    apiKey: credentials.apiKey,
    model: slot.model.trim() || undefined,
    availableModels: (provider?.models ?? []).map((name) => ({ name })),
    remoteContentConsent: hub.remoteConsent,
  };
}

export type ResolvedEmbeddingSource =
  | { kind: 'ollama'; endpoint?: string; model: string }
  | { kind: 'remote'; endpoint: string; apiKey: string; model: string };

/** 嵌入槽位 → 索引运行时来源；远程嵌入必须已同意远程发送且密钥可用。 */
export function resolveEmbeddingSource(store: HubStore): ResolvedEmbeddingSource | null {
  const hub = readModelHub(store);
  const slot = hub.slots.embedding;
  const model = slot.model.trim();
  if (!model) return null;
  if (slot.source === OLLAMA_SOURCE_ID) {
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model };
  }
  const provider = hub.providers.find((entry) => entry.id === slot.source);
  if (provider?.generationOnly) return null;
  if (!hub.remoteConsent) return null;
  const credentials = resolveProviderCredentials(store, slot.source);
  if (!credentials.endpoint || !credentials.apiKey) return null;
  return { kind: 'remote', endpoint: credentials.endpoint, apiKey: credentials.apiKey, model };
}

function isRemoteGenerationApi(value: unknown): value is Exclude<AiGenerationApi, 'ollama-chat'> {
  return value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
    || value === 'google-generate-content';
}
