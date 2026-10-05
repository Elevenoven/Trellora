import type { MaterialChunkSearchResult } from '../pipeline/materialChunkSearch';

/** RRF 名次常数；FTS 名次分数也复用该常数，为全局唯一定义点（优化方案 P2-8）。 */
export const RRF_RANK_CONSTANT = 60;
/** 词法通道排序键中关键词增强分的权重：lexicalKey = bm25RankScore + boost × keywordScore。 */
export const LEXICAL_KEYWORD_BOOST = 0.25;
/** 父块聚合中「其余命中子块 support」的权重 μ。 */
export const PARENT_SUPPORT_WEIGHT = 0.2;
/** rerank 融合中 rerank 分的权重 β。 */
export const RERANK_FUSION_BETA = 0.7;
/** rerank gating 阈值 τ：低于该值的父块被剔除出证据。 */
export const RERANK_GATE_THRESHOLD = 0.25;
/** gating 全剔除时的阈值降级因子：τ' = τ × 0.7 重滤一次（借鉴 WeKnora 阈值回退思想）。 */
export const RERANK_GATE_DEGRADE_FACTOR = 0.7;
/** 降级阈值的绝对地板，避免无限放宽。 */
export const RERANK_GATE_DEGRADE_FLOOR = 0.05;
/** 历史引用父块的门控放宽量：上轮已引用的父块阈值放宽 0.1（借鉴 WeKnora MatchTypeHistory 思想）。 */
export const RERANK_HISTORY_THRESHOLD_RELIEF = 0.1;
/** 历史引用放宽后的阈值地板。 */
export const RERANK_HISTORY_THRESHOLD_FLOOR = 0.05;

/** RRF 融合后的子块行：在原检索结果上附 rrf 分与双通道名次。 */
export interface HybridChildFusion extends MaterialChunkSearchResult {
  rrfScore: number;
  ranks: { vector?: number; lexical?: number };
}

export interface RrfChannelEntry {
  rrfScore: number;
  vectorRank?: number;
  lexicalRank?: number;
}

/**
 * 规范 RRF：只消费两条有序召回列表的排名，不消费原始分数，
 * 因此免疫 cosine/BM25 分数尺度随语料漂移的问题。
 * 缺失通道的子块不贡献该通道分项（不做 0 分惩罚）。
 */
export function reciprocalRankFusion(input: {
  /** 向量通道有序 key 列表（distance 升序）。 */
  vectorKeys: string[];
  /** 关键词通道有序 key 列表（lexicalKey 降序）。 */
  lexicalKeys: string[];
  k?: number;
  vectorWeight?: number;
  lexicalWeight?: number;
}): Map<string, RrfChannelEntry> {
  const k = input.k ?? RRF_RANK_CONSTANT;
  const vectorWeight = input.vectorWeight ?? 1;
  const lexicalWeight = input.lexicalWeight ?? 1;
  const fused = new Map<string, RrfChannelEntry>();
  const contribute = (keys: string[], weight: number, channel: 'vector' | 'lexical'): void => {
    keys.forEach((key, index) => {
      const entry = fused.get(key) ?? { rrfScore: 0 };
      entry.rrfScore += weight / (k + index + 1);
      if (channel === 'vector') entry.vectorRank = index + 1;
      else entry.lexicalRank = index + 1;
      fused.set(key, entry);
    });
  };
  contribute(input.vectorKeys, vectorWeight, 'vector');
  contribute(input.lexicalKeys, lexicalWeight, 'lexical');
  for (const entry of fused.values()) entry.rrfScore = Number(entry.rrfScore.toFixed(6));
  return fused;
}

export interface ParentAggregateScore {
  documentId: string;
  parentChunkId: string;
  /** base + μ × support；base 为最强子块 rrf。 */
  score: number;
  /** 当次查询内 score / max(score)，仅用于展示与 rerank 融合。 */
  normScore: number;
  hitChildren: number;
  bestChildChunkId: string;
  bestChildRrf: number;
  support: number;
}

/**
 * 子块 → 父块上卷聚合：base 主导 + support 覆盖加成。
 * 无父块的子块（遗留数据）跳过，与专用路由旧行为一致。
 */
