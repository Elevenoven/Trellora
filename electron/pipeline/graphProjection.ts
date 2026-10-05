import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { PipelineStageError } from './stageErrors';
import { readLibraryGraphReportFromDirectory } from './libraryGraphStore';
import type { CommunitySummaryRecord } from './communitySummaries';

const sqliteVec = require('sqlite-vec') as { load(database: Database.Database): void };

const graphMetaTableName = 'graph_meta';
const graphEntitiesTableName = 'graph_entities';
const graphRelationsTableName = 'graph_relations';
const graphCommunitiesTableName = 'graph_communities';
const graphEntitiesFtsTableName = 'graph_entities_fts';
// chunk 级图投影（优化方案 P0-2）：实体关系投影出的同文档 chunk 对加权边，供混合检索图扩展。
const graphChunkEdgesTableName = 'graph_chunk_edges';
// 向量表由 graphVectorIndex 建立；投影替换/清理时需一并废弃（图重建整体失效）。
const graphVectorTableNames = ['graph_entity_vec', 'graph_community_vec'];

export interface GraphProjectionImportInput {
  libraryPath: string;
  graphKey: string;
  /** 已提交的 `.menghan-meta/graph/<graphKey>` 目录。 */
  graphDirectory: string;
}

export interface GraphProjectionImportResult {
  graphKey: string;
  engine: string;
  levels: number;
  importedEntities: number;
  importedRelations: number;
  importedCommunities: number;
  importedChunkEdges: number;
  readBackEntities: number;
  readBackRelations: number;
  readBackCommunities: number;
  readBackChunkEdges: number;
  readBackFts: number;
}

export interface GraphProjectionStatus {
  graphKey: string;
  engine: string;
  levels: number;
  entityCount: number;
  relationCount: number;
  communityCount: number;
  /** 已生成非空摘要的社区数（方案 §4.4 状态徽标）。 */
  summaryCoverage: number;
  summaryGeneratedAt: string;
  /** 实体向量 + 社区向量总数（方案 §4.4 状态徽标）。 */
  vectorCoverage: number;
  vectorGeneratedAt: string;
  importedAt: string;
}

export interface GraphCommunityProjectionRow {
  communityId: string;
  level: number;
  parentId: string | null;
  memberCount: number;
  memberKeys: string[];
  summary: string;
  tokens: number;
}

export interface GraphEntityProjectionRow {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
}

/** 图谱可视化（地图菜单，方案 §5）：实体节点 + 保留边 + level 0/1 社区与聚合边。 */
export interface GraphVisualizationEntityNode {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
  communityId: string;
  /** 来源文档 id（地图视图左侧文档筛选用）。 */
  docIds: string[];
}

export interface GraphVisualizationEdgeRow {
  sourceKey: string;
  targetKey: string;
  weight: number;
  kinds: string[];
}

export interface GraphVisualizationCommunityNode {
  communityId: string;
  level: number;
  parentId: string | null;
  memberCount: number;
  memberKeys: string[];
  summary: string;
  tokens: number;
}

/** 社区间聚合边：跨社区成员边的权重和（社区视图用）。 */
export interface GraphVisualizationCommunityEdge {
  sourceCommunityId: string;
  targetCommunityId: string;
  weight: number;
  edgeCount: number;
}

export interface GraphVisualizationPayload {
  status: GraphProjectionStatus;
  entities: GraphVisualizationEntityNode[];
  edges: GraphVisualizationEdgeRow[];
  communities: GraphVisualizationCommunityNode[];
  communityEdges: GraphVisualizationCommunityEdge[];
  /** 实体数超过上限被截断。 */
  truncated: boolean;
}

