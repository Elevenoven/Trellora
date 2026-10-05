import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { isMaterialChunkProjectionCurrent, removeMaterialChunkProjection, replaceMaterialChunkProjection, type MaterialChunkParentProjectionRecord, type MaterialChunkProjectionKeyword, type MaterialChunkProjectionRecord } from './materialChunkSearch';
import { PipelineStageError } from './stageErrors';
import { KEYWORD_OUTPUT_SCHEMA_VERSION } from './keywordTypes';

const keywordTableName = 'chunk_keywords';
const documentTableName = 'chunk_keyword_documents';
const maxSearchTokensPerChunk = 8_192;
const maxSearchTokenCharacters = 128;

export interface KeywordIndexImportResult {
  documentId: string;
  importedChunks: number;
  importedKeywords: number;
  replacedKeywords: number;
  readBackChunks: number;
  readBackKeywords: number;
  sourceContentHash: string;
  stageKey: string;
}

export interface KeywordIndexDocumentStatus {
  documentId: string;
  sourceContentHash: string;
  stageKey: string;
  chunkCount: number;
  keywordCount: number;
  importedAt: string;
}

export interface FtsIndexProjectionSnapshot {
  documentId: string;
  sourceContentHash: string;
  stageKey: string;
  projectedChunkCount: number;
  projectedKeywordCount: number;
  indexedChunks: number;
  ftsRows: number;
  indexedKeywords: number;
  indexedAt: string;
}

interface ChunkSnapshot {
  documentId: string;
  chunkId: string;
  parentChunkId: string | null;
  ordinal: number;
  text: string;
  sourceText: string;
  sectionPath: unknown[];
  sectionContext: string;
  sourceRefs: unknown[];
  contentHash: string;
}

