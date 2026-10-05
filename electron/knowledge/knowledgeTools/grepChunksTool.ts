import { searchMaterialChunks, type MaterialChunkSearchResult } from '../../pipeline/materialChunkSearch';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, toBoundedPublicToolResultText, type KnowledgeToolContext } from '../knowledgeToolContext';
import type { KnowledgeEvidenceRecord } from './knowledgeSessionState';
import { renderKnowledgeBaseImageTransportIndex } from '../knowledgeBaseImageResolver';
import type { AssistantPublicToolResultView } from '../assistantTurnTypes';

const DEFAULT_GREP_LIMIT = 8;
const MAX_GREP_LIMIT = 20;

export const grepChunksTool: ReActTool<KnowledgeToolContext> = {
  name: 'grep_chunks',
  description: [
    '按字面量/关键词在知识库中精确检索（Jieba 分词 + 倒排索引与自研打分）。',
    '适用：找专有名词、人名、编号、配置项、公式符号、原文措辞等必须逐字匹配的内容。',
    '不适用：按含义或同义表达找内容——请改用 knowledge_search。',
    'pattern 传要找的字面量（可含多个词，系统会分词后匹配）；',
    '可用 document_ids 限定到已知文档，提高命中率。',
    '返回带引用号 [n] 的命中块；需要上下文时用 list_knowledge_chunks 深读。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        maxLength: 80,
        description: '要精确查找的字面量或关键词组合',
      },
      document_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：限定检索的文档 id 列表（来自此前检索结果中的 document_id）',
      },
      limit: {
        type: 'number',
        description: '可选：返回条数上限（1–20，默认 8）',
      },
    },
    required: ['pattern'],
  },
  execute: async (args, ctx) => runGrepChunks(args, ctx),
};

async function runGrepChunks(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) {
    return { ok: false, observation: '<tool_error>grep_chunks 需要非空的 pattern。</tool_error>', message: '检索字面量为空，已拒绝执行。' };
  }
  const documentIds = Array.isArray(args.document_ids)
    ? args.document_ids.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 100)
    : undefined;
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(Math.floor(args.limit), MAX_GREP_LIMIT))
    : DEFAULT_GREP_LIMIT;

  ctx.onStage?.(`知识库 Agent 正在按字面量检索「${pattern}」…`);
  const searchContext = await ctx.prepareQueryContext(pattern);
  const outcome = await searchMaterialChunks({
    libraryPath: searchContext.targetPath,
    query: pattern,
    queryTerms: searchContext.queryTerms,
    lexicalError: searchContext.lexicalError,
    mode: 'keyword',
    documentIds: documentIds && documentIds.length > 0 ? documentIds : undefined,
    limit,
    adapter: searchContext.adapter,
    embeddingError: searchContext.embeddingError,
  });

  if (outcome.results.length === 0) {
    const note = outcome.notice ? ` ${outcome.notice}` : '';
    return {
      ok: true,
      observation: `<grep_results pattern="${escapeXmlAttribute(pattern)}">\n</grep_results>\n<retrieval_note>未命中「${escapeXmlText(pattern)}」。可更换写法（如缩写/全称、全半角）重试，或改用 knowledge_search 按含义检索。${escapeXmlText(note)}</retrieval_note>`,
      message: `字面量检索未命中「${pattern}」。`,
      referenceCount: 0,
    };
  }

  const rawRecords = outcome.results.map((result) => toEvidenceRecord(result, ctx));
  const visuals = ctx.resolveEvidenceVisuals?.(rawRecords) ?? { evidence: rawRecords, images: [], mappings: [] };
  const lines: string[] = [`<grep_results pattern="${escapeXmlAttribute(pattern)}">`];
  const publicResults: AssistantPublicToolResultView[] = [];
  let freshCount = 0;
  const seenRefs: string[] = [];
  for (const [index, result] of outcome.results.entries()) {
    const record = visuals.evidence[index]!;
    const documentName = record.documentName ?? result.documentId;
    const { reference, alreadySeen } = ctx.session.registerEvidence(record);
    publicResults.push({
      reference,
      title: documentName,
      location: `父块 ${record.ordinal}`,
      score: result.score,
      methods: ['keyword'],
      seen: alreadySeen,
      ...(!alreadySeen ? { excerpt: toBoundedPublicToolResultText(record.text) } : {}),
    });
    if (alreadySeen) {
      seenRefs.push(reference);
      lines.push(`  <result reference="${reference}" document_id="${escapeXmlAttribute(result.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${result.ordinal}" seen="true" />`);
      continue;
    }
    freshCount += 1;
    lines.push(
      `  <result reference="${reference}" document_id="${escapeXmlAttribute(result.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${result.ordinal}" score="${result.score.toFixed(2)}"${result.sectionContext ? ` section="${escapeXmlAttribute(result.sectionContext)}"` : ''}>\n`
      + `    <content>${compactObservationText(record.text)}</content>\n`
      + '  </result>',
    );
  }
  lines.push('</grep_results>');

  const notes: string[] = [`命中 ${outcome.results.length} 块（新 ${freshCount} 条），检索方式：${outcome.used}。`];
  if (seenRefs.length > 0) notes.push(`其中 ${seenRefs.join('、')} 在本会话已见过。`);
  if (outcome.notice) notes.push(outcome.notice);
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `字面量检索命中 ${outcome.results.length} 块（新 ${freshCount} 条）。`,
    referenceCount: freshCount,
    publicResults,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}

/** 优先取父块作为证据单元；无父块时以命中子块本身登记。 */
function toEvidenceRecord(result: MaterialChunkSearchResult, ctx: KnowledgeToolContext): KnowledgeEvidenceRecord {
  const parent = result.citation.parent;
  return {
    documentId: result.documentId,
    documentName: ctx.documentNameById(result.documentId),
    parentChunkId: result.parentChunkId ?? result.chunkId,
    ordinal: parent?.ordinal ?? result.ordinal,
    text: parent?.text ?? result.text,
    sourceText: parent?.sourceText ?? result.citation.sourceText,
    sectionContext: result.sectionContext || undefined,
    score: result.score,
  };
}
