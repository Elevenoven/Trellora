import { createHash } from 'node:crypto';
import { normalizeMemorySaveClaims } from '../../shared/memorySaveClaims';
import { readMemoryCitationMetadata } from '../../shared/memoryCitations';
import type Database from 'better-sqlite3';
import type { AssistantAttachment, AssistantTurnResult } from './assistantTurnTypes';
import { QaMemoryDatabase } from './qaMemoryDatabase';
import {
  assertQaConversationCheckpointCandidate,
  assertQaConversationCheckpointPayloadShape,
  calculateQaCheckpointSourceHash,
  renderQaConversationCheckpointPayload,
} from './qaConversationCheckpoint';
import { AssistantSessionScopeError, assertAssistantSessionId, createAssistantSessionId } from './assistantSessionScope';
import { estimateTokenCount } from './tokenEstimator';
import { MEMORY_CONSTANTS } from './memory/memoryConstants';
import { calculateConversationArchiveHash, normalizeConversationSearchText } from './memory/conversationArchiveContract';
import { ensureScopeRows, runInImmediateTransaction } from './memory/memoryRepository';
import { assertTrustedMemoryScope } from './memory/memoryScope';
import { detectExplicitMemoryStatement } from './memory/memoryText';
import type { TrustedMemoryScope } from './memory/memoryTypes';
import {
  calculateQaHistoryMessageOverfetch,
  describeAssistantAttachments,
  stripInlineThinkBlocks,
  validateQaAgentMessageInputs,
  validateQaStoredAgentMessages,
} from './qaCanonicalHistory';
import type {
  QaAgentMessage,
  QaAgentMessageInput,
  QaAgentToolCall,
  QaCanonicalRoute,
  QaMemoryPage,
  QaMemoryCompactionRun,
  QaMemoryCompactionRunStatus,
  QaRecentCompleteTurn,
  QaConversationCheckpoint,
  QaConversationCheckpointCandidate,
  QaConversationCheckpointV1,
  QaSessionDetail,
  QaSessionScope,
  QaSessionSummary,
  QaStoredTurn,
  QaSummaryBlock,
  QaSummaryCompressor,
  QaSummaryRollup,
  QaSummaryRollupLevel,
  QaSummaryRollupStatus,
  QaSummaryStatus,
  QaTurnMetadata,
  QaTurnStatus,
} from './qaMemoryTypes';
import { QA_HOT_TURN_STATUSES } from './qaMemoryTypes';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_RESTORED_TURNS = 500;
const MAX_TITLE_CHARS = 80;

/** 旧滚动摘要边界；WK-M9 切换前保持 6，避免改变既有摘要批次坐标。 */
export const QA_HOT_TURN_COUNT = 6;
/** 滚动摘要每批轮次数（设计 §3.1）。 */
export const QA_BATCH_SIZE = 3;
/** 单批摘要上限（设计 §3.2）。 */
export const QA_BATCH_SUMMARY_MAX_TOKENS = 800;
/** LLM 压缩失败后最多重试一次（设计 §3.4）。 */
export const QA_COMPRESSION_MAX_RETRY = 1;
/** L2/L3 都保持为小型结构化记忆块，不随会话长度线性增长。 */
export const QA_ROLLUP_SUMMARY_MAX_TOKENS = 800;
export const QA_ROLLUP_GROUP_SIZE = 3;

export class QaSessionModeMismatchError extends Error {
  readonly code = 'QA_SESSION_MODE_MISMATCH';

  constructor(readonly currentScope: QaSessionScope, readonly requestedScope: QaSessionScope) {
    super(currentScope === 'chat'
      ? '当前会话属于开放式问答，请新建知识库问答会话后再继续。'
      : '当前会话属于知识库问答，请新建开放式问答会话后再继续。');
    this.name = 'QaSessionModeMismatchError';
  }
}

/** 热窗外的第一轮固定为 7，此后每 3 轮一批：[7-9]、[10-12]…… */
export function batchTurnFrom(batchIndex: number): number {
  return QA_HOT_TURN_COUNT + 1 + batchIndex * QA_BATCH_SIZE;
}

export function isValidBatchBoundary(turnFrom: number, turnTo: number): boolean {
  if (!Number.isSafeInteger(turnFrom) || !Number.isSafeInteger(turnTo)) return false;
  if (turnFrom < QA_HOT_TURN_COUNT + 1) return false;
  if ((turnFrom - (QA_HOT_TURN_COUNT + 1)) % QA_BATCH_SIZE !== 0) return false;
  return turnTo === turnFrom + QA_BATCH_SIZE - 1;
}

export interface QaSessionState {
  sessionId: string;
  scope: QaSessionScope;
  title: string;
  lastTurnSeq: number;
  summarizedThroughSeq: number;
}

export interface QaPlannedBatch {
  turnFrom: number;
  turnTo: number;
  /** missing = 尚无可用摘要行；upgrade = 仅有 fallback 占位，等待 LLM 覆盖。 */
  need: 'missing' | 'upgrade';
}

export interface QaRollupSource {
  id: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  text: string;
  version: string;
}

export interface QaPlannedRollup {
  level: QaSummaryRollupLevel;
  sourceStartSeq: number;
  sourceEndSeq: number;
  sourceIds: string[];
  sourceHash: string;
  sources: QaRollupSource[];
}

interface SessionRow {
  session_id: string;
  scope: QaSessionScope;
  title: string;
  library_path: string | null;
  is_pinned: number;
  last_turn_seq: number;
  summarized_through_seq: number;
  turn_count: number;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  turn_id: string;
  request_id?: string;
  attempt_no?: number;
  replaced_by_turn_id?: string | null;
  turn_seq: number;
  user_text: string;
  assistant_text: string | null;
  scope_label: string;
  status: QaTurnStatus;
  result_json: string;
  result_metadata_json?: string;
  created_at: string;
  finished_at: string | null;
}

interface AgentMessageRow {
  message_id: string;
  turn_id: string;
  message_seq: number;
  role: 'assistant' | 'tool';
  content: string;
  reasoning_content: string;
  tool_call_id: string | null;
  artifact_ref_json: string | null;
  created_at: string;
}

interface AgentToolCallRow {
  call_id: string;
  message_id: string;
  call_seq: number;
  tool_name: string;
  arguments_json: string;
}

interface SummaryRow {
  batch_id: string;
  turn_from: number;
  turn_to: number;
  summary_text: string;
  tokens: number;
  compressor: QaSummaryCompressor;
  status: QaSummaryStatus;
  retry_count: number;
  updated_at: string;
}

interface SummaryRollupRow {
  rollup_id: string;
  level: QaSummaryRollupLevel;
  source_start_seq: number;
  source_end_seq: number;
  source_ids_json: string;
  source_hash: string;
  summary_text: string;
  tokens: number;
  compressor: QaSummaryCompressor;
  status: QaSummaryRollupStatus;
  summary_version: number;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  session_id: string;
  checkpoint_version: number;
  covered_from_seq: 1;
  covered_through_seq: number;
  source_hash: string;
  summary_payload_json: string;
  summary_text: string;
  summary_tokens: number;
  target_tokens: number;
  source_tokens: number;
  compression_ratio: number;
  compressor: QaSummaryCompressor;
  model_profile: string | null;
  created_at: string;
  updated_at: string;
}

interface CompactionRunRow {
  run_id: string;
  session_id: string;
  base_checkpoint_version: number;
  source_from_seq: number;
  source_to_seq: number;
  source_hash: string;
  source_tokens: number;
  target_tokens: number;
  output_tokens: number | null;
  status: QaMemoryCompactionRunStatus;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
}

export type QaCheckpointCasResult =
  | { status: 'committed'; checkpoint: QaConversationCheckpoint }
  | { status: 'conflict'; reason: 'base-changed' | 'source-changed'; current?: QaConversationCheckpoint };

export interface QaStartTurnInput {
  turnId: string;
  /** Retries share requestId and receive a monotonically increasing attemptNo. */
  requestId?: string;
  attemptNo?: number;
  userText: string;
  scopeLabel: string;
  route?: QaCanonicalRoute;
  attachments?: readonly AssistantAttachment[];
}

export interface QaFinalizeTurnOptions {
  agentMessages?: readonly QaAgentMessageInput[];
  /** Explicit provider reasoning for the final assistant response. */
  finalReasoningContent?: string;
  route?: QaCanonicalRoute;
  /** Resolved by the main process; never accepted from renderer/model input. */
  archiveScope?: TrustedMemoryScope;
}

