import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS, type MemoryKind } from './memoryConstants';
import { tokenizeMemoryLexical } from './memoryLexical';
import { sanitizeMemoryContent, sanitizeMemoryTopic } from './memoryText';
import type {
  MemoryConsolidationMode,
  MemoryConsolidationResult,
  MemoryItemRecord,
  MemoryConsolidationPreview,
  TrustedMemoryScope,
} from './memoryTypes';
import { MemoryWriteError, MemoryWriteService, memoryMergeFingerprint } from './memoryWriteService';
import { MemoryTask } from './memoryTask';
import { isRestorePaused } from '../../backup/restorePause';
import { MEMORY_AUTOMATIC_WRITE_READY } from './memoryWritePolicy';

const scopeLocks = new Set<string>();

interface ConsolidationRow {
  id: string;
  kind: MemoryKind;
  content: string;
  topic: string;
  importance: number;
  valid_from: string;
  expires_at: string | null;
  status: 'active';
  memory_generation: number;
  write_protection: MemoryItemRecord['writeProtection'];
}

interface EmbeddingRow {
  item_id: string;
  model_id: string;
  dimensions: number;
  embedding: Buffer;
}

export interface MemoryConsolidationDecision {
  merge: boolean;
  content?: string;
  topic?: string;
  importance?: number;
}

export type MemoryConsolidationReviewer = (
  items: readonly Pick<MemoryItemRecord, 'id' | 'kind' | 'content' | 'topic' | 'importance' | 'expiresAt'>[],
  control?: { signal: AbortSignal; timeoutMs: number },
) => Promise<MemoryConsolidationDecision>;

