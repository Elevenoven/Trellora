import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { ensureMaterialChunkSearchSchema } from './materialChunkSearch';
import { ensureMaterialEmbeddingProfileSchema, lockMaterialEmbeddingProfile, readMaterialEmbeddingProfileFromDatabase } from './materialEmbeddingProfile';
import type { MaterialEmbeddingAdapter } from './materialEmbeddingAdapters';
import { getActiveMaterialVectorTable } from './materialVectorGenerationStore';
import {
  MaterialEmbeddingAdapterError,
  MaterialEmbeddingProfileError,
  type MaterialEmbeddingProfile,
} from './materialEmbeddingTypes';

const jobsTableName = 'material_embedding_jobs';
const stateTableName = 'material_chunk_embedding_state';
const vectorMetaTableName = 'material_chunk_vector_meta';

export type MaterialVectorJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'FAILED_RETRYABLE'
  | 'FAILED'
  | 'SUCCEEDED';

export interface MaterialVectorCoordinatorOptions {
  libraryPath: string;
  documentId?: string;
  documentIds?: string[];
  adapter: MaterialEmbeddingAdapter;
  profile?: MaterialEmbeddingProfile;
  batchSize?: number;
  maxBatchCharacters?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  shouldCancel?: () => boolean;
  onProgress?: (report: MaterialVectorJobReport) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  /** 仅用于验证数据库写入失败时事务不会留下半批数据。 */
  beforeBatchCommit?: (input: { rowIds: number[]; vectors: number[][] }) => void | Promise<void>;
}

