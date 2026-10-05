import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generationProfile, readActiveGeneration } from './materialVectorGenerationStore';
import { getLibraryMetaDirectory } from '../treeOrder';
import {
  createLockedMaterialEmbeddingProfile,
  normalizeMaterialEmbeddingCandidate,
  normalizeVectorDimension,
  type MaterialEmbeddingCandidate,
  MaterialEmbeddingProfileError,
  type MaterialEmbeddingProfile,
  type MaterialEmbeddingProfileStatus,
  type MaterialEmbeddingProfileTestResult,
  type MaterialEmbeddingProbeResult,
} from './materialEmbeddingTypes';

export { computeMaterialEmbeddingProfileHash } from './materialEmbeddingTypes';

const profileTableName = 'material_embedding_profile';
const vectorTableName = 'material_chunk_vectors';
const vectorMetaTableName = 'material_chunk_vector_meta';
const profileProbeText = 'Trellora 向量模型探测文本：仅用于确认返回维度，不写入资料库。';
import { loadSqliteVec } from '../loadSqliteVec';

export type MaterialEmbeddingProbe = (input: {
  candidate: MaterialEmbeddingCandidate;
  text: string;
  signal: AbortSignal;
}) => Promise<MaterialEmbeddingProbeResult>;

export function ensureMaterialEmbeddingProfileSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${profileTableName} (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      profile_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state = 'LOCKED'),
      source_id TEXT NOT NULL,
      transport_kind TEXT NOT NULL CHECK (transport_kind IN ('ollama', 'openai-compatible')),
      endpoint_identity TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      response_model TEXT,
      requested_dimensions INTEGER,
      vector_dimension INTEGER NOT NULL CHECK (vector_dimension > 0 AND vector_dimension <= 65536),
      vector_type TEXT NOT NULL CHECK (vector_type = 'float32'),
      distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
      encoding_format TEXT NOT NULL CHECK (encoding_format = 'float'),
      truncate_inputs INTEGER NOT NULL CHECK (truncate_inputs IN (0, 1)),
      document_input_version TEXT NOT NULL,
      query_input_version TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      app_version TEXT NOT NULL
    );
  `);
  const columns = database.prepare(`PRAGMA table_info(${profileTableName})`).all() as Array<{ name: string }>;
  const requiredColumns = ['singleton_id', 'profile_hash', 'state', 'source_id', 'transport_kind', 'endpoint_identity', 'requested_model', 'response_model', 'requested_dimensions', 'vector_dimension', 'vector_type', 'distance_metric', 'encoding_format', 'truncate_inputs', 'document_input_version', 'query_input_version', 'locked_at', 'app_version'];
  if (requiredColumns.some((column) => !columns.some((entry) => entry.name === column))) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_SCHEMA_INVALID', '资料库向量 profile 表结构不完整，请先备份后执行迁移。');
  }
}

export function readMaterialEmbeddingProfile(libraryPath: string): MaterialEmbeddingProfileStatus {
  const databasePath = getDatabasePath(libraryPath);
  if (!fs.existsSync(databasePath)) return { state: 'UNBOUND' };
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  try {
    return readMaterialEmbeddingProfileFromDatabase(database);
  } finally {
    database.close();
  }
}

export function readMaterialEmbeddingProfileFromDatabase(database: Database.Database): MaterialEmbeddingProfileStatus {
  ensureMaterialEmbeddingProfileSchema(database);
  const active = readActiveGeneration(database);
  if (active) return { state: 'LOCKED', profile: generationProfile(active) };
  const row = database.prepare(`SELECT * FROM ${profileTableName} WHERE singleton_id = 1`).get() as ProfileRow | undefined;
  if (row) return { state: 'LOCKED', profile: profileFromRow(row) };
  const legacy = readLegacyState(database);
  return legacy ? { state: 'LEGACY_UNBOUND', legacy } : { state: 'UNBOUND' };
}

export async function testMaterialEmbeddingCandidate(input: {
  candidate: unknown;
  probe: MaterialEmbeddingProbe;
  signal?: AbortSignal;
}): Promise<MaterialEmbeddingProfileTestResult> {
  const candidate = normalizeMaterialEmbeddingCandidate(input.candidate);
  const signal = input.signal ?? new AbortController().signal;
  let result: MaterialEmbeddingProbeResult;
  try {
    result = await input.probe({ candidate, text: profileProbeText, signal });
  } catch (error) {
    if (error instanceof MaterialEmbeddingProfileError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROBE_FAILED', `向量模型探测失败：${message}`);
  }
  const vectorDimension = normalizeVectorDimension(result.vectorDimension);
  if (candidate.requestedDimensions !== undefined && candidate.requestedDimensions !== vectorDimension) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_DIMENSION_MISMATCH', `模型返回 ${vectorDimension} 维，但候选配置要求 ${candidate.requestedDimensions} 维。`);
  }
  const responseModel = typeof result.responseModel === 'string' && result.responseModel.trim() ? result.responseModel.trim().slice(0, 512) : undefined;
  const profile = createLockedMaterialEmbeddingProfile({ candidate, responseModel, vectorDimension, appVersion: 'probe' });
  return {
    state: 'TESTED',
    candidate,
    ...(responseModel ? { responseModel } : {}),
    vectorDimension,
    profileHash: profile.profileHash,
  };
}

export async function lockMaterialEmbeddingProfile(input: {
  libraryPath: string;
  candidate: unknown;
  probe: MaterialEmbeddingProbe;
  signal?: AbortSignal;
  appVersion?: string;
}): Promise<MaterialEmbeddingProfile> {
  const tested = await testMaterialEmbeddingCandidate({ candidate: input.candidate, probe: input.probe, signal: input.signal });
  const profile = createLockedMaterialEmbeddingProfile({
    candidate: tested.candidate,
    responseModel: tested.responseModel,
    vectorDimension: tested.vectorDimension,
    appVersion: input.appVersion,
  });
  const databasePath = getDatabasePath(input.libraryPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  try {
    ensureMaterialEmbeddingProfileSchema(database);
    database.exec('BEGIN IMMEDIATE');
    try {
      const current = readMaterialEmbeddingProfileFromDatabase(database);
      if (current.state === 'LOCKED' && current.profile) {
        if (current.profile.profileHash === profile.profileHash) {
          database.exec('COMMIT');
          return current.profile;
        }
        throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_LOCKED', '该资料库的向量模型已经锁定，不能更换。');
      }
      if (current.state === 'LEGACY_UNBOUND') {
        throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION', '资料库存在未标识的旧向量索引，请先备份并执行迁移。');
      }

      ensureVectorTable(database, profile.vectorDimension);
      insertProfile(database, profile);
      database.exec('COMMIT');
      return profile;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

export function getMaterialEmbeddingProfileProbeText(): string {
  return profileProbeText;
}

function ensureVectorTable(database: Database.Database, dimension: number): void {
  const existing = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(vectorTableName) as { sql?: string } | undefined;
  if (existing) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${vectorTableName}`).get() as { count: number };
    if (Number(row.count) > 0) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_LEGACY_REQUIRES_MIGRATION', '资料库已有旧向量数据，不能在首次锁定时覆盖。');
    }
    const existingDimension = readVectorTableDimension(existing.sql ?? '');
    if (existingDimension !== dimension) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_VECTOR_SCHEMA_CONFLICT', '资料库已有空向量表，但维度与候选模型不一致。');
    }
    return;
  }
  loadSqliteVec(database);
  database.exec(`CREATE VIRTUAL TABLE ${vectorTableName} USING vec0(embedding float[${dimension}] distance_metric=cosine)`);
}

