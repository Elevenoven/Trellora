/**
 * 联网搜索厂商适配器契约（联网搜索设计方案 §3.1）。
 * 对标 WeKnora WebSearchService + 各 Provider 实现：统一接口 +
 * 注册表 + 按 providerId 路由；工具层只依赖本文件契约。
 */

/** 单条网页搜索结果；由适配器归一化产出。 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  /** 适配器若直接返回正文摘录则填入；观察渲染时统一截断。 */
  content?: string;
  /** ISO 日期字符串，可空。 */
  publishedAt?: string;
  /** 产出该结果的适配器 id，如 'zhipu' / 'duckduckgo' / 'searxng'。 */
  source: string;
}

export const webSearchProviderIds = ['zhipu', 'duckduckgo', 'searxng', 'tavily', 'baidu'] as const;
export type WebSearchProviderId = typeof webSearchProviderIds[number];

/** 适配器前置配置要求；工厂侧据此做启用前校验。 */
export type WebSearchProviderRequirement = 'none' | 'api-key' | 'endpoint';

/** 厂商非密动态配置字段的可选项（对标 WeKnora WebSearchProviderConfigFieldOption）。 */
export interface WebSearchProviderConfigFieldOption {
  label: string;
  value: string;
}

/**
 * 厂商非密动态配置字段元数据（对标 WeKnora WebSearchProviderTypeInfo.ConfigFields）：
 * 设置页据此动态渲染表单，配置层据此校验取值并补默认值；
 * 取值落在 providerExtras[adapter.id][key]。
 */
export interface WebSearchProviderConfigField {
  /** 存储键名，如 'search_engine'。 */
  key: string;
  /** 设置页展示名。 */
  label: string;
  type: 'select';
  /** 缺省/非法取值回退值。 */
  default: string;
  description?: string;
  options: WebSearchProviderConfigFieldOption[];
}

/** 各厂商非密配置取值（对标 WeKnora WebSearchProviderParameters.ExtraConfig）。 */
export type WebSearchProviderExtras = Record<string, string>;

export interface WebSearchAdapterSearchInput {
  query: string;
  maxResults: number;
  /** 解密后的厂商配置切片（密钥等），由调用方从配置层装配，不落盘不写日志。 */
  config: WebSearchRuntimeConfig;
  signal: AbortSignal;
}

/**
 * 统一厂商适配器接口：每个搜索厂商实现一个，注册进注册表即可被选择使用。
 * 新增厂商三步走见设计方案 §3.2。
 */
export interface WebSearchProviderAdapter {
  id: WebSearchProviderId;
  /** 设置页展示名（如"智谱联网搜索"）。 */
  label: string;
  /** 设置页一句话说明（是否需要密钥、适用场景）。 */
  description: string;
  requirements: WebSearchProviderRequirement;
  /** 厂商官方文档/凭证获取页链接（对标 WeKnora DocsURL），设置页可展示。 */
  docsUrl?: string;
  /** 非密动态配置字段；缺省表示该厂商无额外配置项。 */
  configFields?: WebSearchProviderConfigField[];
  /**
   * 厂商自持的前置配置校验；返回中文可操作错误表示不可用，
   * undefined 表示就绪。工厂解析与启用门控共用。
   */
  validateConfig?: (config: WebSearchRuntimeConfig) => string | undefined;
  search: (input: WebSearchAdapterSearchInput) => Promise<WebSearchResult[]>;
  /** 设置页测试连接按钮调用；免配置适配器可缺省。 */
  testConnection?: (config: WebSearchRuntimeConfig) => Promise<{ ok: boolean; message: string }>;
}

/** 各厂商自留配置字段按 id 分组（与 webSearchConfig 存储结构一致）；extras 为非密动态配置项。 */
export interface WebSearchRuntimeConfig {
  zhipu?: { apiKey?: string; extras?: WebSearchProviderExtras };
  searxng?: { url?: string };
  tavily?: { apiKey?: string };
  baidu?: { apiKey?: string };
}

/** 设置页可见的配置形态；密钥以 has*Key 标志表达，明文永不回传。 */
export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProviderId;
  maxResults: number;
  consent: boolean;
  searxngUrl: string;
  hasZhipuKey: boolean;
  hasTavilyKey: boolean;
  hasBaiduKey: boolean;
  /** 各厂商非密动态配置取值；读取时已按 configFields 校验并补默认值。 */
  providerExtras: Partial<Record<WebSearchProviderId, WebSearchProviderExtras>>;
}

export const WEB_SEARCH_MAX_RESULTS_MIN = 3;
export const WEB_SEARCH_MAX_RESULTS_MAX = 10;
export const WEB_SEARCH_MAX_RESULTS_DEFAULT = 6;
/** 搜索请求超时（毫秒）；抓取超时见 webFetchClient。 */
export const WEB_SEARCH_TIMEOUT_MS = 12_000;
