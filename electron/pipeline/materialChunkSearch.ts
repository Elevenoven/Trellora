import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { LEXICAL_KEYWORD_BOOST, RRF_RANK_CONSTANT, reciprocalRankFusion, type RrfChannelEntry } from '../knowledge/hybridRetrievalFusion';
import { PipelineStageError } from './stageErrors';
import { scoreLexicalCandidates, type LexicalCorpusStats, type LexicalScoreBreakdown, type LexicalTermDf } from './lexicalScorer';
import { readMaterialEmbeddingProfile, readMaterialEmbeddingProfileFromDatabase } from './materialEmbeddingProfile';
import type { MaterialEmbeddingAdapter as ProfileEmbeddingAdapter } from './materialEmbeddingAdapters';
import type { MaterialEmbeddingProfile, MaterialEmbeddingProfileStatus } from './materialEmbeddingTypes';
import { getActiveMaterialVectorTable } from './materialVectorGenerationStore';

const materialDocumentTableName = 'material_chunk_documents';
const materialChunkTableName = 'material_chunks';
const materialParentTableName = 'material_chunk_parents';
const materialFtsTableName = 'material_chunk_fts';
const materialPostingsTableName = 'material_term_postings';
const materialLexicalStatsTableName = 'material_lexical_stats';
const materialVectorMetaTableName = 'material_chunk_vector_meta';
const vectorBatchSize = 16;
// FTS5 的 bm25 权重按虚表列顺序传入；前两列为 UNINDEXED 标识列。
const materialFtsBm25Expression = `bm25(${materialFtsTableName}, 0.0, 0.0, 1.0, 4.0, 0.5)`;
// FTS 名次分数与 RRF 共用同一个名次常数，避免两处字面量漂移（优化方案 P2-8）。
const materialFtsFallbackScore = 0.65;

const sqliteVec = require('sqlite-vec') as { load(database: Database.Database): void };

export type MaterialChunkSearchMode = 'hybrid' | 'keyword' | 'semantic';
export type MaterialChunkFusion = 'weighted' | 'rrf';

export interface MaterialChunkProjectionRecord {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  /** 供引用与原文保全使用；检索仍使用带章节上下文的 text。 */
  sourceText: string;
  sectionPath: unknown[];
  sectionContext: string;
  sourceRefs: unknown[];
  contentHash: string;
  /** Jieba 预分词结果；SQLite FTS5 只负责对空格分隔词元建立倒排。 */
  searchTokens: string[];
}

export interface MaterialChunkParentProjectionRecord {
  documentId: string;
  parentChunkId: string;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionPath: unknown[];
  sectionContext: string;
  sourceRefs: unknown[];
  contentHash: string;
}

export interface MaterialChunkProjectionKeyword {
  chunkId: string;
  surfaceTerm: string;
  normalizedTerm: string;
  score: number;
}

export interface MaterialChunkCitationParent {
  chunkId: string;
  ordinal: number;
  text: string;
  sourceText: string;
  sourceRefs: unknown[];
}

export interface MaterialChunkCitation {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  contentHash: string;
  text: string;
  sourceText: string;
  sectionContext: string;
  sourceRefs: unknown[];
  parent?: MaterialChunkCitationParent;
}

export interface MaterialChunkSearchResult {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sectionPath: unknown[];
  sectionContext: string;
  contentHash: string;
  score: number;
  bm25Score: number;
  keywordScore: number;
  vectorScore: number;
  /** RRF 融合分；仅 fusion='rrf' 返回，此时 score 同值。 */
  rrfScore?: number;
  /** 双通道 1-based 名次；仅 fusion='rrf' 返回，供 trace 与父块聚合解释。 */
  ranks?: { vector?: number; lexical?: number };
  /** LexScore v2 自研打分分解；仅词法通道命中时返回。 */
  lexicalBreakdown?: LexicalScoreBreakdown;
  matchTypes: Array<'原文' | '关键词' | '语义' | '图扩展'>;
  citation: MaterialChunkCitation;
}

export interface MaterialChunkSearchOutcome {
  results: MaterialChunkSearchResult[];
  mode: MaterialChunkSearchMode;
  used: '综合搜索' | '关键词搜索' | '语义搜索';
  indexedChunks: number;
  vectorIndexed: boolean;
  notice?: string;
}

export interface MaterialChunkVectorResult {
  indexed: number;
  skipped: number;
  dimension: number;
  embeddingModel: string;
  completedAt: string;
}

export type MaterialEmbeddingAdapter = (input: { endpoint?: string; model: string; texts: string[]; timeoutMs?: number }) => Promise<number[][]>;

