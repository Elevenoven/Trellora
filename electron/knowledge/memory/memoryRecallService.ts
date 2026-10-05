import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS, type MemoryKind } from './memoryConstants';
import { isLexicallyRelevant, scoreMemoryLexically } from './memoryLexical';
import { renderUserMemoryBlock, renderUserMemorySearchBlock, type MemoryPromptItem } from './memoryPrompt';
import { ensureScopeRows, MemoryRepository, runInImmediateTransaction } from './memoryRepository';
import type { AgentMemoryConfig, LongTermMemoryAvailability, MemoryItemRecord, MemoryUsedSnapshot, TrustedMemoryScope } from './memoryTypes';
import { mapMemoryItemMetadata, type MemoryItemMetadataRow } from './memoryWritePolicy';
import { readMemoryCitationMetadata, type MemoryCitationMetadata, type MemoryCitationSource } from '../../../shared/memoryCitations';
import { assertTrustedMemoryScope } from './memoryScope';
import { redactSensitiveMemoryContent } from './memoryText';

interface MemoryItemRow extends MemoryItemMetadataRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  kind: MemoryKind;
  content: string;
  topic: string;
  normalized_key: string;
  importance: number;
  origin: MemoryItemRecord['origin'];
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

interface EmbeddingRow {
  item_id: string;
  dimensions: number;
  embedding: Buffer;
  content_fingerprint: string;
}

export interface MemoryEmbeddingRuntime {
  modelId: string;
  embed(texts: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<number[][]>;
}

export interface MemoryRecallItem extends MemoryPromptItem {
  lexicalScore: number;
  vectorScore?: number;
  fusionScore: number;
  source: 'resident' | 'situational' | 'search';
}

export interface MemoryUsedItem extends MemoryPromptItem {
  source: 'resident' | 'situational';
}

export interface MemoryRecallResult {
  availability: LongTermMemoryAvailability;
  resident: MemoryRecallItem[];
  situational: MemoryRecallItem[];
  usedItems: MemoryUsedItem[];
  prompt: string;
  vectorUsed: boolean;
}

export interface MemorySearchResult {
  availability: LongTermMemoryAvailability;
  items: MemoryRecallItem[];
  observation: string;
  vectorUsed: boolean;
}

interface ScoredItem {
  item: MemoryItemRecord;
  lexicalScore: number;
  vectorScore?: number;
  fusionScore: number;
}

/**
 * M5 local reader. It has no model generation dependency: lexical retrieval is
 * fully synchronous/local, while the optional embedding path is strictly
 * bounded and always falls back to the lexical ranking on any failure.
 */
export class MemoryRecallService {
  private readonly repository: MemoryRepository;
  private readonly backfills = new Map<string, Promise<void>>();

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
    private readonly resolveEmbeddingRuntime: () => MemoryEmbeddingRuntime | undefined = () => undefined,
  ) {
    this.repository = new MemoryRepository(databaseOwner, storageWorkspacePath);
  }