export interface MaterialVectorJobReport {
  schemaVersion: 1;
  jobId: string;
  documentId?: string;
  profileHash: string;
  state: MaterialVectorJobState;
  totalItems: number;
  completedItems: number;
  skippedItems: number;
  failedItems: number;
  batchCount: number;
  retryCount: number;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MaterialVectorReconcileResult {
  totalItems: number;
  completedItems: number;
  pendingItems: number;
  inFlightItems: number;
  failedItems: number;
}

export interface MaterialVectorCoordinatorSchemaOptions {
  database: Database.Database;
}

export { ensureMaterialChunkSearchSchema, ensureMaterialEmbeddingProfileSchema, lockMaterialEmbeddingProfile, readMaterialEmbeddingProfileFromDatabase, MaterialEmbeddingAdapterError };
export type { MaterialEmbeddingAdapter } from './materialEmbeddingAdapters';
export { getActiveMaterialVectorTable } from './materialVectorGenerationStore';

export function isMaterialVectorProjectionCurrent(input: {
  libraryPath: string;
  documentId: string;
  profileHash: string;
  expectedChunks?: number;
}): boolean {
  if (!input.profileHash || input.profileHash === 'UNBOUND') return false;
  const databasePath = getMaterialDatabasePath(input.libraryPath);
  if (!fs.existsSync(databasePath)) return false;
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  try {
    ensureMaterialChunkSearchSchema(database);
    ensureMaterialEmbeddingProfileSchema(database);
    ensureMaterialVectorCoordinatorSchema(database);
    const status = readMaterialEmbeddingProfileFromDatabase(database);
    if (status.state !== 'LOCKED' || status.profile?.profileHash !== input.profileHash) return false;
    const progress = readProgress(database, input.profileHash, input.documentId);
    return progress.totalItems === progress.completedItems
      && progress.pendingItems === 0
      && progress.inFlightItems === 0
      && progress.failedItems === 0
      && (input.expectedChunks === undefined || progress.totalItems === input.expectedChunks);
  } catch {
    return false;
  } finally {
    database.close();
  }
}

export function readMaterialVectorProjectionSnapshot(libraryPath: string, documentId: string): {
  profile: MaterialEmbeddingProfile;
  progress: MaterialVectorReconcileResult;
} | null {
  const databasePath = getMaterialDatabasePath(libraryPath);
  if (!fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  try {
    ensureMaterialChunkSearchSchema(database);
    ensureMaterialEmbeddingProfileSchema(database);
    ensureMaterialVectorCoordinatorSchema(database);
    const status = readMaterialEmbeddingProfileFromDatabase(database);
    if (status.state !== 'LOCKED' || !status.profile) return null;
    return { profile: status.profile, progress: readProgress(database, status.profile.profileHash, documentId) };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

interface MaterialVectorChunk {
  rowId: number;
  documentId: string;
  chunkId: string;
  text: string;
  contentHash: string;
}

interface MaterialVectorStateRow {
  chunk_rowid: number;
  document_id: string;
  chunk_id: string;
  chunk_content_hash: string;
  profile_hash: string;
  state: 'PENDING' | 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED';
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface MaterialVectorJobRow {
  job_id: string;
  document_id: string | null;
  profile_hash: string;
  state: MaterialVectorJobState;
  total_items: number;
  completed_items: number;
  skipped_items: number;
  failed_items: number;
  batch_count: number;
  retry_count: number;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

class SingleBatchTooLargeError extends Error {
  readonly code = 'EMBEDDING_BATCH_TOO_LARGE' as const;
  readonly item: MaterialVectorChunk;

  constructor(item: MaterialVectorChunk, message: string) {
    super(message);
    this.name = 'SingleBatchTooLargeError';
    this.item = item;
  }
}

export function ensureMaterialVectorCoordinatorSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${jobsTableName} (
      job_id TEXT PRIMARY KEY,
      document_id TEXT,
      profile_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','CANCEL_REQUESTED','CANCELLED','FAILED_RETRYABLE','FAILED','SUCCEEDED')),
      total_items INTEGER NOT NULL CHECK (total_items >= 0),
      completed_items INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
      skipped_items INTEGER NOT NULL DEFAULT 0 CHECK (skipped_items >= 0),
      failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
      batch_count INTEGER NOT NULL DEFAULT 0 CHECK (batch_count >= 0),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_material_embedding_jobs_document
      ON ${jobsTableName}(document_id, updated_at);
    CREATE TABLE IF NOT EXISTS ${stateTableName} (
      chunk_rowid INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      chunk_content_hash TEXT NOT NULL,
      profile_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','SUCCEEDED','FAILED')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_token TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(document_id, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_chunk_embedding_pending
      ON ${stateTableName}(profile_hash, state, document_id, chunk_rowid);
  `);
  const jobColumns = database.prepare(`PRAGMA table_info(${jobsTableName})`).all() as Array<{ name: string }>;
  const stateColumns = database.prepare(`PRAGMA table_info(${stateTableName})`).all() as Array<{ name: string }>;
  const requiredJobColumns = ['job_id', 'document_id', 'profile_hash', 'state', 'total_items', 'completed_items', 'skipped_items', 'failed_items', 'batch_count', 'retry_count', 'created_at', 'started_at', 'updated_at', 'finished_at', 'error_code', 'error_message'];
  const requiredStateColumns = ['chunk_rowid', 'document_id', 'chunk_id', 'chunk_content_hash', 'profile_hash', 'state', 'attempt_count', 'lease_token', 'lease_expires_at', 'last_error_code', 'last_error_message', 'updated_at'];
  if (requiredJobColumns.some((column) => !jobColumns.some((entry) => entry.name === column)) || requiredStateColumns.some((column) => !stateColumns.some((entry) => entry.name === column))) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_WRITE_FAILED', '资料库向量批处理表结构不完整，请先备份后执行迁移。');
  }
}

export function recoverExpiredMaterialEmbeddingLeases(database: Database.Database, now = new Date()): number {
  ensureMaterialVectorCoordinatorSchema(database);
  const result = database.prepare(`
    UPDATE ${stateTableName}
    SET state = 'PENDING', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = 'EMBEDDING_LEASE_EXPIRED',
        last_error_message = '上一次向量批次租约已过期，已恢复为待处理。',
        updated_at = ?
    WHERE state = 'IN_FLIGHT' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(now.toISOString(), now.toISOString());
  const recovered = Number(result.changes);
  if (recovered > 0) {
    database.prepare(`
      UPDATE ${jobsTableName}
      SET state = 'FAILED_RETRYABLE', error_code = 'EMBEDDING_LEASE_EXPIRED',
          error_message = '向量批处理租约已过期，已由后续任务恢复。', updated_at = ?
      WHERE state IN ('RUNNING', 'CANCEL_REQUESTED')
    `).run(now.toISOString());
  }
  return recovered;
}

export function reconcileMaterialVectorState(input: {
  database: Database.Database;
  profile: MaterialEmbeddingProfile;
  documentId?: string;
  documentIds?: string[];
  now?: Date;
}): MaterialVectorReconcileResult {
  ensureMaterialChunkSearchSchema(input.database);
  ensureMaterialVectorCoordinatorSchema(input.database);
  const now = (input.now ?? new Date()).toISOString();
  const documentFilter = buildDocumentFilter('chunks.document_id', input.documentId, input.documentIds);
  input.database.transaction(() => {
    const chunks = loadChunks(input.database, documentFilter);
    const currentRowIds = new Set(chunks.map((chunk) => chunk.rowId));
    const stateRows = input.database.prepare(`SELECT * FROM ${stateTableName} WHERE ${buildDocumentFilter('document_id', input.documentId, input.documentIds).sql}`).all(...buildDocumentFilter('document_id', input.documentId, input.documentIds).params) as MaterialVectorStateRow[];
    const deleteVector = input.database.prepare(`DELETE FROM ${getActiveMaterialVectorTable(input.database)} WHERE rowid = ?`);
    const deleteState = input.database.prepare(`DELETE FROM ${stateTableName} WHERE chunk_rowid = ?`);
    for (const row of stateRows) {
      if (!currentRowIds.has(Number(row.chunk_rowid))) {
        deleteVector.run(BigInt(row.chunk_rowid));
        deleteState.run(row.chunk_rowid);
      }
    }
    const stateByRowId = new Map(stateRows.map((row) => [Number(row.chunk_rowid), row]));
    const upsertPending = input.database.prepare(`
      INSERT INTO ${stateTableName} (
        chunk_rowid, document_id, chunk_id, chunk_content_hash, profile_hash,
        state, attempt_count, lease_token, lease_expires_at,
        last_error_code, last_error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(chunk_rowid) DO UPDATE SET
        document_id = excluded.document_id,
        chunk_id = excluded.chunk_id,
        chunk_content_hash = excluded.chunk_content_hash,
        profile_hash = excluded.profile_hash,
        state = 'PENDING', attempt_count = 0,
        lease_token = NULL, lease_expires_at = NULL,
        last_error_code = NULL, last_error_message = NULL,
        updated_at = excluded.updated_at
    `);
    for (const chunk of chunks) {
      const state = stateByRowId.get(chunk.rowId);
      const vectorExists = hasVector(input.database, chunk.rowId);
      const sameInput = state?.profile_hash === input.profile.profileHash && state?.chunk_content_hash === chunk.contentHash;
      const activeLease = state?.state === 'IN_FLIGHT' && Boolean(state.lease_expires_at && state.lease_expires_at > now);
      if (sameInput && state?.state === 'SUCCEEDED' && vectorExists) continue;
      if (sameInput && state?.state === 'FAILED' && !isRetryableErrorCode(state.last_error_code)) continue;
      if (sameInput && activeLease) continue;
      deleteVector.run(BigInt(chunk.rowId));
      upsertPending.run(chunk.rowId, chunk.documentId, chunk.chunkId, chunk.contentHash, input.profile.profileHash, now);
    }
  })();
  return readReconcileResult(input.database, input.profile.profileHash, input.documentId, input.documentIds);
}

export async function synchronizeMaterialVectors(input: MaterialVectorCoordinatorOptions): Promise<MaterialVectorJobReport> {
  const settings = normalizeSettings(input);
  const database = openMaterialDatabase(input.libraryPath);
  const jobId = crypto.randomUUID();
  let profile: MaterialEmbeddingProfile;
  let initialSkipped = 0;
  let terminalError: { code: string; message: string; retryable: boolean } | undefined;
  let cancelled = false;
  try {
    const status = readMaterialEmbeddingProfileFromDatabase(database);
    if (status.state !== 'LOCKED' || !status.profile) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_REQUIRED', '资料库尚未锁定向量模型，不能开始向量批处理。');
    }
    profile = status.profile;
    if (input.profile && input.profile.profileHash !== profile.profileHash) {
      throw new MaterialEmbeddingProfileError('EMBEDDING_PROFILE_MISMATCH', '向量批处理使用的 profile 与资料库锁定 profile 不一致。');
    }

    recoverExpiredMaterialEmbeddingLeases(database, settings.now());
    const reconciled = reconcileMaterialVectorState({
      database,
      profile,
      documentId: input.documentId,
      documentIds: input.documentIds,
      now: settings.now(),
    });
    initialSkipped = reconciled.completedItems;
    const progress = readProgress(database, profile.profileHash, input.documentId, input.documentIds);
    database.prepare(`
      INSERT INTO ${jobsTableName} (
        job_id, document_id, profile_hash, state, total_items, completed_items,
        skipped_items, failed_items, batch_count, retry_count,
        created_at, started_at, updated_at, finished_at, error_code, error_message
      ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, 0, 0, ?, NULL, ?, NULL, NULL, NULL)
    `).run(
      jobId,
      input.documentId ?? null,
      profile.profileHash,
      progress.totalItems,
      progress.completedItems,
      initialSkipped,
      progress.failedItems,
      settings.now().toISOString(),
      settings.now().toISOString(),
    );
    if (progress.totalItems === progress.completedItems && progress.failedItems === 0) {
      finishJob(database, jobId, 'SUCCEEDED', profile.profileHash, input, settings.now());
      return emitAndReturnReport(database, jobId, profile.profileHash, input, undefined);
    }
    markJobRunning(database, jobId, settings.now());
    while (true) {
      if (isCancelled(input)) {
        cancelled = true;
        cancelJob(database, jobId, profile.profileHash, input, settings.now());
        break;
      }
      const pending = loadPendingChunks(database, input.documentId, input.documentIds);
      if (pending.length === 0) {
        const current = readProgress(database, profile.profileHash, input.documentId, input.documentIds);
        if (current.totalItems === current.completedItems && current.failedItems === 0) {
          finishJob(database, jobId, 'SUCCEEDED', profile.profileHash, input, settings.now());
        } else if (current.failedItems > 0) {
          finishJob(database, jobId, terminalError?.retryable ? 'FAILED_RETRYABLE' : 'FAILED', profile.profileHash, input, settings.now(), terminalError);
        }
        break;
      }
      const claimed = claimPendingBatch(database, pending, settings, jobId, settings.now());
      if (claimed.length === 0) continue;
      const leaseToken = claimed[0].leaseToken;
      try {
        await processClaimedBatch(database, claimed.map((item) => item.chunk), leaseToken, profile, input, settings, jobId);
      } catch (error) {
        if (isCancelled(input) || getErrorCode(error) === 'EMBEDDING_CANCELLED') {
          cancelled = true;
          cancelJob(database, jobId, profile.profileHash, input, settings.now(), leaseToken);
          break;
        }
        if (error instanceof SingleBatchTooLargeError) {
          terminalError = { code: error.code, message: error.message, retryable: false };
          markSingleBatchTooLarge(database, jobId, profile.profileHash, input, error.item, leaseToken, settings.now());
          continue;
        }
        const adapterError = toAdapterError(error);
        const retryable = adapterError.retryable;
        const attemptsExhausted = claimed.some((item) => item.attemptCount >= settings.maxAttempts);
        const finalFailure = !retryable || attemptsExhausted;
        releaseClaim(database, jobId, profile.profileHash, input, leaseToken, claimed.map((item) => item.chunk), adapterError, finalFailure, settings.now());
        terminalError = { code: adapterError.code, message: adapterError.message, retryable };
        if (finalFailure) break;
        await settings.sleep(computeBackoff(adapterError.retryAfterMs, claimed[0].attemptCount, settings, input.random));
      }
    }
    if (!cancelled) {
      const currentJob = readJobReport(database, jobId);
      if (currentJob.state === 'RUNNING' && terminalError) {
        finishJob(database, jobId, terminalError.retryable ? 'FAILED_RETRYABLE' : 'FAILED', profile.profileHash, input, settings.now(), terminalError);
      }
    }
    return emitAndReturnReport(database, jobId, profile.profileHash, input, cancelled ? undefined : terminalError);
  } finally {
    database.close();
  }
}

export function removeMaterialVectorEntries(database: Database.Database, documentId: string): number {
  ensureMaterialChunkSearchSchema(database);
  ensureMaterialVectorCoordinatorSchema(database);
  const rows = database.prepare(`SELECT id FROM material_chunks WHERE document_id = ?`).all(documentId) as Array<{ id: number }>;
  const deleteVector = database.prepare(`DELETE FROM ${getActiveMaterialVectorTable(database)} WHERE rowid = ?`);
  database.transaction(() => {
    for (const row of rows) deleteVector.run(BigInt(row.id));
    database.prepare(`DELETE FROM ${stateTableName} WHERE document_id = ?`).run(documentId);
    database.prepare(`DELETE FROM ${jobsTableName} WHERE document_id = ?`).run(documentId);
  })();
  return rows.length;
}

function normalizeSettings(input: MaterialVectorCoordinatorOptions) {
  const normalizePositiveInt = (value: number | undefined, fallback: number, max: number) => {
    const normalized = Number.isFinite(value) ? Math.floor(value as number) : fallback;
    return Math.max(1, Math.min(max, normalized));
  };
  return {
    batchSize: normalizePositiveInt(input.batchSize, 16, 512),
    maxBatchCharacters: normalizePositiveInt(input.maxBatchCharacters, 24_000, 2_000_000),
    timeoutMs: normalizePositiveInt(input.timeoutMs, 60_000, 10 * 60_000),
    maxAttempts: normalizePositiveInt(input.maxAttempts, 5, 20),
    initialBackoffMs: normalizePositiveInt(input.initialBackoffMs, 1_000, 10 * 60_000),
    maxBackoffMs: normalizePositiveInt(input.maxBackoffMs, 30_000, 10 * 60_000),
    leaseMs: normalizePositiveInt(input.leaseMs, 5 * 60_000, 24 * 60 * 60_000),
    sleep: input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    now: input.now ?? (() => new Date()),
  };
}

function openMaterialDatabase(libraryPath: string): Database.Database {
  const databasePath = getMaterialDatabasePath(libraryPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  ensureMaterialChunkSearchSchema(database);
  ensureMaterialEmbeddingProfileSchema(database);
  ensureMaterialVectorCoordinatorSchema(database);
  return database;
}

function getMaterialDatabasePath(libraryPath: string): string {
  return path.join(getLibraryMetaDirectory(libraryPath), 'index.db');
}

function loadChunks(database: Database.Database, filter: { sql: string; params: unknown[] }): MaterialVectorChunk[] {
  return database.prepare(`
    SELECT chunks.id AS rowId, chunks.document_id AS documentId,
           chunks.chunk_id AS chunkId, chunks.text, chunks.content_hash AS contentHash
    FROM material_chunks AS chunks WHERE ${filter.sql} ORDER BY chunks.id
  `).all(...filter.params) as MaterialVectorChunk[];
}

function loadPendingChunks(database: Database.Database, documentId?: string, documentIds?: string[]): Array<MaterialVectorClaimedChunk> {
  const filter = buildDocumentFilter('document_id', documentId, documentIds);
  return database.prepare(`
    SELECT states.chunk_rowid AS rowId, states.document_id AS documentId, states.chunk_id AS chunkId,
           chunks.text, chunks.content_hash AS contentHash,
           states.attempt_count AS attemptCount, states.lease_token AS leaseToken
    FROM ${stateTableName} AS states
    JOIN material_chunks AS chunks ON chunks.id = states.chunk_rowid
    WHERE states.state = 'PENDING' AND ${filter.sql.replaceAll('document_id', 'states.document_id')}
    ORDER BY chunk_rowid
  `).all(...filter.params).map((row) => {
    const value = row as { rowId: number; documentId: string; chunkId: string; contentHash: string; text: string; attemptCount: number; leaseToken: string | null };
    return { chunk: { rowId: Number(value.rowId), documentId: value.documentId, chunkId: value.chunkId, text: value.text, contentHash: value.contentHash }, attemptCount: Number(value.attemptCount), leaseToken: value.leaseToken ?? '' };
  });
}

interface MaterialVectorClaimedChunk {
  chunk: MaterialVectorChunk;
  attemptCount: number;
  leaseToken: string;
}

function claimPendingBatch(database: Database.Database, pending: MaterialVectorClaimedChunk[], settings: ReturnType<typeof normalizeSettings>, jobId: string, now: Date): MaterialVectorClaimedChunk[] {
  const selected: MaterialVectorClaimedChunk[] = [];
  let characters = 0;
  for (const item of pending) {
    if (selected.length >= settings.batchSize) break;
    const nextCharacters = characters + item.chunk.text.length;
    if (selected.length > 0 && nextCharacters > settings.maxBatchCharacters) break;
    selected.push(item);
    characters = nextCharacters;
  }
  if (selected.length === 0 && pending.length > 0) selected.push(pending[0]);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + settings.leaseMs).toISOString();
  database.transaction(() => {
    const update = database.prepare(`
      UPDATE ${stateTableName}
      SET state = 'IN_FLIGHT', lease_token = ?, lease_expires_at = ?,
          attempt_count = attempt_count + 1, updated_at = ?
      WHERE chunk_rowid = ? AND state = 'PENDING'
    `);
    for (const item of selected) update.run(leaseToken, leaseExpiresAt, now.toISOString(), item.chunk.rowId);
    const actual = database.prepare(`SELECT chunk_rowid AS rowId, attempt_count AS attemptCount FROM ${stateTableName} WHERE lease_token = ? AND state = 'IN_FLIGHT'`).all(leaseToken) as Array<{ rowId: number; attemptCount: number }>;
    if (actual.length !== selected.length) throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_WRITE_FAILED', '领取向量批次时发现状态已被其他任务改变，请稍后重试。', { retryable: true });
    const attemptsById = new Map(actual.map((row) => [Number(row.rowId), Number(row.attemptCount)]));
    selected.forEach((item) => { item.attemptCount = attemptsById.get(item.chunk.rowId) ?? item.attemptCount + 1; item.leaseToken = leaseToken; });
    database.prepare(`UPDATE ${jobsTableName} SET state = 'RUNNING', started_at = COALESCE(started_at, ?), updated_at = ? WHERE job_id = ?`).run(now.toISOString(), now.toISOString(), jobId);
  })();
  return selected;
}

async function processClaimedBatch(
  database: Database.Database,
  chunks: MaterialVectorChunk[],
  leaseToken: string,
  profile: MaterialEmbeddingProfile,
  input: MaterialVectorCoordinatorOptions,
  settings: ReturnType<typeof normalizeSettings>,
  jobId: string,
): Promise<void> {
  const processSubBatch = async (items: MaterialVectorChunk[]): Promise<void> => {
    if (isCancelled(input)) throw new MaterialEmbeddingAdapterError('EMBEDDING_CANCELLED', '向量批处理已取消。');
    try {
      const result = await input.adapter.embedBatch({
        profile,
        texts: items.map((item) => item.text),
        signal: input.signal,
        timeoutMs: settings.timeoutMs,
      });
      validateBatchResult(result, items, profile);
      try {
        await input.beforeBatchCommit?.({ rowIds: items.map((item) => item.rowId), vectors: result.vectors });
      } catch (error) {
        throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_WRITE_FAILED', `向量批次落库前校验失败：${error instanceof Error ? error.message : String(error)}`, { retryable: true });
      }
      commitBatch(database, jobId, profile, input, items, leaseToken, result.vectors, settings.now());
      input.onProgress?.(readJobReport(database, jobId));
    } catch (error) {
      if (error instanceof SingleBatchTooLargeError) throw error;
      const adapterError = toAdapterError(error);
      if (adapterError.code === 'EMBEDDING_BATCH_TOO_LARGE') {
        if (items.length === 1) throw new SingleBatchTooLargeError(items[0], adapterError.message);
        const middle = Math.ceil(items.length / 2);
        await processSubBatch(items.slice(0, middle));
        await processSubBatch(items.slice(middle));
        return;
      }
      throw adapterError;
    }
  };
  await processSubBatch(chunks);
}

function validateBatchResult(result: { vectors: number[][]; dimension: number; responseModel?: string }, chunks: MaterialVectorChunk[], profile: MaterialEmbeddingProfile): void {
  if (!result || !Array.isArray(result.vectors) || result.vectors.length !== chunks.length) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '向量服务返回数量与提交批次不一致。');
  }
  if (result.dimension !== profile.vectorDimension) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_DIMENSION_MISMATCH', `向量服务返回维度 ${result.dimension} 与锁定 profile 的 ${profile.vectorDimension} 不一致。`);
  }
  const expectedModel = profile.responseModel ?? profile.requestedModel;
  if (result.responseModel && result.responseModel !== expectedModel) {
    throw new MaterialEmbeddingAdapterError('EMBEDDING_MODEL_MISMATCH', `向量服务返回模型 ${result.responseModel} 与锁定模型 ${expectedModel} 不一致。`);
  }
  for (const vector of result.vectors) {
    if (!Array.isArray(vector) || vector.length !== profile.vectorDimension || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new MaterialEmbeddingAdapterError('EMBEDDING_RESPONSE_INVALID', '向量服务返回了非有限值或维度错误。');
    }
  }
}

function commitBatch(database: Database.Database, jobId: string, profile: MaterialEmbeddingProfile, input: MaterialVectorCoordinatorOptions, chunks: MaterialVectorChunk[], leaseToken: string, vectors: number[][], now: Date): void {
  try {
    database.transaction(() => {
      if (readMaterialEmbeddingProfileFromDatabase(database).profile?.profileHash !== profile.profileHash) {
        throw new MaterialEmbeddingAdapterError('EMBEDDING_PROFILE_MISMATCH', '索引代际已经切换，旧批次不能写入新向量空间。');
      }
      const insertVector = database.prepare(`INSERT OR REPLACE INTO ${getActiveMaterialVectorTable(database)}(rowid, embedding) VALUES (?, ?)`);
      const updateState = database.prepare(`
        UPDATE ${stateTableName}
        SET state = 'SUCCEEDED', profile_hash = ?, chunk_content_hash = ?,
            lease_token = NULL, lease_expires_at = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE chunk_rowid = ? AND state = 'IN_FLIGHT' AND lease_token = ?
      `);
      chunks.forEach((chunk, index) => {
        insertVector.run(BigInt(chunk.rowId), toVectorBuffer(vectors[index]));
        const result = updateState.run(profile.profileHash, chunk.contentHash, now.toISOString(), chunk.rowId, leaseToken);
        if (Number(result.changes) !== 1) throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_WRITE_FAILED', '向量批次状态已被其他任务改变，事务已回滚。', { retryable: true });
      });
      setVectorMeta(database, 'embedding_model', profile.requestedModel);
      setVectorMeta(database, 'vector_dimension', String(profile.vectorDimension));
      setVectorMeta(database, 'embedding_profile_hash', profile.profileHash);
      for (const chunk of chunks) {
        if (!hasVector(database, chunk.rowId)) throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_READBACK_FAILED', '向量写入后读回失败，事务已回滚。', { retryable: true });
      }
      const progress = readProgress(database, profile.profileHash, input.documentId, input.documentIds);
      database.prepare(`
        UPDATE ${jobsTableName}
        SET completed_items = ?, failed_items = ?, batch_count = batch_count + 1, updated_at = ?
        WHERE job_id = ?
      `).run(progress.completedItems, progress.failedItems, now.toISOString(), jobId);
    })();
  } catch (error) {
    if (error instanceof MaterialEmbeddingAdapterError) throw error;
    throw new MaterialEmbeddingAdapterError('EMBEDDING_DB_WRITE_FAILED', `向量批次落库失败：${error instanceof Error ? error.message : String(error)}`, { retryable: true });
  }
}

function releaseClaim(database: Database.Database, jobId: string, profileHash: string, input: MaterialVectorCoordinatorOptions, leaseToken: string, chunks: MaterialVectorChunk[], error: MaterialEmbeddingAdapterError, finalFailure: boolean, now: Date): void {
  database.transaction(() => {
    const nextState = finalFailure ? 'FAILED' : 'PENDING';
    database.prepare(`
      UPDATE ${stateTableName}
      SET state = ?, lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE state = 'IN_FLIGHT' AND lease_token = ?
    `).run(nextState, error.code, error.message, now.toISOString(), leaseToken);
    const progress = readProgress(database, profileHash, input.documentId, input.documentIds);
    database.prepare(`
      UPDATE ${jobsTableName}
      SET completed_items = ?, failed_items = ?, retry_count = retry_count + ?,
          error_code = ?, error_message = ?, updated_at = ?
      WHERE job_id = ?
    `).run(progress.completedItems, progress.failedItems, finalFailure ? 0 : 1, error.code, error.message, now.toISOString(), jobId);
  })();
}

function markSingleBatchTooLarge(database: Database.Database, jobId: string, profileHash: string, input: MaterialVectorCoordinatorOptions, item: MaterialVectorChunk, leaseToken: string, now: Date): void {
  database.transaction(() => {
    database.prepare(`
      UPDATE ${stateTableName}
      SET state = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'EMBEDDING_CHUNK_TOO_LARGE', last_error_message = ?, updated_at = ?
      WHERE chunk_rowid = ? AND state = 'IN_FLIGHT' AND lease_token = ?
    `).run('单个 chunk 仍超过向量服务请求上限。', now.toISOString(), item.rowId, leaseToken);
    database.prepare(`
      UPDATE ${stateTableName}
      SET state = 'PENDING', lease_token = NULL, lease_expires_at = NULL,
          last_error_code = 'EMBEDDING_BATCH_TOO_LARGE', last_error_message = ?, updated_at = ?
      WHERE state = 'IN_FLIGHT' AND lease_token = ?
    `).run('同一批次已降批，待重新领取。', now.toISOString(), leaseToken);
    const progress = readProgress(database, profileHash, input.documentId, input.documentIds);
    database.prepare(`UPDATE ${jobsTableName} SET completed_items = ?, failed_items = ?, error_code = 'EMBEDDING_BATCH_TOO_LARGE', error_message = ?, updated_at = ? WHERE job_id = ?`).run(progress.completedItems, progress.failedItems, '单个 chunk 仍超过向量服务请求上限。', now.toISOString(), jobId);
  })();
}

function cancelJob(database: Database.Database, jobId: string, profileHash: string, input: MaterialVectorCoordinatorOptions, now: Date, leaseToken?: string): void {
  database.transaction(() => {
    if (leaseToken) {
      database.prepare(`UPDATE ${stateTableName} SET state = 'PENDING', lease_token = NULL, lease_expires_at = NULL, last_error_code = 'EMBEDDING_CANCELLED', last_error_message = '向量批处理已取消，已保留为待处理。', updated_at = ? WHERE state = 'IN_FLIGHT' AND lease_token = ?`).run(now.toISOString(), leaseToken);
    } else {
      const filter = buildDocumentFilter('document_id', input.documentId, input.documentIds);
      database.prepare(`UPDATE ${stateTableName} SET state = 'PENDING', lease_token = NULL, lease_expires_at = NULL, last_error_code = 'EMBEDDING_CANCELLED', last_error_message = '向量批处理已取消，已保留为待处理。', updated_at = ? WHERE state = 'IN_FLIGHT' AND ${filter.sql}`).run(now.toISOString(), ...filter.params);
    }
    const progress = readProgress(database, profileHash, input.documentId, input.documentIds);
    database.prepare(`UPDATE ${jobsTableName} SET state = 'CANCELLED', completed_items = ?, failed_items = ?, error_code = 'EMBEDDING_CANCELLED', error_message = '向量批处理已取消。', finished_at = ?, updated_at = ? WHERE job_id = ?`).run(progress.completedItems, progress.failedItems, now.toISOString(), now.toISOString(), jobId);
  })();
}

function markJobRunning(database: Database.Database, jobId: string, now: Date): void {
  database.prepare(`UPDATE ${jobsTableName} SET state = 'RUNNING', started_at = ?, updated_at = ? WHERE job_id = ?`).run(now.toISOString(), now.toISOString(), jobId);
}

function finishJob(database: Database.Database, jobId: string, state: MaterialVectorJobState, profileHash: string, input: MaterialVectorCoordinatorOptions, now: Date, error?: { code: string; message: string }): void {
  const progress = readProgress(database, profileHash, input.documentId, input.documentIds);
  database.prepare(`
    UPDATE ${jobsTableName}
    SET state = ?, completed_items = ?, failed_items = ?,
        error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
    WHERE job_id = ?
  `).run(state, progress.completedItems, progress.failedItems, error?.code ?? null, error?.message ?? null, now.toISOString(), now.toISOString(), jobId);
}

function emitAndReturnReport(database: Database.Database, jobId: string, profileHash: string, input: MaterialVectorCoordinatorOptions, error: { code: string; message: string; retryable: boolean } | undefined): MaterialVectorJobReport {
  const report = readJobReport(database, jobId);
  if (error && !report.errorCode) {
    report.errorCode = error.code;
    report.errorMessage = error.message;
  }
  input.onProgress?.(report);
  return report;
}

function readJobReport(database: Database.Database, jobId: string): MaterialVectorJobReport {
  const row = database.prepare(`SELECT * FROM ${jobsTableName} WHERE job_id = ?`).get(jobId) as MaterialVectorJobRow;
  return {
    schemaVersion: 1,
    jobId: row.job_id,
    ...(row.document_id ? { documentId: row.document_id } : {}),
    profileHash: row.profile_hash,
    state: row.state,
    totalItems: Number(row.total_items),
    completedItems: Number(row.completed_items),
    skippedItems: Number(row.skipped_items),
    failedItems: Number(row.failed_items),
    batchCount: Number(row.batch_count),
    retryCount: Number(row.retry_count),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
  };
}

function readProgress(database: Database.Database, profileHash: string, documentId?: string, documentIds?: string[]): MaterialVectorReconcileResult {
  const filter = buildDocumentFilter('chunks.document_id', documentId, documentIds);
  const rows = database.prepare(`
    SELECT chunks.id AS rowId, chunks.content_hash AS contentHash,
           states.profile_hash AS profileHash, states.chunk_content_hash AS stateContentHash,
           states.state, states.last_error_code AS lastErrorCode,
           EXISTS (SELECT 1 FROM ${getActiveMaterialVectorTable(database)} vectors WHERE vectors.rowid = chunks.id) AS vectorExists
    FROM material_chunks chunks
    LEFT JOIN ${stateTableName} states ON states.chunk_rowid = chunks.id
    WHERE ${filter.sql}
  `).all(...filter.params) as Array<{ rowId: number; contentHash: string; profileHash: string | null; stateContentHash: string | null; state: string | null; lastErrorCode: string | null; vectorExists: number }>;
  let completedItems = 0;
  let pendingItems = 0;
  let inFlightItems = 0;
  let failedItems = 0;
  for (const row of rows) {
    if (row.state === 'SUCCEEDED' && row.profileHash === profileHash && row.stateContentHash === row.contentHash && Number(row.vectorExists) === 1) completedItems += 1;
    else if (row.state === 'IN_FLIGHT') inFlightItems += 1;
    else if (row.state === 'FAILED') failedItems += 1;
    else pendingItems += 1;
  }
  return { totalItems: rows.length, completedItems, pendingItems, inFlightItems, failedItems };
}

function readReconcileResult(database: Database.Database, profileHash: string, documentId?: string, documentIds?: string[]): MaterialVectorReconcileResult {
  return readProgress(database, profileHash, documentId, documentIds);
}

function buildDocumentFilter(column: string, documentId?: string, documentIds?: string[]): { sql: string; params: unknown[] } {
  if (documentId?.trim()) return { sql: `${column} = ?`, params: [documentId.trim()] };
  const ids = [...new Set((documentIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { sql: '1 = 1', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

function hasVector(database: Database.Database, rowId: number): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM ${getActiveMaterialVectorTable(database)} WHERE rowid = ?`).get(BigInt(rowId)));
}

function setVectorMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`INSERT INTO ${vectorMetaTableName}(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function toVectorBuffer(values: number[]): Buffer {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function isCancelled(input: MaterialVectorCoordinatorOptions): boolean {
  return Boolean(input.signal?.aborted || input.shouldCancel?.());
}

function toAdapterError(error: unknown): MaterialEmbeddingAdapterError {
  if (error instanceof MaterialEmbeddingAdapterError) return error;
  if (error instanceof MaterialEmbeddingProfileError) return new MaterialEmbeddingAdapterError('EMBEDDING_INPUT_INVALID', error.message);
  if (error && typeof error === 'object') {
    const code = getErrorCode(error);
    const knownCodes = new Set([
      'EMBEDDING_INPUT_INVALID', 'EMBEDDING_AUTH_FAILED', 'EMBEDDING_RATE_LIMITED',
      'EMBEDDING_TIMEOUT', 'EMBEDDING_NETWORK_ERROR', 'EMBEDDING_BATCH_TOO_LARGE',
      'EMBEDDING_MODEL_UNAVAILABLE', 'EMBEDDING_RESPONSE_INVALID', 'EMBEDDING_MODEL_MISMATCH',
      'EMBEDDING_DIMENSION_MISMATCH', 'EMBEDDING_CANCELLED', 'EMBEDDING_DB_WRITE_FAILED',
      'EMBEDDING_DB_READBACK_FAILED', 'EMBEDDING_HTTP_ERROR',
    ]);
    if (code && knownCodes.has(code)) {
      const value = error as { message?: unknown; retryable?: unknown; status?: unknown; retryAfterMs?: unknown };
      return new MaterialEmbeddingAdapterError(code as ConstructorParameters<typeof MaterialEmbeddingAdapterError>[0], typeof value.message === 'string' ? value.message : code, {
        retryable: value.retryable === true,
        ...(typeof value.status === 'number' ? { status: value.status } : {}),
        ...(typeof value.retryAfterMs === 'number' ? { retryAfterMs: value.retryAfterMs } : {}),
      });
    }
  }
  return new MaterialEmbeddingAdapterError('EMBEDDING_NETWORK_ERROR', error instanceof Error ? error.message : String(error), { retryable: true });
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return undefined;
}

function isRetryableErrorCode(code: string | null | undefined): boolean {
  return code === 'EMBEDDING_TIMEOUT'
    || code === 'EMBEDDING_NETWORK_ERROR'
    || code === 'EMBEDDING_RATE_LIMITED'
    || code === 'EMBEDDING_BATCH_TOO_LARGE'
    || code === 'EMBEDDING_DB_WRITE_FAILED'
    || code === 'EMBEDDING_DB_READBACK_FAILED'
    || code === 'EMBEDDING_HTTP_ERROR';
}

function computeBackoff(retryAfterMs: number | undefined, attemptCount: number, settings: ReturnType<typeof normalizeSettings>, random: (() => number) | undefined): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(settings.maxBackoffMs, retryAfterMs);
  const base = Math.min(settings.maxBackoffMs, settings.initialBackoffMs * (2 ** Math.max(0, attemptCount - 1)));
  const jitter = 0.5 + Math.max(0, Math.min(1, random?.() ?? Math.random()));
  return Math.min(settings.maxBackoffMs, Math.floor(base * jitter));
}
