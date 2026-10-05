import type { WebSearchProviderAdapter, WebSearchResult } from './webSearchTypes';
import { WEB_SEARCH_TIMEOUT_MS } from './webSearchTypes';

/**
 * 百度 AI 搜索适配器（对标 WeKnora internal/infrastructure/web_search/baidu.go）。
 * 百度千帆 AI Search API：POST qianfan.baidubce.com/v2/ai_search/web_search。
 * 查询长度上限 72 单元（CJK/全角按 2 计），超限保守截断；
 * 对标 WeKnora：HTTP 200 仍可能携带业务错误码（code !== 0），必须显式报错。密钥只进请求头。
 */
const BAIDU_AI_SEARCH_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const BAIDU_MAX_QUERY_UNITS = 72;

export const baiduSearchProvider: WebSearchProviderAdapter = {
  id: 'baidu',
  label: '百度AI搜索',
  description: '百度千帆 AI Search API，需要 API Key；国内可达性好，适合中文检索。',
  requirements: 'api-key',
  docsUrl: 'https://cloud.baidu.com/doc/AppBuilder/s/qlvEcai0p',
  validateConfig: (config) => (config.baidu?.apiKey?.trim() ? undefined : '「百度AI搜索」需要配置 API Key 后才能使用。'),
  search: async ({ query, maxResults, config, signal }) => {
    const apiKey = config.baidu?.apiKey?.trim();
    if (!apiKey) throw new Error('尚未配置百度AI搜索 API Key。');
    const preparedQuery = normalizeBaiduQuery(query);
    if (!preparedQuery) throw new Error('搜索查询为空。');
    const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
    const response = await fetch(BAIDU_AI_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: preparedQuery }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: Math.max(1, Math.min(50, maxResults)) }],
      }),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      throw new Error(`百度AI搜索请求失败（HTTP ${response.status}）。`);
    }
    const payload = await response.json() as BaiduSearchResponse;
    // 对标 WeKnora：HTTP 200 仍可能携带业务错误码（如密钥无效/额度不足），必须显式报错而非静默空结果。
    if (typeof payload?.code === 'number' && payload.code !== 0) {
      const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : '未知错误';
      throw new Error(`百度AI搜索返回业务错误（code ${payload.code}）：${message}。请在百度千帆控制台确认服务已开通且有可用额度。`);
    }
    const items = Array.isArray(payload?.references) ? payload.references : [];
    const results: WebSearchResult[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!url && !title && !content) continue;
      results.push({
        title: title || url || '未命名搜索结果',
        url,
        ...(content ? { content } : {}),
        ...(typeof item.date === 'string' && item.date.trim() ? { publishedAt: normalizeBaiduDate(item.date.trim()) } : {}),
        source: 'baidu',
      });
      if (results.length >= maxResults) break;
    }
    return results;
  },
  testConnection: async (config) => {
    try {
      const results = await baiduSearchProvider.search({
        query: 'ping', maxResults: 1, config, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      return results.length ? { ok: true, message: '连接正常，已返回搜索结果。' } : { ok: true, message: '连接正常，但本次查询没有结果。' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};

/** 百度文档查询上限 72 单元，CJK/全角按 2 计；与 WeKnora normalizeBaiduQuery 同款的保守宽度模型。 */
function normalizeBaiduQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  let units = 0;
  for (const char of trimmed) units += queryUnitWidth(char);
  if (units <= BAIDU_MAX_QUERY_UNITS) return trimmed;
  let used = 0;
  let out = '';
  for (const char of trimmed) {
    const width = queryUnitWidth(char);
    if (used + width > BAIDU_MAX_QUERY_UNITS) break;
    out += char;
    used += width;
  }
  return out.trim();
}

function queryUnitWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint <= 0x7f ? 1 : 2;
}

const baiduDatePattern = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

/** 把 "2025-4-24" / "2025-04-27 18:02" 等变体归一为零填充格式；无法识别时原样保留。 */
function normalizeBaiduDate(date: string): string {
  const match = baiduDatePattern.exec(date);
  if (!match) return date;
  const pad = (value: string | undefined) => (value ?? '0').padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${pad(match[5])}:${pad(match[6])}`;
}

interface BaiduSearchResponse {
  references?: Array<{ id?: unknown; title?: unknown; url?: unknown; content?: unknown; date?: unknown; type?: unknown }>;
  request_id?: unknown;
  code?: unknown;
  message?: unknown;
}
