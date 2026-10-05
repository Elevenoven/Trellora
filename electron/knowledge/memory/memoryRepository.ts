import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { normalizeWorkspaceMemoryConfig, resolveLongTermMemoryAvailability } from './memoryConfig';
import { assertTrustedMemoryScope } from './memoryScope';
import type {
  AgentMemoryConfig,
  LongTermMemoryAvailability,
  MemorySubjectRecord,
  PrincipalMemoryConfig,
  TrustedMemoryScope,
  WorkspaceMemoryConfig,
} from './memoryTypes';

interface WorkspaceSettingsRow {
  enabled: number;
  write_mode: string;
  extract_model_id: string | null;
  max_items: number;
  extract_delay_seconds: number;
  extract_min_interval_seconds: number;
  extract_instructions: string;
  interest_threshold: number;
  retrieval_conditioning: number;
  embedding_model_id: string | null;
  vector_recall: number;
}

interface MemorySubjectRow {
  workspace_id: string;
  principal_id: string;
  enabled: number;
  block_text: string;
  item_count: number;
  last_extracted_at: string | null;
  extract_cursor_at: string | null;
  extract_cursor_message_id: string | null;
  pending_sessions_json: string;
  extract_scheduled_at: string | null;
  consolidated_at: string | null;
  forced_consolidated_at: string | null;
  memory_generation: number;
  created_at: string;
  updated_at: string;
}

export class MemoryRepository {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {}

  ensureSubject(scope: TrustedMemoryScope, now = new Date()): MemorySubjectRecord {
    assertTrustedMemoryScope(scope);
    const timestamp = now.toISOString();
    runInImmediateTransaction(this.database(), () => ensureScopeRows(this.database(), scope, timestamp));
    return this.requireSubject(scope);
  }

  getSubject(scope: TrustedMemoryScope): MemorySubjectRecord | undefined {
    assertTrustedMemoryScope(scope);
    const row = this.database().prepare(`
      SELECT * FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?
    `).get(scope.workspaceId, scope.principalId) as MemorySubjectRow | undefined;
    return row ? mapSubjectRow(row) : undefined;
  }

  getWorkspaceConfig(scope: TrustedMemoryScope, now = new Date()): WorkspaceMemoryConfig {
    assertTrustedMemoryScope(scope);
    this.ensureSubject(scope, now);
    const row = this.database().prepare(`
      SELECT enabled, write_mode, extract_model_id, max_items, extract_delay_seconds,
             extract_min_interval_seconds, extract_instructions, interest_threshold,
             retrieval_conditioning, embedding_model_id, vector_recall
      FROM memory_workspace_settings WHERE workspace_id = ?
    `).get(scope.workspaceId) as WorkspaceSettingsRow;
    return mapWorkspaceSettingsRow(row);
  }

