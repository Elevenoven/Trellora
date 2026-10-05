import type { MaterialEmbeddingAdapter } from '../pipeline/materialEmbeddingAdapters';
import type { MaterialEmbeddingProfile } from '../pipeline/materialEmbeddingTypes';
import type { RerankAdapter } from './rerankAdapters';
import type { KnowledgeAgentSessionState } from './knowledgeTools/knowledgeSessionState';
import type { WebSearchProviderAdapter, WebSearchRuntimeConfig } from '../websearch/webSearchTypes';
import type { AiTransportImage } from './aiGenerationTransport';
import type { KnowledgeBaseVisualEvidence, KnowledgeBaseVisualMapping } from './knowledgeBaseImageResolver';

/** 按查询装配的检索依赖：路径校验、Jieba 分词、锁定 embedding 适配器。 */
export interface KnowledgeToolRetrievalContext {
  targetPath: string;
  queryTerms?: string[];
  lexicalError?: string;
  adapter?: MaterialEmbeddingAdapter;
  /** 锁定的 embedding profile（优化方案 P1-4）：供图谱检索工具自算问题 embedding。 */
  embeddingProfile?: MaterialEmbeddingProfile;
  embeddingError?: string;
}

/** 单个工具准备检索上下文时可覆盖的查询预处理策略。 */
export interface KnowledgeToolQueryOptions {
  /** false 时跳过程序侧分词；用于由 Agent 直接提供实体锚点的图谱检索。 */
  tokenize?: boolean;
}

/**
 * 联网工具的最小运行时上下文（联网搜索设计方案 §4）：
 * 知识库与开放式问答两条链路共用 web_search/web_fetch 时的结构子集。
 */
export interface WebSearchToolContext {
  session: KnowledgeAgentSessionState;
  signal: AbortSignal;
  /** 联网搜索运行时（联网搜索设计方案 §8）；未启用时缺省，联网工具不注册。 */
  webSearch?: {
    adapter: WebSearchProviderAdapter;
    runtimeConfig: WebSearchRuntimeConfig;
    maxResults: number;
  };
  /** 检索阶段状态提示（接 emitAssistantTurnEvent 的 status 事件）。 */
  onStage?: (message: string) => void;
}

/**
 * 知识工具的运行时上下文；由 knowledgeAgentTurn 入口装配后传入
 * （prepareQueryContext 对应 main.ts 的 prepareMaterialSearchContext，
 * 通过回调解耦避免工具层直接依赖主进程单例）。
 */
export interface KnowledgeToolContext extends WebSearchToolContext {
  libraryPath: string;
  libraryLabel: string;
  /** 文档显示名解析；未知文档返回 undefined。 */
  documentNameById: (documentId: string) => string | undefined;
  prepareQueryContext: (query: string, options?: KnowledgeToolQueryOptions) => Promise<KnowledgeToolRetrievalContext>;
  rerank: { enabled: boolean; adapter?: RerankAdapter };
  /** M8：检索相关性门控后使用的弱文档亲和度系数。 */
  documentAffinityFactors?: (documentIds: readonly string[]) => ReadonlyMap<string, number>;
  /** 将命中证据中的持久化图片引用改写为占位符，并按本轮预算物化为 VLM 输入。 */
  resolveEvidenceVisuals?: <T extends KnowledgeBaseVisualEvidence>(evidence: readonly T[]) => {
    evidence: T[];
    images: AiTransportImage[];
    mappings: KnowledgeBaseVisualMapping[];
  };
  /** 全局图谱检索运行时（GraphRAG 方案 §4.2）：注入 map-reduce 的 LLM 调用；未注入时工具不注册。 */
  graphGlobalSearch?: {
    callModel: (prompt: string) => Promise<string>;
  };
}

/** XML 属性转义，保证观察文本对模型是良构的标记。 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML 元素文本转义；保留引号以保证提示文本对模型可读。 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 观察正文统一压缩连续空白行，避免引用块里的排版空行挤占预算。 */
export function compactObservationText(text: string): string {
  return text
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/(\r?\n){3,}/g, '$1$1')
    .trim();
}

/** 调试轨道使用的工具返回正文投影；保留真实文本，但限制单条体积。 */
export function toBoundedPublicToolResultText(text: string, limit = 2_400): string {
  const compacted = compactObservationText(text);
  return compacted.length > limit ? `${compacted.slice(0, limit)}…` : compacted;
}
