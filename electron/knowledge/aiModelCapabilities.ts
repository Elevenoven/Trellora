import { resolveEffectiveContextWindow } from '../../shared/effectiveContextWindow';
import type { AssistantThinkingMode } from './assistantTurnTypes';
import type { AiGenerationApi, AiProviderConfig, AiRemoteProviderId, OllamaModel } from './aiTypes';

export type AiThinkingDialect = 'none' | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen' | 'openrouter';
export type AiMaxOutputTokensField = 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | 'maxOutputTokens';

export interface AiModelDescriptor {
  provider: AiRemoteProviderId | 'ollama';
  id: string;
  api: AiGenerationApi;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  reasoning: boolean;
  thinkingDialect: AiThinkingDialect;
  maxOutputTokensField: AiMaxOutputTokensField;
  supportsStreamUsage: boolean;
}

interface RemoteProviderProtocolProfile {
  api: Exclude<AiGenerationApi, 'ollama-chat'>;
  thinkingDialect: AiThinkingDialect;
  maxOutputTokensField: AiMaxOutputTokensField;
  supportsStreamUsage: boolean;
}

const defaultRemoteProfile: RemoteProviderProtocolProfile = {
  api: 'openai-completions',
  thinkingDialect: 'none',
  maxOutputTokensField: 'max_tokens',
  supportsStreamUsage: false,
};

const remoteProviderProfiles: Record<AiRemoteProviderId, RemoteProviderProtocolProfile> = {
  openai: {
    api: 'openai-responses',
    thinkingDialect: 'openai',
    maxOutputTokensField: 'max_output_tokens',
    supportsStreamUsage: false,
  },
  anthropic: {
    api: 'anthropic-messages',
    thinkingDialect: 'anthropic',
    maxOutputTokensField: 'max_tokens',
    supportsStreamUsage: false,
  },
  google: {
    api: 'google-generate-content',
    thinkingDialect: 'gemini',
    maxOutputTokensField: 'maxOutputTokens',
    supportsStreamUsage: false,
  },
  deepseek: {
    api: 'openai-completions',
    thinkingDialect: 'deepseek',
    maxOutputTokensField: 'max_tokens',
    supportsStreamUsage: true,
  },
  qwen: {
    api: 'openai-completions',
    thinkingDialect: 'qwen',
    maxOutputTokensField: 'max_tokens',
    supportsStreamUsage: false,
  },
  openrouter: {
    api: 'openai-completions',
    thinkingDialect: 'openrouter',
    maxOutputTokensField: 'max_tokens',
    supportsStreamUsage: false,
  },
  moonshot: defaultRemoteProfile,
  zhipu: defaultRemoteProfile,
  siliconflow: defaultRemoteProfile,
  custom: defaultRemoteProfile,
};

export function resolveRemoteProvider(config: AiProviderConfig): AiRemoteProviderId {
  if (config.provider && config.provider in remoteProviderProfiles) return config.provider;
  try {
    const hostname = new URL(normalizeEndpoint(config.endpoint || '')).hostname.toLowerCase();
    if (hostname === 'api.deepseek.com') return 'deepseek';
    if (hostname === 'api.openai.com') return 'openai';
    if (hostname === 'api.anthropic.com') return 'anthropic';
    if (hostname === 'generativelanguage.googleapis.com') return 'google';
    if (hostname === 'dashscope.aliyuncs.com') return 'qwen';
    if (hostname === 'openrouter.ai') return 'openrouter';
  } catch {
    // Invalid/custom endpoints deliberately use conservative capabilities.
  }
  return 'custom';
}

