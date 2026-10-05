import { reciprocalRankFusion, type HybridChildFusion } from './hybridRetrievalFusion';

/** 召回不足兜底扩写的变体上限；第一版常量，不进设置面板（借鉴 WeKnora 扩写思想，纯本地规则零模型调用）。 */
export const QUERY_EXPANSION_MAX_VARIANTS = 5;

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '吗', '呢', '吧', '啊', '也', '都', '就', '并', '及', '对', '把', '被', '从', '到', '向', '给', '为', '以', '等', '这', '那', '有', '没有',
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'about',
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose',
]);

// 长前缀优先，避免「什么是」被「什么」截断。
const QUESTION_WORD_PREFIXES = [
  '请告诉我', '我想知道', '我想了解', '请介绍', '什么是', '请问', '怎样', '怎么', '为什么', '何时', '何地', '哪个', '哪些', '介绍', '如何', '为何', '什么', '帮我', '谁',
];

const QUOTED_PHRASE_PATTERN = /["'"'「」『』《》]([^"'"'「」『』《》]{3,})["'"'「」『』《》]/g;
const DELIMITER_PATTERN = /[,，;；、。！？!?\s]+/;

export interface QueryExpansionOutcome {
  variants: string[];
  /** 命中的策略名，供 trace 解释。 */
  strategies: string[];
}

/**
 * 召回不足时的本地规则扩写（零模型调用）：
 * ① 分词去停用词重组；② 引号短语原样保留；③ 去疑问词前缀；④ 分隔符拆分。
 * 合并去重后取前 QUERY_EXPANSION_MAX_VARIANTS 条；与原文重复的变体一律剔除。
 */
export function expandQueriesLocally(query: string, queryTerms?: string[]): QueryExpansionOutcome {
  const original = query.trim();
  if (!original) return { variants: [], strategies: [] };
  const seen = new Set<string>([original]);
  const variants: string[] = [];
  const strategies = new Set<string>();
  const push = (variant: string, strategy: string): void => {
    const text = variant.trim();
    if (!text || text.length > 120 || seen.has(text)) return;
    seen.add(text);
    variants.push(text);
    strategies.add(strategy);
  };

  // ① 分词重组：去停用词后用空格连接，贴合 FTS 词元匹配。
  const terms = (queryTerms ?? []).map((term) => term.trim()).filter((term) => term && !STOPWORDS.has(term.toLowerCase()));
  if (terms.length >= 2) push(terms.join(' '), 'term-join');

  // ② 引号短语：专有名词/固定措辞按原文保留。
  for (const match of original.matchAll(QUOTED_PHRASE_PATTERN)) {
    if (match[1]) push(match[1], 'quoted-phrase');
  }

  // ③ 去疑问词前缀：让陈述式变体同时覆盖向量与词法通道。
  const stripped = removeQuestionWordPrefix(original);
  if (stripped && stripped !== original) push(stripped, 'question-word-strip');

  // ④ 分隔符拆分：复合问题拆成独立子句。
  const segments = original.split(DELIMITER_PATTERN).map((segment) => segment.trim()).filter((segment) => [...segment].length >= 2);
  if (segments.length >= 2) for (const segment of segments.slice(0, QUERY_EXPANSION_MAX_VARIANTS)) push(segment, 'delimiter-split');

  return { variants: variants.slice(0, QUERY_EXPANSION_MAX_VARIANTS), strategies: [...strategies] };
}

function removeQuestionWordPrefix(query: string): string {
  for (const prefix of QUESTION_WORD_PREFIXES) {
    if (query.startsWith(prefix)) {
      const remainder = query.slice(prefix.length).trim();
      if ([...remainder].length >= 2) return remainder;
    }
  }
  return query;
}

/**
 * 首轮召回与扩写召回的子块合并：按「首轮优先、扩写轮次依次追加」拼接各通道名次后
 * 重走一次规范 RRF，避免跨调用 rrf 分值尺度差异直接相加。
 * 字段主体保留首轮行；扩写独有的子块使用自身行。
 */
export function mergeRecalledChildren(firstRound: HybridChildFusion[], expansionRounds: HybridChildFusion[][]): HybridChildFusion[] {
  const rounds = [firstRound, ...expansionRounds];
  const byKey = new Map<string, HybridChildFusion>();
  const channelKeys = (channel: 'vector' | 'lexical'): string[] => {
    const ordered: string[] = [];
    const seenKeys = new Set<string>();
    for (const round of rounds) {
      const ranked = round
        .filter((child) => child.ranks?.[channel] !== undefined)
        .sort((first, second) => (first.ranks?.[channel] ?? 0) - (second.ranks?.[channel] ?? 0));
      for (const child of ranked) {
        const key = `${child.documentId}\u0000${child.chunkId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        ordered.push(key);
      }
    }
    return ordered;
  };
  for (const round of rounds) {
    for (const child of round) {
      const key = `${child.documentId}\u0000${child.chunkId}`;
      if (!byKey.has(key)) byKey.set(key, child);
    }
  }
  const fused = reciprocalRankFusion({ vectorKeys: channelKeys('vector'), lexicalKeys: channelKeys('lexical') });
  return [...byKey.entries()]
    .map(([key, child]) => {
      const entry = fused.get(key);
      return {
        ...child,
        score: Number((entry?.rrfScore ?? 0).toFixed(6)),
        rrfScore: Number((entry?.rrfScore ?? 0).toFixed(6)),
        ranks: {
          ...(entry?.vectorRank !== undefined ? { vector: entry.vectorRank } : {}),
          ...(entry?.lexicalRank !== undefined ? { lexical: entry.lexicalRank } : {}),
        },
      };
    })
    .sort((first, second) => second.rrfScore - first.rrfScore || first.documentId.localeCompare(second.documentId) || first.ordinal - second.ordinal);
}