export function ensureMaterialChunkSearchSchema(database: Database.Database): void {
  loadSqliteVec(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${materialDocumentTableName} (
      document_id TEXT PRIMARY KEY,
      source_content_hash TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      keyword_count INTEGER NOT NULL CHECK (keyword_count >= 0),
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${materialChunkTableName} (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      parent_chunk_id TEXT,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      source_text TEXT NOT NULL DEFAULT '',
      section_path_json TEXT NOT NULL,
      section_context TEXT NOT NULL DEFAULT '',
      source_refs_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      keyword_text TEXT NOT NULL,
      UNIQUE (document_id, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_chunks_document ON ${materialChunkTableName}(document_id);
    CREATE INDEX IF NOT EXISTS idx_material_chunks_chunk ON ${materialChunkTableName}(chunk_id);
    CREATE TABLE IF NOT EXISTS ${materialParentTableName} (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      parent_chunk_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      source_text TEXT NOT NULL,
      section_path_json TEXT NOT NULL,
      section_context TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE (document_id, parent_chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_chunk_parents_document ON ${materialParentTableName}(document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${materialFtsTableName} USING fts5(
      document_id UNINDEXED,
      chunk_id UNINDEXED,
      text,
      keyword_text,
      section_path,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS ${materialPostingsTableName} (
      term TEXT NOT NULL,
      chunk_rowid INTEGER NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('body','keyword')),
      tf INTEGER NOT NULL CHECK (tf > 0),
      PRIMARY KEY (term, chunk_rowid, field)
    );
    CREATE INDEX IF NOT EXISTS idx_material_term_postings_chunk ON ${materialPostingsTableName}(chunk_rowid);
    CREATE TABLE IF NOT EXISTS ${materialLexicalStatsTableName} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${materialVectorMetaTableName} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureColumn(database, materialChunkTableName, 'source_text', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, materialChunkTableName, 'section_context', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, materialChunkTableName, 'lexical_body_len', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, materialChunkTableName, 'lexical_kw_len', 'INTEGER NOT NULL DEFAULT 0');
  database.prepare(`UPDATE ${materialChunkTableName} SET source_text = text WHERE source_text = ''`).run();
}

/** 在步骤7的同一 SQLite 事务中替换资料库 chunk 原文、FTS 和关键词字段投影。 */
export function replaceMaterialChunkProjection(database: Database.Database, input: {
  documentId: string;
  sourceContentHash: string;
  stageKey: string;
  chunks: MaterialChunkProjectionRecord[];
  parents?: MaterialChunkParentProjectionRecord[];
  keywords: MaterialChunkProjectionKeyword[];
}): void {
  ensureMaterialChunkSearchSchema(database);
  removeMaterialChunkProjection(database, input.documentId, false);

  const keywordTextByChunk = new Map<string, string[]>();
  const keywordTermsByChunk = new Map<string, Set<string>>();
  for (const keyword of input.keywords) {
    const terms = keywordTextByChunk.get(keyword.chunkId) ?? [];
    terms.push(keyword.surfaceTerm, keyword.normalizedTerm);
    keywordTextByChunk.set(keyword.chunkId, terms);
    const keywordTerms = keywordTermsByChunk.get(keyword.chunkId) ?? new Set<string>();
    if (keyword.surfaceTerm) keywordTerms.add(keyword.surfaceTerm);
    if (keyword.normalizedTerm) keywordTerms.add(keyword.normalizedTerm);
    keywordTermsByChunk.set(keyword.chunkId, keywordTerms);
  }

  const insertChunk = database.prepare(`
    INSERT INTO ${materialChunkTableName} (
      document_id, chunk_id, parent_chunk_id, ordinal, text,
      source_text, section_path_json, section_context, source_refs_json, content_hash, keyword_text,
      lexical_body_len, lexical_kw_len
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBodyPosting = database.prepare(`INSERT OR REPLACE INTO ${materialPostingsTableName} (term, chunk_rowid, field, tf) VALUES (?, ?, 'body', ?)`);
  const insertKeywordPosting = database.prepare(`INSERT OR REPLACE INTO ${materialPostingsTableName} (term, chunk_rowid, field, tf) VALUES (?, ?, 'keyword', 1)`);
  const insertFts = database.prepare(`
    INSERT INTO ${materialFtsTableName} (rowid, document_id, chunk_id, text, keyword_text, section_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const chunk of input.chunks) {
    const keywordText = [...new Set(keywordTextByChunk.get(chunk.chunkId) ?? [])].join(' ');
    const sectionPathText = extractSectionPathText(chunk.sectionPath);
    const bodyTf = countTermFrequencies(chunk.searchTokens);
    const keywordTerms = keywordTermsByChunk.get(chunk.chunkId) ?? new Set<string>();
    const result = insertChunk.run(
      input.documentId,
      chunk.chunkId,
      chunk.parentChunkId,
      chunk.ordinal,
      chunk.text,
      chunk.sourceText,
      JSON.stringify(chunk.sectionPath),
      chunk.sectionContext,
      JSON.stringify(chunk.sourceRefs),
      chunk.contentHash,
      keywordText,
      chunk.searchTokens.length,
      keywordTerms.size,
    );
    // 原文保存在 material_chunks；FTS text 列是可重建的 Jieba 词元投影。
    const ftsText = chunk.searchTokens.length > 0 ? chunk.searchTokens.join(' ') : chunk.text;
    insertFts.run(BigInt(result.lastInsertRowid), input.documentId, chunk.chunkId, ftsText, keywordText, sectionPathText);
    const rowId = Number(result.lastInsertRowid);
    for (const [term, tf] of bodyTf) insertBodyPosting.run(term, rowId, tf);
    for (const term of keywordTerms) insertKeywordPosting.run(term, rowId);
  }
  const insertParent = database.prepare(`
    INSERT INTO ${materialParentTableName} (
      document_id, parent_chunk_id, ordinal, text, source_text,
      section_path_json, section_context, source_refs_json, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const parent of input.parents ?? []) {
    insertParent.run(
      input.documentId,
      parent.parentChunkId,
      parent.ordinal,
      parent.text,
      parent.sourceText,
      JSON.stringify(parent.sectionPath),
      parent.sectionContext,
      JSON.stringify(parent.sourceRefs),
      parent.contentHash,
    );
  }
  database.prepare(`
    INSERT INTO ${materialDocumentTableName} (
      document_id, source_content_hash, stage_key, chunk_count, keyword_count, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.documentId,
    input.sourceContentHash,
    input.stageKey,
    input.chunks.length,
    input.keywords.length,
    new Date().toISOString(),
  );

  setLexicalStat(database, `backfilled:${input.documentId}`, '1');
  refreshLexicalStats(database);

  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${materialChunkTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
  const ftsRow = database.prepare(`SELECT COUNT(*) AS count FROM ${materialFtsTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
  const parentRow = database.prepare(`SELECT COUNT(*) AS count FROM ${materialParentTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
  if (Number(row.count) !== input.chunks.length || Number(ftsRow.count) !== input.chunks.length || Number(parentRow.count) !== (input.parents?.length ?? 0)) {
    throw new PipelineStageError('MATERIAL_INDEX_READBACK_FAILED', '资料库 chunk 检索投影读回核对失败，事务已回滚。', true);
  }
}

export function removeMaterialChunkProjection(database: Database.Database, documentId: string, ensureSchema = true): number {
  if (ensureSchema) ensureMaterialChunkSearchSchema(database);
  const rows = database.prepare(`SELECT id FROM ${materialChunkTableName} WHERE document_id = ?`).all(documentId) as Array<{ id: number }>;
  if (tableExists(database, materialPostingsTableName)) {
    const removePostings = database.prepare(`DELETE FROM ${materialPostingsTableName} WHERE chunk_rowid = ?`);
    for (const row of rows) removePostings.run(row.id);
  }
  if (tableExists(database, materialLexicalStatsTableName)) {
    database.prepare(`DELETE FROM ${materialLexicalStatsTableName} WHERE key = ?`).run(`backfilled:${documentId}`);
  }
  if (tableExists(database, getActiveMaterialVectorTable(database))) {
    const removeVector = database.prepare(`DELETE FROM ${getActiveMaterialVectorTable(database)} WHERE rowid = ?`);
    for (const row of rows) removeVector.run(BigInt(row.id));
  }
  // 向量批处理状态与任务属于资料库投影；删除文档时一并清理，但保留锁定的 profile。
  if (tableExists(database, 'material_chunk_embedding_state')) {
    database.prepare('DELETE FROM material_chunk_embedding_state WHERE document_id = ?').run(documentId);
  }
  if (tableExists(database, 'material_embedding_jobs')) {
    database.prepare('DELETE FROM material_embedding_jobs WHERE document_id = ?').run(documentId);
  }
  database.prepare(`DELETE FROM ${materialFtsTableName} WHERE document_id = ?`).run(documentId);
  database.prepare(`DELETE FROM ${materialChunkTableName} WHERE document_id = ?`).run(documentId);
  database.prepare(`DELETE FROM ${materialParentTableName} WHERE document_id = ?`).run(documentId);
  database.prepare(`DELETE FROM ${materialDocumentTableName} WHERE document_id = ?`).run(documentId);
  return rows.length;
}

export function isMaterialChunkProjectionCurrent(database: Database.Database, input: {
  documentId: string;
  sourceContentHash: string;
  stageKey: string;
  expectedChunks: number;
  expectedKeywords: number;
}): boolean {
  try {
    if (!tableExists(database, materialDocumentTableName) || !tableExists(database, materialChunkTableName) || !tableExists(database, materialFtsTableName)) return false;
    const status = database.prepare(`
      SELECT source_content_hash AS sourceContentHash, stage_key AS stageKey,
             chunk_count AS chunkCount, keyword_count AS keywordCount
      FROM ${materialDocumentTableName} WHERE document_id = ?
    `).get(input.documentId) as { sourceContentHash: string; stageKey: string; chunkCount: number; keywordCount: number } | undefined;
    if (!status || status.sourceContentHash !== input.sourceContentHash || status.stageKey !== input.stageKey) return false;
    const chunks = database.prepare(`SELECT COUNT(*) AS count FROM ${materialChunkTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
    const fts = database.prepare(`SELECT COUNT(*) AS count FROM ${materialFtsTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
    const keywords = database.prepare(`SELECT COUNT(*) AS count FROM ${'chunk_keywords'} WHERE document_id = ?`).get(input.documentId) as { count: number };
    return status.chunkCount === input.expectedChunks
      && status.keywordCount === input.expectedKeywords
      && Number(chunks.count) === input.expectedChunks
      && Number(fts.count) === input.expectedChunks
      && Number(keywords.count) === input.expectedKeywords;
  } catch {
    return false;
  }
}

export async function searchMaterialChunks(input: {
  libraryPath: string;
  query: string;
  /** 由同一 Python Worker/Jieba 配置生成；缺失时保留有界兼容回退。 */
  queryTerms?: string[];
  lexicalError?: string;
  mode?: MaterialChunkSearchMode;
  /** 融合策略：weighted 为旧版加权和（资料库搜索 UI），rrf 为助手专用路由的规范 RRF。 */
  fusion?: MaterialChunkFusion;
  documentIds?: string[];
  /** Wiki 节点作用域：仅召回 sectionPath 末位 nodeId 命中集合的 chunk；双通道原始结果融合前过滤。 */
  sectionNodeIds?: string[];
  limit?: number;
  /** Dedicated RAG first recalls child chunks; parent blocks are materialized afterwards. */
  childOnly?: boolean;
  adapter?: ProfileEmbeddingAdapter;
  embeddingError?: string;
  timeoutMs?: number;
}): Promise<MaterialChunkSearchOutcome> {
  const query = input.query.trim();
  const mode = input.mode ?? 'hybrid';
  const database = openMaterialDatabase(input.libraryPath, false);
  if (!database || !query) {
    database?.close();
    return { results: [], mode, used: usedLabel(mode), indexedChunks: 0, vectorIndexed: false };
  }

  const documentIds = normalizeDocumentIds(input.documentIds);
  ensureLexicalPostings(database, documentIds);
  const childOnly = input.childOnly === true;
  const queryTerms = normalizeSearchTerms(input.queryTerms, query);
  const requestedLimit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 50));
  const indexedChunks = countIndexedChunks(database, documentIds, childOnly);
  let profileStatus: MaterialEmbeddingProfileStatus = { state: 'UNBOUND' };
  let profileReadError: string | undefined;
  try {
    profileStatus = readMaterialEmbeddingProfileFromDatabase(database);
  } catch (error) {
    profileReadError = error instanceof Error ? error.message : String(error);
  }
  const profile = profileStatus.state === 'LOCKED' ? profileStatus.profile : undefined;
  const vectorState = readVectorState(database, profile, documentIds);
  database.close();

  let queryEmbedding: number[] | undefined;
  let vectorError: string | undefined;
  if (mode !== 'keyword' && !profile) {
    vectorError = profileReadError
      ?? (profileStatus.state === 'LEGACY_UNBOUND'
      ? '资料库存在未标识的旧向量索引，请先备份并执行迁移。'
      : '资料库尚未锁定向量模型。');
  } else if (mode !== 'keyword' && !vectorState.available) {
    vectorError = input.embeddingError ?? '资料库向量索引尚未完成，或 profile、向量元数据与批次状态不一致。';
  } else if (mode !== 'keyword' && !input.adapter) {
    vectorError = input.embeddingError ?? '锁定向量模型的连接不可用，请检查模型与密钥配置。';
  } else if (mode !== 'keyword' && profile && input.adapter) {
    try {
      const result = await input.adapter.embedBatch({
        profile,
        texts: [query],
        timeoutMs: input.timeoutMs ?? 60_000,
      });
      queryEmbedding = validateQueryEmbedding(result, profile);
    } catch (error) {
      vectorError = error instanceof Error ? error.message : String(error);
    }
  }

  const searchDatabase = openMaterialDatabase(input.libraryPath, false);
  if (!searchDatabase) return { results: [], mode, used: usedLabel(mode), indexedChunks, vectorIndexed: vectorState.available, ...(vectorError ? { notice: vectorError } : {}) };
  try {
    if (queryEmbedding && readMaterialEmbeddingProfileFromDatabase(searchDatabase).profile?.profileHash !== profile?.profileHash) {
      queryEmbedding = undefined;
      vectorState.available = false;
      vectorError = '索引代际已切换，请重新检索。';
    }
    const rawLexical = mode === 'semantic' && !queryEmbedding ? [] : readLexicalCandidates(searchDatabase, query, queryTerms, documentIds, requestedLimit * 4, childOnly);
    const keywordScores = readKeywordScores(searchDatabase, queryTerms, documentIds);
    const rawVector = queryEmbedding && vectorState.available
      ? readVectorCandidates(searchDatabase, queryEmbedding, documentIds, requestedLimit * 4, childOnly)
      : [];
    const lexical = filterCandidatesBySectionNodes(rawLexical, input.sectionNodeIds);
    const vector = filterCandidatesBySectionNodes(rawVector, input.sectionNodeIds);
    const merged = mergeCandidates(lexical, keywordScores, vector, mode, requestedLimit, queryTerms, input.fusion ?? 'weighted');
    const withParents = attachParents(searchDatabase, merged);
    const used = mode === 'semantic'
      ? '语义搜索'
      : vector.length > 0 && lexical.length > 0 ? '综合搜索' : vector.length > 0 ? '语义搜索' : '关键词搜索';
    const vectorNotice = vectorError
      ? mode === 'hybrid' && lexical.length > 0 ? `向量检索不可用，已使用原文与关键词检索：${vectorError}` : vectorError
      : mode === 'hybrid' && vectorState.available && vector.length === 0 ? '向量检索暂未返回结果，已使用原文与关键词检索。' : undefined;
    const lexicalNotice = input.lexicalError
      ? `Jieba 查询分词不可用，已使用原文兼容检索：${input.lexicalError}`
      : undefined;
    const notice = [lexicalNotice, vectorNotice].filter(Boolean).join('；') || undefined;
    return {
      results: withParents,
      mode,
      used,
      indexedChunks,
      vectorIndexed: vectorState.available,
      ...(notice ? { notice } : {}),
    };
  } finally {
    searchDatabase.close();
  }
}

export async function synchronizeMaterialChunkVectors(input: {
  libraryPath: string;
  embeddingModel: string;
  ollamaEndpoint?: string;
  documentIds?: string[];
  force?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  embed: MaterialEmbeddingAdapter;
}): Promise<MaterialChunkVectorResult> {
  const model = input.embeddingModel.trim();
  if (!model) throw new Error('请先选择本地嵌入模型。');
  const profileStatus = readMaterialEmbeddingProfile(input.libraryPath);
  if (profileStatus.state === 'LOCKED') {
    throw new PipelineStageError('EMBEDDING_PROFILE_LOCKED', '资料库向量模型已经锁定，旧版直接重建入口已停用，请使用锁定 profile 的向量批处理。', false);
  }
  if (profileStatus.state === 'LEGACY_UNBOUND') {
    throw new PipelineStageError('EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION', '资料库存在未标识的旧向量索引，请先备份并执行迁移。', false);
  }
  const database = openMaterialDatabase(input.libraryPath, false);
  if (!database) return { indexed: 0, skipped: 0, dimension: 0, embeddingModel: model, completedAt: new Date().toISOString() };
  try {
    const documentIds = normalizeDocumentIds(input.documentIds);
    const chunks = readChunksForVectorIndex(database, documentIds);
    if (chunks.length === 0) return { indexed: 0, skipped: 0, dimension: readVectorDimension(database), embeddingModel: model, completedAt: new Date().toISOString() };
    const state = readLegacyVectorState(database, model);
    const needsFullRebuild = Boolean(input.force) || !state.available;
    const pending = needsFullRebuild ? chunks : chunks.filter((chunk) => !hasVector(database, chunk.id));
    const skipped = chunks.length - pending.length;
    let dimension = state.dimension;
    for (let offset = 0; offset < pending.length; offset += vectorBatchSize) {
      if (input.shouldCancel?.()) throw new Error('资料库向量索引更新已取消。');
      const batch = pending.slice(offset, offset + vectorBatchSize);
      const embeddings = await input.embed({ endpoint: input.ollamaEndpoint, model, texts: batch.map((chunk) => chunk.text) });
      if (embeddings.length !== batch.length) throw new Error('本地模型返回的向量数量与资料库 chunk 不一致。');
      const nextDimension = embeddings[0]?.length ?? 0;
      if (!nextDimension || embeddings.some((embedding) => embedding.length !== nextDimension)) throw new Error('本地模型返回了无效或维度不一致的向量。');
      if (!dimension || !tableExists(database, getActiveMaterialVectorTable(database)) || getVectorMeta(database, 'embedding_model') !== model || dimension !== nextDimension) {
        recreateVectorTable(database, model, nextDimension);
        dimension = nextDimension;
      }
      const insert = database.prepare(`INSERT OR REPLACE INTO ${getActiveMaterialVectorTable(database)}(rowid, embedding) VALUES (?, ?)`);
      database.transaction(() => {
        batch.forEach((chunk, index) => insert.run(BigInt(chunk.id), toVectorBuffer(embeddings[index])));
      })();
      input.onProgress?.(Math.min(offset + batch.length, pending.length), pending.length);
    }
    setVectorMeta(database, 'embedding_model', model);
    setVectorMeta(database, 'vector_dimension', String(dimension || 0));
    setVectorMeta(database, 'last_completed_at', new Date().toISOString());
    return { indexed: pending.length, skipped, dimension: dimension || 0, embeddingModel: model, completedAt: new Date().toISOString() };
  } finally {
    database.close();
  }
}

function openMaterialDatabase(libraryPath: string, create: boolean): Database.Database | null {
  const databasePath = path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
  if (!create && !fs.existsSync(databasePath)) return null;
  if (create) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  ensureMaterialChunkSearchSchema(database);
  return database;
}

const LEXICAL_RECALL_PER_TERM_LIMIT = 300;
const LEXICAL_RECALL_UNION_LIMIT = 1200;
const LEXICAL_KEYWORD_KAPPA = 3;

function chunksOf<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) batches.push(values.slice(offset, offset + size));
  return batches;
}

function countTermFrequencies(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const term = token.trim();
    if (!term) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function setLexicalStat(database: Database.Database, key: string, value: string): void {
  database.prepare(`INSERT INTO ${materialLexicalStatsTableName} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function refreshLexicalStats(database: Database.Database): void {
  const row = database.prepare(`SELECT COUNT(*) AS n, AVG(lexical_body_len) AS avgBody, AVG(lexical_kw_len) AS avgKw FROM ${materialChunkTableName}`).get() as { n: number; avgBody: number | null; avgKw: number | null };
  setLexicalStat(database, 'doc_count', String(Number(row.n) || 0));
  setLexicalStat(database, 'avg_body_len', String(Number(row.avgBody) || 0));
  setLexicalStat(database, 'avg_kw_len', String(Number(row.avgKw) || 0));
}

function readLexicalCorpusStats(database: Database.Database): LexicalCorpusStats {
  const read = (key: string): number => {
    const row = database.prepare(`SELECT value FROM ${materialLexicalStatsTableName} WHERE key = ?`).get(key) as { value: string } | undefined;
    return Number(row?.value) || 0;
  };
  const cached = { docCount: read('doc_count'), avgBodyLen: read('avg_body_len'), avgKwLen: read('avg_kw_len') };
  if (cached.docCount > 0) return cached;
  const row = database.prepare(`SELECT COUNT(*) AS n, AVG(lexical_body_len) AS avgBody, AVG(lexical_kw_len) AS avgKw FROM ${materialChunkTableName}`).get() as { n: number; avgBody: number | null; avgKw: number | null };
  return { docCount: Number(row.n) || 0, avgBodyLen: Number(row.avgBody) || 0, avgKwLen: Number(row.avgKw) || 0 };
}

function readLexicalTermDf(database: Database.Database, terms: string[]): Map<string, LexicalTermDf> {
  const result = new Map<string, LexicalTermDf>();
  if (terms.length === 0 || !tableExists(database, materialPostingsTableName)) return result;
  const rows = database.prepare(`SELECT term, field, COUNT(*) AS df FROM ${materialPostingsTableName} WHERE term IN (${terms.map(() => '?').join(',')}) GROUP BY term, field`).all(...terms) as Array<{ term: string; field: string; df: number }>;
  for (const row of rows) {
    const entry = result.get(row.term) ?? { body: 0, keyword: 0 };
    if (row.field === 'body') entry.body = Number(row.df);
    else if (row.field === 'keyword') entry.keyword = Number(row.df);
    result.set(row.term, entry);
  }
  return result;
}

function backfillLexicalPostings(database: Database.Database, documentId: string): void {
  const chunks = database.prepare(`
    SELECT chunks.id AS id, chunks.chunk_id AS chunkId, fts.text AS ftsText
    FROM ${materialChunkTableName} AS chunks
    LEFT JOIN ${materialFtsTableName} AS fts ON fts.rowid = chunks.id
    WHERE chunks.document_id = ?
  `).all(documentId) as Array<{ id: number; chunkId: string; ftsText: string | null }>;
  const keywords = database.prepare(`SELECT chunk_id AS chunkId, surface_term AS surfaceTerm, normalized_term AS normalizedTerm FROM chunk_keywords WHERE document_id = ?`).all(documentId) as Array<{ chunkId: string; surfaceTerm: string; normalizedTerm: string }>;
  const keywordTermsByChunk = new Map<string, Set<string>>();
  for (const keyword of keywords) {
    const terms = keywordTermsByChunk.get(keyword.chunkId) ?? new Set<string>();
    if (keyword.surfaceTerm) terms.add(keyword.surfaceTerm);
    if (keyword.normalizedTerm) terms.add(keyword.normalizedTerm);
    keywordTermsByChunk.set(keyword.chunkId, terms);
  }
  const insertPosting = database.prepare(`INSERT OR REPLACE INTO ${materialPostingsTableName} (term, chunk_rowid, field, tf) VALUES (?, ?, 'body', ?)`);
  const insertKeywordPosting = database.prepare(`INSERT OR REPLACE INTO ${materialPostingsTableName} (term, chunk_rowid, field, tf) VALUES (?, ?, 'keyword', 1)`);
  const updateLengths = database.prepare(`UPDATE ${materialChunkTableName} SET lexical_body_len = ?, lexical_kw_len = ? WHERE id = ?`);
  database.transaction(() => {
    for (const chunk of chunks) {
      const tokens = (chunk.ftsText ?? '').split(/\s+/).filter(Boolean);
      const bodyTf = countTermFrequencies(tokens);
      for (const [term, tf] of bodyTf) insertPosting.run(term, chunk.id, tf);
      const keywordTerms = keywordTermsByChunk.get(chunk.chunkId) ?? new Set<string>();
      for (const term of keywordTerms) insertKeywordPosting.run(term, chunk.id);
      updateLengths.run(tokens.length, keywordTerms.size, chunk.id);
    }
    setLexicalStat(database, `backfilled:${documentId}`, '1');
    refreshLexicalStats(database);
  })();
}

/** 旧库没有倒排投影时，从 FTS 词元与关键词表懒重建；失败不阻断检索。 */
function ensureLexicalPostings(database: Database.Database, documentIds: string[]): void {
  if (!tableExists(database, materialPostingsTableName) || !tableExists(database, materialLexicalStatsTableName)) return;
  const filter = documentFilter('chunks', documentIds);
  const stale = database.prepare(`
    SELECT DISTINCT chunks.document_id AS documentId
    FROM ${materialChunkTableName} AS chunks
    WHERE ${filter.sql}
      AND IFNULL((SELECT value FROM ${materialLexicalStatsTableName} WHERE key = 'backfilled:' || chunks.document_id), '') = ''
      AND NOT EXISTS (SELECT 1 FROM ${materialPostingsTableName} AS postings WHERE postings.chunk_rowid = chunks.id)
  `).all(...filter.params) as Array<{ documentId: string }>;
  for (const row of stale) {
    try {
      backfillLexicalPostings(database, row.documentId);
    } catch {
      // 回填失败时保留旧 FTS 打分路径。
    }
  }
}

function readLexicalCandidates(database: Database.Database, query: string, terms: string[], documentIds: string[], limit: number, childOnly = false): LexicalCandidate[] {
  if (terms.length === 0 || !tableExists(database, materialPostingsTableName)) {
    return readLegacyLexicalCandidates(database, query, terms, documentIds, limit, childOnly);
  }
  const filter = documentFilter('chunks', documentIds);
  const childFilter = childOnly ? 'chunks.parent_chunk_id IS NOT NULL' : '1 = 1';
  const hasPostings = database.prepare(`
    SELECT 1 AS found
    FROM ${materialPostingsTableName} AS postings
    JOIN ${materialChunkTableName} AS chunks ON chunks.id = postings.chunk_rowid
    WHERE ${filter.sql}
    LIMIT 1
  `).get(...filter.params) as { found: number } | undefined;
  if (!hasPostings) return readLegacyLexicalCandidates(database, query, terms, documentIds, limit, childOnly);

  const rowIds = new Set<number>();
  const recallByTerm = database.prepare(`
    SELECT postings.chunk_rowid AS rowId
    FROM ${materialPostingsTableName} AS postings
    JOIN ${materialChunkTableName} AS chunks ON chunks.id = postings.chunk_rowid
    WHERE postings.term = ? AND ${filter.sql} AND ${childFilter}
    GROUP BY postings.chunk_rowid
    ORDER BY MAX(postings.tf) DESC
    LIMIT ${LEXICAL_RECALL_PER_TERM_LIMIT}
  `);
  for (const term of terms) {
    for (const row of recallByTerm.all(term, ...filter.params) as Array<{ rowId: number }>) rowIds.add(Number(row.rowId));
    if (rowIds.size >= LEXICAL_RECALL_UNION_LIMIT) break;
  }
  const titleRecall = database.prepare(`
    SELECT chunks.id AS rowId
    FROM ${materialChunkTableName} AS chunks
    WHERE chunks.section_path_json LIKE ? ESCAPE '\\' AND ${filter.sql} AND ${childFilter}
    LIMIT ${LEXICAL_RECALL_PER_TERM_LIMIT}
  `);
  for (const term of terms.slice(0, 8)) {
    for (const row of titleRecall.all(`%${escapeLike(term)}%`, ...filter.params) as Array<{ rowId: number }>) rowIds.add(Number(row.rowId));
  }
  const candidateIds = [...rowIds].slice(0, LEXICAL_RECALL_UNION_LIMIT);
  if (candidateIds.length === 0) return [];

  interface ScoredRow {
    rowId: number;
    documentId: string;
    chunkId: string;
    parentChunkId: string | null;
    ordinal: number;
    text: string;
    sourceText: string;
    sectionContext: string;
    sectionPathJson: string;
    sourceRefsJson: string;
    contentHash: string;
    keywordText: string;
    bodyLen: number;
    kwLen: number;
  }
  const fetched: ScoredRow[] = [];
  for (const batch of chunksOf(candidateIds, 800)) {
    fetched.push(...database.prepare(`
      SELECT chunks.id AS rowId, chunks.document_id AS documentId, chunks.chunk_id AS chunkId,
             chunks.parent_chunk_id AS parentChunkId, chunks.ordinal, chunks.text,
             chunks.source_text AS sourceText, chunks.section_context AS sectionContext,
             chunks.section_path_json AS sectionPathJson, chunks.source_refs_json AS sourceRefsJson,
             chunks.content_hash AS contentHash, chunks.keyword_text AS keywordText,
             chunks.lexical_body_len AS bodyLen, chunks.lexical_kw_len AS kwLen
      FROM ${materialChunkTableName} AS chunks
      WHERE chunks.id IN (${batch.map(() => '?').join(',')}) AND ${filter.sql} AND ${childFilter}
    `).all(...batch, ...filter.params) as ScoredRow[]);
  }
  const bodyTfByRow = new Map<number, Map<string, number>>();
  const kwTfByRow = new Map<number, Map<string, number>>();
  for (const batch of chunksOf(candidateIds, 800)) {
    const tfRows = database.prepare(`
      SELECT chunk_rowid AS rowId, term, field, tf
      FROM ${materialPostingsTableName}
      WHERE chunk_rowid IN (${batch.map(() => '?').join(',')}) AND term IN (${terms.map(() => '?').join(',')})
    `).all(...batch, ...terms) as Array<{ rowId: number; term: string; field: string; tf: number }>;
    for (const tfRow of tfRows) {
      const rowId = Number(tfRow.rowId);
      const target = tfRow.field === 'body' ? bodyTfByRow : kwTfByRow;
      const tfMap = target.get(rowId) ?? new Map<string, number>();
      tfMap.set(tfRow.term, Number(tfRow.tf));
      target.set(rowId, tfMap);
    }
  }
  const corpus = readLexicalCorpusStats(database);
  const termDf = readLexicalTermDf(database, terms);
  const scores = scoreLexicalCandidates({
    queryTerms: terms,
    rawQuery: query,
    corpus,
    termDf,
    candidates: fetched.map((row) => ({
      rowId: Number(row.rowId),
      bodyTf: bodyTfByRow.get(Number(row.rowId)) ?? new Map<string, number>(),
      kwTf: kwTfByRow.get(Number(row.rowId)) ?? new Map<string, number>(),
      bodyLen: Number(row.bodyLen) || 0,
      kwLen: Number(row.kwLen) || 0,
      sectionPathText: extractSectionPathText(parseJsonArray(row.sectionPathJson)),
      sourceText: row.sourceText,
    })),
  });
  const results: LexicalCandidate[] = [];
  for (const row of fetched) {
    const breakdown = scores.get(Number(row.rowId));
    if (!breakdown || breakdown.final <= 0) continue;
    results.push({
      documentId: row.documentId,
      chunkId: row.chunkId,
      parentChunkId: row.parentChunkId,
      ordinal: row.ordinal,
      text: row.text,
      sourceText: row.sourceText,
      sectionContext: row.sectionContext,
      sectionPathJson: row.sectionPathJson,
      sourceRefsJson: row.sourceRefsJson,
      contentHash: row.contentHash,
      keywordText: row.keywordText,
      bm25: breakdown.raw,
      lexicalScore: breakdown.final,
      breakdown,
    });
  }
  results.sort((first, second) => second.lexicalScore - first.lexicalScore);
  return results.slice(0, limit);
}

function readLegacyLexicalCandidates(database: Database.Database, query: string, terms: string[], documentIds: string[], limit: number, childOnly = false): LexicalCandidate[] {
  const ftsQuery = terms.length > 0 ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ') : `"${query.replaceAll('"', '""')}"`;
  const filter = documentFilter('fts', documentIds);
  const childFilter = childOnly ? 'chunks.parent_chunk_id IS NOT NULL' : '1 = 1';
  const rows: LexicalCandidate[] = [];
  try {
    const ftsRows = database.prepare(`
      SELECT chunks.document_id AS documentId, chunks.chunk_id AS chunkId,
             chunks.parent_chunk_id AS parentChunkId, chunks.ordinal, chunks.text,
             chunks.source_text AS sourceText, chunks.section_context AS sectionContext,
             chunks.section_path_json AS sectionPathJson, chunks.source_refs_json AS sourceRefsJson,
             chunks.content_hash AS contentHash, chunks.keyword_text AS keywordText,
             ${materialFtsBm25Expression} AS bm25
      FROM ${materialFtsTableName} AS fts
      JOIN ${materialChunkTableName} AS chunks ON chunks.id = fts.rowid
      WHERE ${materialFtsTableName} MATCH ? AND ${filter.sql} AND ${childFilter}
      ORDER BY bm25 LIMIT ?
    `).all(ftsQuery, ...filter.params, limit) as RawLexicalCandidate[];
    // 原始 BM25 的绝对值随资料库语料变化；用加权 BM25 排序召回池，再转为稳定的名次分数参与混合融合。
    rows.push(...ftsRows.map((row, index) => ({
      ...row,
      lexicalScore: RRF_RANK_CONSTANT / (RRF_RANK_CONSTANT + index),
    })));
  } catch {
    // FTS5 unicode61 does not reliably tokenize every Chinese substring; LIKE below is the deterministic fallback.
  }

  const likeTerms = [...new Set([query, ...terms])].slice(0, 8);
  if (likeTerms.length > 0) {
    const conditions = likeTerms.map(() => '(chunks.text LIKE ? ESCAPE \'\\\' OR chunks.keyword_text LIKE ? ESCAPE \'\\\')').join(' OR ');
    const values = likeTerms.flatMap((term) => {
      const escaped = `%${escapeLike(term)}%`;
      return [escaped, escaped];
    });
    const likeRows = database.prepare(`
      SELECT chunks.document_id AS documentId, chunks.chunk_id AS chunkId,
             chunks.parent_chunk_id AS parentChunkId, chunks.ordinal, chunks.text,
             chunks.source_text AS sourceText, chunks.section_context AS sectionContext,
             chunks.section_path_json AS sectionPathJson, chunks.source_refs_json AS sourceRefsJson,
             chunks.content_hash AS contentHash, chunks.keyword_text AS keywordText,
             0 AS bm25, ${materialFtsFallbackScore} AS lexicalScore
      FROM ${materialChunkTableName} AS chunks
      WHERE (${conditions}) AND ${documentFilter('chunks', documentIds).sql} AND ${childOnly ? 'chunks.parent_chunk_id IS NOT NULL' : '1 = 1'}
      LIMIT ?
    `).all(...values, ...documentFilter('chunks', documentIds).params, limit) as LexicalCandidate[];
    const existing = new Set(rows.map((row) => resultKey(row)));
    for (const row of likeRows) if (!existing.has(resultKey(row))) rows.push(row);
  }
  return rows;
}

function readKeywordScores(database: Database.Database, terms: string[], documentIds: string[]): Map<string, number> {
  if (terms.length === 0 || !tableExists(database, 'chunk_keywords')) return new Map();
  const filters = documentFilter('keywords', documentIds);
  const termList = terms.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT keywords.document_id AS documentId, keywords.chunk_id AS chunkId,
           keywords.normalized_term AS normalizedTerm, keywords.surface_term AS surfaceTerm,
           keywords.score AS score, keywords.kind AS kind
    FROM chunk_keywords AS keywords
    WHERE (keywords.normalized_term IN (${termList}) OR keywords.surface_term IN (${termList})) AND ${filters.sql}
  `).all(...terms, ...terms, ...filters.params) as Array<{ documentId: string; chunkId: string; normalizedTerm: string; surfaceTerm: string; score: number; kind: string }>;
  if (rows.length === 0) return new Map();
  const useIdf = tableExists(database, materialPostingsTableName);
  const termDf = useIdf ? readLexicalTermDf(database, terms) : new Map<string, LexicalTermDf>();
  const docCount = useIdf ? readLexicalCorpusStats(database).docCount : 0;
  const kindWeight = (kind: string): number => (kind === 'phrase' ? 1.2 : kind === 'term' ? 1.1 : 1.0);
  const termSet = new Set(terms);
  const accumulated = new Map<string, { total: number; seen: Set<string> }>();
  for (const row of rows) {
    const key = resultKey(row);
    const entry = accumulated.get(key) ?? { total: 0, seen: new Set<string>() };
    const matched = new Set<string>();
    if (termSet.has(row.normalizedTerm)) matched.add(row.normalizedTerm);
    if (termSet.has(row.surfaceTerm)) matched.add(row.surfaceTerm);
    for (const term of matched) {
      if (entry.seen.has(term)) continue;
      entry.seen.add(term);
      const df = termDf.get(term)?.body ?? 0;
      const termIdf = useIdf && docCount > 0 && df > 0
        ? Math.max(0, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)))
        : 1;
      entry.total += Math.max(0, Math.min(1, Number(row.score))) * kindWeight(String(row.kind)) * termIdf;
    }
    accumulated.set(key, entry);
  }
  return new Map([...accumulated].map(([key, entry]) => [key, entry.total > 0 ? entry.total / (entry.total + LEXICAL_KEYWORD_KAPPA) : 0]));
}

function readVectorCandidates(database: Database.Database, embedding: number[], documentIds: string[], limit: number, childOnly = false): VectorCandidate[] {
  const filter = documentFilter('chunks', documentIds);
  const childFilter = childOnly ? 'chunks.parent_chunk_id IS NOT NULL' : '1 = 1';
  try {
    return database.prepare(`
      SELECT chunks.document_id AS documentId, chunks.chunk_id AS chunkId,
             chunks.parent_chunk_id AS parentChunkId, chunks.ordinal, chunks.text,
             chunks.source_text AS sourceText, chunks.section_context AS sectionContext,
             chunks.section_path_json AS sectionPathJson, chunks.source_refs_json AS sourceRefsJson,
             chunks.content_hash AS contentHash, chunks.keyword_text AS keywordText,
             vectors.distance AS distance
      FROM ${getActiveMaterialVectorTable(database)} AS vectors
      JOIN ${materialChunkTableName} AS chunks ON chunks.id = vectors.rowid
      WHERE vectors.embedding MATCH ? AND k = ? AND ${filter.sql} AND ${childFilter}
      ORDER BY vectors.distance
    `).all(toVectorBuffer(embedding), limit, ...filter.params) as VectorCandidate[];
  } catch {
    return [];
  }
}

function mergeCandidates(lexical: LexicalCandidate[], keywordScores: Map<string, number>, vector: VectorCandidate[], mode: MaterialChunkSearchMode, limit: number, queryTerms: string[], fusion: MaterialChunkFusion): MaterialChunkSearchResult[] {
  const all = new Map<string, Candidate>();
  const lexicalMaximum = Math.max(...lexical.map((row) => row.lexicalScore), 0);
  for (const row of lexical) {
    const key = resultKey(row);
    const existing = all.get(key);
    all.set(key, {
      ...row,
      bm25Score: Math.max(existing?.bm25Score ?? 0, lexicalMaximum > 0 ? row.lexicalScore / lexicalMaximum : 0),
      keywordScore: Math.max(existing?.keywordScore ?? 0, keywordScores.get(key) ?? keywordTextScore(queryTerms, row.keywordText)),
      vectorScore: existing?.vectorScore ?? 0,
    });
  }
  for (const [key, score] of keywordScores) {
    const existing = all.get(key);
    if (existing) existing.keywordScore = Math.max(existing.keywordScore, score);
  }
  const vectorMaximum = Math.max(...vector.map((row) => 1 - Math.max(0, Math.min(1, Number(row.distance)))), 0);
  for (const row of vector) {
    const key = resultKey(row);
    const existing = all.get(key);
    const vectorScore = vectorMaximum > 0 ? (1 - Math.max(0, Math.min(1, Number(row.distance)))) / vectorMaximum : 0;
    if (existing) existing.vectorScore = vectorScore;
    else all.set(key, {
      ...row,
      bm25: 0,
      lexicalScore: 0,
      bm25Score: 0,
      keywordScore: keywordScores.get(key) ?? keywordTextScore(queryTerms, row.keywordText),
      vectorScore,
    });
  }
  const buildResult = (candidate: Candidate, score: number, rrf?: RrfChannelEntry): MaterialChunkSearchResult => ({
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    parentChunkId: candidate.parentChunkId,
    ordinal: candidate.ordinal,
    text: candidate.text,
    sectionPath: parseJsonArray(candidate.sectionPathJson),
    sectionContext: candidate.sectionContext,
    contentHash: candidate.contentHash,
    score,
    bm25Score: Number(candidate.bm25Score.toFixed(6)),
    keywordScore: Number(candidate.keywordScore.toFixed(6)),
    vectorScore: Number(candidate.vectorScore.toFixed(6)),
    ...(candidate.breakdown ? { lexicalBreakdown: candidate.breakdown } : {}),
    ...(rrf ? {
      rrfScore: Number(rrf.rrfScore.toFixed(6)),
      ranks: {
        ...(rrf.vectorRank !== undefined ? { vector: rrf.vectorRank } : {}),
        ...(rrf.lexicalRank !== undefined ? { lexical: rrf.lexicalRank } : {}),
      },
    } : {}),
    matchTypes: [
      ...(candidate.bm25Score > 0 ? ['原文' as const] : []),
      ...(candidate.keywordScore > 0 ? ['关键词' as const] : []),
      ...(candidate.vectorScore > 0 ? ['语义' as const] : []),
    ],
    citation: {
      documentId: candidate.documentId,
      chunkId: candidate.chunkId,
      parentChunkId: candidate.parentChunkId,
      contentHash: candidate.contentHash,
      text: candidate.text,
      sourceText: candidate.sourceText,
      sectionContext: candidate.sectionContext,
      sourceRefs: parseJsonArray(candidate.sourceRefsJson),
    },
  });
  const tieBreak = (first: MaterialChunkSearchResult, second: MaterialChunkSearchResult): number =>
    second.score - first.score || first.documentId.localeCompare(second.documentId) || first.ordinal - second.ordinal;
  if (fusion === 'rrf' && mode !== 'semantic') {
    // 词法通道排序键叠加关键词增强；向量通道保持 distance 序。RRF 只消费排名。
    const lexicalKeyOf = (row: LexicalCandidate): number =>
      row.lexicalScore + LEXICAL_KEYWORD_BOOST * (keywordScores.get(resultKey(row)) ?? keywordTextScore(queryTerms, row.keywordText));
    const lexicalOrdered = [...lexical].sort((first, second) => lexicalKeyOf(second) - lexicalKeyOf(first));
    const fused = reciprocalRankFusion({
      vectorKeys: vector.map((row) => resultKey(row)),
      lexicalKeys: lexicalOrdered.map((row) => resultKey(row)),
    });
    return [...all.values()]
      .map((candidate) => {
        const entry = fused.get(resultKey(candidate));
        return buildResult(candidate, Number((entry?.rrfScore ?? 0).toFixed(6)), entry);
      })
      .sort(tieBreak)
      .slice(0, limit);
  }
  const activeChannels = mode === 'semantic'
    ? [{ key: 'vectorScore' as const, weight: 1 }]
    : [{ key: 'bm25Score' as const, weight: 0.55 }, { key: 'keywordScore' as const, weight: 0.25 }, ...(vector.length > 0 ? [{ key: 'vectorScore' as const, weight: 0.2 }] : [])];
  return [...all.values()]
    .filter((candidate) => mode !== 'semantic' || candidate.vectorScore > 0)
    .map((candidate) => buildResult(candidate, Number(activeChannels.reduce((total, channel) => total + candidate[channel.key] * channel.weight, 0).toFixed(6))))
    .sort(tieBreak)
    .slice(0, limit);
}

export interface MaterialParentWindowRecord {
  documentId: string;
  parentChunkId: string;
  ordinal: number;
  text: string;
  sourceText: string;
}

/**
 * 深读支持：按锚点序号向前后展开父块窗口（只读）。父块缺失时回退旧版
 * 整块表，保持与检索引用一致的降级路径。
 */
export function readMaterialParentWindow(input: { libraryPath: string; documentId: string; ordinal: number; window: number }): MaterialParentWindowRecord[] {
  const window = Math.max(0, Math.min(Math.floor(input.window), 5));
  const from = Math.max(0, input.ordinal - window);
  const to = input.ordinal + window;
  const database = openMaterialDatabase(input.libraryPath, false);
  if (!database) return [];
  try {
    const parentRows = database.prepare(`
      SELECT parent_chunk_id AS parentChunkId, ordinal, text, source_text AS sourceText
      FROM ${materialParentTableName}
      WHERE document_id = ? AND ordinal >= ? AND ordinal <= ?
      ORDER BY ordinal
    `).all(input.documentId, from, to) as Array<{ parentChunkId: string; ordinal: number; text: string; sourceText: string }>;
    if (parentRows.length > 0) {
      return parentRows.map((row) => ({ documentId: input.documentId, parentChunkId: row.parentChunkId, ordinal: row.ordinal, text: row.text, sourceText: row.sourceText }));
    }
    const legacyRows = database.prepare(`
      SELECT chunk_id AS parentChunkId, ordinal, text, source_text AS sourceText
      FROM ${materialChunkTableName}
      WHERE document_id = ? AND ordinal >= ? AND ordinal <= ?
      ORDER BY ordinal
    `).all(input.documentId, from, to) as Array<{ parentChunkId: string; ordinal: number; text: string; sourceText: string }>;
    return legacyRows.map((row) => ({ documentId: input.documentId, parentChunkId: row.parentChunkId, ordinal: row.ordinal, text: row.text, sourceText: row.sourceText }));
  } finally {
    database.close();
  }
}

/** 文档级索引统计，供 get_document_info 工具与 runtime_context 能力声明使用。 */
export function readMaterialDocumentIndexStats(libraryPath: string, documentId?: string): { parentChunks: number; childChunks: number } {
  const database = openMaterialDatabase(libraryPath, false);
  if (!database) return { parentChunks: 0, childChunks: 0 };
  try {
    const parentCount = (database.prepare(`SELECT COUNT(*) AS count FROM ${materialParentTableName}${documentId ? ' WHERE document_id = ?' : ''}`).get(...(documentId ? [documentId] : [])) as { count: number }).count;
    const childCount = (database.prepare(`SELECT COUNT(*) AS count FROM ${materialChunkTableName}${documentId ? ' WHERE document_id = ?' : ''}`).get(...(documentId ? [documentId] : [])) as { count: number }).count;
    return { parentChunks: parentCount, childChunks: childCount };
  } finally {
    database.close();
  }
}

export interface MaterialDirectLoadDocument {
  documentId: string;
  childChunks: number;
  parents: Array<{ parentChunkId: string; ordinal: number; text: string; sourceText: string }>;
}

/**
 * 小文档直载只读查询（借鉴 WeKnora 直载思想）：按文档统计子块数，
 * 返回子块数 ≤ maxChildChunks 且父块数不超预算的文档的全量父块；
 * 无父块投影的遗留文档跳过。只读，不触碰索引写入。
 */
export function readMaterialDirectLoadDocuments(input: { libraryPath: string; maxChildChunks: number; maxParents: number }): MaterialDirectLoadDocument[] {
  const database = openMaterialDatabase(input.libraryPath, false);
  if (!database) return [];
  try {
    if (!tableExists(database, materialParentTableName)) return [];
    const smallRows = database.prepare(`
      SELECT document_id AS documentId, COUNT(*) AS childCount
      FROM ${materialChunkTableName}
      GROUP BY document_id
      HAVING COUNT(*) > 0 AND COUNT(*) <= ?
      ORDER BY COUNT(*) ASC, document_id
    `).all(Math.max(1, Math.floor(input.maxChildChunks))) as Array<{ documentId: string; childCount: number }>;
    const results: MaterialDirectLoadDocument[] = [];
    let remainingParents = Math.max(0, Math.floor(input.maxParents));
    for (const row of smallRows) {
      if (remainingParents <= 0) break;
      const parentCount = (database.prepare(`SELECT COUNT(*) AS count FROM ${materialParentTableName} WHERE document_id = ?`).get(row.documentId) as { count: number }).count;
      if (parentCount === 0 || parentCount > remainingParents) continue;
      const parents = database.prepare(`
        SELECT parent_chunk_id AS parentChunkId, ordinal, text, source_text AS sourceText
        FROM ${materialParentTableName}
        WHERE document_id = ?
        ORDER BY ordinal
      `).all(row.documentId) as Array<{ parentChunkId: string; ordinal: number; text: string; sourceText: string }>;
      if (parents.length === 0) continue;
      results.push({ documentId: row.documentId, childChunks: Number(row.childCount) || 0, parents });
      remainingParents -= parents.length;
    }
    return results;
  } finally {
    database.close();
  }
}

function attachParents(database: Database.Database, results: MaterialChunkSearchResult[]): MaterialChunkSearchResult[] {
  const parentKeys = results.flatMap((result) => result.parentChunkId ? [{ documentId: result.documentId, chunkId: result.parentChunkId }] : []);
  if (parentKeys.length === 0) return results;
  const unique = [...new Map(parentKeys.map((value) => [resultKey(value), value])).values()];
  const parentConditions = unique.map(() => '(document_id = ? AND parent_chunk_id = ?)').join(' OR ');
  const parentParams = unique.flatMap((value) => [value.documentId, value.chunkId]);
  const parentRows = database.prepare(`
    SELECT document_id AS documentId, parent_chunk_id AS chunkId, ordinal, text,
           source_text AS sourceText, source_refs_json AS sourceRefsJson
    FROM ${materialParentTableName} WHERE ${parentConditions}
  `).all(...parentParams) as Array<{ documentId: string; chunkId: string; ordinal: number; text: string; sourceText: string; sourceRefsJson: string }>;
  const parentByKey = new Map(parentRows.map((parent) => [resultKey(parent), parent]));
  const missing = unique.filter((value) => !parentByKey.has(resultKey(value)));
  if (missing.length > 0) {
    const legacyConditions = missing.map(() => '(document_id = ? AND chunk_id = ?)').join(' OR ');
    const legacyParams = missing.flatMap((value) => [value.documentId, value.chunkId]);
    const legacyRows = database.prepare(`
      SELECT document_id AS documentId, chunk_id AS chunkId, ordinal, text,
             source_text AS sourceText, source_refs_json AS sourceRefsJson
      FROM ${materialChunkTableName} WHERE ${legacyConditions}
    `).all(...legacyParams) as Array<{ documentId: string; chunkId: string; ordinal: number; text: string; sourceText: string; sourceRefsJson: string }>;
    for (const parent of legacyRows) parentByKey.set(resultKey(parent), parent);
  }
  return results.map((result) => {
    const parent = result.parentChunkId ? parentByKey.get(resultKey({ documentId: result.documentId, chunkId: result.parentChunkId })) : undefined;
    return parent ? {
      ...result,
      citation: {
        ...result.citation,
        parent: {
          chunkId: parent.chunkId,
          ordinal: parent.ordinal,
          text: parent.text,
          sourceText: parent.sourceText,
          sourceRefs: parseJsonArray(parent.sourceRefsJson),
        },
      },
    } : result;
  });
}

interface LexicalCandidate {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionContext: string;
  keywordText?: string;
  sectionPathJson: string;
  sourceRefsJson: string;
  contentHash: string;
  bm25: number;
  lexicalScore: number;
  breakdown?: LexicalScoreBreakdown;
}

type RawLexicalCandidate = Omit<LexicalCandidate, 'lexicalScore'>;

interface VectorCandidate {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionContext: string;
  keywordText?: string;
  sectionPathJson: string;
  sourceRefsJson: string;
  contentHash: string;
  distance: number;
}

type Candidate = LexicalCandidate & { bm25Score: number; keywordScore: number; vectorScore: number };

function resultKey(value: { documentId: string; chunkId: string }): string {
  return `${value.documentId}\u0000${value.chunkId}`;
}

function countIndexedChunks(database: Database.Database, documentIds: string[], childOnly = false): number {
  const filter = documentFilter('chunks', documentIds);
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${materialChunkTableName} AS chunks WHERE ${filter.sql} AND ${childOnly ? 'chunks.parent_chunk_id IS NOT NULL' : '1 = 1'}`).get(...filter.params) as { count: number };
  return Number(row.count) || 0;
}

function documentFilter(alias: string, documentIds: string[]): { sql: string; params: string[] } {
  if (documentIds.length === 0) return { sql: '1 = 1', params: [] };
  return { sql: `${alias}.document_id IN (${documentIds.map(() => '?').join(', ')})`, params: documentIds };
}

function normalizeDocumentIds(documentIds: string[] | undefined): string[] {
  return [...new Set((documentIds ?? []).filter((value): value is string => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function extractSearchTerms(query: string): string[] {
  return [...new Set(query.match(/[A-Za-z0-9][A-Za-z0-9_.:+#/-]*|[\u4e00-\u9fff]{2,}/gu) ?? [])].slice(0, 8);
}

function normalizeSearchTerms(queryTerms: string[] | undefined, query: string): string[] {
  const source = Array.isArray(queryTerms) ? queryTerms : extractSearchTerms(query);
  return [...new Set(source.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const term = value.trim();
    return term && term.length <= 128 && [...term].every(isPrintableSearchCharacter) ? [term] : [];
  }))].slice(0, 64);
}

function isPrintableSearchCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function keywordTextScore(queryTerms: string[], keywordText?: string): number {
  if (!keywordText) return 0;
  return queryTerms.some((term) => keywordText.includes(term)) ? 0.4 : 0;
}

function extractSectionPathText(sectionPath: unknown[]): string {
  return sectionPath.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const text = (entry as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  }).join(' ');
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Wiki 节点作用域过滤：仅保留 sectionPath 末位 nodeId 命中集合的候选行。
 * 在词法/向量双通道原始结果上、RRF 融合前应用（Wiki 节点问答方案 §3.2）。
 */
export function filterCandidatesBySectionNodes<T extends { sectionPathJson: string }>(rows: T[], sectionNodeIds: string[] | undefined): T[] {
  // `undefined` 只用于 Wiki 根节点，表示整篇文档均在当前作用域内；
  // 空数组表示调用方已解析出“没有任何合法章节”，必须 fail closed。
  if (sectionNodeIds === undefined) return rows;
  if (sectionNodeIds.length === 0) return [];
  const allowed = new Set(sectionNodeIds);
  return rows.filter((row) => {
    const sectionPath = parseJsonArray(row.sectionPathJson);
    const last = sectionPath[sectionPath.length - 1];
    const nodeId = last && typeof last === 'object' ? (last as Record<string, unknown>).nodeId : undefined;
    return typeof nodeId === 'string' && allowed.has(nodeId);
  });
}

function readChunksForVectorIndex(database: Database.Database, documentIds: string[]): Array<{ id: number; text: string }> {
  const filter = documentFilter('chunks', documentIds);
  return database.prepare(`SELECT chunks.id, chunks.text FROM ${materialChunkTableName} AS chunks WHERE ${filter.sql} ORDER BY chunks.id`).all(...filter.params) as Array<{ id: number; text: string }>;
}

function readVectorState(database: Database.Database, profile: MaterialEmbeddingProfile | undefined, documentIds: string[]): { available: boolean; dimension: number } {
  if (!profile || !tableExists(database, getActiveMaterialVectorTable(database)) || !tableExists(database, 'material_chunk_embedding_state')) return { available: false, dimension: 0 };
  const storedModel = getVectorMeta(database, 'embedding_model');
  const dimension = readVectorDimension(database);
  const storedProfileHash = getVectorMeta(database, 'embedding_profile_hash');
  if (storedModel !== profile.requestedModel || storedProfileHash !== profile.profileHash || dimension !== profile.vectorDimension) {
    return { available: false, dimension };
  }
  const filter = documentFilter('chunks', documentIds);
  try {
    const inconsistent = database.prepare(`
      SELECT 1
      FROM ${materialChunkTableName} AS chunks
      LEFT JOIN material_chunk_embedding_state AS states ON states.chunk_rowid = chunks.id
      LEFT JOIN ${getActiveMaterialVectorTable(database)} AS vectors ON vectors.rowid = chunks.id
      WHERE ${filter.sql}
        AND (states.state IS NULL
          OR states.state <> 'SUCCEEDED'
          OR states.profile_hash <> ?
          OR states.chunk_content_hash <> chunks.content_hash
          OR vectors.rowid IS NULL)
      LIMIT 1
    `).get(...filter.params, profile.profileHash);
    if (inconsistent) return { available: false, dimension };
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM ${getActiveMaterialVectorTable(database)} AS vectors
      JOIN ${materialChunkTableName} AS chunks ON chunks.id = vectors.rowid
      WHERE ${filter.sql}
    `).get(...filter.params) as { count: number };
    return { available: Number(row.count) > 0, dimension };
  } catch {
    return { available: false, dimension };
  }
}

function readLegacyVectorState(database: Database.Database, model: string): { available: boolean; dimension: number } {
  if (!tableExists(database, getActiveMaterialVectorTable(database))) return { available: false, dimension: 0 };
  const storedModel = getVectorMeta(database, 'embedding_model');
  const dimension = readVectorDimension(database);
  if (!storedModel || !dimension || (model && storedModel !== model)) return { available: false, dimension };
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${getActiveMaterialVectorTable(database)}`).get() as { count: number };
  return { available: Number(row.count) > 0, dimension };
}

function readVectorDimension(database: Database.Database): number {
  return Number(getVectorMeta(database, 'vector_dimension')) || 0;
}

function validateQueryEmbedding(result: { vectors: number[][]; dimension: number; responseModel?: string }, profile: MaterialEmbeddingProfile): number[] {
  if (!result || !Array.isArray(result.vectors) || result.vectors.length !== 1) {
    throw new Error('查询向量服务返回数量不正确，已停用语义通道。');
  }
  const expectedModel = profile.responseModel ?? profile.requestedModel;
  if (result.responseModel && result.responseModel !== expectedModel) {
    throw new Error(`查询向量服务返回模型 ${result.responseModel} 与锁定模型 ${expectedModel} 不一致，已停用语义通道。`);
  }
  if (result.dimension !== profile.vectorDimension) {
    throw new Error(`查询向量维度 ${result.dimension} 与锁定 profile 的 ${profile.vectorDimension} 不一致，已停用语义通道。`);
  }
  const [vector] = result.vectors;
  if (!Array.isArray(vector) || vector.length !== profile.vectorDimension || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('查询向量返回了非有限值或维度错误，已停用语义通道。');
  }
  return vector;
}

function hasVector(database: Database.Database, rowId: number): boolean {
  if (!tableExists(database, getActiveMaterialVectorTable(database))) return false;
  return Boolean(database.prepare(`SELECT 1 FROM ${getActiveMaterialVectorTable(database)} WHERE rowid = ?`).get(BigInt(rowId)));
}

function recreateVectorTable(database: Database.Database, model: string, dimension: number): void {
  database.exec(`DROP TABLE IF EXISTS ${getActiveMaterialVectorTable(database)}`);
  database.exec(`CREATE VIRTUAL TABLE ${getActiveMaterialVectorTable(database)} USING vec0(embedding float[${dimension}] distance_metric=cosine)`);
  setVectorMeta(database, 'embedding_model', model);
  setVectorMeta(database, 'vector_dimension', String(dimension));
}

function getVectorMeta(database: Database.Database, key: string): string {
  const row = database.prepare(`SELECT value FROM ${materialVectorMetaTableName} WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function setVectorMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`
    INSERT INTO ${materialVectorMetaTableName}(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function toVectorBuffer(values: number[]): Buffer {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function tableExists(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName));
}

/** SQLite 的本地资料库没有统一迁移器；为旧索引补列时保持已有检索数据可读。 */
function ensureColumn(database: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function loadSqliteVec(database: Database.Database): void {
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

function usedLabel(mode: MaterialChunkSearchMode): MaterialChunkSearchOutcome['used'] {
  return mode === 'keyword' ? '关键词搜索' : mode === 'semantic' ? '语义搜索' : '综合搜索';
}
