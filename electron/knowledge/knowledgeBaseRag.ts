import { searchMaterialChunks, type MaterialChunkSearchOutcome } from '../pipeline/materialChunkSearch';
import type { MaterialEmbeddingAdapter } from '../pipeline/materialEmbeddingAdapters';
import { aggregateParentScores, fuseRerankScores, type HybridChildFusion } from './hybridRetrievalFusion';
import { buildRerankDocument, type RerankAdapter } from './rerankAdapters';
import type { AssistantContextSource, AssistantTurnRequest } from './assistantTurnTypes';
import { expandQueriesLocally, mergeRecalledChildren, type QueryExpansionOutcome } from './queryExpansion';
import { readDirectLoadCandidates, type DirectLoadParentCandidate } from './directLoadSmallDocuments';
import { selectDiverseTopK } from './evidenceDiversity';
import { expandHybridChildrenViaGraph, type GraphExpansionContribution } from './graphChunkExpansion';

/** 交给模型的父块证据数 Top-K；子块只是定位器，父块才是证据。 */
export const KNOWLEDGE_BASE_RAG_PARENT_TOP_K = 5;
const RRF_CHILD_TOP_M = 20;
const RRF_CHILD_TOP_M_RERANK = 30;
/** 扩写兜底每路变体的子块召回上限。 */
const EXPANSION_PER_QUERY_CHILD_LIMIT = 10;

export interface KnowledgeBaseRagParentEvidence {
  documentId: string;
  childChunkId: string;
  parentChunkId: string;
  parentOrdinal: number;
  text: string;
  sourceText: string;
  /** 最终分：未启用 rerank 时为父块聚合归一分，启用时为 rerank 融合分。 */
  score: number;
  hitChildren: number;
  methods: Array<'keyword' | 'semantic'>;
}

export interface KnowledgeBaseRetrievalRerankState {
  enabled: boolean;
  applied: boolean;
  gatedOut: number;
  allGatedOut: boolean;
  notice?: string;
  /** 首轮 gating 全剔除后触发降级重滤时实际生效的阈值。 */
  degradedThreshold?: number;
}

export interface KnowledgeBaseRetrievalExpansionState {
  triggered: boolean;
  variants: string[];
  strategies: string[];
  addedChildren: number;
}

/** 图通道扩展状态（优化方案 P0-2）：种子数与实际补充的新子块数；P2-7 补齐种子归因。 */
export interface KnowledgeBaseRetrievalGraphExpansionState {
  seedCount: number;
  addedChildren: number;
  /** 每个补充块的种子来源（优化方案 P2-7）：调试轨道按种子统计图通道贡献。 */
  contributions: GraphExpansionContribution[];
}

/**
 * 通道贡献统计（优化方案 P2-7）：机器可读的通道口径（vector=语义、
 * fts=原文/关键词、graph=图扩展），调试轨道与验证脚本按通道统计贡献度。
 */
export interface RetrievalChannelContribution {
  vector: number;
  fts: number;
  graph: number;
}

export interface KnowledgeBaseRetrievalOutcome {
  evidence: KnowledgeBaseRagParentEvidence[];
  children: HybridChildFusion[];
  parentCandidateCount: number;
  rerank: KnowledgeBaseRetrievalRerankState;
  notice?: string;
  used: MaterialChunkSearchOutcome['used'];
  vectorIndexed: boolean;
  indexedChunks: number;
  /** 召回不足扩写兜底状态（借鉴 WeKnora 扩写思想）。 */
  expansion?: KnowledgeBaseRetrievalExpansionState;
  /** 图通道扩展状态（优化方案 P0-2，借鉴 WeKnora filterSeenChunk 思想）。 */
  graphExpansion?: KnowledgeBaseRetrievalGraphExpansionState;
  /** 子块通道贡献统计（优化方案 P2-7）。 */
  channelContribution: RetrievalChannelContribution;
  /** 小文档直载通道状态（借鉴 WeKnora 直载思想）。 */
  directLoad?: { documentIds: string[]; parentCount: number };
  /** 最终证据中命中历史引用的父块数（借鉴 WeKnora MatchTypeHistory 思想）。 */
  historyHits?: number;
  /** MMR 多样性选择后未入选的候选数。 */
  mmrDropped?: number;
}

