import { readMaterialParentWindow } from '../../pipeline/materialChunkSearch';
import { findMaterialsDocument } from '../../materialsLibrary';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, toBoundedPublicToolResultText, type KnowledgeToolContext } from '../knowledgeToolContext';
import { renderKnowledgeBaseImageTransportIndex } from '../knowledgeBaseImageResolver';
import type { AssistantPublicToolResultView } from '../assistantTurnTypes';

const DEFAULT_WINDOW = 1;
const MAX_WINDOW = 5;

export const listKnowledgeChunksTool: ReActTool<KnowledgeToolContext> = {
  name: 'list_knowledge_chunks',
  description: [
    '深读原文：按 document_id + ordinal 展开目标父块及其前后相邻父块的完整正文。',
    '适用：knowledge_search / grep_chunks 命中的块位于段落边缘、信息不完整，',
    '或需要理解上下文、核对原文措辞时。不要只凭检索摘要下结论。',
    'document_id 与 ordinal 必须来自此前工具返回的检索结果，不要编造。',
    'window 为向前后各展开的块数（1–5，默认 1）；窗口过大会占用证据预算。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      document_id: { type: 'string', description: '目标文档 id（来自检索结果）' },
      ordinal: { type: 'number', description: '锚点父块序号（来自检索结果的 ordinal）' },
      window: { type: 'number', description: '可选：向前后各展开块数（1–5，默认 1）' },
    },
    required: ['document_id', 'ordinal'],
  },
  execute: async (args, ctx) => runListKnowledgeChunks(args, ctx),
};

async function runListKnowledgeChunks(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
  const ordinal = typeof args.ordinal === 'number' && Number.isFinite(args.ordinal) ? Math.max(0, Math.floor(args.ordinal)) : Number.NaN;
  const window = typeof args.window === 'number' && Number.isFinite(args.window)
    ? Math.max(0, Math.min(Math.floor(args.window), MAX_WINDOW))
    : DEFAULT_WINDOW;
  if (!documentId || Number.isNaN(ordinal)) {
    return { ok: false, observation: '<tool_error>list_knowledge_chunks 需要有效的 document_id（字符串）与 ordinal（数字）。</tool_error>', message: '深读参数无效，已拒绝执行。' };
  }

  const document = findMaterialsDocument(ctx.libraryPath, documentId);
  if (!document) {
    return { ok: false, observation: `<tool_error>文档 ${escapeXmlText(documentId)} 不存在；请改用 get_document_info 查看可用文档。</tool_error>`, message: `深读目标文档不存在：${documentId}。` };
  }

  const windowKey = ctx.session.seenWindowKey(documentId, ordinal, window);
  if (ctx.session.isWindowSeen(windowKey)) {
    return {
      ok: true,
      observation: `<deep_read document_id="${escapeXmlAttribute(documentId)}" ordinal="${ordinal}" window="${window}">\n</deep_read>\n<retrieval_note>该窗口在本会话已展开过，结果见上；如需更大范围请增大 window 或移动 ordinal。</retrieval_note>`,
      message: '深读窗口重复，已提示复用此前结果。',
      referenceCount: 0,
    };
  }

  ctx.onStage?.(`知识库 Agent 正在深读「${document.name}」第 ${ordinal} 块附近…`);
  const records = readMaterialParentWindow({ libraryPath: ctx.libraryPath, documentId, ordinal, window });
  ctx.session.markWindowSeen(windowKey);
  if (records.length === 0) {
    return {
      ok: true,
      observation: `<deep_read document_id="${escapeXmlAttribute(documentId)}" ordinal="${ordinal}" window="${window}">\n</deep_read>\n<retrieval_note>该文档在指定位置没有可读块（可能尚未完成解析/切块）。可用 get_document_info 确认状态。</retrieval_note>`,
      message: `深读未取到内容：${document.name} 第 ${ordinal} 块。`,
      referenceCount: 0,
    };
  }

  const visuals = ctx.resolveEvidenceVisuals?.(records.map((record) => ({ ...record, documentId })))
    ?? { evidence: records.map((record) => ({ ...record, documentId })), images: [], mappings: [] };
  const lines: string[] = [`<deep_read document="${escapeXmlAttribute(document.name)}" document_id="${escapeXmlAttribute(documentId)}" anchor_ordinal="${ordinal}" window="${window}">`];
  const publicResults: AssistantPublicToolResultView[] = [];
  let freshCount = 0;
  for (const record of visuals.evidence) {
    const { reference, alreadySeen } = ctx.session.registerEvidence({
      documentId,
      documentName: document.name,
      parentChunkId: record.parentChunkId,
      ordinal: record.ordinal,
      text: record.text,
      sourceText: record.sourceText,
    });
    publicResults.push({
      reference,
      title: document.name,
      location: `父块 ${record.ordinal}`,
      seen: alreadySeen,
      ...(!alreadySeen ? { excerpt: toBoundedPublicToolResultText(record.text) } : {}),
    });
    if (alreadySeen) {
      lines.push(`  <chunk ordinal="${record.ordinal}" reference="${reference}" seen="true" />`);
      continue;
    }
    freshCount += 1;
    lines.push(
      `  <chunk ordinal="${record.ordinal}" reference="${reference}">\n`
      + `    <content>${compactObservationText(record.text)}</content>\n`
      + '  </chunk>',
    );
  }
  lines.push('</deep_read>');
  lines.push(`<retrieval_note>${escapeXmlText(`已展开 ${records.length} 个父块（新 ${freshCount} 条）。引用号用于终答标注；证据足以回答时请直接输出终答。`)}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `深读「${document.name}」展开 ${records.length} 块（新 ${freshCount} 条）。`,
    referenceCount: freshCount,
    publicResults,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}
