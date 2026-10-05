import type { ReActTool, ReActToolExecution } from '../../knowledge/reactAgent/toolRegistry';
import { escapeXmlAttribute, escapeXmlText } from '../../knowledge/knowledgeToolContext';
import type { WikiToolContext } from '../wikiToolContext';
import { collectWikiChildNodes, findWikiNode, getWikiNodeBreadcrumb, isWikiRootNode } from '../wikiNodeScope';
import { WIKI_NODE_DIRECT_INJECT_CHARS } from '../wikiNodeBudget';

/**
 * wiki_get_node_info（方案 §4.3）：返回当前节点的元数据——面包屑路径、直接子节点
 * 标题清单、正文字符数与是否已被直载截断。不返回正文；需要正文用 wiki_read_node。
 * 帮助模型在检索前确认本章节的结构与规模，并为 wiki_read_node 提供合法的子节点 id。
 */
export const wikiGetNodeInfoTool: ReActTool<WikiToolContext> = {
  name: 'wiki_get_node_info',
  description: [
    '查询当前章节的元数据：面包屑路径、直接子章节标题清单、正文字符数与直载截断状态。',
    '适用：检索前确认本章节结构与规模，或获取可用 wiki_read_node 深读的子章节 node_id。',
    '本工具不返回正文内容；需要正文请用 wiki_read_node，需要按含义定位请用 wiki_node_search。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async (_args, ctx) => runWikiGetNodeInfo(ctx),
};

function runWikiGetNodeInfo(ctx: WikiToolContext): ReActToolExecution {
  const node = findWikiNode(ctx.outlineNodes, ctx.nodeId);
  if (!node) {
    return { ok: false, observation: `<tool_error>当前节点 ${escapeXmlText(ctx.nodeId)} 不在目录中。</tool_error>`, message: '当前节点不在目录中。' };
  }
  const breadcrumb = getWikiNodeBreadcrumb(ctx.outlineNodes, ctx.nodeId);
  const children = collectWikiChildNodes(ctx.outlineNodes, ctx.nodeId);
  const chars = (node.markdown ?? '').length;
  const isRoot = isWikiRootNode(node);
  const scopeState = ctx.scopeState;
  const scopeNote = isRoot
    ? '当前为文档根节点，检索范围覆盖整篇文档。'
    : `检索范围限定在本章节及其 ${children.length} 个直接子章节构成的子树内。`;

  const lines: string[] = [
    `<node_info node_id="${escapeXmlAttribute(node.id)}" title="${escapeXmlAttribute(node.title)}" chars="${chars}" truncated="${chars > WIKI_NODE_DIRECT_INJECT_CHARS}" depth="${node.depth}" scope_mode="${scopeState.mode}" retrieval_cycles="${scopeState.retrievalCycleCount}" max_retrieval_cycles="${scopeState.maxRetrievalCycles}" document_scope_entered="${scopeState.documentScopeEntered}" can_escalate="${ctx.scopePolicy.canEscalateToDocument()}">`,
    `  <path>${escapeXmlText(breadcrumb.join(' › '))}</path>`,
    `  <scope document_searches="${scopeState.documentSearchCount}" authorized_document_nodes="${scopeState.authorizedDocumentNodeIds.size}">${escapeXmlText(scopeNote)}</scope>`,
  ];
  if (children.length > 0) {
    lines.push(`  <children count="${children.length}">`);
    for (const child of children) {
      lines.push(`    <child node_id="${escapeXmlAttribute(child.id)}" title="${escapeXmlAttribute(child.title)}" chars="${(child.markdown ?? '').length}" />`);
    }
    lines.push('  </children>');
  } else {
    lines.push('  <children count="0" />');
  }
  lines.push('</node_info>');
  lines.push(`<retrieval_note>${escapeXmlText(chars > WIKI_NODE_DIRECT_INJECT_CHARS
    ? '本章节正文较长，直载内容已截断；如需完整原文，用 wiki_read_node 按 char_offset 翻页深读。'
    : '本章节正文已完整直载；如需核对原文措辞可直接引用，或用 wiki_node_search 定位具体片段。')}</retrieval_note>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `已返回章节「${node.title}」元数据（${children.length} 个子章节，${chars} 字符）。`,
  };
}
