import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME,
  ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME,
  ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION,
} from './assistantWorkspaceMemoryDatabase';
import { QaMemoryDatabase } from './qaMemoryDatabase';
import { estimateTokenCount } from './tokenEstimator';
import type { QaTurnStatus } from './qaMemoryTypes';

export const QA_LEGACY_MEMORY_MIGRATION_VERSION = 1;
export const QA_LEGACY_MEMORY_BACKUP_DIRECTORY_NAME = 'migration-backups';

export type QaLegacyMemoryMigrationStatus = 'no-source' | 'already-completed' | 'completed';

export interface QaLegacyMemoryMigrationResult {
  status: QaLegacyMemoryMigrationStatus;
  migrationId?: string;
  copiedSessionCount: number;
  copiedTurnCount: number;
  backupPaths?: { legacy: string; qa: string };
}

export interface QaLegacyMemoryMigrationOptions {
  /** Deterministic failure injection used only by the migration verifier. */
  faultInjector?: (point: 'after-running' | 'after-session-copy' | 'after-turn-copy' | 'before-validation') => void;
}

export class QaLegacyMemoryMigrationError extends Error {
  readonly code = 'QA_LEGACY_MEMORY_MIGRATION_FAILED';

  constructor(message: string, readonly diagnostic?: string) {
    super(message);
  }
}

interface LegacySessionRow {
  session_id: string;
  library_path: string;
  title: string;
  is_pinned: number;
  last_turn_seq: number;
  created_at: string;
  updated_at: string;
}

interface LegacyTurnRow {
  turn_id: string;
  session_id: string;
  turn_seq: number;
  user_text: string;
  assistant_text: string | null;
  scope_label: string;
  status: string;
  result_json: string;
  created_at: string;
  finished_at: string | null;
}

interface MigrationMap {
  sessions: Map<string, string>;
  turns: Map<string, string>;
}

/**
 * Copies the retired conversation-memory.db into the unified qa-memory.db.
 * The source is opened read-only, both databases are backed up before copy,
 * and the data plus completion marker commit in one target transaction.
 */
export class QaLegacyMemoryMigrationService {
  constructor(private readonly qaMemoryDatabase: QaMemoryDatabase) {}

