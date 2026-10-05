import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AssistantEvidenceCitation, CurrentNotePublicPlanEvent, CurrentNotePublicToolContentPreview, CurrentNotePublicToolEvent, LibrarySectionNavigationObservation } from './assistantTurnTypes';
import type { CurrentNoteEvidenceRecord } from './currentNoteEvidenceLedger';
import type { CurrentNoteSnapshot } from './currentNoteSnapshot';
import { readMarkdownLineRange, tokenizeCurrentNoteText } from './currentNoteStructure';
import type {
  AssistantMemoryMode,
  AssistantMemoryPage,
  AssistantMemorySettings,
  AssistantMemoryTurnFinalize,
  AssistantMemoryTurnStart,
  AssistantSearchGoalCoverage,
  AssistantSearchPlanPersistenceState,
  AssistantSessionDetail,
  AssistantSessionExport,
  AssistantSessionScope,
  AssistantSessionSummary,
  AssistantStoredTurn,
} from './assistantMemoryTypes';
import { AssistantMemoryDatabase } from './assistantMemoryDatabase';
import { AssistantSessionScopeError, assertAssistantSessionId, createAssistantSessionId } from './assistantSessionScope';
import {
  DETERMINISTIC_TURN_DIGEST_VERSION,
  HOT_TERMINAL_TURN_COUNT,
  createRollingSummaryBudgetMetadata,
  createDeterministicTurnDigest,
  emptyRollingSummaryPayload,
  mergeRollingSummaryPayload,
  parseRollingSummaryPayload,
  renderConversationMemorySummary,
  renderRollingSummary,
  assertRollingSummaryPayload,
  type RollingSummaryBudgetMetadata,
  type RollingSummaryPayload,
  type RollingSummaryState,
} from './assistantRollingSummary';
import {
  createCurrentNoteMemoryConversationMessage,
  type CurrentNoteMemoryConversationMessage,
  type NoteConversationMemoryEntry,
} from './noteConversationMemory';
import { assertValidSearchPlan } from './searchPlanValidation';
import type { SearchConflictBinding, SearchEvidenceBinding, SearchGoal, SearchPlan, SearchQueryTerm } from './searchPlanTypes';
import type { CurrentNoteSearchScope } from './currentNoteSearchScope';
import { projectPublicSearchPlan } from './publicSearchPlan';

const maxUserTextChars = 2_000;
const maxAssistantTextChars = 20_000;
const maxEvidencePreviewChars = 240;
const maxClaimsPerSession = 500;
const defaultSettings: AssistantMemorySettings = { mode: 'persistent', updatedAt: '' };

export interface AssistantNoteIdentityInput {
  libraryId: string;
  relativePath: string;
  contentHash: string;
}

type IdentityInput = AssistantNoteIdentityInput;

/** A note-only capability for P5 derived data; it deliberately has no sessionId. */
export interface AssistantNoteScope {
  libraryId: string;
  noteId: string;
}

export interface RollingSummaryCommitInput {
  expectedVersion: number;
  expectedCoveredThroughSeq: number;
  payload: RollingSummaryPayload;
}

export interface ScopedMemoryContext {
  conversation: CurrentNoteMemoryConversationMessage[];
  entries: NoteConversationMemoryEntry[];
  rollingSummary: string;
  rollingSummaryBudget: RollingSummaryBudgetMetadata;
}

interface SessionRow {
  session_id: string;
  note_id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  turn_count: number;
}

/**
 * The only module that reads or writes assistant-memory.db business data.
 * Every public conversation method is scoped to library + note + session.
 */
