import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLibraryMetaDirectory } from '../treeOrder';
import { createAssistantLibraryId } from './assistantLibraryIdentity';
import { emptyRollingSummaryPayload } from './assistantRollingSummary';

export const ASSISTANT_MEMORY_SCHEMA_VERSION = 7;

export class AssistantMemoryDatabaseError extends Error {
  constructor(readonly code: 'ASSISTANT_MEMORY_DATABASE_CORRUPT' | 'ASSISTANT_MEMORY_DATABASE_UNAVAILABLE', message: string, readonly diagnostic?: string) {
    super(message);
  }
}

/**
 * Owns the independent user-memory database.  It intentionally never uses
 * the recoverable index.db path or its migration helpers.
 */
export class AssistantMemoryDatabase {
  private readonly connections = new Map<string, Database.Database>();

  getDatabase(libraryPath: string): Database.Database {
    const normalizedLibraryPath = path.resolve(libraryPath);
    const existing = this.connections.get(normalizedLibraryPath);
    if (existing) return existing;
    const metaDirectory = getLibraryMetaDirectory(normalizedLibraryPath);
    const databasePath = path.join(metaDirectory, 'assistant-memory.db');
    const existed = fs.existsSync(databasePath);
    let database: Database.Database | undefined;
    try {
      fs.mkdirSync(metaDirectory, { recursive: true });
      database = new Database(databasePath);
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      database.pragma('synchronous = NORMAL');
      const integrity = database.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') throw new AssistantMemoryDatabaseError('ASSISTANT_MEMORY_DATABASE_CORRUPT', 'AI 会话记忆库完整性校验失败。请先备份并恢复该资料库的 assistant-memory.db。');
      migrateAssistantMemoryDatabase(database, createAssistantLibraryId(normalizedLibraryPath));
      this.connections.set(normalizedLibraryPath, database);
      return database;
    } catch (error) {
      database?.close();
      if (error instanceof AssistantMemoryDatabaseError) throw error;
      const message = existed
        ? '无法打开 AI 会话记忆库。为避免丢失历史记录，应用未自动重建该数据库。'
        : '无法创建 AI 会话记忆库。请检查资料库目录是否可写。';
      throw new AssistantMemoryDatabaseError(existed ? 'ASSISTANT_MEMORY_DATABASE_CORRUPT' : 'ASSISTANT_MEMORY_DATABASE_UNAVAILABLE', message, error instanceof Error ? error.message : String(error));
    }
  }

  async backup(libraryPath: string, destinationPath: string): Promise<void> {
    const source = this.getDatabase(libraryPath);
    const destination = path.resolve(destinationPath);
    if (path.resolve(destination) === path.resolve(getAssistantMemoryDatabasePath(libraryPath))) {
      throw new Error('备份目标不能覆盖正在使用的 AI 会话记忆库。');
    }
    await source.backup(destination);
  }

  closeLibrary(libraryPath: string): void {
    const normalizedLibraryPath = path.resolve(libraryPath);
    const database = this.connections.get(normalizedLibraryPath);
    if (!database) return;
    database.close();
    this.connections.delete(normalizedLibraryPath);
  }

  closeAll(): void {
    for (const database of this.connections.values()) database.close();
    this.connections.clear();
  }
}

export function getAssistantMemoryDatabasePath(libraryPath: string): string {
  return path.join(getLibraryMetaDirectory(path.resolve(libraryPath)), 'assistant-memory.db');
}

