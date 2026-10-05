import { createMaterialEmbeddingRequestSignal } from '../pipeline/materialEmbeddingTypes';
import { NO_SOURCE_ID, OLLAMA_SOURCE_ID, readModelHub, resolveProviderCredentials, type HubStore } from './modelHub';

/** rerank 请求超时：失败即降级，绝不阻塞回答生成。 */
export const RERANK_TIMEOUT_MS = 8_000;
/** rerank 单文档字符上限；超长父块走锚点窗口裁剪。 */
export const RERANK_DOCUMENT_MAX_CHARS = 6_000;
const DASHSCOPE_RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';

export type RerankAdapter = (query: string, documents: string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<number[]>;

export class RerankAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = 'RerankAdapterError';
    this.code = code;
    this.retryable = options?.retryable === true;
  }
}

export interface RerankRuntimeResolution {
  enabled: boolean;
  reason?: string;
  providerId?: string;
  model?: string;
  adapter?: RerankAdapter;
}

/**
 * rerank 启用条件：槽位已绑定 + 源非 Ollama + 远程已同意 + 凭据可用。
 * 任一条件不满足都返回 enabled:false 与可展示原因，由编排层按降级矩阵处理。
 */
export function resolveRerankRuntime(store: HubStore): RerankRuntimeResolution {
  const hub = readModelHub(store);
  const slot = hub.slots.rerank;
  const model = slot.model.trim();
  if (slot.source === NO_SOURCE_ID || !model) return { enabled: false, reason: '未绑定 rerank 模型，使用 RRF 聚合序。' };
  if (slot.source === OLLAMA_SOURCE_ID) return { enabled: false, reason: 'Ollama 源暂不提供 rerank 接口，使用 RRF 聚合序。' };
  if (!hub.remoteConsent) return { enabled: false, reason: '未确认远程内容发送同意，rerank 已停用。' };
  const credentials = resolveProviderCredentials(store, slot.source);
  if (!credentials.endpoint || !credentials.apiKey) return { enabled: false, reason: 'rerank 来源缺少 API Key 或地址，使用 RRF 聚合序。' };
  return {
    enabled: true,
    providerId: slot.source,
    model,
    adapter: createRerankAdapter({ providerId: slot.source, endpoint: credentials.endpoint, apiKey: credentials.apiKey, model }),
  };
}