/**
 * The dedicated knowledge-base route is deliberately routed away from the
 * note-library Planner/ReAct flow. Attachments and mixed scopes remain on the
 * existing generic assistant path because they are not pure material RAG.
 */
export function getDedicatedKnowledgeBaseRagSource(request: AssistantTurnRequest): AssistantContextSource | undefined {
  if (request.intent !== 'ask' || request.scope !== 'library-search' || request.attachments?.length) return undefined;
  const sources = request.contextSources ?? [];
  return sources.length === 1 && sources[0]?.kind === 'knowledge-base' ? sources[0] : undefined;
}

/**
 * 混合检索编排：双通道召回（子块）→ 召回不足扩写兜底 → RRF 融合 → 父块聚合
 * → 可选 rerank（阈值降级 + 历史引用放宽）→ 小文档直载合池 → MMR 去冗余 → 父块 Top-K。
 * rerank 失败/不可用时回退 RRF 聚合序，绝不阻塞回答生成。
 */
export async function retrieveKnowledgeBaseEvidence(input: {
  libraryPath: string;
  query: string;
  queryTerms?: string[];
  lexicalError?: string;
  adapter?: MaterialEmbeddingAdapter;
  embeddingError?: string;
  rerankEnabled?: boolean;
  rerankAdapter?: RerankAdapter;
  parentTopK?: number;
  onStage?: (message: string) => void;
  /** 允许召回不足时的本地扩写兜底；ReAct 工具多路查询场景应关闭。默认开启。 */
  allowExpansion?: boolean;
  /** 扩写策略注入；测试可替换，缺省走 expandQueriesLocally。 */
  expandQueries?: (query: string, queryTerms?: string[]) => QueryExpansionOutcome;
  /** 上一轮证据的 (documentId, parentChunkId)；本轮聚合已含该父块时才放宽门控，不凭空注入。 */
  historyEvidenceKeys?: Array<{ documentId: string; parentChunkId: string }>;
  /** 是否启用小文档直载通道。默认开启。 */
  directLoadEnabled?: boolean;
  /** Wiki 节点作用域：限定召回文档集合（透传 searchMaterialChunks）。 */
  documentIds?: string[];
  /** Wiki 节点作用域：仅召回 sectionPath 末位 nodeId 命中集合的 chunk（融合前过滤）。 */
  sectionNodeIds?: string[];
  /** 图通道一跳扩展开关；Wiki 节点作用域应关闭以免引入子树外证据。默认开启。 */
  allowGraphExpansion?: boolean;
  /** M8：仅对已经通过相关性门控的检索候选返回弱亲和度系数；不得过滤候选。 */
  documentAffinityFactors?: (documentIds: readonly string[]) => ReadonlyMap<string, number>;
}): Promise<KnowledgeBaseRetrievalOutcome> {
  const topK = Math.max(1, Math.min(input.parentTopK ?? KNOWLEDGE_BASE_RAG_PARENT_TOP_K, 12));
  const rerankRequested = Boolean(input.rerankEnabled && input.rerankAdapter);
  const childLimit = rerankRequested ? RRF_CHILD_TOP_M_RERANK : RRF_CHILD_TOP_M;
  const candidateLimit = rerankRequested ? Math.min(topK * 3, 12) : Math.min(topK * 2, 10);

  input.onStage?.(`正在双通道混合召回子块（向量 + 关键词，Top ${childLimit}）…`);
  const search = await searchMaterialChunks({
    libraryPath: input.libraryPath,
    query: input.query,
    queryTerms: input.queryTerms,
    lexicalError: input.lexicalError,
    mode: 'hybrid',
    fusion: 'rrf',
    childOnly: true,
    limit: childLimit,
    adapter: input.adapter,
    embeddingError: input.embeddingError,
    ...(input.documentIds ? { documentIds: input.documentIds } : {}),
    ...(input.sectionNodeIds ? { sectionNodeIds: input.sectionNodeIds } : {}),
  });
  let children = search.results as HybridChildFusion[];

  // 召回不足扩写兜底：子块命中 < childLimit/2 时用本地规则变体二次召回，合并后重走 RRF。
  const expansion: KnowledgeBaseRetrievalExpansionState = { triggered: false, variants: [], strategies: [], addedChildren: 0 };
  if ((input.allowExpansion ?? true) && children.length < childLimit / 2) {
    const expanded = (input.expandQueries ?? expandQueriesLocally)(input.query, input.queryTerms);
    if (expanded.variants.length > 0) {
      input.onStage?.(`召回不足（仅 ${children.length} 个子块），正在用 ${expanded.variants.length} 条本地变体兜底补召回…`);
      const before = children.length;
      const rounds: HybridChildFusion[][] = [];
      for (const variant of expanded.variants) {
        const outcome = await searchMaterialChunks({
          libraryPath: input.libraryPath,
          query: variant,
          mode: 'hybrid',
          fusion: 'rrf',
          childOnly: true,
          limit: EXPANSION_PER_QUERY_CHILD_LIMIT,
          adapter: input.adapter,
          embeddingError: input.embeddingError,
          ...(input.documentIds ? { documentIds: input.documentIds } : {}),
          ...(input.sectionNodeIds ? { sectionNodeIds: input.sectionNodeIds } : {}),
        });
        rounds.push(outcome.results as HybridChildFusion[]);
      }
      children = mergeRecalledChildren(children, rounds);
      expansion.triggered = true;
      expansion.variants = expanded.variants;
      expansion.strategies = expanded.strategies;
      expansion.addedChildren = children.length - before;
    }
  }

  // 图通道扩展（优化方案 P0-2）：RRF 融合后以 Top 子块为种子，沿 chunk 级图投影一跳只补新证据。
  let graphExpansion: KnowledgeBaseRetrievalGraphExpansionState | undefined;
  if (children.length > 0 && (input.allowGraphExpansion ?? true)) {
    const graphOutcome = expandHybridChildrenViaGraph({ libraryPath: input.libraryPath, children });
    graphExpansion = {
      seedCount: graphOutcome.seedCount,
      addedChildren: graphOutcome.addedChildren,
      contributions: graphOutcome.contributions,
    };
    if (graphOutcome.addedChildren > 0) {
      input.onStage?.(`图通道扩展已补充 ${graphOutcome.addedChildren} 个相邻子块（种子 ${graphOutcome.seedCount} 个）…`);
      children = [...children, ...graphOutcome.children];
    }
  }

  // 通道贡献统计（优化方案 P2-7）：按机器可读通道口径汇总子块来源。
  const channelContribution: RetrievalChannelContribution = { vector: 0, fts: 0, graph: 0 };
  for (const child of children) {
    if (child.matchTypes.includes('图扩展')) channelContribution.graph += 1;
    else {
      if (child.matchTypes.includes('语义')) channelContribution.vector += 1;
      if (child.matchTypes.includes('原文') || child.matchTypes.includes('关键词')) channelContribution.fts += 1;
    }
  }

  input.onStage?.('正在将子块 RRF 分上卷聚合到父块…');
  const aggregates = aggregateParentScores(children);
  const bestChildByParent = new Map<string, HybridChildFusion>();
  for (const child of children) {
    if (!child.parentChunkId) continue;
    const key = [child.documentId, child.parentChunkId].join('|');
    if (!bestChildByParent.has(key)) bestChildByParent.set(key, child);
  }
  const parentMetaByChild = new Map(children.filter((child) => child.citation.parent).map((child) => [child.chunkId, child]));
  const candidates = aggregates.flatMap((aggregate) => {
    const key = [aggregate.documentId, aggregate.parentChunkId].join('|');
    const bestChild = bestChildByParent.get(key);
    const parent = bestChild ? parentMetaByChild.get(bestChild.chunkId)?.citation.parent : undefined;
    if (!bestChild || !parent || !parent.text.trim()) return [];
    const methods = new Set<'keyword' | 'semantic'>();
    for (const child of children) {
      if (child.parentChunkId !== aggregate.parentChunkId || child.documentId !== aggregate.documentId) continue;
      if (child.matchTypes.includes('原文') || child.matchTypes.includes('关键词')) methods.add('keyword');
      if (child.matchTypes.includes('语义')) methods.add('semantic');
    }
    return [{
      aggregate,
      parentOrdinal: parent.ordinal,
      text: parent.text,
      sourceText: parent.sourceText,
      sectionContext: bestChild.sectionContext,
      anchorText: bestChild.sourceText,
      bestChildChunkId: bestChild.chunkId,
      methods: [...methods],
    }];
  }).slice(0, candidateLimit);

  // 小文档直载：跳过召回与 rerank，最终分取归一上限（只读，失败不阻断）。
  const directLoad = (input.directLoadEnabled ?? true)
    ? readDirectLoadCandidates(input.libraryPath)
    : { candidates: [] as DirectLoadParentCandidate[], documentIds: [] as string[] };

  const historyKeys = new Set((input.historyEvidenceKeys ?? []).map((key) => [key.documentId, key.parentChunkId].join('|')));
  const rerankState: KnowledgeBaseRetrievalRerankState = { enabled: rerankRequested, applied: false, gatedOut: 0, allGatedOut: false };
  let selected: Array<typeof candidates[number] & { finalScore: number }>;
  if (rerankRequested && candidates.length > 0 && input.rerankAdapter) {
    input.onStage?.(`Rerank 已启用，正在对 ${candidates.length} 个父块候选重排…`);
    try {
      const documents = candidates.map((candidate) => buildRerankDocument({
        parentText: candidate.text,
        sectionContext: candidate.sectionContext,
        anchorText: candidate.anchorText,
      }).text);
      const rerankScores = await input.rerankAdapter(input.query, documents);
      const historyIndices = candidates
        .map((candidate, index) => (historyKeys.has([candidate.aggregate.documentId, candidate.aggregate.parentChunkId].join('|')) ? index : -1))
        .filter((index) => index >= 0);
      const fusion = fuseRerankScores(
        candidates.map((candidate) => candidate.aggregate.normScore),
        rerankScores,
        historyIndices.length > 0 ? { historyIndices } : undefined,
      );
      rerankState.gatedOut = fusion.gatedOut;
      rerankState.allGatedOut = fusion.allGatedOut;
      if (fusion.degradedThreshold !== undefined) rerankState.degradedThreshold = fusion.degradedThreshold;
      if (fusion.allGatedOut) {
        rerankState.notice = fusion.degradedThreshold !== undefined
          ? `Rerank 认为候选父块相关性均不足（阈值降级至 ${fusion.degradedThreshold} 重滤后仍无可用候选），已保留 RRF 聚合序最高的父块。`
          : 'Rerank 认为候选父块相关性均不足，已保留 RRF 聚合序最高的父块。';
        selected = candidates.slice(0, 1).map((candidate) => ({ ...candidate, finalScore: candidate.aggregate.normScore }));
      } else {
        rerankState.applied = true;
        selected = fusion.order.map((index) => ({ ...candidates[index], finalScore: fusion.finals[index] }));
      }
    } catch (error) {
      rerankState.notice = `Rerank 不可用，已回退 RRF 聚合序：${error instanceof Error ? error.message : String(error)}`;
      selected = candidates.map((candidate) => ({ ...candidate, finalScore: candidate.aggregate.normScore }));
    }
  } else {
    selected = candidates.map((candidate) => ({ ...candidate, finalScore: candidate.aggregate.normScore }));
  }

  // M8 文档亲和度是相关性门控后的弱排序信号。它不参与召回、过滤或 rerank gating，
  // 并且不作用于跳过相关性门控的直载文档。
  if (selected.length > 0 && input.documentAffinityFactors) {
    const factors = input.documentAffinityFactors(selected.map((entry) => entry.aggregate.documentId));
    selected = selected.map((entry, stableIndex) => ({
      ...entry,
      finalScore: entry.finalScore * Math.max(1, Math.min(1.15, factors.get(entry.aggregate.documentId) ?? 1)),
      stableIndex,
    })).sort((left, right) => right.finalScore - left.finalScore || left.stableIndex - right.stableIndex)
      .map(({ stableIndex: _stableIndex, ...entry }) => entry)
      .slice(0, topK);
  } else {
    selected = selected.slice(0, topK);
  }

  // 直载父块合池：与检索父块统一参与排序与 MMR；已被检索选中的父块不重复注入。
  const selectedKeys = new Set(selected.map((entry) => [entry.aggregate.documentId, entry.aggregate.parentChunkId].join('|')));
  const pool = [
    ...selected,
    ...directLoad.candidates
      .filter((candidate) => !selectedKeys.has([candidate.documentId, candidate.parentChunkId].join('|')))
      .map((candidate) => ({
        aggregate: {
          documentId: candidate.documentId,
          parentChunkId: candidate.parentChunkId,
          score: 1,
          normScore: 1,
          hitChildren: 0,
          bestChildChunkId: candidate.parentChunkId,
          bestChildRrf: 0,
          support: 0,
        },
        parentOrdinal: candidate.parentOrdinal,
        text: candidate.text,
        sourceText: candidate.sourceText,
        sectionContext: '',
        anchorText: candidate.sourceText,
        // 直载条目无子块定位器，childChunkId 回落父块 id。
        bestChildChunkId: candidate.parentChunkId,
        methods: [] as Array<'keyword' | 'semantic'>,
        finalScore: 1,
      })),
  ].sort((first, second) => second.finalScore - first.finalScore || first.aggregate.documentId.localeCompare(second.aggregate.documentId) || first.parentOrdinal - second.parentOrdinal);

  // MMR 多样性选择：λ=0.7 偏相关性，字符二元组 Jaccard 抑制同文档重复父块。
  const diversity = selectDiverseTopK(
    pool.map((entry) => ({
      key: [entry.aggregate.documentId, entry.aggregate.parentChunkId].join('|'),
      finalScore: entry.finalScore,
      text: entry.text,
      entry,
    })),
    topK,
  );
  const selection = diversity.selected.map((item) => item.entry);

  const evidence: KnowledgeBaseRagParentEvidence[] = selection.map((entry) => ({
    documentId: entry.aggregate.documentId,
    childChunkId: entry.bestChildChunkId,
    parentChunkId: entry.aggregate.parentChunkId,
    parentOrdinal: entry.parentOrdinal,
    text: entry.text,
    sourceText: entry.sourceText,
    score: Number(entry.finalScore.toFixed(6)),
    hitChildren: entry.aggregate.hitChildren,
    methods: entry.methods,
  }));
  const historyHits = evidence.filter((entry) => historyKeys.has([entry.documentId, entry.parentChunkId].join('|'))).length;
  const noticeParts = [search.notice, rerankState.notice];
  if (expansion.triggered && expansion.addedChildren > 0) {
    noticeParts.push(`首轮召回不足，已通过本地扩写补充 ${expansion.addedChildren} 个子块。`);
  }
  const notice = noticeParts.filter(Boolean).join('；') || undefined;
  return {
    evidence,
    children,
    parentCandidateCount: candidates.length,
    rerank: rerankState,
    ...(notice ? { notice } : {}),
    used: search.used,
    vectorIndexed: search.vectorIndexed,
    indexedChunks: search.indexedChunks,
    ...(expansion.triggered ? { expansion } : {}),
    ...(graphExpansion && graphExpansion.addedChildren > 0 ? { graphExpansion } : {}),
    channelContribution,
    ...(directLoad.candidates.length > 0 ? { directLoad: { documentIds: directLoad.documentIds, parentCount: directLoad.candidates.length } } : {}),
    ...(historyKeys.size > 0 ? { historyHits } : {}),
    ...(pool.length > selection.length ? { mmrDropped: pool.length - selection.length } : {}),
  };
}