export function migrateAssistantMemoryDatabase(database: Database.Database, libraryId: string): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > ASSISTANT_MEMORY_SCHEMA_VERSION) {
    throw new AssistantMemoryDatabaseError('ASSISTANT_MEMORY_DATABASE_UNAVAILABLE', 'AI 会话记忆库版本不受当前应用支持。');
  }
  if (version === ASSISTANT_MEMORY_SCHEMA_VERSION) {
    assertV7Shape(database);
    return;
  }
  let migratedVersion = version;
  if (migratedVersion < 1) {
    database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS assistant_note_identity (
        note_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        last_content_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'missing', 'deleted')),
        missing_since TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_sessions (
        session_id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES assistant_note_identity(note_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        last_turn_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, note_id)
      );
      CREATE TABLE IF NOT EXISTS assistant_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
        turn_seq INTEGER NOT NULL,
        note_content_hash TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        route TEXT NOT NULL,
        context_mode TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'not-found', 'cancelled', 'error', 'interrupted')),
        stop_reason TEXT,
        provider_fingerprint TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (session_id, turn_id),
        UNIQUE (session_id, turn_seq)
      );
      CREATE TABLE IF NOT EXISTS assistant_memory_state (
        session_id TEXT PRIMARY KEY REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
        note_content_hash TEXT NOT NULL,
        summarized_through_seq INTEGER NOT NULL DEFAULT 0,
        rolling_summary TEXT NOT NULL DEFAULT '',
        unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
        memory_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_claims (
        claim_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES assistant_sessions(session_id) ON DELETE CASCADE,
        source_turn_id TEXT NOT NULL,
        note_content_hash TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'stale')),
        revision INTEGER NOT NULL,
        supersedes_claim_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, claim_id),
        UNIQUE (session_id, normalized_key, revision),
        FOREIGN KEY (session_id, source_turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, supersedes_claim_id) REFERENCES assistant_claims(session_id, claim_id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_evidence_refs (
        session_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        note_content_hash TEXT NOT NULL,
        block_ids_json TEXT NOT NULL,
        heading_path_json TEXT NOT NULL,
        line_from INTEGER NOT NULL CHECK (line_from > 0),
        line_to INTEGER NOT NULL CHECK (line_to >= line_from),
        text_hash TEXT NOT NULL,
        preview TEXT NOT NULL,
        source_tool TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'stale')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, evidence_id),
        UNIQUE (session_id, note_content_hash, block_ids_json, line_from, line_to, text_hash),
        FOREIGN KEY (session_id, note_id) REFERENCES assistant_sessions(session_id, note_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assistant_turn_evidence (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, evidence_id),
        FOREIGN KEY (session_id, turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, evidence_id) REFERENCES assistant_evidence_refs(session_id, evidence_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assistant_claim_evidence (
        session_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (session_id, claim_id, evidence_id),
        FOREIGN KEY (session_id, claim_id) REFERENCES assistant_claims(session_id, claim_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, evidence_id) REFERENCES assistant_evidence_refs(session_id, evidence_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS assistant_memory_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_sessions_note_updated ON assistant_sessions(note_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_seq ON assistant_turns(session_id, turn_seq DESC);
      CREATE INDEX IF NOT EXISTS idx_assistant_claims_active ON assistant_claims(session_id, note_content_hash, state, normalized_key);
      CREATE INDEX IF NOT EXISTS idx_assistant_evidence_session_hash ON assistant_evidence_refs(session_id, note_content_hash, state, line_from);
    `);
      database.pragma('user_version = 1');
    })();
    migratedVersion = 1;
  }
  if (migratedVersion < 2) {
    database.transaction(() => {
      // This is intentionally note-scoped rather than session-scoped. The
      // writer validates that digest_json is derived only from note data.
      database.exec(`
        CREATE TABLE IF NOT EXISTS assistant_section_digests (
          digest_id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES assistant_note_identity(note_id) ON DELETE CASCADE,
          note_content_hash TEXT NOT NULL,
          section_id TEXT NOT NULL,
          section_hash TEXT NOT NULL,
          heading_path_json TEXT NOT NULL,
          line_from INTEGER NOT NULL CHECK (line_from > 0),
          line_to INTEGER NOT NULL CHECK (line_to >= line_from),
          provider_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL,
          digest_version INTEGER NOT NULL,
          scope TEXT NOT NULL DEFAULT 'note-derived' CHECK (scope = 'note-derived'),
          digest_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'stale')),
          created_at TEXT NOT NULL,
          UNIQUE (note_id, section_hash, provider_fingerprint, model, digest_version)
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_digests_lookup
          ON assistant_section_digests(note_id, section_hash, provider_fingerprint, model, digest_version, status);
        CREATE INDEX IF NOT EXISTS idx_assistant_digests_section
          ON assistant_section_digests(note_id, section_id, status);
      `);
      database.pragma('user_version = 2');
    })();
  }
  if (migratedVersion < 3) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS assistant_library_identity (
          library_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO assistant_library_identity (library_id, created_at)
        VALUES (${quoteSqlString(libraryId)}, ${quoteSqlString(new Date().toISOString())});

        CREATE TABLE IF NOT EXISTS assistant_search_plans (
          plan_id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL,
          note_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          original_question TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          active_goal_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'partial', 'not-found', 'failed', 'cancelled', 'stale', 'interrupted')),
          revision_count INTEGER NOT NULL CHECK (revision_count >= 0 AND revision_count <= 2),
          goal_update_count INTEGER NOT NULL CHECK (goal_update_count >= 0 AND goal_update_count <= 8),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (plan_id, session_id),
          UNIQUE (library_id, note_id, session_id, turn_id),
          FOREIGN KEY (library_id) REFERENCES assistant_library_identity(library_id) ON DELETE CASCADE,
          FOREIGN KEY (session_id, note_id) REFERENCES assistant_sessions(session_id, note_id) ON DELETE CASCADE,
          FOREIGN KEY (session_id, turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS assistant_search_plan_goals (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          goal_order INTEGER NOT NULL CHECK (goal_order >= 0 AND goal_order <= 3),
          question TEXT NOT NULL,
          evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('fact', 'definition', 'comparison', 'cause', 'timeline')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'searching', 'partial', 'covered', 'conflicted', 'not-found')),
          missing_evidence TEXT,
          PRIMARY KEY (plan_id, goal_id),
          FOREIGN KEY (plan_id) REFERENCES assistant_search_plans(plan_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS assistant_search_plan_requirements (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          requirement_id TEXT NOT NULL,
          requirement_order INTEGER NOT NULL CHECK (requirement_order >= 0 AND requirement_order <= 3),
          label TEXT NOT NULL,
          subject TEXT,
          min_evidence INTEGER NOT NULL CHECK (min_evidence >= 1 AND min_evidence <= 3),
          PRIMARY KEY (plan_id, goal_id, requirement_id),
          FOREIGN KEY (plan_id, goal_id) REFERENCES assistant_search_plan_goals(plan_id, goal_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS assistant_search_plan_query_terms (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          term_order INTEGER NOT NULL CHECK (term_order >= 0 AND term_order <= 5),
          term TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('planner', 'note-map', 'search-observation', 'model-synonym', 'user-confirmed')),
          PRIMARY KEY (plan_id, goal_id, term_order),
          UNIQUE (plan_id, goal_id, term),
          FOREIGN KEY (plan_id, goal_id) REFERENCES assistant_search_plan_goals(plan_id, goal_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS assistant_search_plan_evidence (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          requirement_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          side TEXT NOT NULL CHECK (side IN ('ordinary', 'supports', 'contradicts')),
          PRIMARY KEY (plan_id, goal_id, requirement_id, side, evidence_id),
          FOREIGN KEY (plan_id, goal_id, requirement_id) REFERENCES assistant_search_plan_requirements(plan_id, goal_id, requirement_id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id, session_id) REFERENCES assistant_search_plans(plan_id, session_id) ON DELETE CASCADE,
          FOREIGN KEY (session_id, evidence_id) REFERENCES assistant_evidence_refs(session_id, evidence_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_search_plans_session_updated
          ON assistant_search_plans(library_id, note_id, session_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_assistant_search_plan_evidence_lookup
          ON assistant_search_plan_evidence(session_id, evidence_id);
      `);
      database.pragma('user_version = 3');
    })();
  }
  if (migratedVersion < 4) {
    database.transaction(() => {
      database.exec(`
        ALTER TABLE assistant_memory_state ADD COLUMN rolling_summary_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE assistant_memory_state ADD COLUMN rolling_summary_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"contentHash":"","coveredThroughSeq":0,"turnDigests":[],"unresolvedQuestions":[]}';
        ALTER TABLE assistant_memory_state ADD COLUMN rolling_summary_content_hash TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS assistant_turn_digests (
          digest_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_seq INTEGER NOT NULL CHECK (turn_seq > 0),
          note_content_hash TEXT NOT NULL,
          digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
          digest_json TEXT NOT NULL,
          plan_id TEXT,
          plan_version INTEGER,
          plan_status TEXT CHECK (plan_status IN ('active', 'completed', 'partial', 'not-found', 'failed', 'cancelled', 'stale', 'interrupted')),
          state TEXT NOT NULL CHECK (state IN ('active', 'stale')),
          created_at TEXT NOT NULL,
          UNIQUE (session_id, turn_id, digest_version),
          FOREIGN KEY (session_id, turn_id) REFERENCES assistant_turns(session_id, turn_id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id, session_id) REFERENCES assistant_search_plans(plan_id, session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_turn_digests_session_seq
          ON assistant_turn_digests(session_id, note_content_hash, state, turn_seq);
        CREATE INDEX IF NOT EXISTS idx_assistant_turn_digests_turn
          ON assistant_turn_digests(session_id, turn_id, digest_version);
      `);
      const stateRows = database.prepare(`
        SELECT session_id, note_content_hash, rolling_summary, summarized_through_seq,
          memory_version
        FROM assistant_memory_state
      `).all() as Array<{
        session_id: string;
        note_content_hash: string;
        rolling_summary: string;
        summarized_through_seq: number;
        memory_version: number;
      }>;
      const updateState = database.prepare(`
        UPDATE assistant_memory_state
        SET rolling_summary_version = ?, rolling_summary_json = ?, rolling_summary_content_hash = ?,
          rolling_summary = ?, unresolved_questions_json = ?, summarized_through_seq = ?, updated_at = ?
        WHERE session_id = ?
      `);
      for (const row of stateRows) {
        const payload = {
          ...emptyRollingSummaryPayload(row.note_content_hash, row.rolling_summary),
          coveredThroughSeq: row.summarized_through_seq,
        };
        updateState.run(
          Math.max(1, row.memory_version),
          JSON.stringify(payload),
          row.note_content_hash,
          row.rolling_summary,
          '[]',
          row.summarized_through_seq,
          new Date().toISOString(),
          row.session_id,
        );
      }
      database.pragma('user_version = 4');
    })();
    migratedVersion = 4;
  }
  if (migratedVersion < 5) {
    // v5 only adds derived scope/coverage state.  Keep the whole change in a
    // single transaction and advance user_version last so an interrupted
    // migration is rejected on the next open instead of being rebuilt.
    assertV4Shape(database);
    database.transaction(() => {
      database.exec(`
        ALTER TABLE assistant_search_plans ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'focused'
          CHECK (scope_mode IN ('focused', 'topic-wide'));
        ALTER TABLE assistant_search_plans ADD COLUMN coverage_policy TEXT NOT NULL DEFAULT 'sufficient'
          CHECK (coverage_policy IN ('sufficient', 'aspect-complete', 'occurrence-complete'));
        ALTER TABLE assistant_search_plans ADD COLUMN target_topic TEXT;
        ALTER TABLE assistant_search_plans ADD COLUMN scope_origin TEXT NOT NULL DEFAULT 'controller-fallback'
          CHECK (scope_origin IN ('user-explicit', 'planner-inferred', 'session-inherited', 'controller-fallback'));
        ALTER TABLE assistant_search_plans ADD COLUMN scope_confidence TEXT NOT NULL DEFAULT 'low'
          CHECK (scope_confidence IN ('high', 'medium', 'low'));

        CREATE TABLE assistant_search_plan_scope_aspects (
          plan_id TEXT NOT NULL,
          aspect_order INTEGER NOT NULL CHECK (aspect_order >= 0 AND aspect_order <= 5),
          aspect TEXT NOT NULL,
          PRIMARY KEY (plan_id, aspect_order),
          UNIQUE (plan_id, aspect),
          FOREIGN KEY (plan_id) REFERENCES assistant_search_plans(plan_id) ON DELETE CASCADE
        );

        CREATE TABLE assistant_search_goal_coverage (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          query_fingerprint TEXT NOT NULL,
          matched_block_count INTEGER NOT NULL CHECK (matched_block_count >= 0),
          matched_heading_count INTEGER NOT NULL CHECK (matched_heading_count >= 0),
          read_heading_count INTEGER NOT NULL CHECK (read_heading_count >= 0),
          covered_aspect_count INTEGER NOT NULL CHECK (covered_aspect_count >= 0),
          target_aspect_count INTEGER NOT NULL CHECK (target_aspect_count >= 0),
          candidate_exhausted INTEGER NOT NULL CHECK (candidate_exhausted IN (0, 1)),
          candidate_truncated INTEGER NOT NULL CHECK (candidate_truncated IN (0, 1)),
          next_search_cursor TEXT,
          covered_aspects_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (plan_id, goal_id),
          FOREIGN KEY (plan_id, goal_id) REFERENCES assistant_search_plan_goals(plan_id, goal_id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id) REFERENCES assistant_search_plans(plan_id) ON DELETE CASCADE
        );

        CREATE TABLE assistant_search_goal_sections (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          heading_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('discovered', 'read')),
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (plan_id, goal_id, heading_id, state),
          FOREIGN KEY (plan_id, goal_id) REFERENCES assistant_search_plan_goals(plan_id, goal_id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id) REFERENCES assistant_search_plans(plan_id) ON DELETE CASCADE
        );

        CREATE INDEX idx_assistant_search_plan_scope_aspects_lookup
          ON assistant_search_plan_scope_aspects(plan_id, aspect_order);
        CREATE INDEX idx_assistant_search_goal_coverage_snapshot
          ON assistant_search_goal_coverage(plan_id, content_hash, snapshot_id);
        CREATE INDEX idx_assistant_search_goal_sections_state
          ON assistant_search_goal_sections(plan_id, goal_id, state, content_hash);
      `);
      assertV5Shape(database);
      database.pragma('user_version = 5');
    })();
    migratedVersion = 5;
  }
  if (migratedVersion < 6) {
    assertV5Shape(database);
    database.transaction(() => {
      database.exec(`
        CREATE TABLE assistant_workspace_sessions (
          session_id TEXT PRIMARY KEY,
          library_id TEXT NOT NULL REFERENCES assistant_library_identity(library_id) ON DELETE CASCADE,
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
        CREATE INDEX idx_assistant_workspace_sessions_order
          ON assistant_workspace_sessions(library_id, is_pinned DESC, updated_at DESC, session_id DESC);
        CREATE INDEX idx_assistant_workspace_turns_session_seq
          ON assistant_workspace_turns(session_id, turn_seq ASC);
      `);
      assertV6Shape(database);
      database.pragma('user_version = 6');
    })();
    migratedVersion = 6;
  }
  if (migratedVersion < 7) {
    assertV6Shape(database);
    database.transaction(() => {
      database.exec(`
        CREATE TABLE assistant_search_plan_query_terms_v7 (
          plan_id TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          term_order INTEGER NOT NULL CHECK (term_order >= 0),
          term TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('planner', 'note-map', 'search-observation', 'model-synonym', 'user-confirmed')),
          PRIMARY KEY (plan_id, goal_id, term_order),
          UNIQUE (plan_id, goal_id, term),
          FOREIGN KEY (plan_id, goal_id) REFERENCES assistant_search_plan_goals(plan_id, goal_id) ON DELETE CASCADE
        );
        INSERT INTO assistant_search_plan_query_terms_v7 (plan_id, goal_id, term_order, term, source)
          SELECT plan_id, goal_id, term_order, term, source
          FROM assistant_search_plan_query_terms
          ORDER BY plan_id, goal_id, term_order;
        DROP TABLE assistant_search_plan_query_terms;
        ALTER TABLE assistant_search_plan_query_terms_v7 RENAME TO assistant_search_plan_query_terms;
      `);
      assertV7Shape(database);
      database.pragma('user_version = 7');
    })();
    migratedVersion = 7;
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertV4Shape(database: Database.Database): void {
  const requiredTables = [
    'assistant_library_identity',
    'assistant_search_plans',
    'assistant_search_plan_goals',
    'assistant_search_plan_requirements',
    'assistant_search_plan_query_terms',
    'assistant_search_plan_evidence',
    'assistant_memory_state',
    'assistant_turn_digests',
  ];
  for (const table of requiredTables) {
    const exists = database.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`assistant-memory v4 结构缺少表：${table}`);
  }
  const planColumns = new Set((database.prepare('PRAGMA table_info(assistant_search_plans)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['plan_id', 'library_id', 'note_id', 'session_id', 'turn_id', 'content_hash', 'original_question', 'version', 'status']) {
    if (!planColumns.has(column)) throw new Error(`assistant-memory v4 结构缺少列：assistant_search_plans.${column}`);
  }
}

function assertV5Shape(database: Database.Database): void {
  const requiredTables = ['assistant_search_plan_scope_aspects', 'assistant_search_goal_coverage', 'assistant_search_goal_sections'];
  for (const table of requiredTables) {
    const exists = database.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`assistant-memory v5 结构缺少表：${table}`);
  }
  const planColumns = new Set((database.prepare('PRAGMA table_info(assistant_search_plans)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['scope_mode', 'coverage_policy', 'target_topic', 'scope_origin', 'scope_confidence']) {
    if (!planColumns.has(column)) throw new Error(`assistant-memory v5 结构缺少列：assistant_search_plans.${column}`);
  }
  const coverageColumns = new Set((database.prepare('PRAGMA table_info(assistant_search_goal_coverage)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['snapshot_id', 'content_hash', 'query_fingerprint', 'read_heading_count', 'next_search_cursor']) {
    if (!coverageColumns.has(column)) throw new Error(`assistant-memory v5 结构缺少列：assistant_search_goal_coverage.${column}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('assistant-memory v5 外键校验失败。');
}

function assertV6Shape(database: Database.Database): void {
  assertV5Shape(database);
  for (const table of ['assistant_workspace_sessions', 'assistant_workspace_turns']) {
    const exists = database.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { present: number } | undefined;
    if (!exists) throw new Error(`assistant-memory v6 结构缺少表：${table}`);
  }
  const sessionColumns = new Set((database.prepare('PRAGMA table_info(assistant_workspace_sessions)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['session_id', 'library_id', 'title', 'is_pinned', 'last_turn_seq', 'created_at', 'updated_at']) {
    if (!sessionColumns.has(column)) throw new Error(`assistant-memory v6 结构缺少列：assistant_workspace_sessions.${column}`);
  }
  const turnColumns = new Set((database.prepare('PRAGMA table_info(assistant_workspace_turns)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['turn_id', 'session_id', 'turn_seq', 'user_text', 'assistant_text', 'scope_label', 'status', 'result_json']) {
    if (!turnColumns.has(column)) throw new Error(`assistant-memory v6 结构缺少列：assistant_workspace_turns.${column}`);
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('assistant-memory v6 外键校验失败。');
}

function assertV7Shape(database: Database.Database): void {
  assertV6Shape(database);
  const row = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'assistant_search_plan_query_terms'
  `).get() as { sql: string | null } | undefined;
  const schema = row?.sql ?? '';
  if (!/term_order\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*term_order\s*>=\s*0\s*\)/iu.test(schema)
    || /term_order\s*<=/iu.test(schema)) {
    throw new Error('assistant-memory v7 QueryTerm 顺序约束无效。');
  }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) throw new Error('assistant-memory v7 外键校验失败。');
}
