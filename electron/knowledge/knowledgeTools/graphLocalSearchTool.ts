import { runGraphLocalSearch, type GraphLocalSearchEvidence } from '../../pipeline/graphLocalSearch';
import type { ReActTool, ReActToolExecution } from '../reactAgent/toolRegistry';
import { compactObservationText, escapeXmlAttribute, escapeXmlText, type KnowledgeToolContext } from '../knowledgeToolContext';
import type { KnowledgeEvidenceRecord } from './knowledgeSessionState';
import { renderKnowledgeBaseImageTransportIndex } from '../knowledgeBaseImageResolver';

const ENTITY_DESCRIPTION_LIMIT = 400;
const RELATION_DESCRIPTION_LIMIT = 200;
/** 语义种子通道问题 embedding 超时（优化方案 P1-4）：失败静默回退词法种子。 */
const GRAPH_SEED_EMBED_TIMEOUT_MS = 15_000;

export const graphLocalSearchTool: ReActTool<KnowledgeToolContext> = {
  name: 'graph_local_search',
  description: [
    '沿知识图谱做实体关系检索：从查询定位实体锚点，按 max_hops 扩展相关实体与关系，并返回原始 Chunk 证据。',
    '适用：围绕人/组织/概念等实体的关系问题——谁与谁相关、事物之间的关联脉络、概念之间的连接。',
    '不适用：按含义的普通内容检索用 knowledge_search；字面量精确匹配用 grep_chunks。',
    'query 传一条完整问题；entities 必须由你从 query 中提取 1–5 个实体名称或常用别名，不要填写泛化的问题词。',
    'max_hops 必须由你根据问题选择 1 或 2：直接关系选 1，间接关系、影响链、依赖链或上下游链路选 2，不确定时先选 1，证据不足可再用 2。',
    '返回实体、关系描述与带引用号 [n] 的证据块。',
    '实体描述与社区信息只是线索，事实结论必须以证据块原文为准。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: 120,
        description: '一条完整的实体关系问题',
      },
      entities: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        description: '从 query 提取的 1–5 个实体名称或常用别名，例如 ["Electron", "孟汉"]；不要放“关系”“影响”等问题词。',
      },
      max_hops: {
        type: 'integer',
        enum: [1, 2],
        description: '图谱最大遍历跳数，只能选 1 或 2。直接关系选 1；间接关系、影响链、依赖链或上下游链路选 2；不确定时先选 1，证据不足可再用 2。',
      },
    },
    required: ['query', 'entities', 'max_hops'],
    additionalProperties: false,
  },
  execute: async (args, ctx) => runGraphLocalSearchTool(args, ctx),
};

