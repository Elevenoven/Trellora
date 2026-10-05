import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from './qaMemoryDatabase';
import { getNextUserProfileReviewAt } from './userProfileLifecycle';
import {
  getUserProfileFieldPolicy,
  hasUserProfileSelfSignal,
  isSensitiveProfileContent,
  isThirdPartyProfileClaim,
  normalizeProfileValue,
} from './userProfileExtractor';
import type {
  UserProfileExtractionSource,
  UserProfileItem,
  UserProfileMergeResult,
  UserProfileObservation,
} from './userProfileTypes';

const DEFAULT_PROFILE_ID = 'default';

interface MergeItemRow {
  item_id: string;
  profile_id: string;
  category: UserProfileItem['category'];
  item_key: string;
  field_label: string;
  value_text: string;
  normalized_value: string;
  cardinality: UserProfileItem['cardinality'];
  temporal_status: UserProfileItem['temporalStatus'];
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

const MERGE_ITEM_COLUMNS = `
  item_id, profile_id, category, item_key, field_label, value_text,
  normalized_value, cardinality, temporal_status, assertion_kind, status,
  confidence, stability, user_locked, source_count, valid_from, valid_to,
  expires_at, revision, created_at, updated_at
`;

/**
 * Applies validated observations under deterministic privacy, provenance and
 * conflict rules. The model never receives direct write authority.
 */
export class UserProfileMergeService {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly workspacePath: string,
  ) {}

  merge(source: UserProfileExtractionSource, observations: UserProfileObservation[]): UserProfileMergeResult {
    const database = this.databaseOwner.getDatabase(this.workspacePath);
    return database.transaction(() => {
      let appliedCount = 0;
      let sensitiveFilteredCount = 0;
      let invalidFilteredCount = 0;
      const acceptedCategories = new Set<UserProfileItem['category']>();

      for (const observation of observations) {
        const policy = getUserProfileFieldPolicy(observation.category, observation.key);
        if (!policy || observation.stability === 'turn-only') {
          invalidFilteredCount += 1;
          continue;
        }
        if (isSensitiveProfileContent(`${observation.key} ${observation.value} ${observation.evidenceQuote}`)) {
          sensitiveFilteredCount += 1;
          continue;
        }
        if (isThirdPartyProfileClaim(observation.evidenceQuote)
          || !hasUserProfileSelfSignal(observation.evidenceQuote, source.previousAssistantQuestion)) {
          invalidFilteredCount += 1;
          continue;
        }

        acceptedCategories.add(observation.category);
        if (this.mergeObservation(database, source, observation, policy)) appliedCount += 1;
      }

      return {
        appliedCount,
        sensitiveFilteredCount,
        invalidFilteredCount,
        acceptedCategories: [...acceptedCategories],
      };
    })();
  }

  private mergeObservation(
    database: Database.Database,
    source: UserProfileExtractionSource,
    observation: UserProfileObservation,
    policy: NonNullable<ReturnType<typeof getUserProfileFieldPolicy>>,
  ): boolean {
    const now = new Date().toISOString();
    const nextReviewAt = getNextUserProfileReviewAt(observation.category, new Date(now));
    const normalizedValue = normalizeProfileValue(observation.value);
    const sameValue = database.prepare(`
      SELECT ${MERGE_ITEM_COLUMNS}
      FROM user_profile_items
      WHERE profile_id = ? AND category = ? AND normalized_value = ?
        AND (item_key = ? OR field_label = ?)
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END,
               updated_at DESC
      LIMIT 1
    `).get(
      DEFAULT_PROFILE_ID,
      observation.category,
      normalizedValue,
      observation.key,
      policy.label,
    ) as MergeItemRow | undefined;

    if (sameValue) {
      const evidenceInserted = this.insertEvidence(database, sameValue.item_id, source, observation, now);
      const shouldPromote = (sameValue.status === 'suggested' || sameValue.status === 'superseded')
        && observation.assertion === 'explicit'
        && !sameValue.user_locked
        && this.canPromote(database, sameValue, policy.key, policy.label);
      if (!evidenceInserted && !shouldPromote) return false;

      const before = { ...sameValue };
      if (shouldPromote && policy.cardinality === 'single') {
        for (const conflict of this.findCurrentFieldValues(database, sameValue.category, policy.key, policy.label)) {
          if (conflict.item_id !== sameValue.item_id) this.supersede(database, conflict, now);
        }
      }
      const nextRevision = shouldPromote ? sameValue.revision + 1 : sameValue.revision;
      database.prepare(`
        UPDATE user_profile_items
        SET status = ?, assertion_kind = ?, confidence = MAX(confidence, ?),
            source_count = (SELECT COUNT(*) FROM user_profile_evidence WHERE item_id = ?),
            expires_at = ?, revision = ?, updated_at = ?
        WHERE item_id = ?
      `).run(
        shouldPromote ? 'active' : sameValue.status,
        shouldPromote ? 'explicit' : sameValue.assertion_kind,
        observation.confidence,
        sameValue.item_id,
        nextReviewAt ?? sameValue.expires_at,
        nextRevision,
        now,
        sameValue.item_id,
      );
      if (shouldPromote) {
        this.writeRevision(
          database,
          this.requireItem(database, sameValue.item_id),
          sameValue.status === 'superseded' ? 'restore' : 'update',
          before,
          now,
        );
      }
      return true;
    }

    let status: UserProfileItem['status'] = observation.assertion === 'explicit' ? 'active' : 'suggested';
    if (policy.cardinality === 'single') {
      const conflicts = this.findCurrentFieldValues(database, observation.category, policy.key, policy.label);
      if (conflicts.some((item) => Boolean(item.user_locked))) {
        status = 'suggested';
      } else if (observation.assertion === 'explicit') {
        for (const conflict of conflicts) this.supersede(database, conflict, now);
      } else {
        status = 'suggested';
      }
    }

    const itemId = randomUUID();
    database.prepare(`
      INSERT INTO user_profile_items (
        item_id, profile_id, category, item_key, field_label, value_text,
        normalized_value, cardinality, temporal_status, assertion_kind,
        status, confidence, stability, user_locked, source_count, revision,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, 0, 0, 1, ?, ?, ?)
    `).run(
      itemId,
      DEFAULT_PROFILE_ID,
      observation.category,
      policy.key,
      policy.label,
      observation.value,
      normalizedValue,
      policy.cardinality,
      observation.assertion,
      status,
      observation.confidence,
      observation.stability === 'long-term' ? 'long-term' : 'stable',
      nextReviewAt ?? null,
      now,
      now,
    );
    this.insertEvidence(database, itemId, source, observation, now);
    database.prepare(`
      UPDATE user_profile_items
      SET source_count = (SELECT COUNT(*) FROM user_profile_evidence WHERE item_id = ?)
      WHERE item_id = ?
    `).run(itemId, itemId);
    this.writeRevision(database, this.requireItem(database, itemId), 'create', undefined, now);
    return true;
  }

