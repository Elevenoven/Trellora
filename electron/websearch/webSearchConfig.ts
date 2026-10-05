import { safeStorage } from 'electron';
import type { WebSearchConfig, WebSearchProviderExtras, WebSearchProviderId, WebSearchRuntimeConfig } from './webSearchTypes';
import { WEB_SEARCH_MAX_RESULTS_DEFAULT, WEB_SEARCH_MAX_RESULTS_MAX, WEB_SEARCH_MAX_RESULTS_MIN, webSearchProviderIds } from './webSearchTypes';
import { normalizeProviderExtras } from './webSearchProviders';

/**
 * 联网搜索应用级配置（联网搜索设计方案 §6.1，对齐 parsingConfig.ts 范式）：
 * - 公共字段与厂商自留字段分组存储，切换厂商不丢已填配置；
 * - 密钥用 safeStorage 加密单独存键，渲染进程只见 has*Key 标志；
 * - 非密动态配置项（providerExtras）按厂商 configFields 校验并补默认值（对标 WeKnora ExtraConfig）；
 * - 联网搜索的隐私确认已内置为同意；保留 consent 字段仅兼容旧配置和运行时协议。
 */

interface WebSearchStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

const webSearchConfigKey = 'webSearch';
const webSearchSecretKey = 'webSearchSecret';
const webSearchTavilySecretKey = 'webSearchSecretTavily';
const webSearchBaiduSecretKey = 'webSearchSecretBaidu';

export const defaultWebSearchConfig: WebSearchConfig = {
  enabled: false,
  provider: 'zhipu',
  maxResults: WEB_SEARCH_MAX_RESULTS_DEFAULT,
  consent: true,
  searxngUrl: '',
  hasZhipuKey: false,
  hasTavilyKey: false,
  hasBaiduKey: false,
  providerExtras: {},
};

/** 读取联网搜索配置；密钥不回显，仅以 has*Key 表达是否已保存。 */
export function readWebSearchConfig(store: WebSearchStore): WebSearchConfig {
  const stored = store.get(webSearchConfigKey);
  const record = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const provider = record.provider;
  return {
    enabled: record.enabled === true,
    provider: webSearchProviderIds.includes(provider as WebSearchProviderId) ? (provider as WebSearchProviderId) : 'zhipu',
    maxResults: clampMaxResults(record.maxResults),
    // 历史版本要求在设置页额外确认；现在无需重复勾选，旧配置也一并迁移为已同意。
    consent: true,
    searxngUrl: typeof record.searxngUrl === 'string' ? record.searxngUrl : '',
    hasZhipuKey: Boolean(store.get(webSearchSecretKey)),
    hasTavilyKey: Boolean(store.get(webSearchTavilySecretKey)),
    hasBaiduKey: Boolean(store.get(webSearchBaiduSecretKey)),
    providerExtras: readProviderExtras(record.providerExtras),
  };
}

/** 供主进程内部装配适配器运行时配置；解密后的密钥不落盘不回传渲染进程。 */
export function readWebSearchRuntimeConfig(store: WebSearchStore): WebSearchRuntimeConfig {
  const config = readWebSearchConfig(store);
  return {
    zhipu: { apiKey: readSecret(store, webSearchSecretKey), extras: config.providerExtras.zhipu },
    searxng: { url: config.searxngUrl },
    tavily: { apiKey: readSecret(store, webSearchTavilySecretKey) },
    baidu: { apiKey: readSecret(store, webSearchBaiduSecretKey) },
  };
}

function readSecret(store: WebSearchStore, key: string): string | undefined {
  const encrypted = store.get(key);
  if (typeof encrypted !== 'string' || !encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

/** 逐厂商归一化非密配置取值；未知厂商键丢弃，非法取值回退默认。 */
function readProviderExtras(raw: unknown): Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const extras: Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> = {};
  for (const id of webSearchProviderIds) {
    if (source[id] !== undefined) extras[id] = normalizeProviderExtras(id, source[id]);
  }
  return extras;
}

export type WebSearchConfigPatch = Partial<Omit<WebSearchConfig, 'hasZhipuKey' | 'hasTavilyKey' | 'hasBaiduKey'>> & {
  /** 传入字符串（含空串）表示清空密钥；明文只出现在保存请求中。 */
  zhipuApiKey?: string | null;
  tavilyApiKey?: string | null;
  baiduApiKey?: string | null;
};

export function saveWebSearchConfig(store: WebSearchStore, patch: WebSearchConfigPatch): WebSearchConfig {
  const current = readWebSearchConfig(store);
  const consent = true;
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
  const next: WebSearchConfig = {
    enabled,
    provider: patch.provider !== undefined && webSearchProviderIds.includes(patch.provider) ? patch.provider : current.provider,
    maxResults: patch.maxResults !== undefined ? clampMaxResults(patch.maxResults) : current.maxResults,
    consent,
    searxngUrl: typeof patch.searxngUrl === 'string' ? normalizeSearxngUrl(patch.searxngUrl) : current.searxngUrl,
    hasZhipuKey: applySecretPatch(store, webSearchSecretKey, patch.zhipuApiKey) ?? current.hasZhipuKey,
    hasTavilyKey: applySecretPatch(store, webSearchTavilySecretKey, patch.tavilyApiKey) ?? current.hasTavilyKey,
    hasBaiduKey: applySecretPatch(store, webSearchBaiduSecretKey, patch.baiduApiKey) ?? current.hasBaiduKey,
    providerExtras: patch.providerExtras !== undefined ? mergeProviderExtras(current.providerExtras, patch.providerExtras) : current.providerExtras,
  };
  store.set(webSearchConfigKey, {
    enabled: next.enabled,
    provider: next.provider,
    maxResults: next.maxResults,
    consent: next.consent,
    searxngUrl: next.searxngUrl,
    providerExtras: next.providerExtras,
  });
  return next;
}

/** 密钥补丁写入：字符串（含空串）表示设置/清空，undefined/null 表示不动；返回新的存在标志。 */
function applySecretPatch(store: WebSearchStore, key: string, value: string | null | undefined): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const enteredKey = value.trim();
  if (enteredKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存。');
    store.set(key, safeStorage.encryptString(enteredKey).toString('base64'));
    return true;
  }
  store.set(key, null);
  return false;
}

/** 合并非密配置补丁：只覆盖补丁中出现的厂商，其余保持现状。 */
function mergeProviderExtras(
  current: Partial<Record<WebSearchProviderId, WebSearchProviderExtras>>,
  patch: unknown,
): Partial<Record<WebSearchProviderId, WebSearchProviderExtras>> {
  const next = { ...current };
  const source = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  for (const id of webSearchProviderIds) {
    if (source[id] !== undefined) next[id] = normalizeProviderExtras(id, source[id]);
  }
  return next;
}

function clampMaxResults(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : WEB_SEARCH_MAX_RESULTS_DEFAULT;
  return Math.max(WEB_SEARCH_MAX_RESULTS_MIN, Math.min(WEB_SEARCH_MAX_RESULTS_MAX, parsed));
}

function normalizeSearxngUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('SearXNG 实例地址格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('SearXNG 实例地址必须是不含账号信息的 HTTP/HTTPS 地址。');
  }
  return trimmed.replace(/\/+$/u, '');
}
