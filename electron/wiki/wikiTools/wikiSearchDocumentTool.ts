import { mergeKnowledgeBaseRetrievals, retrieveKnowledgeBaseEvidence } from '../../knowledge/knowledgeBaseRag';
import type { ReActTool, ReActToolExecution } from '../../knowledge/reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText } from '../../knowledge/knowledgeToolContext';
import type { KnowledgeEvidenceRecord } from '../../knowledge/knowledgeTools/knowledgeSessionState';
import { renderKnowledgeBaseImageTransportIndex } from '../../knowledge/knowledgeBaseImageResolver';
import type { WikiToolContext } from '../wikiToolContext';
import { collectCrossNodeHeadingIds } from '../wikiNodeScope';
import {
  WIKI_NODE_SEARCH_MAX_QUERIES,
  WIKI_NODE_SEARCH_MERGED_TOP_K,
  WIKI_NODE_SEARCH_PER_QUERY_TOP_K,
} from '../wikiNodeBudget';

/** 跨章节证据的来源章节标签（sectionContext）字符上限，避免属性过长挤占观察预算。 */
const WIKI_CROSS_SECTION_LABEL_CHARS = 120;

/**
 * wiki_search_document（方案 §4.3）：在同一篇文档内、当前章节子树之外的其他章节做混合检索。
 *
 * 与 wiki_node_search 复用同一 retrieveKnowledgeBaseEvidence 管道，唯一差异是作用域参数
 * `sectionNodeIds` 取「整篇文档 headingId − 当前子树 headingId」的补集，从而只召回其他章节，
 * 服务 cross-links 动作与用户显式询问「与其他章节的关联」。每条证据附来源章节标签
 * （取自匹配子块的 sectionContext），便于模型按关联章节分组作答。
 */
export const wikiSearchDocumentTool: ReActTool<WikiToolContext> = {
  name: 'wiki_search_document',
  description: [
    '在同一篇文档内、当前章节及其子章节之外的其他章节按语义检索内容（向量 + 关键词混合召回）。',
    '适用：用户显式询问"本章节与文档其他部分的关联""哪些章节也提到了 X"等跨章节问题。',
    '不适用：回答本章节内部的问题——那请改用 wiki_node_search。',
    'queries 传 1–3 条完整语义化查询；返回带引用号 [n] 的父块证据，并标注每条证据所属的其他章节，便于按章节分组说明关联。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: WIKI_NODE_SEARCH_MAX_QUERIES,
        items: { type: 'string', maxLength: 120 },
        description: '1–3 条完整的语义化问题或陈述，检索本章节之外的其他章节，不要拆成关键词',
      },
    },
    required: ['queries'],
  },
  execute: async (args, ctx) => runWikiSearchDocument(args, ctx),
};

