import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { classifyMemoryFailure } from '../../../shared/memoryFailure';
import { extractionSourceFingerprint } from './memoryExtractionSourceRepository';
import { MemoryWriteService } from './memoryWriteService';
import { MEMORY_AUTOMATIC_WRITE_READY } from './memoryWritePolicy';
import type { MemorySaveReceipt, MemoryStatus, MemoryTurnStatus, TrustedMemoryScope } from './memoryTypes';

/** Read-only per-turn projection; neither old receipts nor polling can recreate memory. */
export class MemoryTurnStatusService {
  constructor(private readonly owner: QaMemoryDatabase, private readonly storagePath: string,
    private readonly isRouteEnabled: (route: string, agent: string) => boolean,
    private readonly automaticWriteReady: () => boolean = () => MEMORY_AUTOMATIC_WRITE_READY) {}

  get(scope: TrustedMemoryScope, turnIds: readonly string[]): MemoryTurnStatus[] {
    const writer = new MemoryWriteService(this.owner, this.storagePath);
    const enabled = writer.getAvailability(scope).enabled;
    const generation = writer.getSubject(scope).memoryGeneration;
    const config = writer.getWorkspaceConfig(scope);
    const db = this.owner.getDatabase(this.storagePath);
    return [...new Set(turnIds)].flatMap(turnId => {
      const turn = db.prepare(`SELECT turn_id, session_id, user_text, created_at, result_json, result_metadata_json FROM qa_turns
        WHERE turn_id = ? AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
        AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?`).get(turnId, scope.workspaceId, scope.principalId) as {
          turn_id: string; session_id: string; user_text: string; created_at: string; result_json: string; result_metadata_json: string;
        } | undefined;
      if (!turn) return [];
      const metadata = JSON.parse(turn.result_metadata_json) as { memoryExtractionGeneration?: number; memoryExtractionEligible?: boolean; route?: string; memoryExtractionAgentId?: string };
      const result = JSON.parse(turn.result_json) as { memorySave?: MemorySaveReceipt; memoryExtraction?: MemoryTurnStatus['extraction']['summary'] };
      const captured = metadata.memoryExtractionGeneration;
      const stale = captured !== undefined && captured !== generation;
      const currentStatus = (id: string): MemoryStatus | 'deleted' | 'cleared' => {
        if (stale) return 'cleared';
        return (db.prepare('SELECT status FROM memory_items WHERE id=? AND workspace_id=? AND principal_id=? AND memory_generation=?')
          .get(id, scope.workspaceId, scope.principalId, generation) as { status: MemoryStatus } | undefined)?.status ?? 'deleted';
      };
      const explicit = result.memorySave?.itemId ? { itemId: result.memorySave.itemId, currentStatus: currentStatus(result.memorySave.itemId) } : null;
      let extraction: MemoryTurnStatus['extraction'];
      const receipt = db.prepare(`SELECT outcome FROM memory_extraction_turn_receipts WHERE workspace_id=? AND principal_id=? AND memory_generation=? AND turn_id=?`)
        .get(scope.workspaceId, scope.principalId, captured ?? -1, turnId) as { outcome: string } | undefined;
      if (stale) extraction = { status: 'stale', reason: 'STALE_MEMORY_GENERATION' };
      else if (receipt?.outcome === 'legacy_baseline') extraction = { status: 'disabled', reason: 'legacy_baseline' };
      else if (receipt) extraction = { status: 'applied', ...(result.memoryExtraction ? { summary: result.memoryExtraction,
        currentItems: result.memoryExtraction.itemIds.map(id => ({ id, status: currentStatus(id) })) } : {}), reason: receipt.outcome };
      else if (!enabled || config.writeMode !== 'auto' || typeof captured !== 'number' || metadata.memoryExtractionEligible !== true
        || !metadata.route || !metadata.memoryExtractionAgentId || !this.isRouteEnabled(metadata.route, metadata.memoryExtractionAgentId)
        || !this.automaticWriteReady()) extraction = { status: 'disabled', reason: !enabled ? 'memory_disabled'
          : config.writeMode !== 'auto' ? 'explicit_only' : !this.automaticWriteReady() ? 'MEMORY_PROTOCOL_UPGRADE_REQUIRED' : 'route_or_source_ineligible' };
      else {
        const fingerprint = extractionSourceFingerprint(scope, generation, turn);
        const job = db.prepare(`SELECT j.status, j.due_at, j.last_error FROM memory_extraction_jobs j, json_each(j.claimed_sources_json) c
          WHERE j.workspace_id=? AND j.principal_id=? AND j.captured_generation=? AND json_extract(c.value,'$.turnId')=?
          AND json_extract(c.value,'$.fingerprint')=? AND j.status IN ('running','retry','queued','failed')
          ORDER BY j.created_at DESC LIMIT 1`).get(scope.workspaceId, scope.principalId, generation, turnId, fingerprint) as { status: string; due_at: string; last_error: string | null } | undefined;
        const pending = db.prepare(`SELECT due_at FROM memory_extraction_pending_sources WHERE workspace_id=? AND principal_id=? AND memory_generation=? AND turn_id=? AND source_fingerprint=?`)
          .get(scope.workspaceId, scope.principalId, generation, turnId, fingerprint) as { due_at: string } | undefined;
        extraction = { status: job?.status === 'running' ? 'running' : job?.status === 'retry' ? 'retry' : job?.status === 'failed' ? 'failed' : 'waiting',
          ...(pending?.due_at || job?.due_at ? { nextDueAt: pending?.due_at ?? job?.due_at } : {}),
          ...(job?.last_error ? { reason: classifyMemoryFailure(job.last_error) } : {}) };
      }
      return [{ turnId, memoryEnabled: enabled, explicit, extraction }];
    });
  }
}