function insertProfile(database: Database.Database, profile: MaterialEmbeddingProfile): void {
  database.prepare(`
    INSERT INTO ${profileTableName} (
      singleton_id, profile_hash, state, source_id, transport_kind, endpoint_identity,
      requested_model, response_model, requested_dimensions, vector_dimension,
      vector_type, distance_metric, encoding_format, truncate_inputs,
      document_input_version, query_input_version, locked_at, app_version
    ) VALUES (1, ?, 'LOCKED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.profileHash,
    profile.sourceId,
    profile.transportKind,
    profile.endpointIdentity,
    profile.requestedModel,
    profile.responseModel ?? null,
    profile.requestedDimensions ?? null,
    profile.vectorDimension,
    profile.vectorType,
    profile.distanceMetric,
    profile.encodingFormat,
    profile.truncateInputs ? 1 : 0,
    profile.documentInputVersion,
    profile.queryInputVersion,
    profile.lockedAt,
    profile.appVersion,
  );
}

function readLegacyState(database: Database.Database): MaterialEmbeddingProfileStatus['legacy'] | undefined {
  const vectorTable = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(vectorTableName);
  const vectorTableExists = Boolean(vectorTable);
  let vectorRowCount = 0;
  if (vectorTableExists) {
    loadSqliteVec(database);
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${vectorTableName}`).get() as { count: number };
    vectorRowCount = Number(row.count) || 0;
  }
  const storedModel = readMetaValue(database, 'embedding_model');
  const storedDimensionText = readMetaValue(database, 'vector_dimension');
  const storedDimension = storedDimensionText && /^\d+$/u.test(storedDimensionText) ? Number(storedDimensionText) : undefined;
  if (vectorRowCount <= 0) return undefined;
  return {
    vectorTableExists,
    vectorRowCount,
    ...(storedModel ? { storedModel } : {}),
    ...(storedDimension ? { storedDimension } : {}),
  };
}