export function resolveAiModelDescriptor(config: AiProviderConfig, selectedModel = config.model ?? ''): AiModelDescriptor {
  const id = selectedModel.trim() || config.model?.trim() || '';
  const metadata = findModelMetadata(config.availableModels, id);
  if (config.kind === 'ollama') {
    const contextWindowTokens = resolveEffectiveContextWindow({
      providerId: 'ollama',
      modelId: id,
      configuredModelWindow: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
      knownModelWindow: metadata?.contextWindowTokens,
      modelMaxOutputTokens: metadata?.maxOutputTokens,
    }).tokens;
    return {
      provider: 'ollama',
      id,
      api: 'ollama-chat',
      contextWindowTokens,
      ...(metadata?.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
      reasoning: metadata?.reasoning ?? false,
      thinkingDialect: 'none',
      maxOutputTokensField: 'max_tokens',
      supportsStreamUsage: false,
    };
  }

  const provider = resolveRemoteProvider(config);
  const profile = remoteProviderProfiles[provider] ?? defaultRemoteProfile;
  const api = config.api && config.api !== 'ollama-chat' ? config.api : profile.api;
  const contextWindowTokens = resolveEffectiveContextWindow({
    providerId: provider,
    modelId: id,
    configuredModelWindow: config.contextWindowTokensSource === 'user' ? config.contextWindowTokens : undefined,
    knownModelWindow: metadata?.contextWindowTokens,
    modelMaxOutputTokens: metadata?.maxOutputTokens,
  }).tokens;
  return {
    provider,
    id,
    api,
    contextWindowTokens,
    ...(metadata?.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
    reasoning: metadata?.reasoning ?? inferReasoningSupport(provider, id),
    thinkingDialect: resolveThinkingDialect(api, profile.thinkingDialect),
    maxOutputTokensField: resolveMaxOutputTokensField(api, profile.maxOutputTokensField),
    supportsStreamUsage: api === 'openai-completions' && (provider === 'openai' || profile.supportsStreamUsage),
  };
}

/** Maps the UI's provider-neutral simple/advanced choice to the selected wire dialect. */
export function resolveThinkingOptions(
  descriptor: AiModelDescriptor,
  mode?: AssistantThinkingMode,
  resolvedMaxOutputTokens?: number,
): Record<string, unknown> {
  if (descriptor.thinkingDialect === 'qwen') {
    // DashScope 混合思考模型家族：qwen3 系列与 qwen-plus/turbo/flash 均支持 enable_thinking 开关。
    const isQwenHybrid = (/^qwen3(?:[._-]|$)/iu.test(descriptor.id)
      || /^(?:qwen-plus|qwen-turbo|qwen-flash)(?:[._-]|$)/iu.test(descriptor.id))
      && !/(?:^|[._-])thinking(?:[._-]|$)/iu.test(descriptor.id);
    return isQwenHybrid ? { enable_thinking: mode === 'advanced' } : {};
  }
  if (!mode) return {};
  if (descriptor.thinkingDialect === 'deepseek') {
    return mode === 'advanced'
      ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
      : { thinking: { type: 'disabled' } };
  }
  if (descriptor.thinkingDialect === 'openai' && descriptor.reasoning) {
    const effort = mode === 'advanced' ? 'high' : 'low';
    // Responses API 请求 reasoning summary，以便流式渲染深度思考过程。
    return descriptor.api === 'openai-responses' ? { reasoning: { effort, summary: 'auto' } } : { reasoning_effort: effort };
  }
  if (descriptor.thinkingDialect === 'anthropic' && descriptor.reasoning) {
    if (usesAnthropicAdaptiveThinking(descriptor.id)) {
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort: mode === 'advanced' ? 'high' : 'low' },
      };
    }
    const maxTokens = resolvedMaxOutputTokens ?? descriptor.maxOutputTokens ?? 8_192;
    if (maxTokens <= 1_024) {
      throw new Error('Claude 手动思考要求 maxOutputTokens 大于 1024。');
    }
    const budgetTokens = mode === 'advanced'
      ? Math.min(16_000, maxTokens - 1_024)
      : 1_024;
    return { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
  }
  if (descriptor.thinkingDialect === 'gemini' && descriptor.reasoning) {
    if (/^gemini-3(?:[.-]|$)/iu.test(descriptor.id)) {
      return { thinkingConfig: { thinkingLevel: mode === 'advanced' ? 'high' : 'low' } };
    }
    if (/^gemini-2\.5(?:[.-]|$)/iu.test(descriptor.id)) {
      const maxTokens = resolvedMaxOutputTokens ?? descriptor.maxOutputTokens ?? 8_192;
      return { thinkingConfig: { thinkingBudget: mode === 'advanced' ? Math.min(8_192, Math.max(1_024, maxTokens - 1)) : Math.min(1_024, Math.max(0, maxTokens - 1)) } };
    }
  }
  if (descriptor.thinkingDialect === 'openrouter' && descriptor.reasoning) {
    return { reasoning: { effort: mode === 'advanced' ? 'high' : 'low' } };
  }
  return {};
}

export function resolveMaxOutputTokensOptions(descriptor: AiModelDescriptor, requested?: number): Record<string, number> {
  const value = resolveMaxOutputTokensValue(descriptor, requested);
  if (!value) return {};
  return { [descriptor.maxOutputTokensField]: value };
}

export function resolveMaxOutputTokensValue(descriptor: AiModelDescriptor, requested?: number, fallback?: number): number | undefined {
  const candidate = requested ?? fallback;
  if (!candidate) return undefined;
  return descriptor.maxOutputTokens ? Math.min(candidate, descriptor.maxOutputTokens) : candidate;
}

function findModelMetadata(models: OllamaModel[] | undefined, id: string): OllamaModel | undefined {
  return id ? models?.find((model) => model.name.trim() === id) : undefined;
}

function inferReasoningSupport(provider: AiRemoteProviderId, model: string): boolean {
  if (provider === 'deepseek') return true;
  if (provider === 'qwen') return /^qwen3(?:[._-]|$)/iu.test(model);
  if (provider === 'openai') return /^(?:gpt-5(?:[.-]|$)|o(?:1|3|4)(?:[.-]|$))/iu.test(model);
  if (provider === 'anthropic') return /^claude(?:[.-]|$)/iu.test(model);
  if (provider === 'google') return /^gemini-(?:2\.5|3)(?:[.-]|$)/iu.test(model);
  return false;
}

function resolveThinkingDialect(api: AiGenerationApi, fallback: AiThinkingDialect): AiThinkingDialect {
  if (api === 'openai-responses') return 'openai';
  if (api === 'anthropic-messages') return 'anthropic';
  if (api === 'google-generate-content') return 'gemini';
  return fallback;
}

function resolveMaxOutputTokensField(api: AiGenerationApi, fallback: AiMaxOutputTokensField): AiMaxOutputTokensField {
  if (api === 'openai-completions' && fallback === 'max_output_tokens') return 'max_completion_tokens';
  if (api === 'openai-responses') return 'max_output_tokens';
  if (api === 'anthropic-messages') return 'max_tokens';
  if (api === 'google-generate-content') return 'maxOutputTokens';
  return fallback;
}

function usesAnthropicAdaptiveThinking(model: string): boolean {
  if (!/^claude(?:[.-]|$)/iu.test(model)) return false;
  if (/^claude-[a-z0-9]+-(?:[5-9](?:[.-]|$)|4-(?:6|[7-9])(?:[.-]|$))/iu.test(model)) return true;
  return /^claude-mythos-preview(?:[.-]|$)/iu.test(model)
    || /(?:^|[.-])adaptive(?:[.-]|$)/iu.test(model);
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