  async recall(scope: TrustedMemoryScope, query: string, agent: AgentMemoryConfig = {}): Promise<MemoryRecallResult> {
    const availability = this.repository.resolveAvailability(scope, agent);
    if (!availability.enabled || !query.trim()) return emptyRecall(availability);
    try {
      const config = this.repository.getWorkspaceConfig(scope);
      if (config.vectorRecall && config.embeddingModelId) void this.backfill(scope).catch(() => undefined);
      const allResident = this.listActive(scope, MEMORY_CONSTANTS.recall.residentCandidateLimit, `
        (kind IN ('profile', 'preference', 'interest') OR origin = 'explicit')
      `);
      const resident = this.selectResident(query, allResident);
      const residentIds = new Set(resident.map((entry) => entry.item.id));
      const situationalCandidates = this.listActive(scope, MEMORY_CONSTANTS.recall.situationalCandidateLimit, `
        kind IN ('fact', 'task')
      `).filter((item) => !residentIds.has(item.id));
      const situational = await this.rank(query, situationalCandidates, MEMORY_CONSTANTS.recall.situationalItemLimit, config);
      const selectedSituational = selectWithinCodePointBudget(
        situational,
        MEMORY_CONSTANTS.recall.situationalItemLimit,
        MEMORY_CONSTANTS.recall.situationalBlockMaxCodePoints,
      ).map((entry) => ({ ...entry, source: 'situational' as const }));
      const selectedResident = selectWithinCodePointBudget(
        resident,
        Number.MAX_SAFE_INTEGER,
        MEMORY_CONSTANTS.recall.residentBlockMaxCodePoints,
      ).map((entry) => ({ ...entry, source: 'resident' as const }));
      const usedItems: MemoryUsedItem[] = [
        ...selectedResident
          // Interest fillers stabilize the resident block but are deliberately
          // not usage evidence; only an actually lexical-related interest may
          // enter assistant_used_memories.
          .filter((entry) => entry.item.kind !== 'interest' || isLexicallyRelevant(entry.lexicalScore))
          .map((entry) => ({ item: entry.item, source: 'resident' as const })),
        ...selectedSituational.map((entry) => ({ item: entry.item, source: 'situational' as const })),
      ].map((entry, index) => ({ ...entry, reference: index + 1 }));
      const references = new Map(usedItems.map((entry) => [entry.item.id, entry.reference]));
      const promptItems = [...selectedResident, ...selectedSituational].map(({ item }) => ({ item, reference: references.get(item.id) }));
      return {
        availability,
        resident: selectedResident,
        situational: selectedSituational,
        usedItems,
        prompt: renderUserMemoryBlock(promptItems),
        vectorUsed: selectedSituational.some((entry) => entry.vectorScore !== undefined),
      };
    } catch {
      // L4 must never fail the primary answer path. A local DB/read issue has
      // the same externally visible semantics as no recalled memory.
      return emptyRecall(availability);
    }
  }

  async search(scope: TrustedMemoryScope, query: string, limit?: number, agent: AgentMemoryConfig = {}): Promise<MemorySearchResult> {
    const availability = this.repository.resolveAvailability(scope, agent);
    if (!availability.enabled) return { availability, items: [], observation: '', vectorUsed: false };
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error('search_memory 需要非空 query。');
    const selectedLimit = clampInteger(
      limit,
      MEMORY_CONSTANTS.recall.searchMemory.defaultLimit,
      MEMORY_CONSTANTS.recall.searchMemory.maxLimit,
    );
    try {
      const config = this.repository.getWorkspaceConfig(scope);
      const candidates = this.listActive(scope, MEMORY_CONSTANTS.recall.searchMemory.candidateLimit);
      const ranked = await this.rank(normalizedQuery, candidates, selectedLimit, config);
      const items = selectWithinCodePointBudget(
        ranked,
        selectedLimit,
        MEMORY_CONSTANTS.recall.searchMemory.outputMaxCodePoints,
      ).map((entry) => ({ ...entry, source: 'search' as const }));
      return {
        availability,
        items,
        observation: renderUserMemorySearchBlock(items.map(({ item }) => ({ item }))),
        vectorUsed: items.some((entry) => entry.vectorScore !== undefined),
      };
    } catch {
      return { availability, items: [], observation: '', vectorUsed: false };
    }
  }