/** M8 durable-memory housekeeping. Heuristics only propose clusters; only a model-approved decision can merge. */
export class MemoryConsolidationService {
  private readonly writer: MemoryWriteService;
  private readonly tasks = new Set<MemoryTask>();
  private stopped = false;
  private paused = false;
  private readonly previews = new Map<string, { scopeKey: string; generation: number; fingerprints: Map<string, string>; preview: MemoryConsolidationPreview }>();
  get maintenanceBusy(): boolean { return this.tasks.size > 0; }
  pauseForMaintenance(): void { this.paused = true; this.previews.clear(); for (const task of this.tasks) task.abort(); }
  resumeAfterMaintenance(): void { this.paused = false; }
  async stop(): Promise<void> {
    this.stopped = true; this.previews.clear(); for (const task of this.tasks) task.abort();
    const deadline = Date.now() + (this.options.limits?.stopWaitTimeoutMs ?? MEMORY_CONSTANTS.runtime.stopWaitTimeoutMs);
    while (this.maintenanceBusy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
    private readonly options: { revalidateScope?: (scope: TrustedMemoryScope) => boolean; limits?: Partial<Record<keyof typeof MEMORY_CONSTANTS.runtime, number>>; automaticWriteReady?: () => boolean } = {},
  ) {
    this.writer = new MemoryWriteService(databaseOwner, storageWorkspacePath);
  }

  async consolidate(
    scope: TrustedMemoryScope,
    mode: MemoryConsolidationMode,
    reviewer?: MemoryConsolidationReviewer,
    now = new Date(),
  ): Promise<MemoryConsolidationResult> {
    const completedAt = now.toISOString();
    const emptyMaintenance = { archivedExpired: 0, decayedTasks: 0 };
    if (!(this.options.automaticWriteReady?.() ?? MEMORY_AUTOMATIC_WRITE_READY)) return result(mode, emptyMaintenance, completedAt, 0, 0, [], 'review_required');
    const key = `${this.storageWorkspacePath}:${scope.workspaceId}:${scope.principalId}`;
    if (scopeLocks.has(key)) return result(mode, emptyMaintenance, completedAt, 0, 0, [], 'busy');
    if (this.stopped || this.paused || isRestorePaused(this.storageWorkspacePath)) return result(mode, emptyMaintenance, completedAt, 0, 0, [], 'cancelled');
    scopeLocks.add(key);
    const limits = { ...MEMORY_CONSTANTS.runtime, ...this.options.limits };
    const task = new MemoryTask(limits.consolidationTotalTimeoutMs);
    this.tasks.add(task);
    let maintenance = emptyMaintenance;
    let candidateClusters = 0;
    const mergedClusters = 0;
    const mergedItemIds: string[] = [];
    const skipped: NonNullable<MemoryConsolidationResult['skippedClusters']> = [];
    const previews: MemoryConsolidationPreview[] = [];
    const finish = (reason?: MemoryConsolidationResult['skipReason']) => ({
      ...result(mode, maintenance, new Date().toISOString(), candidateClusters, mergedClusters, mergedItemIds, reason),
      skippedChangedClusters: skipped.filter((cluster) => cluster.reason === 'SOURCE_CHANGED' || cluster.reason === 'TARGET_CONFLICT').length,
      skippedExpiryClusters: skipped.filter((cluster) => cluster.reason === 'EXPIRY_MISMATCH' || cluster.reason === 'SOURCE_EXPIRED').length,
      skippedClusters: skipped,
      previews,
    });
    try {
      const assertActive = () => {
        task.assertActive();
        if (this.stopped || this.paused || isRestorePaused(this.storageWorkspacePath) || this.options.revalidateScope?.(scope) === false) throw new Error('MEMORY_TASK_CANCELLED');
        if (!this.writer.getAvailability(scope).enabled) throw new Error('MEMORY_TASK_CANCELLED');
      };
      assertActive();
      if (mode === 'manual') for (const [id, entry] of this.previews) if (entry.scopeKey === key) this.previews.delete(id);
      maintenance = this.writer.maintainForConsolidation(scope, now);
      const subject = this.writer.getSubject(scope);
      const generation = subject.memoryGeneration;
      const last = mode === 'automatic' ? subject.consolidatedAt : subject.forcedConsolidatedAt;
      const minimumSeconds = mode === 'automatic' ? MEMORY_CONSTANTS.consolidation.automaticMinimumIntervalSeconds : MEMORY_CONSTANTS.consolidation.manualMinimumIntervalSeconds;
      if (last && now.getTime() - Date.parse(last) < minimumSeconds * 1000) return finish('too_soon');
      // Background housekeeping may expire/decay by rules, but semantic merges require the visible review flow.
      if (mode === 'automatic') {
        this.writer.markConsolidated(scope, mode, now);
        return finish('review_required');
      }
      const rows = this.database().prepare(`SELECT id, kind, content, topic, importance, valid_from, expires_at, status, memory_generation, write_protection FROM memory_items
        WHERE workspace_id = ? AND principal_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY kind, importance DESC, COALESCE(last_used_at, valid_from) DESC, id LIMIT ?`)
        .all(scope.workspaceId, scope.principalId, completedAt, MEMORY_CONSTANTS.management.listMaxLimit) as ConsolidationRow[];
      const embeddings = this.readEmbeddings(scope);
      for (const cluster of buildCandidateClusters(rows, embeddings, mode, false)) {
        if (cluster.some((item) => item.expires_at !== cluster[0].expires_at)) skipped.push({ itemIds: cluster.map((item) => item.id), reason: 'EXPIRY_MISMATCH' });
      }
      const clusters = buildCandidateClusters(rows, embeddings, mode);
      candidateClusters = clusters.length;
      if (!clusters.length) { this.writer.markConsolidated(scope, mode, now); return finish('no_candidates'); }
      if (!reviewer) return finish('model_unavailable');
      for (const cluster of clusters) {
        assertActive();
        if (this.writer.getSubject(scope).memoryGeneration !== generation) throw new Error('MEMORY_TASK_CANCELLED');
        // WEKNORA_PARITY_HARDENING: only the reviewed semantic snapshot and identical expiry can enter commit.
        const fingerprints = new Map(cluster.map((item) => [item.id, fingerprint(item)]));
        const decision = await task.run((signal) => reviewer(cluster.map(toReviewItem), { signal, timeoutMs: limits.consolidationClusterTimeoutMs }), limits.consolidationClusterTimeoutMs);
        assertActive();
        if (this.writer.getSubject(scope).memoryGeneration !== generation) throw new Error('MEMORY_TASK_CANCELLED');
        if (!decision.merge || typeof decision.content !== 'string') continue;
        const singleLine = decision.content.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
        if (!singleLine || Array.from(singleLine).length > MEMORY_CONSTANTS.consolidation.mergedStatementMaxCodePoints) continue;
        const content = sanitizeMemoryContent(singleLine);
        if (!content || Array.from(content).length > MEMORY_CONSTANTS.consolidation.mergedStatementMaxCodePoints) continue;
        const proposed = { kind: cluster[0].kind, content, expiresAt: cluster[0].expires_at,
          topic: sanitizeMemoryTopic(decision.topic ?? cluster.find(item => item.topic)?.topic ?? ''),
          importance: normalizeImportance(decision.importance, Math.max(...cluster.map(item => item.importance))) };
        const sources = cluster.map(item => ({ ...toReviewItem(item), writeProtection: item.write_protection }));
        const preview: MemoryConsolidationPreview = { id: randomUUID(), fingerprint: createHash('sha256')
          .update(JSON.stringify([generation, [...fingerprints], proposed])).digest('hex'), sources, result: proposed,
          expiresAt: new Date(Date.now() + limits.consolidationTotalTimeoutMs).toISOString() };
        this.previews.set(preview.id, { scopeKey: key, generation, fingerprints, preview });
        previews.push(preview);
      }
      assertActive();
      if (this.writer.getSubject(scope).memoryGeneration !== generation) throw new Error('MEMORY_TASK_CANCELLED');
      this.writer.markConsolidated(scope, mode, now);
      return finish(previews.length ? 'review_required' : mergedClusters ? undefined : skipped.length ? 'sources_skipped' : 'model_declined');
    } catch (error) {
      for (const preview of previews) this.previews.delete(preview.id);
      previews.length = 0;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('TIMEOUT')) return finish('timeout');
      if (message.includes('CANCELLED') || message.includes('STALE_MEMORY_GENERATION')) return finish('cancelled');
      if (message.startsWith('MODEL_UNAVAILABLE')) return finish('model_unavailable');
      return finish('failed');
    } finally {
      task.dispose(); this.tasks.delete(task); scopeLocks.delete(key);
    }
  }

