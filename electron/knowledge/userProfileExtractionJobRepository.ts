import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from './qaMemoryDatabase';
import type {
  UserProfileExtractionJob,
  UserProfileExtractionJobStatus,
  UserProfileExtractionScheduleInput,
  UserProfileExtractionSource,
} from './userProfileTypes';

const DEFAULT_PROFILE_ID = 'default';
const MAX_PENDING_RECOVERY_JOBS = 100;
const MAX_EXTRACTION_PROFILE_ITEMS = 50;

export interface UserProfileExtractionJobRow {
  job_id: string;
  source_turn_id: string;
  profile_id: string;
  session_id: string;
  scope: UserProfileExtractionJob['scope'];
  status: UserProfileExtractionJobStatus;
  attempt_count: number;
  failed_attempt_count: number;
  manual_retry_no: number;
  model_profile_id: string | null;
  provider_id: string;
  model_id: string;
  context_window_tokens: number;
  extractor_version: string;
  input_hash: string;
  output_hash: string;
  observation_count: number;
  applied_count: number;
  filtered_sensitive_count: number;
  filtered_invalid_count: number;
  input_chars: number;
  output_chars: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  error_code: string;
  error_message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export const USER_PROFILE_EXTRACTION_JOB_COLUMNS = `
  job_id, source_turn_id, profile_id, session_id, scope, status,
  attempt_count, failed_attempt_count, manual_retry_no, model_profile_id,
  provider_id, model_id, context_window_tokens, extractor_version,
  input_hash, output_hash, observation_count, applied_count,
  filtered_sensitive_count, filtered_invalid_count, input_chars, output_chars,
  input_tokens, output_tokens, duration_ms, error_code, error_message,
  created_at, started_at, finished_at, updated_at
`;

const QUALIFIED_JOB_COLUMNS = USER_PROFILE_EXTRACTION_JOB_COLUMNS
  .split(',')
  .map((column) => {
    const name = column.trim();
    return name ? `jobs.${name} AS ${name}` : '';
  })
  .filter(Boolean)
  .join(', ');

export interface UserProfileJobScheduleResult {
  job?: UserProfileExtractionJob;
  created: boolean;
  shouldEnqueue: boolean;
}

export interface UserProfileJobCompletionInput {
  status: Extract<UserProfileExtractionJobStatus, 'completed' | 'empty'>;
  outputHash: string;
  observationCount: number;
  appliedCount: number;
  filteredSensitiveCount: number;
  filteredInvalidCount: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** SQLite lifecycle authority for one logical extraction job per QA turn. */
export class UserProfileExtractionJobRepository {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly workspacePath: string,
  ) {}

  schedule(input: UserProfileExtractionScheduleInput): UserProfileJobScheduleResult {
    validateScheduleInput(input);
    const database = this.database();
    return database.transaction(() => {
      const settings = database.prepare(`
        SELECT auto_extract_enabled, allow_chat, allow_knowledge_base
        FROM user_profile_settings WHERE profile_id = ?
      `).get(DEFAULT_PROFILE_ID) as { auto_extract_enabled: number; allow_chat: number; allow_knowledge_base: number } | undefined;
      const routeAllowed = input.scope === 'chat' ? settings?.allow_chat : settings?.allow_knowledge_base;
      if (!settings?.auto_extract_enabled || !routeAllowed) return { created: false, shouldEnqueue: false };

      const turn = database.prepare(`
        SELECT turn_id, session_id, status FROM qa_turns WHERE turn_id = ? AND session_id = ?
      `).get(input.sourceTurnId, input.sessionId) as { turn_id: string; session_id: string; status: string } | undefined;
      if (!turn || !['complete', 'partial', 'not-found'].includes(turn.status)) return { created: false, shouldEnqueue: false };

      const now = new Date().toISOString();
      const jobId = randomUUID();
      const changes = database.prepare(`
        INSERT OR IGNORE INTO user_profile_extraction_jobs (
          job_id, source_turn_id, profile_id, session_id, scope, status,
          attempt_count, failed_attempt_count, manual_retry_no, model_profile_id,
          provider_id, model_id, context_window_tokens, extractor_version,
          input_hash, output_hash, observation_count, applied_count,
          filtered_sensitive_count, filtered_invalid_count, input_chars, output_chars,
          input_tokens, output_tokens, duration_ms, error_code, error_message,
          created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?, ?, '', '', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', ?, NULL, NULL, ?)
      `).run(
        jobId,
        input.sourceTurnId,
        DEFAULT_PROFILE_ID,
        input.sessionId,
        input.scope,
        input.modelProfileId,
        input.providerId,
        input.modelId,
        input.contextWindowTokens,
        now,
        now,
      ).changes;
      const job = changes ? this.requireJob(database, jobId) : this.findByTurn(database, input.sourceTurnId);
      return {
        ...(job ? { job: toUserProfileExtractionJob(job) } : {}),
        created: changes > 0,
        shouldEnqueue: job?.status === 'pending',
      };
    })();
  }

