import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { MEMORY_CONSTANTS } from './memoryConstants';
import { ensureScopeRows, MemoryRepository, runInImmediateTransaction } from './memoryRepository';
import type {
  MemoryDocumentAffinity,
  MemoryDocumentCitation,
  MemoryPage,
  MemoryPageQuery,
  TrustedMemoryScope,
} from './memoryTypes';
import { readMemoryPage } from './memoryPagination';

interface AffinityRow {
  workspace_id: string;
  principal_id: string;
  document_id: string;
  knowledge_base_id: string | null;
  title: string;
  hits: number;
  first_used_at: string;
  last_used_at: string;
}

export interface AffinityScoredCandidate<T> {
  documentId: string;
  score: number;
  value: T;
}

/**
 * A weak post-admission preference. Callers must pass only candidates that
 * have already passed the retrieval/rerank relevance gate.
 */
export class MemoryAffinityService {
  private readonly repository: MemoryRepository;

  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {
    this.repository = new MemoryRepository(databaseOwner, storageWorkspacePath);
  }

  recordCompletedAnswer(
    scope: TrustedMemoryScope,
    turnId: string,
    citations: readonly MemoryDocumentCitation[],
    now = new Date(),
  ): number {
    if (!turnId.trim() || !this.repository.resolveAvailability(scope).enabled) return 0;
    const unique = new Map<string, MemoryDocumentCitation>();
    for (const citation of citations) {
      const documentId = citation.documentId.trim();
      if (!documentId || unique.has(documentId)) continue;
      unique.set(documentId, { ...citation, documentId });
    }
    if (!unique.size) return 0;
    const database = this.database();
    const timestamp = now.toISOString();
    return runInImmediateTransaction(database, () => {
      ensureScopeRows(database, scope, timestamp);
      const insertEvent = database.prepare(`
        INSERT INTO memory_doc_affinity_events (
          turn_id, workspace_id, principal_id, document_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, document_id) DO NOTHING
      `);
      const upsert = database.prepare(`
        INSERT INTO memory_doc_affinities (
          id, workspace_id, principal_id, document_id, knowledge_base_id,
          title, hits, first_used_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(workspace_id, principal_id, document_id) DO UPDATE SET
          knowledge_base_id = COALESCE(excluded.knowledge_base_id, memory_doc_affinities.knowledge_base_id),
          title = CASE WHEN length(trim(excluded.title)) > 0 THEN excluded.title ELSE memory_doc_affinities.title END,
          hits = memory_doc_affinities.hits + 1,
          last_used_at = excluded.last_used_at
      `);
      let recorded = 0;
      for (const citation of unique.values()) {
        const event = insertEvent.run(turnId, scope.workspaceId, scope.principalId, citation.documentId, timestamp);
        if (event.changes === 0) continue;
        upsert.run(
          affinityId(scope, citation.documentId),
          scope.workspaceId,
          scope.principalId,
          citation.documentId,
          citation.knowledgeBaseId?.trim() || null,
          citation.title?.trim() || '',
          timestamp,
          timestamp,
        );
        recorded += 1;
      }
      return recorded;
    });
  }

  listForCandidates(scope: TrustedMemoryScope, documentIds: readonly string[]): Map<string, MemoryDocumentAffinity> {
    if (!this.repository.resolveAvailability(scope).enabled) return new Map();
    const ids = [...new Set(documentIds.map((id) => id.trim()).filter(Boolean))]
      .slice(0, MEMORY_CONSTANTS.lexicalVectorInterestAffinity.documentAffinityCandidateLimit);
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database().prepare(`
      SELECT workspace_id, principal_id, document_id, knowledge_base_id, title,
        hits, first_used_at, last_used_at
      FROM memory_doc_affinities
      WHERE workspace_id = ? AND principal_id = ? AND document_id IN (${placeholders})
    `).all(scope.workspaceId, scope.principalId, ...ids) as AffinityRow[];
    return new Map(rows.map((row) => [row.document_id, mapAffinity(row)]));
  }

