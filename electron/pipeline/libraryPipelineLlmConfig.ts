import fs from 'node:fs';
import path from 'node:path';
import { MODEL_PROVIDER_CATALOG, OLLAMA_SOURCE_ID, readModelHub, resolveGenerationConfig, resolveProviderCredentials } from '../knowledge/modelHub';
import type { AiProviderConfig } from '../knowledge/aiTypes';
import { assertExistingDirectory } from '../pathGuards';
import { atomicWriteJson } from './pathLayout';

export const LIBRARY_PIPELINE_LLM_SCHEMA_VERSION = 1;
export const LIBRARY_PIPELINE_LLM_CONFIG_FILE_NAME = 'pipeline-llm.json';

/**
 * 资料库级语言模型绑定：source/model 为空表示跟随全局生成槽位。
 * 绑定后用于该资料库歧义消解、智能切块与图谱增强（GraphRAG）的 LLM 调用。
 */
export interface LibraryPipelineLlmBinding {
  schemaVersion: 1;
  source: string;
  model: string;
}

export const DEFAULT_LIBRARY_PIPELINE_LLM_BINDING: LibraryPipelineLlmBinding = {
  schemaVersion: LIBRARY_PIPELINE_LLM_SCHEMA_VERSION,
  source: '',
  model: '',
};

export class LibraryPipelineLlmConfigError extends Error {
  readonly code: 'PIPELINE_LLM_CONFIG_INVALID' | 'PIPELINE_LLM_CONFIG_WRITE_FAILED';

  constructor(code: LibraryPipelineLlmConfigError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LibraryPipelineLlmConfigError';
    this.code = code;
  }
}

export function libraryPipelineLlmConfigPath(libraryPath: string): string {
  return path.join(path.resolve(libraryPath), '.menghan-meta', 'config', LIBRARY_PIPELINE_LLM_CONFIG_FILE_NAME);
}

export function readLibraryPipelineLlmBinding(libraryPath: string): LibraryPipelineLlmBinding {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const configPath = libraryPipelineLlmConfigPath(normalizedLibraryPath);
  if (!fs.existsSync(configPath)) return { ...DEFAULT_LIBRARY_PIPELINE_LLM_BINDING };
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_INVALID', `资料库语言模型绑定无法读取：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return normalizeLibraryPipelineLlmBinding(value);
}

export function saveLibraryPipelineLlmBinding(libraryPath: string, patch: unknown): LibraryPipelineLlmBinding {
  const normalizedLibraryPath = assertExistingDirectory(libraryPath);
  const candidate = (patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  const binding = normalizeLibraryPipelineLlmBinding({ ...readLibraryPipelineLlmBinding(normalizedLibraryPath), ...candidate });
  const configPath = libraryPipelineLlmConfigPath(normalizedLibraryPath);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteJson(configPath, binding);
  } catch (error) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_WRITE_FAILED', `资料库语言模型绑定写入失败：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return binding;
}

function normalizeLibraryPipelineLlmBinding(value: unknown): LibraryPipelineLlmBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LibraryPipelineLlmConfigError('PIPELINE_LLM_CONFIG_INVALID', '资料库语言模型绑定必须是 JSON 对象。');
  }
  const candidate = value as Record<string, unknown>;
  return {
    schemaVersion: LIBRARY_PIPELINE_LLM_SCHEMA_VERSION,
    source: typeof candidate.source === 'string' ? candidate.source.trim() : '',
    model: typeof candidate.model === 'string' ? candidate.model.trim().slice(0, 120) : '',
  };
}

interface HubReadStore {
  get: (key: string) => unknown;
}

/** 资料库绑定 → 运行时 AiProviderConfig；未绑定时回退全局生成槽位，保证流水线总有解析结果。 */
export function resolveLibraryPipelineLlmConfig(store: HubReadStore, libraryPath: string): AiProviderConfig {
  const binding = readLibraryPipelineLlmBinding(libraryPath);
  const model = binding.model.trim();
  if (!model || !binding.source) return resolveGenerationConfig(store);
  if (binding.source === OLLAMA_SOURCE_ID) {
    const hub = readModelHub(store);
    return { kind: 'ollama', endpoint: hub.ollamaEndpoint.trim() || undefined, model };
  }
  const hub = readModelHub(store);
  const credentials = resolveProviderCredentials(store, binding.source);
  const provider = hub.providers.find((entry) => entry.id === binding.source);
  const catalog = MODEL_PROVIDER_CATALOG.find((entry) => entry.id === binding.source);
  if (!provider && !catalog) return resolveGenerationConfig(store);
  return {
    kind: 'openai-compatible',
    provider: binding.source,
    api: provider?.api ?? catalog?.api ?? 'openai-completions',
    endpoint: credentials.endpoint || catalog?.endpoint || provider?.endpoint || '',
    apiKey: credentials.apiKey,
    model,
    availableModels: (provider?.models ?? []).map((name) => ({ name })),
    remoteContentConsent: hub.remoteConsent,
  };
}