  getJob(jobId: string): UserProfileExtractionJob {
    return toUserProfileExtractionJob(this.requireJob(this.database(), validateId(jobId)));
  }

  loadPendingSource(jobId: string): UserProfileExtractionSource | undefined {
    const database = this.database();
    const row = database.prepare(`
      SELECT ${QUALIFIED_JOB_COLUMNS}, turns.user_text,
        (SELECT previous.assistant_text
           FROM qa_turns AS previous
          WHERE previous.session_id = turns.session_id AND previous.turn_seq < turns.turn_seq
          ORDER BY previous.turn_seq DESC LIMIT 1) AS previous_assistant_text
      FROM user_profile_extraction_jobs AS jobs
      JOIN qa_turns AS turns ON turns.turn_id = jobs.source_turn_id
      WHERE jobs.job_id = ? AND jobs.status = 'pending'
    `).get(validateId(jobId)) as (UserProfileExtractionJobRow & { user_text: string; previous_assistant_text: string | null }) | undefined;
    if (!row) return undefined;
    const existingItems = database.prepare(`
      SELECT category, item_key, field_label, value_text, status, user_locked
      FROM user_profile_items
      WHERE profile_id = ? AND status IN ('active', 'suggested')
      ORDER BY user_locked DESC, updated_at DESC, item_id DESC
      LIMIT ?
    `).all(DEFAULT_PROFILE_ID, MAX_EXTRACTION_PROFILE_ITEMS) as Array<{
      category: UserProfileExtractionSource['existingItems'][number]['category'];
      item_key: string;
      field_label: string;
      value_text: string;
      status: UserProfileExtractionSource['existingItems'][number]['status'];
      user_locked: number;
    }>;
    const previousAssistantQuestion = extractLastAssistantQuestion(row.previous_assistant_text);
    return {
      job: toUserProfileExtractionJob(row),
      userText: row.user_text,
      ...(previousAssistantQuestion ? { previousAssistantQuestion } : {}),
      existingItems: existingItems.map((item) => ({
        category: item.category,
        itemKey: item.item_key,
        fieldLabel: item.field_label,
        valueText: item.value_text,
        status: item.status,
        userLocked: Boolean(item.user_locked),
      })),
    };
  }

  claim(jobId: string, input: { extractorVersion: string; inputHash: string; inputChars: number }): UserProfileExtractionJob | undefined {
    const database = this.database();
    return database.transaction(() => {
      const now = new Date().toISOString();
      const changes = database.prepare(`
        UPDATE user_profile_extraction_jobs
        SET status = 'running', attempt_count = attempt_count + 1,
            extractor_version = ?, input_hash = ?, input_chars = ?,
            started_at = ?, finished_at = NULL, updated_at = ?,
            error_code = '', error_message = ''
        WHERE job_id = ? AND status = 'pending'
      `).run(input.extractorVersion, input.inputHash, input.inputChars, now, now, validateId(jobId)).changes;
      return changes ? toUserProfileExtractionJob(this.requireJob(database, jobId)) : undefined;
    })();
  }

