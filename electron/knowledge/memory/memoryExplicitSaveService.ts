import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { runInImmediateTransaction } from './memoryRepository';
import { detectExplicitMemoryStatement } from './memoryText';
import { MemoryWriteError, MemoryWriteService } from './memoryWriteService';
import type { MemorySaveReceipt, TrustedMemoryScope } from './memoryTypes';

/** Save and acknowledgement commit together; owner and start generation are checked again. */
export function saveCompletedExplicitMemory(owner: QaMemoryDatabase, storagePath: string, scope: TrustedMemoryScope,
  input: { sessionId: string; messageId: string; userText: string }): MemorySaveReceipt | undefined {
  const statement = detectExplicitMemoryStatement(input.userText);
  if (!statement) return undefined;
  const database = owner.getDatabase(storagePath);
  const writer = new MemoryWriteService(owner, storagePath);
  const persistReceipt = (receipt: MemorySaveReceipt) => {
    database.prepare(`UPDATE qa_turns SET result_json = json_set(result_json, '$.memorySave', json(?)),
      result_metadata_json = json_set(result_metadata_json, '$.memoryExplicitSavePending', json('false'))
      WHERE turn_id = ? AND session_id = ? AND user_text = ?
        AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
        AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?`)
      .run(JSON.stringify(receipt), input.messageId, input.sessionId, input.userText, scope.workspaceId, scope.principalId);
    return receipt;
  };
  try {
    return runInImmediateTransaction(database, () => {
      const source = database.prepare(`SELECT t.result_json, t.result_metadata_json FROM qa_turns t
        JOIN memory_subjects s ON s.workspace_id = ? AND s.principal_id = ?
        WHERE t.turn_id = ? AND t.session_id = ? AND t.status = 'complete' AND t.replaced_by_turn_id IS NULL
          AND t.user_text = ? AND json_extract(t.result_metadata_json, '$.memoryScope.workspaceId') = s.workspace_id
          AND json_extract(t.result_metadata_json, '$.memoryScope.principalId') = s.principal_id
          AND json_type(t.result_metadata_json, '$.memoryExtractionGeneration') = 'integer'
          AND json_extract(t.result_metadata_json, '$.memoryExtractionGeneration') = s.memory_generation`)
        .get(scope.workspaceId, scope.principalId, input.messageId, input.sessionId, input.userText) as
          { result_json: string; result_metadata_json: string } | undefined;
      if (!source) return persistReceipt({ status: 'failed', code: 'STALE_MEMORY_SOURCE' });
      const previous = (JSON.parse(source.result_json) as { memorySave?: MemorySaveReceipt }).memorySave;
      if (previous) return previous;
      if (!writer.getAvailability(scope).enabled) return persistReceipt({ status: 'disabled', code: 'MEMORY_DISABLED' });
      const metadata = JSON.parse(source.result_metadata_json) as { memoryExplicitSaveEnabled?: boolean };
      if (metadata.memoryExplicitSaveEnabled === false) return persistReceipt({ status: 'disabled', code: 'MEMORY_DISABLED_AT_START' });
      const outcome = writer.writeExplicit(scope, statement, { sessionId: input.sessionId, messageId: input.messageId });
      return persistReceipt({ status: outcome.item.status === 'pending' ? 'pending' : 'saved',
        itemId: outcome.item.id, itemStatus: outcome.item.status, archivedItemIds: outcome.archivedItemIds });
    });
  } catch (error) {
    const code = error instanceof MemoryWriteError ? error.code : 'MEMORY_SAVE_FAILED';
    return persistReceipt({ status: code === 'MEMORY_DISABLED' ? 'disabled' : 'failed', code });
  }
}

/** Only journalled requests from this version resume; forgotten or unowned history never replays. */
export function recoverCompletedExplicitMemories(owner: QaMemoryDatabase, storagePath: string, scope: TrustedMemoryScope): void {
  const database = owner.getDatabase(storagePath);
  const sources = database.prepare(`SELECT turn_id, session_id, user_text FROM qa_turns
    WHERE status = 'complete' AND replaced_by_turn_id IS NULL
      AND json_extract(result_metadata_json, '$.memoryExplicitSavePending') = 1
      AND json_extract(result_metadata_json, '$.memoryScope.workspaceId') = ?
      AND json_extract(result_metadata_json, '$.memoryScope.principalId') = ?`)
    .all(scope.workspaceId, scope.principalId) as Array<{ turn_id: string; session_id: string; user_text: string }>;
  for (const source of sources) saveCompletedExplicitMemory(owner, storagePath, scope,
    { sessionId: source.session_id, messageId: source.turn_id, userText: source.user_text });
}
