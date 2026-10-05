import type { WebSearchProviderAdapter, WebSearchResult } from './webSearchTypes';
import { WEB_SEARCH_TIMEOUT_MS } from './webSearchTypes';

/**
 * SearXNG 自部署适配器（联网搜索设计方案 §3.2 高级选项）。
 * 用户自建元搜索引擎，要求实例开启 JSON 输出（settings.yml 的 formats 含 json）。
 */
export const searxngSearchProvider: WebSearchProviderAdapter = {
  id: 'searxng',
  label: 'SearXNG（自部署）',
  description: '指向你自己部署的 SearXNG 实例；无需密钥，但需要实例开启 JSON 输出。',
  requirements: 'endpoint',
  validateConfig: (config) => (config.searxng?.url?.trim() ? undefined : '「SearXNG（自部署）」需要配置实例地址后才能使用。'),
  search: async ({ query, maxResults, config, signal }) => {
    const baseUrl = config.searxng?.url?.trim().replace(/\/+$/u, '');
    if (!baseUrl) throw new Error('尚未配置 SearXNG 实例地址。');
    const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
    const params = new URLSearchParams({ q: query, format: 'json', language: 'zh-CN' });
    const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' },
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      throw new Error(response.status === 403
        ? 'SearXNG 实例拒绝了 JSON 请求（403）：请在实例 settings.yml 的 search.formats 中启用 json。'
        : `SearXNG 搜索请求失败（HTTP ${response.status}）。`);
    }
    const payload = await response.json() as { results?: SearxngResultItem[] };
    const items = Array.isArray(payload?.results) ? payload.results : [];
    const results: WebSearchResult[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      results.push({
        title: title || url,
        url,
        ...(typeof item.content === 'string' && item.content.trim() ? { snippet: item.content.trim() } : {}),
        ...(typeof item.publishedDate === 'string' && item.publishedDate.trim() ? { publishedAt: item.publishedDate.trim() } : {}),
        source: 'searxng',
      });
      if (results.length >= maxResults) break;
    }
    return results;
  },
  testConnection: async (config) => {
    try {
      const results = await searxngSearchProvider.search({
        query: 'ping', maxResults: 1, config, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      return { ok: true, message: results.length ? '连接正常，已返回搜索结果。' : '连接正常，但本次查询没有结果。' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};

interface SearxngResultItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  publishedDate?: unknown;
}
