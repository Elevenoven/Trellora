import type {
  AiExtensionsSettings,
  AiGenerationApi,
  AiModelProfile,
  AiModelProfileView,
  AiModelSettings,
  AiModelSettingsInput,
  AiProviderConfig,
  AiProviderConfigView,
  AiRemoteProviderId,
  AiSkill,
  DirectorySkillOverride,
} from './aiTypes';
import { deriveSkillDescription } from './skillDefinitionResolver';
import { getDefaultModelProfileLabel, isGeneratedModelProfileLabel } from '../../shared/modelProfileLabel';

const profileIdPattern = /^model_[A-Za-z0-9_-]{8,80}$/;
const remoteProviders = new Set<AiRemoteProviderId>(['openai', 'anthropic', 'google', 'deepseek', 'moonshot', 'qwen', 'zhipu', 'siliconflow', 'openrouter', 'custom']);
const remoteApis = new Set<Exclude<AiGenerationApi, 'ollama-chat'>>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generate-content',
]);

const retiredSkillIds = new Set(['skill_builtin_knowledge', 'skill_builtin_learning', 'skill_builtin_organize']);

export function createModelSettingsFromLegacy(config: AiProviderConfig | undefined): AiModelSettingsInput {
  const profileConfig = normalizeProviderConfig(config ?? { kind: 'ollama', endpoint: 'http://127.0.0.1:11434' });
  const profile: AiModelProfile = {
    id: 'model_legacy_default',
    label: getDefaultModelProfileLabel(profileConfig),
    config: profileConfig,
  };
  return { defaultProfileId: profile.id, profiles: [profile] };
}

export function validateModelSettingsInput(value: unknown): AiModelSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型档案设置格式无效。');
  const input = value as Record<string, unknown>;
  if (typeof input.defaultProfileId !== 'string' || !profileIdPattern.test(input.defaultProfileId)) throw new Error('默认模型档案无效。');
  if (!Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 20) throw new Error('模型档案数量应在 1 到 20 之间。');
  const ids = new Set<string>();
  const profiles = input.profiles.map((value) => normalizeModelProfile(value, ids));
  const defaultProfile = profiles.find((profile) => profile.id === input.defaultProfileId);
  if (!defaultProfile) throw new Error('默认模型档案必须存在。');
  return { defaultProfileId: input.defaultProfileId, profiles };
}

export function redactModelSettings(input: AiModelSettingsInput, hasApiKey: (profileId: string) => boolean): AiModelSettings {
  return {
    schemaVersion: 1,
    defaultProfileId: input.defaultProfileId,
    profiles: input.profiles.map((profile): AiModelProfileView => ({
      id: profile.id,
      label: profile.label,
      config: redactProviderConfig(profile.config, hasApiKey(profile.id)),
    })),
  };
}

export function normalizeProviderConfig(value: AiProviderConfig): AiProviderConfig {
  if (!value || (value.kind !== 'ollama' && value.kind !== 'openai-compatible')) throw new Error('模型连接方式无效。');
  const endpoint = readOptionalString(value.endpoint, '模型地址', 1_000);
  const model = readOptionalString(value.model, '模型名称', 200);
  const contextWindowTokens = value.contextWindowTokensSource === 'user'
    ? readPositiveInteger(value.contextWindowTokens)
    : undefined;
  const embeddingModel = readOptionalString(value.embeddingModel, '嵌入模型名称', 200);
  const apiKey = readOptionalString(value.apiKey, 'API Key', 1_024);
  const availableModels = normalizeAvailableModels(value.availableModels);
  if (value.kind === 'ollama') {
    if (value.api && value.api !== 'ollama-chat') throw new Error('本地模型 API 协议无效。');
    return { kind: 'ollama', api: 'ollama-chat', endpoint: endpoint || 'http://127.0.0.1:11434', model, ...(contextWindowTokens ? { contextWindowTokens, contextWindowTokensSource: 'user' as const } : {}), embeddingModel, availableModels };
  }
  const provider = value.provider && remoteProviders.has(value.provider) ? value.provider : 'custom';
  if (value.api && !remoteApis.has(value.api as Exclude<AiGenerationApi, 'ollama-chat'>)) throw new Error('远程模型 API 协议无效。');
  const api = value.api && value.api !== 'ollama-chat' ? value.api : defaultRemoteApi(provider);
  if (!endpoint) throw new Error('远程模型必须填写 API 地址。');
  if (!isHttpEndpoint(endpoint)) throw new Error('API 地址必须使用 http 或 https。');
  // 远程内容发送确认不再由设置页单独收集；读入旧档案时同步迁移为已同意。
  return { kind: 'openai-compatible', provider, api, endpoint: endpoint.replace(/\/+$/, ''), apiKey, model, ...(contextWindowTokens ? { contextWindowTokens, contextWindowTokensSource: 'user' as const } : {}), embeddingModel, availableModels, remoteContentConsent: true };
}

function defaultRemoteApi(provider: AiRemoteProviderId): Exclude<AiGenerationApi, 'ollama-chat'> {
  if (provider === 'openai') return 'openai-responses';
  if (provider === 'anthropic') return 'anthropic-messages';
  if (provider === 'google') return 'google-generate-content';
  return 'openai-completions';
}

