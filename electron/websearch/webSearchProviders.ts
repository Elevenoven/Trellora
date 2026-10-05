import type { WebSearchProviderAdapter, WebSearchProviderExtras, WebSearchProviderId, WebSearchRuntimeConfig } from './webSearchTypes';
import { zhipuSearchProvider } from './zhipuSearchProvider';
import { duckduckgoSearchProvider } from './duckduckgoSearchProvider';
import { searxngSearchProvider } from './searxngSearchProvider';
import { tavilySearchProvider } from './tavilySearchProvider';
import { baiduSearchProvider } from './baiduSearchProvider';

/**
 * 联网搜索适配器注册表 + 工厂（联网搜索设计方案 §3.1，对标 WeKnora
 * WebSearchService 按 providerID 路由）。注册顺序即设置页展示顺序；
 * 新增厂商：实现适配器后调用 registerWebSearchProvider 一行注册。
 */
const registry = new Map<WebSearchProviderId, WebSearchProviderAdapter>();

export function registerWebSearchProvider(adapter: WebSearchProviderAdapter): void {
  if (registry.has(adapter.id)) throw new Error(`联网搜索适配器 ${adapter.id} 重复注册。`);
  registry.set(adapter.id, adapter);
}

registerWebSearchProvider(zhipuSearchProvider);
registerWebSearchProvider(duckduckgoSearchProvider);
registerWebSearchProvider(searxngSearchProvider);
registerWebSearchProvider(tavilySearchProvider);
registerWebSearchProvider(baiduSearchProvider);

export function listWebSearchProviders(): WebSearchProviderAdapter[] {
  return [...registry.values()];
}

export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProviderAdapter | undefined {
  return registry.get(id);
}

export interface ResolvedWebSearchProvider {
  adapter?: WebSearchProviderAdapter;
  /** 适配器存在但前置配置不满足时的中文可操作错误（能力门控据此降级）。 */
  error?: string;
}

/**
 * 按当前配置解析生效适配器；前置校验由各厂商的 validateConfig 自持，
 * 缺配置返回明确错误而非运行时噪音。
 */
export function resolveWebSearchProvider(input: {
  provider: WebSearchProviderId;
  config: WebSearchRuntimeConfig;
}): ResolvedWebSearchProvider {
  const adapter = registry.get(input.provider);
  if (!adapter) return { error: `未知联网搜索厂商 ${input.provider}。` };
  const validationError = adapter.validateConfig?.(input.config);
  if (validationError) return { adapter, error: validationError };
  return { adapter };
}

/**
 * 按厂商 configFields 校验并补全非密配置取值（对标 WeKnora Parameters.ExtraConfig）：
 * 未知键丢弃，非法取值回退字段默认值；无 configFields 的厂商返回空集。
 */
export function normalizeProviderExtras(providerId: WebSearchProviderId, raw: unknown): WebSearchProviderExtras {
  const fields = registry.get(providerId)?.configFields ?? [];
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const extras: WebSearchProviderExtras = {};
  for (const field of fields) {
    const value = source[field.key];
    extras[field.key] = typeof value === 'string' && field.options.some((option) => option.value === value) ? value : field.default;
  }
  return extras;
}
