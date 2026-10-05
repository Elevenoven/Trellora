import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase, recoverExpiredMemoryExtractionJobLeases } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS } from './memoryConstants';
import { assertTrustedMemoryScope } from './memoryScope';
import { ensureScopeRows, runInImmediateTransaction } from './memoryRepository';
import { parseSourceClaims } from './memoryExtractionSourceRepository';
import type {
  ClaimedMemoryExtractionJob,
  MemoryExtractionJobRecord,
  MemoryExtractionModelHint,
  MemoryExtractionJobStatus,
  MemoryExtractionSourceClaim,
  MemoryScope,
  TrustedMemoryScope,
  TrustedMemoryScopeContext,
} from './memoryTypes';

interface ExtractionJobRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  captured_generation: number;
  status: MemoryExtractionJobStatus;
  due_at: string;
  attempts: number;
  claimed_sessions_json: string;
  claimed_sources_json: string;
  source_model_profile_id: string | null;
  source_model_id: string | null;
  source_context_window_tokens: number | null;
  lease_until: string | null;
  last_error: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SubjectQueueRow {
  pending_sessions_json: string;
  memory_generation: number;
  last_extracted_at: string | null;
}

export interface MemoryExtractionScheduleOptions {
  dueAt?: Date;
  now?: Date;
  modelHint?: MemoryExtractionModelHint;
  sources?: MemoryExtractionSourceClaim[];
  reason?: 'external' | 'backlog' | 'continuation';
  carriedAttempts?: number;
}

export type PersistedMemoryScopeRevalidator = (
  scope: MemoryScope,
) => TrustedMemoryScopeContext | undefined;

/** Durable queue for WK-M4 extraction; the runner owns model calls and watermark commits. */
export class MemoryExtractionScheduler {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {}

