import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { fetchWebPage } from '../../websearch/webFetchClient';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, type WebSearchToolContext } from '../knowledgeToolContext';

/**
 * web_fetch 工具（联网搜索设计方案 §4.3，对标 WeKnora web_fetch.go）：
 * 只接受本轮 web_search 返回过的 URL（白名单防提示注入）；抓取成功后
 * 升级原引用条目 pageVerified（引用号不变），失败时保留摘要证据并披露未验证。
 */

const WEB_FETCH_CALL_LIMIT = 3;
/** 终答引用投影使用的已验证正文摘录上限。 */
const VERIFIED_EXCERPT_LIMIT = 800;

export const webFetchTool: ReActTool<WebSearchToolContext> = {
  name: 'web_fetch',
  description: [
    '读取一个网页的正文全文，用于核对 web_search 摘要是否足以支撑结论。',
    'URL 必须来自此前 web_search 的返回结果，不许编造或抓取任意地址；',
    '单轮循环内最多调用 3 次。成功后该网页证据升级为 page_verified="true"；',
    '抓取失败时保留已有摘要证据，但相关结论需标注未经全文验证。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        maxLength: 500,
        description: '要读取正文的网页 URL，必须来自此前 web_search 的返回',
      },
    },
    required: ['url'],
  },
  execute: async (args, ctx) => runWebFetch(args, ctx),
};

async function runWebFetch(args: Record<string, unknown>, ctx: WebSearchToolContext): Promise<ReActToolExecution> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    return { ok: false, observation: '<tool_error>web_fetch 需要非空的 url。</tool_error>', message: '网页抓取 URL 为空，已拒绝执行。' };
  }
  if (!ctx.webSearch) {
    return { ok: false, observation: '<tool_error>联网搜索未启用，请基于知识库证据作答。</tool_error>', message: '联网搜索未启用。' };
  }
  if (!ctx.session.isSearchableUrl(url)) {
    const noLinksAtAll = !ctx.session.hasSearchableUrls();
    return {
      ok: false,
      observation: noLinksAtAll
        ? '<tool_error>本轮搜索结果不含来源链接，web_fetch 不可用。请基于已有摘要作答并注明未经全文验证，不要再尝试抓取。</tool_error>'
        : '<tool_error>URL 不是本次搜索结果，只允许抓取 web_search_results 中带引用号的 URL。</tool_error>',
      message: noLinksAtAll
        ? '本轮搜索结果不含来源链接，web_fetch 不可用。'
        : '网页抓取 URL 不在本轮搜索结果白名单内，已拒绝执行。',
    };
  }
  if (!ctx.session.consumeWebFetchCall(WEB_FETCH_CALL_LIMIT)) {
    return { ok: false, observation: '<tool_error>网页抓取次数已达上限，请基于已有证据直接作答。</tool_error>', message: '网页抓取次数已达上限。' };
  }

  ctx.onStage?.('正在读取网页全文…');
  let reference = ctx.session.referenceOfUrl(url);
  try {
    const outcome = await fetchWebPage({ url, signal: ctx.signal });
    if (outcome.empty) {
      return buildFetchFailureObservation(reference, '页面正文抽取为空（可能是纯脚本渲染页）');
    }
    if (!reference) {
      const registration = ctx.session.registerWebEvidence({
        url,
        title: outcome.title ?? url,
        source: ctx.webSearch.adapter.id,
        sourceText: outcome.text.slice(0, VERIFIED_EXCERPT_LIMIT),
      });
      reference = registration.reference;
    } else {
      ctx.session.verifyWebEvidence(reference, outcome.text.slice(0, VERIFIED_EXCERPT_LIMIT));
    }
    const observation = [
      `<web_page url="${escapeXmlAttribute(url)}" reference="${reference}" page_verified="true">`,
      `  <content>${escapeXmlText(outcome.text)}</content>`,
      '</web_page>',
      `<web_note>该网页证据已升级为全文验证。引用时继续使用 ${reference}。</web_note>`,
    ].join('\n');
    return {
      ok: true,
      observation: compactObservationText(observation),
      message: `网页全文抓取成功，证据 ${reference} 已验证。`,
      referenceCount: 0,
      publicResults: [{
        ...(reference ? { reference } : {}),
        ...(outcome.title ? { title: outcome.title } : {}),
        url,
        pageVerified: true,
        excerpt: outcome.text.slice(0, 400),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildFetchFailureObservation(reference, message);
  }
}

/** 抓取失败：保留已有摘要证据，披露未验证并禁止重复等价搜索（WeKnora Fallback 语义）。 */
function buildFetchFailureObservation(reference: string | undefined, reason: string): ReActToolExecution {
  const kept = reference ? `保留已有搜索摘要证据 ${reference}；` : '';
  const observation = [
    `<tool_error>网页抓取失败：${escapeXmlText(reason)}。${escapeXmlText(`${kept}页面内容未验证，动态事实请降低置信度；不要重复等价搜索，可基于摘要作答并注明未经全文验证。`)}</tool_error>`,
  ].join('\n');
  return {
    ok: false,
    observation,
    message: `网页抓取失败：${reason}`,
  };
}
