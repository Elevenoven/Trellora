import type { ReActTool, ReActToolExecution } from '../../knowledge/reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText } from '../../knowledge/knowledgeToolContext';
import type { WikiDocumentOutlineNode } from '../../wikiOutline';
import type { WikiToolContext } from '../wikiToolContext';
import {
  collectWikiSubtreeNodes,
  findWikiNode,
  formatWikiNodePath,
  getWikiNodeBreadcrumb,
  isWikiNodeDescendantOf,
} from '../wikiNodeScope';
import { WIKI_GREP_CONTEXT_CHARS, WIKI_GREP_MAX_MATCHES } from '../wikiNodeBudget';
import { renderKnowledgeBaseImageTransportIndex } from '../../knowledge/knowledgeBaseImageResolver';

/**
 * wiki_grep_node（方案 §4.5 规则 4）：在当前章节子树原文内做「字面」精确检索。
 *
 * 与 wiki_node_search 的分工：search 按含义做语义/关键词混合召回；grep 按字面子串
 * 精确匹配，专治编号、配置项、命令、专有名词与原文措辞的核对与定位。命中片段按
 * (节点, 偏移) 登记为证据并分配引用号，供终答标注；上下文不足时再用 wiki_read_node 深读。
 *
 * 证据来源为内存投影的 outlineNodes.markdown（无需向量索引），因此该工具始终可用。
 */
export const wikiGrepNodeTool: ReActTool<WikiToolContext> = {
  name: 'wiki_grep_node',
  description: [
    '在当前章节及其子章节的原文里做字面（精确文本）检索，定位编号、配置项、命令、专有名词或原文措辞的出现位置。',
    '与 wiki_node_search 的区别：wiki_node_search 按"含义"做语义检索；wiki_grep_node 按"字面字符串"精确匹配（不区分大小写、不支持正则、不做语义扩展）。',
    '适用：已知确切的关键词/编号/配置项名称，要找出它在原文哪里出现、上下文是什么；核对原文措辞是否如此表述。',
    '返回命中位置、所在章节、行号与上下文片段，并分配引用号 [n] 供终答标注。',
    '命中后若上下文不足以回答，用 wiki_read_node 深读对应章节原文。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        maxLength: 80,
        description: '要精确查找的字面字符串（编号、配置项、命令、原文措辞等），不区分大小写、按子串匹配',
      },
      node_id: {
        type: 'string',
        description: '可选：限定在某子章节内 grep（必须是当前章节或其子章节，来自 wiki_get_node_info 的子节点清单）；省略时在整个当前章节子树内查找',
      },
    },
    required: ['pattern'],
  },
  execute: async (args, ctx) => runWikiGrepNode(args, ctx),
};

interface GrepMatch {
  node: WikiDocumentOutlineNode;
  offset: number;
  line: number;
  snippet: string;
}