export class AssistantMemoryRepository {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly databaseOwner: AssistantMemoryDatabase,
    private readonly libraryPath: string,
    private readonly planPersistenceEnabled = true,
  ) {}

  getSettings(): AssistantMemorySettings {
    const database = this.database();
    const row = database.prepare(`SELECT setting_value, updated_at FROM assistant_memory_settings WHERE setting_key = 'mode'`).get() as { setting_value: string; updated_at: string } | undefined;
    if (!row || !isMode(row.setting_value)) return { ...defaultSettings };
    return { mode: row.setting_value, updatedAt: row.updated_at };
  }

  setSettings(mode: AssistantMemoryMode): AssistantMemorySettings {
    const updatedAt = now();
    this.database().prepare(`
      INSERT INTO assistant_memory_settings (setting_key, setting_value, updated_at)
      VALUES ('mode', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(mode, updatedAt);
    return { mode, updatedAt };
  }

  createSession(input: IdentityInput & { title?: string }): AssistantSessionSummary {
    const database = this.database();
    this.assertLibraryId(input.libraryId);
    const noteId = this.ensureIdentity(input);
    const sessionId = createAssistantSessionId();
    const createdAt = now();
    const title = sanitizeTitle(input.title || '新对话');
    database.transaction(() => {
      database.prepare(`
        INSERT INTO assistant_sessions (session_id, note_id, title, status, last_turn_seq, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 0, ?, ?)
      `).run(sessionId, noteId, title, createdAt, createdAt);
      database.prepare(`
        INSERT INTO assistant_memory_state (
          session_id, note_content_hash, summarized_through_seq, rolling_summary,
          unresolved_questions_json, memory_version, updated_at,
          rolling_summary_version, rolling_summary_json, rolling_summary_content_hash
        )
        VALUES (?, ?, 0, '', '[]', 1, ?, 1, ?, ?)
      `).run(
        sessionId,
        input.contentHash,
        createdAt,
        JSON.stringify(emptyRollingSummaryPayload(input.contentHash)),
        input.contentHash,
      );
    })();
    return { sessionId, title, status: 'active', turnCount: 0, createdAt, updatedAt: createdAt };
  }

  resolveScope(input: IdentityInput & { sessionId: string }): AssistantSessionScope {
    assertAssistantSessionId(input.sessionId);
    this.assertLibraryId(input.libraryId);
    const noteId = this.ensureIdentity(input);
    const row = this.database().prepare(`
      SELECT session_id FROM assistant_sessions WHERE session_id = ? AND note_id = ?
    `).get(input.sessionId, noteId) as { session_id: string } | undefined;
    if (!row) throw new AssistantSessionScopeError();
    return Object.freeze({ libraryId: input.libraryId, noteId, sessionId: input.sessionId });
  }

  resolveNoteScope(input: AssistantNoteIdentityInput): AssistantNoteScope {
    this.assertLibraryId(input.libraryId);
    return Object.freeze({ libraryId: input.libraryId, noteId: this.ensureIdentity(input) });
  }

  listSessions(input: IdentityInput & { page?: number; pageSize?: number; includeArchived?: boolean }): AssistantMemoryPage<AssistantSessionSummary> {
    this.assertLibraryId(input.libraryId);
    const noteId = this.ensureIdentity(input);
    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize, 30);
    const rows = this.database().prepare(`
      SELECT session_id, title, status, created_at, updated_at,
        (SELECT COUNT(*) FROM assistant_turns WHERE assistant_turns.session_id = assistant_sessions.session_id) AS turn_count
      FROM assistant_sessions
      WHERE note_id = ? ${input.includeArchived ? '' : "AND status = 'active'"}
      ORDER BY updated_at DESC, session_id DESC
      LIMIT ? OFFSET ?
    `).all(noteId, pageSize + 1, page * pageSize) as SessionRow[];
    const hasNext = rows.length > pageSize;
    return {
      items: rows.slice(0, pageSize).map(toSessionSummary),
      ...(hasNext ? { nextCursor: page + 1 } : {}),
    };
  }

  withScope(scope: AssistantSessionScope): ScopedAssistantMemoryRepository {
    this.assertScope(scope);
    return new ScopedAssistantMemoryRepository(this, scope);
  }

  getRollingSummary(scope: AssistantSessionScope): RollingSummaryState {
    this.assertScope(scope);
    return this.readRollingSummaryState(this.database(), scope.sessionId);
  }

  /**
   * Compacts only terminal turns outside the hot window.  This projection is
   * intentionally local and deterministic; it never invokes a model.
   */
  async compactRollingSummary(scope: AssistantSessionScope, snapshot: CurrentNoteSnapshot): Promise<RollingSummaryState> {
    return this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      return database.transaction(() => this.compactRollingSummaryInTransaction(database, scope, snapshot.contentHash, now()))();
    });
  }

  async commitRollingSummary(scope: AssistantSessionScope, snapshot: CurrentNoteSnapshot, input: RollingSummaryCommitInput): Promise<boolean> {
    assertRollingSummaryPayload(input.payload);
    if (input.payload.contentHash !== snapshot.contentHash) return false;
    return this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      return database.transaction(() => this.commitRollingSummaryInTransaction(database, scope, snapshot.contentHash, input, now()))();
    });
  }

  getSession(scope: AssistantSessionScope, page?: number, pageSize?: number): AssistantSessionDetail {
    this.assertScope(scope);
    const normalizedPage = normalizePage(page);
    const normalizedSize = normalizePageSize(pageSize, 20);
    const database = this.database();
    const session = database.prepare(`
      SELECT session_id, title, status, created_at, updated_at,
        (SELECT COUNT(*) FROM assistant_turns WHERE assistant_turns.session_id = assistant_sessions.session_id) AS turn_count
      FROM assistant_sessions WHERE session_id = ? AND note_id = ?
    `).get(scope.sessionId, scope.noteId) as SessionRow | undefined;
    if (!session) throw new AssistantSessionScopeError();
    const rows = database.prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text, context_mode, status, stop_reason, usage_json, created_at, finished_at
      FROM assistant_turns WHERE session_id = ? ORDER BY turn_seq DESC LIMIT ? OFFSET ?
    `).all(scope.sessionId, normalizedSize + 1, normalizedPage * normalizedSize) as TurnRow[];
    const state = database.prepare(`
      SELECT note_content_hash, rolling_summary, rolling_summary_version,
        summarized_through_seq, rolling_summary_json
      FROM assistant_memory_state WHERE session_id = ?
    `).get(scope.sessionId) as {
      note_content_hash: string;
      rolling_summary: string;
      rolling_summary_version: number;
      summarized_through_seq: number;
      rolling_summary_json: string;
    } | undefined;
    const summaryPayload = state
      ? parseRollingSummaryPayload(state.rolling_summary_json, state.note_content_hash, state.rolling_summary)
      : emptyRollingSummaryPayload('0'.repeat(64));
    const rollingSummary = state ? renderRollingSummary(summaryPayload) : '';
    const hasNext = rows.length > normalizedSize;
    return {
      session: toSessionSummary(session),
      rollingSummary,
      rollingSummaryVersion: state?.rolling_summary_version ?? 0,
      rollingSummaryCoveredThroughSeq: state?.summarized_through_seq ?? 0,
      rollingSummaryPayload: summaryPayload,
      turns: {
        items: rows.slice(0, normalizedSize).reverse().map((row) => this.toStoredTurn(scope, row)),
        ...(hasNext ? { nextCursor: normalizedPage + 1 } : {}),
      },
    };
  }

  archiveSession(scope: AssistantSessionScope): AssistantSessionSummary {
    this.assertScope(scope);
    const updatedAt = now();
    const changes = this.database().prepare(`UPDATE assistant_sessions SET status = 'archived', updated_at = ? WHERE session_id = ? AND note_id = ?`).run(updatedAt, scope.sessionId, scope.noteId).changes;
    if (!changes) throw new AssistantSessionScopeError();
    return this.getSession(scope).session;
  }

  deleteSession(scope: AssistantSessionScope): void {
    this.assertScope(scope);
    const changes = this.database().prepare(`DELETE FROM assistant_sessions WHERE session_id = ? AND note_id = ?`).run(scope.sessionId, scope.noteId).changes;
    if (!changes) throw new AssistantSessionScopeError();
  }

  clearNote(input: IdentityInput): number {
    this.assertLibraryId(input.libraryId);
    const noteId = this.ensureIdentity(input);
    return this.database().prepare(`DELETE FROM assistant_sessions WHERE note_id = ?`).run(noteId).changes;
  }

  async backup(destinationPath: string): Promise<void> {
    await this.databaseOwner.backup(this.libraryPath, destinationPath);
  }

  exportSession(scope: AssistantSessionScope, format: 'markdown' | 'json'): AssistantSessionExport {
    const detail = this.getSession(scope, 0, 500);
    const safeBase = detail.session.title.replace(/[<>:"/\\|?*]/gu, '-').trim().slice(0, 60) || 'assistant-session';
    if (format === 'json') {
      return {
        format,
        content: `${JSON.stringify(detail, null, 2)}\n`,
        suggestedFileName: `${safeBase}.json`,
      };
    }
    const blocks = [`# ${detail.session.title}`, '', `会话：${detail.session.sessionId}`, `创建时间：${detail.session.createdAt}`, `更新时间：${detail.session.updatedAt}`];
    for (const turn of detail.turns.items) {
      blocks.push('', `## 问题 ${turn.turnSeq}`, '', turn.userText, '', '### 回答', '', turn.assistantText || '（本轮未完成）');
      if (turn.evidence.length) {
        blocks.push('', '### 引用');
        for (const evidence of turn.evidence) blocks.push(`- [L${evidence.lineFrom}-L${evidence.lineTo}] ${evidence.headingPath.join(' / ') || '未命名段落'}：${evidence.preview}`);
      }
    }
    return { format, content: `${blocks.join('\n')}\n`, suggestedFileName: `${safeBase}.md` };
  }

  async startTurn(scope: AssistantSessionScope, input: AssistantMemoryTurnStart): Promise<{ turnId: string; turnSeq: number }> {
    assertTurnStart(input);
    return this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      const turnId = `assistant-turn-${randomUUID()}`;
      const createdAt = now();
      let turnSeq = 0;
      database.transaction(() => {
        const session = database.prepare(`SELECT last_turn_seq FROM assistant_sessions WHERE session_id = ? AND note_id = ? AND status = 'active'`).get(scope.sessionId, scope.noteId) as { last_turn_seq: number } | undefined;
        if (!session) throw new AssistantSessionScopeError();
        turnSeq = session.last_turn_seq + 1;
        database.prepare(`UPDATE assistant_sessions SET last_turn_seq = ?, updated_at = ? WHERE session_id = ? AND note_id = ?`).run(turnSeq, createdAt, scope.sessionId, scope.noteId);
        database.prepare(`
          INSERT INTO assistant_turns (turn_id, session_id, turn_seq, note_content_hash, user_text, route, context_mode, status, provider_fingerprint, model, created_at)
          SELECT ?, ?, ?, note_content_hash, ?, ?, ?, 'pending', ?, ?, ? FROM assistant_memory_state WHERE session_id = ?
        `).run(turnId, scope.sessionId, turnSeq, input.userText, input.route, input.contextMode, input.providerFingerprint, input.model, createdAt, scope.sessionId);
      })();
      return { turnId, turnSeq };
    });
  }

  /**
   * Persists the latest structured plan while a turn is still pending.  The
   * optional evidence batch is inserted first so the plan's composite
   * evidence foreign keys remain valid during incremental recovery.
   */
  async persistSearchPlan(
    scope: AssistantSessionScope,
    turnId: string,
    snapshot: CurrentNoteSnapshot,
    plan: SearchPlan,
    evidence: AssistantEvidenceCitation[] = [],
    persistence?: AssistantSearchPlanPersistenceState,
  ): Promise<void> {
    if (!this.planPersistenceEnabled) throw new Error('SearchPlan 持久化已关闭。');
    await this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      database.transaction(() => {
        const turn = database.prepare(`
          SELECT turn_id FROM assistant_turns
          WHERE session_id = ? AND turn_id = ? AND status = 'pending'
        `).get(scope.sessionId, turnId) as { turn_id: string } | undefined;
        if (!turn) throw new AssistantSessionScopeError();
        this.insertEvidenceForTurn(database, scope, turnId, snapshot, evidence);
        this.writeSearchPlan(database, scope, turnId, snapshot, plan, now(), persistence);
      })();
    });
  }

  loadSearchPlan(scope: AssistantSessionScope, turnId: string, snapshot: CurrentNoteSnapshot): SearchPlan | undefined {
    if (!this.planPersistenceEnabled) return undefined;
    this.assertScope(scope);
    const database = this.database();
    const row = database.prepare(`
      SELECT plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question,
        version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at,
        scope_mode, coverage_policy, target_topic, scope_origin, scope_confidence
      FROM assistant_search_plans
      WHERE library_id = ? AND note_id = ? AND session_id = ? AND turn_id = ?
    `).get(scope.libraryId, scope.noteId, scope.sessionId, turnId) as PlanRow | undefined;
    if (!row) return undefined;
    if (row.content_hash !== snapshot.contentHash) {
      database.transaction(() => {
        database.prepare(`
          UPDATE assistant_evidence_refs
          SET state = 'stale'
          WHERE session_id = ? AND note_id = ? AND note_content_hash <> ? AND state = 'active'
        `).run(scope.sessionId, scope.noteId, snapshot.contentHash);
        database.prepare(`
          UPDATE assistant_search_plans
          SET status = 'stale', active_goal_id = NULL, version = version + 1, updated_at = ?
          WHERE plan_id = ? AND status <> 'stale'
        `).run(now(), row.plan_id);
        database.prepare(`DELETE FROM assistant_search_goal_coverage WHERE plan_id = ?`).run(row.plan_id);
        database.prepare(`DELETE FROM assistant_search_goal_sections WHERE plan_id = ?`).run(row.plan_id);
      })();
      row.status = 'stale';
      row.active_goal_id = null;
      row.version += 1;
      row.updated_at = now();
    }
    return this.hydrateSearchPlan(database, row);
  }

  async finalizeTurn(scope: AssistantSessionScope, turnId: string, snapshot: CurrentNoteSnapshot, input: AssistantMemoryTurnFinalize): Promise<void> {
    assertTurnFinalize(input);
    await this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      const completedAt = now();
      database.transaction(() => {
        const turn = database.prepare(`SELECT turn_seq, user_text FROM assistant_turns WHERE session_id = ? AND turn_id = ? AND status = 'pending'`).get(scope.sessionId, turnId) as { turn_seq: number; user_text: string } | undefined;
        if (!turn) throw new AssistantSessionScopeError();
        const status = input.completeness;
        database.prepare(`
          UPDATE assistant_turns SET note_content_hash = ?, assistant_text = ?, context_mode = ?, status = ?, stop_reason = ?, usage_json = ?, finished_at = ?
          WHERE session_id = ? AND turn_id = ? AND status = 'pending'
        `).run(snapshot.contentHash, input.answer, input.contextMode, status, input.stopReason, JSON.stringify(input.usage), completedAt, scope.sessionId, turnId);
        this.insertEvidenceForTurn(database, scope, turnId, snapshot, input.evidence, completedAt);
        if (input.searchPlan) {
          if (!this.planPersistenceEnabled) throw new Error('SearchPlan 持久化已关闭。');
          this.writeSearchPlan(database, scope, turnId, snapshot, input.searchPlan, completedAt, input.searchScope && input.searchCoverage
            ? { searchScope: input.searchScope, searchCoverage: input.searchCoverage }
            : undefined);
        }
        if (input.evidence.length && input.completeness !== 'not-found') this.insertClaim(database, scope, turnId, turn.user_text, input.answer, input.evidence.map((evidence) => evidence.evidenceId), snapshot.contentHash, completedAt);
        this.compactRollingSummaryInTransaction(database, scope, snapshot.contentHash, completedAt);
        const title = sanitizeTitle(turn.user_text);
        database.prepare(`UPDATE assistant_sessions SET title = CASE WHEN title = '新对话' THEN ? ELSE title END, updated_at = ? WHERE session_id = ? AND note_id = ?`).run(title, completedAt, scope.sessionId, scope.noteId);
      })();
    });
  }

  async finishAbortedTurn(scope: AssistantSessionScope, turnId: string, status: 'cancelled' | 'error'): Promise<void> {
    await this.serialize(scope, () => {
      this.assertScope(scope);
      const database = this.database();
      const finishedAt = now();
      database.transaction(() => {
        const changes = database.prepare(`
          UPDATE assistant_turns SET status = ?, finished_at = ? WHERE session_id = ? AND turn_id = ? AND status = 'pending'
        `).run(status, finishedAt, scope.sessionId, turnId).changes;
        if (!changes) throw new AssistantSessionScopeError();
        if (this.planPersistenceEnabled) {
          database.prepare(`
            UPDATE assistant_search_plans
            SET status = ?, active_goal_id = NULL, version = version + 1, updated_at = ?
            WHERE session_id = ? AND turn_id = ? AND status = 'active'
          `).run(status === 'cancelled' ? 'cancelled' : 'failed', finishedAt, scope.sessionId, turnId);
        }
      })();
    });
  }

  recoverInterruptedTurns(): number {
    const database = this.database();
    const recoveredAt = now();
    return database.transaction(() => {
      const changes = database.prepare(`UPDATE assistant_turns SET status = 'interrupted', finished_at = ? WHERE status = 'pending'`).run(recoveredAt).changes;
      if (this.planPersistenceEnabled) {
        database.prepare(`
          UPDATE assistant_search_plans
          SET status = 'interrupted', active_goal_id = NULL, version = version + 1, updated_at = ?
          WHERE status = 'active'
            AND turn_id IN (SELECT turn_id FROM assistant_turns WHERE status = 'interrupted')
        `).run(recoveredAt);
      }
      return changes;
    })();
  }

  private insertEvidenceForTurn(
    database: Database.Database,
    scope: AssistantSessionScope,
    turnId: string,
    snapshot: CurrentNoteSnapshot,
    evidence: AssistantEvidenceCitation[],
    createdAt = now(),
  ): void {
    const insertEvidence = database.prepare(`
      INSERT INTO assistant_evidence_refs (session_id, evidence_id, note_id, note_content_hash, block_ids_json, heading_path_json, line_from, line_to, text_hash, preview, source_tool, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current-note-react', 'active', ?)
      ON CONFLICT(session_id, evidence_id) DO UPDATE SET
        note_content_hash = excluded.note_content_hash,
        block_ids_json = excluded.block_ids_json,
        heading_path_json = excluded.heading_path_json,
        line_from = excluded.line_from,
        line_to = excluded.line_to,
        text_hash = excluded.text_hash,
        preview = excluded.preview,
        state = 'active'
    `);
    const linkEvidence = database.prepare(`INSERT OR IGNORE INTO assistant_turn_evidence (session_id, turn_id, evidence_id) VALUES (?, ?, ?)`);
    for (const item of evidence) {
      assertCitationForSnapshot(item, snapshot);
      const blockIds = blockIdsForCitation(snapshot, item.lineFrom, item.lineTo);
      insertEvidence.run(scope.sessionId, item.evidenceId, scope.noteId, snapshot.contentHash, JSON.stringify(blockIds), JSON.stringify(item.headingPath), item.lineFrom, item.lineTo, item.quoteHash, item.preview.slice(0, maxEvidencePreviewChars), createdAt);
      linkEvidence.run(scope.sessionId, turnId, item.evidenceId);
    }
  }

  private writeSearchPlan(
    database: Database.Database,
    scope: AssistantSessionScope,
    turnId: string,
    snapshot: CurrentNoteSnapshot,
    plan: SearchPlan,
    savedAt = now(),
    persistence?: AssistantSearchPlanPersistenceState,
  ): void {
    const evidenceIds = new Set((database.prepare(`SELECT evidence_id FROM assistant_evidence_refs WHERE session_id = ?`).all(scope.sessionId) as Array<{ evidence_id: string }>).map((row) => row.evidence_id));
    const validated = assertValidSearchPlan(plan, { evidenceIds });
    const existingForTurn = database.prepare(`
      SELECT plan_id, content_hash FROM assistant_search_plans
      WHERE library_id = ? AND note_id = ? AND session_id = ? AND turn_id = ?
    `).get(scope.libraryId, scope.noteId, scope.sessionId, turnId) as { plan_id: string; content_hash: string } | undefined;
    if (existingForTurn && existingForTurn.plan_id !== validated.planId) throw new Error('同一轮次不能替换 SearchPlan。');
    const existingPlan = database.prepare(`SELECT library_id, note_id, session_id, turn_id, content_hash, created_at, scope_mode, coverage_policy, target_topic, scope_origin, scope_confidence FROM assistant_search_plans WHERE plan_id = ?`).get(validated.planId) as {
      library_id: string;
      note_id: string;
      session_id: string;
      turn_id: string;
      content_hash: string;
      created_at: string;
      scope_mode?: CurrentNoteSearchScope['mode'];
      coverage_policy?: CurrentNoteSearchScope['coveragePolicy'];
      target_topic?: string | null;
      scope_origin?: CurrentNoteSearchScope['origin'];
      scope_confidence?: CurrentNoteSearchScope['confidence'];
    } | undefined;
    if (existingPlan && (existingPlan.library_id !== scope.libraryId || existingPlan.note_id !== scope.noteId || existingPlan.session_id !== scope.sessionId || existingPlan.turn_id !== turnId)) {
      throw new Error('SearchPlan 不能跨资料库、笔记、会话或轮次复用。');
    }
    if (existingPlan && existingPlan.content_hash !== snapshot.contentHash) throw new Error('SearchPlan 内容哈希已过期。');

    const existingScopeAspects = existingPlan
      ? (database.prepare(`SELECT aspect FROM assistant_search_plan_scope_aspects WHERE plan_id = ? ORDER BY aspect_order`).all(validated.planId) as Array<{ aspect: string }>).map((item) => item.aspect)
      : [];
    const searchScope = validateSearchScope(
      persistence?.searchScope
      ?? (isSearchPlanWithScope(plan) ? plan.scope : undefined)
      ?? (existingPlan?.scope_mode ? {
        mode: existingPlan.scope_mode,
        coveragePolicy: existingPlan.coverage_policy ?? 'sufficient',
        ...(existingPlan.target_topic ? { targetTopic: existingPlan.target_topic } : {}),
        targetAspects: existingScopeAspects,
        origin: existingPlan.scope_origin ?? 'controller-fallback',
        confidence: existingPlan.scope_confidence ?? 'low',
      } : undefined)
      ?? fallbackSearchScope(),
    );
    const coverage = persistence?.searchCoverage ?? (isSearchPlanWithCoverage(plan) ? plan.coverage : undefined);
    if (coverage) validateSearchCoverage(coverage, validated, snapshot, searchScope);

    database.prepare(`
      INSERT INTO assistant_search_plans (
        plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question,
        version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at,
        scope_mode, coverage_policy, target_topic, scope_origin, scope_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        original_question = excluded.original_question,
        version = excluded.version,
        active_goal_id = excluded.active_goal_id,
        status = excluded.status,
        revision_count = excluded.revision_count,
        goal_update_count = excluded.goal_update_count,
        scope_mode = excluded.scope_mode,
        coverage_policy = excluded.coverage_policy,
        target_topic = excluded.target_topic,
        scope_origin = excluded.scope_origin,
        scope_confidence = excluded.scope_confidence,
        updated_at = excluded.updated_at
    `).run(
      validated.planId,
      scope.libraryId,
      scope.noteId,
      scope.sessionId,
      turnId,
      existingPlan?.content_hash ?? snapshot.contentHash,
      validated.originalQuestion,
      validated.version,
      validated.activeGoalId,
      validated.status,
      validated.revisionCount,
      validated.goalUpdateCount,
      existingPlan?.created_at ?? validated.createdAt,
      savedAt || validated.updatedAt,
      searchScope.mode,
      searchScope.coveragePolicy,
      searchScope.targetTopic ?? null,
      searchScope.origin,
      searchScope.confidence,
    );
    if (coverage) {
      database.prepare(`DELETE FROM assistant_search_goal_sections WHERE plan_id = ?`).run(validated.planId);
      database.prepare(`DELETE FROM assistant_search_goal_coverage WHERE plan_id = ?`).run(validated.planId);
    }
    database.prepare(`DELETE FROM assistant_search_plan_scope_aspects WHERE plan_id = ?`).run(validated.planId);
    const insertScopeAspect = database.prepare(`
      INSERT INTO assistant_search_plan_scope_aspects (plan_id, aspect_order, aspect)
      VALUES (?, ?, ?)
    `);
    searchScope.targetAspects.forEach((aspect, aspectOrder) => insertScopeAspect.run(validated.planId, aspectOrder, aspect));
    database.prepare(`DELETE FROM assistant_search_plan_evidence WHERE plan_id = ?`).run(validated.planId);
    database.prepare(`DELETE FROM assistant_search_plan_query_terms WHERE plan_id = ?`).run(validated.planId);
    database.prepare(`DELETE FROM assistant_search_plan_requirements WHERE plan_id = ?`).run(validated.planId);
    database.prepare(`DELETE FROM assistant_search_plan_goals WHERE plan_id = ?`).run(validated.planId);

    const insertGoal = database.prepare(`
      INSERT INTO assistant_search_plan_goals (plan_id, goal_id, goal_order, question, evidence_kind, status, missing_evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRequirement = database.prepare(`
      INSERT INTO assistant_search_plan_requirements (plan_id, goal_id, requirement_id, requirement_order, label, subject, min_evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTerm = database.prepare(`
      INSERT INTO assistant_search_plan_query_terms (plan_id, goal_id, term_order, term, source)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertEvidence = database.prepare(`
      INSERT INTO assistant_search_plan_evidence (plan_id, goal_id, requirement_id, session_id, evidence_id, side)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    validated.goals.forEach((goal, goalOrder) => {
      insertGoal.run(validated.planId, goal.goalId, goalOrder, goal.question, goal.evidenceKind, goal.status, goal.missingEvidence ?? null);
      goal.requirements.forEach((requirement, requirementOrder) => {
        insertRequirement.run(validated.planId, goal.goalId, requirement.requirementId, requirementOrder, requirement.label, requirement.subject ?? null, requirement.minEvidence);
      });
      goal.queryTerms.forEach((queryTerm, termOrder) => insertTerm.run(validated.planId, goal.goalId, termOrder, queryTerm.term, queryTerm.source));
      for (const binding of goal.evidenceBindings) {
        for (const evidenceId of binding.evidenceIds) insertEvidence.run(validated.planId, goal.goalId, binding.requirementId, scope.sessionId, evidenceId, 'ordinary');
      }
      for (const binding of goal.conflictBindings) {
        for (const evidenceId of binding.supportsEvidenceIds) insertEvidence.run(validated.planId, goal.goalId, binding.requirementId, scope.sessionId, evidenceId, 'supports');
        for (const evidenceId of binding.contradictsEvidenceIds) insertEvidence.run(validated.planId, goal.goalId, binding.requirementId, scope.sessionId, evidenceId, 'contradicts');
      }
    });
    if (coverage) {
      const insertCoverage = database.prepare(`
        INSERT INTO assistant_search_goal_coverage (
          plan_id, goal_id, snapshot_id, content_hash, query_fingerprint,
          matched_block_count, matched_heading_count, read_heading_count, covered_aspect_count,
          target_aspect_count, candidate_exhausted, candidate_truncated,
          next_search_cursor, covered_aspects_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertSection = database.prepare(`
        INSERT INTO assistant_search_goal_sections (plan_id, goal_id, heading_id, state, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of coverage) {
        insertCoverage.run(
          validated.planId,
          item.goalId,
          item.snapshotId,
          item.contentHash,
          item.queryFingerprint,
          item.matchedBlockCount,
          item.matchedHeadingCount,
          item.readHeadingCount,
          item.coveredAspectCount,
          item.targetAspectCount,
          item.candidateExhausted ? 1 : 0,
          item.candidateTruncated ? 1 : 0,
          item.nextSearchCursor ?? null,
          JSON.stringify(item.coveredAspects),
          savedAt,
        );
        for (const headingId of item.discoveredHeadingIds) insertSection.run(validated.planId, item.goalId, headingId, 'discovered', item.contentHash, savedAt);
        for (const headingId of item.readHeadingIds) insertSection.run(validated.planId, item.goalId, headingId, 'read', item.contentHash, savedAt);
      }
    }
  }

  private hydrateSearchPlan(database: Database.Database, row: PlanRow): SearchPlan {
    const goals = database.prepare(`
      SELECT goal_id, goal_order, question, evidence_kind, status, missing_evidence
      FROM assistant_search_plan_goals WHERE plan_id = ? ORDER BY goal_order
    `).all(row.plan_id) as PlanGoalRow[];
    const requirements = database.prepare(`
      SELECT goal_id, requirement_id, requirement_order, label, subject, min_evidence
      FROM assistant_search_plan_requirements WHERE plan_id = ? ORDER BY goal_id, requirement_order
    `).all(row.plan_id) as PlanRequirementRow[];
    const terms = database.prepare(`
      SELECT goal_id, term_order, term, source
      FROM assistant_search_plan_query_terms WHERE plan_id = ? ORDER BY goal_id, term_order
    `).all(row.plan_id) as PlanTermRow[];
    const bindings = database.prepare(`
      SELECT goal_id, requirement_id, evidence_id, side
      FROM assistant_search_plan_evidence WHERE plan_id = ? ORDER BY goal_id, requirement_id, side, evidence_id
    `).all(row.plan_id) as PlanEvidenceRow[];
    const scopeAspects = database.prepare(`
      SELECT aspect_order, aspect FROM assistant_search_plan_scope_aspects
      WHERE plan_id = ? ORDER BY aspect_order
    `).all(row.plan_id) as Array<{ aspect_order: number; aspect: string }>;
    const coverageRows = database.prepare(`
      SELECT goal_id, snapshot_id, content_hash, query_fingerprint,
        matched_block_count, matched_heading_count, read_heading_count,
        covered_aspect_count, target_aspect_count, candidate_exhausted,
        candidate_truncated, next_search_cursor, covered_aspects_json
      FROM assistant_search_goal_coverage WHERE plan_id = ? ORDER BY goal_id
    `).all(row.plan_id) as CoverageRow[];
    const sectionRows = database.prepare(`
      SELECT goal_id, heading_id, state FROM assistant_search_goal_sections
      WHERE plan_id = ? ORDER BY goal_id, heading_id, state
    `).all(row.plan_id) as SectionRow[];
    const evidenceIds = new Set((database.prepare(`SELECT evidence_id FROM assistant_evidence_refs WHERE session_id = ?`).all(row.session_id) as Array<{ evidence_id: string }>).map((item) => item.evidence_id));
    const plan: SearchPlan = {
      planId: row.plan_id,
      version: row.version,
      originalQuestion: row.original_question,
      goals: goals.map((goal) => {
        const goalRequirements = requirements.filter((requirement) => requirement.goal_id === goal.goal_id).map((requirement) => ({
          requirementId: requirement.requirement_id,
          label: requirement.label,
          ...(requirement.subject === null ? {} : { subject: requirement.subject }),
          minEvidence: requirement.min_evidence,
        }));
        const goalBindings = bindings.filter((binding) => binding.goal_id === goal.goal_id);
        const requirementIds = new Set(goalRequirements.map((requirement) => requirement.requirementId));
        const evidenceBindings: SearchEvidenceBinding[] = [];
        const conflictBindings: SearchConflictBinding[] = [];
        for (const requirementId of requirementIds) {
          const ordinary = goalBindings.filter((binding) => binding.requirement_id === requirementId && binding.side === 'ordinary').map((binding) => binding.evidence_id);
          if (ordinary.length) evidenceBindings.push({ requirementId, evidenceIds: ordinary });
          const supports = goalBindings.filter((binding) => binding.requirement_id === requirementId && binding.side === 'supports').map((binding) => binding.evidence_id);
          const contradicts = goalBindings.filter((binding) => binding.requirement_id === requirementId && binding.side === 'contradicts').map((binding) => binding.evidence_id);
          if (supports.length || contradicts.length) conflictBindings.push({ requirementId, supportsEvidenceIds: supports, contradictsEvidenceIds: contradicts });
        }
        return {
          goalId: goal.goal_id,
          question: goal.question,
          evidenceKind: goal.evidence_kind,
          requirements: goalRequirements,
          queryTerms: terms.filter((term) => term.goal_id === goal.goal_id).map((term) => ({ term: term.term, source: term.source })),
          status: goal.status,
          evidenceBindings,
          conflictBindings,
          ...(goal.missing_evidence === null ? {} : { missingEvidence: goal.missing_evidence }),
        };
      }),
      activeGoalId: row.active_goal_id,
      status: row.status,
      revisionCount: row.revision_count,
      goalUpdateCount: row.goal_update_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const validated = assertValidSearchPlan(plan, { evidenceIds });
    const searchScope: CurrentNoteSearchScope = {
      mode: row.scope_mode ?? 'focused',
      coveragePolicy: row.coverage_policy ?? 'sufficient',
      ...(row.target_topic ? { targetTopic: row.target_topic } : {}),
      targetAspects: scopeAspects.map((item) => item.aspect),
      origin: row.scope_origin ?? 'controller-fallback',
      confidence: row.scope_confidence ?? 'low',
    };
    const searchCoverage = coverageRows.map((coverage) => {
      const sections = sectionRows.filter((section) => section.goal_id === coverage.goal_id);
      const discoveredHeadingIds = sections.filter((section) => section.state === 'discovered').map((section) => section.heading_id);
      const readHeadingIds = sections.filter((section) => section.state === 'read').map((section) => section.heading_id);
      const coveredAspects = parseStringArray(coverage.covered_aspects_json);
      return {
        goalId: coverage.goal_id,
        snapshotId: coverage.snapshot_id,
        contentHash: coverage.content_hash,
        queryFingerprint: coverage.query_fingerprint,
        matchedBlockCount: coverage.matched_block_count,
        matchedHeadingCount: coverage.matched_heading_count,
        readHeadingCount: coverage.read_heading_count,
        coveredAspectCount: coverage.covered_aspect_count,
        targetAspectCount: coverage.target_aspect_count,
        discoveredHeadingIds,
        readHeadingIds,
        coveredAspects,
        missingAspects: searchScope.targetAspects.filter((aspect) => !coveredAspects.includes(aspect)),
        candidateExhausted: coverage.candidate_exhausted === 1,
        candidateTruncated: coverage.candidate_truncated === 1,
        ...(coverage.next_search_cursor ? { nextSearchCursor: coverage.next_search_cursor } : {}),
      } satisfies AssistantSearchGoalCoverage;
    });
    Object.defineProperties(validated, {
      scope: { value: searchScope, enumerable: false, writable: false, configurable: false },
      coverage: { value: searchCoverage, enumerable: false, writable: false, configurable: false },
    });
    return validated;
  }

  loadContext(scope: AssistantSessionScope, snapshot: CurrentNoteSnapshot): ScopedMemoryContext {
    this.assertScope(scope);
    const database = this.database();
    database.transaction(() => {
      database.prepare(`UPDATE assistant_evidence_refs SET state = 'stale' WHERE session_id = ? AND note_content_hash <> ? AND state = 'active'`).run(scope.sessionId, snapshot.contentHash);
      database.prepare(`UPDATE assistant_claims SET state = 'stale' WHERE session_id = ? AND note_content_hash <> ? AND state = 'active'`).run(scope.sessionId, snapshot.contentHash);
      database.prepare(`UPDATE assistant_turn_digests SET state = 'stale' WHERE session_id = ? AND note_content_hash <> ? AND state = 'active'`).run(scope.sessionId, snapshot.contentHash);
      database.prepare(`
        UPDATE assistant_search_plans
        SET status = 'stale', active_goal_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND content_hash <> ? AND status <> 'stale'
      `).run(now(), scope.sessionId, snapshot.contentHash);
      database.prepare(`
        DELETE FROM assistant_search_goal_coverage
        WHERE plan_id IN (
          SELECT plan_id FROM assistant_search_plans
          WHERE session_id = ? AND content_hash <> ?
        )
      `).run(scope.sessionId, snapshot.contentHash);
      database.prepare(`
        DELETE FROM assistant_search_goal_sections
        WHERE plan_id IN (
          SELECT plan_id FROM assistant_search_plans
          WHERE session_id = ? AND content_hash <> ?
        )
      `).run(scope.sessionId, snapshot.contentHash);
      const state = database.prepare(`
        SELECT note_content_hash, rolling_summary_version
        FROM assistant_memory_state WHERE session_id = ?
      `).get(scope.sessionId) as { note_content_hash: string; rolling_summary_version: number } | undefined;
      if (state && state.note_content_hash !== snapshot.contentHash) {
        const payload = emptyRollingSummaryPayload(snapshot.contentHash);
        database.prepare(`
          UPDATE assistant_memory_state
          SET note_content_hash = ?, summarized_through_seq = 0, rolling_summary = '',
            unresolved_questions_json = '[]', memory_version = memory_version + 1,
            rolling_summary_version = ?, rolling_summary_json = ?, rolling_summary_content_hash = ?, updated_at = ?
          WHERE session_id = ? AND note_content_hash <> ?
        `).run(
          snapshot.contentHash,
          state.rolling_summary_version + 1,
          JSON.stringify(payload),
          snapshot.contentHash,
          now(),
          scope.sessionId,
          snapshot.contentHash,
        );
      }
    })();
    const memoryState = database.prepare(`
      SELECT note_content_hash, rolling_summary, rolling_summary_json,
        rolling_summary_version, summarized_through_seq
      FROM assistant_memory_state WHERE session_id = ?
    `).get(scope.sessionId) as {
      note_content_hash: string;
      rolling_summary: string;
      rolling_summary_json: string;
      rolling_summary_version: number;
      summarized_through_seq: number;
    } | undefined;
    const summaryPayload = memoryState?.note_content_hash === snapshot.contentHash
      ? parseRollingSummaryPayload(memoryState.rolling_summary_json, snapshot.contentHash, memoryState.rolling_summary)
      : emptyRollingSummaryPayload(snapshot.contentHash);
    const rollingSummary = renderConversationMemorySummary(summaryPayload);
    const turnRows = database.prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text,
        COALESCE(finished_at, created_at) AS source_version
      FROM assistant_turns
      WHERE session_id = ? AND note_content_hash = ? AND status IN ('complete', 'partial', 'not-found')
      ORDER BY turn_seq DESC LIMIT 3
    `).all(scope.sessionId, snapshot.contentHash) as Array<{
      turn_id: string;
      turn_seq: number;
      user_text: string;
      assistant_text: string | null;
      source_version: string;
    }>;
    const conversation: CurrentNoteMemoryConversationMessage[] = [
      ...(rollingSummary ? [createCurrentNoteMemoryConversationMessage(
        { role: 'assistant', content: `会话摘要：${rollingSummary}` },
        {
          zone: 'conversation-summary',
          sourceId: `rolling-summary:${scope.sessionId}`,
          sourceVersion: String(memoryState?.rolling_summary_version ?? 0),
          contentHash: snapshot.contentHash,
        },
      )] : []),
      ...turnRows.reverse().flatMap((turn) => {
        const memory = {
          zone: 'conversation-hot' as const,
          sourceId: turn.turn_id,
          sourceVersion: turn.source_version,
          contentHash: snapshot.contentHash,
          turnId: turn.turn_id,
          turnSeq: turn.turn_seq,
        };
        return [
          createCurrentNoteMemoryConversationMessage({ role: 'user', content: turn.user_text }, memory),
          ...(turn.assistant_text
            ? [createCurrentNoteMemoryConversationMessage({ role: 'assistant', content: turn.assistant_text }, memory)]
            : []),
        ];
      }),
    ];
    return {
      conversation,
      entries: this.loadMemoryEntries(scope, snapshot),
      rollingSummary,
      rollingSummaryBudget: createRollingSummaryBudgetMetadata(rollingSummary),
    };
  }

  private loadMemoryEntries(scope: AssistantSessionScope, snapshot: CurrentNoteSnapshot): NoteConversationMemoryEntry[] {
    const database = this.database();
    const turnRows = database.prepare(`
      SELECT turn_id, user_text, assistant_text FROM assistant_turns
      WHERE session_id = ? AND note_content_hash = ? AND status = 'complete'
      ORDER BY turn_seq DESC LIMIT 12
    `).all(scope.sessionId, snapshot.contentHash) as Array<{ turn_id: string; user_text: string; assistant_text: string | null }>;
    const result: NoteConversationMemoryEntry[] = [];
    for (const turn of turnRows.reverse()) {
      const evidenceRows = database.prepare(`
        SELECT evidence.evidence_id, evidence.block_ids_json, evidence.heading_path_json, evidence.line_from, evidence.line_to, evidence.text_hash
        FROM assistant_turn_evidence link
        JOIN assistant_evidence_refs evidence ON evidence.session_id = link.session_id AND evidence.evidence_id = link.evidence_id
        WHERE link.session_id = ? AND link.turn_id = ? AND evidence.note_content_hash = ? AND evidence.state = 'active'
        ORDER BY evidence.line_from, evidence.line_to
      `).all(scope.sessionId, turn.turn_id, snapshot.contentHash) as EvidenceRow[];
      const evidence = evidenceRows.flatMap((row) => this.hydrateEvidence(scope, snapshot, row, turn.user_text));
      if (evidence.length) {
        result.push({
          contentHash: snapshot.contentHash,
          questionTerms: meaningfulTerms(turn.user_text),
          evidence,
          answer: turn.assistant_text ?? '',
          completeness: 'complete',
        });
      }
    }
    return result;
  }

  private hydrateEvidence(scope: AssistantSessionScope, snapshot: CurrentNoteSnapshot, row: EvidenceRow, question: string): CurrentNoteEvidenceRecord[] {
    const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, row.line_from, row.line_to);
    if (sha256(text) !== row.text_hash) {
      this.database().prepare(`UPDATE assistant_evidence_refs SET state = 'stale' WHERE session_id = ? AND evidence_id = ?`).run(scope.sessionId, row.evidence_id);
      return [];
    }
    const blockIds = parseStringArray(row.block_ids_json);
    const headingPath = parseStringArray(row.heading_path_json);
    return [{
      evidenceId: row.evidence_id,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      blockIds,
      headingPath,
      lineFrom: row.line_from,
      lineTo: row.line_to,
      text,
      textHash: row.text_hash,
      matchedTerms: [],
      supports: [question],
      sourceToolCallId: 'persistent-memory',
    }];
  }

  private insertClaim(database: Database.Database, scope: AssistantSessionScope, turnId: string, userText: string, answer: string, evidenceIds: string[], contentHash: string, createdAt: string): void {
    const activeClaims = Number((database.prepare(`SELECT COUNT(*) AS count FROM assistant_claims WHERE session_id = ? AND state = 'active'`).get(scope.sessionId) as { count: number }).count);
    if (activeClaims >= maxClaimsPerSession) return;
    const normalizedKey = meaningfulTerms(userText).join('\u001f') || sha256(userText.trim()).slice(0, 24);
    const previous = database.prepare(`
      SELECT claim_id, revision FROM assistant_claims WHERE session_id = ? AND normalized_key = ? ORDER BY revision DESC LIMIT 1
    `).get(scope.sessionId, normalizedKey) as { claim_id: string; revision: number } | undefined;
    if (previous) database.prepare(`UPDATE assistant_claims SET state = 'superseded' WHERE session_id = ? AND claim_id = ?`).run(scope.sessionId, previous.claim_id);
    const claimId = `assistant-claim-${randomUUID()}`;
    database.prepare(`
      INSERT INTO assistant_claims (claim_id, session_id, source_turn_id, note_content_hash, normalized_key, claim_text, state, revision, supersedes_claim_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(claimId, scope.sessionId, turnId, contentHash, normalizedKey, answer.slice(0, 4_000), (previous?.revision ?? 0) + 1, previous?.claim_id ?? null, createdAt);
    const linkEvidence = database.prepare(`INSERT OR IGNORE INTO assistant_claim_evidence (session_id, claim_id, evidence_id) VALUES (?, ?, ?)`);
    for (const evidenceId of evidenceIds) linkEvidence.run(scope.sessionId, claimId, evidenceId);
  }

  private readRollingSummaryState(database: Database.Database, sessionId: string): RollingSummaryState {
    const row = database.prepare(`
      SELECT note_content_hash, rolling_summary_version, summarized_through_seq,
        rolling_summary, rolling_summary_json
      FROM assistant_memory_state WHERE session_id = ?
    `).get(sessionId) as {
      note_content_hash: string;
      rolling_summary_version: number;
      summarized_through_seq: number;
      rolling_summary: string;
      rolling_summary_json: string;
    } | undefined;
    const contentHash = row?.note_content_hash?.trim() || '0'.repeat(64);
    const payload = row
      ? parseRollingSummaryPayload(row.rolling_summary_json, contentHash, row.rolling_summary)
      : emptyRollingSummaryPayload(contentHash);
    const rendered = renderRollingSummary(payload);
    return {
      version: row?.rolling_summary_version ?? 0,
      contentHash: payload.contentHash,
      coveredThroughSeq: row?.summarized_through_seq ?? payload.coveredThroughSeq,
      payload,
      rendered,
      budget: createRollingSummaryBudgetMetadata(rendered),
    };
  }

  private compactRollingSummaryInTransaction(database: Database.Database, scope: AssistantSessionScope, contentHash: string, updatedAt: string): RollingSummaryState {
    const state = database.prepare(`
      SELECT note_content_hash, rolling_summary_version, summarized_through_seq,
        rolling_summary, rolling_summary_json
      FROM assistant_memory_state WHERE session_id = ?
    `).get(scope.sessionId) as {
      note_content_hash: string;
      rolling_summary_version: number;
      summarized_through_seq: number;
      rolling_summary: string;
      rolling_summary_json: string;
    } | undefined;
    if (!state) throw new AssistantSessionScopeError();
    if (state.note_content_hash !== contentHash) {
      database.prepare(`UPDATE assistant_turn_digests SET state = 'stale' WHERE session_id = ? AND note_content_hash <> ? AND state = 'active'`).run(scope.sessionId, contentHash);
      database.prepare(`
        UPDATE assistant_search_plans
        SET status = 'stale', active_goal_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND content_hash <> ? AND status <> 'stale'
      `).run(updatedAt, scope.sessionId, contentHash);
      database.prepare(`
        DELETE FROM assistant_search_goal_coverage
        WHERE plan_id IN (
          SELECT plan_id FROM assistant_search_plans
          WHERE session_id = ? AND content_hash <> ?
        )
      `).run(scope.sessionId, contentHash);
      database.prepare(`
        DELETE FROM assistant_search_goal_sections
        WHERE plan_id IN (
          SELECT plan_id FROM assistant_search_plans
          WHERE session_id = ? AND content_hash <> ?
        )
      `).run(scope.sessionId, contentHash);
      const payload = emptyRollingSummaryPayload(contentHash);
      database.prepare(`
        UPDATE assistant_memory_state
        SET note_content_hash = ?, summarized_through_seq = 0, rolling_summary = '',
          unresolved_questions_json = '[]', memory_version = memory_version + 1,
          rolling_summary_version = rolling_summary_version + 1,
          rolling_summary_json = ?, rolling_summary_content_hash = ?, updated_at = ?
        WHERE session_id = ? AND note_content_hash <> ?
      `).run(contentHash, JSON.stringify(payload), contentHash, updatedAt, scope.sessionId, contentHash);
      return this.readRollingSummaryState(database, scope.sessionId);
    }

    const payload = parseRollingSummaryPayload(state.rolling_summary_json, contentHash, state.rolling_summary);
    const terminalRows = database.prepare(`
      SELECT turn_id, turn_seq, user_text, assistant_text, status, note_content_hash
      FROM assistant_turns
      WHERE session_id = ? AND note_content_hash = ?
        AND status IN ('complete', 'partial', 'not-found')
      ORDER BY turn_seq ASC
    `).all(scope.sessionId, contentHash) as DigestTurnRow[];
    const coldRows = terminalRows
      .slice(0, Math.max(0, terminalRows.length - HOT_TERMINAL_TURN_COUNT))
      .filter((turn) => turn.turn_seq > state.summarized_through_seq)
      .filter((turn) => {
        if (!this.planPersistenceEnabled) return true;
        const plan = database.prepare(`
          SELECT status FROM assistant_search_plans
          WHERE library_id = ? AND note_id = ? AND session_id = ? AND turn_id = ?
        `).get(scope.libraryId, scope.noteId, scope.sessionId, turn.turn_id) as { status: SearchPlan['status'] } | undefined;
        return !plan || plan.status !== 'active';
      })
      .filter((turn) => !database.prepare(`
        SELECT 1 FROM assistant_turn_digests
        WHERE session_id = ? AND turn_id = ? AND digest_version = ?
          AND note_content_hash = ? AND state = 'active'
      `).get(scope.sessionId, turn.turn_id, DETERMINISTIC_TURN_DIGEST_VERSION, contentHash));
    if (!coldRows.length) return this.readRollingSummaryState(database, scope.sessionId);

    const digests = coldRows.map((turn) => {
      const evidenceIds = database.prepare(`
        SELECT evidence_id FROM assistant_turn_evidence
        WHERE session_id = ? AND turn_id = ? ORDER BY evidence_id
      `).all(scope.sessionId, turn.turn_id) as Array<{ evidence_id: string }>;
      const planRow = this.planPersistenceEnabled
        ? database.prepare(`
          SELECT plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question,
            version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at,
            scope_mode, coverage_policy, target_topic, scope_origin, scope_confidence
          FROM assistant_search_plans
          WHERE library_id = ? AND note_id = ? AND session_id = ? AND turn_id = ?
        `).get(scope.libraryId, scope.noteId, scope.sessionId, turn.turn_id) as PlanRow | undefined
        : undefined;
      return createDeterministicTurnDigest({
        turnId: turn.turn_id,
        turnSeq: turn.turn_seq,
        contentHash,
        question: turn.user_text,
        answer: turn.assistant_text || '（本轮未生成回答）',
        status: turn.status,
        evidenceIds: evidenceIds.map((evidence) => evidence.evidence_id),
        ...(planRow ? { plan: this.hydrateSearchPlan(database, planRow) } : {}),
      });
    });
    const nextPayload = mergeRollingSummaryPayload(payload, contentHash, digests);
    this.commitRollingSummaryInTransaction(database, scope, contentHash, {
      expectedVersion: state.rolling_summary_version,
      expectedCoveredThroughSeq: state.summarized_through_seq,
      payload: nextPayload,
    }, updatedAt);
    return this.readRollingSummaryState(database, scope.sessionId);
  }

  private commitRollingSummaryInTransaction(
    database: Database.Database,
    scope: AssistantSessionScope,
    contentHash: string,
    input: RollingSummaryCommitInput,
    updatedAt: string,
  ): boolean {
    const state = database.prepare(`
      SELECT note_content_hash, rolling_summary_version, summarized_through_seq
      FROM assistant_memory_state WHERE session_id = ?
    `).get(scope.sessionId) as { note_content_hash: string; rolling_summary_version: number; summarized_through_seq: number } | undefined;
    if (!state || state.note_content_hash !== contentHash
      || state.rolling_summary_version !== input.expectedVersion
      || state.summarized_through_seq !== input.expectedCoveredThroughSeq) return false;
    for (const digest of input.payload.turnDigests) {
      const turn = database.prepare(`
        SELECT note_content_hash FROM assistant_turns
        WHERE session_id = ? AND turn_id = ?
      `).get(scope.sessionId, digest.turnId) as { note_content_hash: string } | undefined;
      if (!turn || turn.note_content_hash !== contentHash) throw new AssistantSessionScopeError();
      if (digest.planOutcome) {
        const plan = database.prepare(`
          SELECT version, status FROM assistant_search_plans
          WHERE plan_id = ? AND session_id = ?
        `).get(digest.planOutcome.planId, scope.sessionId) as { version: number; status: SearchPlan['status'] } | undefined;
        if (!plan) throw new AssistantSessionScopeError();
      }
    }
    const nextVersion = state.rolling_summary_version + 1;
    const rendered = renderRollingSummary(input.payload);
    const changes = database.prepare(`
      UPDATE assistant_memory_state
      SET note_content_hash = ?, summarized_through_seq = ?, rolling_summary = ?,
        unresolved_questions_json = ?, memory_version = memory_version + 1,
        rolling_summary_version = ?, rolling_summary_json = ?, rolling_summary_content_hash = ?, updated_at = ?
      WHERE session_id = ? AND note_content_hash = ?
        AND rolling_summary_version = ? AND summarized_through_seq = ?
    `).run(
      contentHash,
      input.payload.coveredThroughSeq,
      rendered,
      JSON.stringify(input.payload.unresolvedQuestions),
      nextVersion,
      JSON.stringify(input.payload),
      contentHash,
      updatedAt,
      scope.sessionId,
      contentHash,
      input.expectedVersion,
      input.expectedCoveredThroughSeq,
    ).changes;
    if (changes !== 1) return false;
    const insertDigest = database.prepare(`
      INSERT INTO assistant_turn_digests (
        digest_id, session_id, turn_id, turn_seq, note_content_hash, digest_version,
        digest_json, plan_id, plan_version, plan_status, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(session_id, turn_id, digest_version) DO UPDATE SET
        digest_id = excluded.digest_id,
        turn_seq = excluded.turn_seq,
        note_content_hash = excluded.note_content_hash,
        digest_json = excluded.digest_json,
        plan_id = excluded.plan_id,
        plan_version = excluded.plan_version,
        plan_status = excluded.plan_status,
        state = excluded.state
    `);
    for (const digest of input.payload.turnDigests) {
      insertDigest.run(
        digest.digestId,
        scope.sessionId,
        digest.turnId,
        digest.turnSeq,
        contentHash,
        digest.digestVersion,
        JSON.stringify(digest),
        digest.planOutcome?.planId ?? null,
        digest.planOutcome?.planVersion ?? null,
        digest.planOutcome?.status ?? null,
        updatedAt,
      );
    }
    return true;
  }

  private toStoredTurn(scope: AssistantSessionScope, row: TurnRow): AssistantStoredTurn {
    const execution = parseStoredExecution(row.usage_json);
    const planRow = this.planPersistenceEnabled
      ? this.database().prepare(`
        SELECT plan_id, library_id, note_id, session_id, turn_id, content_hash, original_question,
          version, active_goal_id, status, revision_count, goal_update_count, created_at, updated_at,
          scope_mode, coverage_policy, target_topic, scope_origin, scope_confidence
        FROM assistant_search_plans WHERE library_id = ? AND note_id = ? AND session_id = ? AND turn_id = ?
      `).get(scope.libraryId, scope.noteId, scope.sessionId, row.turn_id) as PlanRow | undefined
      : undefined;
    const plan = planRow ? this.hydrateSearchPlan(this.database(), planRow) : undefined;
    const evidenceRows = this.database().prepare(`
      SELECT evidence.evidence_id, evidence.heading_path_json, evidence.line_from, evidence.line_to, evidence.text_hash, evidence.preview, evidence.note_content_hash
      FROM assistant_turn_evidence link
      JOIN assistant_evidence_refs evidence ON evidence.session_id = link.session_id AND evidence.evidence_id = link.evidence_id
      WHERE link.session_id = ? AND link.turn_id = ?
      ORDER BY evidence.line_from, evidence.line_to
    `).all(scope.sessionId, row.turn_id) as Array<{ evidence_id: string; heading_path_json: string; line_from: number; line_to: number; text_hash: string; preview: string; note_content_hash: string }>;
    return {
      turnId: row.turn_id,
      turnSeq: row.turn_seq,
      userText: row.user_text,
      ...(row.assistant_text ? { assistantText: row.assistant_text } : {}),
      contextMode: row.context_mode,
      status: row.status,
      ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
      createdAt: row.created_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      toolEvents: execution.toolEvents,
      ...(plan ? { planStatus: plan.status } : {}),
      ...(plan ? { planEvent: toPublicPlanEvent(plan) } : {}),
      ...(execution.executionElapsedMs !== undefined ? { executionElapsedMs: execution.executionElapsedMs } : {}),
      evidence: evidenceRows.map((evidence) => ({
        evidenceId: evidence.evidence_id,
        notePath: '',
        contentHash: evidence.note_content_hash,
        headingPath: parseStringArray(evidence.heading_path_json),
        lineFrom: evidence.line_from,
        lineTo: evidence.line_to,
        quoteHash: evidence.text_hash,
        preview: evidence.preview,
      })),
    };
  }

  private ensureIdentity(input: IdentityInput): string {
    const database = this.database();
    const relativePath = normalizeRelativePath(input.relativePath);
    const existing = database.prepare(`SELECT note_id FROM assistant_note_identity WHERE relative_path = ?`).get(relativePath) as { note_id: string } | undefined;
    const updatedAt = now();
    if (existing) {
      database.prepare(`UPDATE assistant_note_identity SET last_content_hash = ?, state = 'active', missing_since = NULL, updated_at = ? WHERE note_id = ?`).run(input.contentHash, updatedAt, existing.note_id);
      return existing.note_id;
    }
    const noteId = `assistant-note-${randomUUID()}`;
    database.prepare(`
      INSERT INTO assistant_note_identity (note_id, relative_path, last_content_hash, state, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(noteId, relativePath, input.contentHash, updatedAt, updatedAt);
    return noteId;
  }

  private assertScope(scope: AssistantSessionScope): void {
    if (!scope?.libraryId || !scope.noteId || !scope.sessionId) throw new AssistantSessionScopeError();
    this.assertLibraryId(scope.libraryId);
    const row = this.database().prepare(`
      SELECT session_id FROM assistant_sessions WHERE session_id = ? AND note_id = ?
    `).get(scope.sessionId, scope.noteId) as { session_id: string } | undefined;
    if (!row) throw new AssistantSessionScopeError();
  }

  private assertLibraryId(libraryId: string): void {
    const row = this.database().prepare(`SELECT library_id FROM assistant_library_identity WHERE library_id = ?`).get(libraryId) as { library_id: string } | undefined;
    if (!row) throw new AssistantSessionScopeError();
  }

  private serialize<T>(scope: AssistantSessionScope, action: () => T): Promise<T> {
    const key = `${scope.libraryId}\u0000${scope.noteId}\u0000${scope.sessionId}`;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.writeQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.libraryPath);
  }
}

/** The persisted plan keeps the same renderer contract as a finished live plan event. */
function toPublicPlanEvent(plan: SearchPlan): CurrentNotePublicPlanEvent {
  const evidenceIds = new Set([
    ...plan.goals.flatMap((goal) => goal.evidenceBindings.flatMap((binding) => binding.evidenceIds)),
    ...plan.goals.flatMap((goal) => goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds])),
  ]);
  return {
    phase: 'finished',
    status: plan.status,
    goals: plan.goals.map((goal) => ({
      label: publicPlanGoalLabel(goal.question),
      status: goal.status,
      evidenceCount: new Set([
        ...goal.evidenceBindings.flatMap((binding) => binding.evidenceIds),
        ...goal.conflictBindings.flatMap((binding) => [...binding.supportsEvidenceIds, ...binding.contradictsEvidenceIds]),
      ]).size,
    })),
    searchPlan: projectPublicSearchPlan(plan, evidenceIds),
  };
}

type SearchPlanWithPersistence = SearchPlan & {
  scope?: CurrentNoteSearchScope;
  coverage?: AssistantSearchGoalCoverage[];
};

function isSearchPlanWithScope(plan: SearchPlan): plan is SearchPlanWithPersistence {
  return Boolean((plan as SearchPlanWithPersistence).scope);
}

function isSearchPlanWithCoverage(plan: SearchPlan): plan is SearchPlanWithPersistence {
  return Array.isArray((plan as SearchPlanWithPersistence).coverage);
}

function fallbackSearchScope(): CurrentNoteSearchScope {
  return { mode: 'focused', coveragePolicy: 'sufficient', targetAspects: [], origin: 'controller-fallback', confidence: 'low' };
}

function validateSearchScope(value: CurrentNoteSearchScope): CurrentNoteSearchScope {
  if (!value || (value.mode !== 'focused' && value.mode !== 'topic-wide')
    || !['sufficient', 'aspect-complete', 'occurrence-complete'].includes(value.coveragePolicy)
    || !['user-explicit', 'planner-inferred', 'session-inherited', 'controller-fallback'].includes(value.origin)
    || !['high', 'medium', 'low'].includes(value.confidence)
    || !Array.isArray(value.targetAspects) || value.targetAspects.length > 6
    || (value.mode === 'focused' && value.coveragePolicy !== 'sufficient')) {
    throw new Error('SearchPlan scope 数据无效。');
  }
  const targetTopic = value.targetTopic?.trim();
  if (targetTopic !== undefined && (targetTopic.length < 1 || targetTopic.length > 80)) throw new Error('SearchPlan scope.topic 无效。');
  const targetAspects = value.targetAspects.map((aspect) => aspect.trim());
  if (targetAspects.some((aspect) => aspect.length < 2 || aspect.length > 80)
    || new Set(targetAspects.map((aspect) => aspect.toLocaleLowerCase())).size !== targetAspects.length) {
    throw new Error('SearchPlan scope.aspect 无效。');
  }
  return {
    mode: value.mode,
    coveragePolicy: value.coveragePolicy,
    ...(targetTopic ? { targetTopic } : {}),
    targetAspects,
    origin: value.origin,
    confidence: value.confidence,
  };
}

function validateSearchCoverage(
  coverage: readonly AssistantSearchGoalCoverage[],
  plan: SearchPlan,
  snapshot: CurrentNoteSnapshot,
  scope: CurrentNoteSearchScope,
): void {
  const goalIds = new Set(plan.goals.map((goal) => goal.goalId));
  const seen = new Set<string>();
  for (const item of coverage) {
    if (!item || seen.has(item.goalId) || !goalIds.has(item.goalId)) throw new Error('SearchPlan coverage goal 无效。');
    seen.add(item.goalId);
    if (item.snapshotId !== snapshot.snapshotId || item.contentHash !== snapshot.contentHash) throw new Error('SearchPlan coverage 与当前笔记快照不一致。');
    if (item.queryFingerprint && !/^[a-f0-9]{64}$/u.test(item.queryFingerprint)) throw new Error('SearchPlan coverage query fingerprint 无效。');
    const counts = [item.matchedBlockCount, item.matchedHeadingCount, item.readHeadingCount, item.coveredAspectCount, item.targetAspectCount];
    if (counts.some((count) => !Number.isInteger(count) || count < 0) || item.coveredAspectCount > item.targetAspectCount || item.targetAspectCount > 6) throw new Error('SearchPlan coverage count 无效。');
    if (item.targetAspectCount !== scope.targetAspects.length) throw new Error('SearchPlan coverage scope 数量不一致。');
    if (!Array.isArray(item.discoveredHeadingIds) || !Array.isArray(item.readHeadingIds) || !Array.isArray(item.coveredAspects) || !Array.isArray(item.missingAspects)) throw new Error('SearchPlan coverage 集合无效。');
    if (item.matchedHeadingCount !== item.discoveredHeadingIds.length || item.readHeadingCount !== item.readHeadingIds.length || item.coveredAspectCount !== item.coveredAspects.length) throw new Error('SearchPlan coverage 计数不是主进程账本派生值。');
    if ([...item.discoveredHeadingIds, ...item.readHeadingIds].some((id) => typeof id !== 'string' || id.length < 1 || id.length > 160)) throw new Error('SearchPlan coverage headingId 无效。');
    if (item.coveredAspects.some((aspect) => !scope.targetAspects.includes(aspect)) || item.missingAspects.some((aspect) => !scope.targetAspects.includes(aspect))) throw new Error('SearchPlan coverage aspect 不属于 scope。');
    if (item.missingAspects.length + item.coveredAspects.length !== item.targetAspectCount) throw new Error('SearchPlan coverage aspect 数量不一致。');
    if (typeof item.candidateExhausted !== 'boolean' || typeof item.candidateTruncated !== 'boolean') throw new Error('SearchPlan coverage candidate 状态无效。');
    if (item.nextSearchCursor !== undefined && (typeof item.nextSearchCursor !== 'string' || item.nextSearchCursor.length < 1 || item.nextSearchCursor.length > 160)) throw new Error('SearchPlan coverage cursor 无效。');
  }
}

function publicPlanGoalLabel(value: string): string {
  const normalized = value
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '当前笔记')
    .replace(/\\\\[^\s]+/gu, '当前笔记')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized || '当前核实目标';
}

export class ScopedAssistantMemoryRepository {
  constructor(private readonly repository: AssistantMemoryRepository, readonly scope: AssistantSessionScope) {}

  getRollingSummary(): RollingSummaryState {
    return this.repository.getRollingSummary(this.scope);
  }

  compactRollingSummary(snapshot: CurrentNoteSnapshot): Promise<RollingSummaryState> {
    return this.repository.compactRollingSummary(this.scope, snapshot);
  }

  commitRollingSummary(snapshot: CurrentNoteSnapshot, input: RollingSummaryCommitInput): Promise<boolean> {
    return this.repository.commitRollingSummary(this.scope, snapshot, input);
  }

  loadContext(snapshot: CurrentNoteSnapshot): ScopedMemoryContext {
    return this.repository.loadContext(this.scope, snapshot);
  }

  startTurn(input: AssistantMemoryTurnStart): Promise<{ turnId: string; turnSeq: number }> {
    return this.repository.startTurn(this.scope, input);
  }

  persistSearchPlan(turnId: string, snapshot: CurrentNoteSnapshot, plan: SearchPlan, evidence?: AssistantEvidenceCitation[], persistence?: AssistantSearchPlanPersistenceState): Promise<void> {
    return this.repository.persistSearchPlan(this.scope, turnId, snapshot, plan, evidence, persistence);
  }

  loadSearchPlan(turnId: string, snapshot: CurrentNoteSnapshot): SearchPlan | undefined {
    return this.repository.loadSearchPlan(this.scope, turnId, snapshot);
  }

  finalizeTurn(turnId: string, snapshot: CurrentNoteSnapshot, input: AssistantMemoryTurnFinalize): Promise<void> {
    return this.repository.finalizeTurn(this.scope, turnId, snapshot, input);
  }

  finishAbortedTurn(turnId: string, status: 'cancelled' | 'error'): Promise<void> {
    return this.repository.finishAbortedTurn(this.scope, turnId, status);
  }
}

interface TurnRow {
  turn_id: string;
  turn_seq: number;
  user_text: string;
  assistant_text: string | null;
  context_mode: string;
  status: AssistantStoredTurn['status'];
  stop_reason: string | null;
  usage_json: string;
  created_at: string;
  finished_at: string | null;
}

interface DigestTurnRow {
  turn_id: string;
  turn_seq: number;
  user_text: string;
  assistant_text: string | null;
  status: 'complete' | 'partial' | 'not-found';
  note_content_hash: string;
}

interface EvidenceRow {
  evidence_id: string;
  block_ids_json: string;
  heading_path_json: string;
  line_from: number;
  line_to: number;
  text_hash: string;
}

interface PlanRow {
  plan_id: string;
  library_id: string;
  note_id: string;
  session_id: string;
  turn_id: string;
  content_hash: string;
  original_question: string;
  version: number;
  active_goal_id: string | null;
  status: SearchPlan['status'];
  revision_count: number;
  goal_update_count: number;
  created_at: string;
  updated_at: string;
  scope_mode?: CurrentNoteSearchScope['mode'];
  coverage_policy?: CurrentNoteSearchScope['coveragePolicy'];
  target_topic?: string | null;
  scope_origin?: CurrentNoteSearchScope['origin'];
  scope_confidence?: CurrentNoteSearchScope['confidence'];
}

interface CoverageRow {
  goal_id: string;
  snapshot_id: string;
  content_hash: string;
  query_fingerprint: string;
  matched_block_count: number;
  matched_heading_count: number;
  read_heading_count: number;
  covered_aspect_count: number;
  target_aspect_count: number;
  candidate_exhausted: number;
  candidate_truncated: number;
  next_search_cursor: string | null;
  covered_aspects_json: string;
}

interface SectionRow {
  goal_id: string;
  heading_id: string;
  state: 'discovered' | 'read';
}

interface PlanGoalRow {
  goal_id: string;
  goal_order: number;
  question: string;
  evidence_kind: SearchGoal['evidenceKind'];
  status: SearchGoal['status'];
  missing_evidence: string | null;
}

interface PlanRequirementRow {
  goal_id: string;
  requirement_id: string;
  requirement_order: number;
  label: string;
  subject: string | null;
  min_evidence: number;
}

interface PlanTermRow {
  goal_id: string;
  term_order: number;
  term: string;
  source: SearchQueryTerm['source'];
}

interface PlanEvidenceRow {
  goal_id: string;
  requirement_id: string;
  evidence_id: string;
  side: 'ordinary' | 'supports' | 'contradicts';
}

function toSessionSummary(row: SessionRow): AssistantSessionSummary {
  return { sessionId: row.session_id, title: row.title, status: row.status, turnCount: row.turn_count, createdAt: row.created_at, updatedAt: row.updated_at };
}

function assertTurnStart(input: AssistantMemoryTurnStart): void {
  if (!input.userText.trim() || input.userText.length > maxUserTextChars || !input.route || !input.contextMode || !input.providerFingerprint || !input.model) {
    throw new Error('AI 会话轮次数据无效。');
  }
}

function assertTurnFinalize(input: AssistantMemoryTurnFinalize): void {
  if (input.answer.length > maxAssistantTextChars || !input.stopReason || !input.contextMode || !isJsonObject(input.usage)) throw new Error('AI 会话结果数据无效。');
}

function assertCitationForSnapshot(citation: AssistantEvidenceCitation, snapshot: CurrentNoteSnapshot): void {
  if (citation.contentHash !== snapshot.contentHash || citation.lineFrom < 1 || citation.lineTo < citation.lineFrom || citation.lineTo > snapshot.lineCount || !/^[a-f0-9]{64}$/u.test(citation.quoteHash)) {
    throw new Error('AI 会话引用与当前笔记快照不一致。');
  }
  const text = readMarkdownLineRange(snapshot.markdown, snapshot.lineOffsets, citation.lineFrom, citation.lineTo);
  if (sha256(text) !== citation.quoteHash) throw new Error('AI 会话引用校验失败。');
}

function blockIdsForCitation(snapshot: CurrentNoteSnapshot, lineFrom: number, lineTo: number): string[] {
  return snapshot.blocks.filter((block) => block.lineFrom <= lineTo && block.lineTo >= lineFrom).map((block) => block.blockId).sort();
}

function meaningfulTerms(value: string): string[] {
  return [...new Set(tokenizeCurrentNoteText(value).filter((term) => term.length >= 2))].slice(0, 24);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoredExecution(value: string): { toolEvents: CurrentNotePublicToolEvent[]; executionElapsedMs?: number } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonObject(parsed)) return { toolEvents: [] };
    const toolEvents = Array.isArray(parsed.toolEvents)
      ? parsed.toolEvents.slice(0, 24).flatMap((event) => parseStoredToolEvent(event))
      : [];
    const executionElapsedMs = typeof parsed.executionElapsedMs === 'number'
      && Number.isFinite(parsed.executionElapsedMs)
      && parsed.executionElapsedMs >= 0
      && parsed.executionElapsedMs <= 10 * 60_000
      ? parsed.executionElapsedMs
      : undefined;
    return { toolEvents, ...(executionElapsedMs !== undefined ? { executionElapsedMs } : {}) };
  } catch {
    return { toolEvents: [] };
  }
}

function parseStoredToolEvent(value: unknown): CurrentNotePublicToolEvent[] {
  if (!isJsonObject(value)) return [];
  const tools = [
    'read_current_note',
    'search_note_library',
    'search_knowledge_base',
    'read_attachments',
    'search_attachment',
    'read_attachment_range',
    'get_note_map',
    'search_note',
    'read_note_range',
    'read_note_section',
    'expand_evidence',
    'get_library_note_map',
    'search_library_note_blocks',
    'read_library_note_range',
    'read_library_note_section',
    'expand_library_evidence',
    'read_library_adjacent_section',
    'knowledge_agent_skill',
  ] as const;
  const states = ['started', 'completed', 'rejected'] as const;
  if (!tools.includes(value.tool as typeof tools[number])
    || !states.includes(value.state as typeof states[number])
    || typeof value.message !== 'string'
    || !value.message.trim()
    || value.message.length > 240) return [];
  const elapsedMs = typeof value.elapsedMs === 'number'
    && Number.isFinite(value.elapsedMs)
    && value.elapsedMs >= 0
    && value.elapsedMs <= 10 * 60_000
    ? value.elapsedMs
    : undefined;
  const inputSummary = readStoredToolText(value.inputSummary, 1_200);
  const outputSummary = readStoredToolText(value.outputSummary, 1_200);
  const contentPreviews = Array.isArray(value.contentPreviews)
    ? value.contentPreviews.slice(0, 6).flatMap((preview) => parseStoredToolContentPreview(preview))
    : [];
  const sectionNavigation = parseStoredLibrarySectionNavigation(value.sectionNavigation);
  return [{
    tool: value.tool as typeof tools[number],
    state: value.state as typeof states[number],
    message: value.message.trim(),
    ...(inputSummary ? { inputSummary } : {}),
    ...(outputSummary ? { outputSummary } : {}),
    ...(contentPreviews.length ? { contentPreviews } : {}),
    ...(sectionNavigation ? { sectionNavigation } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  }];
}

function parseStoredToolContentPreview(value: unknown): CurrentNotePublicToolContentPreview[] {
  if (!isJsonObject(value)
    || (value.kind !== 'candidate' && value.kind !== 'evidence')
    || !Array.isArray(value.headingPath)
    || value.headingPath.length > 8
    || value.headingPath.some((part) => typeof part !== 'string' || part.length > 240)
    || !Number.isSafeInteger(value.lineFrom)
    || !Number.isSafeInteger(value.lineTo)
    || (value.lineFrom as number) < 1
    || (value.lineTo as number) < (value.lineFrom as number)
    || typeof value.text !== 'string'
    || !value.text.trim()
    || value.text.length > 2_500
    || typeof value.truncated !== 'boolean') return [];
  return [{
    kind: value.kind,
    headingPath: [...value.headingPath] as string[],
    lineFrom: value.lineFrom as number,
    lineTo: value.lineTo as number,
    text: value.text,
    truncated: value.truncated,
  }];
}

function parseStoredLibrarySectionNavigation(value: unknown): LibrarySectionNavigationObservation | undefined {
  if (!isJsonObject(value)
    || !Number.isSafeInteger(value.queryTermCount)
    || (value.queryTermCount as number) < 0
    || (value.queryTermCount as number) > 1_000
    || !Number.isSafeInteger(value.evaluatedSectionCount)
    || (value.evaluatedSectionCount as number) < 0
    || (value.evaluatedSectionCount as number) > 1_000_000
    || typeof value.ambiguous !== 'boolean'
    || typeof value.fallbackUsed !== 'boolean'
    || !Array.isArray(value.candidates)
    || value.candidates.length > 3) return undefined;
  const candidates = value.candidates.flatMap((candidate) => {
    if (!isJsonObject(candidate)
      || !Array.isArray(candidate.headingPath)
      || candidate.headingPath.length > 8
      || candidate.headingPath.some((part) => typeof part !== 'string' || !part.trim() || part.length > 240)
      || !Number.isSafeInteger(candidate.lineFrom)
      || !Number.isSafeInteger(candidate.lineTo)
      || (candidate.lineFrom as number) < 1
      || (candidate.lineTo as number) < (candidate.lineFrom as number)
      || typeof candidate.score !== 'number'
      || !Number.isFinite(candidate.score)
      || candidate.score < 0
      || candidate.score > 100
      || !Array.isArray(candidate.matchedTerms)
      || candidate.matchedTerms.length > 12
      || candidate.matchedTerms.some((term) => typeof term !== 'string' || !term.trim() || term.length > 80)) return [];
    return [{
      headingPath: [...candidate.headingPath] as string[],
      lineFrom: candidate.lineFrom as number,
      lineTo: candidate.lineTo as number,
      score: candidate.score,
      matchedTerms: [...candidate.matchedTerms] as string[],
    }];
  });
  if (candidates.length !== value.candidates.length) return undefined;
  return {
    queryTermCount: value.queryTermCount as number,
    evaluatedSectionCount: value.evaluatedSectionCount as number,
    ambiguous: value.ambiguous,
    fallbackUsed: value.fallbackUsed,
    candidates,
  };
}

function readStoredToolText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value.trim() : undefined;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) throw new Error('笔记相对路径无效。');
  return normalized;
}

function sanitizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 120) || '新对话';
}

function normalizePage(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 0 ? value! : 0;
}

function normalizePageSize(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 1 && value! <= 100 ? value! : fallback;
}

function isMode(value: string): value is AssistantMemoryMode {
  return value === 'persistent' || value === 'session-only' || value === 'disabled';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function now(): string {
  return new Date().toISOString();
}
