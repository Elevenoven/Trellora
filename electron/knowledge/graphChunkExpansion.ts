import type Database from 'better-sqlite3';
import { openGraphDatabase, searchGraphChunkEdgeNeighbors } from '../pipeline/graphProjection';
import type { HybridChildFusion } from './hybridRetrievalFusion';

/** 图扩展预算（优化方案 P0-2）：融合结果 Top-10 作种子，每种子最多 2 个邻居，总量封顶 6 条新块。 */
export const GRAPH_EXPANSION_SEED_LIMIT = 10;
export const GRAPH_EXPANSION_PER_SEED_LIMIT = 2;
export const GRAPH_EXPANSION_TOTAL_LIMIT = 6;
/** 一跳补充的距离衰减；补充块合成 rrf 分 = 种子 rrf × (边权/10) × 衰减。 */
export const GRAPH_EXPANSION_DECAY = 0.5;
/** 图装配阶段已把关系权重归一化到 1~10（P0-1），chunk 边权同尺度。 */
const GRAPH_WEIGHT_SCALE_MAX = 10;

/** 图扩展补充块的种子归因（优化方案 P2-7）：遥测回答“补了几条、来自哪些种子”。 */
export interface GraphExpansionContribution {
  seedChunkId: string;
  chunkId: string;
  edgeWeight: number;
  rrfScore: number;
}

export interface GraphExpansionOutcome {
  children: HybridChildFusion[];
  /** 实际作为种子参与一跳查询的子块数。 */
  seedCount: number;
  addedChildren: number;
  /** 每个补充块的种子来源；实体化失败被跳过时同步剔除。 */
  contributions: GraphExpansionContribution[];
}

/**
 * 图通道扩展（优化方案 P0-2）：RRF 融合后以 Top-N 子块为种子，在 chunk 级图投影上一跳
 * 补召回，只补充主召回未见过的块（WeKnora filterSeenChunk 语义），并给出可解释的合成
 * rrf 分（种子分 × 归一边权 × 距离衰减），绝不高于种子本身。
 * 无投影/无 chunk 边表/读取失败时静默降级为空，不阻塞主召回。
 */
export function expandHybridChildrenViaGraph(input: { libraryPath: string; children: HybridChildFusion[] }): GraphExpansionOutcome {
  if (input.children.length === 0) return { children: [], seedCount: 0, addedChildren: 0, contributions: [] };
  const seeds = [...input.children]
    .sort((first, second) => second.rrfScore - first.rrfScore)
    .slice(0, GRAPH_EXPANSION_SEED_LIMIT);
  const neighbors = searchGraphChunkEdgeNeighbors(
    input.libraryPath,
    seeds.map((seed) => seed.chunkId),
    GRAPH_EXPANSION_PER_SEED_LIMIT,
  );
  if (neighbors.length === 0) return { children: [], seedCount: seeds.length, addedChildren: 0, contributions: [] };

  const seen = new Set(input.children.map((child) => child.chunkId));
  const accepted = new Set<string>();
  const pickedBySeed = new Map<string, number>();
  const picked: Array<{ neighborChunkId: string; weight: number; seed: HybridChildFusion }> = [];
  for (const seed of seeds) {
    if (picked.length >= GRAPH_EXPANSION_TOTAL_LIMIT) break;
    for (const neighbor of neighbors) {
      if (neighbor.seedChunkId !== seed.chunkId) continue;
      const perSeed = pickedBySeed.get(seed.chunkId) ?? 0;
      if (perSeed >= GRAPH_EXPANSION_PER_SEED_LIMIT) break;
      if (seen.has(neighbor.neighborChunkId) || accepted.has(neighbor.neighborChunkId)) continue;
      if (picked.length >= GRAPH_EXPANSION_TOTAL_LIMIT) break;
      accepted.add(neighbor.neighborChunkId);
      picked.push({ neighborChunkId: neighbor.neighborChunkId, weight: neighbor.weight, seed });
      pickedBySeed.set(seed.chunkId, perSeed + 1);
    }
  }
  if (picked.length === 0) return { children: [], seedCount: seeds.length, addedChildren: 0, contributions: [] };

  const materialized = materializeGraphChildren(input.libraryPath, picked);
  return {
    children: materialized.children,
    seedCount: seeds.length,
    addedChildren: materialized.children.length,
    contributions: materialized.contributions,
  };
}

interface ChunkMaterialRow {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionPathJson: string;
  sectionContext: string;
  sourceRefsJson: string;
  contentHash: string;
}

interface ParentMaterialRow {
  documentId: string;
  parentChunkId: string;
  ordinal: number;
  text: string;
  sourceText: string;
  sourceRefsJson: string;
}

