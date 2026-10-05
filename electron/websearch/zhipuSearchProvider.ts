import type { WebSearchProviderAdapter, WebSearchProviderConfigFieldOption, WebSearchResult, WebSearchAdapterSearchInput } from './webSearchTypes';
import { WEB_SEARCH_TIMEOUT_MS } from './webSearchTypes';

/**
 * 智谱联网搜索适配器（联网搜索设计方案 §3.2，对标 WeKnora internal/infrastructure/web_search/zhipu.go）。
 * 智谱开放平台 Web Search API：POST /api/paas/v4/web_search。
 * 默认引擎 search_std：search_pro / search_pro_sogou / search_pro_quark 需单独开通，
 * 未开通时平台可能以 200 业务错误体响应，故 200 后仍须检查体内 error.code/message。密钥只进请求头。
 * 注意：旧 /api/paas/v4/tools 入口要求 model 字段，缺省会报「模型不存在」，勿用。
 */
const ZHIPU_WEB_SEARCH_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';

/** 引擎档位可选项（对标 WeKnora zhipu ConfigFields：search_engine）；label 含单次请求价格档。 */
const SEARCH_ENGINE_OPTIONS: WebSearchProviderConfigFieldOption[] = [
  { label: '标准 search_std · ¥0.01/次', value: 'search_std' },
  { label: '专业 search_pro · ¥0.03/次', value: 'search_pro' },
  { label: '搜狗 search_pro_sogou · ¥0.05/次', value: 'search_pro_sogou' },
  { label: '夸克 search_pro_quark · ¥0.05/次', value: 'search_pro_quark' },
];

/** 正文长度可选项（对标 WeKnora zhipu ConfigFields：content_size）。 */
const CONTENT_SIZE_OPTIONS: WebSearchProviderConfigFieldOption[] = [
  { label: 'medium · 简洁摘要', value: 'medium' },
  { label: 'high · 更多上下文', value: 'high' },
];

/** 从可选项集合中取合法值，非法/缺省回退默认（配置层已归一化，此处双保险）。 */
function pickOptionValue(value: string | undefined, options: WebSearchProviderConfigFieldOption[], fallback: string): string {
  return value && options.some((option) => option.value === value) ? value : fallback;
}

