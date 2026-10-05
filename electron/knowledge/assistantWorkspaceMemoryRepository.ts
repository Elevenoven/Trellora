import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AssistantTurnResult } from './assistantTurnTypes';
import { createAssistantLibraryId } from './assistantLibraryIdentity';
import { AssistantWorkspaceMemoryDatabase } from './assistantWorkspaceMemoryDatabase';
import { AssistantSessionScopeError, assertAssistantSessionId } from './assistantSessionScope';
import type {
  AssistantWorkspaceMemoryPage,
  AssistantWorkspaceSessionDetail,
  AssistantWorkspaceSessionSummary,
  AssistantWorkspaceStoredTurn,
  AssistantWorkspaceTurnStatus,
} from './assistantWorkspaceMemoryTypes';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_RESTORED_TURNS = 500;

interface WorkspaceSessionRow {
  session_id: string;
  title: string;
  is_pinned: number;
  last_turn_seq: number;
  turn_count: number;
  created_at: string;
  updated_at: string;
}

interface WorkspaceTurnRow {
  turn_id: string;
  turn_seq: number;
  user_text: string;
  assistant_text: string | null;
  scope_label: string;
  status: AssistantWorkspaceTurnStatus;
  result_json: string;
  created_at: string;
  finished_at: string | null;
}

export class AssistantWorkspaceMemoryReadOnlyError extends Error {
  readonly code = 'ASSISTANT_WORKSPACE_MEMORY_READ_ONLY';

  constructor() {
    super('旧知识库问答历史已停用写入，请使用统一问答历史。');
  }
}

/**
 * Compatibility reader for conversation-memory.db. All mutation methods fail
 * closed so an old renderer or plugin cannot restart the retired write path.
 */
export class AssistantWorkspaceMemoryRepository {
  private readonly libraryIdValue: string;

  constructor(
    private readonly databaseOwner: AssistantWorkspaceMemoryDatabase,
    private readonly workspacePath: string,
    libraryPath: string,
  ) {
    this.libraryIdValue = createAssistantLibraryId(path.resolve(libraryPath));
  }

  createSession(_title = '新会话'): AssistantWorkspaceSessionSummary {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  listSessions(cursor?: number, pageSize = DEFAULT_PAGE_SIZE): AssistantWorkspaceMemoryPage<AssistantWorkspaceSessionSummary> {
    const database = this.database();
    if (!database) return { items: [] };
    const page = normalizePage(cursor);
    const normalizedPageSize = normalizePageSize(pageSize);
    const rows = database.prepare(`
      SELECT session_id, title, is_pinned, last_turn_seq, created_at, updated_at,
        (SELECT COUNT(*) FROM assistant_workspace_turns
          WHERE assistant_workspace_turns.session_id = assistant_workspace_sessions.session_id) AS turn_count
      FROM assistant_workspace_sessions
      WHERE library_id = ?
      ORDER BY is_pinned DESC, updated_at DESC, session_id DESC
      LIMIT ? OFFSET ?
    `).all(this.libraryIdValue, normalizedPageSize + 1, page * normalizedPageSize) as WorkspaceSessionRow[];
    const hasNext = rows.length > normalizedPageSize;
    return {
      items: rows.slice(0, normalizedPageSize).map(toSessionSummary),
      ...(hasNext ? { nextCursor: page + 1 } : {}),
    };
  }

  getSession(sessionId: string): AssistantWorkspaceSessionDetail {
    assertAssistantSessionId(sessionId);
    const database = this.database();
    if (!database) throw new AssistantSessionScopeError();
    const session = this.getSessionSummary(database, sessionId);
    const rows = database.prepare(`
      SELECT * FROM (
        SELECT turn_id, turn_seq, user_text, assistant_text, scope_label, status,
          result_json, created_at, finished_at
        FROM assistant_workspace_turns
        WHERE session_id = ?
        ORDER BY turn_seq DESC
        LIMIT ?
      ) ORDER BY turn_seq ASC
    `).all(sessionId, MAX_RESTORED_TURNS) as WorkspaceTurnRow[];
    return { session, turns: rows.map(toStoredTurn) };
  }

  renameSession(_sessionId: string, _title: string): AssistantWorkspaceSessionSummary {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  setPinned(_sessionId: string, _pinned: boolean): AssistantWorkspaceSessionSummary {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  deleteSession(_sessionId: string): void {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  startTurn(
    _sessionId: string,
    _input: { turnId: string; userText: string; scopeLabel: string },
  ): { turnId: string; turnSeq: number } {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  finalizeTurn(_sessionId: string, _turnId: string, _result: AssistantTurnResult): void {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  finishAbortedTurn(
    _sessionId: string,
    _turnId: string,
    _status: Extract<AssistantWorkspaceTurnStatus, 'cancelled' | 'error'>,
  ): void {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  recoverInterruptedTurns(): number {
    throw new AssistantWorkspaceMemoryReadOnlyError();
  }

  private getSessionSummary(database: Database.Database, sessionId: string): AssistantWorkspaceSessionSummary {
    const row = database.prepare(`
      SELECT session_id, title, is_pinned, last_turn_seq, created_at, updated_at,
        (SELECT COUNT(*) FROM assistant_workspace_turns
          WHERE assistant_workspace_turns.session_id = assistant_workspace_sessions.session_id) AS turn_count
      FROM assistant_workspace_sessions
      WHERE session_id = ? AND library_id = ?
    `).get(sessionId, this.libraryIdValue) as WorkspaceSessionRow | undefined;
    if (!row) throw new AssistantSessionScopeError();
    return toSessionSummary(row);
  }

  private database(): Database.Database | undefined {
    return this.databaseOwner.getDatabase(this.workspacePath);
  }
}

function toSessionSummary(row: WorkspaceSessionRow): AssistantWorkspaceSessionSummary {
  return {
    sessionId: row.session_id,
    title: row.title,
    pinned: row.is_pinned === 1,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredTurn(row: WorkspaceTurnRow): AssistantWorkspaceStoredTurn {
  let result: AssistantTurnResult | undefined;
  if (row.result_json && row.result_json !== '{}') {
    try {
      result = JSON.parse(row.result_json) as AssistantTurnResult;
    } catch {
      result = undefined;
    }
  }
  return {
    turnId: row.turn_id,
    turnSeq: row.turn_seq,
    userText: row.user_text,
    ...(row.assistant_text ? { assistantText: row.assistant_text } : {}),
    scopeLabel: row.scope_label,
    status: row.status,
    ...(result ? { result } : {}),
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function normalizePage(value?: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function normalizePageSize(value: number): number {
  return Number.isInteger(value) ? Math.min(MAX_PAGE_SIZE, Math.max(1, value)) : DEFAULT_PAGE_SIZE;
}