  /**
   * Called only after a canonical successful answer is durable. Snapshots are
   * deliberately inserted before touching the live item, preserving the exact
   * used text if that item is edited or deleted later.
   */
  recordUsedMemories(scope: TrustedMemoryScope, turnId: string, items: readonly MemoryUsedItem[]): void {
    assertTrustedMemoryScope(scope);
    const unique = new Map(items.map((entry) => [entry.item.id, entry]));
    if (!turnId.trim() || unique.size === 0) return;
    const database = this.database();
    const timestamp = new Date().toISOString();
    runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const insert = database.prepare(`
        INSERT INTO assistant_used_memories (turn_id, item_id, kind, content_snapshot, used_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, item_id) DO NOTHING
      `);
      const touch = database.prepare(`
        UPDATE memory_items
        SET last_used_at = ?, use_count = use_count + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ? AND status = 'active'
      `);
      for (const entry of unique.values()) {
        const result = insert.run(turnId, entry.item.id, entry.item.kind, entry.item.content, timestamp);
        if (result.changes > 0) {
          touch.run(timestamp, timestamp, entry.item.id, scope.workspaceId, scope.principalId);
        }
      }
      const turn = database.prepare('SELECT result_metadata_json FROM qa_turns WHERE turn_id = ?').get(turnId) as { result_metadata_json: string } | undefined;
      if (turn) {
        const metadata = JSON.parse(turn.result_metadata_json) as Record<string, unknown>;
        // Preserve the first durable numbering and provenance on duplicate completion.
        if (!Array.isArray(metadata.memoryCitations)) {
          const citations: MemoryCitationMetadata[] = [...unique.values()].flatMap(({ item, reference }) => reference ? [{
            itemId: item.id, reference, topic: item.topic, origin: item.origin,
            sourceSessionId: item.sourceSessionId ?? null, sourceMessageId: item.sourceMessageId ?? null,
          }] : []);
          database.prepare('UPDATE qa_turns SET result_metadata_json = ? WHERE turn_id = ?').run(JSON.stringify({ ...metadata, memoryCitations: citations }), turnId);
        }
      }
    });
  }

  listUsedMemories(scope: TrustedMemoryScope, turnId: string): MemoryUsedSnapshot[] {
    assertTrustedMemoryScope(scope);
    if (!turnId.trim()) return [];
    const rows = this.database().prepare(`
      SELECT used.item_id, used.kind, used.content_snapshot, used.used_at, turns.result_metadata_json
      FROM assistant_used_memories AS used
      JOIN qa_turns AS turns ON turns.turn_id = used.turn_id
      WHERE used.turn_id = ?
        AND json_extract(turns.result_metadata_json, '$.memoryScope.workspaceId') = ?
        AND json_extract(turns.result_metadata_json, '$.memoryScope.principalId') = ?
      ORDER BY used.used_at ASC, used.item_id ASC
    `).all(turnId, scope.workspaceId, scope.principalId) as Array<{
      item_id: string; kind: MemoryUsedSnapshot['kind']; content_snapshot: string; used_at: string; result_metadata_json: string;
    }>;
    return rows.map((row) => ({
      itemId: row.item_id,
      kind: row.kind,
      contentSnapshot: row.content_snapshot,
      usedAt: row.used_at,
      ...readMemoryCitationMetadata(row.result_metadata_json, row.item_id),
    }));
  }

  /** Read only a source registered in this owner's answer; never accept a renderer-supplied source ID. */
  getCitationSource(scope: TrustedMemoryScope, turnId: string, itemId: string): MemoryCitationSource {
    const snapshot = this.listUsedMemories(scope, turnId).find((entry) => entry.itemId === itemId);
    if (!snapshot) return { status: 'unavailable' };
    if (snapshot.origin === 'manual') return { status: 'manual' };
    if (!snapshot.sourceMessageId || !snapshot.sourceSessionId) return { status: 'unavailable' };
    const row = this.database().prepare(`SELECT user_text, created_at FROM qa_turns
      WHERE turn_id = ? AND session_id = ? AND status IN ('complete', 'partial', 'not-found')
        AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
        AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?
    `).get(snapshot.sourceMessageId, snapshot.sourceSessionId, scope.workspaceId, scope.principalId) as { user_text: string; created_at: string } | undefined;
    return row ? { status: 'available', userText: redactSensitiveMemoryContent(row.user_text).content, createdAt: row.created_at } : { status: 'unavailable' };
  }

  /** Explicitly available to host maintenance; one batch is at most 50 items. */
  async backfill(scope: TrustedMemoryScope): Promise<void> {
    const key = `${scope.workspaceId}\u0000${scope.principalId}`;
    const inFlight = this.backfills.get(key);
    if (inFlight) return inFlight;
    const operation = this.backfillNow(scope).finally(() => this.backfills.delete(key));
    this.backfills.set(key, operation);
    return operation;
  }

  private selectResident(query: string, candidates: readonly MemoryItemRecord[]): ScoredItem[] {
    const fixedKinds: MemoryKind[] = ['profile', 'preference'];
    const result: ScoredItem[] = [];
    const selected = new Set<string>();
    for (const kind of fixedKinds) {
      for (const item of sortResidentFixed(candidates.filter((candidate) => candidate.kind === kind))) {
        result.push(toScored(item, query));
        selected.add(item.id);
      }
    }
    // Explicit statements stay resident regardless of their semantic kind.
    for (const item of sortResidentFixed(candidates.filter((candidate) => candidate.origin === 'explicit' && !selected.has(candidate.id)))) {
      result.push(toScored(item, query));
      selected.add(item.id);
    }
    const interests = candidates.filter((candidate) => candidate.kind === 'interest' && !selected.has(candidate.id));
    const scoredInterests = interests.map((item) => toScored(item, query));
    const related = scoredInterests.filter((entry) => isLexicallyRelevant(entry.lexicalScore)).sort(compareScored);
    const fillers = scoredInterests.filter((entry) => !isLexicallyRelevant(entry.lexicalScore))
      .sort((left, right) => right.item.importance - left.item.importance || compareFreshness(left.item, right.item));
    result.push(...[...related, ...fillers].slice(0, MEMORY_CONSTANTS.recall.residentInterestLimit));
    return result;
  }

  private async rank(
    query: string,
    candidates: readonly MemoryItemRecord[],
    maxItems: number,
    config: ReturnType<MemoryRepository['getWorkspaceConfig']>,
  ): Promise<ScoredItem[]> {
    const lexical = candidates.map((item) => toScored(item, query))
      .filter((entry) => isLexicallyRelevant(entry.lexicalScore))
      .sort(compareScored);
    const vector = await this.rankVector(query, candidates, config).catch(() => []);
    // Preserve the full lexical tail for the resident/situational rune budget:
    // if a high-ranked long item cannot fit, selection must still be able to
    // continue with a shorter candidate rather than stop at the pre-fusion cut.
    if (!vector.length) return lexical;
    const fusion = new Map<string, ScoredItem>();
    const preFusionLimit = maxItems * MEMORY_CONSTANTS.lexicalVectorInterestAffinity.vectorPreFusionMaxItemsMultiplier;
    for (const [rank, entry] of lexical.slice(0, preFusionLimit).entries()) {
      fusion.set(entry.item.id, { ...entry, fusionScore: rrfScore(rank) });
    }
    for (const [rank, entry] of vector.slice(0, preFusionLimit).entries()) {
      const previous = fusion.get(entry.item.id);
      fusion.set(entry.item.id, {
        ...entry,
        lexicalScore: previous?.lexicalScore ?? entry.lexicalScore,
        fusionScore: (previous?.fusionScore ?? 0) + rrfScore(rank),
      });
    }
    const fused = [...fusion.values()].sort((left, right) => right.fusionScore - left.fusionScore || compareFreshness(left.item, right.item));
    const fusedIds = new Set(fused.map((entry) => entry.item.id));
    return [...fused, ...lexical.filter((entry) => !fusedIds.has(entry.item.id))];
  }

  private async rankVector(
    query: string,
    candidates: readonly MemoryItemRecord[],
    config: ReturnType<MemoryRepository['getWorkspaceConfig']>,
  ): Promise<ScoredItem[]> {
    const runtime = this.resolveVectorRuntime(config);
    if (!runtime) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEMORY_CONSTANTS.lexicalVectorInterestAffinity.queryEmbeddingTimeoutSeconds * 1_000);
    let queryVector: number[];
    try {
      [queryVector] = await runtime.embed([query], MEMORY_CONSTANTS.lexicalVectorInterestAffinity.queryEmbeddingTimeoutSeconds * 1_000, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
    if (!isValidVector(queryVector)) return [];
    const byId = new Map(candidates.map((item) => [item.id, item]));
    const aliases = this.embeddingAliases(candidates);
    const rows = this.database().prepare(`
      SELECT item_id, dimensions, embedding, content_fingerprint
      FROM memory_item_embeddings
      WHERE workspace_id = ? AND principal_id = ? AND model_id = ?
      LIMIT ?
    `).all(
      candidates[0]?.workspaceId ?? '',
      candidates[0]?.principalId ?? '',
      runtime.modelId,
      MEMORY_CONSTANTS.lexicalVectorInterestAffinity.vectorCandidateLimit,
    ) as EmbeddingRow[];
    const ranked: ScoredItem[] = [];
    const staleEmbeddingIds: string[] = [];
    for (const row of rows) {
      const item = byId.get(row.item_id);
      if (!item || row.dimensions !== queryVector.length || row.content_fingerprint !== memoryEmbeddingFingerprint(item, aliases.get(item.id))) {
        staleEmbeddingIds.push(row.item_id);
        continue;
      }
      const score = cosine(queryVector, decodeVector(row.embedding, row.dimensions));
      if (score < MEMORY_CONSTANTS.lexicalVectorInterestAffinity.cosineMinimumScore) continue;
      const lexicalScore = toScored(item, query).lexicalScore;
      ranked.push({ item, lexicalScore, vectorScore: score, fusionScore: score });
    }
    if (staleEmbeddingIds.length) {
      const placeholders = staleEmbeddingIds.map(() => '?').join(', ');
      this.database().prepare(`
        DELETE FROM memory_item_embeddings
        WHERE workspace_id = ? AND principal_id = ? AND model_id = ? AND item_id IN (${placeholders})
      `).run(candidates[0]?.workspaceId ?? '', candidates[0]?.principalId ?? '', runtime.modelId, ...staleEmbeddingIds);
    }
    return ranked.sort((left, right) => (right.vectorScore ?? 0) - (left.vectorScore ?? 0) || compareFreshness(left.item, right.item));
  }

  private async backfillNow(scope: TrustedMemoryScope): Promise<void> {
    const config = this.repository.getWorkspaceConfig(scope);
    const runtime = this.resolveVectorRuntime(config);
    if (!runtime) return;
    const candidates = this.listActive(scope, MEMORY_CONSTANTS.lexicalVectorInterestAffinity.embeddingBackfillBatchSize);
    await this.backfillForRuntime(candidates, config, runtime);
  }

  private async backfillForRuntime(
    candidates: readonly MemoryItemRecord[],
    config: ReturnType<MemoryRepository['getWorkspaceConfig']>,
    runtime: MemoryEmbeddingRuntime,
  ): Promise<void> {
    if (!candidates.length || config.embeddingModelId !== runtime.modelId) return;
    const database = this.database();
    const existing = new Map((database.prepare(`
      SELECT item_id, dimensions, embedding, content_fingerprint
      FROM memory_item_embeddings WHERE workspace_id = ? AND principal_id = ? AND model_id = ?
    `).all(candidates[0].workspaceId, candidates[0].principalId, runtime.modelId) as EmbeddingRow[]).map((row) => [row.item_id, row]));
    const aliases = this.embeddingAliases(candidates);
    const stale = candidates.filter((item) => {
      const row = existing.get(item.id);
      return !row || row.content_fingerprint !== memoryEmbeddingFingerprint(item, aliases.get(item.id));
    }).slice(0, MEMORY_CONSTANTS.lexicalVectorInterestAffinity.embeddingBackfillBatchSize);
    if (!stale.length) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEMORY_CONSTANTS.lexicalVectorInterestAffinity.embeddingWriteTimeoutSeconds * 1_000);
    let vectors: number[][];
    try {
      vectors = await runtime.embed(stale.map((item) => memoryEmbeddingText(item, aliases.get(item.id))), MEMORY_CONSTANTS.lexicalVectorInterestAffinity.embeddingWriteTimeoutSeconds * 1_000, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
    if (vectors.length !== stale.length || vectors.some((vector) => !isValidVector(vector))) return;
    const dimensions = vectors[0].length;
    if (vectors.some((vector) => vector.length !== dimensions)) return;
    const timestamp = new Date().toISOString();
    runInImmediateTransaction(database, () => {
      const upsert = database.prepare(`
        INSERT INTO memory_item_embeddings (
          item_id, workspace_id, principal_id, model_id, dimensions, embedding, content_fingerprint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          workspace_id = excluded.workspace_id, principal_id = excluded.principal_id,
          model_id = excluded.model_id, dimensions = excluded.dimensions,
          embedding = excluded.embedding, content_fingerprint = excluded.content_fingerprint,
          updated_at = excluded.updated_at
      `);
      for (const [index, item] of stale.entries()) {
        upsert.run(item.id, item.workspaceId, item.principalId, runtime.modelId, dimensions, encodeVector(vectors[index]), memoryEmbeddingFingerprint(item, aliases.get(item.id)), timestamp);
      }
    });
  }

  private resolveVectorRuntime(config: ReturnType<MemoryRepository['getWorkspaceConfig']>): MemoryEmbeddingRuntime | undefined {
    if (!config.vectorRecall || !config.embeddingModelId?.trim()) return undefined;
    const runtime = this.resolveEmbeddingRuntime();
    return runtime?.modelId === config.embeddingModelId ? runtime : undefined;
  }

  private listActive(scope: TrustedMemoryScope, limit: number, extraClause = '1 = 1'): MemoryItemRecord[] {
    const rows = this.database().prepare(`
      SELECT * FROM memory_items
      WHERE workspace_id = ? AND principal_id = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
        AND ${extraClause}
      ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, valid_from DESC, id DESC
      LIMIT ?
    `).all(scope.workspaceId, scope.principalId, new Date().toISOString(), limit) as MemoryItemRow[];
    return rows.map(mapItemRow);
  }

  private embeddingAliases(items: readonly MemoryItemRecord[]): Map<string, string[]> {
    const interests = items.filter((item) => item.kind === 'interest' && item.topic.trim());
    if (!interests.length) return new Map();
    const topics = [...new Set(interests.map((item) => item.topic.trim()))];
    const placeholders = topics.map(() => '?').join(', ');
    const rows = this.database().prepare(`
      SELECT topic, aliases_json FROM memory_topic_stats
      WHERE workspace_id = ? AND principal_id = ? AND topic IN (${placeholders})
    `).all(interests[0].workspaceId, interests[0].principalId, ...topics) as Array<{ topic: string; aliases_json: string }>;
    const aliasesByTopic = new Map(rows.map((row) => [row.topic, parseAliases(row.aliases_json)]));
    return new Map(interests.map((item) => [item.id, aliasesByTopic.get(item.topic.trim()) ?? []]));
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

function emptyRecall(availability: LongTermMemoryAvailability): MemoryRecallResult {
  return { availability, resident: [], situational: [], usedItems: [], prompt: '', vectorUsed: false };
}

function toScored(item: MemoryItemRecord, query: string): ScoredItem {
  const lexical = scoreMemoryLexically({ query, topic: item.topic, content: item.content, importance: item.importance });
  return { item, lexicalScore: lexical.score, fusionScore: lexical.score };
}

function selectWithinCodePointBudget(entries: readonly ScoredItem[], maxItems: number, maxCodePoints: number): ScoredItem[] {
  const selected: ScoredItem[] = [];
  let used = 0;
  for (const entry of entries) {
    if (selected.length >= maxItems) break;
    const size = Array.from(`${entry.item.topic}\n${entry.item.content}`).length;
    if (size > maxCodePoints || used + size > maxCodePoints) continue;
    selected.push(entry);
    used += size;
  }
  return selected;
}

function compareScored(left: ScoredItem, right: ScoredItem): number {
  return right.lexicalScore - left.lexicalScore || compareFreshness(left.item, right.item);
}

function sortResidentFixed(items: readonly MemoryItemRecord[]): MemoryItemRecord[] {
  return [...items].sort((left, right) => right.importance - left.importance || compareFreshness(left, right));
}

function compareFreshness(left: MemoryItemRecord, right: MemoryItemRecord): number {
  return right.validFrom.localeCompare(left.validFrom) || right.id.localeCompare(left.id);
}

function rrfScore(rank: number): number {
  return 1 / (MEMORY_CONSTANTS.lexicalVectorInterestAffinity.memoryRrfK + rank + MEMORY_CONSTANTS.lexicalVectorInterestAffinity.memoryRrfRankBase);
}

function clampInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value as number)));
}

