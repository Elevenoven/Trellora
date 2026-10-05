import type Database from 'better-sqlite3';
import { openGraphDatabase } from './graphProjection';
import { queryGraphEntityVectorNeighbors } from './graphVectorIndex';

/** 遍历预算（方案 §4.1）：≤2 跳、节点 ≤50、边 ≤100。 */
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_SEED_LIMIT = 5;
const DEFAULT_NODE_BUDGET = 50;
const DEFAULT_EDGE_BUDGET = 100;
const DEFAULT_EVIDENCE_LIMIT = 6;
/** 多跳遍历距离衰减（优化方案 P0-3）：排序键 = weight × decay^(hop-1)，与 chunk 图扩展一致。 */
const HOP_DECAY = 0.5;
/** 语义种子通道（优化方案 P1-4）：实体向量近邻 Top-K 与相似度下限。 */
const VECTOR_SEED_TOP_K = 5;
const DEFAULT_VECTOR_SEED_MIN_SIMILARITY = 0.35;
/** 向量种子打分权重：上限低于词法命中（mention 1.5 / FTS 2+），语义链接只做补充不作主锚。 */
const VECTOR_SEED_SCORE_WEIGHT = 0.8;

export interface GraphLocalSearchInput {
  libraryPath: string;
  query: string;
  /** Jieba 检索分词结果；未提供时退化为标点/空白切分。 */
  queryTerms?: string[];
  /** 问题 embedding（优化方案 P1-4）：提供时叠加实体向量近邻种子通道；维度不匹配静默降级。 */
  queryEmbedding?: number[];
  /** 语义种子必须与图向量索引使用同一模型档案，维度相同也不能跨模型。 */
  queryProfileHash?: string;
  /** 语义种子相似度下限（1 - cosine distance）；缺省 0.35。 */
  vectorSeedMinSimilarity?: number;
  maxHops?: number;
  seedLimit?: number;
  nodeBudget?: number;
  edgeBudget?: number;
  evidenceLimit?: number;
}

export interface GraphLocalSearchEntity {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
  communityId: string;
  /** 0=锚点种子；1/2=遍历跳数。 */
  hop: number;
}

export interface GraphLocalSearchRelation {
  sourceKey: string;
  targetKey: string;
  weight: number;
  kinds: string[];
  description: string;
  chunkIds: string[];
}

export interface GraphLocalSearchEvidence {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionContext: string;
  /** 产出该证据的实体键或边，用于解释装配来源。 */
  matchedBy: string[];
}

export interface GraphLocalSearchCommunityHint {
  communityId: string;
  level: number;
  summary: string;
  /** 按 degree 降序的成员显示名，仅做导向，不做事实。 */
  topMembers: string[];
}

export interface GraphLocalSearchResult {
  seeds: string[];
  /** 仅由向量通道引入的种子键（遥测/调试轨道统计种子命中率用，优化方案 P1-4）。 */
  vectorSeedKeys: string[];
  entities: GraphLocalSearchEntity[];
  relations: GraphLocalSearchRelation[];
  evidence: GraphLocalSearchEvidence[];
  communities: GraphLocalSearchCommunityHint[];
  traversedNodes: number;
  traversedEdges: number;
}

/**
 * graph_local_search 查询核心（方案 §4.1）：实体锚点（FTS5 + 词法子串双通道，
 * 可选叠加实体向量近邻通道，优化方案 P1-4）→ ≤2 跳加权遍历 → 证据回原始 Chunk。
 * 图谱投影不存在时返回 null（工具据此降级提示）。
 */