function readMetaValue(database: Database.Database, key: string): string | undefined {
  const exists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(vectorMetaTableName);
  if (!exists) return undefined;
  const row = database.prepare(`SELECT value FROM ${vectorMetaTableName} WHERE key = ?`).get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : undefined;
}

function profileFromRow(row: ProfileRow): MaterialEmbeddingProfile {
  const candidate = normalizeMaterialEmbeddingCandidate({
    schemaVersion: 1,
    sourceId: row.source_id,
    transportKind: row.transport_kind,
    endpointIdentity: row.endpoint_identity,
    requestedModel: row.requested_model,
    ...(row.requested_dimensions === null ? {} : { requestedDimensions: row.requested_dimensions }),
    vectorType: row.vector_type,
    distanceMetric: row.distance_metric,
    encodingFormat: row.encoding_format,
    truncateInputs: row.truncate_inputs === 1,
    documentInputVersion: row.document_input_version,
    queryInputVersion: row.query_input_version,
  });
  const vectorDimension = normalizeVectorDimension(row.vector_dimension);
  const responseModel = typeof row.response_model === 'string' && row.response_model.trim() ? row.response_model.trim() : undefined;
  const expectedHash = createLockedMaterialEmbeddingProfile({ candidate, responseModel, vectorDimension, lockedAt: row.locked_at, appVersion: row.app_version }).profileHash;
  if (expectedHash !== row.profile_hash) {
    throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_SCHEMA_INVALID', '资料库向量 profile 校验失败，语义检索已停用。');
  }
  return {
    ...candidate,
    profileHash: row.profile_hash,
    state: 'LOCKED',
    ...(responseModel ? { responseModel } : {}),
    vectorDimension,
    lockedAt: row.locked_at,
    appVersion: row.app_version,
  };
}

function getDatabasePath(libraryPath: string): string {
  return path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
}

function readVectorTableDimension(sql: string): number | undefined {
  const match = sql.match(/float\[(\d+)\]/u);
  return match ? Number(match[1]) : undefined;
}

interface ProfileRow {
  profile_hash: string;
  state: 'LOCKED';
  source_id: string;
  transport_kind: 'ollama' | 'openai-compatible';
  endpoint_identity: string;
  requested_model: string;
  response_model: string | null;
  requested_dimensions: number | null;
  vector_dimension: number;
  vector_type: 'float32';
  distance_metric: 'cosine';
  encoding_format: 'float';
  truncate_inputs: number;
  document_input_version: string;
  query_input_version: string;
  locked_at: string;
  app_version: string;
}