export function aggregateParentScores(children: HybridChildFusion[], supportWeight: number = PARENT_SUPPORT_WEIGHT): ParentAggregateScore[] {
  const byParent = new Map<string, { documentId: string; parentChunkId: string; rows: HybridChildFusion[] }>();
  for (const child of children) {
    if (!child.parentChunkId) continue;
    const key = [child.documentId, child.parentChunkId].join('|');
    const group = byParent.get(key) ?? { documentId: child.documentId, parentChunkId: child.parentChunkId, rows: [] };
    group.rows.push(child);
    byParent.set(key, group);
  }
  const aggregated: ParentAggregateScore[] = [];
  for (const group of byParent.values()) {
    const ordered = [...group.rows].sort((first, second) => second.rrfScore - first.rrfScore);
    const best = ordered[0];
    const support = ordered.slice(1).reduce((total, row) => total + row.rrfScore, 0);
    aggregated.push({
      documentId: group.documentId,
      parentChunkId: group.parentChunkId,
      score: Number((best.rrfScore + supportWeight * support).toFixed(6)),
      normScore: 0,
      hitChildren: ordered.length,
      bestChildChunkId: best.chunkId,
      bestChildRrf: best.rrfScore,
      support: Number(support.toFixed(6)),
    });
  }
  const maximum = Math.max(...aggregated.map((entry) => entry.score), 0);
  for (const entry of aggregated) entry.normScore = maximum > 0 ? Number((entry.score / maximum).toFixed(6)) : 0;
  return aggregated.sort((first, second) => second.score - first.score || first.documentId.localeCompare(second.documentId));
}

export interface RerankFusionOutcome {
  /** 父块候选数组的下标，按 final 分降序且已应用 gating。 */
  order: number[];
  finals: number[];
  gatedOut: number;
  /** gating 剔除全部候选时为 true（含降级重滤后仍全剔除）；调用方应回退 RRF 聚合序并保留 Top-1。 */
  allGatedOut: boolean;
  /** 首轮全剔除后实际生效的降级阈值；未触发降级时缺省。 */
  degradedThreshold?: number;
}

/**
 * rerank 分与 RRF 归一分融合：final = β·rerank + (1-β)·norm；
 * rerank < τ 的父块被 gating 剔除。rerank 主导排序，RRF 作为先验 tie-breaker。
 * 首轮全剔除时按 τ' = max(τ × degradeFactor, degradeFloor) 降级重滤一次；
 * historyIndices 命中的父块（上轮已引用）阈值放宽 relief，不凭空注入证据。
 */
export function fuseRerankScores(
  normScores: number[],
  rerankScores: number[],
  options?: {
    beta?: number;
    threshold?: number;
    degradeFactor?: number;
    degradeFloor?: number;
    /** 属于历史引用的候选下标；门控阈值放宽 RERANK_HISTORY_THRESHOLD_RELIEF。 */
    historyIndices?: number[];
  },
): RerankFusionOutcome {
  if (!Array.isArray(normScores) || !Array.isArray(rerankScores) || normScores.length !== rerankScores.length) {
    throw new Error('RERANK_COUNT_MISMATCH: rerank 返回数量与父块候选不一致。');
  }
  if (rerankScores.some((score) => typeof score !== 'number' || !Number.isFinite(score))) {
    throw new Error('RERANK_SCORE_INVALID: rerank 返回了非有限分数。');
  }
  const beta = options?.beta ?? RERANK_FUSION_BETA;
  const threshold = options?.threshold ?? RERANK_GATE_THRESHOLD;
  const degradeFactor = options?.degradeFactor ?? RERANK_GATE_DEGRADE_FACTOR;
  const degradeFloor = options?.degradeFloor ?? RERANK_GATE_DEGRADE_FLOOR;
  const history = new Set((options?.historyIndices ?? []).filter((index) => index >= 0 && index < rerankScores.length));
  const clamped = rerankScores.map((score) => Math.max(0, Math.min(1, score)));
  const finals = clamped.map((score, index) => Number((beta * score + (1 - beta) * (normScores[index] ?? 0)).toFixed(6)));
  const thresholdOf = (index: number): number => history.has(index)
    ? Math.max(threshold - RERANK_HISTORY_THRESHOLD_RELIEF, RERANK_HISTORY_THRESHOLD_FLOOR)
    : threshold;
  const filterAt = (gate: (index: number) => number) =>
    finals.map((finalScore, index) => ({ index, finalScore, rerank: clamped[index] })).filter((row) => row.rerank >= gate(row.index));
  let passing = filterAt(thresholdOf);
  let degradedThreshold: number | undefined;
  if (passing.length === 0 && finals.length > 0) {
    const degraded = Math.max(Math.min(threshold * degradeFactor, threshold), degradeFloor);
    if (degraded < threshold) {
      degradedThreshold = Number(degraded.toFixed(6));
      passing = filterAt((index) => (history.has(index) ? Math.max(degraded - RERANK_HISTORY_THRESHOLD_RELIEF, RERANK_HISTORY_THRESHOLD_FLOOR) : degraded));
    }
  }
  const gatedOut = finals.length - passing.length;
  if (passing.length === 0) return { order: [], finals, gatedOut, allGatedOut: finals.length > 0, ...(degradedThreshold !== undefined ? { degradedThreshold } : {}) };
  passing.sort((first, second) => second.finalScore - first.finalScore || first.index - second.index);
  return { order: passing.map((row) => row.index), finals, gatedOut, allGatedOut: false, ...(degradedThreshold !== undefined ? { degradedThreshold } : {}) };
}
