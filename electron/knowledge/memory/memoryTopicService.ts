import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS } from './memoryConstants';
import { normalizeTopicKey, sanitizeMemoryTopic } from './memoryText';
import { ensureScopeRows, runInImmediateTransaction } from './memoryRepository';
import { MemoryWriteError, MemoryWriteService } from './memoryWriteService';
import type { MemoryPage, MemoryPageQuery, MemoryTopicRecord, TrustedMemoryScope } from './memoryTypes';
import { readMemoryPage } from './memoryPagination';

interface TopicStatRow {
  id: string;
  normalized_key: string;
  topic: string;
  aliases_json: string;
  hits: number;
  promoted_item_id: string | null;
}

export interface TopicCandidate {
  normalizedKey: string;
  topic: string;
  aliases: string[];
  hits: number;
}

export interface TopicResolutionRequest {
  topic: string;
  candidates: TopicCandidate[];
}

export interface MemoryTopicServiceOptions {
  /** Only used for non-exact, non-lexical cases; it must return an existing key or undefined. */
  resolveUncertainTopic?: (request: TopicResolutionRequest) => Promise<string | undefined>;
}

export interface PreparedMemoryTopic {
  selected: TopicCandidate;
  aliases: string[];
}

/** Topic counters are not L4 facts. Automatic promotion emits an interest proposal awaiting review. */
export class MemoryTopicService {
  private readonly writer: MemoryWriteService;

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {
    this.writer = new MemoryWriteService(databaseOwner, storageWorkspacePath);
  }

  async recordTopics(
    scope: TrustedMemoryScope,
    topics: string[],
    memoryGeneration: number,
    options: MemoryTopicServiceOptions = {},
  ): Promise<void> {
    const prepared = await this.prepareTopics(scope, topics, options);
    runInImmediateTransaction(this.database(), () => this.applyTopics(scope, prepared, memoryGeneration));
  }

  /** Network resolution finishes before any hit is written. */
  async prepareTopics(scope: TrustedMemoryScope, topics: string[], options: MemoryTopicServiceOptions = {}): Promise<PreparedMemoryTopic[]> {
    const candidates = this.listCandidates(scope);
    const plans = new Map<string, PreparedMemoryTopic>();
    for (const topic of [...new Set(topics.map(sanitizeMemoryTopic).filter(Boolean))]) {
      const selected = await this.resolveTopic(topic, candidates, options.resolveUncertainTopic)
        ?? { normalizedKey: normalizeTopicKey(topic), topic, aliases: [], hits: 0 };
      if (!selected.normalizedKey) continue;
      if (!candidates.some((candidate) => candidate.normalizedKey === selected.normalizedKey)) candidates.push(selected);
      const plan = plans.get(selected.normalizedKey) ?? { selected, aliases: [] };
      plan.aliases.push(topic);
      selected.aliases = appendAlias(selected.aliases, topic);
      plans.set(selected.normalizedKey, plan);
    }
    return [...plans.values()];
  }

  /** Synchronous only; joins the extraction segment's transaction on this connection. */
  applyTopics(scope: TrustedMemoryScope, plans: PreparedMemoryTopic[], memoryGeneration: number): void {
    if (!this.writer.getAvailability(scope).enabled || this.writer.getWorkspaceConfig(scope).writeMode !== 'auto') {
      throw new Error('AUTO_EXTRACTION_DISABLED');
    }
    for (const plan of plans) {
      const updated = this.upsertHit(scope, plan.aliases[0], plan.selected, memoryGeneration);
      const row = this.requireTopic(scope, updated.id);
      this.database().prepare(`UPDATE memory_topic_stats SET aliases_json = ? WHERE id = ? AND workspace_id = ? AND principal_id = ?`)
        .run(JSON.stringify(plan.aliases.reduce(appendAlias, parseAliases(row.aliases_json))), updated.id, scope.workspaceId, scope.principalId);
      const threshold = this.writer.getWorkspaceConfig(scope).interestThreshold;
      if (updated.hits < threshold || updated.promotedItemId) continue;
      try {
        const promoted = this.writer.write(scope, {
          operation: 'add',
        kind: 'interest',
        topic: updated.topic,
        content: `用户持续关注：${updated.topic}`,
        importance: 3,
        origin: 'extracted',
        inferred: false,
        memoryGeneration,
      });
        this.setPromotedItem(scope, updated.id, promoted.item.id, memoryGeneration);
      } catch (error) {
        if (!(error instanceof MemoryWriteError) || !['MEMORY_PREVIOUSLY_FORGOTTEN', 'MEMORY_SENSITIVE_CONTENT'].includes(error.code)) throw error;
      }
    }
  }

