import { mergeKnowledgeBaseRetrievals, retrieveKnowledgeBaseEvidence } from '../../knowledge/knowledgeBaseRag';
import type { ReActTool, ReActToolExecution } from '../../knowledge/reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText } from '../../knowledge/knowledgeToolContext';
import type { KnowledgeEvidenceRecord } from '../../knowledge/knowledgeTools/knowledgeSessionState';
import { renderKnowledgeBaseImageTransportIndex } from '../../knowledge/knowledgeBaseImageResolver';
import type { WikiToolContext } from '../wikiToolContext';
import {
  WIKI_NODE_SEARCH_MAX_QUERIES,
  WIKI_NODE_SEARCH_MERGED_TOP_K,
  WIKI_NODE_SEARCH_PER_QUERY_TOP_K,
} from '../wikiNodeBudget';

/**
 * wiki_node_search（方案 §4.3）：在当前节点子树内做混合检索（向量 + 关键词、RRF、
 * 可选 rerank、MMR），完整复用知识库 retrieveKnowledgeBaseEvidence 管道，仅叠加
 * documentIds=[documentId] 与 sectionNodeIds=子树 headingId 集合两个作用域参数，
 * 并关闭本地扩写、图通道一跳扩展与小文档直载，杜绝子树外证据混入。
 */
export const wikiNodeSearchTool: ReActTool<WikiToolContext> = {
  name: 'wiki_node_search',
  description: [
    '在当前章节及其子章节范围内按语义检索内容（向量 + 关键词混合召回、RRF 融合、可选 Rerank 精排）。',
    '适用：找概念、解释、做法、结论等按"含义"检索的问题，检索范围严格限定在本章节子树。',
    '不适用：找专有名词、编号、配置项、原文措辞——请改用 wiki_read_node 深读原文核对。',
    'queries 传 1–3 条完整的语义化问题或陈述（例如"本节的校准步骤有哪些"），不要拆成关键词碎片；',
    '不同查询应覆盖问题的不同侧面。返回带引用号 [n] 的父块证据；命中后若信息不完整，应再用 wiki_read_node 展开原文。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: WIKI_NODE_SEARCH_MAX_QUERIES,
        items: { type: 'string', maxLength: 120 },
        description: '1–3 条完整的语义化问题或陈述，按含义搜索，不要拆成关键词',
      },
    },
    required: ['queries'],
  },
  execute: async (args, ctx) => runWikiNodeSearch(args, ctx),
};

async function runWikiNodeSearch(args: Record<string, unknown>, ctx: WikiToolContext): Promise<ReActToolExecution> {
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, WIKI_NODE_SEARCH_MAX_QUERIES);
  if (queries.length === 0) {
    return { ok: false, observation: '<tool_error>wiki_node_search 需要至少一条非空查询。</tool_error>', message: '检索查询为空，已拒绝执行。' };
  }

  ctx.onStage?.(`Wiki Agent 正在本章节内执行 ${queries.length} 路语义检索…`);
  const outcomes = [];
  for (const query of queries) {
    if (ctx.signal.aborted) break;
    const searchContext = await ctx.prepareQueryContext(query);
    outcomes.push(await retrieveKnowledgeBaseEvidence({
      libraryPath: searchContext.targetPath,
      query,
      queryTerms: searchContext.queryTerms,
      lexicalError: searchContext.lexicalError,
      adapter: searchContext.adapter,
      embeddingError: searchContext.embeddingError,
      rerankEnabled: ctx.rerank.enabled,
      rerankAdapter: ctx.rerank.adapter,
      parentTopK: WIKI_NODE_SEARCH_PER_QUERY_TOP_K,
      // 多路 queries 已覆盖扩写意图，工具层关闭本地扩写；本轮已登记证据作为历史引用放宽门控。
      allowExpansion: false,
      historyEvidenceKeys: ctx.session.seenEvidenceKeys(),
      // Wiki 节点作用域：限定文档 + 章节子树，关闭图扩展与跨文档小文档直载，杜绝子树外证据。
      documentIds: [ctx.documentId],
      ...(ctx.sectionNodeIds ? { sectionNodeIds: ctx.sectionNodeIds } : {}),
      allowGraphExpansion: false,
      directLoadEnabled: false,
    }));
  }
  if (outcomes.length === 0) {
    return { ok: false, observation: '<tool_error>检索被取消。</tool_error>', message: '检索被取消。' };
  }
  const merged = mergeKnowledgeBaseRetrievals(outcomes, WIKI_NODE_SEARCH_MERGED_TOP_K);

  if (merged.evidence.length === 0) {
    const notice = merged.notice ? `<retrieval_note>${escapeXmlText(merged.notice)}</retrieval_note>` : '';
    return {
      ok: true,
      observation: `<search_results queries="${escapeXmlAttribute(queries.join('；'))}">\n</search_results>\n<retrieval_note>本章节内未命中任何父块。可尝试更换措辞、用 wiki_read_node 直接深读本章节原文，或确认本章节是否确有相关内容。</retrieval_note>${notice}`,
      message: `本章节语义检索未命中（${queries.length} 路查询）。`,
      referenceCount: 0,
    };
  }

  const visuals = ctx.resolveEvidenceVisuals?.(merged.evidence) ?? { evidence: merged.evidence, images: [], mappings: [] };
  const lines: string[] = [`<search_results queries="${escapeXmlAttribute(queries.join('；'))}">`];
  let freshCount = 0;
  const seenRefs: string[] = [];
  for (const entry of visuals.evidence) {
    const documentName = entry.documentId === ctx.documentId ? ctx.documentName : entry.documentId;
    const record: KnowledgeEvidenceRecord = {
      documentId: entry.documentId,
      documentName,
      parentChunkId: entry.parentChunkId,
      ordinal: entry.parentOrdinal,
      text: entry.text,
      sourceText: entry.sourceText,
      sectionContext: entry.sectionContext,
      score: entry.score,
      methods: entry.methods,
    };
    const { reference, alreadySeen } = ctx.session.registerEvidence(record);
    if (alreadySeen) {
      seenRefs.push(reference);
      lines.push(`  <result reference="${reference}" ordinal="${entry.parentOrdinal}" seen="true" />`);
      continue;
    }
    freshCount += 1;
    const methods = entry.methods.map((method) => (method === 'semantic' ? '语义' : '关键词')).join('+') || '综合';
    lines.push(
      `  <result reference="${reference}" ordinal="${entry.parentOrdinal}" score="${entry.score.toFixed(2)}" methods="${methods}">\n`
      + `    <content>${compactObservationText(entry.text)}</content>\n`
      + '  </result>',
    );
  }
  lines.push('</search_results>');

  const notes: string[] = [`本章节内命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条）；引用号用于终答标注。`];
  if (seenRefs.length > 0) notes.push(`其中 ${seenRefs.join('、')} 在本会话已见过，不再展开正文，可直接引用。`);
  if (freshCount > 0) notes.push('若命中内容不完整或位于块边缘，用 wiki_read_node 深读本章节原文。');
  if (merged.notice) notes.push(merged.notice);
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `本章节语义检索命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条）。`,
    referenceCount: freshCount,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}