function memoryEmbeddingText(item: MemoryItemRecord, aliases: readonly string[] = []): string {
  const base = item.topic.trim() ? `${item.topic.trim()}：${item.content}` : item.content;
  return aliases.length ? `${base}\naliases：${aliases.join('、')}` : base;
}

function memoryEmbeddingFingerprint(item: MemoryItemRecord, aliases: readonly string[] = []): string {
  return createHash('sha256').update(memoryEmbeddingText(item, aliases), 'utf8').digest('hex');
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()).slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function encodeVector(vector: readonly number[]): Buffer {
  const output = Buffer.allocUnsafe(vector.length * 4);
  for (const [index, value] of vector.entries()) output.writeFloatLE(value, index * 4);
  return output;
}

function decodeVector(value: Buffer, dimensions: number): number[] {
  if (value.length !== dimensions * 4) return [];
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) vector.push(value.readFloatLE(index * 4));
  return vector;
}

function isValidVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function mapItemRow(row: MemoryItemRow): MemoryItemRecord {
  return {
    ...mapMemoryItemMetadata(row),
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    kind: row.kind,
    content: row.content,
    topic: row.topic,
    normalizedKey: row.normalized_key,
    importance: row.importance,
    origin: row.origin,
    status: row.status,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    validFrom: row.valid_from,
    invalidAt: row.invalid_at,
    expiresAt: row.expires_at,
    supersededBy: row.superseded_by,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    memoryGeneration: row.memory_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
