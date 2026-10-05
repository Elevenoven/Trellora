import { createHash } from 'node:crypto';
import { fetchWebPage, parsePublicWebUrl } from '../../websearch/webFetchClient';
import type { WebSearchProviderAdapter, WebSearchRuntimeConfig } from '../../websearch/webSearchTypes';
import type {
  SelectionContextReceipt,
  SelectionEditContextGoal,
  SelectionEvidenceItem,
} from '../selectionEditTypes';

/** SE-6 source-local budgets. Search snippets are navigation only and never consume evidence budget. */
const MAX_WEB_SEARCH_RESULTS = 3;
const MAX_WEB_FETCHES = 2;
const MAX_WEB_PAGE_CHARS = 1_600;
const MIN_WEB_PAGE_BUDGET = 160;

export interface SelectionEditWebSourceRuntime {
  adapter: WebSearchProviderAdapter;
  runtimeConfig: WebSearchRuntimeConfig;
  maxResults: number;
}

export interface CollectSelectionEditWebSourcesInput {
  goals: readonly SelectionEditContextGoal[];
  runtime?: SelectionEditWebSourceRuntime;
  signal: AbortSignal;
  remainingCharacters: number;
  onProgress?: (message: string) => void;
}

export interface SelectionEditWebSourcesResult {
  evidence: SelectionEvidenceItem[];
  receipt: Pick<SelectionContextReceipt, 'planned' | 'used' | 'skipped' | 'candidates'>;
}

/**
 * SE-6 web boundary:
 * 1. A single bounded web_search call creates navigation candidates only.
 * 2. Only URLs returned by that search may enter web_fetch.
 * 3. Only successfully fetched full text becomes a `web` evidence item.
 *
 * This deliberately does not reuse a search snippet as a fallback evidence
 * source. A failed fetch remains visible in the receipt as "未全文核验" and is
 * never passed to the model as factual context.
 */
