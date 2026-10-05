import { listMaterialsDocuments } from '../../materialsLibrary';
import { readMaterialDocumentIndexStats } from '../../pipeline/materialChunkSearch';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { escapeXmlAttribute, escapeXmlText, type KnowledgeToolContext } from '../knowledgeToolContext';

const OVERVIEW_LIMIT = 30;

export const getDocumentInfoTool: ReActTool<KnowledgeToolContext> = {
  name: 'get_document_info',
  description: [
    '查询知识库文档的元数据：标题、路径、大小、入库时间、向量索引状态与块数统计。',
    '适用：判断某文档是否值得深读、确认文档是否存在、了解知识库规模与索引状态。',
    '传 document_id 时只返回该文档详情；不传时返回知识库全部文档概览（最多 30 条）。',
    '本工具不返回正文内容；需要正文请用 knowledge_search / list_knowledge_chunks。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: '可选：要查看的文档 id；省略时返回全部文档概览' },
    },
  },
  execute: async (args, ctx) => runGetDocumentInfo(args, ctx),
};

async function runGetDocumentInfo(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
  const documents = listMaterialsDocuments(ctx.libraryPath);

  if (documentId) {
    const target = documents.find((document) => document.id === documentId);
    if (!target) {
      return { ok: false, observation: `<tool_error>文档 ${escapeXmlText(documentId)} 不存在；不传 document_id 可查看知识库全部文档。</tool_error>`, message: `文档不存在：${documentId}。` };
    }
    const stats = readMaterialDocumentIndexStats(ctx.libraryPath, documentId);
    const observation = [
      `<document_info document_id="${escapeXmlAttribute(target.id)}">`,
      `  <name>${escapeXmlText(target.name)}</name>`,
      `  <path>${escapeXmlText(target.relativePath)}</path>`,
      `  <extension>${escapeXmlAttribute(target.extension)}</extension>`,
      `  <size_bytes>${target.sizeBytes}</size_bytes>`,
      `  <added_at>${escapeXmlAttribute(target.addedAt)}</added_at>`,
      `  <vector_state>${target.vectorState === 'indexed' ? 'indexed' : 'pending'}</vector_state>`,
      `  <parent_chunks>${stats.parentChunks}</parent_chunks>`,
      `  <child_chunks>${stats.childChunks}</child_chunks>`,
      '</document_info>',
      `<retrieval_note>${escapeXmlText(stats.parentChunks === 0 && stats.childChunks === 0 ? '该文档尚未产出可检索块；检索与深读都不会命中。' : '深读请用 list_knowledge_chunks（document_id + ordinal）。')}</retrieval_note>`,
    ].join('\n');
    return { ok: true, observation, message: `已返回文档「${target.name}」元数据。` };
  }

  const total = documents.length;
  const listed = documents.slice(0, OVERVIEW_LIMIT);
  const libraryStats = readMaterialDocumentIndexStats(ctx.libraryPath);
  const lines: string[] = [`<document_overview library="${escapeXmlAttribute(ctx.libraryLabel)}" documents="${total}" parent_chunks="${libraryStats.parentChunks}" child_chunks="${libraryStats.childChunks}">`];
  for (const document of listed) {
    lines.push(`  <document document_id="${escapeXmlAttribute(document.id)}" name="${escapeXmlAttribute(document.name)}" extension="${escapeXmlAttribute(document.extension)}" vector_state="${document.vectorState === 'indexed' ? 'indexed' : 'pending'}" />`);
  }
  lines.push('</document_overview>');
  if (total > listed.length) {
    lines.push(`<retrieval_note>${escapeXmlText(`文档过多，仅列出前 ${OVERVIEW_LIMIT} 条；请用 knowledge_search / grep_chunks 直接按内容检索。`)}</retrieval_note>`);
  }
  return { ok: true, observation: lines.join('\n'), message: `已返回知识库文档概览（共 ${total} 篇）。` };
}