  updateWorkspaceConfig(
    scope: TrustedMemoryScope,
    patch: Partial<WorkspaceMemoryConfig>,
    now = new Date(),
  ): WorkspaceMemoryConfig {
    assertTrustedMemoryScope(scope);
    const database = this.database();
    const timestamp = now.toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const current = this.readWorkspaceConfig(scope);
      const next = normalizeWorkspaceMemoryConfig(patch, current);
      database.prepare(`
        UPDATE memory_workspace_settings
        SET enabled = ?, write_mode = ?, extract_model_id = ?, max_items = ?,
            extract_delay_seconds = ?, extract_min_interval_seconds = ?,
            extract_instructions = ?, interest_threshold = ?, retrieval_conditioning = ?,
            embedding_model_id = ?, vector_recall = ?, updated_at = ?
        WHERE workspace_id = ?
      `).run(
        asSqliteBoolean(next.enabled), next.writeMode, next.extractModelId, next.maxItems,
        next.extractDelaySeconds, next.extractMinIntervalSeconds, next.extractInstructions,
        next.interestThreshold, asSqliteBoolean(next.retrievalConditioning), next.embeddingModelId,
        asSqliteBoolean(next.vectorRecall), timestamp, scope.workspaceId,
      );
      // L4 vectors are valid only for the configured model identity. Keeping
      // an old model's bytes would be harmless because recall gates by model,
      // but deleting them here makes a model switch explicit and bounded.
      if (current.embeddingModelId !== next.embeddingModelId) {
        database.prepare(`
          DELETE FROM memory_item_embeddings WHERE workspace_id = ? AND principal_id = ?
        `).run(scope.workspaceId, scope.principalId);
      }
      // L3 shares the configured embedding slot but not the L4 enabled flag.
      // A model/feature switch invalidates only its derived vector bytes; the
      // keyword archive remains queryable and will be backfilled independently.
      if (current.embeddingModelId !== next.embeddingModelId || current.vectorRecall !== next.vectorRecall) {
        database.prepare(`
          UPDATE conversation_search_documents
          SET embedding_model_id = NULL, embedding_dimensions = NULL, embedding = NULL,
              embedding_fingerprint = NULL, index_state = ?
          WHERE workspace_id = ? AND principal_id = ?
        `).run(
          next.vectorRecall && next.embeddingModelId ? 'pending' : 'disabled',
          scope.workspaceId,
          scope.principalId,
        );
      }
      return next;
    });
  }

  setPrincipalEnabled(scope: TrustedMemoryScope, enabled: boolean, now = new Date()): PrincipalMemoryConfig {
    assertTrustedMemoryScope(scope);
    const timestamp = now.toISOString();
    const database = this.database();
    runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      database.prepare(`
        UPDATE memory_subjects SET enabled = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ?
      `).run(asSqliteBoolean(enabled), timestamp, scope.workspaceId, scope.principalId);
    });
    return { enabled };
  }

  getPrincipalConfig(scope: TrustedMemoryScope, now = new Date()): PrincipalMemoryConfig {
    return { enabled: this.ensureSubject(scope, now).enabled };
  }

  resolveAvailability(
    scope: TrustedMemoryScope,
    agent: AgentMemoryConfig = {},
    now = new Date(),
  ): LongTermMemoryAvailability {
    return resolveLongTermMemoryAvailability(
      this.getWorkspaceConfig(scope, now),
      this.getPrincipalConfig(scope, now),
      agent,
    );
  }

  private requireSubject(scope: TrustedMemoryScope): MemorySubjectRecord {
    const subject = this.getSubject(scope);
    if (!subject) throw new Error('记忆主体初始化失败。');
    return subject;
  }

  private readWorkspaceConfig(scope: TrustedMemoryScope): WorkspaceMemoryConfig {
    const row = this.database().prepare(`
      SELECT enabled, write_mode, extract_model_id, max_items, extract_delay_seconds,
             extract_min_interval_seconds, extract_instructions, interest_threshold,
             retrieval_conditioning, embedding_model_id, vector_recall
      FROM memory_workspace_settings WHERE workspace_id = ?
    `).get(scope.workspaceId) as WorkspaceSettingsRow | undefined;
    if (!row) throw new Error('记忆工作区配置不存在。');
    return mapWorkspaceSettingsRow(row);
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

export function runInImmediateTransaction<T>(database: Database.Database, operation: () => T): T {
  if (database.inTransaction) return operation();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function ensureScopeRows(
  database: Database.Database,
  scope: TrustedMemoryScope,
  timestamp: string,
): void {
  assertTrustedMemoryScope(scope);
  database.prepare(`
    INSERT INTO memory_workspace_settings (workspace_id, created_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO NOTHING
  `).run(scope.workspaceId, timestamp, timestamp);
  database.prepare(`
    INSERT INTO memory_subjects (workspace_id, principal_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, principal_id) DO NOTHING
  `).run(scope.workspaceId, scope.principalId, timestamp, timestamp);
}

function mapWorkspaceSettingsRow(row: WorkspaceSettingsRow): WorkspaceMemoryConfig {
  return normalizeWorkspaceMemoryConfig({
    enabled: row.enabled,
    writeMode: row.write_mode,
    extractModelId: row.extract_model_id,
    maxItems: row.max_items,
    extractDelaySeconds: row.extract_delay_seconds,
    extractMinIntervalSeconds: row.extract_min_interval_seconds,
    extractInstructions: row.extract_instructions,
    interestThreshold: row.interest_threshold,
    retrievalConditioning: row.retrieval_conditioning,
    embeddingModelId: row.embedding_model_id,
    vectorRecall: row.vector_recall,
  });
}

function mapSubjectRow(row: MemorySubjectRow): MemorySubjectRecord {
  return {
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    enabled: row.enabled === 1,
    blockText: row.block_text,
    itemCount: row.item_count,
    lastExtractedAt: row.last_extracted_at,
    extractCursorAt: row.extract_cursor_at,
    extractCursorMessageId: row.extract_cursor_message_id,
    pendingSessionIds: parseStringArray(row.pending_sessions_json),
    extractScheduledAt: row.extract_scheduled_at,
    consolidatedAt: row.consolidated_at,
    forcedConsolidatedAt: row.forced_consolidated_at,
    memoryGeneration: row.memory_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function asSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
