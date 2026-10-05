import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONTRACT_VERSION, MEMORY_CONSTANTS, MEMORY_KINDS, MEMORY_STATUSES, type MemoryKind, type MemoryOrigin } from './memoryConstants';
import { ensureScopeRows, MemoryRepository, runInImmediateTransaction } from './memoryRepository';
import {
  isMostlyRedacted,
  memoryFingerprint,
  memoryItemKey,
  redactSensitiveMemoryContent,
  sanitizeMemoryContent,
  sanitizeMemoryTopic,
  truncateCodePoints,
} from './memoryText';
import { readMemoryPage } from './memoryPagination';
import type {
  AgentMemoryConfig,
  ManualMemoryInput,
  MemoryClearResult,
  MemoryExportDocument,
  MemoryImportResult,
  MemoryItemListQuery,
  MemoryItemPageQuery,
  MemoryItemCounts,
  MemoryPage,
  MemoryItemPage,
  MemoryItemPatch,
  MemoryItemRecord,
  MemoryWriteInput,
  MemoryWriteResult,
  TrustedMemoryScope,
  WorkspaceMemoryConfig,
  MemoryProposalReview,
  MemoryProposalContext,
} from './memoryTypes';
import { independentMemoryKey, isExplicitMemoryCorrection, mapMemoryItemMetadata,
  memoryProposalFingerprint, memoryTargetFingerprint, memoryTargetSnapshot, sameMemoryStatement,
  type MemoryItemMetadataRow } from './memoryWritePolicy';

interface MemoryItemRow extends MemoryItemMetadataRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  kind: MemoryKind;
  content: string;
  topic: string;
  normalized_key: string;
  importance: number;
  origin: MemoryOrigin;
  status: MemoryItemRecord['status'];
  source_session_id: string | null;
  source_message_id: string | null;
  valid_from: string;
  invalid_at: string | null;
  expires_at: string | null;
  superseded_by: string | null;
  last_used_at: string | null;
  use_count: number;
  memory_generation: number;
  created_at: string;
  updated_at: string;
}

interface TombstoneRow {
  id: string;
  source_message_id: string | null;
  created_at: string;
}