export const zhipuSearchProvider: WebSearchProviderAdapter = {
  id: 'zhipu',
  label: '智谱联网搜索',
  description: '智谱开放平台 Web Search API，需要 API Key；国内可达性好，适合中文检索。',
  requirements: 'api-key',
  docsUrl: 'https://docs.bigmodel.cn/cn/guide/tools/web-search',
  configFields: [
    {
      key: 'search_engine',
      label: '搜索引擎',
      type: 'select',
      default: 'search_std',
      description: '不同引擎对应不同价格档；pro 系引擎需在智谱控制台单独开通，未开通时平台会以业务错误响应。',
      options: SEARCH_ENGINE_OPTIONS,
    },
    {
      key: 'content_size',
      label: '正文长度',
      type: 'select',
      default: 'medium',
      description: 'medium 返回简洁摘要；high 返回更完整上下文，单条更长。',
      options: CONTENT_SIZE_OPTIONS,
    },
  ],
  validateConfig: (config) => (config.zhipu?.apiKey?.trim() ? undefined : '「智谱联网搜索」需要配置 API Key 后才能使用。'),
  search: async (input) => (await runZhipuWebSearch(input)).results,
  testConnection: async (config) => {
    try {
      const outcome = await runZhipuWebSearch({
        query: 'ping', maxResults: 1, config, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (outcome.results.length) return { ok: true, message: '连接正常，已返回搜索结果。' };
      return {
        ok: true,
        message: outcome.rawCount > 0
          ? `连接正常，但 ${outcome.rawCount} 条原始结果均缺少合法链接，解析为 0 条（request_id=${outcome.requestId}）。`
          : `连接正常，但平台 search_result 为空（request_id=${outcome.requestId}）；若多次测试均为空，请在智谱控制台确认 web_search 服务已开通且有可用额度。`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};

interface ZhipuSearchOutcome {
  results: WebSearchResult[];
  /** 平台原始 search_result 条数；用于区分「平台空返回」与「解析丢弃」。 */
  rawCount: number;
  requestId: string;
}

async function runZhipuWebSearch({ query, maxResults, config, signal }: WebSearchAdapterSearchInput): Promise<ZhipuSearchOutcome> {
  const apiKey = config.zhipu?.apiKey?.trim();
  if (!apiKey) throw new Error('尚未配置智谱联网搜索 API Key。');
  const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
  const response = await fetch(ZHIPU_WEB_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      search_engine: pickOptionValue(config.zhipu?.extras?.search_engine, SEARCH_ENGINE_OPTIONS, 'search_std'),
      search_query: query,
      search_intent: false,
      count: Math.max(1, Math.min(50, maxResults)),
      content_size: pickOptionValue(config.zhipu?.extras?.content_size, CONTENT_SIZE_OPTIONS, 'medium'),
    }),
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(`智谱联网搜索请求失败（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
  }
  const payload = await response.json() as ZhipuWebSearchResponse;
  // 对标 WeKnora：HTTP 200 仍可能携带业务错误体（如服务未开通/额度不足），必须显式报错而非静默空结果。
  const errorCode = typeof payload?.error?.code === 'string' ? payload.error.code.trim() : '';
  const errorMessage = typeof payload?.error?.message === 'string' ? payload.error.message.trim() : '';
  if (errorCode || errorMessage) {
    throw new Error(`智谱联网搜索返回业务错误${errorCode ? `（${errorCode}）` : ''}：${errorMessage || '未知错误'}。请在智谱控制台确认 web_search 服务已开通且有可用额度。`);
  }
  const items = Array.isArray(payload?.search_result) ? payload.search_result : [];
  const requestId = typeof payload?.request_id === 'string' && payload.request_id.trim() ? payload.request_id.trim() : '无';
  const results: WebSearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    // 官方文档示例用 link，但真实响应存在 url/href 变体与无协议链接，均兼容。
    const rawLink = pickString(record, ['link', 'url', 'href']);
    const title = pickString(record, ['title']);
    let link = '';
    if (/^https?:\/\//i.test(rawLink)) link = rawLink;
    else if (/^(?:[\w-]+\.)+[a-z]{2,}([/:?#]|$)/i.test(rawLink)) link = `https://${rawLink}`;
    // 官方 schema 中 link 非必填：部分引擎/查询仅返回标题+摘要（对标 WeKnora 宽松策略），
    // 无链接条目以空 url 进入台账，按摘要级证据登记，引用展示标注「无链接」。
    const content = pickString(record, ['content', 'snippet']);
    if (!link && !title && !content) continue;
    results.push({
      title: title || link || '未命名搜索结果',
      url: link,
      ...(typeof item.content === 'string' && item.content.trim() ? { snippet: item.content.trim() } : {}),
      ...(typeof item.publish_date === 'string' && item.publish_date.trim() ? { publishedAt: item.publish_date.trim() } : {}),
      source: 'zhipu',
    });
    if (results.length >= maxResults) break;
  }
  if (items.length > 0 && results.length === 0) {
    throw new Error(`智谱返回 ${items.length} 条原始结果，但均缺少可解析的 http(s) 链接（request_id=${requestId}）。原始样例：${jsonSample(items[0])}`);
  }
  return { results, rawCount: items.length, requestId };
}

/** 按顺序取第一个非空字符串字段。 */
function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 截断的原始条目 JSON 样例（公开网页数据，不含密钥）；长字符串值截断以保全字段名可见。 */
function jsonSample(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, val) => (typeof val === 'string' && val.length > 40 ? `${val.slice(0, 40)}…` : val)) ?? String(value);
    return text.length > 320 ? `${text.slice(0, 320)}…` : text;
  } catch {
    return '无法序列化';
  }
}

interface ZhipuSearchResultItem {
  title?: unknown;
  link?: unknown;
  content?: unknown;
  media?: unknown;
  publish_date?: unknown;
}

interface ZhipuWebSearchResponse {
  search_result?: ZhipuSearchResultItem[];
  request_id?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** 截断读取错误正文，避免把大段 HTML 塞进用户提示。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; msg?: unknown };
      const message = parsed?.error?.message ?? parsed?.msg;
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
    } catch { /* 非 JSON 正文，走截断文本 */ }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}
