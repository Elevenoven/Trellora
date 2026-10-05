import type {
  LibraryGraphVisualizationCommunity,
  LibraryGraphVisualizationCommunityEdge,
  LibraryGraphVisualizationEdge,
  LibraryGraphVisualizationEntity,
  LibraryGraphVisualizationPayload,
} from '../electron';

/**
 * 地图视图纯函数（方案 §5）：层级聚合、钻取、筛选与确定性着色。
 * 不含 DOM/cytoscape 依赖，便于脚本单测（scripts/verify-library-graph-map-view.mjs）。
 */

export type LibraryGraphViewMode = 'community' | 'entity';

export interface LibraryGraphViewNode {
  id: string;
  kind: 'entity' | 'community';
  label: string;
  size: number;
  color: string;
  /** 实体键或社区 id（详情抽屉回查用）。 */
  ref: string;
  level?: number;
  memberCount?: number;
}

export interface LibraryGraphViewEdge {
  id: string;
  source: string;
  target: string;
  width: number;
  kind: 'relation' | 'community' | 'hierarchy';
  label?: string;
}

export interface LibraryGraphViewElements {
  nodes: LibraryGraphViewNode[];
  edges: LibraryGraphViewEdge[];
}

/** 确定性调色板：按字符串哈希取色，同一社区/实体在会话间颜色稳定。 */
const GRAPH_VIEW_PALETTE = ['#5b8fba', '#438f70', '#b98532', '#9180b6', '#bd786b', '#479ca0', '#b680a0', '#7e91a3', '#a38a56', '#729657'];

export function hashPaletteColor(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return GRAPH_VIEW_PALETTE[hash % GRAPH_VIEW_PALETTE.length];
}

/** 实体节点尺寸 ∝ degree（8~34px 区间，平方根收缩避免头部实体过大）。 */
export function entityNodeSize(degree: number): number {
  return Math.round(8 + Math.min(26, Math.sqrt(Math.max(0, degree)) * 6));
}

/** 社区节点尺寸 ∝ 成员数（18~60px）。 */
export function communityNodeSize(memberCount: number): number {
  return Math.round(18 + Math.min(42, Math.sqrt(Math.max(0, memberCount)) * 5));
}

/** 边宽 ∝ weight（1~6px）。 */
export function relationEdgeWidth(weight: number): number {
  return Math.max(1, Math.min(6, 0.8 + Math.sqrt(Math.max(1, weight)) * 0.9));
}

/** 实体视图筛选：社区钻取时归属字段与成员清单双路径并取（子社区成员归属字段存的是 level0 id）。 */
export interface EntityViewFilter {
  communityId?: string | null;
  memberKeys?: ReadonlySet<string>;
}

/** 实体视图元素：可选社区钻取（只画该社区成员）与焦点实体（邻居高亮由前端选中完成）。 */
export function createEntityViewElements(payload: LibraryGraphVisualizationPayload, options?: EntityViewFilter): LibraryGraphViewElements {
  const filter = options;
  const entities = filter?.communityId || filter?.memberKeys
    ? payload.entities.filter((entity) =>
      (filter.communityId ? entity.communityId === filter.communityId : false)
      || (filter.memberKeys ? filter.memberKeys.has(entity.canonicalKey) : false))
    : payload.entities;
  const retained = new Set(entities.map((entity) => entity.canonicalKey));
  const nodes: LibraryGraphViewNode[] = entities.map((entity) => ({
    id: entityNodeId(entity.canonicalKey),
    kind: 'entity',
    label: entity.mention || entity.canonicalKey,
    size: entityNodeSize(entity.degree),
    color: hashPaletteColor(entity.communityId || '无社区'),
    ref: entity.canonicalKey,
  }));
  const edges: LibraryGraphViewEdge[] = payload.edges
    .filter((edge) => retained.has(edge.sourceKey) && retained.has(edge.targetKey))
    .map((edge) => ({
      id: edgeId(edge),
      source: entityNodeId(edge.sourceKey),
      target: entityNodeId(edge.targetKey),
      width: relationEdgeWidth(edge.weight),
      kind: 'relation',
      label: edge.kinds[0],
    }));
  return { nodes, edges };
}

/** 社区视图元素：社区节点（与实体视图同风格圆点，层级由父子虚线边表达）+ 聚合边 + level1→level0 父子层级边。 */
export function createCommunityViewElements(payload: LibraryGraphVisualizationPayload): LibraryGraphViewElements {
  const mentionByKey = new Map(payload.entities.map((entity) => [entity.canonicalKey, entity.mention]));
  const nodes: LibraryGraphViewNode[] = payload.communities.map((community) => ({
    id: communityNodeId(community.communityId),
    kind: 'community',
    label: communityShortLabel(community, mentionByKey.get(community.memberKeys[0] ?? '') || undefined),
    size: communityNodeSize(community.memberCount),
    color: hashPaletteColor(community.communityId),
    ref: community.communityId,
    level: community.level,
    memberCount: community.memberCount,
  }));
  const communityIds = new Set(payload.communities.map((community) => community.communityId));
  const edges: LibraryGraphViewEdge[] = [];
  for (const edge of payload.communityEdges) {
    if (!communityIds.has(edge.sourceCommunityId) || !communityIds.has(edge.targetCommunityId)) continue;
    edges.push({
      id: `community:${edge.sourceCommunityId}->${edge.targetCommunityId}`,
      source: communityNodeId(edge.sourceCommunityId),
      target: communityNodeId(edge.targetCommunityId),
      width: relationEdgeWidth(edge.weight),
      kind: 'community',
      label: `${edge.edgeCount} 条`,
    });
  }
  for (const community of payload.communities) {
    if (!community.parentId || !communityIds.has(community.parentId)) continue;
    edges.push({
      id: `hierarchy:${community.communityId}->${community.parentId}`,
      source: communityNodeId(community.communityId),
      target: communityNodeId(community.parentId),
      width: 1,
      kind: 'hierarchy',
    });
  }
  return { nodes, edges };
}