  migrate(workspacePath: string, options: QaLegacyMemoryMigrationOptions = {}): QaLegacyMemoryMigrationResult {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const sourcePath = path.join(
      normalizedWorkspacePath,
      ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME,
      ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME,
    );
    const targetDatabase = this.qaMemoryDatabase.getDatabase(normalizedWorkspacePath);
    if (!fs.existsSync(sourcePath)) {
      return { status: 'no-source', copiedSessionCount: 0, copiedTurnCount: 0 };
    }

    const rawSource = fs.readFileSync(sourcePath);
    let sourceFingerprint = sha256(rawSource);
    let migrationId = createMigrationId(sourcePath, sourceFingerprint);
    let backupPaths: { legacy: string; qa: string } | undefined;
    let sourceDatabase: Database.Database | undefined;

    try {
      sourceDatabase = new Database(sourcePath, { readonly: true, fileMustExist: true });
      sourceDatabase.pragma('query_only = ON');
      sourceDatabase.pragma('foreign_keys = ON');
      // Keep fingerprinting, backup serialization, and row reads on one
      // consistent source snapshot even if another process still has WAL open.
      sourceDatabase.exec('BEGIN');
      const integrity = sourceDatabase.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`旧问答历史数据库完整性校验失败：${String(integrity)}`);
      assertLegacySourceShape(sourceDatabase);

      const sourceSnapshot = sourceDatabase.serialize();
      sourceFingerprint = sha256(sourceSnapshot);
      migrationId = createMigrationId(sourcePath, sourceFingerprint);
      const completed = targetDatabase.prepare(`
        SELECT migration_id FROM memory_migrations
        WHERE source_path = ? AND source_fingerprint = ? AND migration_version = ? AND status = 'completed'
      `).get(sourcePath, sourceFingerprint, QA_LEGACY_MEMORY_MIGRATION_VERSION) as { migration_id: string } | undefined;
      if (completed) {
        return {
          status: 'already-completed',
          migrationId: completed.migration_id,
          copiedSessionCount: 0,
          copiedTurnCount: 0,
        };
      }

      backupPaths = createMigrationBackups(normalizedWorkspacePath, sourceSnapshot, targetDatabase.serialize());
      const sessions = loadLegacySessions(sourceDatabase);
      const turns = loadLegacyTurns(sourceDatabase);
      const sourceHash = hashCanonicalRows(createSourceCanonicalRows(sessions, turns));
      const startedAt = new Date().toISOString();
      upsertRunningMigration(targetDatabase, {
        migrationId,
        sourcePath,
        sourceFingerprint,
        sourceSessionCount: sessions.length,
        sourceTurnCount: turns.length,
        sourceHash,
        backupPaths,
        startedAt,
      });
      options.faultInjector?.('after-running');

      const copied = targetDatabase.transaction(() => {
        const idMap = copyLegacyRows(targetDatabase, migrationId, sessions, turns, options);
        options.faultInjector?.('before-validation');
        const targetRows = createTargetCanonicalRows(targetDatabase, sessions, turns, idMap);
        const targetHash = hashCanonicalRows(targetRows);
        const mappedCounts = targetDatabase.prepare(`
          SELECT entity_type, COUNT(*) AS count
          FROM memory_migration_id_map
          WHERE migration_id = ?
          GROUP BY entity_type
        `).all(migrationId) as Array<{ entity_type: 'session' | 'turn'; count: number }>;
        const mappedSessionCount = mappedCounts.find((row) => row.entity_type === 'session')?.count ?? 0;
        const mappedTurnCount = mappedCounts.find((row) => row.entity_type === 'turn')?.count ?? 0;
        if (mappedSessionCount !== sessions.length || mappedTurnCount !== turns.length || targetHash !== sourceHash) {
          throw new Error('迁移后的会话数量、轮次数量或内容哈希不一致。');
        }

        const completedAt = new Date().toISOString();
        targetDatabase.prepare(`
          UPDATE memory_migrations
          SET status = 'completed', copied_session_count = ?, copied_turn_count = ?,
            target_hash = ?, error_message = '', completed_at = ?, updated_at = ?
          WHERE migration_id = ?
        `).run(sessions.length, turns.length, targetHash, completedAt, completedAt, migrationId);
        return { sessionCount: sessions.length, turnCount: turns.length };
      })();

      return {
        status: 'completed',
        migrationId,
        copiedSessionCount: copied.sessionCount,
        copiedTurnCount: copied.turnCount,
        backupPaths,
      };
    } catch (error) {
      if (!backupPaths) {
        backupPaths = createMigrationBackups(normalizedWorkspacePath, rawSource, targetDatabase.serialize());
      }
      markMigrationFailed(targetDatabase, {
        migrationId,
        sourcePath,
        sourceFingerprint,
        backupPaths,
        message: error instanceof Error ? error.message : String(error),
      });
      throw new QaLegacyMemoryMigrationError(
        '旧问答历史迁移失败；新问答记忆仍可使用，旧数据库与迁移前备份均已保留。',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (sourceDatabase?.inTransaction) sourceDatabase.exec('ROLLBACK');
      sourceDatabase?.close();
    }
  }
}