export class QaMemoryRepository {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly workspacePath: string,
    private readonly extractionAuthority?: {
      resolveScope: () => TrustedMemoryScope | undefined;
      isRouteEnabled: (route: QaCanonicalRoute, agentId: string) => boolean;
    },
  ) {}

  // ---------- 会话 ----------

  createSession(scope: QaSessionScope, input: { title?: string; libraryPath?: string } = {}): QaSessionSummary {
    return this.createSessionWithId(createAssistantSessionId(), scope, input);
  }

  /** 主进程自动建会话，或在校验问答模式后恢复既有会话。 */
  ensureSession(sessionId: string, scope: QaSessionScope, input: { title?: string; libraryPath?: string } = {}): QaSessionSummary {
    assertAssistantSessionId(sessionId);
    const database = this.database();
    const row = database.prepare(`
      SELECT session_id, scope, library_path, last_turn_seq FROM qa_sessions WHERE session_id = ?
    `).get(sessionId) as Pick<SessionRow, 'session_id' | 'scope' | 'library_path' | 'last_turn_seq'> | undefined;
    if (row) {
      const libraryPath = scope === 'knowledge-base' ? input.libraryPath?.trim() || null : null;
      if (row.scope !== scope) {
        if (row.last_turn_seq > 0) throw new QaSessionModeMismatchError(row.scope, scope);
        database.prepare(`
          UPDATE qa_sessions SET scope = ?, library_path = ?, updated_at = ? WHERE session_id = ?
        `).run(scope, libraryPath, new Date().toISOString(), sessionId);
      } else if (row.library_path !== libraryPath && (scope === 'chat' || libraryPath)) {
        database.prepare(`
          UPDATE qa_sessions SET library_path = ?, updated_at = ? WHERE session_id = ?
        `).run(libraryPath, new Date().toISOString(), sessionId);
      }
      return this.getSessionSummary(sessionId);
    }
    return this.createSessionWithId(sessionId, scope, input);
  }

  /** 全局会话列表：同时展示两种模式，每个会话仍由 scope 严格隔离。 */
  listSessions(input: { cursor?: number; pageSize?: number } = {}): QaMemoryPage<QaSessionSummary> {
    const page = normalizePage(input.cursor);
    const pageSize = normalizePageSize(input.pageSize ?? DEFAULT_PAGE_SIZE);
    const rows = this.database().prepare(`
      SELECT session_id, scope, title, library_path, is_pinned, last_turn_seq, summarized_through_seq,
        created_at, updated_at,
        (SELECT COUNT(*) FROM qa_turns WHERE qa_turns.session_id = qa_sessions.session_id) AS turn_count
      FROM qa_sessions
      ORDER BY is_pinned DESC, updated_at DESC, session_id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize + 1, page * pageSize) as SessionRow[];
    const hasNext = rows.length > pageSize;
    return {
      items: rows.slice(0, pageSize).map(toSessionSummary),
      ...(hasNext ? { nextCursor: page + 1 } : {}),
    };
  }

  getSession(sessionId: string): QaSessionDetail {
    assertAssistantSessionId(sessionId);
    const session = this.getSessionSummary(sessionId);
    const turnRows = this.database().prepare(`
      SELECT * FROM (
        SELECT turn_id, request_id, attempt_no, replaced_by_turn_id, turn_seq,
          user_text, assistant_text, scope_label, status, result_json,
          result_metadata_json, created_at, finished_at
        FROM qa_turns
        WHERE session_id = ? AND replaced_by_turn_id IS NULL
        ORDER BY turn_seq DESC
        LIMIT ?
      ) ORDER BY turn_seq ASC
    `).all(sessionId, MAX_RESTORED_TURNS) as TurnRow[];
    const summaryRows = this.database().prepare(`
      SELECT batch_id, turn_from, turn_to, summary_text, tokens, compressor, status, retry_count, updated_at
      FROM qa_summaries
      WHERE session_id = ?
      ORDER BY turn_from ASC
    `).all(sessionId) as SummaryRow[];
    const usedRows = this.database().prepare(`
      SELECT used.turn_id, used.item_id, used.kind, used.content_snapshot, used.used_at, turns.result_metadata_json
      FROM assistant_used_memories AS used
      JOIN qa_turns AS turns ON turns.turn_id = used.turn_id
      WHERE turns.session_id = ? AND turns.replaced_by_turn_id IS NULL
      ORDER BY used.turn_id ASC, used.used_at ASC, used.item_id ASC
    `).all(sessionId) as Array<{
      turn_id: string;
      item_id: string;
      kind: 'profile' | 'preference' | 'fact' | 'task' | 'interest';
      content_snapshot: string;
      used_at: string;
      result_metadata_json: string;
    }>;
    const usedByTurn = new Map<string, QaStoredTurn['usedMemories']>();
    for (const row of usedRows) {
      const entries = usedByTurn.get(row.turn_id) ?? [];
      entries.push({ itemId: row.item_id, kind: row.kind, contentSnapshot: row.content_snapshot, usedAt: row.used_at, ...readMemoryCitationMetadata(row.result_metadata_json, row.item_id) });
      usedByTurn.set(row.turn_id, entries);
    }
    return {
      session,
      turns: turnRows.map((row) => toStoredTurn(row, usedByTurn.get(row.turn_id))),
      summaries: summaryRows.map(toSummaryBlock),
    };
  }

  renameSession(sessionId: string, title: string): QaSessionSummary {
    assertAssistantSessionId(sessionId);
    const updatedAt = new Date().toISOString();
    const changes = this.database().prepare(`
      UPDATE qa_sessions SET title = ?, updated_at = ? WHERE session_id = ?
    `).run(sanitizeTitle(title), updatedAt, sessionId).changes;
    if (!changes) throw new AssistantSessionScopeError();
    return this.getSessionSummary(sessionId);
  }

  setPinned(sessionId: string, pinned: boolean): QaSessionSummary {
    assertAssistantSessionId(sessionId);
    const updatedAt = new Date().toISOString();
    const changes = this.database().prepare(`
      UPDATE qa_sessions SET is_pinned = ?, updated_at = ? WHERE session_id = ?
    `).run(pinned ? 1 : 0, updatedAt, sessionId).changes;
    if (!changes) throw new AssistantSessionScopeError();
    return this.getSessionSummary(sessionId);
  }

  deleteSession(sessionId: string): void {
    assertAssistantSessionId(sessionId);
    const database = this.database();
    database.transaction(() => {
      const pending = database.prepare(`
        SELECT 1 AS present FROM qa_turns WHERE session_id = ? AND status = 'pending' LIMIT 1
      `).get(sessionId) as { present: number } | undefined;
      if (pending) throw new Error('当前会话仍在回答，停止回答后才能删除。');
      const changes = database.prepare(`DELETE FROM qa_sessions WHERE session_id = ?`).run(sessionId).changes;
      if (!changes) throw new AssistantSessionScopeError();
    })();
  }

  // ---------- 轮次 ----------

  startTurn(sessionId: string, input: QaStartTurnInput): { turnId: string; turnSeq: number; requestId: string; attemptNo: number } {
    assertAssistantSessionId(sessionId);
    assertTurnInput(input);
    const database = this.database();
    return runInImmediateTransaction(database, () => {
      const session = database.prepare(`
        SELECT session_id, title, last_turn_seq FROM qa_sessions WHERE session_id = ?
      `).get(sessionId) as Pick<SessionRow, 'session_id' | 'title' | 'last_turn_seq'> | undefined;
      if (!session) throw new AssistantSessionScopeError();
      const turnSeq = session.last_turn_seq + 1;
      const requestId = input.requestId?.trim() || input.turnId;
      const previousAttempt = database.prepare(`
        SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no
        FROM qa_turns WHERE session_id = ? AND request_id = ?
      `).get(sessionId, requestId) as { attempt_no: number };
      const attemptNo = input.attemptNo ?? previousAttempt.attempt_no + 1;
      if (attemptNo <= previousAttempt.attempt_no) {
        throw new Error('问答重试 attempt_no 必须大于已有尝试。');
      }
      const createdAt = new Date().toISOString();
      const owner = this.extractionAuthority?.resolveScope();
      if (owner) assertTrustedMemoryScope(owner);
      if (owner) ensureScopeRows(database, owner, createdAt);
      const generation = owner ? (database.prepare(`SELECT memory_generation FROM memory_subjects
        WHERE workspace_id = ? AND principal_id = ?`).get(owner.workspaceId, owner.principalId) as { memory_generation: number }).memory_generation : undefined;
      const metadataJson = JSON.stringify({
        schemaVersion: 1,
        route: input.route ?? 'chat',
        attachments: describeAssistantAttachments(input.attachments),
        ...(owner ? { memoryScope: { workspaceId: owner.workspaceId, principalId: owner.principalId },
          memoryExtractionGeneration: generation, memoryExtractionAgentId: 'default', memoryExtractionEligible: false,
          memoryExplicitSaveEnabled: Boolean(detectExplicitMemoryStatement(input.userText) && database.prepare(`SELECT 1
            FROM memory_workspace_settings w JOIN memory_subjects s ON s.workspace_id = w.workspace_id
            WHERE w.workspace_id = ? AND s.principal_id = ? AND w.enabled = 1 AND s.enabled = 1`)
            .get(owner.workspaceId, owner.principalId)) } : {}),
      });
      database.prepare(`
        INSERT INTO qa_turns (
          turn_id, session_id, turn_seq, request_id, attempt_no, replaced_by_turn_id,
          user_text, assistant_text, scope_label, status, user_tokens, assistant_tokens,
          result_json, result_metadata_json, created_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'pending', ?, 0, '{}', ?, ?, NULL)
      `).run(
        input.turnId,
        sessionId,
        turnSeq,
        requestId,
        attemptNo,
        input.userText,
        input.scopeLabel,
        estimateTokenCount(input.userText),
        metadataJson,
        createdAt,
      );
      const nextTitle = session.last_turn_seq === 0 && session.title === '新会话'
        ? deriveTitle(input.userText)
        : session.title;
      database.prepare(`
        UPDATE qa_sessions SET title = ?, last_turn_seq = ?, updated_at = ? WHERE session_id = ?
      `).run(nextTitle, turnSeq, createdAt, sessionId);
      return { turnId: input.turnId, turnSeq, requestId, attemptNo };
    });
  }

  finalizeTurn(sessionId: string, turnId: string, result: AssistantTurnResult, options: QaFinalizeTurnOptions = {}): void {
    assertAssistantSessionId(sessionId);
    if (result.type !== 'answer') throw new Error('问答轮次只能以最终回答完成。');
    const agentMessages = [
      ...(options.agentMessages ?? []),
      ...(options.finalReasoningContent?.trim()
        ? [{ role: 'assistant' as const, reasoningContent: options.finalReasoningContent }]
        : []),
    ];
    validateQaAgentMessageInputs(agentMessages);
    const finishedAt = new Date().toISOString();
    const assistantText = normalizeMemorySaveClaims(stripInlineThinkBlocks(result.answer));
    if (!assistantText) throw new Error('模型最终回答去除 think 块后为空，未标记为完成。');
    const resultJson = JSON.stringify(stripAssistantTextFromResult(result));
    const status: QaTurnStatus = result.completeness === 'partial'
      ? 'partial'
      : result.completeness === 'not-found' ? 'not-found' : 'complete';
    const database = this.database();
    runInImmediateTransaction(database, () => {
      const pending = database.prepare(`
        SELECT request_id, attempt_no, user_text, created_at, result_metadata_json FROM qa_turns
        WHERE turn_id = ? AND session_id = ? AND status = 'pending'
      `).get(turnId, sessionId) as {
        request_id: string;
        attempt_no: number;
        user_text: string;
        created_at: string;
        result_metadata_json: string;
      } | undefined;
      if (!pending) throw new AssistantSessionScopeError();
      if (options.archiveScope) assertTrustedMemoryScope(options.archiveScope);
      const startedMetadata = parseTurnMetadata(pending.result_metadata_json);
      const owner = startedMetadata.memoryScope;
      const sameOwner = owner && options.archiveScope
        && owner.workspaceId === options.archiveScope.workspaceId && owner.principalId === options.archiveScope.principalId;
      const currentScope = this.extractionAuthority?.resolveScope();
      const currentSubject = owner ? database.prepare(`SELECT memory_generation, enabled FROM memory_subjects
        WHERE workspace_id = ? AND principal_id = ?`).get(owner.workspaceId, owner.principalId) as { memory_generation: number; enabled: number } | undefined : undefined;
      const settings = owner ? database.prepare(`SELECT enabled, write_mode FROM memory_workspace_settings WHERE workspace_id = ?`)
        .get(owner.workspaceId) as { enabled: number; write_mode: string } | undefined : undefined;
      const extractionEligible = Boolean(status === 'complete' && sameOwner && currentScope
        && currentScope.workspaceId === owner?.workspaceId && currentScope.principalId === owner?.principalId
        && currentSubject?.memory_generation === startedMetadata.memoryExtractionGeneration
        && currentSubject?.enabled === 1 && settings?.enabled === 1 && settings.write_mode === 'auto'
        && (!options.route || options.route === startedMetadata.route)
        && this.extractionAuthority?.isRouteEnabled(startedMetadata.route, startedMetadata.memoryExtractionAgentId ?? ''));
      const finalMetadataJson = JSON.stringify({
        ...startedMetadata,
        memoryExtractionEligible: extractionEligible,
        // The durable completed turn doubles as the explicit-save journal across a crash.
        memoryExplicitSavePending: Boolean(status === 'complete' && startedMetadata.memoryExplicitSaveEnabled
          && sameOwner && currentScope?.workspaceId === owner?.workspaceId && currentScope?.principalId === owner?.principalId
          && currentSubject?.memory_generation === startedMetadata.memoryExtractionGeneration
          && currentSubject?.enabled === 1 && settings?.enabled === 1),
        ...(!owner && options.route ? { route: options.route } : {}),
        ...(!owner && options.archiveScope ? {
          memoryScope: {
            workspaceId: options.archiveScope.workspaceId,
            principalId: options.archiveScope.principalId,
          },
        } : {}),
      });
      const current = database.prepare(`
        SELECT turn_id, attempt_no FROM qa_turns
        WHERE session_id = ? AND request_id = ?
          AND status IN ('complete', 'partial', 'not-found')
          AND replaced_by_turn_id IS NULL
        ORDER BY attempt_no DESC, turn_seq DESC
        LIMIT 1
      `).get(sessionId, pending.request_id) as { turn_id: string; attempt_no: number } | undefined;
      const replacedByTurnId = current && current.attempt_no > pending.attempt_no ? current.turn_id : null;
      if (current && current.attempt_no < pending.attempt_no) {
        database.prepare(`
          UPDATE qa_turns SET replaced_by_turn_id = ?
          WHERE turn_id = ? AND session_id = ? AND replaced_by_turn_id IS NULL
        `).run(turnId, current.turn_id, sessionId);
      }

      persistAgentMessages(database, turnId, agentMessages, finishedAt);
      const changes = database.prepare(`
        UPDATE qa_turns
        SET assistant_text = ?, status = ?, assistant_tokens = ?, result_json = ?,
          result_metadata_json = ?, replaced_by_turn_id = ?, finished_at = ?
        WHERE turn_id = ? AND session_id = ? AND status = 'pending'
      `).run(
        assistantText,
        status,
        estimateTokenCount(assistantText),
        resultJson,
        finalMetadataJson,
        replacedByTurnId,
        finishedAt,
        turnId,
        sessionId,
      ).changes;
      if (!changes) throw new AssistantSessionScopeError();
      if (current && current.attempt_no < pending.attempt_no) {
        database.prepare(`DELETE FROM conversation_search_documents WHERE turn_id = ?`).run(current.turn_id);
      }
      if (options.archiveScope && !replacedByTurnId) {
        ensureScopeRows(database, options.archiveScope, finishedAt);
        const contentHash = calculateConversationArchiveHash(pending.user_text, assistantText);
        database.prepare(`
          INSERT INTO conversation_search_documents (
            turn_id, workspace_id, principal_id, session_id, question, answer,
            search_text, content_hash, embedding_model_id, embedding_dimensions,
            embedding, embedding_fingerprint, index_state, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', ?)
          ON CONFLICT(turn_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            principal_id = excluded.principal_id,
            session_id = excluded.session_id,
            question = excluded.question,
            answer = excluded.answer,
            search_text = excluded.search_text,
            content_hash = excluded.content_hash,
            embedding_model_id = NULL,
            embedding_dimensions = NULL,
            embedding = NULL,
            embedding_fingerprint = NULL,
            index_state = 'pending',
            created_at = excluded.created_at
        `).run(
          turnId,
          options.archiveScope.workspaceId,
          options.archiveScope.principalId,
          sessionId,
          pending.user_text,
          assistantText,
          normalizeConversationSearchText(`${pending.user_text}\n${assistantText}`),
          contentHash,
          pending.created_at,
        );
      }
      database.prepare(`UPDATE qa_sessions SET updated_at = ? WHERE session_id = ?`).run(finishedAt, sessionId);
    });
  }

  finishAbortedTurn(
    sessionId: string,
    turnId: string,
    status: Extract<QaTurnStatus, 'cancelled' | 'error'>,
    assistantText?: string,
  ): void {
    assertAssistantSessionId(sessionId);
    const finishedAt = new Date().toISOString();
    const preservedAssistantText = status === 'cancelled' && assistantText
      ? stripInlineThinkBlocks(assistantText)
      : '';
    const database = this.database();
    database.transaction(() => {
      database.prepare(`
        UPDATE qa_turns
        SET assistant_text = ?, assistant_tokens = ?, status = ?, finished_at = ?
        WHERE turn_id = ? AND session_id = ? AND status = 'pending'
      `).run(
        preservedAssistantText || null,
        estimateTokenCount(preservedAssistantText),
        status,
        finishedAt,
        turnId,
        sessionId,
      );
      database.prepare(`UPDATE qa_sessions SET updated_at = ? WHERE session_id = ?`).run(finishedAt, sessionId);
    })();
  }

  recoverInterruptedTurns(): number {
    const database = this.database();
    const finishedAt = new Date().toISOString();
    return database.transaction(() => {
      const pending = database.prepare(`
        SELECT turn_id, session_id FROM qa_turns WHERE status = 'pending'
      `).all() as Array<{ turn_id: string; session_id: string }>;
      const updateTurn = database.prepare(`
        UPDATE qa_turns SET status = 'interrupted', finished_at = ? WHERE turn_id = ?
      `);
      const updateSession = database.prepare(`UPDATE qa_sessions SET updated_at = ? WHERE session_id = ?`);
      for (const row of pending) {
        updateTurn.run(finishedAt, row.turn_id);
        updateSession.run(finishedAt, row.session_id);
      }
      return pending.length;
    })();
  }

  /**
   * WeKnora-aligned L2 reader. qa_turns stores the user/assistant pair in one
   * row, so the raw-message overfetch is converted to its equivalent turn-row
   * limit only after calculating max(historyTurns*4, 50).
   */
  loadRecentCompleteTurns(
    sessionId: string,
    historyTurns = MEMORY_CONSTANTS.conversationHistory.recentCompleteTurns,
  ): QaRecentCompleteTurn[] {
    assertAssistantSessionId(sessionId);
    if (!Number.isSafeInteger(historyTurns) || historyTurns < 0) throw new Error('最近历史轮数无效。');
    if (historyTurns === 0) return [];
    const messageFetchLimit = calculateQaHistoryMessageOverfetch(historyTurns);
    const turnRowFetchLimit = Math.ceil(messageFetchLimit / 2);
    const rows = this.database().prepare(`
      SELECT turn_id, request_id, attempt_no, replaced_by_turn_id, turn_seq,
        user_text, assistant_text, scope_label, status, result_json,
        result_metadata_json, created_at, finished_at
      FROM qa_turns
      WHERE session_id = ?
      ORDER BY turn_seq DESC, attempt_no DESC, turn_id DESC
      LIMIT ?
    `).all(sessionId, turnRowFetchLimit) as TurnRow[];
    const eligibleRows = rows.filter(isCompleteTurnRow);
    if (eligibleRows.length === 0) return [];
    const loadedAgentMessages = loadAgentMessagesByTurn(this.database(), eligibleRows.map((row) => row.turn_id));
    return eligibleRows
      .flatMap((row) => {
        if (loadedAgentMessages.invalidTurnIds.has(row.turn_id)) return [];
        const agentMessages = loadedAgentMessages.messagesByTurn.get(row.turn_id) ?? [];
        if (!validateQaStoredAgentMessages(agentMessages)) return [];
        return [toRecentCompleteTurn(row, agentMessages)];
      })
      .slice(0, historyTurns)
      .reverse();
  }

  /** 最近 ≤limit 个已完成轮次，新 → 旧排序（设计 §2.1：取消/失败轮不入窗）。 */
  loadHotTurns(sessionId: string, limit = QA_HOT_TURN_COUNT): Array<QaStoredTurn> {
    return this.loadRecentCompleteTurns(sessionId, limit)
      .map((turn): QaStoredTurn => ({
        turnId: turn.turnId,
        requestId: turn.requestId,
        attemptNo: turn.attemptNo,
        turnSeq: turn.turnSeq,
        userText: turn.userText,
        assistantText: turn.assistantText,
        scopeLabel: turn.scopeLabel,
        status: turn.status,
        createdAt: turn.createdAt,
        finishedAt: turn.finishedAt,
      }))
      .reverse();
  }

  // ---------- 会话状态与摘要批次 ----------

  getSessionState(sessionId: string): QaSessionState {
    assertAssistantSessionId(sessionId);
    const row = this.database().prepare(`
      SELECT session_id, scope, title, last_turn_seq, summarized_through_seq
      FROM qa_sessions WHERE session_id = ?
    `).get(sessionId) as Pick<SessionRow, 'session_id' | 'scope' | 'title' | 'last_turn_seq' | 'summarized_through_seq'> | undefined;
    if (!row) throw new AssistantSessionScopeError();
    return {
      sessionId: row.session_id,
      scope: row.scope,
      title: row.title,
      lastTurnSeq: row.last_turn_seq,
      summarizedThroughSeq: row.summarized_through_seq,
    };
  }

  /** 读取批次轮次原文（用于压缩），按 turn_seq 升序。 */
  loadTurnRange(sessionId: string, turnFrom: number, turnTo: number): QaStoredTurn[] {
    assertAssistantSessionId(sessionId);
    const rows = this.database().prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text, scope_label, status,
        result_json, created_at, finished_at
      FROM qa_turns
      WHERE session_id = ? AND turn_seq BETWEEN ? AND ?
      ORDER BY turn_seq ASC
    `).all(sessionId, turnFrom, turnTo) as TurnRow[];
    return rows.map(toStoredTurn);
  }

  listSummaries(sessionId: string): QaSummaryBlock[] {
    assertAssistantSessionId(sessionId);
    const rows = this.database().prepare(`
      SELECT batch_id, turn_from, turn_to, summary_text, tokens, compressor, status, retry_count, updated_at
      FROM qa_summaries
      WHERE session_id = ?
      ORDER BY turn_from ASC
    `).all(sessionId) as SummaryRow[];
    return rows.map(toSummaryBlock);
  }

  /** 分层摘要只供维护与压力策略读取；L1 原始摘要和 Turn 永不删除。 */
  listSummaryRollups(sessionId: string, level?: QaSummaryRollupLevel): QaSummaryRollup[] {
    assertAssistantSessionId(sessionId);
    const rows = level === undefined
      ? this.database().prepare(`
        SELECT rollup_id, level, source_start_seq, source_end_seq, source_ids_json,
          source_hash, summary_text, tokens, compressor, status, summary_version, created_at, updated_at
        FROM qa_summary_rollups WHERE session_id = ?
        ORDER BY level ASC, source_start_seq ASC
      `).all(sessionId) as SummaryRollupRow[]
      : this.database().prepare(`
        SELECT rollup_id, level, source_start_seq, source_end_seq, source_ids_json,
          source_hash, summary_text, tokens, compressor, status, summary_version, created_at, updated_at
        FROM qa_summary_rollups WHERE session_id = ? AND level = ?
        ORDER BY source_start_seq ASC
      `).all(sessionId, level) as SummaryRollupRow[];
    return rows.map(toSummaryRollup);
  }

  /**
   * Plans exact groups of three: L2 consumes L1 batches and L3 consumes L2.
   * A source change marks the old row stale before a replacement is scheduled.
   */
  planPendingRollups(sessionId: string, level: QaSummaryRollupLevel): QaPlannedRollup[] {
    assertAssistantSessionId(sessionId);
    const sources = level === 2
      ? this.loadL1RollupSources(sessionId)
      : this.loadL2RollupSources(sessionId);
    const existing = new Map(this.listSummaryRollups(sessionId, level)
      .map((rollup) => [rollup.sourceStartSeq, rollup]));
    const sourceByStart = new Map(sources.map((source) => [source.sourceStartSeq, source]));
    const sourceSpan = level === 2 ? QA_BATCH_SIZE : QA_BATCH_SIZE * QA_ROLLUP_GROUP_SIZE;
    const rollupSpan = sourceSpan * QA_ROLLUP_GROUP_SIZE;
    const maximumEnd = sources.reduce((maximum, source) => Math.max(maximum, source.sourceEndSeq), 0);
    const planned: QaPlannedRollup[] = [];
    for (let anchor = QA_HOT_TURN_COUNT + 1; anchor + rollupSpan - 1 <= maximumEnd; anchor += rollupSpan) {
      const group = Array.from(
        { length: QA_ROLLUP_GROUP_SIZE },
        (_, index) => sourceByStart.get(anchor + index * sourceSpan),
      ).filter((source): source is QaRollupSource => Boolean(source));
      if (!isContiguousRollupGroup(group)) continue;
      const sourceHash = createRollupSourceHash(level, group);
      const sourceStartSeq = group[0].sourceStartSeq;
      const sourceEndSeq = group[group.length - 1].sourceEndSeq;
      const current = existing.get(sourceStartSeq);
      if (current?.status === 'done' && current.sourceHash === sourceHash) continue;
      if (current && current.sourceHash !== sourceHash && current.status !== 'stale') {
        this.database().prepare(`
          UPDATE qa_summary_rollups SET status = 'stale', updated_at = ?
          WHERE session_id = ? AND level = ? AND source_start_seq = ?
        `).run(new Date().toISOString(), sessionId, level, sourceStartSeq);
      }
      planned.push({
        level,
        sourceStartSeq,
        sourceEndSeq,
        sourceIds: group.map((source) => source.id),
        sourceHash,
        sources: group,
      });
    }
    return planned;
  }

  upsertSummaryRollup(input: {
    sessionId: string;
    level: QaSummaryRollupLevel;
    sourceStartSeq: number;
    sourceEndSeq: number;
    sourceIds: string[];
    sourceHash: string;
    summaryText: string;
    compressor: QaSummaryCompressor;
    status?: Extract<QaSummaryRollupStatus, 'done' | 'failed'>;
  }): QaSummaryRollup {
    assertAssistantSessionId(input.sessionId);
    if (input.sourceIds.length !== QA_ROLLUP_GROUP_SIZE || new Set(input.sourceIds).size !== QA_ROLLUP_GROUP_SIZE) {
      throw new Error('问答分层摘要必须精确引用 3 个下级来源。');
    }
    if (!Number.isSafeInteger(input.sourceStartSeq) || input.sourceStartSeq < 1
      || !Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq < input.sourceStartSeq
      || !/^[a-f0-9]{64}$/u.test(input.sourceHash)) throw new Error('问答分层摘要来源范围无效。');
    const summaryText = input.summaryText.trim();
    const tokens = estimateTokenCount(summaryText);
    if (!summaryText || tokens > QA_ROLLUP_SUMMARY_MAX_TOKENS) throw new Error('问答分层摘要为空或超过 800 token 上限。');
    const database = this.database();
    const rollupId = `qa-rollup-l${input.level}-${input.sessionId}-${input.sourceStartSeq}`;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO qa_summary_rollups (
        rollup_id, session_id, level, source_start_seq, source_end_seq, source_ids_json,
        source_hash, summary_text, tokens, compressor, status, summary_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (session_id, level, source_start_seq) DO UPDATE SET
        source_end_seq = excluded.source_end_seq,
        source_ids_json = excluded.source_ids_json,
        source_hash = excluded.source_hash,
        summary_text = excluded.summary_text,
        tokens = excluded.tokens,
        compressor = excluded.compressor,
        status = excluded.status,
        summary_version = qa_summary_rollups.summary_version + 1,
        updated_at = excluded.updated_at
    `).run(
      rollupId,
      input.sessionId,
      input.level,
      input.sourceStartSeq,
      input.sourceEndSeq,
      JSON.stringify(input.sourceIds),
      input.sourceHash,
      summaryText,
      tokens,
      input.compressor,
      input.status ?? 'done',
      now,
      now,
    );
    const row = database.prepare(`
      SELECT rollup_id, level, source_start_seq, source_end_seq, source_ids_json,
        source_hash, summary_text, tokens, compressor, status, summary_version, created_at, updated_at
      FROM qa_summary_rollups WHERE session_id = ? AND level = ? AND source_start_seq = ?
    `).get(input.sessionId, input.level, input.sourceStartSeq) as SummaryRollupRow;
    return toSummaryRollup(row);
  }

  /** Bounded old-turn lexical locator used only when explicit recall is enabled. */
  searchOldTurnsLexical(
    sessionId: string,
    terms: readonly string[],
    input: { limit?: number; beforeTurnSeq?: number } = {},
  ): QaStoredTurn[] {
    assertAssistantSessionId(sessionId);
    const normalizedTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, 8);
    if (normalizedTerms.length === 0) return [];
    const limit = Math.min(24, Math.max(1, Number.isSafeInteger(input.limit) ? Number(input.limit) : 12));
    const beforeTurnSeq = Number.isSafeInteger(input.beforeTurnSeq) && Number(input.beforeTurnSeq) > 0
      ? Number(input.beforeTurnSeq)
      : Math.max(1, this.getSessionState(sessionId).lastTurnSeq - QA_HOT_TURN_COUNT + 1);
    const statuses = QA_HOT_TURN_STATUSES.map(() => '?').join(', ');
    const clauses = normalizedTerms.map(() => `(user_text LIKE ? ESCAPE '\\' OR assistant_text LIKE ? ESCAPE '\\')`).join(' OR ');
    const termParameters = normalizedTerms.flatMap((term) => {
      const escaped = `%${escapeLike(term)}%`;
      return [escaped, escaped];
    });
    const rows = this.database().prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text, scope_label, status,
        result_json, created_at, finished_at
      FROM qa_turns
      WHERE session_id = ? AND status IN (${statuses}) AND turn_seq < ? AND (${clauses})
      ORDER BY turn_seq DESC
      LIMIT ?
    `).all(sessionId, ...QA_HOT_TURN_STATUSES, beforeTurnSeq, ...termParameters, limit) as TurnRow[];
    return rows.map(toStoredTurn);
  }

  /** All memorable terminal Turns after a boundary, oldest first; Phase 0 reads only. */
  loadMemorableTurnsAfter(sessionId: string, afterTurnSeq = 0): QaStoredTurn[] {
    assertAssistantSessionId(sessionId);
    if (!Number.isSafeInteger(afterTurnSeq) || afterTurnSeq < 0) throw new Error('会话记忆边界必须是非负整数。');
    const statuses = QA_HOT_TURN_STATUSES.map(() => '?').join(', ');
    const rows = this.database().prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text, scope_label, status,
        result_json, created_at, finished_at
      FROM qa_turns
      WHERE session_id = ? AND turn_seq > ? AND status IN (${statuses})
      ORDER BY turn_seq ASC
    `).all(sessionId, afterTurnSeq, ...QA_HOT_TURN_STATUSES) as TurnRow[];
    return rows.map(toStoredTurn);
  }

  // ---------- 剩余窗口 Checkpoint（阶段 2 基础设施，尚不接管发送路径） ----------

  getConversationCheckpoint(sessionId: string): QaConversationCheckpoint | undefined {
    assertAssistantSessionId(sessionId);
    const row = this.database().prepare(`
      SELECT session_id, checkpoint_version, covered_from_seq, covered_through_seq,
        source_hash, summary_payload_json, summary_text, summary_tokens, target_tokens,
        source_tokens, compression_ratio, compressor, model_profile, created_at, updated_at
      FROM qa_memory_checkpoints WHERE session_id = ?
    `).get(sessionId) as CheckpointRow | undefined;
    return row ? toConversationCheckpoint(row) : undefined;
  }

  /**
   * 候选摘要在事务外生成；这里只做短事务 CAS。source_to 之后的新 Turn
   * 不参与冲突判定，旧 Checkpoint 或本次来源范围有变化才拒绝提交。
   */
  commitConversationCheckpointCas(input: {
    sessionId: string;
    expectedCheckpointVersion: number;
    expectedCoveredThroughSeq: number;
    sourceTurnSeqs: readonly number[];
    candidate: QaConversationCheckpointCandidate;
  }): QaCheckpointCasResult {
    assertAssistantSessionId(input.sessionId);
    assertQaConversationCheckpointCandidate(input.candidate);
    if (!Number.isSafeInteger(input.expectedCheckpointVersion) || input.expectedCheckpointVersion < 0
      || !Number.isSafeInteger(input.expectedCoveredThroughSeq) || input.expectedCoveredThroughSeq < 0
      || input.sourceTurnSeqs.length === 0
      || input.sourceTurnSeqs.some((seq, index) => !Number.isSafeInteger(seq)
        || seq <= input.expectedCoveredThroughSeq || index > 0 && seq <= input.sourceTurnSeqs[index - 1])) {
      throw new Error('Checkpoint CAS 基线或来源轮次无效。');
    }
    const payload = input.candidate.payload;
    if (payload.sessionId !== input.sessionId
      || payload.checkpointVersion !== input.expectedCheckpointVersion + 1
      || payload.coveredThroughSeq !== input.sourceTurnSeqs.at(-1)) {
      throw new Error('Checkpoint 候选与 CAS 基线不一致。');
    }

    const database = this.database();
    return database.transaction((): QaCheckpointCasResult => {
      const currentRow = database.prepare(`
        SELECT session_id, checkpoint_version, covered_from_seq, covered_through_seq,
          source_hash, summary_payload_json, summary_text, summary_tokens, target_tokens,
          source_tokens, compression_ratio, compressor, model_profile, created_at, updated_at
        FROM qa_memory_checkpoints WHERE session_id = ?
      `).get(input.sessionId) as CheckpointRow | undefined;
      const current = currentRow ? toConversationCheckpoint(currentRow) : undefined;
      if ((current?.checkpointVersion ?? 0) !== input.expectedCheckpointVersion
        || (current?.coveredThroughSeq ?? 0) !== input.expectedCoveredThroughSeq) {
        return { status: 'conflict', reason: 'base-changed', ...(current ? { current } : {}) };
      }

      const statuses = QA_HOT_TURN_STATUSES.map(() => '?').join(', ');
      const sourceRows = database.prepare(`
        SELECT turn_id, turn_seq, user_text, assistant_text, scope_label, status,
          result_json, created_at, finished_at
        FROM qa_turns
        WHERE session_id = ? AND turn_seq > ? AND turn_seq <= ? AND status IN (${statuses})
        ORDER BY turn_seq ASC
      `).all(
        input.sessionId,
        input.expectedCoveredThroughSeq,
        payload.coveredThroughSeq,
        ...QA_HOT_TURN_STATUSES,
      ) as TurnRow[];
      const sourceTurns = sourceRows.map(toStoredTurn);
      if (!sameNumbers(sourceTurns.map((turn) => turn.turnSeq), input.sourceTurnSeqs)
        || calculateQaCheckpointSourceHash({ previousCheckpoint: current, selectedTurns: sourceTurns }) !== payload.sourceHash) {
        return { status: 'conflict', reason: 'source-changed', ...(current ? { current } : {}) };
      }

      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO qa_memory_checkpoints (
          session_id, checkpoint_version, covered_from_seq, covered_through_seq,
          source_hash, summary_payload_json, summary_text, summary_tokens, target_tokens,
          source_tokens, compression_ratio, compressor, model_profile, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          checkpoint_version = excluded.checkpoint_version,
          covered_from_seq = excluded.covered_from_seq,
          covered_through_seq = excluded.covered_through_seq,
          source_hash = excluded.source_hash,
          summary_payload_json = excluded.summary_payload_json,
          summary_text = excluded.summary_text,
          summary_tokens = excluded.summary_tokens,
          target_tokens = excluded.target_tokens,
          source_tokens = excluded.source_tokens,
          compression_ratio = excluded.compression_ratio,
          compressor = excluded.compressor,
          model_profile = excluded.model_profile,
          updated_at = excluded.updated_at
      `).run(
        input.sessionId,
        payload.checkpointVersion,
        payload.coveredThroughSeq,
        payload.sourceHash,
        JSON.stringify(payload),
        input.candidate.summaryText,
        input.candidate.summaryTokens,
        input.candidate.targetTokens,
        input.candidate.sourceTokens,
        input.candidate.compressionRatio,
        payload.compressor,
        payload.modelProfile ?? null,
        now,
        now,
      );
      return { status: 'committed', checkpoint: this.getConversationCheckpoint(input.sessionId)! };
    })();
  }

  createCompactionRun(input: {
    runId: string;
    sessionId: string;
    baseCheckpointVersion: number;
    sourceFromSeq: number;
    sourceToSeq: number;
    sourceHash: string;
    sourceTokens: number;
    targetTokens: number;
  }): QaMemoryCompactionRun {
    assertAssistantSessionId(input.sessionId);
    assertCompactionRunInput(input);
    const createdAt = new Date().toISOString();
    this.database().prepare(`
      INSERT INTO qa_memory_compaction_runs (
        run_id, session_id, base_checkpoint_version, source_from_seq, source_to_seq,
        source_hash, source_tokens, target_tokens, output_tokens, status,
        error_code, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'running', NULL, ?, NULL)
    `).run(
      input.runId,
      input.sessionId,
      input.baseCheckpointVersion,
      input.sourceFromSeq,
      input.sourceToSeq,
      input.sourceHash,
      input.sourceTokens,
      input.targetTokens,
      createdAt,
    );
    return this.getCompactionRun(input.runId);
  }

  finishCompactionRun(input: {
    runId: string;
    status: Exclude<QaMemoryCompactionRunStatus, 'running'>;
    outputTokens?: number;
    errorCode?: string;
  }): QaMemoryCompactionRun {
    assertRunId(input.runId);
    if (input.outputTokens !== undefined && (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0)) {
      throw new Error('Checkpoint 审计输出 token 无效。');
    }
    if (input.errorCode !== undefined && (input.errorCode.length > 120 || /[\r\n]/u.test(input.errorCode))) {
      throw new Error('Checkpoint 审计错误码无效。');
    }
    const changes = this.database().prepare(`
      UPDATE qa_memory_compaction_runs
      SET status = ?, output_tokens = ?, error_code = ?, finished_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(
      input.status,
      input.outputTokens ?? null,
      input.errorCode ?? null,
      new Date().toISOString(),
      input.runId,
    ).changes;
    if (!changes) throw new Error('Checkpoint 压缩审计不存在或已结束。');
    return this.getCompactionRun(input.runId);
  }

  recoverInterruptedCompactionRuns(): number {
    return this.database().prepare(`
      UPDATE qa_memory_compaction_runs
      SET status = 'interrupted', error_code = COALESCE(error_code, 'APP_RESTART'), finished_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString()).changes;
  }

  listCompactionRuns(sessionId: string, limit = 50): QaMemoryCompactionRun[] {
    assertAssistantSessionId(sessionId);
    const normalizedLimit = Number.isSafeInteger(limit) ? Math.min(200, Math.max(1, limit)) : 50;
    const rows = this.database().prepare(`
      SELECT run_id, session_id, base_checkpoint_version, source_from_seq, source_to_seq,
        source_hash, source_tokens, target_tokens, output_tokens, status,
        error_code, created_at, finished_at
      FROM qa_memory_compaction_runs
      WHERE session_id = ?
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?
    `).all(sessionId, normalizedLimit) as CompactionRunRow[];
    return rows.map(toCompactionRun);
  }

  private getCompactionRun(runId: string): QaMemoryCompactionRun {
    assertRunId(runId);
    const row = this.database().prepare(`
      SELECT run_id, session_id, base_checkpoint_version, source_from_seq, source_to_seq,
        source_hash, source_tokens, target_tokens, output_tokens, status,
        error_code, created_at, finished_at
      FROM qa_memory_compaction_runs WHERE run_id = ?
    `).get(runId) as CompactionRunRow | undefined;
    if (!row) throw new Error('Checkpoint 压缩审计不存在。');
    return toCompactionRun(row);
  }

  /**
   * 写入或覆盖一个批次的摘要行（同 batch_id / 同 (session, turn_from) 唯一）。
   * 批次存在任意摘要行即可推进 summarized_through_seq（设计 §3.4 第 5 条）。
   */
  upsertSummary(input: {
    sessionId: string;
    turnFrom: number;
    turnTo: number;
    summaryText: string;
    compressor: QaSummaryCompressor;
    status: QaSummaryStatus;
    incrementRetry?: boolean;
  }): void {
    assertAssistantSessionId(input.sessionId);
    if (!isValidBatchBoundary(input.turnFrom, input.turnTo)) throw new Error('问答摘要批次边界不合法。');
    const tokens = estimateTokenCount(input.summaryText);
    if (tokens > QA_BATCH_SUMMARY_MAX_TOKENS) throw new Error('问答摘要批次超过 800 token 上限。');
    const database = this.database();
    database.transaction(() => {
      const batchId = `qa-batch-${input.sessionId}-${input.turnFrom}`;
      const now = new Date().toISOString();
      const existing = database.prepare(`
        SELECT batch_id, retry_count FROM qa_summaries WHERE session_id = ? AND turn_from = ?
      `).get(input.sessionId, input.turnFrom) as { batch_id: string; retry_count: number } | undefined;
      const retryCount = (existing?.retry_count ?? 0) + (input.incrementRetry ? 1 : 0);
      database.prepare(`
        INSERT INTO qa_summaries (
          batch_id, session_id, turn_from, turn_to, summary_text, tokens,
          compressor, status, retry_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id, turn_from) DO UPDATE SET
          turn_to = excluded.turn_to,
          summary_text = excluded.summary_text,
          tokens = excluded.tokens,
          compressor = excluded.compressor,
          status = excluded.status,
          retry_count = excluded.retry_count,
          updated_at = excluded.updated_at
      `).run(batchId, input.sessionId, input.turnFrom, input.turnTo, input.summaryText, tokens, input.compressor, input.status, retryCount, now, now);
      this.advanceSummarizedThroughLocked(database, input.sessionId, input.turnTo);
      database.prepare(`UPDATE qa_sessions SET updated_at = ? WHERE session_id = ?`).run(now, input.sessionId);
    })();
  }

  markSummaryFailed(sessionId: string, turnFrom: number): void {
    assertAssistantSessionId(sessionId);
    const database = this.database();
    database.transaction(() => {
      const existing = database.prepare(`
        SELECT summary_text, tokens, compressor FROM qa_summaries
        WHERE session_id = ? AND turn_from = ?
      `).get(sessionId, turnFrom) as { summary_text: string; tokens: number; compressor: QaSummaryCompressor } | undefined;
      const now = new Date().toISOString();
      if (existing) {
        // fallback 是可用的确定性摘要。升级失败只消耗重试次数，不能让 M1
        // 从 Prompt 中消失；只有没有可用文本的行才进入 failed。
        database.prepare(`
          UPDATE qa_summaries
          SET status = CASE WHEN compressor = 'fallback' AND summary_text != '' THEN 'done' ELSE 'failed' END,
            retry_count = retry_count + 1, updated_at = ?
          WHERE session_id = ? AND turn_from = ?
        `).run(now, sessionId, turnFrom);
        return;
      }
      // 连占位都没有时不做任何写入，批次规划会重新走 fallback 占位流程。
      void now;
    })();
  }

  /**
   * 会话开始校验（设计 §3.4 第 1 条）：边界对齐 + 不越界 + 摘要不超上限。
   * 无效行标 failed 并清零 retry，供规划器重新划批补压。
   */
  validateAndRepairSummaries(sessionId: string): void {
    assertAssistantSessionId(sessionId);
    const database = this.database();
    const state = this.getSessionState(sessionId);
    const rows = database.prepare(`
      SELECT batch_id, turn_from, turn_to, summary_text, tokens, compressor, status, retry_count
      FROM qa_summaries WHERE session_id = ?
    `).all(sessionId) as SummaryRow[];
    const maxAllowedTurnTo = Math.max(0, state.lastTurnSeq - QA_HOT_TURN_COUNT);
    database.transaction(() => {
      const invalidate = database.prepare(`
        UPDATE qa_summaries
        SET status = 'failed', compressor = 'fallback', summary_text = '', tokens = 0, retry_count = 0, updated_at = ?
        WHERE session_id = ? AND turn_from = ?
      `);
      const now = new Date().toISOString();
      for (const row of rows) {
        const invalidBoundary = !isValidBatchBoundary(row.turn_from, row.turn_to);
        const beyondWindow = row.turn_to > maxAllowedTurnTo;
        const overBudget = row.tokens > QA_BATCH_SUMMARY_MAX_TOKENS;
        if (invalidBoundary || beyondWindow || overBudget) invalidate.run(now, sessionId, row.turn_from);
      }
      // summarized_through_seq 不得越过最后一个合法批次。
      const maxThrough = database.prepare(`
        SELECT COALESCE(MAX(turn_to), 0) AS max_to FROM qa_summaries
        WHERE session_id = ? AND status = 'done' AND summary_text != ''
      `).get(sessionId) as { max_to: number };
      if (state.summarizedThroughSeq > maxThrough.max_to) {
        database.prepare(`
          UPDATE qa_sessions SET summarized_through_seq = ?, updated_at = ? WHERE session_id = ?
        `).run(maxThrough.max_to, now, sessionId);
      }
    })();
  }

  /**
   * 批次规划（设计 §3.1 / §3.4）：
   * - missing：turn_to ≤ last_seq - 6 且没有可用摘要行（含校验失败被清空的行）；
   * - upgrade：已有 fallback 占位但尚无 compressor='llm' 的完成行，且重试未耗尽。
   */
  planPendingBatches(sessionId: string): QaPlannedBatch[] {
    assertAssistantSessionId(sessionId);
    const state = this.getSessionState(sessionId);
    const maxAllowedTurnTo = state.lastTurnSeq - QA_HOT_TURN_COUNT;
    if (maxAllowedTurnTo < QA_HOT_TURN_COUNT + QA_BATCH_SIZE) return [];
    const rows = this.database().prepare(`
      SELECT turn_from, turn_to, compressor, status, retry_count, summary_text
      FROM qa_summaries WHERE session_id = ?
    `).all(sessionId) as Array<SummaryRow & { summary_text: string }>;
    const byFrom = new Map(rows.map((row) => [row.turn_from, row]));
    const planned: QaPlannedBatch[] = [];
    for (let turnFrom = QA_HOT_TURN_COUNT + 1; turnFrom + QA_BATCH_SIZE - 1 <= maxAllowedTurnTo; turnFrom += QA_BATCH_SIZE) {
      const turnTo = turnFrom + QA_BATCH_SIZE - 1;
      const row = byFrom.get(turnFrom);
      const usable = row && row.status === 'done' && row.summary_text !== '';
      if (!usable) {
        planned.push({ turnFrom, turnTo, need: 'missing' });
        continue;
      }
      if (row!.compressor !== 'llm' && row!.retry_count < QA_COMPRESSION_MAX_RETRY + 1) {
        planned.push({ turnFrom, turnTo, need: 'upgrade' });
      }
    }
    return planned;
  }

  private advanceSummarizedThroughLocked(database: Database.Database, sessionId: string, turnTo: number): void {
    database.prepare(`
      UPDATE qa_sessions
      SET summarized_through_seq = MAX(summarized_through_seq, ?)
      WHERE session_id = ?
    `).run(turnTo, sessionId);
  }

  private loadL1RollupSources(sessionId: string): QaRollupSource[] {
    return this.listSummaries(sessionId)
      .filter((summary) => summary.status === 'done' && summary.summaryText.trim())
      .map((summary) => ({
        id: summary.batchId,
        sourceStartSeq: summary.turnFrom,
        sourceEndSeq: summary.turnTo,
        text: summary.summaryText,
        version: summary.updatedAt,
      }));
  }

  private loadL2RollupSources(sessionId: string): QaRollupSource[] {
    return this.listSummaryRollups(sessionId, 2)
      .filter((rollup) => rollup.status === 'done' && rollup.summaryText.trim())
      .map((rollup) => ({
        id: rollup.rollupId,
        sourceStartSeq: rollup.sourceStartSeq,
        sourceEndSeq: rollup.sourceEndSeq,
        text: rollup.summaryText,
        version: `${rollup.sourceHash}:${rollup.summaryVersion}`,
      }));
  }

  private createSessionWithId(sessionId: string, scope: QaSessionScope, input: { title?: string; libraryPath?: string }): QaSessionSummary {
    const createdAt = new Date().toISOString();
    const libraryPath = scope === 'knowledge-base' ? input.libraryPath?.trim() || null : null;
    this.database().prepare(`
      INSERT INTO qa_sessions (
        session_id, scope, title, library_path, is_pinned, last_turn_seq, summarized_through_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(sessionId, scope, sanitizeTitle(input.title ?? '新会话'), libraryPath, createdAt, createdAt);
    return this.getSessionSummary(sessionId);
  }

  private getSessionSummary(sessionId: string): QaSessionSummary {
    const row = this.database().prepare(`
      SELECT session_id, scope, title, library_path, is_pinned, last_turn_seq, summarized_through_seq,
        created_at, updated_at,
        (SELECT COUNT(*) FROM qa_turns WHERE qa_turns.session_id = qa_sessions.session_id) AS turn_count
      FROM qa_sessions WHERE session_id = ?
    `).get(sessionId) as SessionRow | undefined;
    if (!row) throw new AssistantSessionScopeError();
    return toSessionSummary(row);
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.workspacePath);
  }
}

function toSessionSummary(row: SessionRow): QaSessionSummary {
  return {
    sessionId: row.session_id,
    scope: row.scope,
    title: row.title,
    pinned: row.is_pinned === 1,
    ...(row.library_path ? { libraryPath: row.library_path } : {}),
    turnCount: row.turn_count,
    lastTurnSeq: row.last_turn_seq,
    summarizedThroughSeq: row.summarized_through_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredTurn(row: TurnRow, usedMemories?: QaStoredTurn['usedMemories']): QaStoredTurn {
  let result: AssistantTurnResult | undefined;
  if (row.result_json && row.result_json !== '{}') {
    try {
      const parsed = JSON.parse(row.result_json) as AssistantTurnResult | Omit<Extract<AssistantTurnResult, { type: 'answer' }>, 'answer'>;
      result = parsed.type === 'answer' && row.assistant_text
        ? { ...parsed, answer: row.assistant_text } as AssistantTurnResult
        : parsed as AssistantTurnResult;
    } catch {
      result = undefined;
    }
  }
  return {
    turnId: row.turn_id,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.attempt_no ? { attemptNo: row.attempt_no } : {}),
    turnSeq: row.turn_seq,
    userText: row.user_text,
    ...(row.assistant_text ? { assistantText: row.assistant_text } : {}),
    scopeLabel: row.scope_label,
    status: row.status,
    ...(result ? { result } : {}),
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(usedMemories?.length ? { usedMemories } : {}),
  };
}

function toSummaryBlock(row: SummaryRow): QaSummaryBlock {
  return {
    batchId: row.batch_id,
    turnFrom: row.turn_from,
    turnTo: row.turn_to,
    summaryText: row.summary_text,
    tokens: row.tokens,
    compressor: row.compressor,
    status: row.status,
    retryCount: row.retry_count,
    updatedAt: row.updated_at,
  };
}

function stripAssistantTextFromResult(result: AssistantTurnResult): unknown {
  if (result.type !== 'answer') return result;
  const {
    answer: _answer,
    thinkingText: _thinkingText,
    modelEvents: _modelEvents,
    ...metadata
  } = result;
  return metadata;
}

function isCompleteTurnRow(row: TurnRow): row is TurnRow & {
  request_id: string;
  attempt_no: number;
  assistant_text: string;
  finished_at: string;
} {
  return QA_HOT_TURN_STATUSES.includes(row.status)
    && row.replaced_by_turn_id == null
    && Boolean(row.request_id?.trim())
    && Number.isSafeInteger(row.attempt_no)
    && (row.attempt_no ?? 0) >= 1
    && Boolean(row.user_text.trim())
    && Boolean(row.assistant_text?.trim())
    && Boolean(row.finished_at);
}

function toRecentCompleteTurn(
  row: TurnRow & { request_id: string; attempt_no: number; assistant_text: string; finished_at: string },
  agentMessages: QaAgentMessage[],
): QaRecentCompleteTurn {
  return {
    turnId: row.turn_id,
    requestId: row.request_id,
    attemptNo: row.attempt_no,
    turnSeq: row.turn_seq,
    userText: row.user_text,
    assistantText: stripInlineThinkBlocks(row.assistant_text),
    scopeLabel: row.scope_label,
    status: row.status as QaRecentCompleteTurn['status'],
    metadata: parseTurnMetadata(row.result_metadata_json),
    agentMessages,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function parseTurnMetadata(value: string | undefined): QaTurnMetadata {
  try {
    const parsed = JSON.parse(value || '{}') as Partial<QaTurnMetadata>;
    const route = isCanonicalRoute(parsed.route) ? parsed.route : 'chat';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.flatMap((attachment) => {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return [];
        const record = attachment as Record<string, unknown>;
        if (typeof record.attachmentId !== 'string'
          || (record.kind !== 'image' && record.kind !== 'document' && record.kind !== 'text')
          || typeof record.name !== 'string'
          || typeof record.sizeBytes !== 'number'
          || !Number.isSafeInteger(record.sizeBytes)
          || record.sizeBytes < 0) return [];
        return [{
          attachmentId: record.attachmentId,
          kind: record.kind,
          name: record.name,
          ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
          sizeBytes: record.sizeBytes,
        }];
      })
      : [];
    const memoryScope = parsed.memoryScope
      && typeof parsed.memoryScope === 'object'
      && typeof parsed.memoryScope.workspaceId === 'string'
      && parsed.memoryScope.workspaceId.trim()
      && typeof parsed.memoryScope.principalId === 'string'
      && parsed.memoryScope.principalId.trim()
      ? {
        workspaceId: parsed.memoryScope.workspaceId.trim(),
        principalId: parsed.memoryScope.principalId.trim(),
      }
      : undefined;
    return { schemaVersion: 1, route, attachments, ...(memoryScope ? { memoryScope } : {}),
      ...(Number.isSafeInteger(parsed.memoryExtractionGeneration) && parsed.memoryExtractionGeneration! >= 0
        ? { memoryExtractionGeneration: parsed.memoryExtractionGeneration } : {}),
      ...(typeof parsed.memoryExtractionAgentId === 'string' ? { memoryExtractionAgentId: parsed.memoryExtractionAgentId } : {}),
      ...(typeof parsed.memoryExtractionEligible === 'boolean' ? { memoryExtractionEligible: parsed.memoryExtractionEligible } : {}),
      ...(typeof parsed.memoryExplicitSaveEnabled === 'boolean' ? { memoryExplicitSaveEnabled: parsed.memoryExplicitSaveEnabled } : {}),
      ...(typeof parsed.memoryExplicitSavePending === 'boolean' ? { memoryExplicitSavePending: parsed.memoryExplicitSavePending } : {}),
    };
  } catch {
    return { schemaVersion: 1, route: 'chat', attachments: [] };
  }
}

function isCanonicalRoute(value: unknown): value is QaCanonicalRoute {
  return value === 'chat'
    || value === 'knowledge-base'
    || value === 'current-note-direct'
    || value === 'current-note-react';
}

function persistAgentMessages(
  database: Database.Database,
  turnId: string,
  messages: readonly QaAgentMessageInput[],
  createdAt: string,
): void {
  const insertMessage = database.prepare(`
    INSERT INTO qa_agent_messages (
      message_id, turn_id, message_seq, role, content, reasoning_content,
      tool_call_id, artifact_ref_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCall = database.prepare(`
    INSERT INTO qa_agent_tool_calls (
      call_id, message_id, call_seq, tool_name, arguments_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const [messageSeq, message] of messages.entries()) {
    const messageId = `${turnId}:agent:${messageSeq}`;
    insertMessage.run(
      messageId,
      turnId,
      messageSeq,
      message.role,
      message.content ?? '',
      message.reasoningContent ?? '',
      message.role === 'tool' ? message.toolCallId : null,
      message.artifactRef === undefined ? null : JSON.stringify(message.artifactRef),
      createdAt,
    );
    for (const [callSeq, call] of (message.toolCalls ?? []).entries()) {
      insertCall.run(call.callId, messageId, callSeq, call.toolName, JSON.stringify(call.arguments));
    }
  }
}

function loadAgentMessagesByTurn(
  database: Database.Database,
  turnIds: readonly string[],
): { messagesByTurn: Map<string, QaAgentMessage[]>; invalidTurnIds: Set<string> } {
  if (turnIds.length === 0) return { messagesByTurn: new Map(), invalidTurnIds: new Set() };
  const placeholders = turnIds.map(() => '?').join(', ');
  const messageRows = database.prepare(`
    SELECT message_id, turn_id, message_seq, role, content, reasoning_content,
      tool_call_id, artifact_ref_json, created_at
    FROM qa_agent_messages
    WHERE turn_id IN (${placeholders})
    ORDER BY turn_id ASC, message_seq ASC
  `).all(...turnIds) as AgentMessageRow[];
  const messageIds = messageRows.map((row) => row.message_id);
  const callRows = messageIds.length > 0
    ? database.prepare(`
      SELECT call_id, message_id, call_seq, tool_name, arguments_json
      FROM qa_agent_tool_calls
      WHERE message_id IN (${messageIds.map(() => '?').join(', ')})
      ORDER BY message_id ASC, call_seq ASC
    `).all(...messageIds) as AgentToolCallRow[]
    : [];
  const callsByMessage = new Map<string, QaAgentToolCall[]>();
  const turnIdByMessageId = new Map(messageRows.map((row) => [row.message_id, row.turn_id]));
  const callNameByTurnAndId = new Map<string, string>();
  const invalidTurnIds = new Set<string>();
  for (const row of callRows) {
    let argumentsValue: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.arguments_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const turnId = turnIdByMessageId.get(row.message_id);
        if (turnId) invalidTurnIds.add(turnId);
        continue;
      }
      argumentsValue = parsed as Record<string, unknown>;
    } catch {
      const turnId = turnIdByMessageId.get(row.message_id);
      if (turnId) invalidTurnIds.add(turnId);
      continue;
    }
    const call: QaAgentToolCall = {
      callId: row.call_id,
      callSeq: row.call_seq,
      toolName: row.tool_name,
      arguments: argumentsValue,
    };
    const group = callsByMessage.get(row.message_id) ?? [];
    group.push(call);
    callsByMessage.set(row.message_id, group);
    const turnId = turnIdByMessageId.get(row.message_id);
    if (turnId) callNameByTurnAndId.set(`${turnId}\0${row.call_id}`, row.tool_name);
  }
  const result = new Map<string, QaAgentMessage[]>();
  for (const row of messageRows) {
    let artifactRef: Record<string, unknown> | undefined;
    if (row.artifact_ref_json) {
      try {
        const parsed = JSON.parse(row.artifact_ref_json) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          invalidTurnIds.add(row.turn_id);
        } else {
          artifactRef = parsed as Record<string, unknown>;
        }
      } catch {
        invalidTurnIds.add(row.turn_id);
      }
    }
    const message: QaAgentMessage = {
      messageId: row.message_id,
      messageSeq: row.message_seq,
      role: row.role,
      content: row.content,
      reasoningContent: row.reasoning_content,
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
      ...(row.tool_call_id && callNameByTurnAndId.has(`${row.turn_id}\0${row.tool_call_id}`)
        ? { toolName: callNameByTurnAndId.get(`${row.turn_id}\0${row.tool_call_id}`)! }
        : {}),
      ...(artifactRef ? { artifactRef } : {}),
      toolCalls: callsByMessage.get(row.message_id) ?? [],
      createdAt: row.created_at,
    };
    const group = result.get(row.turn_id) ?? [];
    group.push(message);
    result.set(row.turn_id, group);
  }
  return { messagesByTurn: result, invalidTurnIds };
}

function toSummaryRollup(row: SummaryRollupRow): QaSummaryRollup {
  let sourceIds: string[] = [];
  try {
    const value = JSON.parse(row.source_ids_json) as unknown;
    if (Array.isArray(value)) sourceIds = value.filter((item): item is string => typeof item === 'string');
  } catch {
    sourceIds = [];
  }
  return {
    rollupId: row.rollup_id,
    level: row.level,
    sourceStartSeq: row.source_start_seq,
    sourceEndSeq: row.source_end_seq,
    sourceIds,
    sourceHash: row.source_hash,
    summaryText: row.summary_text,
    tokens: row.tokens,
    compressor: row.compressor,
    status: row.status,
    summaryVersion: row.summary_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConversationCheckpoint(row: CheckpointRow): QaConversationCheckpoint {
  let payload: QaConversationCheckpointV1;
  try {
    payload = JSON.parse(row.summary_payload_json) as QaConversationCheckpointV1;
  } catch (error) {
    throw new Error('Checkpoint payload JSON 已损坏。', { cause: error });
  }
  if (payload.schemaVersion !== 1
    || payload.sessionId !== row.session_id
    || payload.checkpointVersion !== row.checkpoint_version
    || payload.coveredFromSeq !== 1
    || payload.coveredThroughSeq !== row.covered_through_seq
    || payload.sourceHash !== row.source_hash
    || payload.summaryTokens !== row.summary_tokens
    || payload.compressor !== row.compressor) {
    throw new Error('Checkpoint payload 与数据库投影不一致。');
  }
  assertQaConversationCheckpointPayloadShape(payload);
  if (row.summary_text !== renderCheckpointForPersistenceCheck(payload)
    || estimateTokenCount(row.summary_text) !== row.summary_tokens
    || row.compression_ratio > 0.20
    || Math.abs(row.compression_ratio - row.summary_tokens / row.source_tokens) > 1e-12) {
    throw new Error('Checkpoint 文本或压缩指标与 payload 不一致。');
  }
  return {
    sessionId: row.session_id,
    checkpointVersion: row.checkpoint_version,
    coveredFromSeq: row.covered_from_seq,
    coveredThroughSeq: row.covered_through_seq,
    sourceHash: row.source_hash,
    payload,
    summaryText: row.summary_text,
    summaryTokens: row.summary_tokens,
    targetTokens: row.target_tokens,
    sourceTokens: row.source_tokens,
    compressionRatio: row.compression_ratio,
    compressor: row.compressor,
    ...(row.model_profile ? { modelProfile: row.model_profile } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function renderCheckpointForPersistenceCheck(payload: QaConversationCheckpointV1): string {
  // Keep the repository dependency surface explicit while sharing the one
  // deterministic renderer used for prompt projection and persistence checks.
  return renderQaConversationCheckpointPayload(payload);
}

function toCompactionRun(row: CompactionRunRow): QaMemoryCompactionRun {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    baseCheckpointVersion: row.base_checkpoint_version,
    sourceFromSeq: row.source_from_seq,
    sourceToSeq: row.source_to_seq,
    sourceHash: row.source_hash,
    sourceTokens: row.source_tokens,
    targetTokens: row.target_tokens,
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function isContiguousRollupGroup(group: readonly QaRollupSource[]): boolean {
  if (group.length !== QA_ROLLUP_GROUP_SIZE) return false;
  return group.every((source, index) => index === 0
    || source.sourceStartSeq === group[index - 1].sourceEndSeq + 1);
}

function createRollupSourceHash(level: QaSummaryRollupLevel, sources: readonly QaRollupSource[]): string {
  return createHash('sha256').update(JSON.stringify({
    level,
    sources: sources.map((source) => ({
      id: source.id,
      from: source.sourceStartSeq,
      to: source.sourceEndSeq,
      text: source.text,
      version: source.version,
    })),
  }), 'utf8').digest('hex');
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCompactionRunInput(input: {
  runId: string;
  baseCheckpointVersion: number;
  sourceFromSeq: number;
  sourceToSeq: number;
  sourceHash: string;
  sourceTokens: number;
  targetTokens: number;
}): void {
  assertRunId(input.runId);
  if (!Number.isSafeInteger(input.baseCheckpointVersion) || input.baseCheckpointVersion < 0
    || !Number.isSafeInteger(input.sourceFromSeq) || input.sourceFromSeq < 1
    || !Number.isSafeInteger(input.sourceToSeq) || input.sourceToSeq < input.sourceFromSeq
    || !/^[a-f0-9]{64}$/u.test(input.sourceHash)
    || !Number.isSafeInteger(input.sourceTokens) || input.sourceTokens <= 0
    || !Number.isSafeInteger(input.targetTokens) || input.targetTokens < 0) {
    throw new Error('Checkpoint 压缩审计输入无效。');
  }
}

function assertRunId(runId: string): void {
  if (!runId.trim() || runId.length > 160 || /[\r\n]/u.test(runId)) throw new Error('Checkpoint 压缩审计标识无效。');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function normalizePage(value?: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function normalizePageSize(value: number): number {
  return Number.isInteger(value) ? Math.min(MAX_PAGE_SIZE, Math.max(1, value)) : DEFAULT_PAGE_SIZE;
}

function sanitizeTitle(value: string): string {
  const title = value.replace(/\s+/gu, ' ').trim();
  if (!title) throw new Error('会话名称不能为空。');
  return title.slice(0, MAX_TITLE_CHARS);
}

function deriveTitle(userText: string): string {
  const normalized = userText.replace(/\s+/gu, ' ').trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized || '新会话';
}

function assertTurnInput(input: QaStartTurnInput): void {
  if (!input.turnId.trim() || input.turnId.length > 160) throw new Error('问答轮次标识无效。');
  if (input.requestId !== undefined && (!input.requestId.trim() || input.requestId.length > 160)) throw new Error('问答请求标识无效。');
  if (input.attemptNo !== undefined && (!Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1)) throw new Error('问答重试序号无效。');
  if (!input.userText.trim()) throw new Error('问答内容无效。');
  if (input.scopeLabel.length > 240) throw new Error('问答范围标签无效。');
}
