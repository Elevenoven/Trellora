import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assertTrustedMemoryScope } from './memoryScope';
import type { MemoryExtractionSourceClaim, MemoryExtractionUserMessage, MemoryScope, TrustedMemoryScope } from './memoryTypes';
import { MEMORY_EXTRACTOR_VERSION } from './memoryExtractor';

export interface MemoryExtractionOutcome {
  itemIds: string[]; active: number; pending: number; reused: number; archived: number; skipped: string[];
}

type SourceRow = { turn_id: string; session_id: string; user_text: string; created_at: string; result_metadata_json: string };
export type ExtractionRouteValidator = (route: string, agentId: string) => boolean;

/** WEKNORA_PARITY_HARDENING: one scoped source reader; missing provenance fails closed; receipts replace timestamp exclusion. */
export class MemoryExtractionSourceRepository {
  constructor(private readonly database: Database.Database, private readonly isRouteEnabled: ExtractionRouteValidator) {}

  eligible(scope: TrustedMemoryScope, generation: number, unprocessed = true,
    options: { ids?: string[]; limit?: number; before?: MemoryExtractionUserMessage; descending?: boolean } = {}): MemoryExtractionUserMessage[] {
    assertTrustedMemoryScope(scope);
    if (options.ids && !options.ids.length) return [];
    const rows = this.database.prepare(`SELECT t.turn_id, t.session_id, t.user_text, t.created_at, t.result_metadata_json FROM qa_turns t
      WHERE t.status = 'complete' AND t.replaced_by_turn_id IS NULL AND length(trim(t.user_text)) > 0
      AND json_extract(t.result_metadata_json, '$.memoryScope.workspaceId') = ?
      AND json_extract(t.result_metadata_json, '$.memoryScope.principalId') = ?
      AND json_type(t.result_metadata_json, '$.memoryExtractionGeneration') = 'integer'
      AND json_extract(t.result_metadata_json, '$.memoryExtractionGeneration') = ?
      AND json_type(t.result_metadata_json, '$.memoryExtractionEligible') = 'true'
      ${unprocessed ? `AND NOT EXISTS (SELECT 1 FROM memory_extraction_turn_receipts r WHERE r.workspace_id = ? AND r.principal_id = ? AND r.memory_generation = ? AND r.turn_id = t.turn_id)` : ''}
      ${options.ids ? `AND t.turn_id IN (${options.ids.map(() => '?').join(',')})` : ''}
      ${options.before ? 'AND (t.created_at < ? OR (t.created_at = ? AND t.turn_id < ?))' : ''}
      ORDER BY t.created_at ${options.descending ? 'DESC' : 'ASC'}, t.turn_id ${options.descending ? 'DESC' : 'ASC'}`).iterate(scope.workspaceId, scope.principalId, generation,
      ...(unprocessed ? [scope.workspaceId, scope.principalId, generation] : []), ...(options.ids ?? []),
      ...(options.before ? [options.before.createdAt, options.before.createdAt, options.before.messageId] : [])) as Iterable<SourceRow>;
    const exhausted = unprocessed ? this.exhausted(scope, generation) : new Set<string>();
    const messages: MemoryExtractionUserMessage[] = [];
    for (const row of rows) {
      const metadata = JSON.parse(row.result_metadata_json) as { route?: unknown; memoryExtractionAgentId?: unknown };
      if (typeof metadata.route !== 'string' || typeof metadata.memoryExtractionAgentId !== 'string'
        || !this.isRouteEnabled(metadata.route, metadata.memoryExtractionAgentId)) continue;
      const fingerprint = extractionSourceFingerprint(scope, generation, row);
      if (exhausted.has(`${row.turn_id}:${fingerprint}`)) continue;
      messages.push({ messageId: row.turn_id, sessionId: row.session_id, content: row.user_text, createdAt: row.created_at, sourceFingerprint: fingerprint });
      if (messages.length >= (options.limit ?? Infinity)) break;
    }
    return messages;
  }

  readClaim(scope: TrustedMemoryScope, generation: number, claims: MemoryExtractionSourceClaim[]): MemoryExtractionUserMessage[] {
    const available = new Map(this.eligible(scope, generation, true, { ids: claims.map((claim) => claim.turnId) }).map((source) => [source.messageId, source]));
    const result: MemoryExtractionUserMessage[] = [];
    for (const claim of claims) {
      if (this.hasReceipt(scope, generation, claim.turnId)) continue;
      const source = available.get(claim.turnId);
      if (!source || source.sourceFingerprint !== claim.fingerprint || claim.generation !== generation) throw new Error('SOURCE_CHANGED');
      result.push(source);
    }
    return result.sort((left, right) => compareBinary(left.createdAt, right.createdAt) || compareBinary(left.messageId, right.messageId));
  }