  listCandidates(scope: TrustedMemoryScope): TopicCandidate[] {
    return this.list(scope).map(({ normalizedKey, topic, aliases, hits }) => ({ normalizedKey, topic, aliases, hits }));
  }

  list(scope: TrustedMemoryScope): MemoryTopicRecord[] {
    const rows = this.database().prepare(`
      SELECT id, normalized_key, topic, aliases_json, hits, promoted_item_id
      FROM memory_topic_stats
      WHERE workspace_id = ? AND principal_id = ?
      ORDER BY hits DESC, last_seen_at DESC, id DESC LIMIT ?
    `).all(
      scope.workspaceId,
      scope.principalId,
      MEMORY_CONSTANTS.writeAndExtraction.topicCandidateLimit,
    ) as TopicStatRow[];
    return rows.map(mapTopicRecord);
  }

  /** Management can page all topics without expanding the model's topic candidate budget. */
  listPage(scope: TrustedMemoryScope, query: MemoryPageQuery = {}): MemoryPage<MemoryTopicRecord> {
    return readMemoryPage<TopicStatRow, MemoryTopicRecord>(this.database(), query, {
      table: 'memory_topic_stats', select: 'id, normalized_key, topic, aliases_json, hits, promoted_item_id',
      where: 'workspace_id = ? AND principal_id = ?', parameters: [scope.workspaceId, scope.principalId],
      orderBy: 'hits DESC, last_seen_at DESC, id DESC',
    }, mapTopicRecord);
  }

  promote(scope: TrustedMemoryScope, topicId: string): MemoryTopicRecord {
    const row = this.requireTopic(scope, topicId);
    if (!row.promoted_item_id) {
      const promoted = this.writer.createManual(scope, {
        kind: 'interest', topic: row.topic, content: `用户持续关注：${row.topic}`, importance: 3,
      });
      this.database().prepare(`
        UPDATE memory_topic_stats SET promoted_item_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ?
      `).run(promoted.item.id, new Date().toISOString(), topicId, scope.workspaceId, scope.principalId);
    }
    return mapTopicRecord(this.requireTopic(scope, topicId));
  }

  delete(scope: TrustedMemoryScope, topicId: string): void {
    const row = this.requireTopic(scope, topicId);
    if (row.promoted_item_id) {
      try { this.writer.delete(scope, row.promoted_item_id); } catch { /* stale promoted pointer */ }
    }
    this.database().prepare(`DELETE FROM memory_topic_stats WHERE id = ? AND workspace_id = ? AND principal_id = ?`)
      .run(topicId, scope.workspaceId, scope.principalId);
  }

  private async resolveTopic(
    topic: string,
    candidates: TopicCandidate[],
    resolver: MemoryTopicServiceOptions['resolveUncertainTopic'],
  ): Promise<TopicCandidate | undefined> {
    const incomingKey = normalizeTopicKey(topic);
    if (!incomingKey) return undefined;
    const exact = candidates.find((candidate) => candidate.normalizedKey === incomingKey
      || candidate.aliases.some((alias) => normalizeTopicKey(alias) === incomingKey));
    if (exact) return exact;
    const lexical = candidates.find((candidate) => cjkBigramDice(incomingKey, candidate.normalizedKey)
      >= MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicDiceMergeMinimum);
    if (lexical) return lexical;
    if (!resolver || !candidates.length) return undefined;
    const proposedKey = normalizeTopicKey(await resolver({
      topic,
      candidates: candidates.slice(0, MEMORY_CONSTANTS.writeAndExtraction.topicPromptLimit),
    }) ?? '');
    return proposedKey ? candidates.find((candidate) => candidate.normalizedKey === proposedKey) : undefined;
  }