  /** Commit only the exact server-issued preview the user saw; model approval alone does not authorize protected merges. */
  approvePreview(scope: TrustedMemoryScope, id: string, expectedFingerprint: string): MemoryItemRecord {
    const key = `${this.storageWorkspacePath}:${scope.workspaceId}:${scope.principalId}`;
    const entry = this.previews.get(id);
    if (!entry || entry.scopeKey !== key || entry.preview.fingerprint !== expectedFingerprint || Date.parse(entry.preview.expiresAt) <= Date.now()) {
      throw new MemoryWriteError('SOURCE_CHANGED', '整理预览已失效，请重新整理。');
    }
    if (scopeLocks.has(key)) throw new MemoryWriteError('TARGET_CONFLICT', '正在整理，请稍后审查。');
    const assertActive = () => {
      if (this.stopped || this.paused || isRestorePaused(this.storageWorkspacePath) || this.options.revalidateScope?.(scope) === false
        || !this.writer.getAvailability(scope).enabled) throw new MemoryWriteError('MEMORY_DISABLED', '长期记忆当前不可写入。');
    };
    try {
      return this.writer.mergeApproved(scope, entry.preview.sources.map(item => item.id), entry.preview.result,
        { generation: entry.generation, fingerprints: entry.fingerprints, assertActive, userReviewed: true });
    } finally { this.previews.delete(id); }
  }