/**
 * 拆分子问题多路检索结果合并（设计 §8）：
 * 按 (documentId, parentChunkId) 去重保留最高分，重排后取最终 Top-K。
 */
export function mergeKnowledgeBaseRetrievals(outcomes: KnowledgeBaseRetrievalOutcome[], topK: number): KnowledgeBaseRetrievalOutcome {
  if (outcomes.length === 1) return outcomes[0];
  const bestByParent = new Map<string, KnowledgeBaseRagParentEvidence>();
  for (const outcome of outcomes) {
    for (const entry of outcome.evidence) {
      const key = [entry.documentId, entry.parentChunkId].join('|');
      const existing = bestByParent.get(key);
      if (!existing || entry.score > existing.score) bestByParent.set(key, entry);
    }
  }
  const evidence = [...bestByParent.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  const rerankNotices = outcomes.map((outcome) => outcome.rerank.notice).filter(Boolean) as string[];
  const notices = outcomes.map((outcome) => outcome.notice).filter(Boolean) as string[];
  const notice = notices.join('；') || undefined;
  const expansions = outcomes.map((outcome) => outcome.expansion).filter(Boolean) as KnowledgeBaseRetrievalExpansionState[];
  const triggeredExpansions = expansions.filter((entry) => entry.triggered);
  const graphExpansions = outcomes.map((outcome) => outcome.graphExpansion).filter(Boolean) as KnowledgeBaseRetrievalGraphExpansionState[];
  const directLoads = outcomes.map((outcome) => outcome.directLoad).filter(Boolean) as Array<{ documentIds: string[]; parentCount: number }>;
  const historyHits = outcomes.reduce((total, outcome) => total + (outcome.historyHits ?? 0), 0);
  const mmrDropped = outcomes.reduce((total, outcome) => total + (outcome.mmrDropped ?? 0), 0);
  return {
    evidence,
    children: outcomes.flatMap((outcome) => outcome.children),
    parentCandidateCount: outcomes.reduce((total, outcome) => total + outcome.parentCandidateCount, 0),
    rerank: {
      enabled: outcomes.some((outcome) => outcome.rerank.enabled),
      applied: outcomes.some((outcome) => outcome.rerank.applied),
      gatedOut: outcomes.reduce((total, outcome) => total + outcome.rerank.gatedOut, 0),
      allGatedOut: outcomes.every((outcome) => outcome.rerank.allGatedOut),
      ...(rerankNotices.length ? { notice: rerankNotices.join('；') } : {}),
      ...(outcomes.some((outcome) => outcome.rerank.degradedThreshold !== undefined)
        ? { degradedThreshold: Math.min(...outcomes.map((outcome) => outcome.rerank.degradedThreshold ?? Number.POSITIVE_INFINITY)) }
        : {}),
    },
    ...(notice ? { notice } : {}),
    used: outcomes.some((outcome) => outcome.used === '综合搜索')
      ? '综合搜索'
      : outcomes[0].used,
    vectorIndexed: outcomes.some((outcome) => outcome.vectorIndexed),
    indexedChunks: Math.max(...outcomes.map((outcome) => outcome.indexedChunks)),
    ...(triggeredExpansions.length > 0 ? {
      expansion: {
        triggered: true,
        variants: [...new Set(triggeredExpansions.flatMap((entry) => entry.variants))],
        strategies: [...new Set(triggeredExpansions.flatMap((entry) => entry.strategies))],
        addedChildren: triggeredExpansions.reduce((total, entry) => total + entry.addedChildren, 0),
      },
    } : {}),
    ...(graphExpansions.length > 0 ? {
      graphExpansion: {
        seedCount: graphExpansions.reduce((total, entry) => total + entry.seedCount, 0),
        addedChildren: graphExpansions.reduce((total, entry) => total + entry.addedChildren, 0),
        contributions: graphExpansions.flatMap((entry) => entry.contributions ?? []),
      },
    } : {}),
    channelContribution: {
      vector: outcomes.reduce((total, outcome) => total + (outcome.channelContribution?.vector ?? 0), 0),
      fts: outcomes.reduce((total, outcome) => total + (outcome.channelContribution?.fts ?? 0), 0),
      graph: outcomes.reduce((total, outcome) => total + (outcome.channelContribution?.graph ?? 0), 0),
    },
    ...(directLoads.length > 0 ? {
      directLoad: {
        documentIds: [...new Set(directLoads.flatMap((entry) => entry.documentIds))],
        parentCount: directLoads.reduce((total, entry) => total + entry.parentCount, 0),
      },
    } : {}),
    ...(historyHits > 0 ? { historyHits } : {}),
    ...(mmrDropped > 0 ? { mmrDropped } : {}),
  };
}