interface ParentChunkSnapshot {
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

interface KeywordIndexRow {
  documentId: string;
  chunkId: string;
  normalizedTerm: string;
  surfaceTerm: string;
  rank: number;
  score: number;
  kind: string;
  offsetsJson: string;
  algorithmVersion: string;
  chunkContentHash: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

export async function importKeywordsStage(input: {
  libraryPath: string;
  documentId: string;
  sourceContentHash: string;
  stageKey: string;
  chunksPath: string;
  /** V2 可选的 Parent 产物；未提供时保留旧 chunks.jsonl 的兼容行为。 */
  parentsPath?: string;
  keywordsPath: string;
}): Promise<KeywordIndexImportResult> {
  const chunks = await readChunkSnapshots(input.chunksPath, input.documentId);
  const parents = input.parentsPath ? await readParentChunkSnapshots(input.parentsPath, input.documentId) : undefined;
  if (parents) {
    for (const chunk of chunks.values()) {
      if (chunk.parentChunkId && !parents.has(chunk.parentChunkId)) {
        failInvalid(`Child 引用了不存在的 Parent：${chunk.parentChunkId}。`);
      }
    }
  }
  const rows: KeywordIndexRow[] = [];
  const keywordChunkIds = new Set<string>();
  const searchTokensByChunk = new Map<string, string[]>();

  await forEachJsonLine(input.keywordsPath, (value, lineNumber) => {
    const record = parseKeywordRecord(value, input.documentId, lineNumber);
    const chunk = chunks.get(record.chunkId);
    if (!chunk) failInvalid(`关键词产物引用了不存在的 chunk：${record.chunkId}。`);
    if (keywordChunkIds.has(record.chunkId)) failInvalid(`关键词产物中存在重复 chunk：${record.chunkId}。`);
    if (record.chunkContentHash !== chunk.contentHash) {
      failInvalid(`关键词产物与当前 chunk 内容不一致：${record.chunkId}。`);
    }
    keywordChunkIds.add(record.chunkId);
    searchTokensByChunk.set(record.chunkId, record.searchTokens);
    const normalizedSeen = new Set<string>();
    let previousScore = Number.POSITIVE_INFINITY;
    for (const [index, keyword] of record.keywords.entries()) {
      const row = parseKeywordRow(keyword, record, chunk, input.documentId, lineNumber, index);
      if (row.score > previousScore + 1e-12) failInvalid(`关键词 score 顺序无效：${record.chunkId}。`);
      previousScore = row.score;
      if (normalizedSeen.has(row.normalizedTerm)) failInvalid(`同一 chunk 中存在重复关键词：${row.chunkId}。`);
      normalizedSeen.add(row.normalizedTerm);
      rows.push(row);
    }
  });

  if (keywordChunkIds.size !== chunks.size) {
    failInvalid(`关键词产物与 chunks 产物数量不一致：${keywordChunkIds.size}/${chunks.size}。`);
  }

  const database = openKeywordDatabase(input.libraryPath, true);
  try {
    const importedAt = new Date().toISOString();
    return database.transaction(() => {
      const previous = database.prepare(`SELECT COUNT(*) AS count FROM ${keywordTableName} WHERE document_id = ?`).get(input.documentId) as { count: number };
      database.prepare(`DELETE FROM ${keywordTableName} WHERE document_id = ?`).run(input.documentId);
      database.prepare(`DELETE FROM ${documentTableName} WHERE document_id = ?`).run(input.documentId);

      const insert = database.prepare(`
        INSERT INTO ${keywordTableName} (
          document_id, chunk_id, normalized_term, surface_term, rank, score,
          kind, offsets_json, algorithm_version, chunk_content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insert.run(
          row.documentId,
          row.chunkId,
          row.normalizedTerm,
          row.surfaceTerm,
          row.rank,
          row.score,
          row.kind,
          row.offsetsJson,
          row.algorithmVersion,
          row.chunkContentHash,
        );
      }
      database.prepare(`
        INSERT INTO ${documentTableName} (
          document_id, source_content_hash, stage_key, chunk_count, keyword_count, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.documentId, input.sourceContentHash, input.stageKey, chunks.size, rows.length, importedAt);
      replaceMaterialChunkProjection(database, {
        documentId: input.documentId,
        sourceContentHash: input.sourceContentHash,
        stageKey: input.stageKey,
        chunks: [...chunks.values()].map((chunk) => toMaterialChunkProjection(chunk, searchTokensByChunk.get(chunk.chunkId) ?? [])),
        parents: parents ? [...parents.values()].map(toMaterialParentProjection) : undefined,
        keywords: rows.map(toMaterialKeywordProjection),
      });

      const readBack = readKeywordIndexCounts(database, input.documentId);
      if (readBack.chunkCount !== chunks.size || readBack.keywordCount !== rows.length) {
        throw new PipelineStageError('KEYWORDS_INDEX_READBACK_FAILED', '关键词索引读回核对失败，事务已回滚。', true);
      }
      return {
        documentId: input.documentId,
        importedChunks: chunks.size,
        importedKeywords: rows.length,
        replacedKeywords: Number(previous.count) || 0,
        readBackChunks: readBack.chunkCount,
        readBackKeywords: readBack.keywordCount,
        sourceContentHash: input.sourceContentHash,
        stageKey: input.stageKey,
      };
    })();
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('KEYWORDS_INDEX_WRITE_FAILED', '关键词索引写入失败，可以重试。', true, error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

export function removeKeywordIndexEntries(libraryPath: string, documentId: string): number {
  const database = openKeywordDatabase(libraryPath, false);
  if (!database) return 0;
  try {
    return database.transaction(() => {
      const current = database.prepare(`SELECT COUNT(*) AS count FROM ${keywordTableName} WHERE document_id = ?`).get(documentId) as { count: number };
      database.prepare(`DELETE FROM ${keywordTableName} WHERE document_id = ?`).run(documentId);
      database.prepare(`DELETE FROM ${documentTableName} WHERE document_id = ?`).run(documentId);
      removeMaterialChunkProjection(database, documentId);
      const readBack = readKeywordIndexCounts(database, documentId);
      if (readBack.chunkCount !== 0 || readBack.keywordCount !== 0) {
        throw new PipelineStageError('KEYWORDS_INDEX_DELETE_FAILED', '关键词索引清理核对失败，事务已回滚。', true);
      }
      return Number(current.count) || 0;
    })();
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError('KEYWORDS_INDEX_DELETE_FAILED', '关键词索引清理失败，文档尚未删除。', true, error instanceof Error ? error.message : String(error));
  } finally {
    database.close();
  }
}

export function isKeywordIndexCurrent(input: { libraryPath: string; documentId: string; sourceContentHash: string; stageKey: string; expectedChunks: number; expectedKeywords: number }): boolean {
  const database = openKeywordDatabase(input.libraryPath, false);
  if (!database) return false;
  try {
    const status = database.prepare(`
      SELECT document_id AS documentId, source_content_hash AS sourceContentHash,
             stage_key AS stageKey, chunk_count AS chunkCount, keyword_count AS keywordCount,
             imported_at AS importedAt
      FROM ${documentTableName} WHERE document_id = ?
    `).get(input.documentId) as KeywordIndexDocumentStatus | undefined;
    if (!status || status.sourceContentHash !== input.sourceContentHash || status.stageKey !== input.stageKey) return false;
    const counts = readKeywordIndexCounts(database, input.documentId);
    return status.chunkCount === input.expectedChunks
      && status.keywordCount === input.expectedKeywords
      && counts.chunkCount === input.expectedChunks
      && counts.keywordCount === input.expectedKeywords
      && isMaterialChunkProjectionCurrent(database, input);
  } catch {
    return false;
  } finally {
    database.close();
  }
}

export function readKeywordIndexDocument(libraryPath: string, documentId: string): KeywordIndexDocumentStatus | null {
  const database = openKeywordDatabase(libraryPath, false);
  if (!database) return null;
  try {
      return database.prepare(`
        SELECT document_id AS documentId, source_content_hash AS sourceContentHash,
              stage_key AS stageKey, chunk_count AS chunkCount, keyword_count AS keywordCount,
              imported_at AS importedAt
        FROM ${documentTableName} WHERE document_id = ?
      `).get(documentId) as KeywordIndexDocumentStatus | undefined ?? null;
  } finally {
    database.close();
  }
}

/** 读回 FTS5 虚表及其普通表投影数量，供流水线 UI 展示真实索引状态。 */
export function readFtsIndexProjectionSnapshot(libraryPath: string, documentId: string): FtsIndexProjectionSnapshot | null {
  const database = openKeywordDatabase(libraryPath, false);
  if (!database) return null;
  try {
    if (!tableExists(database, 'material_chunk_documents')
      || !tableExists(database, 'material_chunks')
      || !tableExists(database, 'material_chunk_fts')) return null;
    const projection = database.prepare(`
      SELECT document_id AS documentId, source_content_hash AS sourceContentHash,
             stage_key AS stageKey, chunk_count AS projectedChunkCount,
             keyword_count AS projectedKeywordCount, indexed_at AS indexedAt
      FROM material_chunk_documents WHERE document_id = ?
    `).get(documentId) as Omit<FtsIndexProjectionSnapshot, 'indexedChunks' | 'ftsRows' | 'indexedKeywords'> | undefined;
    if (!projection) return null;
    const chunks = database.prepare('SELECT COUNT(*) AS count FROM material_chunks WHERE document_id = ?').get(documentId) as { count: number };
    const fts = database.prepare('SELECT COUNT(*) AS count FROM material_chunk_fts WHERE document_id = ?').get(documentId) as { count: number };
    const keywords = database.prepare(`SELECT COUNT(*) AS count FROM ${keywordTableName} WHERE document_id = ?`).get(documentId) as { count: number };
    return {
      ...projection,
      projectedChunkCount: Number(projection.projectedChunkCount) || 0,
      projectedKeywordCount: Number(projection.projectedKeywordCount) || 0,
      indexedChunks: Number(chunks.count) || 0,
      ftsRows: Number(fts.count) || 0,
      indexedKeywords: Number(keywords.count) || 0,
    };
  } finally {
    database.close();
  }
}

async function readChunkSnapshots(filePath: string, documentId: string): Promise<Map<string, ChunkSnapshot>> {
  const chunks = new Map<string, ChunkSnapshot>();
  await forEachJsonLine(filePath, (value, lineNumber) => {
    if (value.documentId !== documentId || typeof value.chunkId !== 'string' || typeof value.text !== 'string' || !Number.isInteger(value.ordinal)) {
      failInvalid(`第 ${lineNumber} 个 chunk 记录无效。`);
    }
    if (value.parentChunkId !== undefined && value.parentChunkId !== null && typeof value.parentChunkId !== 'string') {
      failInvalid(`第 ${lineNumber} 个 chunk 的 parentChunkId 无效。`);
    }
    if (value.sectionPath !== undefined && !Array.isArray(value.sectionPath)) failInvalid(`第 ${lineNumber} 个 chunk 的 sectionPath 无效。`);
    if (value.sourceRefs !== undefined && !Array.isArray(value.sourceRefs)) failInvalid(`第 ${lineNumber} 个 chunk 的 sourceRefs 无效。`);
    if (chunks.has(value.chunkId)) failInvalid(`chunkId 重复：${value.chunkId}。`);
    chunks.set(value.chunkId, {
      documentId,
      chunkId: value.chunkId,
      parentChunkId: typeof value.parentChunkId === 'string' ? value.parentChunkId : null,
      ordinal: value.ordinal,
      text: value.text,
      sourceText: typeof value.sourceText === 'string' ? value.sourceText : value.text,
      sectionPath: Array.isArray(value.sectionPath) ? value.sectionPath : [],
      sectionContext: typeof value.sectionContext === 'string' ? value.sectionContext : '',
      sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs : [],
      contentHash: hashChunkContent(value.text),
    });
  });
  return chunks;
}

async function readParentChunkSnapshots(filePath: string, documentId: string): Promise<Map<string, ParentChunkSnapshot>> {
  const parents = new Map<string, ParentChunkSnapshot>();
  await forEachJsonLine(filePath, (value, lineNumber) => {
    if (value.documentId !== documentId || typeof value.parentId !== 'string' || !value.parentId.trim() || typeof value.text !== 'string' || !Number.isInteger(value.ordinal)) {
      failInvalid(`第 ${lineNumber} 个 Parent 记录无效。`);
    }
    if (value.sourceText !== undefined && typeof value.sourceText !== 'string') failInvalid(`第 ${lineNumber} 个 Parent 的 sourceText 无效。`);
    if (value.sectionPath !== undefined && !Array.isArray(value.sectionPath)) failInvalid(`第 ${lineNumber} 个 Parent 的 sectionPath 无效。`);
    if (value.sourceRefs !== undefined && !Array.isArray(value.sourceRefs)) failInvalid(`第 ${lineNumber} 个 Parent 的 sourceRefs 无效。`);
    if (parents.has(value.parentId)) failInvalid(`Parent ID 重复：${value.parentId}。`);
    parents.set(value.parentId, {
      documentId,
      parentChunkId: value.parentId,
      ordinal: value.ordinal,
      text: value.text,
      sourceText: typeof value.sourceText === 'string' ? value.sourceText : value.text,
      sectionPath: Array.isArray(value.sectionPath) ? value.sectionPath : [],
      sectionContext: typeof value.sectionContext === 'string' ? value.sectionContext : '',
      sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs : [],
      contentHash: hashChunkContent(value.text),
    });
  });
  return parents;
}

function parseKeywordRecord(value: JsonRecord, documentId: string, lineNumber: number): { chunkId: string; chunkContentHash: string; algorithmVersion: string; keywords: unknown[]; searchTokens: string[] } {
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== KEYWORD_OUTPUT_SCHEMA_VERSION) || value.documentId !== documentId || typeof value.chunkId !== 'string' || !value.chunkId.trim()) {
    failInvalid(`第 ${lineNumber} 个关键词记录无效。`);
  }
  if (typeof value.chunkContentHash !== 'string' || !value.chunkContentHash.startsWith('sha256:')) failInvalid(`关键词记录缺少 chunk 内容 hash：${value.chunkId}。`);
  const algorithm = value.algorithm;
  if (!isRecord(algorithm) || typeof algorithm.version !== 'string' || !algorithm.version.trim()) failInvalid(`关键词记录缺少算法版本：${value.chunkId}。`);
  if (!Array.isArray(value.keywords)) failInvalid(`关键词记录缺少 keywords 数组：${value.chunkId}。`);
  if (typeof value.schemaVersion === 'number' && value.schemaVersion >= 2) {
    if (!Array.isArray(value.keyword) || value.keyword.length !== value.keywords.length || value.keyword.some((term) => typeof term !== 'string' || !term.trim())) {
      failInvalid(`关键词记录缺少有效 keyword 字段：${value.chunkId}。`);
    }
    const detailedTerms = value.keywords.map((item) => {
      if (!isRecord(item) || typeof item.term !== 'string') failInvalid(`关键词记录的 keywords 项无效：${value.chunkId}。`);
      return item.term;
    });
    if (JSON.stringify(value.keyword) !== JSON.stringify(detailedTerms)) {
      failInvalid(`关键词记录的 keyword 字段与 keywords 不一致：${value.chunkId}。`);
    }
  }
  let searchTokens: string[] = [];
  if (typeof value.schemaVersion === 'number' && value.schemaVersion >= 3) {
    if (!Array.isArray(value.searchTokens)
      || value.searchTokens.length > maxSearchTokensPerChunk
      || value.searchTokens.some((token) => typeof token !== 'string'
        || !token
        || token !== token.trim()
        || token.length > maxSearchTokenCharacters
        || [...token].some((character) => !isPrintableCharacter(character)))) {
      failInvalid(`关键词记录缺少有效 searchTokens 字段：${value.chunkId}。`);
    }
    searchTokens = value.searchTokens as string[];
  }
  return {
    chunkId: value.chunkId,
    chunkContentHash: value.chunkContentHash,
    algorithmVersion: algorithm.version,
    keywords: value.keywords,
    searchTokens,
  };
}

function parseKeywordRow(value: unknown, record: { chunkId: string; algorithmVersion: string }, chunk: ChunkSnapshot, documentId: string, lineNumber: number, index: number): KeywordIndexRow {
  if (!isRecord(value) || typeof value.term !== 'string' || !value.term || typeof value.normalizedTerm !== 'string' || !value.normalizedTerm) {
    failInvalid(`第 ${lineNumber} 个关键词项无效。`);
  }
  if (typeof value.rank !== 'number' || !Number.isInteger(value.rank) || value.rank !== index + 1) failInvalid(`关键词 rank 不连续：${record.chunkId}。`);
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) failInvalid(`关键词 score 无效：${record.chunkId}。`);
  if (typeof value.kind !== 'string' || !value.kind) failInvalid(`关键词 kind 无效：${record.chunkId}。`);
  if (!Array.isArray(value.occurrences) || value.occurrences.length === 0) failInvalid(`关键词 occurrence 缺失：${record.chunkId}。`);

  const occurrences = value.occurrences.map((occurrence) => parseOccurrence(occurrence, chunk, value.term as string, record.chunkId));
  return {
    documentId,
    chunkId: chunk.chunkId,
    normalizedTerm: value.normalizedTerm,
    surfaceTerm: value.term,
    rank: value.rank,
    score: value.score,
    kind: value.kind,
    offsetsJson: JSON.stringify(occurrences),
    algorithmVersion: record.algorithmVersion,
    chunkContentHash: hashChunkContentFromSnapshot(chunk),
  };
}

function parseOccurrence(value: unknown, chunk: ChunkSnapshot, term: string, chunkId: string): { start: number; end: number; sentenceIndex: number } {
  if (!isRecord(value) || !Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 0 || value.end <= value.start) {
    failInvalid(`关键词 occurrence offset 无效：${chunkId}。`);
  }
  const characters = Array.from(chunk.text);
  if (value.end > characters.length || characters.slice(value.start, value.end).join('') !== term) {
    failInvalid(`关键词 occurrence 无法回指当前 chunk 原文：${chunkId}。`);
  }
  if (!Number.isInteger(value.sentenceIndex ?? 0) || (value.sentenceIndex ?? 0) < 0) failInvalid(`关键词 sentenceIndex 无效：${chunkId}。`);
  return { start: value.start, end: value.end, sentenceIndex: value.sentenceIndex ?? 0 };
}

function hashChunkContent(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function hashChunkContentFromSnapshot(chunk: ChunkSnapshot): string {
  return chunk.contentHash;
}

function toMaterialChunkProjection(chunk: ChunkSnapshot, searchTokens: string[]): MaterialChunkProjectionRecord {
  return {
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    parentChunkId: chunk.parentChunkId,
    ordinal: chunk.ordinal,
    text: chunk.text,
    sourceText: chunk.sourceText,
    sectionPath: chunk.sectionPath,
    sectionContext: chunk.sectionContext,
    sourceRefs: chunk.sourceRefs,
    contentHash: chunk.contentHash,
    searchTokens,
  };
}

function isPrintableCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
}

function toMaterialParentProjection(parent: ParentChunkSnapshot): MaterialChunkParentProjectionRecord {
  return {
    documentId: parent.documentId,
    parentChunkId: parent.parentChunkId,
    ordinal: parent.ordinal,
    text: parent.text,
    sourceText: parent.sourceText,
    sectionPath: parent.sectionPath,
    sectionContext: parent.sectionContext,
    sourceRefs: parent.sourceRefs,
    contentHash: parent.contentHash,
  };
}

function toMaterialKeywordProjection(row: KeywordIndexRow): MaterialChunkProjectionKeyword {
  return {
    chunkId: row.chunkId,
    surfaceTerm: row.surfaceTerm,
    normalizedTerm: row.normalizedTerm,
    score: row.score,
  };
}

async function forEachJsonLine(filePath: string, callback: (value: JsonRecord, lineNumber: number) => void): Promise<void> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        failInvalid(`第 ${lineNumber} 行 JSON 无效。`);
      }
      if (!isRecord(value)) failInvalid(`第 ${lineNumber} 行必须是对象。`);
      callback(value, lineNumber);
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

function openKeywordDatabase(libraryPath: string, create: boolean): Database.Database | null {
  const metadataDirectory = getLibraryMetaDirectory(libraryPath);
  if (create) fs.mkdirSync(metadataDirectory, { recursive: true });
  const databasePath = path.join(metadataDirectory, 'index.db');
  if (!create && !fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${keywordTableName} (
      document_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      normalized_term TEXT NOT NULL,
      surface_term TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK (rank >= 1),
      score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
      kind TEXT NOT NULL,
      offsets_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      chunk_content_hash TEXT NOT NULL,
      PRIMARY KEY (document_id, chunk_id, normalized_term)
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_keywords_document ON ${keywordTableName}(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_keywords_chunk ON ${keywordTableName}(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_keywords_term ON ${keywordTableName}(normalized_term);
    CREATE TABLE IF NOT EXISTS ${documentTableName} (
      document_id TEXT PRIMARY KEY,
      source_content_hash TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      keyword_count INTEGER NOT NULL CHECK (keyword_count >= 0),
      imported_at TEXT NOT NULL
    );
  `);
  return database;
}

function readKeywordIndexCounts(database: Database.Database, documentId: string): { chunkCount: number; keywordCount: number } {
  const keywordRow = database.prepare(`SELECT COUNT(*) AS keywordCount FROM ${keywordTableName} WHERE document_id = ?`).get(documentId) as { keywordCount: number };
  const documentRow = database.prepare(`SELECT chunk_count AS chunkCount FROM ${documentTableName} WHERE document_id = ?`).get(documentId) as { chunkCount: number } | undefined;
  return { chunkCount: Number(documentRow?.chunkCount) || 0, keywordCount: Number(keywordRow.keywordCount) || 0 };
}

function tableExists(database: Database.Database, tableName: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName));
}

function failInvalid(message: string): never {
  throw new PipelineStageError('KEYWORDS_INDEX_INPUT_INVALID', message, false);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