  list(scope: TrustedMemoryScope, limit = 50): MemoryDocumentAffinity[] {
    const bounded = Math.max(1, Math.min(MEMORY_CONSTANTS.management.listMaxLimit, Math.trunc(limit)));
    const rows = this.database().prepare(`
      SELECT workspace_id, principal_id, document_id, knowledge_base_id, title,
        hits, first_used_at, last_used_at
      FROM memory_doc_affinities
      WHERE workspace_id = ? AND principal_id = ?
      ORDER BY hits DESC, last_used_at DESC, document_id ASC LIMIT ?
    `).all(scope.workspaceId, scope.principalId, bounded) as AffinityRow[];
    return rows.map(mapAffinity);
  }

  /** Management paging remains separate from bounded retrieval-affinity candidates. */
  listPage(scope: TrustedMemoryScope, query: MemoryPageQuery = {}): MemoryPage<MemoryDocumentAffinity> {
    return readMemoryPage<AffinityRow, MemoryDocumentAffinity>(this.database(), query, {
      table: 'memory_doc_affinities', select: 'workspace_id, principal_id, document_id, knowledge_base_id, title, hits, first_used_at, last_used_at',
      where: 'workspace_id = ? AND principal_id = ?', parameters: [scope.workspaceId, scope.principalId],
      orderBy: 'hits DESC, last_used_at DESC, document_id ASC',
    }, mapAffinity);
  }

  delete(scope: TrustedMemoryScope, documentId: string): boolean {
    const normalized = documentId.trim();
    if (!normalized) return false;
    return runInImmediateTransaction(this.database(), () => {
      this.database().prepare(`
        DELETE FROM memory_doc_affinity_events
        WHERE workspace_id = ? AND principal_id = ? AND document_id = ?
      `).run(scope.workspaceId, scope.principalId, normalized);
      return this.database().prepare(`
        DELETE FROM memory_doc_affinities
        WHERE workspace_id = ? AND principal_id = ? AND document_id = ?
      `).run(scope.workspaceId, scope.principalId, normalized).changes > 0;
    });
  }

  rerankAdmitted<T>(scope: TrustedMemoryScope, candidates: readonly AffinityScoredCandidate<T>[]): Array<AffinityScoredCandidate<T> & { affinityHits: number; affinityFactor: number }> {
    const bounded = candidates.slice(0, MEMORY_CONSTANTS.lexicalVectorInterestAffinity.documentAffinityCandidateLimit);
    const affinity = this.listForCandidates(scope, bounded.map((candidate) => candidate.documentId));
    return applyDocumentAffinity(bounded, affinity);
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

export function calculateDocumentAffinityFactor(hits: number): number {
  const contract = MEMORY_CONSTANTS.lexicalVectorInterestAffinity;
  if (!Number.isFinite(hits) || hits < contract.documentAffinityMinimumHits) return 1;
  const ratio = Math.min(1, Math.log1p(Math.max(0, Math.trunc(hits))) / Math.log1p(contract.documentAffinitySaturationHits));
  return Math.min(contract.documentAffinityMaximumFactor, 1 + (contract.documentAffinityMaximumFactor - 1) * ratio);
}

export function applyDocumentAffinity<T>(
  candidates: readonly AffinityScoredCandidate<T>[],
  affinity: ReadonlyMap<string, Pick<MemoryDocumentAffinity, 'hits'>>,
): Array<AffinityScoredCandidate<T> & { affinityHits: number; affinityFactor: number }> {
  return candidates.map((candidate, index) => {
    const hits = affinity.get(candidate.documentId)?.hits ?? 0;
    const factor = calculateDocumentAffinityFactor(hits);
    return {
      ...candidate,
      score: Number((candidate.score * factor).toFixed(6)),
      affinityHits: hits,
      affinityFactor: Number(factor.toFixed(6)),
      __stableIndex: index,
    };
  }).sort((left, right) => right.score - left.score || left.__stableIndex - right.__stableIndex)
    .map(({ __stableIndex: _index, ...candidate }) => candidate);
}

function affinityId(scope: TrustedMemoryScope, documentId: string): string {
  const digest = createHash('sha256')
    .update(`${scope.workspaceId}\u0000${scope.principalId}\u0000${documentId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `memory-affinity-${digest}-${randomUUID().slice(0, 8)}`;
}

function mapAffinity(row: AffinityRow): MemoryDocumentAffinity {
  return {
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    documentId: row.document_id,
    knowledgeBaseId: row.knowledge_base_id,
    title: row.title,
    hits: row.hits,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
  };
}