/** 把选中的邻居 chunk 回 material_chunks 实体化为带引用的子块行（引用必须指向原始 Chunk）。 */
function materializeGraphChildren(
  libraryPath: string,
  picked: Array<{ neighborChunkId: string; weight: number; seed: HybridChildFusion }>,
): { children: HybridChildFusion[]; contributions: GraphExpansionContribution[] } {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return { children: [], contributions: [] };
  try {
    if (!materialTablesExist(database)) return { children: [], contributions: [] };
    const chunkIds = picked.map((entry) => entry.neighborChunkId);
    const placeholders = chunkIds.map(() => '?').join(', ');
    const chunkRows = database.prepare(`
      SELECT document_id AS documentId, chunk_id AS chunkId, parent_chunk_id AS parentChunkId,
             ordinal, text, source_text AS sourceText, section_path_json AS sectionPathJson,
             section_context AS sectionContext, source_refs_json AS sourceRefsJson, content_hash AS contentHash
      FROM material_chunks
      WHERE chunk_id IN (${placeholders})
    `).all(...chunkIds) as ChunkMaterialRow[];
    if (chunkRows.length === 0) return { children: [], contributions: [] };
    const chunkByKey = new Map(chunkRows.map((row) => [`${row.documentId}\u0000${row.chunkId}`, row]));

    const parentIdsByDocument = new Map<string, string[]>();
    for (const row of chunkRows) {
      if (!row.parentChunkId) continue;
      const list = parentIdsByDocument.get(row.documentId) ?? [];
      if (!list.includes(row.parentChunkId)) list.push(row.parentChunkId);
      parentIdsByDocument.set(row.documentId, list);
    }
    const parentByKey = new Map<string, ParentMaterialRow>();
    for (const [documentId, parentIds] of parentIdsByDocument) {
      const parentPlaceholders = parentIds.map(() => '?').join(', ');
      const parentRows = database.prepare(`
        SELECT document_id AS documentId, parent_chunk_id AS parentChunkId, ordinal,
               text, source_text AS sourceText, source_refs_json AS sourceRefsJson
        FROM material_chunk_parents
        WHERE document_id = ? AND parent_chunk_id IN (${parentPlaceholders})
      `).all(documentId, ...parentIds) as ParentMaterialRow[];
      for (const parent of parentRows) parentByKey.set(`${parent.documentId}\u0000${parent.parentChunkId}`, parent);
    }

    const children: HybridChildFusion[] = [];
    const contributions: GraphExpansionContribution[] = [];
    for (const entry of picked) {
      // 同一 chunkId 理论上全局唯一，但仍按 (document, chunk) 精确匹配，缺失即跳过。
      const row = [...chunkByKey.values()].find((candidate) => candidate.chunkId === entry.neighborChunkId);
      if (!row) continue;
      const parent = row.parentChunkId ? parentByKey.get(`${row.documentId}\u0000${row.parentChunkId}`) : undefined;
      const rrfScore = Number((entry.seed.rrfScore * (entry.weight / GRAPH_WEIGHT_SCALE_MAX) * GRAPH_EXPANSION_DECAY).toFixed(6));
      children.push({
        documentId: row.documentId,
        chunkId: row.chunkId,
        parentChunkId: row.parentChunkId,
        ordinal: row.ordinal,
        text: row.text,
        sectionPath: parseJsonArray(row.sectionPathJson),
        sectionContext: row.sectionContext,
        contentHash: row.contentHash,
        score: rrfScore,
        bm25Score: 0,
        keywordScore: 0,
        vectorScore: 0,
        rrfScore,
        ranks: {},
        matchTypes: ['图扩展'],
        citation: {
          documentId: row.documentId,
          chunkId: row.chunkId,
          parentChunkId: row.parentChunkId,
          contentHash: row.contentHash,
          text: row.text,
          sourceText: row.sourceText,
          sectionContext: row.sectionContext,
          sourceRefs: parseJsonArray(row.sourceRefsJson),
          ...(parent ? {
            parent: {
              chunkId: parent.parentChunkId,
              ordinal: parent.ordinal,
              text: parent.text,
              sourceText: parent.sourceText,
              sourceRefs: parseJsonArray(parent.sourceRefsJson),
            },
          } : {}),
        },
      });
      contributions.push({
        seedChunkId: entry.seed.chunkId,
        chunkId: row.chunkId,
        edgeWeight: entry.weight,
        rrfScore,
      });
    }
    return { children, contributions };
  } catch {
    return { children: [], contributions: [] };
  } finally {
    database.close();
  }
}

function materialTablesExist(database: Database.Database): boolean {
  for (const tableName of ['material_chunks', 'material_chunk_parents']) {
    if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(tableName)) return false;
  }
  return true;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