async function runWikiGrepNode(args: Record<string, unknown>, ctx: WikiToolContext): Promise<ReActToolExecution> {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) {
    return { ok: false, observation: '<tool_error>wiki_grep_node 需要非空 pattern。</tool_error>', message: 'grep 关键词为空，已拒绝执行。' };
  }

  const requestedId = typeof args.node_id === 'string' ? args.node_id.trim() : '';
  const scopeId = requestedId || ctx.nodeId;
  const scopeNode = findWikiNode(ctx.outlineNodes, scopeId);
  if (!scopeNode) {
    return { ok: false, observation: `<tool_error>节点 ${escapeXmlText(scopeId)} 不存在；请用 wiki_get_node_info 查看当前章节与子节点清单。</tool_error>`, message: `grep 目标节点不存在：${scopeId}。` };
  }
  if (!isWikiNodeDescendantOf(ctx.outlineNodes, scopeId, ctx.nodeId)) {
    return { ok: false, observation: '<tool_error>只能在当前章节或其子章节内 grep；该节点超出本章节作用域。</tool_error>', message: 'grep 目标超出当前章节作用域，已拒绝执行。' };
  }

  ctx.onStage?.(`Wiki Agent 正在本章节内字面检索「${pattern}」…`);
  const subtreeNodes = collectWikiSubtreeNodes(ctx.outlineNodes, scopeId);
  const needle = pattern.toLowerCase();
  const matches: GrepMatch[] = [];
  let capped = false;

  for (const targetNode of subtreeNodes) {
    if (ctx.signal.aborted) break;
    const markdown = targetNode.markdown ?? '';
    if (!markdown) continue;
    const haystack = markdown.toLowerCase();
    let from = 0;
    for (;;) {
      const offset = haystack.indexOf(needle, from);
      if (offset === -1) break;
      matches.push({
        node: targetNode,
        offset,
        line: countLines(markdown, offset),
        snippet: buildSnippet(markdown, offset, pattern.length),
      });
      from = offset + needle.length;
      if (matches.length >= WIKI_GREP_MAX_MATCHES) { capped = true; break; }
    }
    if (capped || ctx.signal.aborted) break;
  }

  const scopeLabel = scopeId === ctx.nodeId ? '本章节子树' : `「${scopeNode.title}」子树`;
  if (matches.length === 0) {
    return {
      ok: true,
      observation: `<grep_results pattern="${escapeXmlAttribute(pattern)}" scope="${escapeXmlAttribute(scopeNode.title)}" matches="0">\n</grep_results>\n<retrieval_note>${escapeXmlText(`${scopeLabel}内未字面命中「${pattern}」。可能原文措辞不同（改用 wiki_node_search 按含义检索），或本章节确实没有该内容。`)}</retrieval_note>`,
      message: `字面检索未命中：${pattern}。`,
      referenceCount: 0,
    };
  }

  const lines: string[] = [`<grep_results pattern="${escapeXmlAttribute(pattern)}" scope="${escapeXmlAttribute(scopeNode.title)}" matches="${matches.length}">`];
  const rawEvidence = matches.map((match) => ({ documentId: ctx.documentId, text: match.snippet, sourceText: match.snippet }));
  const visuals = ctx.resolveEvidenceVisuals?.(rawEvidence) ?? { evidence: rawEvidence, images: [], mappings: [] };
  let freshCount = 0;
  for (const [index, match] of matches.entries()) {
    const resolvedSnippet = visuals.evidence[index]!.text;
    const evidenceKey = `wiki-grep:${match.node.id}:${match.offset}`;
    const { reference, alreadySeen } = ctx.session.registerEvidence({
      documentId: ctx.documentId,
      documentName: ctx.documentName,
      parentChunkId: evidenceKey,
      ordinal: 0,
      text: resolvedSnippet,
      sourceText: match.snippet,
      sectionContext: toSectionContext(
        formatWikiNodePath(getWikiNodeBreadcrumb(ctx.outlineNodes, match.node.id)),
        match.node.title,
      ),
    });
    if (!alreadySeen) freshCount += 1;
    lines.push(
      `  <match reference="${reference}" node="${escapeXmlAttribute(match.node.title)}" line="${match.line}"${alreadySeen ? ' seen="true"' : ''}>\n`
      + `    <content>${compactObservationText(resolvedSnippet)}</content>\n`
      + '  </match>',
    );
  }
  lines.push('</grep_results>');

  const notes: string[] = [`${scopeLabel}内字面命中「${pattern}」${matches.length} 处（新 ${freshCount} 条）；引用号用于终答标注。`];
  if (capped) notes.push(`命中已达上限 ${WIKI_GREP_MAX_MATCHES} 处，可能还有更多；可缩小 node_id 范围或用更精确的 pattern。`);
  notes.push('若命中上下文不足以回答，用 wiki_read_node 深读对应章节原文核对。');
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `字面检索「${pattern}」命中 ${matches.length} 处（新 ${freshCount} 条）${capped ? '，已达上限' : ''}。`,
    referenceCount: freshCount,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}

function toSectionContext(nodePath: string, nodeTitle: string): string {
  return nodePath && nodePath !== nodeTitle
    ? `章节路径：${nodePath.replace(/ › /gu, ' / ')}\n章节：${nodeTitle}`
    : `章节：${nodeTitle}`;
}

/** 命中位置所在行号（1 起）：统计 offset 之前的换行数。 */
function countLines(markdown: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/** 命中片段：以命中位置为中心取前后各 WIKI_GREP_CONTEXT_CHARS 字符，越界处标注省略号。 */
function buildSnippet(markdown: string, offset: number, patternLength: number): string {
  const start = Math.max(0, offset - WIKI_GREP_CONTEXT_CHARS);
  const end = Math.min(markdown.length, offset + patternLength + WIKI_GREP_CONTEXT_CHARS);
  const body = markdown.slice(start, end).trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < markdown.length ? '…' : '';
  return `${prefix}${body}${suffix}`;
}
