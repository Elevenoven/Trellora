import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { estimateTokenCount } from '../knowledge/tokenEstimator';
import { PipelineStageError } from './stageErrors';
import { openGraphDatabase } from './graphProjection';

const sqliteVec = require('sqlite-vec') as { load(database: Database.Database): void };

export const GRAPH_VECTOR_SCHEMA_VERSION = 1;
/** 实体向量文本 = 「mention」（type）：description，截断上限（与摘要同口径的 token 估算）。 */
export const GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS = 800;
/** 社区向量文本 = 摘要文本；摘要本身有预算，但仍截断以适配 embedding 模型上下文。 */
export const GRAPH_COMMUNITY_VECTOR_TEXT_MAX_TOKENS = 800;
const GRAPH_VECTOR_BATCH_SIZE = 16;

const entityVectorTableName = 'graph_entity_vec';
const communityVectorTableName = 'graph_community_vec';
/**
 * 向量复用缓存（优化方案 P1-5 最小场景）：单文档重解析触发图重建时，
 * 未变化的实体/社区直接复用旧向量，只对变化项调 embedding，避免全量重嵌入。
 * 缓存是普通表，不随 replaceGraphProjection 的图重建清空；仅随投影清理删除。
 */
const entityVectorCacheTableName = 'graph_entity_vec_cache';
const communityVectorCacheTableName = 'graph_community_vec_cache';

export interface GraphVectorIndexBuildInput {
  libraryPath: string;
  graphKey: string;
  /** sha256(graphKey + 模型指纹)；图重建整体失效，模型指纹变化只失效向量。 */
  vectorKey: string;
  modelFingerprint: string;
  vectorDimension: number;
  /** 注入式批量 embedding（与向量阶段同模式，Worker 永不持钥）。 */
  callEmbed: (texts: string[]) => Promise<number[][]>;
  signal?: AbortSignal;
}

export interface GraphVectorIndexBuildResult {
  vectorKey: string;
  entityVectors: number;
  communityVectors: number;
  /** 命中缓存复用的向量数（优化方案 P1-5）；未命中的才实际调 embedding。 */
  entityVectorsReused: number;
  communityVectorsReused: number;
  dimension: number;
  durationMs: number;
}

export interface GraphEntityVectorNeighbor {
  rowId: number;
  canonicalKey: string;
  mention: string;
  type: string;
  distance: number;
}

export interface GraphCommunityVectorNeighbor {
  rowId: number;
  communityId: string;
  level: number;
  distance: number;
}

/** 与 summaryKey 同口径：sha256 of JSON。 */
export function computeGraphVectorKey(input: { graphKey: string; modelFingerprint: string }): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    schemaVersion: GRAPH_VECTOR_SCHEMA_VERSION,
    graphKey: input.graphKey,
    modelFingerprint: input.modelFingerprint,
  })).digest('hex');
}

export function buildGraphEntityVectorText(input: { mention: string; type: string; description: string }): string {
  const text = `「${input.mention}」（${input.type}）：${input.description}`.trim();
  return truncateToTokenBudget(text, GRAPH_ENTITY_VECTOR_TEXT_MAX_TOKENS);
}