/** 钻取：社区的成员实体子图（实体视图以社区过滤的便捷入口）；成员以 memberKeys 为准，归属字段作兜底。 */
export function buildCommunityDrillDown(payload: LibraryGraphVisualizationPayload, communityId: string): LibraryGraphViewElements {
  const community = findCommunity(payload, communityId);
  if (!community) return { nodes: [], edges: [] };
  return createEntityViewElements(payload, { communityId, memberKeys: new Set(community.memberKeys) });
}

/**
 * 文档筛选（地图视图左侧多选面板）：空集合 = 不筛选原样返回；
 * 否则只保留 docIds 命中选中文档的实体，社区按可见成员重算成员数并剔除空社区，
 * 社区间聚合边在可见实体/可见边上重新聚合，保证社区视图与实体视图口径一致。
 */
export function applyDocumentFilter(payload: LibraryGraphVisualizationPayload, docIds: ReadonlySet<string>): LibraryGraphVisualizationPayload {
  if (docIds.size === 0) return payload;
  const entities = payload.entities.filter((entity) => entity.docIds.some((docId) => docIds.has(docId)));
  const retained = new Set(entities.map((entity) => entity.canonicalKey));
  const edges = payload.edges.filter((edge) => retained.has(edge.sourceKey) && retained.has(edge.targetKey));
  const communities = payload.communities
    .map((community) => {
      const memberKeys = community.memberKeys.filter((key) => retained.has(key));
      return { ...community, memberKeys, memberCount: memberKeys.length };
    })
    .filter((community) => community.memberKeys.length > 0);
  const communityIds = new Set(communities.map((community) => community.communityId));
  const communityByKey = new Map(entities.map((entity) => [entity.canonicalKey, entity.communityId]));
  const aggregated = new Map<string, LibraryGraphVisualizationCommunityEdge>();
  for (const edge of edges) {
    const source = communityByKey.get(edge.sourceKey) ?? '';
    const target = communityByKey.get(edge.targetKey) ?? '';
    if (!source || !target || source === target) continue;
    const aggregateKey = `${source}\u0000${target}`;
    const existing = aggregated.get(aggregateKey);
    if (existing) {
      existing.weight += edge.weight;
      existing.edgeCount += 1;
    } else {
      aggregated.set(aggregateKey, { sourceCommunityId: source, targetCommunityId: target, weight: edge.weight, edgeCount: 1 });
    }
  }
  const communityEdges = [...aggregated.values()]
    .filter((edge) => communityIds.has(edge.sourceCommunityId) && communityIds.has(edge.targetCommunityId))
    .sort((first, second) => second.weight - first.weight || first.sourceCommunityId.localeCompare(second.sourceCommunityId));
  return { ...payload, entities, edges, communities, communityEdges };
}

export function findEntity(payload: LibraryGraphVisualizationPayload, canonicalKey: string): LibraryGraphVisualizationEntity | null {
  return payload.entities.find((entity) => entity.canonicalKey === canonicalKey) ?? null;
}

export function findCommunity(payload: LibraryGraphVisualizationPayload, communityId: string): LibraryGraphVisualizationCommunity | null {
  return payload.communities.find((community) => community.communityId === communityId) ?? null;
}

/** 实体的相关边（详情抽屉展示）。 */
export function getEntityRelatedEdges(payload: LibraryGraphVisualizationPayload, canonicalKey: string): Array<{ edge: LibraryGraphVisualizationEdge; otherKey: string }> {
  return payload.edges
    .filter((edge) => edge.sourceKey === canonicalKey || edge.targetKey === canonicalKey)
    .map((edge) => ({ edge, otherKey: edge.sourceKey === canonicalKey ? edge.targetKey : edge.sourceKey }));
}

export type LibraryGraphEmptyKind = 'no-library' | 'no-projection' | 'no-entities';

export function getLibraryGraphEmptyState(input: { hasLibrary: boolean; payload: LibraryGraphVisualizationPayload | null }): LibraryGraphEmptyKind | null {
  if (!input.hasLibrary) return 'no-library';
  if (!input.payload) return 'no-projection';
  if (input.payload.entities.length === 0 && input.payload.communities.length === 0) return 'no-entities';
  return null;
}

export function communityTitle(community: LibraryGraphVisualizationCommunity): string {
  const head = community.memberKeys[0];
  return head ? `社区 ${community.communityId} · ${head}` : `社区 ${community.communityId}`;
}

/** 社区画布标签：与实体视图的简洁命名对齐，取头部成员的实体名；子社区（level≥1）加后缀区分同名父子社区。 */
export function communityShortLabel(community: LibraryGraphVisualizationCommunity, headMention?: string): string {
  const base = headMention || community.memberKeys[0] || `社区 ${community.communityId}`;
  return community.level > 0 ? `${base} · 子社区` : base;
}

export function entityNodeId(canonicalKey: string): string {
  return `entity:${canonicalKey}`;
}

export function communityNodeId(communityId: string): string {
  return `community:${communityId}`;
}

function edgeId(edge: LibraryGraphVisualizationEdge): string {
  return `edge:${edge.sourceKey}->${edge.targetKey}`;
}