  completeWithoutCall(
    jobId: string,
    input: { filteredSensitiveCount?: number; filteredInvalidCount?: number },
  ): UserProfileExtractionJob {
    const now = new Date().toISOString();
    const changes = this.database().prepare(`
      UPDATE user_profile_extraction_jobs
      SET status = 'empty', filtered_sensitive_count = ?, filtered_invalid_count = ?,
          finished_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'pending' AND attempt_count = 0
    `).run(
      Math.max(0, Math.round(input.filteredSensitiveCount ?? 0)),
      Math.max(0, Math.round(input.filteredInvalidCount ?? 0)),
      now,
      now,
      validateId(jobId),
    ).changes;
    if (!changes) throw new Error('画像提取任务已不在等待状态。');
    return this.getJob(jobId);
  }

  complete(jobId: string, input: UserProfileJobCompletionInput): UserProfileExtractionJob {
    const now = new Date().toISOString();
    const changes = this.database().prepare(`
      UPDATE user_profile_extraction_jobs
      SET status = ?, output_hash = ?, observation_count = ?, applied_count = ?,
          filtered_sensitive_count = ?, filtered_invalid_count = ?, output_chars = ?,
          input_tokens = ?, output_tokens = ?, duration_ms = ?, error_code = '',
          error_message = '', finished_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'
    `).run(
      input.status,
      input.outputHash,
      input.observationCount,
      input.appliedCount,
      input.filteredSensitiveCount,
      input.filteredInvalidCount,
      input.outputChars,
      input.inputTokens,
      input.outputTokens,
      input.durationMs,
      now,
      now,
      validateId(jobId),
    ).changes;
    if (!changes) throw new Error('画像提取任务已不在运行状态。');
    return this.getJob(jobId);
  }

  fail(
    jobId: string,
    input: { status: Extract<UserProfileExtractionJobStatus, 'failed' | 'blocked' | 'unknown'>; code: string; message: string; durationMs?: number },
  ): UserProfileExtractionJob {
    const now = new Date().toISOString();
    const failedIncrement = input.status === 'failed' ? 1 : 0;
    const changes = this.database().prepare(`
      UPDATE user_profile_extraction_jobs
      SET status = ?, failed_attempt_count = failed_attempt_count + ?,
          error_code = ?, error_message = ?, duration_ms = ?, finished_at = ?, updated_at = ?
      WHERE job_id = ? AND status IN ('pending', 'running')
    `).run(
      input.status,
      failedIncrement,
      sanitizeAuditText(input.code, 80),
      sanitizeAuditText(input.message, 300),
      Math.max(0, Math.round(input.durationMs ?? 0)),
      now,
      now,
      validateId(jobId),
    ).changes;
    if (!changes) throw new Error('画像提取任务状态已变化。');
    return this.getJob(jobId);
  }

  prepareManualRetry(jobId: string): UserProfileExtractionJob {
    const now = new Date().toISOString();
    const changes = this.database().prepare(`
      UPDATE user_profile_extraction_jobs
      SET status = 'pending', manual_retry_no = manual_retry_no + 1,
          error_code = '', error_message = '', started_at = NULL,
          finished_at = NULL, updated_at = ?
      WHERE job_id = ? AND status IN ('failed', 'blocked', 'unknown')
    `).run(now, validateId(jobId)).changes;
    if (!changes) throw new Error('只有失败、受阻或状态未知的画像任务可以重试。');
    return this.getJob(jobId);
  }