async function runGraphLocalSearchTool(args: Record<string, unknown>, ctx: KnowledgeToolContext): Promise<ReActToolExecution> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, observation: '<tool_error>graph_local_search 需要非空的 query。</tool_error>', message: '图谱检索查询为空，已拒绝执行。' };
  }
  const maxHops = args.max_hops;
  if (maxHops !== 1 && maxHops !== 2) {
    return {
      ok: false,
      observation: '<tool_error>graph_local_search 的 max_hops 只能是整数 1 或 2。</tool_error>',
      message: '图谱检索跳数无效，只能选择 1 或 2。',
    };
  }
  const entities = normalizeQueryEntities(args.entities);
  if (!entities) {
    return {
      ok: false,
      observation: '<tool_error>graph_local_search 的 entities 必须是包含 1 到 5 个非空实体名称的字符串数组。</tool_error>',
      message: '图谱检索实体参数无效，请提供 1 到 5 个实体名称。',
    };
  }

  ctx.onStage?.(`知识库 Agent 正在从实体「${entities.join('、')}」沿图谱检索（最多 ${maxHops} 跳）…`);
  // 实体锚点由 Agent 直接给出；这里只准备路径和向量依赖，不再调用程序侧分词器。
  const searchContext = await ctx.prepareQueryContext(query, { tokenize: false });
  // 语义种子（优化方案 P1-4）：用锁定的 embedding 适配器自算问题 embedding，
  // 供实体向量近邻补充锚点；失败静默回退纯词法种子。
  let queryEmbedding: number[] | undefined;
  if (searchContext.adapter && searchContext.embeddingProfile) {
    try {
      const embedResult = await searchContext.adapter.embedBatch({
        profile: searchContext.embeddingProfile,
        texts: [query],
        timeoutMs: GRAPH_SEED_EMBED_TIMEOUT_MS,
        signal: ctx.signal,
      });
      const vector = embedResult.vectors[0];
      if (Array.isArray(vector) && vector.length > 0 && vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        queryEmbedding = vector;
      }
    } catch {
      queryEmbedding = undefined;
    }
  }
  const result = runGraphLocalSearch({
    libraryPath: searchContext.targetPath,
    query,
    maxHops,
    queryTerms: entities,
    ...(queryEmbedding ? { queryEmbedding, queryProfileHash: searchContext.embeddingProfile?.profileHash } : {}),
  });
  if (!result) {
    return {
      ok: true,
      observation: `<graph_search_results query="${escapeXmlAttribute(query)}" query_entities="${escapeXmlAttribute(entities.join('|'))}" max_hops="${maxHops}">\n</graph_search_results>\n<retrieval_note>该资料库尚未建立知识图谱投影，图谱检索不可用；请改用 knowledge_search 或 grep_chunks。</retrieval_note>`,
      message: '知识图谱投影不存在，图谱检索不可用。',
      referenceCount: 0,
    };
  }
  if (result.seeds.length === 0) {
    return {
      ok: true,
      observation: `<graph_search_results query="${escapeXmlAttribute(query)}" query_entities="${escapeXmlAttribute(entities.join('|'))}" max_hops="${maxHops}">\n</graph_search_results>\n<retrieval_note>图谱中未命中「${escapeXmlText(entities.join('、'))}」相关实体；可更换实体写法，或改用 knowledge_search / grep_chunks。</retrieval_note>`,
      message: `图谱未命中「${query}」相关实体。`,
      referenceCount: 0,
    };
  }

  const lines: string[] = [`<graph_search_results query="${escapeXmlAttribute(query)}" query_entities="${escapeXmlAttribute(entities.join('|'))}" max_hops="${maxHops}" nodes="${result.traversedNodes}" edges="${result.traversedEdges}">`];
  lines.push('  <entities>');
  for (const entity of result.entities) {
    const seedAttribute = entity.hop === 0 ? ' seed="true"' : '';
    lines.push(
      `    <entity name="${escapeXmlAttribute(entity.mention)}" type="${escapeXmlAttribute(entity.type)}" hop="${entity.hop}"${seedAttribute}>`
      + (entity.description ? `<description>${escapeXmlText(compactDescription(entity.description, ENTITY_DESCRIPTION_LIMIT))}</description>` : '')
      + '</entity>',
    );
  }
  lines.push('  </entities>');
  lines.push('  <relations>');
  for (const relation of result.relations) {
    lines.push(
      `    <relation source="${escapeXmlAttribute(relation.sourceKey)}" target="${escapeXmlAttribute(relation.targetKey)}" weight="${relation.weight}" kinds="${escapeXmlAttribute(relation.kinds.join('|'))}">`
      + (relation.description ? `<description>${escapeXmlText(compactDescription(relation.description, RELATION_DESCRIPTION_LIMIT))}</description>` : '')
      + '</relation>',
    );
  }
  lines.push('  </relations>');

  let freshCount = 0;
  const seenRefs: string[] = [];
  const rawRecords = result.evidence.map((evidence) => toEvidenceRecord(evidence, ctx));
  const visuals = ctx.resolveEvidenceVisuals?.(rawRecords) ?? { evidence: rawRecords, images: [], mappings: [] };
  lines.push('  <evidence>');
  for (const [index, evidence] of result.evidence.entries()) {
    const record = visuals.evidence[index]!;
    const documentName = record.documentName ?? evidence.documentId;
    const { reference, alreadySeen } = ctx.session.registerEvidence(record);
    if (alreadySeen) {
      seenRefs.push(reference);
      lines.push(`    <chunk reference="${reference}" document_id="${escapeXmlAttribute(evidence.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${evidence.ordinal}" seen="true" />`);
      continue;
    }
    freshCount += 1;
    lines.push(
      `    <chunk reference="${reference}" document_id="${escapeXmlAttribute(evidence.documentId)}" document="${escapeXmlAttribute(documentName)}" ordinal="${evidence.ordinal}"${evidence.sectionContext ? ` section="${escapeXmlAttribute(evidence.sectionContext)}"` : ''}>\n`
      + `      <content>${compactObservationText(record.text)}</content>\n`
      + '    </chunk>',
    );
  }
  lines.push('  </evidence>');

  if (result.communities.length > 0) {
    lines.push('  <community_hints note="仅用于判断检索方向，不作为事实证据">');
    for (const community of result.communities) {
      lines.push(`    <community id="${escapeXmlAttribute(community.communityId)}" level="${community.level}"${community.summary ? ` summary="${escapeXmlAttribute(compactDescription(community.summary, RELATION_DESCRIPTION_LIMIT))}"` : ''} members="${escapeXmlAttribute(community.topMembers.join('、'))}" />`);
    }
    lines.push('  </community_hints>');
  }
  lines.push('</graph_search_results>');

  const notes: string[] = [`本次按 Agent 提供的实体「${entities.join('、')}」检索，并选择最多 ${maxHops} 跳。图谱命中 ${result.seeds.length} 个锚点实体，遍历 ${result.traversedNodes} 节点、${result.traversedEdges} 边，证据 ${result.evidence.length} 块（新 ${freshCount} 条）。`];
  if (result.vectorSeedKeys.length > 0) notes.push(`其中 ${result.vectorSeedKeys.length} 个锚点来自语义向量近邻（非字面命中），结论前请用证据块核实。`);
  if (seenRefs.length > 0) notes.push(`其中 ${seenRefs.join('、')} 在本会话已见过。`);
  if (result.evidence.length === 0) notes.push('图谱命中实体但无对应原文块，请改用 knowledge_search 或 grep_chunks 核实。');
  lines.push(`<retrieval_note>${escapeXmlText(notes.join(' '))}</retrieval_note>`);
  const visualIndex = renderKnowledgeBaseImageTransportIndex(visuals.mappings);
  if (visualIndex) lines.push(`<visual_inputs>${escapeXmlText(visualIndex)}</visual_inputs>`);

  return {
    ok: true,
    observation: lines.join('\n'),
    message: `图谱检索（最多 ${maxHops} 跳）命中 ${result.seeds.length} 个锚点实体，证据 ${result.evidence.length} 块（新 ${freshCount} 条）。`,
    referenceCount: freshCount,
    ...(visuals.images.length ? { images: visuals.images } : {}),
  };
}

/** 证据优先回父块（与 grep_chunks 口径一致）；无父块时以命中块本身登记。 */
function toEvidenceRecord(evidence: GraphLocalSearchEvidence, ctx: KnowledgeToolContext): KnowledgeEvidenceRecord {
  return {
    documentId: evidence.documentId,
    documentName: ctx.documentNameById(evidence.documentId),
    parentChunkId: evidence.parentChunkId ?? evidence.chunkId,
    ordinal: evidence.ordinal,
    text: evidence.text,
    sourceText: evidence.sourceText,
    sectionContext: evidence.sectionContext || undefined,
  };
}

function compactDescription(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function normalizeQueryEntities(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
  const entities: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const entity = item.trim();
    if (!entity || entity.length > 64) return undefined;
    if (!entities.includes(entity)) entities.push(entity);
  }
  return entities.length > 0 ? entities : undefined;
}