/** 按 degree 降序读取头部实体（小图降级实体概览用，方案 §8）；没有投影返回 null。 */
export function readGraphTopEntities(libraryPath: string, limit: number): GraphEntityProjectionRow[] | null {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return null;
  try {
    if (!graphTablesExist(database)) return null;
    const rows = database.prepare(`
      SELECT canonical_key, mention, type, description, degree
      FROM ${graphEntitiesTableName}
      ORDER BY degree DESC, canonical_key ASC
      LIMIT ?
    `).all(Math.max(1, Math.floor(limit) || 1)) as Array<{ canonical_key: string; mention: string; type: string; description: string; degree: number }>;
    return rows.map((row) => ({
      canonicalKey: row.canonical_key,
      mention: row.mention,
      type: row.type,
      description: typeof row.description === 'string' ? row.description : '',
      degree: Number(row.degree) || 0,
    }));
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/** 别名仲裁需要候选描述辅助判定；批量回读全部实体描述（图规模小，一次读取）。 */
export function readGraphEntityDescriptions(libraryPath: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return descriptions;
  try {
    if (!graphTablesExist(database)) return descriptions;
    const rows = database.prepare(`SELECT canonical_key, description FROM ${graphEntitiesTableName}`).all() as Array<{ canonical_key: string; description: string }>;
    for (const row of rows) descriptions.set(row.canonical_key, typeof row.description === 'string' ? row.description : '');
  } catch {
    return descriptions;
  } finally {
    database.close();
  }
}

interface EntityRow {
  canonicalKey: string;
  mention: string;
  type: string;
  description: string;
  degree: number;
  docIdsJson: string;
  chunkIdsJson: string;
  communityId: string;
}

interface RelationRow {
  sourceKey: string;
  targetKey: string;
  weight: number;
  pmi: number;
  strengthMean: number;
  strengthSampleCount: number;
  supportChunkCount: number;
  supportDocCount: number;
  kindsJson: string;
  description: string;
  chunkIdsJson: string;
}

interface CommunityRow {
  communityId: string;
  level: number;
  parentId: string | null;
  memberCount: number;
  memberKeysJson: string;
  tokens: number;
}

interface ChunkEdgeRow {
  chunkIdA: string;
  chunkIdB: string;
  weight: number;
}

/** chunk 边一跳邻居（优化方案 P0-2）；seedChunkId 为出发种子。 */
export interface GraphChunkEdgeNeighbor {
  seedChunkId: string;
  neighborChunkId: string;
  weight: number;
}

/**
 * 把已提交的库级图产物导入资料库 meta SQLite（与 FTS5 投影同库，方案 §3.4）。
 * Python Worker 只读产物目录，本模块是唯一写入方；事务内先清空旧投影再整体替换，
 * 读回计数与 graph-report.json 不一致则回滚。
 */
export function replaceGraphProjection(input: GraphProjectionImportInput): GraphProjectionImportResult {
  const report = readLibraryGraphReportFromDirectory(input.graphDirectory);
  if (!report || report.graphKey !== input.graphKey) {
    throw new PipelineStageError('GRAPH_PROJECTION_INPUT_INVALID', 'graph-report.json 缺失或 graphKey 不一致，拒绝导入投影。', false);
  }
  const { entities, relations } = readGraphArtifacts(path.join(input.graphDirectory, 'graph.jsonl'));
  const communities = readCommunityArtifacts(path.join(input.graphDirectory, 'communities.jsonl'));
  const chunkEdges = readChunkEdgeArtifacts(path.join(input.graphDirectory, 'chunk_edges.jsonl'));
  if (entities.length !== report.counts.nodes
    || relations.length !== report.counts.edges
    || communities.length !== report.counts.communities
    || chunkEdges.length !== report.counts.chunkEdges) {
    throw new PipelineStageError('GRAPH_PROJECTION_INPUT_INVALID', '图谱产物行数与 graph-report.json 计数不一致，拒绝导入投影。', false);
  }

  const database = openGraphDatabase(input.libraryPath, true);
  try {
    // 图重建整体失效向量索引：先废弃旧向量表（graph_meta 的 vectorKey 会在事务内清空）。
    // 放在事务外：加载 sqlite-vec 扩展不进入事务。
    dropGraphVectorTables(database);
    const importedAt = new Date().toISOString();
    return database.transaction(() => {
      database.prepare(`DELETE FROM ${graphEntitiesFtsTableName}`).run();
      database.prepare(`DELETE FROM ${graphEntitiesTableName}`).run();
      database.prepare(`DELETE FROM ${graphRelationsTableName}`).run();
      database.prepare(`DELETE FROM ${graphCommunitiesTableName}`).run();
      database.prepare(`DELETE FROM ${graphChunkEdgesTableName}`).run();
      database.prepare(`DELETE FROM ${graphMetaTableName}`).run();

      const insertEntity = database.prepare(`
        INSERT INTO ${graphEntitiesTableName} (canonical_key, mention, type, description, degree, doc_ids, chunk_ids, community_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of entities) {
        insertEntity.run(row.canonicalKey, row.mention, row.type, row.description, row.degree, row.docIdsJson, row.chunkIdsJson, row.communityId);
      }
      const insertRelation = database.prepare(`
        INSERT INTO ${graphRelationsTableName} (
          source_key, target_key, weight, pmi, strength_mean, strength_sample_count,
          support_chunk_count, support_doc_count, kinds, description, chunk_ids
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of relations) {
        insertRelation.run(
          row.sourceKey,
          row.targetKey,
          row.weight,
          row.pmi,
          row.strengthMean,
          row.strengthSampleCount,
          row.supportChunkCount,
          row.supportDocCount,
          row.kindsJson,
          row.description,
          row.chunkIdsJson,
        );
      }
      const insertCommunity = database.prepare(`
        INSERT INTO ${graphCommunitiesTableName} (community_id, level, parent_id, member_count, member_keys, summary, tokens)
        VALUES (?, ?, ?, ?, ?, '', ?)
      `);
      for (const row of communities) {
        insertCommunity.run(row.communityId, row.level, row.parentId, row.memberCount, row.memberKeysJson, row.tokens);
      }
      const insertChunkEdge = database.prepare(`
        INSERT INTO ${graphChunkEdgesTableName} (chunk_id_a, chunk_id_b, weight)
        VALUES (?, ?, ?)
      `);
      for (const row of chunkEdges) {
        insertChunkEdge.run(row.chunkIdA, row.chunkIdB, row.weight);
      }
      // external-content FTS：普通表重建后统一从内容表重建索引。
      database.prepare(`INSERT INTO ${graphEntitiesFtsTableName}(${graphEntitiesFtsTableName}) VALUES ('rebuild')`).run();

      const insertMeta = database.prepare(`INSERT INTO ${graphMetaTableName} (key, value) VALUES (?, ?)`);
      insertMeta.run('graphKey', input.graphKey);
      insertMeta.run('engine', report.engine);
      insertMeta.run('levels', String(report.counts.levels));
      insertMeta.run('entityCount', String(entities.length));
      insertMeta.run('relationCount', String(relations.length));
      insertMeta.run('communityCount', String(communities.length));
      insertMeta.run('chunkEdgeCount', String(chunkEdges.length));
      insertMeta.run('leidenConfig', JSON.stringify(report.leidenConfig));
      insertMeta.run('sourceDocuments', JSON.stringify(report.sourceDocuments));
      insertMeta.run('weightVersion', report.weightVersion);
      insertMeta.run('weightConfig', JSON.stringify(report.weightConfig));
      insertMeta.run('importedAt', importedAt);

      const readBack = readGraphProjectionCounts(database);
      if (readBack.entities !== entities.length || readBack.relations !== relations.length
        || readBack.communities !== communities.length || readBack.chunkEdges !== chunkEdges.length
        || readBack.fts !== entities.length) {
        throw new PipelineStageError('GRAPH_PROJECTION_COUNT_MISMATCH', '图谱投影读回计数与产物不一致，事务已回滚。', true);
      }
      return {
        graphKey: input.graphKey,
        engine: report.engine,
        levels: report.counts.levels,
        importedEntities: entities.length,
        importedRelations: relations.length,
        importedCommunities: communities.length,
        importedChunkEdges: chunkEdges.length,
        readBackEntities: readBack.entities,
        readBackRelations: readBack.relations,
        readBackCommunities: readBack.communities,
        readBackChunkEdges: readBack.chunkEdges,
        readBackFts: readBack.fts,
      };
    })();
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('GRAPH_PROJECTION_IMPORT_FAILED', `图谱投影导入失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    database.close();
  }
}

/** current 判定：仿 isKeywordIndexCurrent，比对 graphKey 与预期实体/社区数量（方案 §3.4）。 */
export function isGraphProjectionCurrent(libraryPath: string, input: { graphKey: string; expectedEntities: number; expectedCommunities: number }): boolean {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return false;
  try {
    if (!graphTablesExist(database)) return false;
    const meta = readGraphMetaMap(database);
    if (meta.graphKey !== input.graphKey) return false;
    if (Number(meta.entityCount) !== input.expectedEntities || Number(meta.communityCount) !== input.expectedCommunities) return false;
    const counts = readGraphProjectionCounts(database);
    return counts.entities === input.expectedEntities
      && counts.communities === input.expectedCommunities
      && counts.fts === input.expectedEntities;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/** 读取当前投影状态（供库级状态展示）；没有投影返回 null。 */
export function readGraphProjectionStatus(libraryPath: string): GraphProjectionStatus | null {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return null;
  try {
    if (!graphTablesExist(database)) return null;
    const meta = readGraphMetaMap(database);
    if (!meta.graphKey) return null;
    return {
      graphKey: meta.graphKey,
      engine: meta.engine ?? '',
      levels: Number(meta.levels) || 0,
      entityCount: Number(meta.entityCount) || 0,
      relationCount: Number(meta.relationCount) || 0,
      communityCount: Number(meta.communityCount) || 0,
      summaryCoverage: Number(meta.summaryCoverage) || 0,
      summaryGeneratedAt: meta.summaryGeneratedAt ?? '',
      vectorCoverage: Number(meta.vectorCoverage) || 0,
      vectorGeneratedAt: meta.vectorGeneratedAt ?? '',
      importedAt: meta.importedAt ?? '',
    };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/**
 * 摘要生成后写回投影（方案 §3.3）：事务内 UPDATE 社区摘要与 token，
 * 并在 meta 记录覆盖数与生成时间；读回计数不一致则回滚。best-effort 由调用方保证。
 */
export function updateGraphCommunitySummaries(libraryPath: string, records: CommunitySummaryRecord[]): { updated: number; coverage: number } {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return { updated: 0, coverage: 0 };
  try {
    if (!graphTablesExist(database)) return { updated: 0, coverage: 0 };
    const generatedAt = new Date().toISOString();
    return database.transaction(() => {
      const update = database.prepare(`UPDATE ${graphCommunitiesTableName} SET summary = ?, tokens = ? WHERE community_id = ?`);
      let updated = 0;
      for (const record of records) {
        if (!record.summary.trim()) continue;
        const result = update.run(record.summary, record.tokens, record.communityId);
        if (result.changes > 0) updated += 1;
      }
      const coverage = (database.prepare(
        `SELECT COUNT(*) AS count FROM ${graphCommunitiesTableName} WHERE summary != ''`,
      ).get() as { count: number }).count;
      const upsertMeta = database.prepare(`INSERT INTO ${graphMetaTableName} (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      upsertMeta.run('summaryCoverage', String(Number(coverage) || 0));
      upsertMeta.run('summaryGeneratedAt', generatedAt);
      const readBack = (database.prepare(
        `SELECT COUNT(*) AS count FROM ${graphCommunitiesTableName} WHERE summary != ''`,
      ).get() as { count: number }).count;
      if (Number(readBack) !== Number(coverage)) {
        throw new PipelineStageError('GRAPH_PROJECTION_COUNT_MISMATCH', '社区摘要写回读回计数不一致，事务已回滚。', true);
      }
      return { updated, coverage: Number(coverage) || 0 };
    })();
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('GRAPH_PROJECTION_IMPORT_FAILED', `社区摘要写回投影失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    database.close();
  }
}

/** 读取社区投影（含摘要），供全局检索与社区浏览抽屉；没有投影返回 null。 */
export function readGraphCommunities(libraryPath: string): GraphCommunityProjectionRow[] | null {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return null;
  try {
    if (!graphTablesExist(database)) return null;
    const rows = database.prepare(`
      SELECT community_id, level, parent_id, member_count, member_keys, summary, tokens
      FROM ${graphCommunitiesTableName}
      ORDER BY level DESC, community_id ASC
    `).all() as Array<{ community_id: string; level: number; parent_id: string | null; member_count: number; member_keys: string; summary: string; tokens: number }>;
    return rows.map((row) => {
      let memberKeys: string[] = [];
      try {
        const parsed = JSON.parse(row.member_keys) as unknown;
        if (Array.isArray(parsed)) memberKeys = parsed.filter((item): item is string => typeof item === 'string');
      } catch {
        memberKeys = [];
      }
      return {
        communityId: row.community_id,
        level: Number(row.level) || 0,
        parentId: row.parent_id,
        memberCount: Number(row.member_count) || 0,
        memberKeys,
        summary: typeof row.summary === 'string' ? row.summary : '',
        tokens: Number(row.tokens) || 0,
      };
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/**
 * 地图菜单只读视图数据（方案 §5）：实体按 degree 降序取 top-N，边仅保留两端在集合内；
 * 社区取 level 0/1（含摘要/成员），社区间聚合边 = 跨社区成员边的权重和。没有投影返回 null。
 */
export function readGraphVisualizationPayload(libraryPath: string, options?: { nodeLimit?: number }): GraphVisualizationPayload | null {
  const nodeLimit = Math.max(1, Math.floor(options?.nodeLimit ?? 500));
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return null;
  try {
    if (!graphTablesExist(database)) return null;
    const meta = readGraphMetaMap(database);
    if (!meta.graphKey) return null;
    const status: GraphProjectionStatus = {
      graphKey: meta.graphKey,
      engine: meta.engine ?? '',
      levels: Number(meta.levels) || 0,
      entityCount: Number(meta.entityCount) || 0,
      relationCount: Number(meta.relationCount) || 0,
      communityCount: Number(meta.communityCount) || 0,
      summaryCoverage: Number(meta.summaryCoverage) || 0,
      summaryGeneratedAt: meta.summaryGeneratedAt ?? '',
      vectorCoverage: Number(meta.vectorCoverage) || 0,
      vectorGeneratedAt: meta.vectorGeneratedAt ?? '',
      importedAt: meta.importedAt ?? '',
    };
    const entityRows = database.prepare(`
      SELECT canonical_key, mention, type, description, degree, community_id, doc_ids
      FROM ${graphEntitiesTableName}
      ORDER BY degree DESC, canonical_key ASC
      LIMIT ?
    `).all(nodeLimit) as Array<{ canonical_key: string; mention: string; type: string; description: string; degree: number; community_id: string; doc_ids: string }>;
    const entities: GraphVisualizationEntityNode[] = entityRows.map((row) => ({
      canonicalKey: row.canonical_key,
      mention: row.mention,
      type: row.type,
      description: typeof row.description === 'string' ? row.description : '',
      degree: Number(row.degree) || 0,
      communityId: row.community_id ?? '',
      docIds: parseJsonStringArray(row.doc_ids),
    }));
    const retained = new Set(entities.map((entity) => entity.canonicalKey));
    const relationRows = database.prepare(`
      SELECT source_key, target_key, weight, kinds
      FROM ${graphRelationsTableName}
      WHERE source_key IN (SELECT canonical_key FROM ${graphEntitiesTableName} ORDER BY degree DESC LIMIT ?)
        AND target_key IN (SELECT canonical_key FROM ${graphEntitiesTableName} ORDER BY degree DESC LIMIT ?)
    `).all(nodeLimit, nodeLimit) as Array<{ source_key: string; target_key: string; weight: number; kinds: string }>;
    const edges: GraphVisualizationEdgeRow[] = relationRows
      .filter((row) => retained.has(row.source_key) && retained.has(row.target_key))
      .map((row) => ({ sourceKey: row.source_key, targetKey: row.target_key, weight: Number(row.weight) || 1, kinds: parseJsonStringArray(row.kinds) }));

    const communityRows = database.prepare(`
      SELECT community_id, level, parent_id, member_count, member_keys, summary, tokens
      FROM ${graphCommunitiesTableName}
      WHERE level <= 1
      ORDER BY level ASC, community_id ASC
    `).all() as Array<{ community_id: string; level: number; parent_id: string | null; member_count: number; member_keys: string; summary: string; tokens: number }>;
    const communities: GraphVisualizationCommunityNode[] = communityRows.map((row) => ({
      communityId: row.community_id,
      level: Number(row.level) || 0,
      parentId: row.parent_id,
      memberCount: Number(row.member_count) || 0,
      memberKeys: parseJsonStringArray(row.member_keys),
      summary: typeof row.summary === 'string' ? row.summary : '',
      tokens: Number(row.tokens) || 0,
    }));

    // 聚合跨社区边：全部实体的社区归属 + 全部关系的权重累计。
    const membershipRows = database.prepare(`SELECT canonical_key, community_id FROM ${graphEntitiesTableName}`).all() as Array<{ canonical_key: string; community_id: string }>;
    const communityByKey = new Map(membershipRows.map((row) => [row.canonical_key, row.community_id ?? '']));
    const allRelationRows = database.prepare(`SELECT source_key, target_key, weight FROM ${graphRelationsTableName}`).all() as Array<{ source_key: string; target_key: string; weight: number }>;
    const aggregated = new Map<string, GraphVisualizationCommunityEdge>();
    for (const row of allRelationRows) {
      const source = communityByKey.get(row.source_key) ?? '';
      const target = communityByKey.get(row.target_key) ?? '';
      if (!source || !target || source === target) continue;
      const aggregateKey = `${source}\u0000${target}`;
      const existing = aggregated.get(aggregateKey);
      if (existing) {
        existing.weight += Number(row.weight) || 1;
        existing.edgeCount += 1;
      } else {
        aggregated.set(aggregateKey, { sourceCommunityId: source, targetCommunityId: target, weight: Number(row.weight) || 1, edgeCount: 1 });
      }
    }
    const communityIds = new Set(communities.map((community) => community.communityId));
    const communityEdges = [...aggregated.values()]
      .filter((edge) => communityIds.has(edge.sourceCommunityId) && communityIds.has(edge.targetCommunityId))
      .sort((first, second) => second.weight - first.weight || first.sourceCommunityId.localeCompare(second.sourceCommunityId));
    return { status, entities, edges, communities, communityEdges, truncated: status.entityCount > entities.length };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/** 地图视图搜索定位：FTS5 命中优先，无命中时回退 mention 包含匹配（中文分词兜底）。 */
export function searchGraphVisualizationEntities(libraryPath: string, query: string, limit = 12): GraphVisualizationEntityNode[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return [];
  const cap = Math.max(1, Math.floor(limit));
  try {
    if (!graphTablesExist(database)) return [];
    const terms = trimmed.split(/\s+/u).filter((term) => term.length > 0);
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const mapRow = (row: { canonicalKey: string; mention: string; type: string; description: string; degree: number; communityId: string; docIds: string }): GraphVisualizationEntityNode => ({
      canonicalKey: row.canonicalKey,
      mention: row.mention,
      type: row.type,
      description: row.description ?? '',
      degree: Number(row.degree) || 0,
      communityId: row.communityId ?? '',
      docIds: parseJsonStringArray(row.docIds),
    });
    try {
      const ftsRows = database.prepare(`
        SELECT entities.canonical_key AS canonicalKey, entities.mention AS mention, entities.type AS type,
               entities.description AS description, entities.degree AS degree, entities.community_id AS communityId,
               entities.doc_ids AS docIds
        FROM ${graphEntitiesFtsTableName} AS fts
        JOIN ${graphEntitiesTableName} AS entities ON entities.rowid = fts.rowid
        WHERE ${graphEntitiesFtsTableName} MATCH ?
        ORDER BY bm25(${graphEntitiesFtsTableName})
        LIMIT ?
      `).all(ftsQuery, cap) as Array<{ canonicalKey: string; mention: string; type: string; description: string; degree: number; communityId: string; docIds: string }>;
      if (ftsRows.length > 0) return ftsRows.map(mapRow);
    } catch {
      // FTS 查询语法异常时直接走回退。
    }
    const like = `%${trimmed}%`;
    const fallbackRows = database.prepare(`
      SELECT canonical_key AS canonicalKey, mention AS mention, type AS type,
             description AS description, degree AS degree, community_id AS communityId,
             doc_ids AS docIds
      FROM ${graphEntitiesTableName}
      WHERE mention LIKE ? OR canonical_key LIKE ?
      ORDER BY degree DESC, canonical_key ASC
      LIMIT ?
    `).all(like, like, cap) as Array<{ canonicalKey: string; mention: string; type: string; description: string; degree: number; communityId: string; docIds: string }>;
    return fallbackRows.map(mapRow);
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
  return [];
}

/** 关闭图谱增强或清理资料库索引时清空投影；资料库索引库不存在时静默返回。 */
export function removeGraphProjection(libraryPath: string): void {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return;
  try {
    database.transaction(() => {
      if (!graphTablesExist(database)) return;
      database.prepare(`DELETE FROM ${graphEntitiesFtsTableName}`).run();
      database.prepare(`DELETE FROM ${graphEntitiesTableName}`).run();
      database.prepare(`DELETE FROM ${graphRelationsTableName}`).run();
      database.prepare(`DELETE FROM ${graphCommunitiesTableName}`).run();
      database.prepare(`DELETE FROM ${graphChunkEdgesTableName}`).run();
      database.prepare(`DELETE FROM ${graphMetaTableName}`).run();
    })();
    dropGraphVectorTables(database);
    // 向量复用缓存表（优化方案 P1-5）：图投影被清空后旧向量不再可信，随之删除。
    database.exec('DROP TABLE IF EXISTS graph_entity_vec_cache');
    database.exec('DROP TABLE IF EXISTS graph_community_vec_cache');
  } catch (error) {
    throw new PipelineStageError('GRAPH_PROJECTION_IMPORT_FAILED', `图谱投影清理失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    database.close();
  }
}

/**
 * 废弃图向量虚拟表。vec0 表的 DROP 依赖 sqlite-vec 模块；扩展不可加载时跳过——
 * graph_meta 已清空，vectorKey 缺失会让缓存判定失效，下次构建整体重建。
 */
function dropGraphVectorTables(database: Database.Database): void {
  const hasVectorTables = graphVectorTableNames.some((tableName) => database.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(tableName));
  if (!hasVectorTables) return;
  try {
    loadGraphSqliteVec(database);
  } catch {
    return;
  }
  for (const tableName of graphVectorTableNames) {
    database.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
}

function loadGraphSqliteVec(database: Database.Database): void {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const packagedExtensionPath = resourcesPath
    ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll')
    : '';
  if (packagedExtensionPath && fs.existsSync(packagedExtensionPath)) {
    database.loadExtension(packagedExtensionPath);
    return;
  }
  sqliteVec.load(database);
}

export function openGraphDatabase(libraryPath: string, create: boolean): Database.Database | null {
  const metadataDirectory = getLibraryMetaDirectory(libraryPath);
  if (create) fs.mkdirSync(metadataDirectory, { recursive: true });
  const databasePath = path.join(metadataDirectory, 'index.db');
  if (!create && !fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  if (create) ensureGraphSchema(database);
  return database;
}

function ensureGraphSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${graphMetaTableName} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${graphEntitiesTableName} (
      canonical_key TEXT PRIMARY KEY,
      mention TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      degree INTEGER NOT NULL CHECK (degree >= 0),
      doc_ids TEXT NOT NULL,
      chunk_ids TEXT NOT NULL,
      community_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_graph_entities_community ON ${graphEntitiesTableName}(community_id);
    CREATE TABLE IF NOT EXISTS ${graphRelationsTableName} (
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      weight INTEGER NOT NULL CHECK (weight >= 1),
      pmi REAL NOT NULL DEFAULT 0 CHECK (pmi >= 0),
      strength_mean REAL NOT NULL DEFAULT 1 CHECK (strength_mean >= 1 AND strength_mean <= 10),
      strength_sample_count INTEGER NOT NULL DEFAULT 1 CHECK (strength_sample_count >= 1),
      support_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (support_chunk_count >= 0),
      support_doc_count INTEGER NOT NULL DEFAULT 0 CHECK (support_doc_count >= 0),
      kinds TEXT NOT NULL,
      description TEXT NOT NULL,
      chunk_ids TEXT NOT NULL,
      PRIMARY KEY (source_key, target_key)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_relations_target ON ${graphRelationsTableName}(target_key);
    CREATE TABLE IF NOT EXISTS ${graphCommunitiesTableName} (
      community_id TEXT PRIMARY KEY,
      level INTEGER NOT NULL CHECK (level >= 0),
      parent_id TEXT,
      member_count INTEGER NOT NULL CHECK (member_count >= 0),
      member_keys TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      tokens INTEGER NOT NULL CHECK (tokens >= 0)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${graphEntitiesFtsTableName} USING fts5(
      canonical_key, description,
      content='${graphEntitiesTableName}', content_rowid='rowid'
    );
    CREATE TABLE IF NOT EXISTS ${graphChunkEdgesTableName} (
      chunk_id_a TEXT NOT NULL,
      chunk_id_b TEXT NOT NULL,
      weight INTEGER NOT NULL CHECK (weight >= 1),
      PRIMARY KEY (chunk_id_a, chunk_id_b)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_chunk_edges_b ON ${graphChunkEdgesTableName}(chunk_id_b);
  `);
  ensureGraphRelationTuningColumns(database);
}

/** 为 graph-v2 及更早的现有 index.db 增量补齐可调参列；正式图导入随后会整体替换旧关系行。 */
function ensureGraphRelationTuningColumns(database: Database.Database): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${graphRelationsTableName})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const additions: Array<[string, string]> = [
    ['pmi', 'REAL NOT NULL DEFAULT 0 CHECK (pmi >= 0)'],
    ['strength_mean', 'REAL NOT NULL DEFAULT 1 CHECK (strength_mean >= 1 AND strength_mean <= 10)'],
    ['strength_sample_count', 'INTEGER NOT NULL DEFAULT 1 CHECK (strength_sample_count >= 1)'],
    ['support_chunk_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (support_chunk_count >= 0)'],
    ['support_doc_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (support_doc_count >= 0)'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE ${graphRelationsTableName} ADD COLUMN ${name} ${definition}`);
  }
}

/**
 * chunk 边一跳邻居查询（优化方案 P0-2）：每个种子 chunk 按边权降序取前 perSeedLimit 个。
 * 边无向存储（a < b），两个方向都要查；无投影/无表时返回空数组，调用方降级。
 */
export function searchGraphChunkEdgeNeighbors(libraryPath: string, seedChunkIds: string[], perSeedLimit: number): GraphChunkEdgeNeighbor[] {
  if (seedChunkIds.length === 0) return [];
  const limit = Math.max(1, Math.floor(perSeedLimit) || 1);
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return [];
  try {
    if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(graphChunkEdgesTableName)) return [];
    const query = database.prepare(`
      SELECT neighborChunkId, weight FROM (
        SELECT chunk_id_b AS neighborChunkId, weight FROM ${graphChunkEdgesTableName} WHERE chunk_id_a = ?
        UNION ALL
        SELECT chunk_id_a AS neighborChunkId, weight FROM ${graphChunkEdgesTableName} WHERE chunk_id_b = ?
      )
      ORDER BY weight DESC, neighborChunkId ASC
      LIMIT ?
    `);
    const neighbors: GraphChunkEdgeNeighbor[] = [];
    for (const seedChunkId of seedChunkIds) {
      const rows = query.all(seedChunkId, seedChunkId, limit) as Array<{ neighborChunkId: string; weight: number }>;
      for (const row of rows) {
        neighbors.push({ seedChunkId, neighborChunkId: row.neighborChunkId, weight: Number(row.weight) || 1 });
      }
    }
    return neighbors;
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function graphTablesExist(database: Database.Database): boolean {
  for (const tableName of [graphMetaTableName, graphEntitiesTableName, graphRelationsTableName, graphCommunitiesTableName, graphEntitiesFtsTableName]) {
    const found = database.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(tableName);
    if (!found) return false;
  }
  return true;
}

function readGraphProjectionCounts(database: Database.Database): { entities: number; relations: number; communities: number; chunkEdges: number; fts: number } {
  const entities = database.prepare(`SELECT COUNT(*) AS count FROM ${graphEntitiesTableName}`).get() as { count: number };
  const relations = database.prepare(`SELECT COUNT(*) AS count FROM ${graphRelationsTableName}`).get() as { count: number };
  const communities = database.prepare(`SELECT COUNT(*) AS count FROM ${graphCommunitiesTableName}`).get() as { count: number };
  const chunkEdges = database.prepare(`SELECT COUNT(*) AS count FROM ${graphChunkEdgesTableName}`).get() as { count: number };
  const fts = database.prepare(`SELECT COUNT(*) AS count FROM ${graphEntitiesFtsTableName}`).get() as { count: number };
  return {
    entities: Number(entities.count) || 0,
    relations: Number(relations.count) || 0,
    communities: Number(communities.count) || 0,
    chunkEdges: Number(chunkEdges.count) || 0,
    fts: Number(fts.count) || 0,
  };
}

function readGraphMetaMap(database: Database.Database): Record<string, string> {
  const rows = database.prepare(`SELECT key, value FROM ${graphMetaTableName}`).all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

function readGraphArtifacts(graphPath: string): { entities: EntityRow[]; relations: RelationRow[] } {
  const entities: EntityRow[] = [];
  const relations: RelationRow[] = [];
  const seenEntities = new Set<string>();
  const seenRelations = new Set<string>();
  forEachJsonLine(graphPath, (record, lineNumber) => {
    if (record.kind === 'node') {
      const canonicalKey = requiredString(record.canonicalKey, `第 ${lineNumber} 行节点缺少 canonicalKey。`);
      if (seenEntities.has(canonicalKey)) failInvalid(`图谱产物存在重复实体：${canonicalKey}。`);
      seenEntities.add(canonicalKey);
      entities.push({
        canonicalKey,
        mention: typeof record.mention === 'string' && record.mention ? record.mention : canonicalKey,
        type: typeof record.type === 'string' && record.type ? record.type : 'concept',
        description: typeof record.description === 'string' ? record.description : '',
        degree: toNonNegativeInteger(record.degree),
        docIdsJson: JSON.stringify(toStringArray(record.docIds)),
        chunkIdsJson: JSON.stringify(toStringArray(record.chunkIds)),
        communityId: typeof record.communityId === 'string' ? record.communityId : '',
      });
    } else if (record.kind === 'edge') {
      const sourceKey = requiredString(record.sourceKey, `第 ${lineNumber} 行边缺少 sourceKey。`);
      const targetKey = requiredString(record.targetKey, `第 ${lineNumber} 行边缺少 targetKey。`);
      if (!seenEntities.has(sourceKey) || !seenEntities.has(targetKey)) {
        failInvalid(`图谱产物边引用了未知实体：${sourceKey} → ${targetKey}。`);
      }
      const relationKey = `${sourceKey}\u0000${targetKey}`;
      if (seenRelations.has(relationKey)) failInvalid(`图谱产物存在重复边：${sourceKey} → ${targetKey}。`);
      seenRelations.add(relationKey);
      const chunkIds = toStringArray(record.chunkIds);
      const supportChunkCount = record.supportChunkCount === undefined
        ? chunkIds.length
        : toNonNegativeInteger(record.supportChunkCount);
      if (supportChunkCount !== chunkIds.length) {
        failInvalid(`图谱产物边支持块计数不一致：${sourceKey} → ${targetKey}。`);
      }
      relations.push({
        sourceKey,
        targetKey,
        weight: Math.max(1, toNonNegativeInteger(record.weight)),
        pmi: toNonNegativeNumber(record.pmi),
        strengthMean: Math.min(10, Math.max(1, toFiniteNumber(record.strengthMean, 1))),
        strengthSampleCount: Math.max(1, toNonNegativeInteger(record.strengthSampleCount)),
        supportChunkCount,
        supportDocCount: toNonNegativeInteger(record.supportDocCount),
        kindsJson: JSON.stringify(toStringArray(record.kinds)),
        description: typeof record.description === 'string' ? record.description : '',
        chunkIdsJson: JSON.stringify(chunkIds),
      });
    } else {
      failInvalid(`图谱产物第 ${lineNumber} 行的 kind 无效。`);
    }
  });
  return { entities, relations };
}

function readCommunityArtifacts(communitiesPath: string): CommunityRow[] {
  const communities: CommunityRow[] = [];
  const seen = new Set<string>();
  forEachJsonLine(communitiesPath, (record, lineNumber) => {
    const communityId = requiredString(record.communityId, `第 ${lineNumber} 行社区缺少 communityId。`);
    if (seen.has(communityId)) failInvalid(`图谱产物存在重复社区：${communityId}。`);
    seen.add(communityId);
    const memberKeys = toStringArray(record.memberKeys);
    communities.push({
      communityId,
      level: toNonNegativeInteger(record.level),
      parentId: typeof record.parentId === 'string' && record.parentId ? record.parentId : null,
      memberCount: memberKeys.length,
      memberKeysJson: JSON.stringify(memberKeys),
      tokens: toNonNegativeInteger(record.tokens),
    });
  });
  return communities;
}

/**
 * chunk 边产物（chunk_edges.jsonl）：文件缺失视为 0 条（兼容旧手构产物），
 * 但存在时必须合法且行数与 report 计数一致。
 */
function readChunkEdgeArtifacts(chunkEdgesPath: string): ChunkEdgeRow[] {
  if (!fs.existsSync(chunkEdgesPath)) return [];
  const chunkEdges: ChunkEdgeRow[] = [];
  const seen = new Set<string>();
  forEachJsonLine(chunkEdgesPath, (record, lineNumber) => {
    const chunkIdA = requiredString(record.chunkIdA, `第 ${lineNumber} 行 chunk 边缺少 chunkIdA。`);
    const chunkIdB = requiredString(record.chunkIdB, `第 ${lineNumber} 行 chunk 边缺少 chunkIdB。`);
    if (chunkIdA === chunkIdB) failInvalid(`图谱产物 chunk 边两端相同：${chunkIdA}。`);
    const pairKey = `${chunkIdA}\u0000${chunkIdB}`;
    if (seen.has(pairKey)) failInvalid(`图谱产物存在重复 chunk 边：${chunkIdA} ↔ ${chunkIdB}。`);
    seen.add(pairKey);
    chunkEdges.push({
      chunkIdA,
      chunkIdB,
      weight: Math.max(1, toNonNegativeInteger(record.weight)),
    });
  });
  return chunkEdges;
}

function forEachJsonLine(filePath: string, callback: (record: Record<string, unknown>, lineNumber: number) => void): void {
  if (!fs.existsSync(filePath)) failInvalid(`图谱产物缺失：${filePath}`);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let lineNumber = 0;
  for (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      failInvalid(`图谱产物第 ${lineNumber} 行 JSON 无效。`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) failInvalid(`图谱产物第 ${lineNumber} 行必须是对象。`);
    callback(value as Record<string, unknown>, lineNumber);
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) failInvalid(message);
  return value;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toNonNegativeNumber(value: unknown): number {
  const number = toFiniteNumber(value, 0);
  return number >= 0 ? number : 0;
}

function failInvalid(message: string): never {
  throw new PipelineStageError('GRAPH_PROJECTION_INPUT_INVALID', message, false);
}