function assertLegacySourceShape(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (version !== ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
    throw new Error(`旧问答历史数据库版本不受支持：${String(version)}`);
  }
  const requiredColumns: Record<string, string[]> = {
    conversation_memory_libraries: ['library_id', 'library_path'],
    assistant_workspace_sessions: [
      'session_id', 'library_id', 'title', 'is_pinned', 'last_turn_seq', 'created_at', 'updated_at',
    ],
    assistant_workspace_turns: [
      'turn_id', 'session_id', 'turn_seq', 'user_text', 'assistant_text', 'scope_label',
      'status', 'result_json', 'created_at', 'finished_at',
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const available = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    if (columns.some((column) => !available.has(column))) throw new Error(`旧问答历史数据库结构缺少 ${table} 的必要字段。`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('旧问答历史数据库外键校验失败。');
}

function loadLegacySessions(database: Database.Database): LegacySessionRow[] {
  return database.prepare(`
    SELECT sessions.session_id, libraries.library_path, sessions.title, sessions.is_pinned,
      sessions.last_turn_seq, sessions.created_at, sessions.updated_at
    FROM assistant_workspace_sessions AS sessions
    INNER JOIN conversation_memory_libraries AS libraries ON libraries.library_id = sessions.library_id
    ORDER BY sessions.created_at ASC, sessions.session_id ASC
  `).all() as LegacySessionRow[];
}

function loadLegacyTurns(database: Database.Database): LegacyTurnRow[] {
  return database.prepare(`
    SELECT turns.turn_id, turns.session_id, turns.turn_seq, turns.user_text, turns.assistant_text,
      turns.scope_label, turns.status, turns.result_json, turns.created_at, turns.finished_at
    FROM assistant_workspace_turns AS turns
    INNER JOIN assistant_workspace_sessions AS sessions ON sessions.session_id = turns.session_id
    ORDER BY sessions.created_at ASC, turns.session_id ASC, turns.turn_seq ASC, turns.turn_id ASC
  `).all() as LegacyTurnRow[];
}

function copyLegacyRows(
  database: Database.Database,
  migrationId: string,
  sessions: LegacySessionRow[],
  turns: LegacyTurnRow[],
  options: QaLegacyMemoryMigrationOptions,
): MigrationMap {
  const idMap: MigrationMap = { sessions: new Map(), turns: new Map() };
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  const insertSession = database.prepare(`
    INSERT INTO qa_sessions (
      session_id, scope, title, library_path, is_pinned, last_turn_seq,
      summarized_through_seq, created_at, updated_at
    ) VALUES (?, 'knowledge-base', ?, ?, ?, ?, 0, ?, ?)
  `);
  const insertTurn = database.prepare(`
    INSERT INTO qa_turns (
      turn_id, session_id, turn_seq, request_id, attempt_no, replaced_by_turn_id,
      user_text, assistant_text, scope_label, status, user_tokens, assistant_tokens,
      result_json, result_metadata_json, created_at, finished_at
    ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `);
  const insertMapping = database.prepare(`
    INSERT INTO memory_migration_id_map (
      migration_id, entity_type, legacy_id, qa_id, content_hash
    ) VALUES (?, ?, ?, ?, ?)
  `);

  database.prepare('DELETE FROM memory_migration_id_map WHERE migration_id = ?').run(migrationId);
  for (const session of sessions) {
    const qaSessionId = resolveSessionId(database, migrationId, session.session_id);
    insertSession.run(
      qaSessionId,
      session.title,
      path.resolve(session.library_path),
      session.is_pinned === 1 ? 1 : 0,
      session.last_turn_seq,
      session.created_at,
      session.updated_at,
    );
    insertMapping.run(migrationId, 'session', session.session_id, qaSessionId, hashCanonicalRows(session));
    idMap.sessions.set(session.session_id, qaSessionId);
  }
  options.faultInjector?.('after-session-copy');

  for (const turn of turns) {
    const qaSessionId = idMap.sessions.get(turn.session_id);
    const session = sessionById.get(turn.session_id);
    if (!qaSessionId || !session) throw new Error('旧问答历史存在无所属会话的轮次。');
    const qaTurnId = resolveTurnId(database, migrationId, turn.turn_id);
    const status = normalizeLegacyTurnStatus(turn.status);
    const finishedAt = status === 'interrupted' && turn.status === 'pending'
      ? turn.finished_at ?? session.updated_at
      : turn.finished_at;
    insertTurn.run(
      qaTurnId,
      qaSessionId,
      turn.turn_seq,
      qaTurnId,
      turn.user_text,
      turn.assistant_text,
      turn.scope_label,
      status,
      estimateTokenCount(turn.user_text),
      estimateTokenCount(turn.assistant_text ?? ''),
      stripLegacyAssistantPayload(turn.result_json),
      turn.created_at,
      finishedAt,
    );
    insertMapping.run(migrationId, 'turn', turn.turn_id, qaTurnId, hashCanonicalRows(turn));
    idMap.turns.set(turn.turn_id, qaTurnId);
  }
  options.faultInjector?.('after-turn-copy');
  return idMap;
}

function stripLegacyAssistantPayload(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}';
    const metadata = { ...(parsed as Record<string, unknown>) };
    delete metadata.answer;
    delete metadata.thinkingText;
    delete metadata.modelEvents;
    return JSON.stringify(metadata);
  } catch {
    return '{}';
  }
}

function createSourceCanonicalRows(sessions: LegacySessionRow[], turns: LegacyTurnRow[]): unknown {
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  return {
    sessions: sessions.map((session) => ({
      legacySessionId: session.session_id,
      libraryPath: path.resolve(session.library_path),
      title: session.title,
      pinned: session.is_pinned === 1,
      lastTurnSeq: session.last_turn_seq,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    })),
    turns: turns.map((turn) => {
      const status = normalizeLegacyTurnStatus(turn.status);
      const owner = sessionById.get(turn.session_id);
      return {
        legacyTurnId: turn.turn_id,
        legacySessionId: turn.session_id,
        turnSeq: turn.turn_seq,
        userText: turn.user_text,
        assistantText: turn.assistant_text,
        scopeLabel: turn.scope_label,
        status,
        resultJson: turn.result_json,
        createdAt: turn.created_at,
        finishedAt: status === 'interrupted' && turn.status === 'pending'
          ? turn.finished_at ?? owner?.updated_at ?? turn.created_at
          : turn.finished_at,
      };
    }),
  };
}

function createTargetCanonicalRows(
  database: Database.Database,
  sessions: LegacySessionRow[],
  turns: LegacyTurnRow[],
  idMap: MigrationMap,
): unknown {
  const readSession = database.prepare(`
    SELECT library_path, title, is_pinned, last_turn_seq, created_at, updated_at
    FROM qa_sessions WHERE session_id = ?
  `);
  const readTurn = database.prepare(`
    SELECT turn_seq, user_text, assistant_text, scope_label, status, result_json, created_at, finished_at
    FROM qa_turns WHERE turn_id = ? AND session_id = ?
  `);
  return {
    sessions: sessions.map((session) => {
      const qaId = idMap.sessions.get(session.session_id);
      const row = qaId ? readSession.get(qaId) as {
        library_path: string; title: string; is_pinned: number; last_turn_seq: number; created_at: string; updated_at: string;
      } | undefined : undefined;
      if (!row) throw new Error('迁移后的问答会话无法读取。');
      return {
        legacySessionId: session.session_id,
        libraryPath: row.library_path,
        title: row.title,
        pinned: row.is_pinned === 1,
        lastTurnSeq: row.last_turn_seq,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
    turns: turns.map((turn) => {
      const qaTurnId = idMap.turns.get(turn.turn_id);
      const qaSessionId = idMap.sessions.get(turn.session_id);
      const row = qaTurnId && qaSessionId ? readTurn.get(qaTurnId, qaSessionId) as {
        turn_seq: number; user_text: string; assistant_text: string | null; scope_label: string;
        status: QaTurnStatus; result_json: string; created_at: string; finished_at: string | null;
      } | undefined : undefined;
      if (!row) throw new Error('迁移后的问答轮次无法读取。');
      return {
        legacyTurnId: turn.turn_id,
        legacySessionId: turn.session_id,
        turnSeq: row.turn_seq,
        userText: row.user_text,
        assistantText: row.assistant_text,
        scopeLabel: row.scope_label,
        status: row.status,
        resultJson: row.result_json,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      };
    }),
  };
}

function resolveSessionId(database: Database.Database, migrationId: string, legacyId: string): string {
  const validLegacyId = /^assistant-session-[0-9a-f-]{36}$/u.test(legacyId);
  if (validLegacyId && !rowExists(database, 'qa_sessions', 'session_id', legacyId)) return legacyId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const digest = sha256(`${migrationId}\u0000session\u0000${legacyId}\u0000${attempt}`);
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const candidate = `assistant-session-${uuid}`;
    if (!rowExists(database, 'qa_sessions', 'session_id', candidate)) return candidate;
  }
  throw new Error('无法为冲突的旧问答会话生成安全标识。');
}

function resolveTurnId(database: Database.Database, migrationId: string, legacyId: string): string {
  if (legacyId.trim() && legacyId.length <= 160 && !rowExists(database, 'qa_turns', 'turn_id', legacyId)) return legacyId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `legacy-qa-turn-${sha256(`${migrationId}\u0000turn\u0000${legacyId}\u0000${attempt}`).slice(0, 48)}`;
    if (!rowExists(database, 'qa_turns', 'turn_id', candidate)) return candidate;
  }
  throw new Error('无法为冲突的旧问答轮次生成安全标识。');
}

function rowExists(database: Database.Database, table: 'qa_sessions' | 'qa_turns', column: 'session_id' | 'turn_id', value: string): boolean {
  return Boolean(database.prepare(`SELECT 1 AS present FROM ${table} WHERE ${column} = ?`).get(value));
}

function normalizeLegacyTurnStatus(status: string): QaTurnStatus {
  switch (status) {
    case 'complete':
    case 'cancelled':
    case 'error':
    case 'interrupted':
      return status;
    case 'pending':
      return 'interrupted';
    default:
      throw new Error(`旧问答历史包含不支持的轮次状态：${status}`);
  }
}

function upsertRunningMigration(
  database: Database.Database,
  input: {
    migrationId: string;
    sourcePath: string;
    sourceFingerprint: string;
    sourceSessionCount: number;
    sourceTurnCount: number;
    sourceHash: string;
    backupPaths: { legacy: string; qa: string };
    startedAt: string;
  },
): void {
  database.prepare(`
    INSERT INTO memory_migrations (
      migration_id, source_path, source_fingerprint, migration_version, status,
      source_session_count, source_turn_count, source_hash, backup_path,
      started_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(migration_id) DO UPDATE SET
      status = 'running', source_session_count = excluded.source_session_count,
      source_turn_count = excluded.source_turn_count, copied_session_count = 0,
      copied_turn_count = 0, source_hash = excluded.source_hash, target_hash = '',
      backup_path = excluded.backup_path, error_message = '', completed_at = NULL,
      started_at = excluded.started_at, updated_at = excluded.updated_at
  `).run(
    input.migrationId,
    input.sourcePath,
    input.sourceFingerprint,
    QA_LEGACY_MEMORY_MIGRATION_VERSION,
    input.sourceSessionCount,
    input.sourceTurnCount,
    input.sourceHash,
    JSON.stringify(input.backupPaths),
    input.startedAt,
    input.startedAt,
  );
}

function markMigrationFailed(
  database: Database.Database,
  input: {
    migrationId: string;
    sourcePath: string;
    sourceFingerprint: string;
    backupPaths: { legacy: string; qa: string };
    message: string;
  },
): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO memory_migrations (
      migration_id, source_path, source_fingerprint, migration_version, status,
      backup_path, error_message, started_at, updated_at
    ) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?)
    ON CONFLICT(migration_id) DO UPDATE SET
      status = 'failed', backup_path = excluded.backup_path,
      error_message = excluded.error_message, completed_at = NULL, updated_at = excluded.updated_at
  `).run(
    input.migrationId,
    input.sourcePath,
    input.sourceFingerprint,
    QA_LEGACY_MEMORY_MIGRATION_VERSION,
    JSON.stringify(input.backupPaths),
    input.message.slice(0, 2_000),
    now,
    now,
  );
}

function createMigrationBackups(
  workspacePath: string,
  legacyBytes: Uint8Array,
  qaBytes: Uint8Array,
): { legacy: string; qa: string } {
  const directory = path.join(
    workspacePath,
    ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME,
    QA_LEGACY_MEMORY_BACKUP_DIRECTORY_NAME,
  );
  fs.mkdirSync(directory, { recursive: true });
  return {
    legacy: writeExclusiveBackup(directory, 'conversation-memory', legacyBytes),
    qa: writeExclusiveBackup(directory, 'qa-memory', qaBytes),
  };
}

function writeExclusiveBackup(directory: string, prefix: string, bytes: Uint8Array): string {
  const suffix = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomUUID()}`;
  const destination = path.join(directory, `${prefix}-${suffix}.db`);
  const temporary = `${destination}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function createMigrationId(sourcePath: string, sourceFingerprint: string): string {
  return `qa-legacy-memory-v${QA_LEGACY_MEMORY_MIGRATION_VERSION}-${sha256(`${path.resolve(sourcePath)}\u0000${sourceFingerprint}`).slice(0, 48)}`;
}

function hashCanonicalRows(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}