export async function collectSelectionEditWebSources(input: CollectSelectionEditWebSourcesInput): Promise<SelectionEditWebSourcesResult> {
  const planned: SelectionContextReceipt['planned'] = [];
  const used: SelectionContextReceipt['used'] = [];
  const skipped: SelectionContextReceipt['skipped'] = [];
  const candidates: SelectionContextReceipt['candidates'] = [];
  const evidence: SelectionEvidenceItem[] = [];
  if (!input.runtime) {
    skipped.push({ sourceKind: 'web', reason: '联网补充未就绪，未发送搜索请求。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  if (input.remainingCharacters < MIN_WEB_PAGE_BUDGET) {
    skipped.push({ sourceKind: 'web', reason: '本轮原文证据预算不足，未发送联网搜索请求。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  const queryTerms = uniqueTerms(input.goals.flatMap((goal) => goal.queryTerms));
  if (queryTerms.length === 0) {
    skipped.push({ sourceKind: 'web', reason: '选区没有可用于联网定位的主题词。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }

  const query = queryTerms.join(' ');
  planned.push({ sourceKind: 'web', reason: '先执行一次受限网页搜索，再仅抓取本次搜索返回的 URL 全文核验。' });
  input.onProgress?.('正在联网定位候选网页；搜索摘要不会进入生成上下文…');
  let results: Awaited<ReturnType<WebSearchProviderAdapter['search']>>;
  try {
    results = await input.runtime.adapter.search({
      query,
      maxResults: Math.min(MAX_WEB_SEARCH_RESULTS, input.runtime.maxResults),
      config: input.runtime.runtimeConfig,
      signal: input.signal,
    });
  } catch {
    skipped.push({ sourceKind: 'web', reason: '网页搜索失败，未将任何摘要作为事实证据。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }
  throwIfAborted(input.signal);
  if (results.length === 0) {
    skipped.push({ sourceKind: 'web', reason: '网页搜索没有返回可核验的候选。' });
    return { evidence, receipt: { planned, used, skipped, candidates } };
  }

  for (const [index, result] of results.slice(0, MAX_WEB_SEARCH_RESULTS).entries()) {
    const safeUrl = normalizeSearchResultUrl(result.url);
    const candidateId = `web:${index}:${hashText(`${result.title}\u0000${result.url}`).slice(0, 16)}`;
    if (!safeUrl) {
      candidates.push({
        candidateId,
        sourceKind: 'web',
        title: boundedText(result.title, '网页搜索结果'),
        locator: '网页 / 受限地址',
        queryTerms,
        retrievalMethod: 'web_search（摘要仅用于定位）',
        readState: 'skipped',
        pageVerified: false,
        reason: '搜索结果不是可抓取的公开 HTTP/HTTPS 地址，摘要未纳入合成。',
      });
      continue;
    }
    candidates.push({
      candidateId,
      sourceKind: 'web',
      title: boundedText(result.title, safeUrl.hostname),
      locator: `网页 / ${safeUrl.hostname}`,
      queryTerms,
      retrievalMethod: 'web_search（摘要仅用于定位）',
      readState: 'candidate',
      pageVerified: false,
    });
  }

  let remainingCharacters = input.remainingCharacters;
  for (const candidate of candidates.filter((item) => item.readState === 'candidate').slice(0, MAX_WEB_FETCHES)) {
    throwIfAborted(input.signal);
    if (remainingCharacters < MIN_WEB_PAGE_BUDGET) break;
    const url = findCandidateUrl(candidate.candidateId, results);
    if (!url) {
      candidate.readState = 'skipped';
      candidate.reason = '候选 URL 身份校验失败，摘要未纳入合成。';
      continue;
    }
    input.onProgress?.(`正在全文核验网页「${candidate.title}」…`);
    try {
      const outcome = await fetchWebPage({ url, signal: input.signal });
      if (outcome.empty || !outcome.text.trim()) {
        candidate.readState = 'skipped';
        candidate.reason = '网页正文为空，未全文核验；摘要未纳入合成。';
        continue;
      }
      const content = outcome.text.slice(0, Math.min(MAX_WEB_PAGE_CHARS, remainingCharacters));
      if (content.length < MIN_WEB_PAGE_BUDGET) {
        candidate.readState = 'skipped';
        candidate.reason = '网页正文超出本轮受限读取预算，摘要未纳入合成。';
        continue;
      }
      const sourceContentHash = hashText(outcome.text);
      const evidenceId = `evidence-web-${hashText(`${url}\u0000${sourceContentHash}\u0000${content}`).slice(0, 24)}`;
      const title = boundedText(outcome.title ?? candidate.title, candidate.title);
      const item: SelectionEvidenceItem = {
        evidenceId,
        sourceKind: 'web',
        title,
        locator: `网页 / ${new URL(url).hostname}`,
        content,
        sourceContentHash,
        textHash: hashText(content),
        goalIds: input.goals.map((goal) => goal.goalId),
        readVerified: true,
        pageVerified: true,
      };
      evidence.push(item);
      used.push({ sourceKind: 'web', title: item.title, locator: item.locator, characterCount: item.content.length });
      candidate.title = title;
      candidate.locator = item.locator;
      candidate.readState = 'deep-read';
      candidate.pageVerified = true;
      remainingCharacters -= content.length;
    } catch (error) {
      if (isAbortError(error)) throw error;
      candidate.readState = 'skipped';
      candidate.reason = '网页全文读取失败，未全文核验；摘要未纳入合成。';
    }
  }
  for (const candidate of candidates) {
    if (candidate.readState === 'candidate') {
      candidate.readState = 'skipped';
      candidate.reason = '候选未进入本轮全文核验配额，摘要未纳入合成。';
    }
  }
  if (evidence.length === 0) skipped.push({ sourceKind: 'web', reason: '没有全文核验通过的网页原文，未将搜索摘要用于生成。' });
  return { evidence, receipt: { planned, used, skipped, candidates } };
}

function normalizeSearchResultUrl(value: string): URL | undefined {
  try {
    return parsePublicWebUrl(value);
  } catch {
    return undefined;
  }
}

function findCandidateUrl(candidateId: string, results: readonly { title: string; url: string }[]): string | undefined {
  const match = /^web:(\d+):/u.exec(candidateId);
  if (!match) return undefined;
  const result = results[Number(match[1])];
  return result && normalizeSearchResultUrl(result.url) ? result.url : undefined;
}

function uniqueTerms(values: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    const term = value.trim();
    if (term.length < 2 || term.length > 80) continue;
    terms.add(term);
    if (terms.size >= 6) break;
  }
  return [...terms];
}

function boundedText(value: string, fallback: string): string {
  const text = value.trim() || fallback;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('已取消 AI 编辑任务。', 'AbortError');
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}
