import { runGraphGlobalSearch } from '../../pipeline/graphGlobalSearch';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { escapeXmlAttribute, escapeXmlText, type KnowledgeToolContext } from '../knowledgeToolContext';

const ENTITY_DESCRIPTION_LIMIT = 200;
const COMMUNITY_SUMMARY_LIMIT = 300;

export const graphGlobalSearchTool: ReActTool<KnowledgeToolContext> = {
  name: 'graph_global_search',
  description: [
    '基于知识图谱社区摘要做整库 map-reduce 综合：回答覆盖整个资料库的整体性问题。',
    '适用：整库概览、主题脉络、跨文档趋势与共性总结等没有具体实体锚点的问题。',
    '不适用：围绕具体实体/文档的问题用 graph_local_search 或 knowledge_search；字面量匹配用 grep_chunks。',
    'query 传一条完整的整体性问题；返回综合答案与参与社区列表。',
    '注意：答案来自社区摘要综合，参与社区只帮助理解全局，不能作为原文引用；需要出处时再用其他工具核实原文。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: 200,
        description: '一条完整的整库整体性问题',
      },
    },
    required: ['query'],
  },
  execute: async (args, ctx) => runGraphGlobalSearchTool(args, ctx),
};

async function runGraphGlobalSearchTool(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, observation: '<tool_error>graph_global_search 需要非空的 query。</tool_error>', message: '全局检索查询为空，已拒绝执行。' };
  }
  if (!ctx.graphGlobalSearch) {
    return {
      ok: true,
      observation: `<graph_global_search_results query="${escapeXmlAttribute(query)}">\n</graph_global_search_results>\n<retrieval_note>该资料库的图谱社区摘要尚未就绪，全局检索不可用；请改用 knowledge_search 或 graph_local_search。</retrieval_note>`,
      message: '图谱社区摘要未就绪，全局检索不可用。',
      referenceCount: 0,
    };
  }

  ctx.onStage?.(`知识库 Agent 正在做全局图谱综合「${query}」…`);
  const result = await runGraphGlobalSearch({
    libraryPath: ctx.libraryPath,
    query,
    signal: ctx.signal,
    callModel: ctx.graphGlobalSearch.callModel,
    onProgress: (phase, completed, total) => ctx.onStage?.(`知识库 Agent 全局图谱综合（${phase === 'map' ? 'map' : 'reduce'}）${completed}/${total}…`),
  });

  if (result.mode === 'unavailable' || result.mode === 'cost-guard') {
    return {
      ok: true,
      observation: `<graph_global_search_results query="${escapeXmlAttribute(query)}" mode="${result.mode}">\n</graph_global_search_results>\n<retrieval_note>${escapeXmlText(result.note)}</retrieval_note>`,
      message: result.mode === 'cost-guard' ? '全局检索触发成本护栏，未执行模型调用。' : '全局检索不可用。',
      referenceCount: 0,
    };
  }

  const lines: string[] = [
    `<graph_global_search_results query="${escapeXmlAttribute(query)}" mode="${result.mode}" level="${result.level}" llm_calls="${result.llmCalls}">`,
  ];
  if (result.mode === 'entity-overview') {
    lines.push('  <entity_overview note="小图降级：仅列出头部实体供把握全局，事实请回原文核实">');
    for (const entity of result.entities) {
      lines.push(
        `    <entity name="${escapeXmlAttribute(entity.mention)}" type="${escapeXmlAttribute(entity.type)}" degree="${entity.degree}">`
        + (entity.description ? `<description>${escapeXmlText(compactText(entity.description, ENTITY_DESCRIPTION_LIMIT))}</description>` : '')
        + '</entity>',
      );
    }
    lines.push('  </entity_overview>');
  } else {
    lines.push(`  <answer>\n${compactText(result.answer, 4000)}\n  </answer>`);
    lines.push('  <participating_communities note="社区摘要只用于理解全局，不能作为原文引用">');
    for (const community of result.communities) {
      lines.push(`    <community id="${escapeXmlAttribute(community.communityId)}" level="${community.level}" summary="${escapeXmlAttribute(compactText(community.summary, COMMUNITY_SUMMARY_LIMIT))}" />`);
    }
    lines.push('  </participating_communities>');
  }
  lines.push('</graph_global_search_results>');
  lines.push(`<retrieval_note>${escapeXmlText(result.note || '全局检索完成。')}</retrieval_note>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: result.mode === 'entity-overview'
      ? '图谱规模较小，已降级为实体概览模式。'
      : `全局检索完成：map ${result.mapChunks} 块，综合 ${result.partials.length} 条部分答案。`,
    referenceCount: 0,
  };
}

function compactText(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
