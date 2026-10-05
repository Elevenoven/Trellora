import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS, type MemoryKind } from './memoryConstants';
import { MemoryRepository } from './memoryRepository';
import { truncateCodePoints } from './memoryText';
import type { MemoryItemRecord, TrustedMemoryScope } from './memoryTypes';
import { mapMemoryItemMetadata, type MemoryItemMetadataRow } from './memoryWritePolicy';

interface ConditioningItemRow extends MemoryItemMetadataRow {
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

export interface RetrievalConditioningResult {
  prompt: string;
  itemIds: string[];
  familiarDocumentIds: string[];
  contentCodePoints: number;
}

const EMPTY_CONDITIONING: RetrievalConditioningResult = {
  prompt: '', itemIds: [], familiarDocumentIds: [], contentCodePoints: 0,
};

/**
 * Query-rewrite-only background. It never returns filter fields and therefore
 * cannot narrow a knowledge base, document id set, or evidence scope.
 */
export class MemoryConditioningService {
  private readonly repository: MemoryRepository;

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {
    this.repository = new MemoryRepository(databaseOwner, storageWorkspacePath);
  }

  build(scope: TrustedMemoryScope): RetrievalConditioningResult {
    const availability = this.repository.resolveAvailability(scope);
    const config = this.repository.getWorkspaceConfig(scope);
    if (!availability.enabled || !config.retrievalConditioning) return EMPTY_CONDITIONING;
    const now = new Date().toISOString();
    const items = (this.database().prepare(`
      SELECT * FROM memory_items
      WHERE workspace_id = ? AND principal_id = ? AND status = 'active'
        AND kind IN ('profile', 'interest')
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, valid_from DESC, id DESC
      LIMIT ?
    `).all(
      scope.workspaceId,
      scope.principalId,
      now,
      MEMORY_CONSTANTS.recall.retrievalConditioning.candidateLimit,
    ) as ConditioningItemRow[]).map(mapItem);
    const familiar = this.database().prepare(`
      SELECT document_id, title FROM memory_doc_affinities
      WHERE workspace_id = ? AND principal_id = ? AND length(trim(title)) > 0
      ORDER BY hits DESC, last_used_at DESC, document_id ASC LIMIT ?
    `).all(
      scope.workspaceId,
      scope.principalId,
      MEMORY_CONSTANTS.recall.retrievalConditioning.familiarDocumentLimit,
    ) as Array<{ document_id: string; title: string }>;
    const lines = [
      ...items.map((item) => `- ${item.topic.trim() ? `${item.topic.trim()}：` : ''}${item.content.trim()}`),
      ...(familiar.length ? [`- 熟悉文档：${familiar.map((entry) => entry.title.trim()).join('、')}`] : []),
    ];
    const content = fitLines(lines, MEMORY_CONSTANTS.recall.retrievalConditioning.outputMaxCodePoints);
    if (!content) return EMPTY_CONDITIONING;
    return {
      prompt: `<asker_background note="仅用于消解问题语境，不是检索过滤条件">\n${escapeXmlText(content)}\n</asker_background>`,
      itemIds: items.map((item) => item.id),
      familiarDocumentIds: familiar.map((entry) => entry.document_id),
      contentCodePoints: Array.from(content).length,
    };
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

function fitLines(lines: readonly string[], maximum: number): string {
  const selected: string[] = [];
  let used = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (!line) continue;
    const separator = selected.length ? 1 : 0;
    const remaining = maximum - used - separator;
    if (remaining <= 0) break;
    const fitted = truncateCodePoints(line, remaining).trim();
    if (!fitted) continue;
    selected.push(fitted);
    used += separator + Array.from(fitted).length;
  }
  return selected.join('\n');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function mapItem(row: ConditioningItemRow): MemoryItemRecord {
  return {
    ...mapMemoryItemMetadata(row),
    id: row.id, workspaceId: row.workspace_id, principalId: row.principal_id,
    kind: row.kind, content: row.content, topic: row.topic, normalizedKey: row.normalized_key,
    importance: row.importance, origin: row.origin, status: row.status,
    sourceSessionId: row.source_session_id, sourceMessageId: row.source_message_id,
    validFrom: row.valid_from, invalidAt: row.invalid_at, expiresAt: row.expires_at,
    supersededBy: row.superseded_by, lastUsedAt: row.last_used_at, useCount: row.use_count,
    memoryGeneration: row.memory_generation, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