export function createRerankAdapter(source: { providerId: string; endpoint: string; apiKey: string; model: string }): RerankAdapter {
  return async (query, documents, options) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || documents.length === 0 || documents.some((doc) => typeof doc !== 'string' || !doc.trim())) {
      throw new RerankAdapterError('RERANK_INPUT_INVALID', 'rerank 的查询与文档不能为空。');
    }
    // DashScope 的 rerank 走原生服务路径，不在 OpenAI 兼容 endpoint 下；其余厂商走 {endpoint}/rerank。
    const url = source.providerId === 'qwen' ? DASHSCOPE_RERANK_URL : `${normalizeEndpoint(source.endpoint)}/rerank`;
    const body = source.providerId === 'qwen'
      ? { model: source.model, input: { query: trimmedQuery, documents }, parameters: { return_documents: false } }
      : { model: source.model, query: trimmedQuery, documents };
    const requestSignal = createMaterialEmbeddingRequestSignal(options?.signal, options?.timeoutMs ?? RERANK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${source.apiKey.trim()}`, 'content-type': 'application/json' },
        signal: requestSignal.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) throw new RerankAdapterError('RERANK_AUTH_FAILED', `rerank 服务认证失败（HTTP ${status}）。`);
        if (status === 429) throw new RerankAdapterError('RERANK_RATE_LIMITED', 'rerank 服务请求过于频繁。', { retryable: true });
        if (status >= 500) throw new RerankAdapterError('RERANK_SERVICE_UNAVAILABLE', `rerank 服务暂时不可用（HTTP ${status}）。`, { retryable: true });
        throw new RerankAdapterError('RERANK_HTTP_ERROR', `rerank 服务请求失败（HTTP ${status}）。`, { retryable: true });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'rerank 服务返回的响应不是有效 JSON。');
      }
      return parseRerankScores(payload, documents.length, source.providerId);
    } catch (error) {
      if (error instanceof RerankAdapterError) throw error;
      if (requestSignal.didTimeout()) throw new RerankAdapterError('RERANK_TIMEOUT', 'rerank 请求超时。', { retryable: true });
      if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new RerankAdapterError('RERANK_CANCELLED', 'rerank 请求已取消。', { retryable: true });
      throw new RerankAdapterError('RERANK_NETWORK_ERROR', '无法连接 rerank 服务。', { retryable: true });
    } finally {
      requestSignal.cleanup();
    }
  };
}

/** 兼容 DashScope output.results 与 Cohere/Jina/SiliconFlow/Voyage 的顶层 results 两种形态。 */
function parseRerankScores(payload: unknown, expectedCount: number, providerId: string): number[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const output = (record.output ?? {}) as Record<string, unknown>;
  const rawResults = Array.isArray(record.results) ? record.results : Array.isArray(output.results) ? output.results : undefined;
  if (!rawResults) throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'rerank 服务返回了无法识别的结果结构。');
  const scores: Array<number | undefined> = Array.from({ length: expectedCount });
  const seen = new Set<number>();
  for (const row of rawResults) {
    if (!row || typeof row !== 'object') throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'rerank 服务返回了无效结果项。');
    const entry = row as Record<string, unknown>;
    const index = Number(entry.index);
    const rawScore = typeof entry.relevance_score === 'number' ? entry.relevance_score : typeof entry.score === 'number' ? entry.score : undefined;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || seen.has(index) || rawScore === undefined || !Number.isFinite(rawScore)) {
      throw new RerankAdapterError('RERANK_RESPONSE_INVALID', 'rerank 服务返回的结果下标或分数无效。');
    }
    scores[index] = Math.max(0, Math.min(1, rawScore));
    seen.add(index);
  }
  if (scores.some((score) => score === undefined)) throw new RerankAdapterError('RERANK_RESPONSE_INVALID', `rerank 服务返回的结果不完整（${providerId}）。`);
  return scores as number[];
}

export interface RerankDocumentBuildResult {
  text: string;
  windowed: boolean;
  truncated: boolean;
}

/**
 * 长父块裁剪：优先以最佳命中子块为锚点取窗口，保证 reranker 看到与查询相关的局部；
 * 锚点定位失败才退化为头部截断。sectionContext 作为章节前缀保留。
 */
export function buildRerankDocument(input: { parentText: string; sectionContext?: string; anchorText?: string; maxChars?: number }): RerankDocumentBuildResult {
  const maxChars = Math.max(512, input.maxChars ?? RERANK_DOCUMENT_MAX_CHARS);
  const sectionContext = (input.sectionContext ?? '').trim().slice(0, 120);
  const prefix = sectionContext ? `[章节] ${sectionContext}\n` : '';
  const budget = Math.max(256, maxChars - prefix.length);
  const parentText = input.parentText;
  if (parentText.length <= budget) return { text: prefix + parentText, windowed: false, truncated: false };
  const anchor = (input.anchorText ?? '').trim();
  const anchorStart = anchor ? parentText.indexOf(anchor) : -1;
  if (anchorStart >= 0) {
    const anchorLength = Math.min(anchor.length, budget);
    const half = Math.floor((budget - anchorLength) / 2);
    const windowStart = Math.max(0, Math.min(anchorStart - half, parentText.length - budget));
    const excerpt = parentText.slice(windowStart, windowStart + budget);
    return { text: prefix + excerpt, windowed: true, truncated: true };
  }
  return { text: prefix + parentText.slice(0, budget), windowed: false, truncated: true };
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