export function validateExtensionsSettings(value: unknown): AiExtensionsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 扩展设置格式无效。');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.skills)) throw new Error('AI 扩展设置格式无效。');
  if (input.skills.length > 13) throw new Error('AI 扩展数量超过上限。');
  const skillIds = new Set<string>();
  // 移除旧的三个预设；完整的五个标准技能由发布资源初始化到工作区。
  const skills = input.skills.filter((item) => !retiredSkillIds.has((item as AiSkill | null)?.id ?? ''))
    .map((item) => normalizeSkill(item, skillIds));
  const directorySkillOverrides = normalizeDirectorySkillOverrides(input.directorySkillOverrides);
  return { schemaVersion: 1, skills, ...(directorySkillOverrides ? { directorySkillOverrides } : {}) };
}

export function defaultExtensionsSettings(): AiExtensionsSettings {
  return { schemaVersion: 1, skills: [] };
}

/** 目录技能登记：键为 frontmatter name，最多 100 条；空表归一化为缺省。 */
function normalizeDirectorySkillOverrides(value: unknown): Record<string, DirectorySkillOverride> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('目录技能登记格式无效。');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new Error('目录技能登记数量超过上限。');
  const result: Record<string, DirectorySkillOverride> = {};
  for (const [rawName, rawOverride] of entries) {
    const name = readRequiredString(rawName, '目录技能登记名称', 64);
    if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) throw new Error('目录技能登记格式无效。');
    const override = rawOverride as Record<string, unknown>;
    if (typeof override.enabled !== 'boolean') throw new Error('目录技能登记启用状态无效。');
    const importedAt = readOptionalString(override.importedAt, '目录技能导入时间', 40);
    result[name] = importedAt ? { enabled: override.enabled, importedAt } : { enabled: override.enabled };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeModelProfile(value: unknown, ids: Set<string>): AiModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型档案格式无效。');
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !profileIdPattern.test(input.id) || ids.has(input.id)) throw new Error('模型档案标识无效。');
  ids.add(input.id);
  const config = normalizeProviderConfig(input.config as AiProviderConfig);
  const enteredLabel = readOptionalString(input.label, '模型档案名称', 60);
  const label = enteredLabel && !isGeneratedModelProfileLabel(enteredLabel) ? enteredLabel : getDefaultModelProfileLabel(config);
  return { id: input.id, label, config };
}

function normalizeSkill(value: unknown, ids: Set<string>): AiSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 助手技能格式无效。');
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !/^skill_(builtin_[a-z]+|[A-Za-z0-9_-]{8,80})$/.test(input.id) || ids.has(input.id)) throw new Error('AI 助手技能标识无效。');
  ids.add(input.id);
  if (typeof input.enabled !== 'boolean') throw new Error('AI 助手技能启用状态无效。');
  return {
    id: input.id,
    name: readRequiredString(input.name, 'AI 助手技能名称', 60),
    description: readOptionalString(input.description, 'AI 助手技能描述', 200)
      ?? deriveSkillDescription(String(input.name ?? ''), String(input.instruction ?? '')),
    instruction: readRequiredString(input.instruction, 'AI 助手技能约束', 800),
    generationStyle: readSkillGenerationStyle(input.generationStyle, 'balanced'),
    enabled: input.enabled,
    system: false,
  };
}

function readSkillGenerationStyle(value: unknown, fallback: AiSkill['generationStyle']): AiSkill['generationStyle'] {
  if (value === undefined) return fallback;
  if (value === 'factual' || value === 'balanced' || value === 'creative') return value;
  throw new Error('AI 助手技能生成风格无效。');
}

function redactProviderConfig(config: AiProviderConfig, hasApiKey: boolean): AiProviderConfigView {
  const { apiKey: _apiKey, ...safeConfig } = config;
  return { ...safeConfig, hasApiKey };
}

function normalizeAvailableModels(value: AiProviderConfig['availableModels']): AiProviderConfig['availableModels'] {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, NonNullable<AiProviderConfig['availableModels']>[number]>();
  for (const model of value) {
    const name = typeof model?.name === 'string' ? model.name.trim().slice(0, 200) : '';
    if (!name || normalized.has(name)) continue;
    const declaredContextWindowTokens = readPositiveInteger(model.contextWindowTokens);
    const contextWindowSource = model.contextWindowSource === 'provider' || model.contextWindowSource === 'ollama'
      ? model.contextWindowSource
      : undefined;
    // Phase 0/1 wrote 128K into every catalog item without provenance. Drop
    // that legacy synthetic value so it cannot masquerade as model metadata.
    const contextWindowTokens = declaredContextWindowTokens === 131_072 && !contextWindowSource
      ? undefined
      : declaredContextWindowTokens;
    const maxOutputTokens = readPositiveInteger(model.maxOutputTokens);
    normalized.set(name, {
      name,
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(contextWindowTokens && contextWindowSource ? { contextWindowSource } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    });
  }
  return [...normalized.values()].slice(0, 200);
}

function readPositiveInteger(value: unknown): number | undefined {
  const candidate = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 && candidate <= 10_000_000 ? candidate : undefined;
}

function readRequiredString(value: unknown, label: string, maxLength: number): string {
  const result = readOptionalString(value, label, maxLength);
  if (!result) throw new Error(`${label}不能为空。`);
  return result;
}

function readOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label}格式无效。`);
  const result = value.trim();
  if (result.length > maxLength || Array.from(result).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new Error(`${label}格式无效。`);
  return result || undefined;
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
