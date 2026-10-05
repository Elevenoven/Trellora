/**
 * web_fetch 底层抓取客户端（联网搜索设计方案 §4.3 / §3.3）。
 * 仅接受本轮搜索结果内的 http/https URL（白名单在工具层校验），
 * 抓取后做轻量正文抽取：去脚本/样式/导航标签 → 文本化 → 截断。
 */

/** 抓取超时（毫秒）；搜索超时见 webSearchTypes.WEB_SEARCH_TIMEOUT_MS。 */
export const WEB_FETCH_TIMEOUT_MS = 15_000;
/** 单页正文抽取后的上限；进观察前还会再过观察预算截断。 */
export const WEB_FETCH_MAX_CHARS = 12_000;

export interface WebFetchOutcome {
  title?: string;
  /** 抽取后的正文纯文本（已截断至 WEB_FETCH_MAX_CHARS）。 */
  text: string;
  /** 正文抽取为空（如纯 JS 渲染页）时为 true；调用方按失败降级处理。 */
  empty: boolean;
}

export async function fetchWebPage(input: { url: string; signal: AbortSignal }): Promise<WebFetchOutcome> {
  const parsed = parsePublicWebUrl(input.url);
  const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  const response = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
    signal: AbortSignal.any([input.signal, timeout]),
  });
  if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）。`);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)) {
    throw new Error(`网页返回了不支持的内容类型（${contentType.split(';')[0]}）。`);
  }
  const html = await response.text();
  return extractReadableContent(html);
}

/**
 * 防止搜索结果或重定向链借由抓取工具访问本机、内网和带凭据的地址。
 * URL 是否来自本轮搜索仍由调用方负责；本函数只负责网络目标边界。
 */
export function parsePublicWebUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL 格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 http/https 网页。');
  if (parsed.username || parsed.password) throw new Error('网页 URL 不能包含账号信息。');
  if (isPrivateHostname(parsed.hostname)) throw new Error('不允许抓取本机或内网地址。');
  return parsed;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

/** 轻量正文抽取：无外部依赖的正则式清洗，覆盖常见网页结构。 */
export function extractReadableContent(html: string): WebFetchOutcome {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(header|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  const text = stripped
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    ...(title ? { title } : {}),
    text: text.slice(0, WEB_FETCH_MAX_CHARS),
    empty: text.trim().length < 40,
  };
}
