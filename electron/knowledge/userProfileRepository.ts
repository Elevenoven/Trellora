import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from './qaMemoryDatabase';
import { isSensitiveProfileContent } from './userProfileExtractor';
import { collectUserProfileReviewDueItems, getNextUserProfileReviewAt } from './userProfileLifecycle';
import {
  toUserProfileExtractionJob,
  USER_PROFILE_EXTRACTION_JOB_COLUMNS,
  type UserProfileExtractionJobRow,
} from './userProfileExtractionJobRepository';
import {
  USER_PROFILE_CATEGORIES,
  type UserProfileCardinality,
  type UserProfileCategory,
  type UserProfileClearResult,
  type UserProfileClearScope,
  type UserProfileConflictGroup,
  type UserProfileConflictResolutionInput,
  type UserProfileContextSnapshot,
  type UserProfileDeleteInput,
  type UserProfileEvidence,
  type UserProfileEvidencePage,
  type UserProfileEvidenceQuery,
  type UserProfileExportDocument,
  type UserProfileItem,
  type UserProfileItemInput,
  type UserProfileImportSummary,
  type UserProfileLockInput,
  type UserProfileOverview,
  type UserProfileReviewInput,
  type UserProfileRevision,
  type UserProfileRevisionPage,
  type UserProfileRevisionQuery,
  type UserProfileRevisionSnapshot,
  type UserProfileRollbackInput,
  type UserProfileSettings,
  type UserProfileSettingsPatch,
  type UserProfileTemporalStatus,
} from './userProfileTypes';

const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_EVIDENCE_PAGE_SIZE = 10;
const MAX_EVIDENCE_PAGE_SIZE = 50;
const DEFAULT_REVISION_PAGE_SIZE = 10;
const MAX_REVISION_PAGE_SIZE = 50;
const MAX_OVERVIEW_ITEMS = 500;
const MAX_IMPORT_ITEMS = 500;
const MAX_FIELD_LABEL_CHARS = 48;
const MAX_VALUE_TEXT_CHARS = 1_000;

interface UserProfileSettingsRow {
  profile_id: string;
  auto_extract_enabled: number;
  use_in_qa_context: number;
  allow_chat: number;
  allow_knowledge_base: number;
  extraction_model_profile_id: string | null;
  profile_token_budget: number;
  created_at: string;
  updated_at: string;
}

interface UserProfileItemRow {
  item_id: string;
  profile_id: string;
  category: UserProfileCategory;
  item_key: string;
  field_label: string;
  value_text: string;
  cardinality: UserProfileCardinality;
  temporal_status: UserProfileTemporalStatus;
  assertion_kind: UserProfileItem['assertionKind'];
  status: UserProfileItem['status'];
  confidence: number;
  stability: UserProfileItem['stability'];
  user_locked: number;
  source_count: number;
  valid_from: string | null;
  valid_to: string | null;
  expires_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface UserProfileEvidenceRow {
  evidence_id: string;
  item_id: string;
  source_turn_id: string | null;
  source_session_id: string | null;
  source_scope: UserProfileEvidence['sourceScope'];
  excerpt: string;
  assertion_kind: UserProfileEvidence['assertionKind'];
  confidence: number;
  occurred_at: string;
  created_at: string;
}

interface UserProfileRevisionRow {
  revision_id: string;
  item_id: string;
  revision: number;
  action: UserProfileRevision['action'];
  actor: UserProfileRevision['actor'];
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export class UserProfileValidationError extends Error {}
export class UserProfileRevisionConflictError extends Error {}

/**
 * Owns the durable user-information boundary. Model observations can only
 * arrive through the extractor/merge service; public mutations remain explicit.
 */
export class UserProfileRepository {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly workspacePath: string,
  ) {}