  schedule(
    scope: TrustedMemoryScope,
    sessionId: string,
    options: MemoryExtractionScheduleOptions = {},
  ): MemoryExtractionJobRecord {
    assertTrustedMemoryScope(scope);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const now = options.now ?? new Date();
    const timestamp = now.toISOString();
    const database = this.database();

    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const subject = this.requireSubjectQueue(database, scope);
      const dueAt = options.dueAt?.toISOString()
        ?? deriveDueAt(database, scope.workspaceId, subject.last_extracted_at, now).toISOString();
      const modelHint = normalizeModelHint(options.modelHint);
      if (options.sources) {
        const reason = options.reason ?? 'external';
        if (reason === 'external') database.prepare(`UPDATE memory_extraction_pending_sources SET due_at = ?
          WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? AND reason = 'external'`)
          .run(dueAt, scope.workspaceId, scope.principalId, subject.memory_generation);
        for (const source of options.sources) {
          if (source.generation !== subject.memory_generation) throw new Error('STALE_MEMORY_GENERATION');
          database.prepare(`INSERT INTO memory_extraction_pending_sources
            (workspace_id, principal_id, memory_generation, turn_id, source_fingerprint, due_at, reason, carried_attempts, model_hint_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, principal_id, memory_generation, turn_id) DO UPDATE SET
              source_fingerprint = excluded.source_fingerprint, due_at = excluded.due_at, reason = excluded.reason,
              carried_attempts = excluded.carried_attempts, model_hint_json = excluded.model_hint_json`).run(scope.workspaceId, scope.principalId, source.generation,
              source.turnId, source.fingerprint, dueAt, reason, options.carriedAttempts ?? 0, JSON.stringify(modelHint));
        }
      }
      const pendingSessionIds = appendPendingSession(
        parseStringArray(subject.pending_sessions_json),
        normalizedSessionId,
      );
      database.prepare(`
        UPDATE memory_subjects
        SET pending_sessions_json = ?, extract_scheduled_at = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ?
      `).run(JSON.stringify(pendingSessionIds), dueAt, timestamp, scope.workspaceId, scope.principalId);

      const liveJob = this.findLiveJob(database, scope);
      if (liveJob) {
        if (liveJob.status === 'queued') {
          const actualDue = this.pendingDue(database, scope) ?? dueAt;
          database.prepare(`UPDATE memory_extraction_jobs SET due_at = ? WHERE id = ?`).run(actualDue, liveJob.id);
          database.prepare(`UPDATE memory_subjects SET extract_scheduled_at = ? WHERE workspace_id = ? AND principal_id = ?`)
            .run(actualDue, scope.workspaceId, scope.principalId);
        } else if (liveJob.status === 'retry') {
          database.prepare(`UPDATE memory_subjects SET extract_scheduled_at = ? WHERE workspace_id = ? AND principal_id = ?`)
            .run(liveJob.due_at, scope.workspaceId, scope.principalId);
        }
        if (liveJob.status === 'queued' && hasModelHint(modelHint)) {
          database.prepare(`
            UPDATE memory_extraction_jobs
            SET source_model_profile_id = COALESCE(?, source_model_profile_id),
                source_model_id = COALESCE(?, source_model_id),
                source_context_window_tokens = COALESCE(?, source_context_window_tokens),
                updated_at = ?
            WHERE id = ? AND workspace_id = ? AND principal_id = ?
          `).run(
            modelHint.profileId, modelHint.modelId, modelHint.contextWindowTokens, timestamp,
            liveJob.id, scope.workspaceId, scope.principalId,
          );
          return this.requireJob(database, scope, liveJob.id);
        }
        return this.requireJob(database, scope, liveJob.id);
      }

      const jobId = `memory-extract-${randomUUID()}`;
      const actualDue = this.pendingDue(database, scope) ?? dueAt;
      database.prepare(`UPDATE memory_subjects SET extract_scheduled_at = ? WHERE workspace_id = ? AND principal_id = ?`)
        .run(actualDue, scope.workspaceId, scope.principalId);
      database.prepare(`
        INSERT INTO memory_extraction_jobs (
          id, workspace_id, principal_id, captured_generation, status, due_at,
          attempts, claimed_sessions_json, source_model_profile_id, source_model_id,
          source_context_window_tokens, lease_until, last_error, finished_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, 0, '[]', ?, ?, ?, NULL, NULL, NULL, ?, ?)
      `).run(
        jobId,
        scope.workspaceId,
        scope.principalId,
        subject.memory_generation,
        actualDue,
        modelHint.profileId,
        modelHint.modelId,
        modelHint.contextWindowTokens,
        timestamp,
        timestamp,
      );
      return this.requireJob(database, scope, jobId);
    });
  }

  claimNextDue(
    revalidateScope: PersistedMemoryScopeRevalidator,
    now = new Date(),
  ): ClaimedMemoryExtractionJob | undefined {
    const database = this.database();
    const timestamp = now.toISOString();
    return runInImmediateTransaction(database, () => {
      recoverExpiredMemoryExtractionJobLeases(database, now);
      while (true) {
        const row = database.prepare(`
          SELECT * FROM memory_extraction_jobs
          WHERE status IN ('queued', 'retry') AND due_at <= ?
          ORDER BY due_at ASC, id ASC
          LIMIT 1
        `).get(timestamp) as ExtractionJobRow | undefined;
        if (!row) return undefined;

        const trustedContext = revalidateScope({
          workspaceId: row.workspace_id,
          principalId: row.principal_id,
        });
        if (!trustedContext) {
          this.markStale(database, row.id, timestamp, 'SCOPE_NO_LONGER_REGISTERED');
          continue;
        }
        assertTrustedMemoryScope(trustedContext.scope);

        const subject = this.requireSubjectQueue(database, trustedContext.scope);
        if (subject.memory_generation !== row.captured_generation) {
          this.markStale(database, row.id, timestamp, 'STALE_MEMORY_GENERATION');
          continue;
        }
        let frozen = parseSourceClaims(row.claimed_sources_json);
        let carriedAttempts = row.attempts;
        if (!frozen.length) {
          const pending = database.prepare(`SELECT p.turn_id, p.source_fingerprint, p.memory_generation, p.carried_attempts, p.model_hint_json FROM memory_extraction_pending_sources p JOIN qa_turns t ON t.turn_id = p.turn_id
            WHERE p.workspace_id = ? AND p.principal_id = ? AND p.memory_generation = ? AND p.due_at <= ? ORDER BY p.due_at, t.created_at, p.turn_id`)
            .all(row.workspace_id, row.principal_id, row.captured_generation, timestamp) as { turn_id: string; source_fingerprint: string; memory_generation: number; carried_attempts: number; model_hint_json: string }[];
          if (pending.length) {
            const budget = pending[0].carried_attempts;
            const selected = pending.filter((source) => source.carried_attempts === budget).slice(0, MEMORY_CONSTANTS.writeAndExtraction.newUserMessageLimit);
            frozen = selected.map((source) => ({ turnId: source.turn_id, fingerprint: source.source_fingerprint, generation: source.memory_generation }));
            carriedAttempts = Math.max(carriedAttempts, budget);
            const hint = selected.map((source) => normalizeModelHint(JSON.parse(source.model_hint_json))).findLast(hasModelHint);
            if (hint) database.prepare(`UPDATE memory_extraction_jobs SET source_model_profile_id = ?, source_model_id = ?, source_context_window_tokens = ? WHERE id = ?`)
              .run(hint.profileId, hint.modelId, hint.contextWindowTokens, row.id);
            for (const source of selected) database.prepare(`DELETE FROM memory_extraction_pending_sources WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? AND turn_id = ?`)
              .run(row.workspace_id, row.principal_id, row.captured_generation, source.turn_id);
            // Only confirmed, already-due overflow receives the 15-second backlog delay.
            database.prepare(`UPDATE memory_extraction_pending_sources SET due_at = ?, reason = 'backlog'
              WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? AND due_at <= ? AND carried_attempts = ?`)
              .run(new Date(now.getTime() + MEMORY_CONSTANTS.writeAndExtraction.truncatedFollowUpSeconds * 1000).toISOString(), row.workspace_id, row.principal_id, row.captured_generation, timestamp, budget);
          }
        }
        const retainedClaim = parseStringArray(row.claimed_sessions_json);
        let claimedSessionIds = retainedClaim.length
          ? retainedClaim
          : parseStringArray(subject.pending_sessions_json);
        if (!claimedSessionIds.length && frozen.length) {
          claimedSessionIds = [...new Set(frozen.flatMap((source) => {
            const turn = database.prepare('SELECT session_id FROM qa_turns WHERE turn_id = ?').get(source.turnId) as { session_id: string } | undefined;
            return turn ? [turn.session_id] : [];
          }))];
        }
        if (!claimedSessionIds.length) {
          this.markStale(database, row.id, timestamp, 'NO_PENDING_SESSIONS');
          continue;
        }

        if (!retainedClaim.length) {
          database.prepare(`
            UPDATE memory_subjects
            SET pending_sessions_json = '[]', extract_scheduled_at = NULL, updated_at = ?
            WHERE workspace_id = ? AND principal_id = ?
          `).run(timestamp, row.workspace_id, row.principal_id);
        }

        const delay = database.prepare(`
          SELECT extract_delay_seconds AS value
          FROM memory_workspace_settings WHERE workspace_id = ?
        `).get(row.workspace_id) as { value: number };
        const leaseSeconds = delay.value + MEMORY_CONSTANTS.writeAndExtraction.inFlightLeaseExtraSeconds;
        const leaseUntil = new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
        database.prepare(`
          UPDATE memory_extraction_jobs
          SET status = 'running', attempts = ?, claimed_sessions_json = ?, claimed_sources_json = ?,
              lease_until = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND principal_id = ?
            AND status IN ('queued', 'retry')
        `).run(
          carriedAttempts + 1,
          JSON.stringify(claimedSessionIds),
          JSON.stringify(frozen),
          leaseUntil,
          timestamp,
          row.id,
          row.workspace_id,
          row.principal_id,
        );
        const claimed = this.requireJob(database, trustedContext.scope, row.id);
        if (carriedAttempts > MEMORY_CONSTANTS.writeAndExtraction.queueFailureRetryLimit) {
          database.prepare(`UPDATE memory_extraction_jobs SET status = 'failed', last_error = 'RETRY_BUDGET_EXHAUSTED', lease_until = NULL, finished_at = ? WHERE id = ?`).run(timestamp, row.id);
          this.schedulePendingFollowUp(database, trustedContext.scope, timestamp, claimed);
          continue;
        }
        return {
          ...claimed,
          trustedScope: trustedContext.scope,
          workspacePath: trustedContext.workspacePath,
        };
      }
    });
  }

  complete(scope: TrustedMemoryScope, jobId: string, now = new Date()): void {
    assertTrustedMemoryScope(scope);
    const timestamp = now.toISOString();
    const database = this.database();
    runInImmediateTransaction(database, () => {
      const job = this.requireJob(database, scope, jobId);
      if (job.status !== 'running') throw new Error('待完成的记忆抽取任务不在运行中。');
      const changes = database.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'done', lease_until = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ? AND status = 'running'
      `).run(timestamp, timestamp, jobId, scope.workspaceId, scope.principalId).changes;
      if (!changes) throw new Error('待完成的记忆抽取任务不存在或不属于当前作用域。');
      this.schedulePendingFollowUp(database, scope, timestamp, job);
    });
  }

  fail(scope: TrustedMemoryScope, jobId: string, error: unknown, now = new Date()): MemoryExtractionJobRecord {
    assertTrustedMemoryScope(scope);
    const database = this.database();
    const timestamp = now.toISOString();
    return runInImmediateTransaction(database, () => {
      const job = this.requireJob(database, scope, jobId);
      if (job.status !== 'running') return job;
      const shouldRetry = job.attempts <= MEMORY_CONSTANTS.writeAndExtraction.queueFailureRetryLimit;
      const status: MemoryExtractionJobStatus = shouldRetry ? 'retry' : 'failed';
      database.prepare(`
        UPDATE memory_extraction_jobs
        SET status = ?, due_at = ?, lease_until = NULL, last_error = ?,
            finished_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ? AND status = 'running'
      `).run(
        status,
        timestamp,
        normalizeError(error),
        shouldRetry ? null : timestamp,
        timestamp,
        jobId,
        scope.workspaceId,
        scope.principalId,
      );
      if (!shouldRetry) this.schedulePendingFollowUp(database, scope, timestamp, job);
      return this.requireJob(database, scope, jobId);
    });
  }

  recoverExpiredLeases(now = new Date()): number {
    return runInImmediateTransaction(
      this.database(),
      () => recoverExpiredMemoryExtractionJobLeases(this.database(), now),
    );
  }

  stale(scope: TrustedMemoryScope, jobId: string, reason: string, now = new Date()): void {
    assertTrustedMemoryScope(scope);
    const timestamp = now.toISOString();
    runInImmediateTransaction(this.database(), () => {
      this.database().prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'stale', lease_until = NULL, last_error = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ? AND status = 'running'
      `).run(normalizeError(reason), timestamp, timestamp, jobId, scope.workspaceId, scope.principalId);
      const job = this.getJob(scope, jobId);
      if (job && this.requireSubjectQueue(this.database(), scope).memory_generation === job.capturedGeneration) this.schedulePendingFollowUp(this.database(), scope, timestamp, job);
    });
  }

  getJob(scope: TrustedMemoryScope, jobId: string): MemoryExtractionJobRecord | undefined {
    assertTrustedMemoryScope(scope);
    const row = this.database().prepare(`
      SELECT * FROM memory_extraction_jobs
      WHERE id = ? AND workspace_id = ? AND principal_id = ?
    `).get(jobId, scope.workspaceId, scope.principalId) as ExtractionJobRow | undefined;
    return row ? mapJobRow(row) : undefined;
  }

  getNextDueAt(): string | undefined {
    const row = this.database().prepare(`
      SELECT due_at FROM memory_extraction_jobs
      WHERE status IN ('queued', 'retry') ORDER BY due_at ASC, id ASC LIMIT 1
    `).get() as { due_at: string } | undefined;
    return row?.due_at;
  }

  private schedulePendingFollowUp(
    database: Database.Database,
    scope: TrustedMemoryScope,
    timestamp: string,
    sourceJob: MemoryExtractionJobRecord,
  ): void {
    const subject = this.requireSubjectQueue(database, scope);
    if (this.findLiveJob(database, scope)) return;
    if (subject.last_extracted_at) {
      const settings = database.prepare('SELECT extract_min_interval_seconds AS seconds FROM memory_workspace_settings WHERE workspace_id = ?')
        .get(scope.workspaceId) as { seconds: number };
      const earliest = new Date(Date.parse(subject.last_extracted_at) + settings.seconds * 1000).toISOString();
      // New messages can arrive before the running job commits its last_extracted_at.
      // Preserve their debounce and reapply the actual minimum interval; backlog keeps 15 seconds.
      database.prepare(`UPDATE memory_extraction_pending_sources SET due_at = MAX(due_at, ?)
        WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? AND reason = 'external'`)
        .run(earliest, scope.workspaceId, scope.principalId, subject.memory_generation);
    }
    const pendingDue = this.pendingDue(database, scope);
    if (!pendingDue && !parseStringArray(subject.pending_sessions_json).length) return;
    const dueAt = pendingDue ?? new Date(
      new Date(timestamp).getTime() + MEMORY_CONSTANTS.writeAndExtraction.truncatedFollowUpSeconds * 1_000,
    ).toISOString();
    const nextSource = database.prepare(`SELECT model_hint_json FROM memory_extraction_pending_sources
      WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? ORDER BY due_at, turn_id LIMIT 1`)
      .get(scope.workspaceId, scope.principalId, subject.memory_generation) as { model_hint_json: string } | undefined;
    const hint = nextSource ? normalizeModelHint(JSON.parse(nextSource.model_hint_json)) : {
      profileId: sourceJob.sourceModelProfileId, modelId: sourceJob.sourceModelId, contextWindowTokens: sourceJob.sourceContextWindowTokens,
    };
    database.prepare(`
      INSERT INTO memory_extraction_jobs (
        id, workspace_id, principal_id, captured_generation, status, due_at,
        attempts, claimed_sessions_json, source_model_profile_id, source_model_id,
        source_context_window_tokens, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, '[]', ?, ?, ?, ?, ?)
    `).run(
      `memory-extract-${randomUUID()}`,
      scope.workspaceId,
      scope.principalId,
      subject.memory_generation,
      dueAt,
      hint.profileId,
      hint.modelId,
      hint.contextWindowTokens,
      timestamp,
      timestamp,
    );
    database.prepare(`
      UPDATE memory_subjects SET extract_scheduled_at = ?, updated_at = ?
      WHERE workspace_id = ? AND principal_id = ?
    `).run(dueAt, timestamp, scope.workspaceId, scope.principalId);
  }

  private pendingDue(database: Database.Database, scope: TrustedMemoryScope): string | undefined {
    const row = database.prepare(`SELECT MIN(due_at) AS due FROM memory_extraction_pending_sources p
      JOIN memory_subjects s USING (workspace_id, principal_id)
      WHERE p.workspace_id = ? AND p.principal_id = ? AND p.memory_generation = s.memory_generation`)
      .get(scope.workspaceId, scope.principalId) as { due: string | null };
    return row.due ?? undefined;
  }

  private markStale(database: Database.Database, jobId: string, timestamp: string, reason: string): void {
    database.prepare(`
      UPDATE memory_extraction_jobs
      SET status = 'stale', lease_until = NULL, last_error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, timestamp, timestamp, jobId);
  }

  private findLiveJob(database: Database.Database, scope: TrustedMemoryScope): ExtractionJobRow | undefined {
    return database.prepare(`
      SELECT * FROM memory_extraction_jobs
      WHERE workspace_id = ? AND principal_id = ? AND status IN ('queued', 'running', 'retry')
      LIMIT 1
    `).get(scope.workspaceId, scope.principalId) as ExtractionJobRow | undefined;
  }

  private requireJob(
    database: Database.Database,
    scope: TrustedMemoryScope,
    jobId: string,
  ): MemoryExtractionJobRecord {
    const row = database.prepare(`
      SELECT * FROM memory_extraction_jobs
      WHERE id = ? AND workspace_id = ? AND principal_id = ?
    `).get(jobId, scope.workspaceId, scope.principalId) as ExtractionJobRow | undefined;
    if (!row) throw new Error('记忆抽取任务不存在或不属于当前作用域。');
    return mapJobRow(row);
  }

  private requireSubjectQueue(database: Database.Database, scope: TrustedMemoryScope): SubjectQueueRow {
    const row = database.prepare(`
      SELECT pending_sessions_json, memory_generation, last_extracted_at FROM memory_subjects
      WHERE workspace_id = ? AND principal_id = ?
    `).get(scope.workspaceId, scope.principalId) as SubjectQueueRow | undefined;
    if (!row) throw new Error('记忆主体不存在或不属于当前作用域。');
    return row;
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

function mapJobRow(row: ExtractionJobRow): MemoryExtractionJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    capturedGeneration: row.captured_generation,
    status: row.status,
    dueAt: row.due_at,
    attempts: row.attempts,
    claimedSessionIds: parseStringArray(row.claimed_sessions_json),
    claimedSources: parseSourceClaims(row.claimed_sources_json),
    sourceModelProfileId: row.source_model_profile_id,
    sourceModelId: row.source_model_id,
    sourceContextWindowTokens: row.source_context_window_tokens,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deriveDueAt(database: Database.Database, workspaceId: string, lastExtractedAt: string | null, now: Date): Date {
  const settings = database.prepare(`
    SELECT extract_delay_seconds, extract_min_interval_seconds
    FROM memory_workspace_settings WHERE workspace_id = ?
  `).get(workspaceId) as { extract_delay_seconds: number; extract_min_interval_seconds: number } | undefined;
  const delayMs = (settings?.extract_delay_seconds ?? 90) * 1_000;
  const minIntervalMs = (settings?.extract_min_interval_seconds ?? 300) * 1_000;
  const lastExtractedMs = lastExtractedAt ? Date.parse(lastExtractedAt) : Number.NaN;
  return new Date(Math.max(
    now.getTime() + delayMs,
    Number.isFinite(lastExtractedMs) ? lastExtractedMs + minIntervalMs : Number.NEGATIVE_INFINITY,
  ));
}

function normalizeModelHint(hint: MemoryExtractionModelHint | undefined): Required<MemoryExtractionModelHint> {
  const profileId = normalizeOptionalHint(hint?.profileId);
  const modelId = normalizeOptionalHint(hint?.modelId);
  const contextWindowTokens = Number.isInteger(hint?.contextWindowTokens) && (hint?.contextWindowTokens ?? 0) > 0
    ? hint!.contextWindowTokens!
    : null;
  return { profileId, modelId, contextWindowTokens };
}

function normalizeOptionalHint(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length <= 500 ? normalized : null;
}

function hasModelHint(hint: Required<MemoryExtractionModelHint>): boolean {
  return hint.profileId !== null || hint.modelId !== null || hint.contextWindowTokens !== null;
}

function appendPendingSession(sessionIds: string[], sessionId: string): string[] {
  const next = [...sessionIds.filter((candidate) => candidate !== sessionId), sessionId];
  return next.slice(-MEMORY_CONSTANTS.writeAndExtraction.pendingSessionLimit);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || normalized.length > 500) throw new Error('记忆抽取会话标识无效。');
  return normalized;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 1_000).join('') || 'UNKNOWN_EXTRACTION_ERROR';
}