  recoverInterruptedJobs(): string[] {
    const database = this.database();
    return database.transaction(() => {
      const now = new Date().toISOString();
      database.prepare(`
        UPDATE user_profile_extraction_jobs
        SET status = 'unknown', error_code = 'process-interrupted',
            error_message = '上次调用的最终状态未知，未自动重复调用。',
            finished_at = ?, updated_at = ?
        WHERE status = 'running'
      `).run(now, now);
      const rows = database.prepare(`
        SELECT job_id FROM user_profile_extraction_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC LIMIT ?
      `).all(MAX_PENDING_RECOVERY_JOBS) as Array<{ job_id: string }>;
      return rows.map((row) => row.job_id);
    })();
  }

  listPendingJobIds(limit = MAX_PENDING_RECOVERY_JOBS): string[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MAX_PENDING_RECOVERY_JOBS, limit)) : MAX_PENDING_RECOVERY_JOBS;
    return (this.database().prepare(`
      SELECT job_id FROM user_profile_extraction_jobs
      WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).all(boundedLimit) as Array<{ job_id: string }>).map((row) => row.job_id);
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.workspacePath);
  }

  private requireJob(database: Database.Database, jobId: string): UserProfileExtractionJobRow {
    const row = database.prepare(`SELECT ${USER_PROFILE_EXTRACTION_JOB_COLUMNS} FROM user_profile_extraction_jobs WHERE job_id = ?`).get(jobId) as UserProfileExtractionJobRow | undefined;
    if (!row) throw new Error('画像提取任务不存在或已被删除。');
    return row;
  }

  private findByTurn(database: Database.Database, sourceTurnId: string): UserProfileExtractionJobRow | undefined {
    return database.prepare(`SELECT ${USER_PROFILE_EXTRACTION_JOB_COLUMNS} FROM user_profile_extraction_jobs WHERE source_turn_id = ?`).get(sourceTurnId) as UserProfileExtractionJobRow | undefined;
  }
}

export function toUserProfileExtractionJob(row: UserProfileExtractionJobRow): UserProfileExtractionJob {
  return {
    jobId: row.job_id,
    sourceTurnId: row.source_turn_id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    scope: row.scope,
    status: row.status,
    attemptCount: row.attempt_count,
    failedAttemptCount: row.failed_attempt_count,
    manualRetryNo: row.manual_retry_no,
    ...(row.model_profile_id ? { modelProfileId: row.model_profile_id } : {}),
    providerId: row.provider_id,
    modelId: row.model_id,
    contextWindowTokens: row.context_window_tokens,
    observationCount: row.observation_count,
    appliedCount: row.applied_count,
    filteredSensitiveCount: row.filtered_sensitive_count,
    filteredInvalidCount: row.filtered_invalid_count,
    inputChars: row.input_chars,
    outputChars: row.output_chars,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    durationMs: row.duration_ms,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
  };
}

function extractLastAssistantQuestion(value: string | null): string | undefined {
  if (!value) return undefined;
  const matches = value.match(/[^。！？!?\n]{1,280}[？?]/gu);
  const question = matches?.at(-1)?.trim();
  return question ? [...question].slice(0, 300).join('') : undefined;
}

function validateScheduleInput(input: UserProfileExtractionScheduleInput): void {
  validateId(input.sourceTurnId);
  validateId(input.sessionId);
  validateId(input.modelProfileId);
  if (input.scope !== 'chat' && input.scope !== 'knowledge-base') throw new Error('画像提取范围无效。');
  if (!input.providerId.trim() || input.providerId.length > 80) throw new Error('画像提取 Provider 标识无效。');
  if (!input.modelId.trim() || input.modelId.length > 200) throw new Error('画像提取模型标识无效。');
  if (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 1) throw new Error('画像提取上下文窗口无效。');
}

function validateId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error('画像提取任务标识无效。');
  return value.trim();
}

function sanitizeAuditText(value: string, maxChars: number): string {
  return [...String(value).replace(/[\r\n\t]+/g, ' ').trim()].slice(0, maxChars).join('');
}