/** 缓存判定：投影内向量键一致且两张向量表存在即命中（向量本体就在投影库内）。 */
export function isGraphVectorIndexCurrent(libraryPath: string, vectorKey: string): boolean {
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return false;
  try {
    const storedKey = readGraphMetaValue(database, 'vectorKey');
    if (storedKey !== vectorKey || !storedKey) return false;
    return tableExists(database, entityVectorTableName) && tableExists(database, communityVectorTableName);
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/**
 * 从投影读取实体与社区（摘要非空），批量 embedding 后整体重建两张向量表。
 * rowid 与 graph_entities / graph_communities 对齐，供别名裁决召回做 KNN join。
 */
export async function buildGraphVectorIndex(input: GraphVectorIndexBuildInput): Promise<GraphVectorIndexBuildResult> {
  const startedAt = Date.now();
  const database = openGraphDatabase(input.libraryPath, false);
  if (!database) {
    throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', '图谱投影缺失，无法建立图向量索引。', true);
  }
  try {
    if (!tableExists(database, 'graph_entities') || !tableExists(database, 'graph_communities')) {
      throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', '图谱投影表缺失，无法建立图向量索引。', true);
    }
    const entityRows = database.prepare(`
      SELECT rowid AS rowid, canonical_key, mention, type, description
      FROM graph_entities ORDER BY rowid
    `).all() as Array<{ rowid: number; canonical_key: string; mention: string; type: string; description: string }>;
    const communityRows = database.prepare(`
      SELECT rowid AS rowid, community_id, summary
      FROM graph_communities WHERE summary != '' ORDER BY rowid
    `).all() as Array<{ rowid: number; community_id: string; summary: string }>;

    const entityItems: Array<{ rowid: number; cacheKey: string; text: string }> = entityRows
      .map((row) => ({
        rowid: Number(row.rowid),
        cacheKey: row.canonical_key,
        text: buildGraphEntityVectorText({ mention: row.mention, type: row.type, description: row.description }),
      }))
      .filter((item) => item.cacheKey !== '' && item.text.length > 0);
    const communityItems: Array<{ rowid: number; cacheKey: string; text: string }> = communityRows
      .map((row) => ({
        rowid: Number(row.rowid),
        cacheKey: row.community_id,
        text: truncateToTokenBudget(String(row.summary).trim(), GRAPH_COMMUNITY_VECTOR_TEXT_MAX_TOKENS),
      }))
      .filter((item) => item.cacheKey !== '' && item.text.length > 0);

    // 增量复用（优化方案 P1-5 最小场景）：向量文本未变的实体/社区直接取缓存向量，
    // 单文档重解析触发的图重建只对变化项调 embedding。
    const expectedCacheBytes = input.vectorDimension * 4;
    const entityPlan = resolveVectorReuse(database, entityVectorCacheTableName, entityItems, expectedCacheBytes);
    const communityPlan = resolveVectorReuse(database, communityVectorCacheTableName, communityItems, expectedCacheBytes);
    const entityBuffers = await embedQueuedVectors(entityPlan.queue, entityPlan.buffers, input);
    const communityBuffers = await embedQueuedVectors(communityPlan.queue, communityPlan.buffers, input);

    loadGraphSqliteVec(database);
    // vec0 虚拟表的 CREATE/DROP 不支持在事务内执行；只有插入与 meta 写入走事务。
    database.exec(`DROP TABLE IF EXISTS ${entityVectorTableName}`);
    database.exec(`DROP TABLE IF EXISTS ${communityVectorTableName}`);
    database.exec(`CREATE VIRTUAL TABLE ${entityVectorTableName} USING vec0(embedding float[${input.vectorDimension}] distance_metric=cosine)`);
    database.exec(`CREATE VIRTUAL TABLE ${communityVectorTableName} USING vec0(embedding float[${input.vectorDimension}] distance_metric=cosine)`);
    database.exec(`CREATE TABLE IF NOT EXISTS ${entityVectorCacheTableName} (cache_key TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL)`);
    database.exec(`CREATE TABLE IF NOT EXISTS ${communityVectorCacheTableName} (cache_key TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL)`);
    database.transaction(() => {
      const insertEntity = database.prepare(`INSERT INTO ${entityVectorTableName}(rowid, embedding) VALUES (?, ?)`);
      // vec0 的 rowid 列要求整数主键：与 materialVectorCoordinator 同口径，用 BigInt 绑定。
      entityItems.forEach((item, index) => insertEntity.run(BigInt(item.rowid), entityBuffers[index]));
      const insertCommunity = database.prepare(`INSERT INTO ${communityVectorTableName}(rowid, embedding) VALUES (?, ?)`);
      communityItems.forEach((item, index) => insertCommunity.run(BigInt(item.rowid), communityBuffers[index]));
      writeVectorCache(database, entityVectorCacheTableName, entityItems, entityBuffers);
      writeVectorCache(database, communityVectorCacheTableName, communityItems, communityBuffers);
      upsertGraphMeta(database, 'vectorKey', input.vectorKey);
      upsertGraphMeta(database, 'vectorModelFingerprint', input.modelFingerprint);
      upsertGraphMeta(database, 'vectorDimension', String(input.vectorDimension));
      upsertGraphMeta(database, 'vectorEntityCoverage', String(entityItems.length));
      upsertGraphMeta(database, 'vectorCommunityCoverage', String(communityItems.length));
      upsertGraphMeta(database, 'vectorCoverage', String(entityItems.length + communityItems.length));
      upsertGraphMeta(database, 'vectorGeneratedAt', new Date().toISOString());
    })();

    return {
      vectorKey: input.vectorKey,
      entityVectors: entityItems.length,
      communityVectors: communityItems.length,
      entityVectorsReused: entityPlan.reused,
      communityVectorsReused: communityPlan.reused,
      dimension: input.vectorDimension,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `图向量索引建立失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    database.close();
  }
}

/** 实体向量 KNN：join 投影实体表回读 canonicalKey/mention/type；索引缺失或维度不符返回空。 */
export function queryGraphEntityVectorNeighbors(libraryPath: string, queryVector: number[], limit: number, profileHash?: string): GraphEntityVectorNeighbor[] {
  return queryGraphVectorNeighbors(database => database.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance, e.canonical_key, e.mention, e.type
    FROM ${entityVectorTableName} v
    JOIN graph_entities e ON e.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
    LIMIT ?
  `), libraryPath, queryVector, limit, profileHash).map((row) => ({
    rowId: row.rowId,
    canonicalKey: String(row.canonical_key ?? ''),
    mention: String(row.mention ?? ''),
    type: String(row.type ?? ''),
    distance: row.distance,
  }));
}

/** 社区向量 KNN：join 投影社区表回读 communityId/level；索引缺失或维度不符返回空。 */
export function queryGraphCommunityVectorNeighbors(libraryPath: string, queryVector: number[], limit: number, profileHash?: string): GraphCommunityVectorNeighbor[] {
  return queryGraphVectorNeighbors(database => database.prepare(`
    SELECT v.rowid AS rowid, v.distance AS distance, c.community_id, c.level
    FROM ${communityVectorTableName} v
    JOIN graph_communities c ON c.rowid = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
    LIMIT ?
  `), libraryPath, queryVector, limit, profileHash).map((row) => ({
    rowId: row.rowId,
    communityId: String((row as Record<string, unknown>).community_id ?? ''),
    level: Number((row as Record<string, unknown>).level) || 0,
    distance: row.distance,
  }));
}

function queryGraphVectorNeighbors(
  prepareStatement: (database: Database.Database) => Database.Statement,
  libraryPath: string,
  queryVector: number[],
  limit: number,
  profileHash?: string,
): Array<{ rowId: number; distance: number } & Record<string, unknown>> {
  if (!Array.isArray(queryVector) || queryVector.length === 0 || !Number.isFinite(limit) || limit <= 0) return [];
  const database = openGraphDatabase(libraryPath, false);
  if (!database) return [];
  try {
    if (profileHash && readGraphMetaValue(database, 'vectorModelFingerprint') !== profileHash) return [];
    if (Number(readGraphMetaValue(database, 'vectorDimension')) !== queryVector.length) return [];
    loadGraphSqliteVec(database);
    const rows = prepareStatement(database).all(toVectorBuffer(queryVector), Math.floor(limit), Math.floor(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, rowId: Number(row.rowid), distance: Number(row.distance) }));
  } catch {
    return [];
  } finally {
    database.close();
  }
}

/** 待嵌入队列回填：只对未命中缓存的项分批调 embedding，结果写回对应槽位。 */
async function embedQueuedVectors(
  queue: Array<{ slot: number; item: { rowid: number; text: string } }>,
  buffers: Buffer[],
  input: GraphVectorIndexBuildInput,
): Promise<Buffer[]> {
  if (queue.length === 0) return buffers;
  const vectors = await embedItems(queue.map((entry) => ({ rowid: entry.item.rowid, text: entry.item.text })), input);
  queue.forEach((entry, index) => {
    buffers[entry.slot] = toVectorBuffer(vectors[index]);
  });
  return buffers;
}

async function embedItems(items: Array<{ rowid: number; text: string }>, input: GraphVectorIndexBuildInput): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < items.length; start += GRAPH_VECTOR_BATCH_SIZE) {
    if (input.signal?.aborted) throw new PipelineStageError('GRAPH_VECTOR_INDEX_CANCELLED', '图向量索引已取消。', true);
    const batch = items.slice(start, start + GRAPH_VECTOR_BATCH_SIZE);
    const batchVectors = await input.callEmbed(batch.map((item) => item.text));
    if (!Array.isArray(batchVectors) || batchVectors.length !== batch.length) {
      throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `embedding 返回 ${Array.isArray(batchVectors) ? batchVectors.length : 0} 条向量，与批内 ${batch.length} 条文本不一致。`, true);
    }
    for (const vector of batchVectors) {
      if (!Array.isArray(vector) || vector.length !== input.vectorDimension
        || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new PipelineStageError('GRAPH_VECTOR_INDEX_FAILED', `embedding 返回维度错误或含非有限值（期望维度 ${input.vectorDimension}）。`, true);
      }
      vectors.push(vector);
    }
  }
  return vectors;
}