async function runWikiSearchDocument(args: Record<string, unknown>, ctx: WikiToolContext): Promise<ReActToolExecution> {
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, WIKI_NODE_SEARCH_MAX_QUERIES);
  if (queries.length === 0) {
    return { ok: false, observation: '<tool_error>wiki_search_document 需要至少一条非空查询。</tool_error>', message: '检索查询为空，已拒绝执行。' };
  }

  // 根节点作用域即整篇文档，没有"其他章节"可关联；直接如实说明，避免无意义检索。
  if (ctx.sectionNodeIds === undefined) {
    return {
      ok: true,
      observation: '<cross_section_results queries="' + escapeXmlAttribute(queries.join('；')) + '">\n</cross_section_results>\n<retrieval_note>当前章节是整篇文档的根，文档内没有"本章节之外"的其他章节可供关联。</retrieval_note>',
      message: '根节点无跨章节可关联。',
      referenceCount: 0,
    };
  }
  const crossNodeIds = collectCrossNodeHeadingIds(ctx.outlineNodes, ctx.sectionNodeIds);
  if (crossNodeIds.length === 0) {
    return {
      ok: true,
      observation: '<cross_section_results queries="' + escapeXmlAttribute(queries.join('；')) + '">\n</cross_section_results>\n<retrieval_note>本文档除当前章节子树外没有其他章节，无法进行跨章节关联检索。</retrieval_note>',
      message: '文档内无其他章节可关联。',
      referenceCount: 0,
    };
  }

  ctx.onStage?.(`Wiki Agent 正在本章节之外的 ${crossNodeIds.length} 个章节范围内执行 ${queries.length} 路跨章节检索…`);
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
      allowExpansion: false,
      historyEvidenceKeys: ctx.session.seenEvidenceKeys(),
      // 跨章节作用域：限定同一文档，sectionNodeIds 取当前子树的补集，只召回其他章节。
      documentIds: [ctx.documentId],
      sectionNodeIds: crossNodeIds,
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
      observation: '<cross_section_results queries="' + escapeXmlAttribute(queries.join('；')) + '">\n</cross_section_results>\n<retrieval_note>本章节之外的其他章节未命中任何父块。可尝试更换措辞，或如实说明"未找到与其他章节的明确关联"。</retrieval_note>' + notice,
      message: `跨章节检索未命中（${queries.length} 路查询）。`,
      referenceCount: 0,
    };
  }

  // 来源章节标签：由匹配子块的 sectionContext 提供，供模型按关联章节分组。
  const sectionByChild = new Map<string, string>();
  const sourceNodeByChild = new Map<string, { id: string; title: string }>();
  for (const child of merged.children) {
    const label = child.sectionContext?.trim();
    if (label && !sectionByChild.has(child.chunkId)) sectionByChild.set(child.chunkId, label);
    const sectionPath = Array.isArray(child.sectionPath) ? child.sectionPath : [];
    const terminal = sectionPath.at(-1);
    const sourceHeadingId = terminal && typeof terminal === 'object' && typeof (terminal as { nodeId?: unknown }).nodeId === 'string'
      ? (terminal as { nodeId: string }).nodeId
      : undefined;
    const sourceNode = sourceHeadingId
      ? ctx.outlineNodes.find((candidate) => candidate.sourceHeadingId === sourceHeadingId)
      : undefined;
    if (sourceNode && !sourceNodeByChild.has(child.chunkId)) {
      sourceNodeByChild.set(child.chunkId, { id: sourceNode.id, title: sourceNode.title });
    }
  }

  const lines: string[] = ['<cross_section_results queries="' + escapeXmlAttribute(queries.join('；')) + '">'];
  const visuals = ctx.resolveEvidenceVisuals?.(merged.evidence) ?? { evidence: merged.evidence, images: [], mappings: [] };
  let freshCount = 0;
  const seenRefs: string[] = [];
  const sections = new Set<string>();
  for (const entry of visuals.evidence) {
    const documentName = entry.documentId === ctx.documentId ? ctx.documentName : entry.documentId;
    const section = sectionByChild.get(entry.childChunkId)?.slice(0, WIKI_CROSS_SECTION_LABEL_CHARS);
    const sourceNode = sourceNodeByChild.get(entry.childChunkId);
    if (sourceNode) ctx.scopeState.authorizedDocumentNodeIds.add(sourceNode.id);
    const record: KnowledgeEvidenceRecord = {
      documentId: entry.documentId,
      documentName,
      parentChunkId: entry.parentChunkId,
      ordinal: entry.parentOrdinal,
      text: entry.text,
      sourceText: entry.sourceText,
      ...(section ? { sectionContext: section } : {}),
      score: entry.score,
      methods: entry.methods,
    };
    const { reference, alreadySeen } = ctx.session.registerEvidence(record);
    if (section) sections.add(section);
    const sectionAttr = section ? ` section="${escapeXmlAttribute(section)}"` : '';
    const sourceNodeAttr = sourceNode ? ` source_node_id="${escapeXmlAttribute(sourceNode.id)}"` : '';
    if (alreadySeen) {
      seenRefs.push(reference);
      lines.push(`  <result reference="${reference}" ordinal="${entry.parentOrdinal}"${sectionAttr}${sourceNodeAttr} seen="true" />`);
      continue;
    }
    freshCount += 1;
    const methods = entry.methods.map((method) => (method === 'semantic' ? '语义' : '关键词')).join('+') || '综合';
    lines.push(
      `  <result reference="${reference}" ordinal="${entry.parentOrdinal}" score="${entry.score.toFixed(2)}" methods="${methods}"${sectionAttr}${sourceNodeAttr}>\n`
      + `    <content>${compactObservationText(entry.text)}</content>\n`
      + '  </result>',
    );
  }
  lines.push('</cross_section_results>');

  const notes: string[] = [`本章节之外命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条）`];
  if (sections.size > 0) notes.push(`涉及其他章节：${[...sections].slice(0, 8).map((section) => `「${section}」`).join('、')}`);
  notes.push('请按关联到的章节分组说明关联点，事实句尾标注引用号 [n]。');
  if (seenRefs.length > 0) notes.push(`其中 ${seenRefs.join('、')} 在本会话已见过，不再展开正文，可直接引用。`);
  if (merged.notice) notes.push(merged.notice);
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `跨章节检索命中 ${merged.evidence.length} 个父块（新 ${freshCount} 条，涉及 ${sections.size} 个其他章节）。`,
    referenceCount: freshCount,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}
