import type { ReActBudget } from '../knowledge/reactAgent/reactEngineTypes';

/**
 * Wiki 节点作用域预算剖面（方案 §4.4）。
 *
 * R2 最多允许 5 个受控检索周期；预算需容纳每周期一次检索以及必要的深读，
 * 同时由范围策略独立拒绝第 6 次检索。
 */
export const WIKI_NODE_REACT_BUDGET: ReActBudget = {
  /** 允许 5 个“检索 → 评估”周期，并为深读与终答留出决策轮。 */
  maxIterations: 10,
  /** 含终答与有限兜底余量。 */
  maxModelCalls: 12,
  /** 5 次检索之外允许有限深读；第 6 次检索仍由 Wiki 周期门控拒绝。 */
  maxToolCalls: 12,
  /** 对齐引擎默认。 */
  maxEmptyRetries: 1,
  maxRepeatedContentRounds: 2,
  /** 节点证据粒度小于全库。 */
  maxSingleObservationChars: 8_000,
  /** 与通用知识库动态轨迹预算对齐。 */
  maxTotalObservationTokens: 20_000,
  contextConsolidationThreshold: 0.5,
  contextConsolidationMaxTokens: 2_000,
};

/**
 * 长章节总结需要覆盖阅读而非命中即答：仅 `summarize` 使用，更高的预算不影响普通节点问答。
 */
export const WIKI_NODE_SUMMARY_REACT_BUDGET: ReActBudget = {
  ...WIKI_NODE_REACT_BUDGET,
  maxIterations: 12,
  maxModelCalls: 14,
  maxToolCalls: 14,
  maxTotalObservationTokens: 32_000,
};

/** 节点 markdown ≤ 该字符数时全文直载（L0），系统提示声明检索仅用于字面核实与跨节点关联。 */
export const WIKI_NODE_DIRECT_INJECT_CHARS = 6_000;
/** 超过直载阈值时注入的头部字符数。 */
export const WIKI_NODE_DIRECT_HEAD_CHARS = 4_000;
/** 超过直载阈值时注入的尾部字符数。 */
export const WIKI_NODE_DIRECT_TAIL_CHARS = 1_000;
/** wiki_read_node 单窗返回的 markdown 字符上限（对齐观察预算粒度）。 */
export const WIKI_NODE_READ_WINDOW_CHARS = 8_000;
/** wiki_node_search 单条查询的父块召回数；多路合并后再取 Top K。 */
export const WIKI_NODE_SEARCH_PER_QUERY_TOP_K = 3;
/** wiki_node_search 多路合并后的父块证据上限。 */
export const WIKI_NODE_SEARCH_MERGED_TOP_K = 5;
/** wiki_node_search 单次调用的最大查询条数。 */
export const WIKI_NODE_SEARCH_MAX_QUERIES = 3;
/** wiki_grep_node 单次调用返回的最大命中数；超出提示缩小范围或改用深读。 */
export const WIKI_GREP_MAX_MATCHES = 10;
/** wiki_grep_node 单条命中在原文中的上下文字符半径（命中位置前后各取该字符数）。 */
export const WIKI_GREP_CONTEXT_CHARS = 200;