  private readEmbeddings(scope: TrustedMemoryScope): Map<string, EmbeddingRow> {
    const rows = this.database().prepare(`
      SELECT item_id, model_id, dimensions, embedding FROM memory_item_embeddings
      WHERE workspace_id = ? AND principal_id = ?
    `).all(scope.workspaceId, scope.principalId) as EmbeddingRow[];
    return new Map(rows.map((row) => [row.item_id, row]));
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

function buildCandidateClusters(
  rows: readonly ConsolidationRow[],
  embeddings: ReadonlyMap<string, EmbeddingRow>,
  mode: MemoryConsolidationMode,
  matchExpiry = true,
): ConsolidationRow[][] {
  const maxSize = mode === 'automatic'
    ? MEMORY_CONSTANTS.consolidation.automaticMaximumClusterSize
    : MEMORY_CONSTANTS.consolidation.manualMaximumClusterSize;
  const jaccardThreshold = mode === 'automatic'
    ? MEMORY_CONSTANTS.consolidation.automaticJaccardThreshold
    : MEMORY_CONSTANTS.consolidation.manualJaccardThreshold;
  const cosineThreshold = mode === 'automatic'
    ? MEMORY_CONSTANTS.consolidation.automaticCosineThreshold
    : MEMORY_CONSTANTS.consolidation.manualCosineThreshold;
  const unused = new Set(rows.map((row) => row.id));
  const clusters: ConsolidationRow[][] = [];
  for (const seed of rows) {
    if (!unused.has(seed.id)) continue;
    const candidates = rows.filter((candidate) => candidate.id !== seed.id && unused.has(candidate.id) && candidate.kind === seed.kind && (!matchExpiry || candidate.expires_at === seed.expires_at))
      .map((candidate) => ({ candidate, similarity: similarity(seed, candidate, embeddings) }))
      .filter(({ similarity: score }) => score.jaccard >= jaccardThreshold || score.cosine >= cosineThreshold)
      .sort((left, right) => Math.max(right.similarity.jaccard, right.similarity.cosine) - Math.max(left.similarity.jaccard, left.similarity.cosine));
    const cluster = [seed, ...candidates.slice(0, maxSize - 1).map(({ candidate }) => candidate)];
    if (cluster.length < 2) continue;
    cluster.forEach((item) => unused.delete(item.id));
    clusters.push(cluster);
  }
  return clusters;
}

function similarity(left: ConsolidationRow, right: ConsolidationRow, embeddings: ReadonlyMap<string, EmbeddingRow>) {
  const leftTokens = lexicalSet(`${left.topic} ${left.content}`);
  const rightTokens = lexicalSet(`${right.topic} ${right.content}`);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const leftEmbedding = embeddings.get(left.id);
  const rightEmbedding = embeddings.get(right.id);
  const vectorCompatible = leftEmbedding && rightEmbedding
    && leftEmbedding.model_id === rightEmbedding.model_id
    && leftEmbedding.dimensions === rightEmbedding.dimensions;
  return {
    jaccard: union ? intersection / union : 0,
    cosine: vectorCompatible
      ? cosine(decodeVector(leftEmbedding.embedding, leftEmbedding.dimensions), decodeVector(rightEmbedding.embedding, rightEmbedding.dimensions))
      : -1,
  };
}

function lexicalSet(value: string): Set<string> {
  const tokens = tokenizeMemoryLexical(value);
  return new Set([...tokens.unigrams].map((token) => `u:${token}`).concat([...tokens.bigrams].map((token) => `b:${token}`)));
}

function decodeVector(value: Buffer, dimensions: number): number[] {
  if (value.length !== dimensions * 4) return [];
  return Array.from({ length: dimensions }, (_unused, index) => value.readFloatLE(index * 4));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : -1;
}

function toReviewItem(row: ConsolidationRow): Pick<MemoryItemRecord, 'id' | 'kind' | 'content' | 'topic' | 'importance' | 'expiresAt'> {
  return { id: row.id, kind: row.kind, content: row.content, topic: row.topic, importance: row.importance, expiresAt: row.expires_at };
}

function fingerprint(row: ConsolidationRow): string {
  return memoryMergeFingerprint({ ...toReviewItem(row), status: row.status, memoryGeneration: row.memory_generation, writeProtection: row.write_protection });
}

function normalizeImportance(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(5, Math.trunc(value)))
    : fallback;
}

function result(
  mode: MemoryConsolidationMode,
  maintenance: { archivedExpired: number; decayedTasks: number },
  completedAt: string,
  candidateClusters: number,
  mergedClusters: number,
  mergedItemIds: string[],
  skipReason?: MemoryConsolidationResult['skipReason'],
): MemoryConsolidationResult {
  return { mode, ...maintenance, candidateClusters, mergedClusters, mergedItemIds, ...(skipReason ? { skipReason } : {}), completedAt };
}