export function runGraphLocalSearch(input: GraphLocalSearchInput): GraphLocalSearchResult | null {
  const database = openGraphDatabase(input.libraryPath, false);
  if (!database) return null;
  try {
    if (!graphTablesReady(database)) return null;
    const terms = normalizeSearchTerms(input.query, input.queryTerms);
    if (terms.length === 0) return emptyResult();
    const seedLimit = clampLimit(input.seedLimit, 1, 20, DEFAULT_SEED_LIMIT);
    const vectorSeeds = findVectorSeedCandidates(input, seedLimit);
    const seeds = findSeedEntities(database, terms, seedLimit, vectorSeeds);
    if (seeds.length === 0) return emptyResult();

    const maxHops = clampLimit(input.maxHops, 1, 2, DEFAULT_MAX_HOPS);
    const nodeBudget = clampLimit(input.nodeBudget, 1, 200, DEFAULT_NODE_BUDGET);
    const edgeBudget = clampLimit(input.edgeBudget, 1, 500, DEFAULT_EDGE_BUDGET);
    const traversal = traverseGraph(database, seeds.map((seed) => seed.canonicalKey), maxHops, nodeBudget, edgeBudget);

    const evidenceLimit = clampLimit(input.evidenceLimit, 1, 20, DEFAULT_EVIDENCE_LIMIT);
    const entities = [...seeds, ...traversal.entities];
    const evidence = collectChunkEvidence(database, { entities, relations: traversal.relations }, evidenceLimit);
    const communities = collectCommunityHints(database, seeds.map((seed) => seed.canonicalKey));
    const vectorSeedKeySet = new Set(vectorSeeds.map((candidate) => candidate.canonicalKey));

    return {
      seeds: seeds.map((seed) => seed.canonicalKey),
      vectorSeedKeys: seeds.map((seed) => seed.canonicalKey).filter((key) => vectorSeedKeySet.has(key)),
      entities,
      relations: traversal.relations,
      evidence,
      communities,
      traversedNodes: entities.length,
      traversedEdges: traversal.relations.length,
    };
  } finally {
    database.close();
  }
}

type SeedEntity = GraphLocalSearchEntity;

interface EntityRecord {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
  communityId: string;
}

interface RelationRecord {
  sourceKey: string;
  targetKey: string;
  weight: number;
  kinds: string[];
  description: string;
  chunkIds: string[];
}

function emptyResult(): GraphLocalSearchResult {
  return { seeds: [], vectorSeedKeys: [], entities: [], relations: [], evidence: [], communities: [], traversedNodes: 0, traversedEdges: 0 };
}

