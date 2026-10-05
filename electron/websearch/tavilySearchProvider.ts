import type { WebSearchProviderAdapter, WebSearchResult } from './webSearchTypes';
import { WEB_SEARCH_TIMEOUT_MS } from './webSearchTypes';

/**
 * Tavily 搜索适配器（对标 WeKnora internal/infrastructure/web_search/tavily.go）。
 * 面向 AI 应用的搜索 API：POST api.tavily.com/search，结果带相关性评分与发布时间；
 * 境外端点，可达性依赖用户网络环境。密钥只进请求体 api_key 字段（与 WeKnora 一致），不写日志。
 */
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

export const tavilySearchProvider: WebSearchProviderAdapter = {
  id: 'tavily',
  label: 'Tavily',
  description: '面向 AI 的搜索 API，返回结构化结果与相关性评分；需要 API Key，境外端点。',
  requirements: 'api-key',
  docsUrl: 'https://docs.tavily.com/',
  validateConfig: (config) => (config.tavily?.apiKey?.trim() ? undefined : '「Tavily」需要配置 API Key 后才能使用。'),
  search: async ({ query, maxResults, config, signal }) => {
    const apiKey = config.tavily?.apiKey?.trim();
    if (!apiKey) throw new Error('尚未配置 Tavily API Key。');
    const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: Math.max(1, Math.min(20, maxResults)) }),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      throw new Error(`Tavily 搜索请求失败（HTTP ${response.status}）。请在 Tavily 控制台确认密钥有效且有可用额度。`);
    }
    const payload = await response.json() as TavilySearchResponse;
    const items = Array.isArray(payload?.results) ? payload.results : [];
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
        ...(content ? { snippet: content } : {}),
        ...(typeof item.published_date === 'string' && item.published_date.trim() ? { publishedAt: item.published_date.trim() } : {}),
        source: 'tavily',
      });
      if (results.length >= maxResults) break;
    }
    return results;
  },
  testConnection: async (config) => {
    try {
      const results = await tavilySearchProvider.search({
        query: 'ping', maxResults: 1, config, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      return results.length ? { ok: true, message: '连接正常，已返回搜索结果。' } : { ok: true, message: '连接正常，但本次查询没有结果。' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};

interface TavilySearchResponse {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown; score?: unknown; published_date?: unknown }>;
}
