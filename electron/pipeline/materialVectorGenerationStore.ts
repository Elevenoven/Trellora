import Database from 'better-sqlite3';
import { createLockedMaterialEmbeddingProfile, type MaterialEmbeddingProfile } from './materialEmbeddingTypes';
import type { MaterialVectorGeneration } from '../../shared/materialVectorGenerations';

export interface GenerationRow {
  id: string; state: MaterialVectorGeneration['state']; profile_json: string; vector_table: string;
  projection_hash: string; sources_hash: string; completed: number; total: number;
  evaluated_queries: number; created_at: string; error: string | null;
}

/** 代际记录与 active 指针只属于向量域，不修改原有 LOCKED 单例。 */
export function ensureMaterialVectorGenerationSchema(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS material_vector_generations (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, profile_json TEXT NOT NULL, vector_table TEXT NOT NULL,
    projection_hash TEXT NOT NULL, sources_hash TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, evaluated_queries INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS material_vector_active_generation (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), generation_id TEXT NOT NULL);`);
}

/** 所有动态 SQL 表名由主进程 UUID 派生；数据库内的任意字符串不能成为 SQL。 */
export function generationVectorTable(id: string): string {
  if (id === 'original') return 'material_chunk_vectors';
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('向量索引代际 ID 无效。');
  return `material_chunk_vectors_g_${id}`;
}

export function readActiveGeneration(database: Database.Database): GenerationRow | undefined {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='material_vector_active_generation'").get()) return undefined;
  const pointer = database.prepare('SELECT generation_id FROM material_vector_active_generation WHERE singleton_id=1').get() as { generation_id: string } | undefined;
  if (!pointer) return undefined;
  const row = database.prepare('SELECT * FROM material_vector_generations WHERE id=?').get(pointer.generation_id) as GenerationRow | undefined;
  if (!row || row.state !== 'ACTIVE' || row.vector_table !== generationVectorTable(row.id)) throw new Error('激活的向量索引代际损坏，语义检索已停用。');
  return row;
}

export function getActiveMaterialVectorTable(database: Database.Database): string {
  return readActiveGeneration(database)?.vector_table ?? 'material_chunk_vectors';
}

export function generationProfile(row: GenerationRow): MaterialEmbeddingProfile {
  const profile = JSON.parse(row.profile_json) as MaterialEmbeddingProfile;
  const expected = createLockedMaterialEmbeddingProfile({ candidate: profile, responseModel: profile.responseModel, vectorDimension: profile.vectorDimension, lockedAt: profile.lockedAt, appVersion: profile.appVersion });
  if (profile.state !== 'LOCKED' || profile.profileHash !== expected.profileHash) throw new Error('向量索引代际模型校验失败。');
  return expected;
}

export function generationView(row: GenerationRow): MaterialVectorGeneration {
  return { id: row.id, state: row.state, profile: generationProfile(row), completed: row.completed, total: row.total,
    evaluatedQueries: row.evaluated_queries, createdAt: row.created_at, ...(row.error ? { error: row.error } : {}) };
}
