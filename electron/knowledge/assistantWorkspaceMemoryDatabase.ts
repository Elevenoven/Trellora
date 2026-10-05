import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION = 1;
export const ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME = 'ConversationMemory';
export const ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME = 'conversation-memory.db';

export class AssistantWorkspaceMemoryDatabaseError extends Error {
  constructor(
    readonly code: 'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT' | 'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

/**
 * Read-only compatibility owner for the retired knowledge-base Q&A history.
 * Phase 6 never creates, migrates, repairs, or writes conversation-memory.db.
 */
export class AssistantWorkspaceMemoryDatabase {
  private readonly connections = new Map<string, Database.Database>();

  getDatabase(workspacePath: string): Database.Database | undefined {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const existing = this.connections.get(normalizedWorkspacePath);
    if (existing) return existing;

    const databasePath = getAssistantWorkspaceMemoryDatabasePath(normalizedWorkspacePath);
    if (!fs.existsSync(databasePath)) return undefined;
    let database: Database.Database | undefined;
    try {
      database = new Database(databasePath, { readonly: true, fileMustExist: true });
      database.pragma('query_only = ON');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      const integrity = database.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') {
        throw new AssistantWorkspaceMemoryDatabaseError(
          'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT',
          '知识库问答历史数据库完整性校验失败。请先备份并恢复 ConversationMemory 中的数据库。',
        );
      }
      const version = Number(database.pragma('user_version', { simple: true }));
      if (version !== ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
        throw new AssistantWorkspaceMemoryDatabaseError(
          'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
          '旧知识库问答历史数据库版本不受只读兼容层支持。',
        );
      }
      assertV1Shape(database);
      this.connections.set(normalizedWorkspacePath, database);
      return database;
    } catch (error) {
      database?.close();
      if (error instanceof AssistantWorkspaceMemoryDatabaseError) throw error;
      throw new AssistantWorkspaceMemoryDatabaseError(
        'ASSISTANT_WORKSPACE_MEMORY_DATABASE_CORRUPT',
        '无法只读打开旧知识库问答历史数据库。为避免丢失历史记录，应用未自动重建该数据库。',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  closeAll(): void {
    for (const database of this.connections.values()) database.close();
    this.connections.clear();
  }
}

export function getAssistantWorkspaceMemoryDatabasePath(workspacePath: string): string {
  return path.join(
    path.resolve(workspacePath),
    ASSISTANT_WORKSPACE_MEMORY_DIRECTORY_NAME,
    ASSISTANT_WORKSPACE_MEMORY_DATABASE_NAME,
  );
}

export function migrateAssistantWorkspaceMemoryDatabase(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
    throw new AssistantWorkspaceMemoryDatabaseError(
      'ASSISTANT_WORKSPACE_MEMORY_DATABASE_UNAVAILABLE',
      '知识库问答历史数据库版本不受当前应用支持。',
    );
  }
  if (version === ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION) {
    assertV1Shape(database);
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE conversation_memory_libraries (
        library_id TEXT PRIMARY KEY,
        library_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE assistant_workspace_sessions (
        session_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES conversation_memory_libraries(library_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
        last_turn_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_turn_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE assistant_workspace_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES assistant_workspace_sessions(session_id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        scope_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'cancelled', 'error', 'interrupted')),
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (session_id, turn_seq)
      );
      CREATE TABLE conversation_memory_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX idx_assistant_workspace_sessions_order
        ON assistant_workspace_sessions(library_id, is_pinned DESC, updated_at DESC, session_id DESC);
      CREATE INDEX idx_assistant_workspace_turns_session_seq
        ON assistant_workspace_turns(session_id, turn_seq ASC);
    `);
    database.pragma(`user_version = ${ASSISTANT_WORKSPACE_MEMORY_SCHEMA_VERSION}`);
    assertV1Shape(database);
  })();
}

function assertV1Shape(database: Database.Database): void {
  const requiredTables = [
    'conversation_memory_libraries',
    'assistant_workspace_sessions',
    'assistant_workspace_turns',
    'conversation_memory_migrations',
  ];
  for (const table of requiredTables) {
    const exists = database.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`conversation-memory v1 结构缺少表：${table}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('conversation-memory v1 外键校验失败。');
}
