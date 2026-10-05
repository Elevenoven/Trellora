import type { WebSearchProviderAdapter, WebSearchResult } from './webSearchTypes';
import { WEB_SEARCH_TIMEOUT_MS } from './webSearchTypes';

/**
 * DuckDuckGo HTML lite 适配器（联网搜索设计方案 §3.2 免配置兜底）。
 * 解析 html.duckduckgo.com/html/ 的结果页；跳转链接需还原 uddg 参数。
 * 境外端点，可达性依赖用户网络环境。
 */
const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';

const resultBlockPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

export const duckduckgoSearchProvider: WebSearchProviderAdapter = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  description: '免密钥的境外搜索引擎；无需配置，但网络可达性因环境而异。',
  requirements: 'none',
  search: async ({ query, maxResults, signal }) => {
    const timeout = AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS);
    const url = `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' },
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) throw new Error(`DuckDuckGo 搜索请求失败（HTTP ${response.status}）。`);
    const html = await response.text();

    const links: Array<{ url: string; title: string }> = [];
    for (const match of html.matchAll(resultBlockPattern)) {
      const resolved = resolveDuckDuckGoLink(match[1]);
      if (!resolved) continue;
      links.push({ url: resolved, title: stripHtml(match[2]) });
    }
    const snippets: string[] = [...html.matchAll(snippetPattern)].map((match) => stripHtml(match[1]));

    const results: WebSearchResult[] = [];
    for (const [index, link] of links.entries()) {
      if (!link.url || !link.title) continue;
      results.push({
        title: link.title,
        url: link.url,
        ...(snippets[index]?.trim() ? { snippet: snippets[index].trim() } : {}),
        source: 'duckduckgo',
      });
      if (results.length >= maxResults) break;
    }
    return results;
  },
};

/** DDG 结果链接多为 //duckduckgo.com/l/?uddg=<encoded> 跳转，需还原真实地址。 */
function resolveDuckDuckGoLink(href: string): string | undefined {
  const decodedHref = decodeHtmlEntities(href.trim());
  if (/uddg=/.test(decodedHref)) {
    const uddg = /uddg=([^&]+)/.exec(decodedHref)?.[1];
    if (!uddg) return undefined;
    try {
      const resolved = decodeURIComponent(uddg);
      return /^https?:\/\//i.test(resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  }
  return /^https?:\/\//i.test(decodedHref) ? decodedHref : undefined;
}

function stripHtml(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