export class MemoryWriteError extends Error {
  constructor(
    readonly code:
      | 'MEMORY_DISABLED'
      | 'MEMORY_INPUT_INVALID'
      | 'MEMORY_SENSITIVE_CONTENT'
      | 'MEMORY_PREVIOUSLY_FORGOTTEN'
      | 'MEMORY_WRITE_CONFLICT'
      | 'MEMORY_ITEM_NOT_FOUND'
      | 'MEMORY_CONFIRM_REQUIRES_PENDING'
      | 'SOURCE_CHANGED'
      | 'EXPIRY_MISMATCH'
      | 'SOURCE_EXPIRED'
      | 'TARGET_CONFLICT'
      | 'STALE_MEMORY_GENERATION'
      | 'MEMORY_PROTOCOL_UPGRADE_REQUIRED'
      | 'PROPOSAL_REVIEW_REQUIRED'
      | 'PROPOSAL_CHANGED'
      | 'TARGET_CHANGED'
      | 'TARGET_EXPIRED'
      | 'RETIRE_PROPOSAL_READ_ONLY'
      | 'USER_REVIEW_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The only L4 mutator. Every write enters through this service so redaction,
 * tombstones, replacement, capacity and resident-block maintenance cannot
 * diverge between explicit, extracted and manual paths.
 */
export class MemoryWriteService {
  private readonly repository: MemoryRepository;

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {
    this.repository = new MemoryRepository(databaseOwner, storageWorkspacePath);
  }

  getWorkspaceConfig(scope: TrustedMemoryScope): WorkspaceMemoryConfig {
    return this.repository.getWorkspaceConfig(scope);
  }

  getSubject(scope: TrustedMemoryScope) {
    return this.repository.ensureSubject(scope);
  }

  updateWorkspaceConfig(scope: TrustedMemoryScope, patch: Partial<WorkspaceMemoryConfig>): WorkspaceMemoryConfig {
    return this.repository.updateWorkspaceConfig(scope, patch);
  }

  setPrincipalEnabled(scope: TrustedMemoryScope, enabled: boolean): { enabled: boolean } {
    return this.repository.setPrincipalEnabled(scope, enabled);
  }

  getAvailability(scope: TrustedMemoryScope, agent: AgentMemoryConfig = {}) {
    return this.repository.resolveAvailability(scope, agent);
  }

  writeExplicit(
    scope: TrustedMemoryScope,
    content: string,
    source: { sessionId?: string | null; messageId?: string | null },
    agent: AgentMemoryConfig = {},
  ): MemoryWriteResult {
    return this.write(scope, {
      operation: 'add',
      kind: 'fact',
      content,
      importance: MEMORY_CONSTANTS.writeAndExtraction.importance.explicit,
      origin: 'explicit',
      sourceSessionId: source.sessionId ?? null,
      sourceMessageId: source.messageId ?? null,
    }, agent);
  }

  createManual(scope: TrustedMemoryScope, input: ManualMemoryInput): MemoryWriteResult {
    return this.write(scope, { ...input, origin: 'manual', operation: 'add' });
  }

  write(scope: TrustedMemoryScope, input: MemoryWriteInput, agent: AgentMemoryConfig = {}): MemoryWriteResult {
    const availability = this.repository.resolveAvailability(scope, agent);
    if (!availability.enabled) throw new MemoryWriteError('MEMORY_DISABLED', '长期记忆当前未启用。');
    const prepared = prepareWrite(input);
    if (input.origin === 'extracted' && !input.operation) {
      throw new MemoryWriteError('MEMORY_PROTOCOL_UPGRADE_REQUIRED', '自动提炼协议正在升级，旧来源已保留。');
    }
    const operation = input.operation ?? 'add';
    if (!['add', 'replace', 'retire'].includes(operation)) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆操作无效。');
    const database = this.database();
    const timestamp = new Date().toISOString();

    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const subject = requireSubject(database, scope);
      if ((prepared.origin === 'extracted' || prepared.memoryGeneration !== undefined)
        && (prepared.memoryGeneration === undefined || prepared.memoryGeneration !== subject.memory_generation)) {
        throw new MemoryWriteError('STALE_MEMORY_GENERATION', '提炼任务所属的记忆代际已过期。');
      }
      assertNoTombstone(database, scope, prepared, subject.memory_generation, timestamp);
      let target: MemoryItemRow | undefined;
      if (operation !== 'add') {
        if (!input.targetItemId || !input.expectedTargetFingerprint) throw new MemoryWriteError('PROPOSAL_REVIEW_REQUIRED', '替换或撤销必须指定已展示的旧记忆。');
        target = findItem(database, scope, input.targetItemId);
        assertProposalTarget(target, subject.memory_generation, input.expectedTargetFingerprint, timestamp);
        if (operation === 'retire' && !sameMemoryStatement(prepared.content, target!.content)) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '撤销提案必须保留旧正文快照。');
        const pending = database.prepare(`SELECT * FROM memory_items WHERE workspace_id = ? AND principal_id = ?
          AND replaces_id = ? AND status = 'pending'`).get(scope.workspaceId, scope.principalId, target!.id) as MemoryItemRow | undefined;
        if (pending) {
          if (pending.proposal_action === operation && pending.content === prepared.content
            && pending.expires_at === prepared.expiresAt && pending.replaces_fingerprint === input.expectedTargetFingerprint) {
            return { action: 'unchanged', item: mapItemRow(pending), redacted: prepared.redacted, archivedItemIds: [] };
          }
          throw new MemoryWriteError('MEMORY_WRITE_CONFLICT', '这条旧记忆已有其他待确认提案，请先处理。');
        }
      } else {
        if (input.targetItemId || input.expectedTargetFingerprint) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '新增不能隐式指定替换目标。');
        const duplicate = listLiveSameKind(database, scope, prepared.kind).find(candidate =>
          candidate.proposal_action !== 'retire' && candidate.proposal_action !== 'replace'
          && candidate.memory_generation === subject.memory_generation
          && candidate.expires_at === prepared.expiresAt && !isExpired(candidate.expires_at, timestamp)
          && sameMemoryStatement(candidate.content, prepared.content));
        // Explicit and extraction may describe the same fact under different kinds.
        const explicitDuplicate = prepared.origin === 'extracted' && prepared.sourceMessageId
          ? database.prepare(`SELECT * FROM memory_items WHERE workspace_id = ? AND principal_id = ?
            AND source_message_id = ? AND memory_generation = ? AND origin = 'explicit'
            AND status IN ('active','pending') ORDER BY status = 'active' DESC`).all(scope.workspaceId, scope.principalId,
              prepared.sourceMessageId, subject.memory_generation) as MemoryItemRow[] : [];
        const reused = duplicate ?? explicitDuplicate.find(candidate => candidate.expires_at === prepared.expiresAt
          && candidate.proposal_action !== 'retire' && sameMemoryStatement(candidate.content, prepared.content));
        if (reused) return { action: 'unchanged', item: mapItemRow(reused), redacted: prepared.redacted, archivedItemIds: [] };
      }
      const correction = prepared.origin === 'explicit' && isExplicitMemoryCorrection(prepared.content)
        && database.prepare(`SELECT 1 FROM memory_items WHERE workspace_id = ? AND principal_id = ? AND status = 'active' LIMIT 1`)
          .get(scope.workspaceId, scope.principalId);
      const status = operation !== 'add' || correction || input.reviewReason ? 'pending' : prepared.status;
      const reason = status === 'pending' ? input.reviewReason ?? (correction ? 'AMBIGUOUS_RELATION'
        : operation === 'replace' ? 'TARGET_REPLACEMENT' : operation === 'retire' ? 'TARGET_RETIREMENT' : 'INFERRED_FACT') : null;
      let key = target?.normalized_key ?? prepared.normalizedKey;
      if (!target && findLiveByKey(database, scope, prepared.kind, key)) key = independentMemoryKey(key, prepared.content);
      const collision = database.prepare(`SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ?
        AND kind = ? AND normalized_key = ? AND status = ?`).get(scope.workspaceId, scope.principalId, prepared.kind, key, status);
      if (collision) throw new MemoryWriteError('MEMORY_WRITE_CONFLICT', '该信息存在不同有效期或待审内容，请选择原条目编辑。');
      const id = randomUUID();
      database.prepare(`
          INSERT INTO memory_items (
            id, workspace_id, principal_id, kind, content, topic, normalized_key,
            importance, origin, status, source_session_id, source_message_id,
            valid_from, expires_at, memory_generation, created_at, updated_at,
            proposal_action, replaces_id, replaces_fingerprint, replaces_snapshot_json, review_reason, write_protection
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, scope.workspaceId, scope.principalId, prepared.kind, prepared.content, prepared.topic,
          key, prepared.importance, prepared.origin, status,
          prepared.sourceSessionId, prepared.sourceMessageId, timestamp, prepared.expiresAt,
          subject.memory_generation, timestamp, timestamp, status === 'pending' ? operation : null,
          target?.id ?? null, target ? input.expectedTargetFingerprint : null,
          target ? JSON.stringify(memoryTargetSnapshot(mapItemRow(target))) : null, reason,
          prepared.origin === 'extracted' ? 'none' : 'user',
        );
      const archivedItemIds = status === 'active' ? enforceActiveCapacity(database, scope, this.repository.getWorkspaceConfig(scope).maxItems, timestamp) : [];
      for (const archivedItemId of archivedItemIds) {
        database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id = ? AND workspace_id = ? AND principal_id = ?`)
          .run(archivedItemId, scope.workspaceId, scope.principalId);
      }
      refreshSubjectCache(database, scope, timestamp);
      const item = requireItem(database, scope, id);
      return {
        action: 'created',
        item,
        redacted: prepared.redacted,
        archivedItemIds,
      };
    });
  }

  updateManual(scope: TrustedMemoryScope, itemId: string, patch: MemoryItemPatch): MemoryItemRecord {
    const database = this.database();
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const existing = findItem(database, scope, itemId);
      if (!existing || !isLive(existing)) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '当前有效记忆不存在。');
      if (existing.proposal_action === 'retire') throw new MemoryWriteError('RETIRE_PROPOSAL_READ_ONLY', '撤销提案正文只读；需要更正请先拒绝提案，再编辑原记忆。');
      if (patch.expectedFingerprint && patch.expectedFingerprint !== (existing.status === 'pending'
        ? memoryProposalFingerprint(mapItemRow(existing)) : memoryTargetFingerprint(mapItemRow(existing)))) {
        throw new MemoryWriteError('TARGET_CHANGED', '记忆已变化，请刷新后重新编辑。');
      }
      const prepared = prepareWrite({
        kind: patch.kind ?? existing.kind,
        content: patch.content ?? existing.content,
        topic: patch.topic ?? existing.topic,
        importance: patch.importance ?? existing.importance,
        expiresAt: patch.expiresAt === undefined ? existing.expires_at : patch.expiresAt,
        origin: 'manual',
        sourceSessionId: existing.source_session_id,
        sourceMessageId: existing.source_message_id,
      });
      let key = existing.proposal_action === 'replace' || prepared.kind === existing.kind && prepared.topic === existing.topic
        ? existing.normalized_key : prepared.normalizedKey;
      const duplicate = database.prepare(`SELECT * FROM memory_items WHERE workspace_id = ? AND principal_id = ?
        AND kind = ? AND normalized_key = ? AND status = ?`).get(scope.workspaceId, scope.principalId, prepared.kind, key, existing.status) as MemoryItemRow | undefined;
      if (duplicate && duplicate.id !== existing.id) {
        key = independentMemoryKey(key, prepared.content);
      }
      if (existing.status === 'active') invalidateTargetProposals(database, scope, existing.id, timestamp, 'TARGET_CHANGED');
      database.prepare(`
        UPDATE memory_items
        SET kind = ?, content = ?, topic = ?, normalized_key = ?, importance = ?, origin = 'manual',
            write_protection = 'user', invalid_at = NULL, expires_at = ?, superseded_by = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ?
      `).run(
        prepared.kind, prepared.content, prepared.topic, key, prepared.importance,
        prepared.expiresAt, timestamp, existing.id, scope.workspaceId, scope.principalId,
      );
      database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id = ? AND workspace_id = ? AND principal_id = ?`)
        .run(existing.id, scope.workspaceId, scope.principalId);
      const archivedItemIds = existing.status === 'active' ? enforceActiveCapacity(database, scope, this.repository.getWorkspaceConfig(scope).maxItems, timestamp) : [];
      for (const archivedItemId of archivedItemIds) {
        database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id = ? AND workspace_id = ? AND principal_id = ?`)
          .run(archivedItemId, scope.workspaceId, scope.principalId);
      }
      refreshSubjectCache(database, scope, timestamp);
      return requireItem(database, scope, existing.id);
    });
  }

  /** Review data is scoped by the main process; imported or unrelated turns never become source evidence. */
  getProposalContext(scope: TrustedMemoryScope, itemId: string): MemoryProposalContext {
    const row = findItem(this.database(), scope, itemId);
    if (!row) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '记忆不存在。');
    const proposal = mapItemRow(row);
    const targetRow = row.replaces_id ? findItem(this.database(), scope, row.replaces_id) : undefined;
    const currentTarget = targetRow ? mapItemRow(targetRow) : null;
    const timestamp = new Date().toISOString();
    const invalidReason = currentTarget && isExpired(currentTarget.expiresAt, timestamp) ? 'TARGET_EXPIRED'
      : row.replaces_id && (!currentTarget || currentTarget.status !== 'active'
        || memoryTargetFingerprint(currentTarget) !== row.replaces_fingerprint) ? 'TARGET_CHANGED' : null;
    const source = proposal.sourceMessageId ? this.database().prepare(`SELECT user_text FROM qa_turns WHERE turn_id = ?
      AND session_id = ? AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
      AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?
      AND json_extract(result_metadata_json, '$.memoryExtractionGeneration') = ?`).get(proposal.sourceMessageId,
        proposal.sourceSessionId, scope.workspaceId, scope.principalId, proposal.memoryGeneration) as { user_text: string } | undefined : undefined;
    const availableTargets = proposal.proposalAction === 'add' ? this.list(scope, { statuses: ['active'], limit: MEMORY_CONSTANTS.management.listMaxLimit }).items
      .filter(item => item.memoryGeneration === proposal.memoryGeneration && !isExpired(item.expiresAt, timestamp)) : [];
    return { proposal, currentTarget, availableTargets, invalidReason,
      sourceQuote: source ? redactSensitiveMemoryContent(sanitizeMemoryContent(source.user_text)).content : null };
  }

  confirm(scope: TrustedMemoryScope, itemId: string, review?: MemoryProposalReview): MemoryItemRecord {
    const database = this.database();
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const item = findItem(database, scope, itemId);
      if (!item) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '记忆条目不存在。');
      if (item.status !== 'pending') throw new MemoryWriteError('MEMORY_CONFIRM_REQUIRES_PENDING', '只有待确认记忆可以确认。');
      const generation = requireSubject(database, scope).memory_generation;
      if (item.memory_generation !== generation) throw new MemoryWriteError('STALE_MEMORY_GENERATION', '提案所属记忆代际已过期。');
      if (isExpired(item.expires_at, timestamp)) throw new MemoryWriteError('TARGET_EXPIRED', '待确认提案已过期。');
      const action = item.proposal_action!;
      const selectingTarget = action === 'add' && review?.expectedAction === 'replace' && review.targetItemId;
      if (!review && (action !== 'add' || item.review_reason === 'AMBIGUOUS_RELATION')) throw new MemoryWriteError('PROPOSAL_REVIEW_REQUIRED', '请先查看提案动作和新旧内容，再确认。');
      if (review && ((!selectingTarget && review.expectedAction !== action)
        || review.expectedProposalFingerprint !== memoryProposalFingerprint(mapItemRow(item)))) {
        throw new MemoryWriteError('PROPOSAL_CHANGED', '提案内容或动作已变化，请刷新后重新审查。');
      }
      if (review?.targetItemId && !selectingTarget) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '不能为已有提案静默改换目标。');
      const effectiveAction = selectingTarget ? 'replace' : action;
      const targetId = selectingTarget ? review!.targetItemId : item.replaces_id;
      if (effectiveAction !== 'add') {
        const target = targetId ? findItem(database, scope, targetId) : undefined;
        assertProposalTarget(target, generation, selectingTarget ? review!.expectedTargetFingerprint : item.replaces_fingerprint, timestamp);
        invalidateTargetProposals(database, scope, target!.id, timestamp, 'TARGET_CHANGED', item.id);
        if (effectiveAction === 'retire') insertTombstone(database, scope, target!, generation, timestamp);
        database.prepare(`UPDATE memory_items SET status = 'superseded', invalid_at = ?, superseded_by = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND principal_id = ?`)
          .run(timestamp, effectiveAction === 'replace' ? item.id : null, timestamp, target!.id, scope.workspaceId, scope.principalId);
        database.prepare('DELETE FROM memory_item_embeddings WHERE item_id = ?').run(target!.id);
      }
      database.prepare(`UPDATE memory_items SET status = ?, invalid_at = ?, updated_at = ?, write_protection = 'user',
        proposal_action = ?, replaces_id = ?, replaces_fingerprint = ?, replaces_snapshot_json = ?, review_reason = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ?`).run(effectiveAction === 'retire' ? 'archived' : 'active',
          effectiveAction === 'retire' ? timestamp : null, timestamp, effectiveAction === 'retire' ? action : null,
          effectiveAction === 'retire' ? item.replaces_id : null, effectiveAction === 'retire' ? item.replaces_fingerprint : null,
          effectiveAction === 'retire' ? item.replaces_snapshot_json : null, effectiveAction === 'retire' ? item.review_reason : null,
          item.id, scope.workspaceId, scope.principalId);
      const archived = enforceActiveCapacity(database, scope, this.repository.getWorkspaceConfig(scope).maxItems, timestamp);
      for (const id of archived) database.prepare('DELETE FROM memory_item_embeddings WHERE item_id = ?').run(id);
      trimTombstones(database, scope);
      refreshSubjectCache(database, scope, timestamp);
      return requireItem(database, scope, item.id);
    });
  }

  reject(scope: TrustedMemoryScope, itemId: string): MemoryItemRecord {
    const database = this.database();
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const item = findItem(database, scope, itemId);
      if (!item) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '记忆条目不存在。');
      if (item.status !== 'pending') throw new MemoryWriteError('MEMORY_CONFIRM_REQUIRES_PENDING', '只有待确认记忆可以拒绝。');
      if (item.proposal_action !== 'retire') insertTombstone(database, scope, item, requireSubject(database, scope).memory_generation, timestamp);
      database.prepare(`
        UPDATE memory_items SET status = 'archived', invalid_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ?
      `).run(timestamp, timestamp, item.id, scope.workspaceId, scope.principalId);
      database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id = ? AND workspace_id = ? AND principal_id = ?`)
        .run(item.id, scope.workspaceId, scope.principalId);
      trimTombstones(database, scope);
      refreshSubjectCache(database, scope, timestamp);
      return requireItem(database, scope, item.id);
    });
  }

  delete(scope: TrustedMemoryScope, itemId: string): void {
    const database = this.database();
    const timestamp = new Date().toISOString();
    runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const item = findItem(database, scope, itemId);
      if (!item) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '记忆条目不存在。');
      if (item.proposal_action !== 'retire') insertTombstone(database, scope, item, requireSubject(database, scope).memory_generation, timestamp);
      database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id = ? AND workspace_id = ? AND principal_id = ?`)
        .run(item.id, scope.workspaceId, scope.principalId);
      database.prepare(`DELETE FROM memory_items WHERE id = ? AND workspace_id = ? AND principal_id = ?`)
        .run(item.id, scope.workspaceId, scope.principalId);
      trimTombstones(database, scope);
      refreshSubjectCache(database, scope, timestamp);
    });
  }

  /** Permanent consolidation is accepted only after the caller's model review. */
  mergeApproved(scope: TrustedMemoryScope, sourceItemIds: readonly string[], merged: ManualMemoryInput,
    guard?: { generation: number; fingerprints: ReadonlyMap<string, string>; assertActive: () => void; userReviewed?: boolean }): MemoryItemRecord {
    if (!this.repository.resolveAvailability(scope).enabled) throw new MemoryWriteError('MEMORY_DISABLED', '长期记忆当前未启用。');
    if (!guard?.userReviewed) throw new MemoryWriteError('USER_REVIEW_REQUIRED', '整理合并需要查看方案并确认。');
    const ids = [...new Set(sourceItemIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length < 2) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '整理合并至少需要两个来源条目。');
    const prepared = prepareWrite({ ...merged, origin: 'manual' });
    const database = this.database();
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      guard?.assertActive();
      if (guard && requireSubject(database, scope).memory_generation !== guard.generation) throw new MemoryWriteError('STALE_MEMORY_GENERATION', '整理代际已过期。');
      const placeholders = ids.map(() => '?').join(', ');
      const sources = database.prepare(`
        SELECT * FROM memory_items WHERE workspace_id = ? AND principal_id = ?
          AND id IN (${placeholders}) AND status = 'active'
      `).all(scope.workspaceId, scope.principalId, ...ids) as MemoryItemRow[];
      if (sources.length !== ids.length || sources.some((item) => item.kind !== prepared.kind)) {
        throw new MemoryWriteError('SOURCE_CHANGED', '整理来源已变化，未执行合并。');
      }
      if (sources.some(item => item.write_protection !== 'none') && !guard?.userReviewed) {
        throw new MemoryWriteError('USER_REVIEW_REQUIRED', '用户确认的记忆需要预览并确认后才能整理替换。');
      }
      if (database.prepare(`SELECT 1 FROM memory_items WHERE workspace_id = ? AND principal_id = ?
        AND status = 'pending' AND replaces_id IN (${placeholders}) LIMIT 1`).get(scope.workspaceId, scope.principalId, ...ids)) {
        throw new MemoryWriteError('TARGET_CONFLICT', '整理来源存在待确认提案，请先处理。');
      }
      if (guard && sources.some((item) => guard.fingerprints.get(item.id) !== memoryMergeFingerprint(mapItemRow(item)))) {
        throw new MemoryWriteError('SOURCE_CHANGED', '整理来源在审核期间已被编辑。');
      }
      if (sources.some((item) => item.expires_at && Date.parse(item.expires_at) <= Date.parse(timestamp))) {
        throw new MemoryWriteError('SOURCE_EXPIRED', '整理来源已过期。');
      }
      if (sources.some((item) => item.expires_at !== prepared.expiresAt)) throw new MemoryWriteError('EXPIRY_MISMATCH', '整理来源有效期不一致。');
      assertNoTombstone(database, scope, prepared, requireSubject(database, scope).memory_generation, timestamp);
      const duplicate = findLiveByKey(database, scope, prepared.kind, prepared.normalizedKey);
      if (duplicate && !ids.includes(duplicate.id) && (duplicate.status !== 'active' || duplicate.content !== prepared.content
        || duplicate.expires_at !== prepared.expiresAt || duplicate.expires_at && Date.parse(duplicate.expires_at) <= Date.parse(timestamp))) {
        throw new MemoryWriteError('TARGET_CONFLICT', '合并目标与现有条目冲突。');
      }
      const targetId = duplicate?.id ?? randomUUID();
      const protection = guard?.userReviewed ? 'user' : 'none';
      if (!duplicate) {
        database.prepare(`
          INSERT INTO memory_items (
            id, workspace_id, principal_id, kind, content, topic, normalized_key,
            importance, origin, status, valid_from, expires_at, memory_generation, created_at, updated_at, write_protection
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?, ?, ?, ?)
        `).run(
          targetId, scope.workspaceId, scope.principalId, prepared.kind, prepared.content, prepared.topic,
          prepared.normalizedKey, prepared.importance, timestamp, prepared.expiresAt,
          requireSubject(database, scope).memory_generation, timestamp, timestamp, protection,
        );
      } else if (ids.includes(duplicate.id)) {
        database.prepare(`
          UPDATE memory_items SET content = ?, topic = ?, importance = ?, origin = 'manual',
            status = 'active', invalid_at = NULL, expires_at = ?, superseded_by = NULL, updated_at = ?, write_protection = ?
          WHERE id = ? AND workspace_id = ? AND principal_id = ?
        `).run(
          prepared.content, prepared.topic, prepared.importance, prepared.expiresAt, timestamp, protection,
          duplicate.id, scope.workspaceId, scope.principalId,
        );
      }
      database.prepare(`
        UPDATE memory_items SET status = 'superseded', invalid_at = ?, superseded_by = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ? AND id IN (${placeholders}) AND id <> ?
      `).run(timestamp, targetId, timestamp, scope.workspaceId, scope.principalId, ...ids, targetId);
      database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id IN (${placeholders})`).run(...ids);
      refreshSubjectCache(database, scope, timestamp);
      return requireItem(database, scope, targetId);
    });
  }

  maintainForConsolidation(scope: TrustedMemoryScope, now = new Date()): { archivedExpired: number; decayedTasks: number } {
    const database = this.database();
    const timestamp = now.toISOString();
    const staleCutoff = new Date(now.getTime() - MEMORY_CONSTANTS.consolidation.staleTaskDays * 86_400_000).toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const expiringTargets = database.prepare(`SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ?
        AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`)
        .all(scope.workspaceId, scope.principalId, timestamp) as { id: string }[];
      for (const target of expiringTargets) invalidateTargetProposals(database, scope, target.id, timestamp, 'TARGET_EXPIRED');
      const archivedExpired = database.prepare(`
        UPDATE memory_items SET status = 'archived', invalid_at = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ? AND status IN ('active', 'pending')
          AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(timestamp, timestamp, scope.workspaceId, scope.principalId, timestamp).changes;
      const decayingTargets = database.prepare(`SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ?
        AND kind = 'task' AND status = 'active' AND importance > ? AND COALESCE(last_used_at, valid_from) < ?`)
        .all(scope.workspaceId, scope.principalId, MEMORY_CONSTANTS.consolidation.staleTaskImportance, staleCutoff) as { id: string }[];
      for (const target of decayingTargets) invalidateTargetProposals(database, scope, target.id, timestamp, 'TARGET_CHANGED');
      const decayedTasks = database.prepare(`
        UPDATE memory_items SET importance = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ? AND kind = 'task' AND status = 'active'
          AND importance > ? AND COALESCE(last_used_at, valid_from) < ?
      `).run(
        MEMORY_CONSTANTS.consolidation.staleTaskImportance, timestamp,
        scope.workspaceId, scope.principalId, MEMORY_CONSTANTS.consolidation.staleTaskImportance, staleCutoff,
      ).changes;
      if (archivedExpired) database.prepare(`DELETE FROM memory_item_embeddings WHERE workspace_id = ? AND principal_id = ?
        AND item_id IN (SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ? AND status = 'archived')`)
        .run(scope.workspaceId, scope.principalId, scope.workspaceId, scope.principalId);
      if (archivedExpired || decayedTasks) refreshSubjectCache(database, scope, timestamp);
      return { archivedExpired, decayedTasks };
    });
  }

  markConsolidated(scope: TrustedMemoryScope, mode: 'automatic' | 'manual', now = new Date()): void {
    const timestamp = now.toISOString();
    ensureScopeRows(this.database(), scope, timestamp);
    const column = mode === 'automatic' ? 'consolidated_at' : 'forced_consolidated_at';
    this.database().prepare(`UPDATE memory_subjects SET ${column} = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ?`)
      .run(timestamp, timestamp, scope.workspaceId, scope.principalId);
  }

  /** Background retirement is an operation proposal; only reviewed confirmation mutates the target. */
  retireExtracted(scope: TrustedMemoryScope, input: MemoryWriteInput, agent: AgentMemoryConfig = {}): boolean {
    if (input.origin !== 'extracted') throw new MemoryWriteError('MEMORY_INPUT_INVALID', '自动遗忘必须来自提炼任务。');
    return this.write(scope, { ...input, operation: 'retire' }, agent).item.status === 'pending';
  }

  clear(scope: TrustedMemoryScope): MemoryClearResult {
    const database = this.database();
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const subject = requireSubject(database, scope);
      const nextGeneration = subject.memory_generation + 1;
      const priorityItems = database.prepare(`
        SELECT * FROM memory_items
        WHERE workspace_id = ? AND principal_id = ? AND status IN ('active', 'pending')
        ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, valid_from DESC, id DESC
        LIMIT ?
      `).all(scope.workspaceId, scope.principalId, MEMORY_CONSTANTS.writeAndExtraction.tombstoneRetentionLimit) as MemoryItemRow[];
      for (const item of priorityItems) insertTombstone(database, scope, item, nextGeneration, timestamp);
      trimTombstones(database, scope);

      let deletedItems = 0;
      while (true) {
        const batch = database.prepare(`
          SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ? LIMIT ?
        `).all(scope.workspaceId, scope.principalId, MEMORY_CONSTANTS.writeAndExtraction.clearScanBatchSize) as Array<{ id: string }>;
        if (!batch.length) break;
        const ids = batch.map((item) => item.id);
        const placeholders = ids.map(() => '?').join(', ');
        database.prepare(`DELETE FROM memory_item_embeddings WHERE item_id IN (${placeholders})`).run(...ids);
        database.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders}) AND workspace_id = ? AND principal_id = ?`)
          .run(...ids, scope.workspaceId, scope.principalId);
        deletedItems += ids.length;
      }
        database.prepare(`DELETE FROM memory_topic_stats WHERE workspace_id = ? AND principal_id = ?`)
          .run(scope.workspaceId, scope.principalId);
        database.prepare(`DELETE FROM memory_extraction_turn_receipts WHERE workspace_id = ? AND principal_id = ?`)
          .run(scope.workspaceId, scope.principalId);
        database.prepare(`DELETE FROM memory_extraction_pending_sources WHERE workspace_id = ? AND principal_id = ?`)
          .run(scope.workspaceId, scope.principalId);
      database.prepare(`DELETE FROM memory_doc_affinities WHERE workspace_id = ? AND principal_id = ?`)
        .run(scope.workspaceId, scope.principalId);
      database.prepare(`DELETE FROM memory_doc_affinity_events WHERE workspace_id = ? AND principal_id = ?`)
        .run(scope.workspaceId, scope.principalId);
      database.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'stale', lease_until = NULL, finished_at = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ? AND status IN ('queued', 'running', 'retry')
      `).run(timestamp, timestamp, scope.workspaceId, scope.principalId);
      const latestTurn = database.prepare(`
          SELECT turn_id, created_at FROM qa_turns
          WHERE json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
            AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?
          ORDER BY created_at DESC, turn_id DESC LIMIT 1
        `).get(scope.workspaceId, scope.principalId) as { turn_id: string; created_at: string } | undefined;
      database.prepare(`
        UPDATE memory_subjects
        SET block_text = '', item_count = 0,
            extract_cursor_at = ?, extract_cursor_message_id = ?,
            pending_sessions_json = '[]', extract_scheduled_at = NULL,
            consolidated_at = NULL, forced_consolidated_at = NULL,
            memory_generation = ?, updated_at = ?
        WHERE workspace_id = ? AND principal_id = ?
      `).run(
        latestTurn?.created_at ?? null, latestTurn?.turn_id ?? null, nextGeneration, timestamp,
        scope.workspaceId, scope.principalId,
      );
      const retained = database.prepare(`
        SELECT COUNT(*) AS count FROM memory_tombstones WHERE workspace_id = ? AND principal_id = ?
      `).get(scope.workspaceId, scope.principalId) as { count: number };
      return { deletedItems, retainedTombstones: retained.count, memoryGeneration: nextGeneration };
    });
  }

  list(scope: TrustedMemoryScope, query: MemoryItemListQuery = {}): MemoryItemPage {
    const database = this.database();
    this.repository.ensureSubject(scope);
    const limit = clampInteger(query.limit, MEMORY_CONSTANTS.management.listDefaultLimit, MEMORY_CONSTANTS.management.listMaxLimit);
    const statuses = normalizedFilter(query.statuses, MEMORY_STATUSES);
    const kinds = normalizedFilter(query.kinds, MEMORY_KINDS);
    const cursor = decodeCursor(query.cursor);
    const clauses = ['workspace_id = ?', 'principal_id = ?'];
    const params: unknown[] = [scope.workspaceId, scope.principalId];
    if (statuses.length) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (kinds.length) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = database.prepare(`
      SELECT * FROM memory_items WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params, limit + 1) as MemoryItemRow[];
    const visible = rows.slice(0, limit).map(mapItemRow);
    const tail = visible.at(-1);
    return {
      items: visible,
      ...(rows.length > limit && tail ? { nextCursor: encodeCursor(tail) } : {}),
    };
  }

  /** Management totals are scoped and independent of the selected page or kind filter. */
  getItemCounts(scope: TrustedMemoryScope): MemoryItemCounts {
    this.repository.ensureSubject(scope);
    return this.database().prepare(`SELECT COALESCE(SUM(status = 'active'), 0) AS active,
      COALESCE(SUM(status = 'pending'), 0) AS pending, COUNT(*) AS "all" FROM memory_items
      WHERE workspace_id = ? AND principal_id = ?`).get(scope.workspaceId, scope.principalId) as MemoryItemCounts;
  }

  /** Count and retrieve only one management page; preserve the existing cursor-based list API. */
  listPage(scope: TrustedMemoryScope, query: MemoryItemPageQuery = {}): MemoryPage<MemoryItemRecord> {
    this.repository.ensureSubject(scope);
    const clauses = ['workspace_id = ?', 'principal_id = ?'];
    const parameters: unknown[] = [scope.workspaceId, scope.principalId];
    for (const [column, values] of [
      ['status', normalizedFilter(query.statuses, MEMORY_STATUSES)],
      ['kind', normalizedFilter(query.kinds, MEMORY_KINDS)],
    ] as const) {
      if (!values.length) continue;
      clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      parameters.push(...values);
    }
    return readMemoryPage<MemoryItemRow, MemoryItemRecord>(this.database(), query, {
      table: 'memory_items', select: '*', where: clauses.join(' AND '), parameters, orderBy: 'created_at DESC, id DESC',
    }, mapItemRow);
  }

  export(scope: TrustedMemoryScope): MemoryExportDocument {
    const database = this.database();
    this.repository.ensureSubject(scope);
    const maximum = MEMORY_CONSTANTS.management.exportMaximumItems;
    const rows = database.prepare(`
      SELECT * FROM memory_items
      WHERE workspace_id = ? AND principal_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ?
    `).all(scope.workspaceId, scope.principalId, maximum + 1) as MemoryItemRow[];
    if (rows.length > maximum) throw new MemoryWriteError('MEMORY_WRITE_CONFLICT', '记忆导出条目超过安全上限。');
    return { contractVersion: MEMORY_CONTRACT_VERSION, exportedAt: new Date().toISOString(), items: rows.map(mapItemRow) };
  }

  import(scope: TrustedMemoryScope, value: unknown): MemoryImportResult {
    if (!this.repository.resolveAvailability(scope).enabled) throw new MemoryWriteError('MEMORY_DISABLED', '长期记忆当前未启用。');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆备份格式无效。');
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length > MEMORY_CONSTANTS.management.exportMaximumItems) {
      throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆备份条目无效或超过上限。');
    }
    let importedItems = 0;
    let unchangedItems = 0;
    let skippedItems = 0;
    for (const raw of items) {
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { skippedItems += 1; continue; }
        const item = raw as Partial<MemoryItemRecord>;
        if (item.proposalAction || item.replacesId || item.status && item.status !== 'active') { skippedItems += 1; continue; }
        if (!item.kind || !item.content || !MEMORY_KINDS.includes(item.kind)) { skippedItems += 1; continue; }
        const result = this.createManual(scope, {
          kind: item.kind,
          content: item.content,
          topic: item.topic,
          importance: item.importance,
          expiresAt: item.expiresAt,
        });
        if (result.action === 'unchanged') unchangedItems += 1;
        else importedItems += 1;
      } catch (error) {
        if (error instanceof MemoryWriteError && ['MEMORY_PREVIOUSLY_FORGOTTEN', 'MEMORY_SENSITIVE_CONTENT'].includes(error.code)) skippedItems += 1;
        else throw error;
      }
    }
    return { importedItems, unchangedItems, skippedItems };
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

/** Usage counters are intentionally excluded: recall does not invalidate a semantic review. */
export function memoryMergeFingerprint(item: Pick<MemoryItemRecord, 'id' | 'kind' | 'content' | 'topic' | 'importance' | 'expiresAt' | 'status' | 'memoryGeneration'> & Partial<Pick<MemoryItemRecord, 'writeProtection'>>): string {
  return createHash('sha256').update(JSON.stringify([item.id, item.kind, item.content, item.topic,
    item.importance, item.expiresAt, item.status, item.memoryGeneration, item.writeProtection])).digest('hex');
}

function prepareWrite(input: MemoryWriteInput): PreparedWrite {
  if (!isMemoryKind(input.kind ?? 'fact')) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆类型无效。');
  const sanitized = sanitizeMemoryContent(input.content);
  if (!sanitized) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆内容不能为空。');
  const redaction = redactSensitiveMemoryContent(sanitized);
  const content = sanitizeMemoryContent(redaction.content);
  if (isMostlyRedacted(content)) throw new MemoryWriteError('MEMORY_SENSITIVE_CONTENT', '敏感内容已隐藏，剩余信息不足以保存为记忆。');
  const topic = sanitizeMemoryTopic(input.topic ?? '');
  const normalizedKey = memoryItemKey(topic, content);
  if (!normalizedKey) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆内容无法生成稳定标识。');
  const origin = input.origin;
  const importance = origin === 'explicit'
    ? MEMORY_CONSTANTS.writeAndExtraction.importance.explicit
    : normalizeImportance(input.importance, origin === 'manual'
      ? MEMORY_CONSTANTS.writeAndExtraction.importance.manualDefault
      : MEMORY_CONSTANTS.writeAndExtraction.importance.manualDefault);
  return {
    kind: input.kind ?? 'fact', content, topic, normalizedKey, importance, origin,
    // Model confidence never authorizes activation, including automatic interest promotion.
    status: origin === 'extracted' ? 'pending' : 'active',
    sourceSessionId: normalizeOptionalText(input.sourceSessionId),
    sourceMessageId: normalizeOptionalText(input.sourceMessageId),
    expiresAt: normalizeOptionalIso(input.expiresAt),
    ...(input.memoryGeneration === undefined ? {} : { memoryGeneration: input.memoryGeneration }),
    redacted: redaction.redacted,
  };
}

interface PreparedWrite {
  kind: MemoryKind;
  content: string;
  topic: string;
  normalizedKey: string;
  importance: number;
  origin: MemoryOrigin;
  status: 'active' | 'pending';
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  expiresAt: string | null;
  memoryGeneration?: number;
  redacted: boolean;
}

function assertNoTombstone(
  database: Database.Database,
  scope: TrustedMemoryScope,
  prepared: PreparedWrite,
  _generation: number,
  timestamp: string,
): void {
  const fingerprint = memoryFingerprint(prepared.content);
  if (!fingerprint) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆内容无法生成指纹。');
  const exact = database.prepare(`
    SELECT id, source_message_id, created_at FROM memory_tombstones
    WHERE workspace_id = ? AND principal_id = ? AND fingerprint = ?
  `).get(scope.workspaceId, scope.principalId, fingerprint) as TombstoneRow | undefined;
  if (exact) throw new MemoryWriteError('MEMORY_PREVIOUSLY_FORGOTTEN', '该记忆已被遗忘，不会再次写入。');
  if (prepared.origin !== 'extracted' || !prepared.sourceMessageId) return;
  const cutoff = new Date(new Date(timestamp).getTime()
    - MEMORY_CONSTANTS.writeAndExtraction.extractedSourceRejectionWindowSeconds * 1_000).toISOString();
  const sourceRejected = database.prepare(`
    SELECT id, source_message_id, created_at FROM memory_tombstones
    WHERE workspace_id = ? AND principal_id = ? AND source_message_id = ? AND created_at >= ?
    LIMIT 1
  `).get(scope.workspaceId, scope.principalId, prepared.sourceMessageId, cutoff) as TombstoneRow | undefined;
  if (sourceRejected) throw new MemoryWriteError('MEMORY_PREVIOUSLY_FORGOTTEN', '该消息最近生成的记忆已被拒绝。');
}

function insertTombstone(
  database: Database.Database,
  scope: TrustedMemoryScope,
  item: Pick<MemoryItemRow, 'kind' | 'topic' | 'content' | 'source_message_id'>,
  generation: number,
  timestamp: string,
): void {
  const fingerprint = memoryFingerprint(item.content);
  if (!fingerprint) return;
  database.prepare(`
    INSERT INTO memory_tombstones (
      id, workspace_id, principal_id, kind, topic, fingerprint, source_message_id, memory_generation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, principal_id, fingerprint) DO UPDATE SET
      kind = excluded.kind, topic = excluded.topic, source_message_id = excluded.source_message_id,
      memory_generation = excluded.memory_generation, created_at = excluded.created_at
  `).run(
    randomUUID(), scope.workspaceId, scope.principalId, item.kind, sanitizeMemoryTopic(item.topic),
    fingerprint, item.source_message_id, generation, timestamp,
  );
}

function trimTombstones(database: Database.Database, scope: TrustedMemoryScope): void {
  database.prepare(`
    DELETE FROM memory_tombstones WHERE id IN (
      SELECT id FROM memory_tombstones
      WHERE workspace_id = ? AND principal_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `).run(scope.workspaceId, scope.principalId, MEMORY_CONSTANTS.writeAndExtraction.tombstoneRetentionLimit);
}

function findLiveByKey(database: Database.Database, scope: TrustedMemoryScope, kind: MemoryKind, normalizedKey: string): MemoryItemRow | undefined {
  return database.prepare(`
    SELECT * FROM memory_items
    WHERE workspace_id = ? AND principal_id = ? AND kind = ? AND normalized_key = ?
      AND status IN ('active', 'pending')
    LIMIT 1
  `).get(scope.workspaceId, scope.principalId, kind, normalizedKey) as MemoryItemRow | undefined;
}

function listLiveSameKind(database: Database.Database, scope: TrustedMemoryScope, kind: MemoryKind): MemoryItemRow[] {
  return database.prepare(`
    SELECT * FROM memory_items
    WHERE workspace_id = ? AND principal_id = ? AND kind = ? AND status IN ('active', 'pending')
    ORDER BY valid_from DESC, id DESC LIMIT ?
  `).all(scope.workspaceId, scope.principalId, kind, MEMORY_CONSTANTS.writeAndExtraction.existingCandidateLimit) as MemoryItemRow[];
}

function findItem(database: Database.Database, scope: TrustedMemoryScope, id: string): MemoryItemRow | undefined {
  return database.prepare(`
    SELECT * FROM memory_items WHERE id = ? AND workspace_id = ? AND principal_id = ?
  `).get(id, scope.workspaceId, scope.principalId) as MemoryItemRow | undefined;
}

function requireItem(database: Database.Database, scope: TrustedMemoryScope, id: string): MemoryItemRecord {
  const item = findItem(database, scope, id);
  if (!item) throw new MemoryWriteError('MEMORY_ITEM_NOT_FOUND', '记忆条目不存在。');
  return mapItemRow(item);
}

function requireSubject(database: Database.Database, scope: TrustedMemoryScope): { memory_generation: number } {
  const subject = database.prepare(`
    SELECT memory_generation FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?
  `).get(scope.workspaceId, scope.principalId) as { memory_generation: number } | undefined;
  if (!subject) throw new MemoryWriteError('MEMORY_WRITE_CONFLICT', '记忆主体初始化失败。');
  return subject;
}

function enforceActiveCapacity(
  database: Database.Database,
  scope: TrustedMemoryScope,
  maximum: number,
  timestamp: string,
): string[] {
  const rows = database.prepare(`
    SELECT id FROM memory_items
    WHERE workspace_id = ? AND principal_id = ? AND status = 'active'
    ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, valid_from DESC, id DESC
  `).all(scope.workspaceId, scope.principalId) as Array<{ id: string }>;
  const overflow = rows.slice(maximum).map((row) => row.id);
  if (!overflow.length) return [];
  for (const id of overflow) invalidateTargetProposals(database, scope, id, timestamp, 'TARGET_CHANGED');
  const placeholders = overflow.map(() => '?').join(', ');
  database.prepare(`
    UPDATE memory_items SET status = 'archived', invalid_at = ?, updated_at = ?
    WHERE id IN (${placeholders}) AND workspace_id = ? AND principal_id = ? AND status = 'active'
  `).run(timestamp, timestamp, ...overflow, scope.workspaceId, scope.principalId);
  return overflow;
}

function refreshSubjectCache(database: Database.Database, scope: TrustedMemoryScope, timestamp: string): void {
  const active = database.prepare(`
    SELECT kind, content FROM memory_items
    WHERE workspace_id = ? AND principal_id = ? AND status = 'active'
    ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, valid_from DESC, id DESC
  `).all(scope.workspaceId, scope.principalId) as Array<{ kind: MemoryKind; content: string }>;
  const lines: string[] = [];
  let used = 0;
  for (const item of active) {
    const line = `- ${memoryKindLabel(item.kind)}：${item.content}`;
    const lineLength = Array.from(line).length + (lines.length ? 1 : 0);
    if (used + lineLength > MEMORY_CONSTANTS.recall.residentBlockMaxCodePoints) continue;
    lines.push(line);
    used += lineLength;
  }
  database.prepare(`
    UPDATE memory_subjects SET block_text = ?, item_count = ?, updated_at = ?
    WHERE workspace_id = ? AND principal_id = ?
  `).run(lines.join('\n'), active.length, timestamp, scope.workspaceId, scope.principalId);
}

function isExpired(expiresAt: string | null, timestamp: string): boolean {
  return expiresAt !== null && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(timestamp));
}

function assertProposalTarget(target: MemoryItemRow | undefined, generation: number, expectedFingerprint: string | null | undefined, timestamp: string): asserts target is MemoryItemRow {
  if (!target || target.status !== 'active' || target.memory_generation !== generation) throw new MemoryWriteError('TARGET_CHANGED', '原记忆已变化或不存在，请重新审查。');
  if (isExpired(target.expires_at, timestamp)) throw new MemoryWriteError('TARGET_EXPIRED', '原记忆已过期，未执行替换。');
  if (!expectedFingerprint || memoryTargetFingerprint(mapItemRow(target)) !== expectedFingerprint) throw new MemoryWriteError('TARGET_CHANGED', '原记忆内容已变化，请刷新后重新审查。');
}

function invalidateTargetProposals(database: Database.Database, scope: TrustedMemoryScope, targetId: string, timestamp: string,
  reason: 'TARGET_CHANGED' | 'TARGET_EXPIRED', exceptId = ''): void {
  database.prepare(`UPDATE memory_items SET status = 'archived', invalid_at = ?, updated_at = ?, review_reason = ?
    WHERE workspace_id = ? AND principal_id = ? AND replaces_id = ? AND status = 'pending' AND id <> ?`)
    .run(timestamp, timestamp, reason, scope.workspaceId, scope.principalId, targetId, exceptId);
}

function normalizeImportance(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(
    MEMORY_CONSTANTS.writeAndExtraction.importance.min,
    Math.min(MEMORY_CONSTANTS.writeAndExtraction.importance.max, Math.trunc(value)),
  );
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? sanitizeMemoryContent(value) : '';
  return normalized ? truncateCodePoints(normalized, MEMORY_CONSTANTS.writeAndExtraction.contentMaxCodePoints) : null;
}

function normalizeOptionalIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new MemoryWriteError('MEMORY_INPUT_INVALID', '记忆失效时间无效。');
  return parsed.toISOString();
}

function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

function isLive(item: MemoryItemRow): boolean {
  return item.status === 'active' || item.status === 'pending';
}

function mapItemRow(row: MemoryItemRow): MemoryItemRecord {
  const item: MemoryItemRecord = {
    ...mapMemoryItemMetadata(row),
    id: row.id, workspaceId: row.workspace_id, principalId: row.principal_id,
    kind: row.kind, content: row.content, topic: row.topic, normalizedKey: row.normalized_key,
    importance: row.importance, origin: row.origin, status: row.status,
    sourceSessionId: row.source_session_id, sourceMessageId: row.source_message_id,
    validFrom: row.valid_from, invalidAt: row.invalid_at, expiresAt: row.expires_at,
    supersededBy: row.superseded_by, lastUsedAt: row.last_used_at, useCount: row.use_count,
    memoryGeneration: row.memory_generation, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (item.status === 'pending') item.proposalFingerprint = memoryProposalFingerprint(item);
  if (item.status === 'active') item.targetFingerprint = memoryTargetFingerprint(item);
  return item;
}

function clampInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function normalizedFilter<T extends string>(values: readonly T[] | undefined, allowed: readonly T[]): T[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is T => typeof value === 'string' && allowed.includes(value as T)))];
}

function encodeCursor(item: MemoryItemRecord): string {
  return `${item.createdAt}|${item.id}`;
}

function decodeCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.lastIndexOf('|');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return Number.isNaN(new Date(createdAt).getTime()) || !id ? undefined : { createdAt, id };
}

function memoryKindLabel(kind: MemoryKind): string {
  return ({ profile: '画像', preference: '偏好', fact: '事实', task: '任务', interest: '兴趣' } as const)[kind];
}