  private canPromote(database: Database.Database, item: MergeItemRow, key: string, label: string): boolean {
    if (item.cardinality === 'multiple') return true;
    return !this.findCurrentFieldValues(database, item.category, key, label)
      .some((candidate) => candidate.item_id !== item.item_id && Boolean(candidate.user_locked));
  }

  private findCurrentFieldValues(
    database: Database.Database,
    category: UserProfileItem['category'],
    key: string,
    label: string,
  ): MergeItemRow[] {
    return database.prepare(`
      SELECT ${MERGE_ITEM_COLUMNS}
      FROM user_profile_items
      WHERE profile_id = ? AND category = ?
        AND (item_key = ? OR field_label = ?)
        AND status IN ('active', 'suggested')
      ORDER BY user_locked DESC, updated_at DESC
    `).all(DEFAULT_PROFILE_ID, category, key, label) as MergeItemRow[];
  }

  private supersede(database: Database.Database, item: MergeItemRow, now: string): void {
    database.prepare(`
      UPDATE user_profile_items
      SET status = 'superseded', revision = ?, updated_at = ?
      WHERE item_id = ? AND revision = ? AND user_locked = 0
    `).run(item.revision + 1, now, item.item_id, item.revision);
    this.writeRevision(database, this.requireItem(database, item.item_id), 'supersede', item, now);
  }

  private insertEvidence(
    database: Database.Database,
    itemId: string,
    source: UserProfileExtractionSource,
    observation: UserProfileObservation,
    now: string,
  ): boolean {
    return database.prepare(`
      INSERT OR IGNORE INTO user_profile_evidence (
        evidence_id, item_id, source_turn_id, source_session_id, source_scope,
        excerpt, assertion_kind, confidence, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      itemId,
      source.job.sourceTurnId,
      source.job.sessionId,
      source.job.scope,
      observation.evidenceQuote,
      observation.assertion,
      observation.confidence,
      now,
      now,
    ).changes > 0;
  }

  private requireItem(database: Database.Database, itemId: string): MergeItemRow {
    const row = database.prepare(`
      SELECT ${MERGE_ITEM_COLUMNS} FROM user_profile_items WHERE item_id = ?
    `).get(itemId) as MergeItemRow | undefined;
    if (!row) throw new Error('画像合并目标不存在。');
    return row;
  }

  private writeRevision(
    database: Database.Database,
    after: MergeItemRow,
    action: 'create' | 'update' | 'supersede' | 'restore',
    before: MergeItemRow | undefined,
    now: string,
  ): void {
    database.prepare(`
      INSERT INTO user_profile_revisions (
        revision_id, item_id, revision, action, actor, before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, 'extractor', ?, ?, ?)
    `).run(
      randomUUID(),
      after.item_id,
      after.revision,
      action,
      before ? JSON.stringify(toAuditItem(before)) : null,
      JSON.stringify(toAuditItem(after)),
      now,
    );
  }
}

function toAuditItem(row: MergeItemRow): Record<string, unknown> {
  return {
    itemId: row.item_id,
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
    updatedAt: row.updated_at,
  };
}