function clampLimit(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeSearchTerms(query: string, queryTerms?: string[]): string[] {
  const provided = (queryTerms ?? [])
    .map((term) => term.trim())
    .filter((term) => term && term.length <= 64);
  if (provided.length > 0) return [...new Set(provided)].slice(0, 16);
  const naive = query
    .split(/[\s，。、；：！？,.:;!?"'（）()【】[\]《》<>—…·/\\|]+/u)
    .map((term) => term.trim())
    .filter((term) => term && term.length <= 64);
  return [...new Set(naive)].slice(0, 16);
}

/**
 * 语义种子候选（优化方案 P1-4）：问题 embedding 对实体向量 KNN Top-K，
 * 相似度 = 1 - cosine distance，低于下限丢弃；无向量索引/维度不符时静默返回空。
 */
function findVectorSeedCandidates(input: GraphLocalSearchInput, seedLimit: number): Array<{ canonicalKey: string; similarity: number }> {
  if (!input.queryEmbedding || input.queryEmbedding.length === 0) return [];
  const minSimilarity = typeof input.vectorSeedMinSimilarity === 'number' && Number.isFinite(input.vectorSeedMinSimilarity)
    ? Math.min(1, Math.max(0, input.vectorSeedMinSimilarity))
    : DEFAULT_VECTOR_SEED_MIN_SIMILARITY;
  const neighbors = queryGraphEntityVectorNeighbors(input.libraryPath, input.queryEmbedding, Math.max(1, VECTOR_SEED_TOP_K), input.queryProfileHash);
  const candidates: Array<{ canonicalKey: string; similarity: number }> = [];
  const seen = new Set<string>();
  for (const neighbor of neighbors) {
    if (!neighbor.canonicalKey || seen.has(neighbor.canonicalKey)) continue;
    const distance = Number(neighbor.distance);
    if (!Number.isFinite(distance)) continue;
    const similarity = 1 - Math.max(0, Math.min(1, distance));
    if (!Number.isFinite(similarity) || similarity < minSimilarity) continue;
    seen.add(neighbor.canonicalKey);
    candidates.push({ canonicalKey: neighbor.canonicalKey, similarity });
  }
  return candidates.slice(0, Math.max(1, seedLimit));
}

/**
 * FTS5 通道 + LIKE 子串通道合并打分；中文语料下子串通道兜底分词边界。
 * 可选叠加向量种子通道（优化方案 P1-4）：打分低于字面命中，只作补充锚点。
 */
function findSeedEntities(
  database: Database.Database,
  terms: string[],
  seedLimit: number,
  vectorSeeds: Array<{ canonicalKey: string; similarity: number }> = [],
): SeedEntity[] {
  const scores = new Map<string, number>();
  const boost = (key: string, value: number): void => scores.set(key, (scores.get(key) ?? 0) + value);

  const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  try {
    const ftsRows = database.prepare(`
      SELECT entities.canonical_key AS canonicalKey, bm25(graph_entities_fts) AS bm25
      FROM graph_entities_fts AS fts
      JOIN graph_entities AS entities ON entities.rowid = fts.rowid
      WHERE graph_entities_fts MATCH ?
      ORDER BY bm25
      LIMIT ?
    `).all(ftsQuery, seedLimit * 4) as Array<{ canonicalKey: string; bm25: number }>;
    ftsRows.forEach((row, index) => boost(row.canonicalKey, 2 + (ftsRows.length - index) * 0.1));
  } catch {
    // 分词碎片可能构造出非法 MATCH 表达式；此时只依赖子串通道。
  }

  const like = database.prepare(`
    SELECT canonical_key AS canonicalKey, mention, description
    FROM graph_entities
    WHERE mention LIKE ? OR canonical_key LIKE ? OR description LIKE ?
    LIMIT 500
  `);
  for (const term of terms) {
    const pattern = `%${term}%`;
    const rows = like.all(pattern, pattern, pattern) as Array<{ canonicalKey: string; mention: string; description: string }>;
    for (const row of rows) {
      const weight = row.mention.toLowerCase().includes(term.toLowerCase()) ? 1.5 : 0.5;
      boost(row.canonicalKey, weight);
    }
  }

  // 向量通道：相似度线性映射为打分，上限 0.8，低于 mention 命中（1.5）与 FTS（2+）。
  for (const candidate of vectorSeeds) {
    boost(candidate.canonicalKey, candidate.similarity * VECTOR_SEED_SCORE_WEIGHT);
  }

  const candidates = [...scores.entries()]
    .map(([canonicalKey, score]) => ({ canonicalKey, score }))
    .sort((first, second) => second.score - first.score || first.canonicalKey.localeCompare(second.canonicalKey))
    .slice(0, seedLimit)
    .map((candidate) => readEntity(database, candidate.canonicalKey))
    .filter((entity): entity is EntityRecord => entity !== null);
  return candidates.map((entity) => ({ ...entity, hop: 0 }));
}

/** BFS 遍历：按边权降序扩展，受节点/边预算约束；产出按 weight × 衰减^(hop-1) 降序（优化方案 P0-3）。 */
function traverseGraph(database: Database.Database, seedKeys: string[], maxHops: number, nodeBudget: number, edgeBudget: number): {
  entities: GraphLocalSearchEntity[];
  relations: GraphLocalSearchRelation[];
} {
  const visited = new Map<string, GraphLocalSearchEntity>();
  for (const key of seedKeys) {
    const entity = readEntity(database, key);
    if (entity) visited.set(key, { ...entity, hop: 0 });
  }
  const seenEdges = new Set<string>();
  const relations: Array<RelationRecord & { hop: number }> = [];
  let frontier = [...visited.keys()];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    if (frontier.length === 0 || visited.size >= nodeBudget || relations.length >= edgeBudget) break;
    const candidates: Array<RelationRecord & { neighbor: string }> = [];
    for (const key of frontier) {
      for (const relation of readRelationsOf(database, key)) {
        const edgeId = `${relation.sourceKey}\u0000${relation.targetKey}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);
        relations.push({ ...relation, hop });
        const neighbor = relation.sourceKey === key ? relation.targetKey : relation.sourceKey;
        if (!visited.has(neighbor)) candidates.push({ ...relation, neighbor });
      }
    }
    candidates.sort((first, second) => second.weight - first.weight || first.neighbor.localeCompare(second.neighbor));
    const next: string[] = [];
    for (const candidate of candidates) {
      if (visited.size >= nodeBudget) break;
      if (visited.has(candidate.neighbor)) continue;
      const entity = readEntity(database, candidate.neighbor);
      if (!entity) continue;
      visited.set(candidate.neighbor, { ...entity, hop });
      next.push(candidate.neighbor);
    }
    frontier = next;
  }

  return {
    entities: [...visited.values()].filter((entity) => entity.hop > 0),
    relations: relations
      .sort((first, second) => decayedWeight(second) - decayedWeight(first) || first.sourceKey.localeCompare(second.sourceKey))
      .slice(0, edgeBudget)
      .map(({ hop: _hop, ...relation }) => relation),
  };
}

/** 距离衰减后的边排序键：深层边按 0.5 逐跳衰减，避免噪声边与近层边同台竞争预算。 */
function decayedWeight(relation: { weight: number; hop: number }): number {
  return relation.weight * HOP_DECAY ** Math.max(0, relation.hop - 1);
}

/** 证据装配：种子与遍历边的 chunkIds 汇总后回 material_chunks 取原文（引用必须指向原始 Chunk）。 */
function collectChunkEvidence(database: Database.Database, traversal: {
  entities: GraphLocalSearchEntity[];
  relations: GraphLocalSearchRelation[];
}, evidenceLimit: number): GraphLocalSearchEvidence[] {
  const chunkSources = new Map<string, string[]>();
  const addSource = (chunkId: string, source: string): void => {
    const sources = chunkSources.get(chunkId) ?? [];
    if (!sources.includes(source)) sources.push(source);
    chunkSources.set(chunkId, sources);
  };
  for (const relation of traversal.relations) {
    for (const chunkId of relation.chunkIds) addSource(chunkId, `${relation.sourceKey}→${relation.targetKey}`);
  }
  for (const entity of traversal.entities) {
    const row = readEntityChunkIds(database, entity.canonicalKey);
    for (const chunkId of row) addSource(chunkId, entity.canonicalKey);
  }
  if (chunkSources.size === 0) return [];

  const chunkIds = [...chunkSources.keys()].slice(0, evidenceLimit * 3);
  const placeholders = chunkIds.map(() => '?').join(', ');
  const chunkRows = database.prepare(`
    SELECT chunk_id AS chunkId, document_id AS documentId, parent_chunk_id AS parentChunkId,
           ordinal, text, source_text AS sourceText, section_context AS sectionContext
    FROM material_chunks
    WHERE chunk_id IN (${placeholders})
  `).all(...chunkIds) as Array<{ chunkId: string; documentId: string; parentChunkId: string | null; ordinal: number; text: string; sourceText: string; sectionContext: string }>;
  if (chunkRows.length === 0) return [];

  const parentLookup = new Map<string, { parentChunkId: string; ordinal: number; text: string; sourceText: string }>();
  const parentIdsByDocument = new Map<string, string[]>();
  for (const row of chunkRows) {
    if (!row.parentChunkId) continue;
    const list = parentIdsByDocument.get(row.documentId) ?? [];
    if (!list.includes(row.parentChunkId)) list.push(row.parentChunkId);
    parentIdsByDocument.set(row.documentId, list);
  }
  for (const [documentId, parentIds] of parentIdsByDocument) {
    const parentPlaceholders = parentIds.map(() => '?').join(', ');
    const parentRows = database.prepare(`
      SELECT parent_chunk_id AS parentChunkId, ordinal, text, source_text AS sourceText
      FROM material_chunk_parents
      WHERE document_id = ? AND parent_chunk_id IN (${parentPlaceholders})
    `).all(documentId, ...parentIds) as Array<{ parentChunkId: string; ordinal: number; text: string; sourceText: string }>;
    for (const parent of parentRows) parentLookup.set(`${documentId}\u0000${parent.parentChunkId}`, parent);
  }

  const evidence: GraphLocalSearchEvidence[] = [];
  const seenParents = new Set<string>();
  for (const row of chunkRows) {
    if (evidence.length >= evidenceLimit) break;
    const matchedBy = chunkSources.get(row.chunkId) ?? [];
    const parent = row.parentChunkId ? parentLookup.get(`${row.documentId}\u0000${row.parentChunkId}`) : undefined;
    if (parent) {
      const dedupeKey = `${row.documentId}\u0000${parent.parentChunkId}`;
      if (seenParents.has(dedupeKey)) continue;
      seenParents.add(dedupeKey);
      evidence.push({
        documentId: row.documentId,
        chunkId: row.chunkId,
        parentChunkId: parent.parentChunkId,
        ordinal: parent.ordinal,
        text: parent.text,
        sourceText: parent.sourceText,
        sectionContext: row.sectionContext,
        matchedBy,
      });
      continue;
    }
    evidence.push({
      documentId: row.documentId,
      chunkId: row.chunkId,
      parentChunkId: null,
      ordinal: row.ordinal,
      text: row.text,
      sourceText: row.sourceText,
      sectionContext: row.sectionContext,
      matchedBy,
    });
  }
  return evidence;
}

/** 种子实体所在 level-0 社区的导向信息；P2 摘要为空，仅列核心成员。 */
function collectCommunityHints(database: Database.Database, seedKeys: string[]): GraphLocalSearchCommunityHint[] {
  const hints: GraphLocalSearchCommunityHint[] = [];
  const seen = new Set<string>();
  for (const key of seedKeys) {
    const entity = readEntity(database, key);
    if (!entity || !entity.communityId || seen.has(entity.communityId)) continue;
    const community = database.prepare(`
      SELECT community_id AS communityId, level, summary, member_keys AS memberKeys
      FROM graph_communities WHERE community_id = ?
    `).get(entity.communityId) as { communityId: string; level: number; summary: string; memberKeys: string } | undefined;
    if (!community) continue;
    seen.add(community.communityId);
    let memberKeys: string[] = [];
    try {
      memberKeys = (JSON.parse(community.memberKeys) as unknown[]).filter((item): item is string => typeof item === 'string');
    } catch {
      memberKeys = [];
    }
    const members = memberKeys
      .map((memberKey) => readEntity(database, memberKey))
      .filter((member): member is EntityRecord => member !== null)
      .sort((first, second) => second.degree - first.degree)
      .slice(0, 5)
      .map((member) => member.mention);
    hints.push({
      communityId: community.communityId,
      level: community.level,
      summary: community.summary,
      topMembers: members,
    });
  }
  return hints;
}

function graphTablesReady(database: Database.Database): boolean {
  for (const tableName of ['graph_meta', 'graph_entities', 'graph_relations', 'graph_communities', 'graph_entities_fts']) {
    if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(tableName)) return false;
  }
  const meta = database.prepare(`SELECT value FROM graph_meta WHERE key = 'graphKey'`).get() as { value: string } | undefined;
  return Boolean(meta?.value);
}

function readEntity(database: Database.Database, canonicalKey: string): EntityRecord | null {
  const row = database.prepare(`
    SELECT canonical_key AS canonicalKey, mention, type, description, degree, community_id AS communityId
    FROM graph_entities WHERE canonical_key = ?
  `).get(canonicalKey) as EntityRecord | undefined;
  return row ?? null;
}

function readEntityChunkIds(database: Database.Database, canonicalKey: string): string[] {
  const row = database.prepare(`SELECT chunk_ids AS chunkIds FROM graph_entities WHERE canonical_key = ?`).get(canonicalKey) as { chunkIds: string } | undefined;
  if (!row) return [];
  try {
    return (JSON.parse(row.chunkIds) as unknown[]).filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function readRelationsOf(database: Database.Database, canonicalKey: string): RelationRecord[] {
  const rows = database.prepare(`
    SELECT source_key AS sourceKey, target_key AS targetKey, weight, kinds, description, chunk_ids AS chunkIds
    FROM graph_relations WHERE source_key = ? OR target_key = ?
  `).all(canonicalKey, canonicalKey) as Array<{ sourceKey: string; targetKey: string; weight: number; kinds: string; description: string; chunkIds: string }>;
  return rows.map((row) => ({
    sourceKey: row.sourceKey,
    targetKey: row.targetKey,
    weight: row.weight,
    kinds: parseStringArray(row.kinds),
    description: row.description,
    chunkIds: parseStringArray(row.chunkIds),
  }));
}

function parseStringArray(value: string): string[] {
  try {
    return (JSON.parse(value) as unknown[]).filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