  assertUnchanged(scope: TrustedMemoryScope, generation: number, messages: MemoryExtractionUserMessage[]): void {
    const current = new Map(this.eligible(scope, generation, true, { ids: messages.map((message) => message.messageId) }).map((source) => [source.messageId, source]));
    for (const message of messages) {
      if (!message.sourceFingerprint || current.get(message.messageId)?.sourceFingerprint !== message.sourceFingerprint) throw new Error('SOURCE_CHANGED');
    }
  }

  commit(scope: TrustedMemoryScope, generation: number, jobId: string, messages: MemoryExtractionUserMessage[],
    outcomes?: ReadonlyMap<string, MemoryExtractionOutcome>): void {
    const timestamp = new Date().toISOString();
    const insert = this.database.prepare(`INSERT INTO memory_extraction_turn_receipts VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?)`);
    for (const source of messages) {
      insert.run(scope.workspaceId, scope.principalId, generation, source.messageId, source.sourceFingerprint, MEMORY_EXTRACTOR_VERSION, jobId, timestamp);
      const outcome = outcomes?.get(source.messageId);
      if (outcome) this.database.prepare(`UPDATE qa_turns SET result_json = json_set(result_json, '$.memoryExtraction', json(?))
        WHERE turn_id = ? AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
        AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?`).run(JSON.stringify({
          status: 'applied', schemaVersion: 2, generation, completedAt: timestamp, ...outcome,
        }), source.messageId, scope.workspaceId, scope.principalId);
    }
    const latest = messages.at(-1);
    if (!latest) return;
    const changed = this.database.prepare(`UPDATE memory_subjects SET
      extract_cursor_at = CASE WHEN extract_cursor_at IS NULL OR extract_cursor_at < ? OR (extract_cursor_at = ? AND extract_cursor_message_id < ?) THEN ? ELSE extract_cursor_at END,
      extract_cursor_message_id = CASE WHEN extract_cursor_at IS NULL OR extract_cursor_at < ? OR (extract_cursor_at = ? AND extract_cursor_message_id < ?) THEN ? ELSE extract_cursor_message_id END,
      last_extracted_at = ?, updated_at = ? WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ?`).run(
      latest.createdAt, latest.createdAt, latest.messageId, latest.createdAt,
      latest.createdAt, latest.createdAt, latest.messageId, latest.messageId, timestamp, timestamp, scope.workspaceId, scope.principalId, generation).changes;
    if (!changed) throw new Error('STALE_MEMORY_GENERATION');
  }

  private hasReceipt(scope: TrustedMemoryScope, generation: number, turnId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM memory_extraction_turn_receipts WHERE workspace_id = ? AND principal_id = ? AND memory_generation = ? AND turn_id = ?`)
      .get(scope.workspaceId, scope.principalId, generation, turnId));
  }

  private exhausted(scope: TrustedMemoryScope, generation: number): Set<string> {
    const jobs = this.database.prepare(`SELECT claimed_sources_json FROM memory_extraction_jobs
      WHERE workspace_id = ? AND principal_id = ? AND captured_generation = ? AND status = 'failed'`).all(scope.workspaceId, scope.principalId, generation) as { claimed_sources_json: string }[];
    return new Set(jobs.flatMap((job) => parseSourceClaims(job.claimed_sources_json).map((claim) => `${claim.turnId}:${claim.fingerprint}`)));
  }
}

function compareBinary(left: string, right: string): number { return left === right ? 0 : left < right ? -1 : 1; }

export function extractionSourceFingerprint(scope: MemoryScope, generation: number, row: SourceRow): string {
  const metadata = JSON.parse(row.result_metadata_json) as { route?: string; memoryExtractionAgentId?: string };
  return createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.principalId, generation,
    row.turn_id, row.session_id, row.created_at, metadata.route, metadata.memoryExtractionAgentId, row.user_text])).digest('hex');
}

export function parseSourceClaims(value: string): MemoryExtractionSourceClaim[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('INVALID_EXTRACTION_SOURCE_CLAIM');
  return parsed.map((claim: unknown) => {
    if (!claim || typeof claim !== 'object') throw new Error('INVALID_EXTRACTION_SOURCE_CLAIM');
    const row = claim as MemoryExtractionSourceClaim;
    if (typeof row.turnId !== 'string' || !row.turnId || typeof row.fingerprint !== 'string' || !row.fingerprint
      || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new Error('INVALID_EXTRACTION_SOURCE_CLAIM');
    return { turnId: row.turnId, fingerprint: row.fingerprint, generation: row.generation };
  });
}

export function claimSources(messages: MemoryExtractionUserMessage[], generation: number): MemoryExtractionSourceClaim[] {
  return messages.map((source) => ({ turnId: source.messageId, fingerprint: source.sourceFingerprint!, generation }));
}