  getOverview(): UserProfileOverview {
    const database = this.database();
    const settings = this.ensureSettings(database);
    const rows = database.prepare(`
      SELECT item_id, profile_id, category, item_key, field_label, value_text,
             cardinality, temporal_status, assertion_kind, status, confidence,
             stability, user_locked, source_count, valid_from, valid_to,
             expires_at, revision, created_at, updated_at
      FROM user_profile_items
      WHERE profile_id = ?
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'suggested' THEN 1 WHEN 'superseded' THEN 2 ELSE 3 END,
        category ASC,
        updated_at DESC,
        item_id DESC
      LIMIT ?
    `).all(DEFAULT_PROFILE_ID, MAX_OVERVIEW_ITEMS) as UserProfileItemRow[];
    const counts = database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) AS suggested,
        SUM(CASE WHEN user_locked = 1 THEN 1 ELSE 0 END) AS locked,
        (SELECT COUNT(*)
           FROM user_profile_evidence AS evidence_rows
           JOIN user_profile_items AS evidence_items ON evidence_items.item_id = evidence_rows.item_id
          WHERE evidence_items.profile_id = ?) AS evidence
      FROM user_profile_items
      WHERE profile_id = ?
    `).get(DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID) as {
      total: number;
      active: number | null;
      suggested: number | null;
      locked: number | null;
      evidence: number;
    };
    const extractionCounts = database.prepare(`
      SELECT
        COUNT(*) AS total_jobs,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
        SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_jobs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_jobs,
        SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown_jobs,
        SUM(attempt_count) AS total_calls,
        SUM(failed_attempt_count) AS failed_calls,
        SUM(manual_retry_no) AS manual_retries,
        SUM(observation_count) AS observations,
        SUM(applied_count) AS applied,
        SUM(filtered_sensitive_count) AS filtered_sensitive,
        SUM(filtered_invalid_count) AS filtered_invalid,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM user_profile_extraction_jobs
      WHERE profile_id = ?
    `).get(DEFAULT_PROFILE_ID) as Record<string, number | null>;
    const recentJobs = database.prepare(`
      SELECT ${USER_PROFILE_EXTRACTION_JOB_COLUMNS}
      FROM user_profile_extraction_jobs
      WHERE profile_id = ?
      ORDER BY created_at DESC, job_id DESC
      LIMIT 10
    `).all(DEFAULT_PROFILE_ID) as UserProfileExtractionJobRow[];

    const items = rows.map(toItem);
    const conflicts = collectConflictGroups(items);
    const reviewDueItems = collectUserProfileReviewDueItems(items);
    return {
      settings,
      items,
      counts: {
        total: counts.total,
        active: counts.active ?? 0,
        suggested: counts.suggested ?? 0,
        locked: counts.locked ?? 0,
        evidence: counts.evidence,
        conflicts: conflicts.length,
        reviewDue: reviewDueItems.length,
      },
      conflicts,
      reviewDueItems,
      extraction: {
        stats: {
          totalJobs: extractionCounts.total_jobs ?? 0,
          pendingJobs: extractionCounts.pending_jobs ?? 0,
          runningJobs: extractionCounts.running_jobs ?? 0,
          completedJobs: extractionCounts.completed_jobs ?? 0,
          emptyJobs: extractionCounts.empty_jobs ?? 0,
          failedJobs: extractionCounts.failed_jobs ?? 0,
          blockedJobs: extractionCounts.blocked_jobs ?? 0,
          unknownJobs: extractionCounts.unknown_jobs ?? 0,
          totalCalls: extractionCounts.total_calls ?? 0,
          failedCalls: extractionCounts.failed_calls ?? 0,
          manualRetries: extractionCounts.manual_retries ?? 0,
          observations: extractionCounts.observations ?? 0,
          applied: extractionCounts.applied ?? 0,
          filteredSensitive: extractionCounts.filtered_sensitive ?? 0,
          filteredInvalid: extractionCounts.filtered_invalid ?? 0,
          inputTokens: extractionCounts.input_tokens ?? 0,
          outputTokens: extractionCounts.output_tokens ?? 0,
        },
        recentJobs: recentJobs.map(toUserProfileExtractionJob),
      },
    };
  }

  getContextSnapshot(): UserProfileContextSnapshot {
    const database = this.database();
    const settings = this.ensureSettings(database);
    if (!settings.useInQaContext) return { settings, items: [] };
    const rows = database.prepare(`
      SELECT item_id, profile_id, category, item_key, field_label, value_text,
             cardinality, temporal_status, assertion_kind, status, confidence,
             stability, user_locked, source_count, valid_from, valid_to,
             expires_at, revision, created_at, updated_at
      FROM user_profile_items
      WHERE profile_id = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY item_id ASC
      LIMIT ?
    `).all(DEFAULT_PROFILE_ID, new Date().toISOString(), MAX_OVERVIEW_ITEMS) as UserProfileItemRow[];
    return { settings, items: rows.map(toItem) };
  }

  saveSettings(candidate: UserProfileSettingsPatch): UserProfileSettings {
    const patch = validateSettingsPatch(candidate);

    const database = this.database();
    this.ensureSettings(database);
    const current = this.readSettings(database);
    const next = {
      autoExtractEnabled: patch.autoExtractEnabled ?? current.autoExtractEnabled,
      useInQaContext: patch.useInQaContext ?? current.useInQaContext,
      allowChat: patch.allowChat ?? current.allowChat,
      allowKnowledgeBase: patch.allowKnowledgeBase ?? current.allowKnowledgeBase,
      profileTokenBudget: patch.profileTokenBudget ?? current.profileTokenBudget,
    };
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE user_profile_settings
      SET auto_extract_enabled = ?,
          use_in_qa_context = ?,
          allow_chat = ?,
          allow_knowledge_base = ?,
          profile_token_budget = ?,
          updated_at = ?
      WHERE profile_id = ?
    `).run(
      toInteger(next.autoExtractEnabled),
      toInteger(next.useInQaContext),
      toInteger(next.allowChat),
      toInteger(next.allowKnowledgeBase),
      next.profileTokenBudget,
      now,
      DEFAULT_PROFILE_ID,
    );
    return this.readSettings(database);
  }

  upsertItem(candidate: UserProfileItemInput): UserProfileItem {
    const input = validateItemInput(candidate);
    const database = this.database();
    this.ensureSettings(database);

    return database.transaction(() => {
      const existing = input.itemId ? this.findItemRow(database, input.itemId) : undefined;
      if (input.itemId && !existing) {
        throw new UserProfileValidationError('要编辑的用户信息不存在或已被删除。');
      }
      if (existing) assertExpectedRevision(existing, input.expectedRevision);

      const itemKey = createItemKey(input.fieldLabel);
      const normalizedValue = normalizeValue(input.valueText);
      const duplicate = database.prepare(`
        SELECT item_id
        FROM user_profile_items
        WHERE profile_id = ? AND category = ? AND item_key = ? AND normalized_value = ?
          AND item_id <> ?
      `).get(
        DEFAULT_PROFILE_ID,
        input.category,
        itemKey,
        normalizedValue,
        existing?.item_id ?? '',
      ) as { item_id: string } | undefined;
      if (duplicate) {
        throw new UserProfileValidationError('相同字段和值已经存在，无需重复添加。');
      }

      const now = new Date().toISOString();
      const nextReviewAt = input.temporalStatus === 'current'
        ? getNextUserProfileReviewAt(input.category, new Date(now))
        : undefined;
      if (input.cardinality === 'single') {
        this.supersedeOtherValues(database, {
          category: input.category,
          itemKey,
          excludedItemId: existing?.item_id,
          now,
        });
      }

      if (!existing) {
        const itemId = randomUUID();
        database.prepare(`
          INSERT INTO user_profile_items (
            item_id, profile_id, category, item_key, field_label, value_text,
            normalized_value, cardinality, temporal_status, assertion_kind,
            status, confidence, stability, user_locked, source_count, expires_at,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'active', 1, 'stable', ?, 0, ?, 1, ?, ?)
        `).run(
          itemId,
          DEFAULT_PROFILE_ID,
          input.category,
          itemKey,
          input.fieldLabel,
          input.valueText,
          normalizedValue,
          input.cardinality,
          input.temporalStatus,
          toInteger(input.userLocked),
          nextReviewAt ?? null,
          now,
          now,
        );
        const created = this.requireItemRow(database, itemId);
        this.writeRevision(database, created, 'create', undefined, now);
        return toItem(created);
      }

      const nextRevision = existing.revision + 1;
      database.prepare(`
        UPDATE user_profile_items
        SET category = ?, item_key = ?, field_label = ?, value_text = ?,
            normalized_value = ?, cardinality = ?, temporal_status = ?,
            assertion_kind = 'manual', status = 'active', confidence = 1,
            stability = 'stable', user_locked = ?, expires_at = ?, revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(
        input.category,
        itemKey,
        input.fieldLabel,
        input.valueText,
        normalizedValue,
        input.cardinality,
        input.temporalStatus,
        toInteger(input.userLocked),
        nextReviewAt ?? null,
        nextRevision,
        now,
        existing.item_id,
        existing.revision,
      );
      const updated = this.requireItemRow(database, existing.item_id);
      this.writeRevision(database, updated, 'update', existing, now);
      return toItem(updated);
    })();
  }

  setLocked(candidate: UserProfileLockInput): UserProfileItem {
    const input = validateLockInput(candidate);
    const database = this.database();
    return database.transaction(() => {
      const existing = this.requireItemRow(database, input.itemId);
      assertExpectedRevision(existing, input.expectedRevision);
      if (Boolean(existing.user_locked) === input.locked) return toItem(existing);

      const now = new Date().toISOString();
      database.prepare(`
        UPDATE user_profile_items
        SET user_locked = ?, revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(
        toInteger(input.locked),
        existing.revision + 1,
        now,
        existing.item_id,
        existing.revision,
      );
      const updated = this.requireItemRow(database, existing.item_id);
      this.writeRevision(database, updated, input.locked ? 'lock' : 'unlock', existing, now);
      return toItem(updated);
    })();
  }

  deleteItem(candidate: UserProfileDeleteInput): boolean {
    const input = validateDeleteInput(candidate);
    const database = this.database();
    return database.transaction(() => {
      const existing = this.findItemRow(database, input.itemId);
      if (!existing) return false;
      assertExpectedRevision(existing, input.expectedRevision);
      return database.prepare('DELETE FROM user_profile_items WHERE item_id = ?').run(input.itemId).changes > 0;
    })();
  }

  clear(candidate: UserProfileClearScope): UserProfileClearResult {
    const scope = validateClearScope(candidate);
    const database = this.database();
    this.ensureSettings(database);
    return database.transaction(() => {
      const deletedItems = scope === 'all'
        ? database.prepare('DELETE FROM user_profile_items WHERE profile_id = ?').run(DEFAULT_PROFILE_ID).changes
        : database.prepare(`
            DELETE FROM user_profile_items
            WHERE profile_id = ? AND assertion_kind <> 'manual'
          `).run(DEFAULT_PROFILE_ID).changes;
      database.prepare('DELETE FROM user_profile_extraction_jobs WHERE profile_id = ?').run(DEFAULT_PROFILE_ID);
      return { deletedItems };
    })();
  }

  listEvidence(candidate: UserProfileEvidenceQuery): UserProfileEvidencePage {
    const input = validateEvidenceQuery(candidate);
    const database = this.database();
    this.requireItemRow(database, input.itemId);
    const rows = database.prepare(`
      SELECT evidence_id, item_id, source_turn_id, source_session_id,
             source_scope, excerpt, assertion_kind, confidence, occurred_at, created_at
      FROM user_profile_evidence
      WHERE item_id = ?
      ORDER BY occurred_at DESC, evidence_id DESC
      LIMIT ? OFFSET ?
    `).all(input.itemId, input.pageSize + 1, input.cursor) as UserProfileEvidenceRow[];
    const hasMore = rows.length > input.pageSize;
    const visible = hasMore ? rows.slice(0, input.pageSize) : rows;
    return {
      items: visible.map(toEvidence),
      ...(hasMore ? { nextCursor: input.cursor + input.pageSize } : {}),
    };
  }

  listRevisions(candidate: UserProfileRevisionQuery): UserProfileRevisionPage {
    const input = validateRevisionQuery(candidate);
    const database = this.database();
    this.requireItemRow(database, input.itemId);
    const rows = database.prepare(`
      SELECT revision_id, item_id, revision, action, actor, before_json, after_json, created_at
      FROM user_profile_revisions
      WHERE item_id = ?
      ORDER BY revision DESC, revision_id DESC
      LIMIT ? OFFSET ?
    `).all(input.itemId, input.pageSize + 1, input.cursor) as UserProfileRevisionRow[];
    const hasMore = rows.length > input.pageSize;
    const visible = hasMore ? rows.slice(0, input.pageSize) : rows;
    return {
      items: visible.map(toRevision),
      ...(hasMore ? { nextCursor: input.cursor + input.pageSize } : {}),
    };
  }

  resolveConflict(candidate: UserProfileConflictResolutionInput): UserProfileItem {
    const input = validateConflictResolutionInput(candidate);
    const database = this.database();
    return database.transaction(() => {
      const existing = this.requireItemRow(database, input.itemId);
      assertExpectedRevision(existing, input.expectedRevision);
      if (existing.cardinality !== 'single' || !['active', 'suggested'].includes(existing.status)) {
        throw new UserProfileValidationError('这条信息已不在待处理的冲突中。');
      }
      const now = new Date().toISOString();
      if (input.decision === 'keep') {
        this.supersedeOtherValues(database, {
          category: existing.category,
          itemKey: existing.item_key,
          excludedItemId: existing.item_id,
          now,
        });
      }
      database.prepare(`
        UPDATE user_profile_items
        SET status = ?, assertion_kind = 'manual', user_locked = 1,
            expires_at = ?, revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(
        input.decision === 'keep' ? 'active' : 'rejected',
        input.decision === 'keep' ? getNextUserProfileReviewAt(existing.category, new Date(now)) ?? null : null,
        existing.revision + 1,
        now,
        existing.item_id,
        existing.revision,
      );
      const updated = this.requireItemRow(database, existing.item_id);
      this.writeRevision(database, updated, 'update', existing, now);
      return toItem(updated);
    })();
  }

  reviewItem(candidate: UserProfileReviewInput): UserProfileItem {
    const input = validateReviewInput(candidate);
    const database = this.database();
    return database.transaction(() => {
      const existing = this.requireItemRow(database, input.itemId);
      assertExpectedRevision(existing, input.expectedRevision);
      if (existing.status !== 'active' || !existing.expires_at || existing.expires_at > new Date().toISOString()) {
        throw new UserProfileValidationError('这条用户信息当前不需要复核。');
      }
      const now = new Date().toISOString();
      database.prepare(`
        UPDATE user_profile_items
        SET status = ?, temporal_status = ?, valid_to = ?, expires_at = ?,
            revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(
        input.decision === 'keep' ? 'active' : 'superseded',
        input.decision === 'keep' ? 'current' : 'historical',
        input.decision === 'keep' ? null : now,
        input.decision === 'keep' ? getNextUserProfileReviewAt(existing.category, new Date(now)) ?? null : null,
        existing.revision + 1,
        now,
        existing.item_id,
        existing.revision,
      );
      const updated = this.requireItemRow(database, existing.item_id);
      this.writeRevision(database, updated, input.decision === 'keep' ? 'update' : 'supersede', existing, now);
      return toItem(updated);
    })();
  }

  rollbackItem(candidate: UserProfileRollbackInput): UserProfileItem {
    const input = validateRollbackInput(candidate);
    const database = this.database();
    return database.transaction(() => {
      const existing = this.requireItemRow(database, input.itemId);
      assertExpectedRevision(existing, input.expectedRevision);
      const revision = database.prepare(`
        SELECT revision_id, item_id, revision, action, actor, before_json, after_json, created_at
        FROM user_profile_revisions
        WHERE item_id = ? AND revision = ?
      `).get(input.itemId, input.targetRevision) as UserProfileRevisionRow | undefined;
      const snapshot = revision?.after_json ? parseRevisionSnapshot(revision.after_json) : undefined;
      if (!snapshot) throw new UserProfileValidationError('目标修订不可恢复或已损坏。');

      const normalizedValue = normalizeValue(snapshot.valueText);
      const duplicate = database.prepare(`
        SELECT item_id FROM user_profile_items
        WHERE profile_id = ? AND category = ? AND item_key = ? AND normalized_value = ?
          AND item_id <> ?
      `).get(DEFAULT_PROFILE_ID, snapshot.category, snapshot.itemKey, normalizedValue, existing.item_id) as { item_id: string } | undefined;
      if (duplicate) throw new UserProfileValidationError('目标修订与现有信息重复，无法回滚。');

      const now = new Date().toISOString();
      if (snapshot.status === 'active' && snapshot.cardinality === 'single') {
        this.supersedeOtherValues(database, {
          category: snapshot.category,
          itemKey: snapshot.itemKey,
          excludedItemId: existing.item_id,
          now,
        });
      }
      database.prepare(`
        UPDATE user_profile_items
        SET category = ?, item_key = ?, field_label = ?, value_text = ?, normalized_value = ?,
            cardinality = ?, temporal_status = ?, assertion_kind = ?, status = ?, confidence = ?,
            stability = ?, user_locked = ?, source_count = ?, valid_from = ?, valid_to = ?,
            expires_at = ?, revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(
        snapshot.category,
        snapshot.itemKey,
        snapshot.fieldLabel,
        snapshot.valueText,
        normalizedValue,
        snapshot.cardinality,
        snapshot.temporalStatus,
        snapshot.assertionKind,
        snapshot.status,
        snapshot.confidence,
        snapshot.stability,
        toInteger(snapshot.userLocked),
        snapshot.sourceCount,
        snapshot.validFrom ?? null,
        snapshot.validTo ?? null,
        snapshot.expiresAt ?? null,
        existing.revision + 1,
        now,
        existing.item_id,
        existing.revision,
      );
      const restored = this.requireItemRow(database, existing.item_id);
      this.writeRevision(database, restored, 'restore', existing, now);
      return toItem(restored);
    })();
  }

  exportJson(): UserProfileExportDocument {
    const items = this.getOverview().items
      .filter((item) => item.status === 'active')
      .slice(0, MAX_IMPORT_ITEMS)
      .map((item) => ({
        category: item.category,
        fieldLabel: item.fieldLabel,
        valueText: item.valueText,
        cardinality: item.cardinality,
        temporalStatus: item.temporalStatus,
        status: 'active' as const,
        userLocked: item.userLocked,
      }));
    return {
      format: 'menghan-notes.user-profile',
      version: 1,
      exportedAt: new Date().toISOString(),
      items,
    };
  }

  importJson(candidate: unknown): UserProfileImportSummary {
    const validated = validateImportDocument(candidate);
    const items = validated.items;
    const database = this.database();
    let importedItems = 0;
    let skippedItems = 0;
    let rejectedItems = validated.rejectedItems;
    let conflictItems = 0;

    for (const item of items) {
      if (isSensitiveProfileContent(`${item.fieldLabel} ${item.valueText}`)) {
        rejectedItems += 1;
        continue;
      }
      const itemKey = createItemKey(item.fieldLabel);
      const normalizedValue = normalizeValue(item.valueText);
      const duplicate = database.prepare(`
        SELECT item_id, status, revision FROM user_profile_items
        WHERE profile_id = ? AND category = ? AND item_key = ? AND normalized_value = ?
        LIMIT 1
      `).get(DEFAULT_PROFILE_ID, item.category, itemKey, normalizedValue) as { item_id: string; status: UserProfileItem['status']; revision: number } | undefined;
      if (duplicate?.status === 'active') {
        skippedItems += 1;
        continue;
      }
      if (item.cardinality === 'single') {
        const current = database.prepare(`
          SELECT COUNT(*) AS count FROM user_profile_items
          WHERE profile_id = ? AND category = ? AND item_key = ?
            AND status IN ('active', 'suggested') AND normalized_value <> ?
        `).get(DEFAULT_PROFILE_ID, item.category, itemKey, normalizedValue) as { count: number };
        if (current.count > 0) conflictItems += 1;
      }
      this.upsertItem({
        ...(duplicate ? { itemId: duplicate.item_id, expectedRevision: duplicate.revision } : {}),
        category: item.category,
        fieldLabel: item.fieldLabel,
        valueText: item.valueText,
        cardinality: item.cardinality,
        temporalStatus: item.temporalStatus,
        userLocked: item.userLocked,
      });
      importedItems += 1;
    }
    return { importedItems, skippedItems, rejectedItems, conflictItems };
  }

  /** Reconciles durable profile provenance after a QA session is deleted. */
  reconcileEvidence(): void {
    const database = this.database();
    database.transaction(() => {
      database.prepare(`
        UPDATE user_profile_items
        SET source_count = (SELECT COUNT(*) FROM user_profile_evidence WHERE item_id = user_profile_items.item_id)
        WHERE profile_id = ?
      `).run(DEFAULT_PROFILE_ID);
      database.prepare(`
        DELETE FROM user_profile_items
        WHERE profile_id = ? AND assertion_kind <> 'manual' AND user_locked = 0
          AND NOT EXISTS (
            SELECT 1 FROM user_profile_evidence WHERE item_id = user_profile_items.item_id
          )
      `).run(DEFAULT_PROFILE_ID);
    })();
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.workspacePath);
  }

  private ensureSettings(database: Database.Database): UserProfileSettings {
    const now = new Date().toISOString();
    database.prepare(`
      INSERT OR IGNORE INTO user_profile_settings (
        profile_id, auto_extract_enabled, use_in_qa_context, allow_chat,
        allow_knowledge_base, extraction_model_profile_id, profile_token_budget,
        created_at, updated_at
      ) VALUES (?, 0, 0, 1, 1, NULL, 600, ?, ?)
    `).run(DEFAULT_PROFILE_ID, now, now);
    return this.readSettings(database);
  }

  private readSettings(database: Database.Database): UserProfileSettings {
    const row = database.prepare(`
      SELECT profile_id, auto_extract_enabled, use_in_qa_context, allow_chat,
             allow_knowledge_base, extraction_model_profile_id,
             profile_token_budget, created_at, updated_at
      FROM user_profile_settings WHERE profile_id = ?
    `).get(DEFAULT_PROFILE_ID) as UserProfileSettingsRow | undefined;
    if (!row) throw new Error('用户信息设置初始化失败。');
    return toSettings(row);
  }

  private findItemRow(database: Database.Database, itemId: string): UserProfileItemRow | undefined {
    return database.prepare(`
      SELECT item_id, profile_id, category, item_key, field_label, value_text,
             cardinality, temporal_status, assertion_kind, status, confidence,
             stability, user_locked, source_count, valid_from, valid_to,
             expires_at, revision, created_at, updated_at
      FROM user_profile_items WHERE profile_id = ? AND item_id = ?
    `).get(DEFAULT_PROFILE_ID, itemId) as UserProfileItemRow | undefined;
  }

  private requireItemRow(database: Database.Database, itemId: string): UserProfileItemRow {
    const row = this.findItemRow(database, itemId);
    if (!row) throw new UserProfileValidationError('用户信息不存在或已被删除。');
    return row;
  }

  private supersedeOtherValues(
    database: Database.Database,
    input: { category: UserProfileCategory; itemKey: string; excludedItemId?: string; now: string },
  ): void {
    const rows = database.prepare(`
      SELECT item_id, profile_id, category, item_key, field_label, value_text,
             cardinality, temporal_status, assertion_kind, status, confidence,
             stability, user_locked, source_count, valid_from, valid_to,
             expires_at, revision, created_at, updated_at
      FROM user_profile_items
      WHERE profile_id = ? AND category = ? AND item_key = ?
        AND status IN ('active', 'suggested') AND item_id <> ?
    `).all(
      DEFAULT_PROFILE_ID,
      input.category,
      input.itemKey,
      input.excludedItemId ?? '',
    ) as UserProfileItemRow[];

    for (const row of rows) {
      database.prepare(`
        UPDATE user_profile_items
        SET status = 'superseded', revision = ?, updated_at = ?
        WHERE item_id = ? AND revision = ?
      `).run(row.revision + 1, input.now, row.item_id, row.revision);
      const updated = this.requireItemRow(database, row.item_id);
      this.writeRevision(database, updated, 'supersede', row, input.now);
    }
  }

  private writeRevision(
    database: Database.Database,
    after: UserProfileItemRow,
    action: 'create' | 'update' | 'lock' | 'unlock' | 'supersede' | 'restore',
    before: UserProfileItemRow | undefined,
    now: string,
  ): void {
    database.prepare(`
      INSERT INTO user_profile_revisions (
        revision_id, item_id, revision, action, actor, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
    `).run(
      randomUUID(),
      after.item_id,
      after.revision,
      action,
      before ? JSON.stringify(toItem(before)) : null,
      JSON.stringify(toItem(after)),
      now,
    );
  }
}

function toSettings(row: UserProfileSettingsRow): UserProfileSettings {
  return {
    profileId: row.profile_id,
    autoExtractEnabled: Boolean(row.auto_extract_enabled),
    useInQaContext: Boolean(row.use_in_qa_context),
    allowChat: Boolean(row.allow_chat),
    allowKnowledgeBase: Boolean(row.allow_knowledge_base),
    ...(row.extraction_model_profile_id ? { extractionModelProfileId: row.extraction_model_profile_id } : {}),
    profileTokenBudget: row.profile_token_budget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: UserProfileItemRow): UserProfileItem {
  return {
    itemId: row.item_id,
    profileId: row.profile_id,
    category: row.category,
    itemKey: row.item_key,
    fieldLabel: row.field_label,
    valueText: row.value_text,
    cardinality: row.cardinality,
    temporalStatus: row.temporal_status,
    assertionKind: row.assertion_kind,
    status: row.status,
    confidence: row.confidence,
    stability: row.stability,
    userLocked: Boolean(row.user_locked),
    sourceCount: row.source_count,
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to ? { validTo: row.valid_to } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvidence(row: UserProfileEvidenceRow): UserProfileEvidence {
  return {
    evidenceId: row.evidence_id,
    itemId: row.item_id,
    ...(row.source_turn_id ? { sourceTurnId: row.source_turn_id } : {}),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    sourceScope: row.source_scope,
    excerpt: row.excerpt,
    assertionKind: row.assertion_kind,
    confidence: row.confidence,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function collectConflictGroups(items: readonly UserProfileItem[]): UserProfileConflictGroup[] {
  const groups = new Map<string, UserProfileItem[]>();
  for (const item of items) {
    if (item.cardinality !== 'single' || (item.status !== 'active' && item.status !== 'suggested')) continue;
    const groupId = `${item.category}:${item.itemKey}`;
    const values = groups.get(groupId) ?? [];
    values.push(item);
    groups.set(groupId, values);
  }
  return [...groups.entries()].flatMap(([groupId, values]) => {
    if (values.length < 2) return [];
    const sorted = [...values].sort((left, right) => Number(right.userLocked) - Number(left.userLocked)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.itemId.localeCompare(right.itemId));
    return [{
      groupId,
      category: sorted[0].category,
      itemKey: sorted[0].itemKey,
      fieldLabel: sorted[0].fieldLabel,
      items: sorted,
      updatedAt: sorted.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, sorted[0].updatedAt),
    }];
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.groupId.localeCompare(right.groupId));
}

function toRevision(row: UserProfileRevisionRow): UserProfileRevision {
  const before = row.before_json ? parseRevisionSnapshot(row.before_json) : undefined;
  const after = row.after_json ? parseRevisionSnapshot(row.after_json) : undefined;
  return {
    revisionId: row.revision_id,
    itemId: row.item_id,
    revision: row.revision,
    action: row.action,
    actor: row.actor,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    createdAt: row.created_at,
  };
}

function parseRevisionSnapshot(value: string): UserProfileRevisionSnapshot | undefined {
  try {
    const input = requireRecord(JSON.parse(value) as unknown, '画像修订快照无效。');
    if (!USER_PROFILE_CATEGORIES.includes(input.category as UserProfileCategory)) return undefined;
    if (input.cardinality !== 'single' && input.cardinality !== 'multiple') return undefined;
    if (input.temporalStatus !== 'current' && input.temporalStatus !== 'historical' && input.temporalStatus !== 'unspecified') return undefined;
    if (input.assertionKind !== 'manual' && input.assertionKind !== 'explicit' && input.assertionKind !== 'inferred') return undefined;
    if (input.status !== 'active' && input.status !== 'suggested' && input.status !== 'rejected' && input.status !== 'superseded') return undefined;
    if (input.stability !== 'stable' && input.stability !== 'long-term' && input.stability !== 'contextual') return undefined;
    if (typeof input.userLocked !== 'boolean') return undefined;
    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) return undefined;
    if (!Number.isSafeInteger(input.sourceCount) || (input.sourceCount as number) < 0) return undefined;
    const optionalDate = (candidate: unknown): string | undefined => typeof candidate === 'string' && candidate.length <= 64 ? candidate : undefined;
    return {
      category: input.category as UserProfileCategory,
      itemKey: requiredText(input.itemKey, 128, '画像字段 Key'),
      fieldLabel: requiredText(input.fieldLabel, MAX_FIELD_LABEL_CHARS, '字段名称'),
      valueText: requiredText(input.valueText, MAX_VALUE_TEXT_CHARS, '信息内容'),
      cardinality: input.cardinality,
      temporalStatus: input.temporalStatus,
      assertionKind: input.assertionKind,
      status: input.status,
      confidence: input.confidence,
      stability: input.stability,
      userLocked: input.userLocked,
      sourceCount: input.sourceCount as number,
      ...(optionalDate(input.validFrom) ? { validFrom: optionalDate(input.validFrom)! } : {}),
      ...(optionalDate(input.validTo) ? { validTo: optionalDate(input.validTo)! } : {}),
      ...(optionalDate(input.expiresAt) ? { expiresAt: optionalDate(input.expiresAt)! } : {}),
    };
  } catch {
    return undefined;
  }
}

function validateSettingsPatch(candidate: UserProfileSettingsPatch): UserProfileSettingsPatch {
  const value = requireRecord(candidate, '用户信息设置参数无效。');
  const patch: UserProfileSettingsPatch = {};
  for (const key of ['autoExtractEnabled', 'useInQaContext', 'allowChat', 'allowKnowledgeBase'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new UserProfileValidationError('用户信息设置开关必须是布尔值。');
      patch[key] = value[key];
    }
  }
  if (value.profileTokenBudget !== undefined) {
    if (!Number.isSafeInteger(value.profileTokenBudget) || value.profileTokenBudget < 128 || value.profileTokenBudget > 4000) {
      throw new UserProfileValidationError('用户信息上下文预算必须在 128 到 4000 之间。');
    }
    patch.profileTokenBudget = value.profileTokenBudget;
  }
  return patch;
}

function validateItemInput(candidate: UserProfileItemInput): UserProfileItemInput {
  const value = requireRecord(candidate, '用户信息参数无效。');
  const itemId = optionalIdentifier(value.itemId, '用户信息 ID 无效。');
  if (!USER_PROFILE_CATEGORIES.includes(value.category as UserProfileCategory)) {
    throw new UserProfileValidationError('用户信息分类无效。');
  }
  const fieldLabel = requiredText(value.fieldLabel, MAX_FIELD_LABEL_CHARS, '字段名称');
  const valueText = requiredText(value.valueText, MAX_VALUE_TEXT_CHARS, '信息内容');
  if (isSensitiveProfileContent(`${fieldLabel} ${valueText}`)) {
    throw new UserProfileValidationError('用户画像不能保存密码、密钥、证件号或其他受保护的敏感信息。');
  }
  if (value.cardinality !== 'single' && value.cardinality !== 'multiple') {
    throw new UserProfileValidationError('字段关系必须是单值或多值。');
  }
  if (value.temporalStatus !== 'current' && value.temporalStatus !== 'historical' && value.temporalStatus !== 'unspecified') {
    throw new UserProfileValidationError('时间状态无效。');
  }
  if (typeof value.userLocked !== 'boolean') throw new UserProfileValidationError('锁定状态无效。');
  const expectedRevision = optionalRevision(value.expectedRevision);
  return {
    ...(itemId ? { itemId } : {}),
    category: value.category as UserProfileCategory,
    fieldLabel,
    valueText,
    cardinality: value.cardinality,
    temporalStatus: value.temporalStatus,
    userLocked: value.userLocked,
    ...(expectedRevision ? { expectedRevision } : {}),
  };
}

function validateLockInput(candidate: UserProfileLockInput): UserProfileLockInput {
  const value = requireRecord(candidate, '锁定参数无效。');
  const itemId = requiredIdentifier(value.itemId, '用户信息 ID 无效。');
  if (typeof value.locked !== 'boolean') throw new UserProfileValidationError('锁定状态无效。');
  return { itemId, locked: value.locked, expectedRevision: requiredRevision(value.expectedRevision) };
}

function validateDeleteInput(candidate: UserProfileDeleteInput): UserProfileDeleteInput {
  const value = requireRecord(candidate, '删除参数无效。');
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    expectedRevision: requiredRevision(value.expectedRevision),
  };
}

function validateClearScope(candidate: UserProfileClearScope): UserProfileClearScope {
  if (candidate !== 'all' && candidate !== 'ai-only') throw new UserProfileValidationError('清空范围无效。');
  return candidate;
}

function validateEvidenceQuery(candidate: UserProfileEvidenceQuery): Required<UserProfileEvidenceQuery> {
  const value = requireRecord(candidate, '证据查询参数无效。');
  const cursor = value.cursor ?? 0;
  const pageSize = value.pageSize ?? DEFAULT_EVIDENCE_PAGE_SIZE;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new UserProfileValidationError('证据分页游标无效。');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_EVIDENCE_PAGE_SIZE) {
    throw new UserProfileValidationError(`证据分页大小必须在 1 到 ${MAX_EVIDENCE_PAGE_SIZE} 之间。`);
  }
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    cursor,
    pageSize,
  };
}

function validateRevisionQuery(candidate: UserProfileRevisionQuery): Required<UserProfileRevisionQuery> {
  const value = requireRecord(candidate, '修订记录查询参数无效。');
  const cursor = value.cursor ?? 0;
  const pageSize = value.pageSize ?? DEFAULT_REVISION_PAGE_SIZE;
  if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new UserProfileValidationError('修订分页游标无效。');
  if (!Number.isSafeInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > MAX_REVISION_PAGE_SIZE) {
    throw new UserProfileValidationError(`修订分页大小必须在 1 到 ${MAX_REVISION_PAGE_SIZE} 之间。`);
  }
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    cursor: cursor as number,
    pageSize: pageSize as number,
  };
}

function validateConflictResolutionInput(candidate: UserProfileConflictResolutionInput): UserProfileConflictResolutionInput {
  const value = requireRecord(candidate, '画像冲突处理参数无效。');
  if (value.decision !== 'keep' && value.decision !== 'reject') throw new UserProfileValidationError('画像冲突处理决定无效。');
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    expectedRevision: requiredRevision(value.expectedRevision),
    decision: value.decision,
  };
}

function validateReviewInput(candidate: UserProfileReviewInput): UserProfileReviewInput {
  const value = requireRecord(candidate, '画像复核参数无效。');
  if (value.decision !== 'keep' && value.decision !== 'archive') throw new UserProfileValidationError('画像复核决定无效。');
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    expectedRevision: requiredRevision(value.expectedRevision),
    decision: value.decision,
  };
}

function validateRollbackInput(candidate: UserProfileRollbackInput): UserProfileRollbackInput {
  const value = requireRecord(candidate, '画像回滚参数无效。');
  return {
    itemId: requiredIdentifier(value.itemId, '用户信息 ID 无效。'),
    targetRevision: requiredRevision(value.targetRevision),
    expectedRevision: requiredRevision(value.expectedRevision),
  };
}

function validateImportDocument(candidate: unknown): { items: UserProfileItemInput[]; rejectedItems: number } {
  const document = requireRecord(candidate, '用户画像 JSON 格式无效。');
  if (document.format !== 'menghan-notes.user-profile' || document.version !== 1 || !Array.isArray(document.items)) {
    throw new UserProfileValidationError('仅支持Trellora 用户画像 JSON v1。');
  }
  if (document.items.length > MAX_IMPORT_ITEMS) {
    throw new UserProfileValidationError(`一次最多导入 ${MAX_IMPORT_ITEMS} 条用户信息。`);
  }
  const items: UserProfileItemInput[] = [];
  let rejectedItems = 0;
  for (const candidateItem of document.items) {
    try {
      const item = requireRecord(candidateItem, '导入条目格式无效。');
      if (item.status !== 'active') throw new UserProfileValidationError('导入文件只能包含已启用的画像条目。');
      items.push(validateItemInput({
        category: item.category,
        fieldLabel: item.fieldLabel,
        valueText: item.valueText,
        cardinality: item.cardinality,
        temporalStatus: item.temporalStatus,
        userLocked: item.userLocked,
      } as UserProfileItemInput));
    } catch {
      rejectedItems += 1;
    }
  }
  return { items, rejectedItems };
}

function requireRecord(candidate: unknown, message: string): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new UserProfileValidationError(message);
  }
  return candidate as Record<string, unknown>;
}

function requiredText(candidate: unknown, maxChars: number, label: string): string {
  if (typeof candidate !== 'string') throw new UserProfileValidationError(`${label}必须是文本。`);
  const value = candidate.trim();
  if (!value) throw new UserProfileValidationError(`${label}不能为空。`);
  if ([...value].length > maxChars) throw new UserProfileValidationError(`${label}不能超过 ${maxChars} 个字符。`);
  return value;
}

function optionalIdentifier(candidate: unknown, message: string): string | undefined {
  if (candidate === undefined) return undefined;
  return requiredIdentifier(candidate, message);
}

function requiredIdentifier(candidate: unknown, message: string): string {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 128) {
    throw new UserProfileValidationError(message);
  }
  return candidate.trim();
}

function optionalRevision(candidate: unknown): number | undefined {
  if (candidate === undefined) return undefined;
  return requiredRevision(candidate);
}

function requiredRevision(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new UserProfileValidationError('用户信息修订版本无效。');
  }
  return candidate as number;
}

function assertExpectedRevision(row: UserProfileItemRow, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined || row.revision !== expectedRevision) {
    throw new UserProfileRevisionConflictError('这条用户信息已在别处更新，请刷新后重试。');
  }
}

function createItemKey(fieldLabel: string): string {
  const slug = fieldLabel
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `custom.${slug || 'field'}`;
}

function normalizeValue(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function toInteger(value: boolean): number {
  return value ? 1 : 0;
}