/**
 * 缓存复用拆分（优化方案 P1-5）：cacheKey 命中且向量文本哈希一致、字节数与当前维度
 * 匹配才复用；其余进待嵌入队列。缓存表缺失/损坏时静默降级为全量嵌入。
 */
function resolveVectorReuse(
  database: Database.Database,
  cacheTableName: string,
  items: Array<{ cacheKey: string; text: string }>,
  expectedBytes: number,
): { buffers: Buffer[]; queue: Array<{ slot: number; item: { rowid: number; text: string } & { cacheKey: string } }>; reused: number } {
  const cache = readVectorCache(database, cacheTableName);
  const buffers: Buffer[] = new Array(items.length);
  const queue: Array<{ slot: number; item: { rowid: number; text: string } & { cacheKey: string } }> = [];
  let reused = 0;
  items.forEach((item, index) => {
    const cached = cache.get(item.cacheKey);
    const textHash = hashVectorText(item.text);
    if (cached && cached.textHash === textHash && Buffer.isBuffer(cached.embedding) && cached.embedding.byteLength === expectedBytes) {
      buffers[index] = cached.embedding;
      reused += 1;
      return;
    }
    queue.push({ slot: index, item: item as { rowid: number; text: string } & { cacheKey: string } });
  });
  return { buffers, queue, reused };
}

