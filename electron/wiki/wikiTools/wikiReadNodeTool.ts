import type { ReActTool, ReActToolExecution } from '../../knowledge/reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText } from '../../knowledge/knowledgeToolContext';
import type { WikiToolContext } from '../wikiToolContext';
import { findWikiNode, formatWikiNodePath, getWikiNodeBreadcrumb, isWikiNodeDescendantOf } from '../wikiNodeScope';
import { WIKI_NODE_READ_WINDOW_CHARS } from '../wikiNodeBudget';
import { renderKnowledgeBaseImageTransportIndex } from '../../knowledge/knowledgeBaseImageResolver';

/**
 * wiki_read_node（方案 §4.3）：深读节点 markdown（默认当前节点，允许其子节点）。
 *
 * 节点 markdown 已由 readWikiDocumentOutline 投影到内存（outlineNodes），本工具直接
 * 按字符窗切片返回，单窗 ≤ WIKI_NODE_READ_WINDOW_CHARS；超长时标注下一窗偏移，供模型翻页。
 * 读到的窗口按 (节点, 偏移) 登记为证据并分配引用号，重复读同一窗口时提示复用。
 */
export const wikiReadNodeTool: ReActTool<WikiToolContext> = {
  name: 'wiki_read_node',
  description: [
    '深读章节原文：返回指定节点的 markdown 正文（默认当前章节，允许读取其子章节，以及跨章节检索刚刚命中的同文档节点）。',
    '适用：wiki_node_search 命中的片段信息不完整、位于段落边缘，或需要核对原文措辞、通读本章节时。',
    '不要只凭检索摘要下结论。node_id 省略时读当前章节；跨章节 node_id 只能使用 wiki_search_document 结果返回并授权的 source_node_id。',
    `单次最多返回 ${WIKI_NODE_READ_WINDOW_CHARS} 个字符；章节更长时会标注 next_offset，可带 char_offset 翻页继续读。`,
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      node_id: { type: 'string', description: '可选：当前章节/子章节 node_id，或 wiki_search_document 返回的 source_node_id；省略时读当前章节' },
      char_offset: { type: 'number', description: '可选：从该字符偏移开始读取（用于翻下一页），默认 0' },
    },
  },
  execute: async (args, ctx) => runWikiReadNode(args, ctx),
};

async function runWikiReadNode(args: Record<string, unknown>, ctx: WikiToolContext): Promise<ReActToolExecution> {
  const requestedId = typeof args.node_id === 'string' ? args.node_id.trim() : '';
  const nodeId = requestedId || ctx.nodeId;
  const charOffset = typeof args.char_offset === 'number' && Number.isFinite(args.char_offset)
    ? Math.max(0, Math.floor(args.char_offset))
    : 0;

  const node = findWikiNode(ctx.outlineNodes, nodeId);
  if (!node) {
    return { ok: false, observation: `<tool_error>节点 ${escapeXmlText(nodeId)} 不存在；请用 wiki_get_node_info 查看当前章节与子节点清单。</tool_error>`, message: `深读目标节点不存在：${nodeId}。` };
  }
  const withinLocalSubtree = isWikiNodeDescendantOf(ctx.outlineNodes, nodeId, ctx.nodeId);
  const authorizedByDocumentSearch = ctx.scopeState.authorizedDocumentNodeIds.has(nodeId);
  if (!withinLocalSubtree && !authorizedByDocumentSearch) {
    return { ok: false, observation: '<tool_error>该节点既不属于当前章节子树，也不是本轮跨章节检索已授权的同文档节点。</tool_error>', message: '深读目标超出当前章节作用域且未经跨章节检索授权，已拒绝执行。' };
  }

  const markdown = node.markdown ?? '';
  if (charOffset >= markdown.length) {
    return {
      ok: true,
      observation: `<node_read node_id="${escapeXmlAttribute(nodeId)}" title="${escapeXmlAttribute(node.title)}" char_offset="${charOffset}">\n</node_read>\n<retrieval_note>偏移 ${charOffset} 已超出本章节正文长度（共 ${markdown.length} 字符），没有更多内容可读。</retrieval_note>`,
      message: `深读偏移超出章节长度：${node.title}。`,
      referenceCount: 0,
    };
  }

  const rawWindowText = markdown.slice(charOffset, charOffset + WIKI_NODE_READ_WINDOW_CHARS);
  const visuals = ctx.resolveEvidenceVisuals?.([{ documentId: ctx.documentId, text: rawWindowText, sourceText: rawWindowText }])
    ?? { evidence: [{ documentId: ctx.documentId, text: rawWindowText, sourceText: rawWindowText }], images: [], mappings: [] };
  const windowText = visuals.evidence[0]!.text;
  const nextOffset = charOffset + rawWindowText.length;
  const truncated = nextOffset < markdown.length;

  const evidenceKey = `wiki-node:${nodeId}:${charOffset}`;
  const { reference, alreadySeen } = ctx.session.registerEvidence({
    documentId: ctx.documentId,
    documentName: ctx.documentName,
    parentChunkId: evidenceKey,
    ordinal: 0,
    text: windowText,
    sourceText: rawWindowText,
    sectionContext: toSectionContext(formatWikiNodePath(getWikiNodeBreadcrumb(ctx.outlineNodes, nodeId)), node.title),
  });
  if (withinLocalSubtree) ctx.scopeState.localDeepReadCompleted = true;

  const lines: string[] = [
    `<node_read node_id="${escapeXmlAttribute(nodeId)}" title="${escapeXmlAttribute(node.title)}" reference="${reference}" char_offset="${charOffset}" chars="${windowText.length}" total_chars="${markdown.length}"${truncated ? ` next_offset="${nextOffset}"` : ''}${alreadySeen ? ' seen="true"' : ''}>`,
  ];
  if (alreadySeen) {
    lines.push('</node_read>');
    lines.push(`<retrieval_note>${escapeXmlText('该章节窗口在本会话已读过，结果见上；如需继续请增大 char_offset 翻页。')}</retrieval_note>`);
    return { ok: true, observation: lines.join('\n'), message: `深读窗口重复：${node.title}。`, referenceCount: 0 };
  }
  lines.push(`  <content>${compactObservationText(windowText)}</content>`);
  lines.push('</node_read>');
  const notes: string[] = [`已深读「${node.title}」${windowText.length} 字符，引用号 ${reference} 用于终答标注。`];
  if (truncated) notes.push(`本章节共 ${markdown.length} 字符，尚未读完；如需后续内容，带 char_offset=${nextOffset} 再次调用。`);
  notes.push('证据足以回答时请直接输出终答，不要为凑轮数重复深读。');
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `深读「${node.title}」返回 ${windowText.length} 字符${truncated ? '（已截断，可翻页）' : ''}。`,
    referenceCount: 1,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}

function toSectionContext(nodePath: string, nodeTitle: string): string {
  return nodePath && nodePath !== nodeTitle
    ? `章节路径：${nodePath.replace(/ › /gu, ' / ')}\n章节：${nodeTitle}`
    : `章节：${nodeTitle}`;
}
