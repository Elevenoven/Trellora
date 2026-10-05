import { mergeKnowledgeBaseRetrievals, retrieveKnowledgeBaseEvidence } from '../knowledgeBaseRag';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, toBoundedPublicToolResultText, type KnowledgeToolContext } from '../knowledgeToolContext';
import type { KnowledgeEvidenceRecord } from './knowledgeSessionState';
import { renderKnowledgeBaseImageTransportIndex } from '../knowledgeBaseImageResolver';
import type { AssistantPublicToolResultView } from '../assistantTurnTypes';

/** 单条查询的父块召回数；多路合并后再取 Top 5（方案 §4.3）。 */
const PER_QUERY_PARENT_TOP_K = 3;
const MERGED_TOP_K = 5;
const MAX_QUERIES = 5;

export const knowledgeSearchTool: ReActTool<KnowledgeToolContext> = {
  name: 'knowledge_search',
  description: [
    '按语义在知识库中检索内容（向量 + 关键词混合召回、RRF 融合、可选 Rerank 精排）。',
    '适用：找概念、解释、做法、结论等按"含义"检索的问题。',
    '不适用：找专有名词、编号、配置项、原文措辞——请改用 grep_chunks。',
    'queries 传 1–5 条完整的语义化问题或陈述（例如"谐波抑制有哪些常见方法"），',
    '不要拆成关键词碎片；不同查询应覆盖问题的不同侧面，避免重复同义改写。',
    '返回带引用号 [n] 的父块证据；命中后若信息不完整，应再用 list_knowledge_chunks 深读原文。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUERIES,
        items: { type: 'string', maxLength: 120 },
        description: '1–5 条完整的语义化问题或陈述，按含义搜索，不要拆成关键词',
      },
    },
    required: ['queries'],
  },
  execute: async (args, ctx) => runKnowledgeSearch(args, ctx),
};

async function runKnowledgeSearch(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_QUERIES);
  if (queries.length === 0) {
    return { ok: false, observation: '<tool_error>knowledge_search 需要至少一条非空查询。</tool_error>', message: '检索查询为空，已拒绝执行。' };
  }

  ctx.onStage?.(`知识库 Agent 正在执行 ${queries.length} 路语义检索…`);
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
      parentTopK: PER_QUERY_PARENT_TOP_K,
      // 多路 queries 已覆盖扩写意图，工具层关闭本地扩写；本轮已登记证据作为历史引用放宽门控。
      allowExpansion: false,
      historyEvidenceKeys: ctx.session.seenEvidenceKeys(),
      ...(ctx.documentAffinityFactors ? { documentAffinityFactors: ctx.documentAffinityFactors } : {}),
    }));
  }
  if (outcomes.length === 0) {
    return { ok: false, observation: '<tool_error>检索被取消。</tool_error>', message: '检索被取消。' };
  }
  const merged = mergeKnowledgeBaseRetrievals(outcomes, MERGED_TOP_K);

  if (merged.evidence.length === 0) {
    const notice = merged.notice ? `<retrieval_note>${escapeXmlText(merged.notice)}</retrieval_note>` : '';
    return {
      ok: true,
      observation: `<search_results queries="${escapeXmlAttribute(queries.join('；'))}">\n</search_results>\n<retrieval_note>未命中任何父块。可尝试更换措辞、改用 grep_chunks 按字面量检索，或确认知识库中是否确有相关内容。</retrieval_note>${notice}`,
      message: `语义检索未命中（${queries.length} 路查询）。`,
      referenceCount: 0,
    };
  }

  const visuals = ctx.resolveEvidenceVisuals?.(merged.evidence) ?? { evidence: merged.evidence, images: [], mappings: [] };
  const lines: string[] = [`<search_results queries="${escapeXmlAttribute(queries.join('；'))}">`];
  const publicResults: AssistantPublicToolResultView[] = [];
  let freshCount = 0;
  const seenRefs: string[] = [];
  for (const entry of visuals.evidence) {
    const documentName = ctx.documentNameById(entry.documentId) ?? entry.documentId;
    const record: KnowledgeEvidenceRecord = {
      documentId: entry.documentId,
      documentName,
      parentChunkId: entry.parentChunkId,
      ordinal: entry.parentOrdinal,
      text: entry.text,
      sourceText: entry.sourceText,
      score: entry.score,
      methods: entry.methods,
    };
    const { reference, alreadySeen } = ctx.session.registerEvidence(record);
    publicResults.push({
      reference,
      title: documentName,
      location: `父块 ${entry.parentOrdinal}`,
      score: entry.score,
      methods: entry.methods,
      seen: alreadySeen,
      ...(!alreadySeen ? { excerpt: toBoundedPublicToolResultText(entry.text) } : {}),
    });
    if (alreadySeen) {
      seenRefs.push(reference);
      lines.push(`  <result reference="${reference}" document_id="${escapeXmlAttribute(entry.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${entry.parentOrdinal}" seen="true" />`);
      continue;
    }
    freshCount += 1;
    const methods = entry.methods.map((method) => (method === 'semantic' ? '语义' : '关键词')).join('+') || '综合';
    lines.push(
      `  <result reference="${reference}" document_id="${escapeXmlAttribute(entry.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${entry.parentOrdinal}" score="${entry.score.toFixed(2)}" methods="${methods}">\n`
      + `    <content>${compactObservationText(entry.text)}</content>\n`
      + '  </result>',
    );
  }
  lines.push('</search_results>');

  const notes: string[] = [`命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条）；引用号用于终答标注。`];
  if (seenRefs.length > 0) notes.push(`其中 ${seenRefs.join('、')} 在本会话已见过，不再展开正文，可直接引用。`);
  if (merged.graphExpansion && merged.graphExpansion.addedChildren > 0) {
    notes.push(`图通道已基于 ${merged.graphExpansion.seedCount} 个种子块补充 ${merged.graphExpansion.addedChildren} 个相邻子块，相关证据已参与聚合。`);
  }
  if (freshCount > 0) notes.push('若命中内容不完整或位于块边缘，用 list_knowledge_chunks 按 document_id + ordinal 深读原文。');
  if (merged.notice) notes.push(merged.notice);
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `语义检索命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条）。`,
    referenceCount: freshCount,
    publicResults,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}