function readVectorCache(database: Database.Database, cacheTableName: string): Map<string, { textHash: string; embedding: Buffer }> {
  const cache = new Map<string, { textHash: string; embedding: Buffer }>();
  try {
    if (!tableExists(database, cacheTableName)) return cache;
    const rows = database.prepare(`SELECT cache_key AS cacheKey, text_hash AS textHash, embedding FROM ${cacheTableName}`).all() as Array<{ cacheKey: string; textHash: string; embedding: Buffer }>;
    for (const row of rows) {
      if (typeof row.cacheKey === 'string' && row.cacheKey && typeof row.textHash === 'string') {
        cache.set(row.cacheKey, { textHash: row.textHash, embedding: row.embedding });
      }
    }
  } catch {
    cache.clear();
  }
  return cache;
}

/** 事务内全量重写缓存：与当次索引内容对齐，已删除实体/社区的向量随之废弃。 */
function writeVectorCache(
  database: Database.Database,
  cacheTableName: string,
  items: Array<{ cacheKey: string; text: string }>,
  buffers: Buffer[],
): void {
  database.prepare(`DELETE FROM ${cacheTableName}`).run();
  const insert = database.prepare(`INSERT INTO ${cacheTableName} (cache_key, text_hash, embedding) VALUES (?, ?, ?)`);
  items.forEach((item, index) => insert.run(item.cacheKey, hashVectorText(item.text), buffers[index]));
}

function hashVectorText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  let slice = text;
  while (estimateTokenCount(slice) > maxTokens && slice.length > 0) {
    const ratio = maxTokens / Math.max(1, estimateTokenCount(slice));
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * ratio)));
  }
  return slice;
}

function toVectorBuffer(values: number[]): Buffer {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
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

function tableExists(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type IN (?, ?) AND name = ?').get('table', 'view', tableName));
}

function readGraphMetaValue(database: Database.Database, key: string): string {
  if (!tableExists(database, 'graph_meta')) return '';
  const row = database.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function upsertGraphMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`
    INSERT INTO graph_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