  private upsertHit(
    scope: TrustedMemoryScope,
    rawTopic: string,
    selected: TopicCandidate | undefined,
    memoryGeneration: number,
  ): { id: string; topic: string; hits: number; promotedItemId: string | null } {
    const timestamp = new Date().toISOString();
    return runInImmediateTransaction(this.database(), () => {
      ensureScopeRows(this.database(), scope, timestamp);
      assertCurrentGeneration(this.database(), scope, memoryGeneration);
      const current = selected ? this.database().prepare(`
        SELECT id, normalized_key, topic, aliases_json, hits, promoted_item_id
        FROM memory_topic_stats
        WHERE workspace_id = ? AND principal_id = ? AND normalized_key = ?
      `).get(scope.workspaceId, scope.principalId, selected.normalizedKey) as TopicStatRow | undefined : undefined;
      if (current) {
        const aliases = appendAlias(parseAliases(current.aliases_json), rawTopic);
        const label = selectStableLabel(current.topic, rawTopic);
        this.database().prepare(`
          UPDATE memory_topic_stats
          SET topic = ?, aliases_json = ?, hits = hits + 1, last_seen_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND principal_id = ?
        `).run(label, JSON.stringify(aliases), timestamp, timestamp, current.id, scope.workspaceId, scope.principalId);
        return { id: current.id, topic: label, hits: current.hits + 1, promotedItemId: current.promoted_item_id };
      }
      const key = selected?.normalizedKey ?? normalizeTopicKey(rawTopic);
      if (!key) throw new Error('主题无法生成稳定标识。');
      const id = `memory-topic-${randomUUID()}`;
      this.database().prepare(`
        INSERT INTO memory_topic_stats (
          id, workspace_id, principal_id, normalized_key, topic, aliases_json, hits,
          first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?)
      `).run(id, scope.workspaceId, scope.principalId, key, rawTopic, timestamp, timestamp, timestamp, timestamp);
      return { id, topic: rawTopic, hits: 1, promotedItemId: null };
    });
  }

  private setPromotedItem(scope: TrustedMemoryScope, topicId: string, itemId: string, memoryGeneration: number): void {
    const timestamp = new Date().toISOString();
    runInImmediateTransaction(this.database(), () => {
      assertCurrentGeneration(this.database(), scope, memoryGeneration);
      this.database().prepare(`
        UPDATE memory_topic_stats SET promoted_item_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND principal_id = ? AND promoted_item_id IS NULL
      `).run(itemId, timestamp, topicId, scope.workspaceId, scope.principalId);
    });
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }

  private requireTopic(scope: TrustedMemoryScope, topicId: string): TopicStatRow {
    const row = this.database().prepare(`
      SELECT id, normalized_key, topic, aliases_json, hits, promoted_item_id
      FROM memory_topic_stats WHERE id = ? AND workspace_id = ? AND principal_id = ?
    `).get(topicId, scope.workspaceId, scope.principalId) as TopicStatRow | undefined;
    if (!row) throw new Error('主题不存在。');
    return row;
  }
}

function assertCurrentGeneration(database: Database.Database, scope: TrustedMemoryScope, expected: number): void {
  const row = database.prepare(`
    SELECT memory_generation FROM memory_subjects WHERE workspace_id = ? AND principal_id = ?
  `).get(scope.workspaceId, scope.principalId) as { memory_generation: number } | undefined;
  if (!row || row.memory_generation !== expected) throw new Error('STALE_MEMORY_GENERATION');
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').map(sanitizeMemoryTopic).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapTopicRecord(row: TopicStatRow): MemoryTopicRecord {
  return {
    id: row.id,
    normalizedKey: row.normalized_key,
    topic: row.topic,
    aliases: parseAliases(row.aliases_json),
    hits: row.hits,
    promotedItemId: row.promoted_item_id,
  };
}

function appendAlias(aliases: string[], topic: string): string[] {
  return [...new Set([...aliases, topic])].slice(-MEMORY_CONSTANTS.writeAndExtraction.topicAliasLimit);
}

function selectStableLabel(existing: string, incoming: string): string {
  const existingKey = normalizeTopicKey(existing);
  const incomingKey = normalizeTopicKey(incoming);
  if (Array.from(existingKey).length > MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicLongKeyWarningCodePoints) return existing;
  if (Array.from(incomingKey).length > MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicLongKeyWarningCodePoints) return existing;
  const anchored = cjkBigramDice(existingKey, incomingKey)
    >= MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicLabelBidirectionalAnchorMinimum;
  return anchored && Array.from(incoming).length < Array.from(existing).length ? incoming : existing;
}

function cjkBigramDice(left: string, right: string): number {
  if (Array.from(left).length < MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicDiceMergeMinKeyCodePoints
    || Array.from(right).length < MEMORY_CONSTANTS.lexicalVectorInterestAffinity.topicDiceMergeMinKeyCodePoints) return 0;
  if (![...left, ...right].every((character) => /\p{Script=Han}/u.test(character))) return 0;
  const leftBigrams = cjkBigrams(left);
  const rightBigrams = cjkBigrams(right);
  if (!leftBigrams.size || !rightBigrams.size) return 0;
  let intersection = 0;
  for (const bigram of leftBigrams) if (rightBigrams.has(bigram)) intersection += 1;
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function cjkBigrams(value: string): Set<string> {
  const runes = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index < runes.length - 1; index += 1) result.add(`${runes[index]}${runes[index + 1]}`);
  return result;
}
