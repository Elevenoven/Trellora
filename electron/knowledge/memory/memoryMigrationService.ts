import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getAssistantMemoryDatabasePath, type AssistantMemoryDatabase } from '../assistantMemoryDatabase';
import { QaMemoryDatabase } from '../qaMemoryDatabase';
import { estimateTokenCount } from '../tokenEstimator';
import { MEMORY_CONSTANTS, type MemoryKind, type MemoryOrigin, type MemoryStatus } from './memoryConstants';
import { ensureScopeRows, runInImmediateTransaction } from './memoryRepository';
import { isMostlyRedacted, memoryFingerprint, memoryItemKey, redactSensitiveMemoryContent, sanitizeMemoryContent, sanitizeMemoryTopic } from './memoryText';
import type { MemoryMigrationReport, TrustedMemoryScope } from './memoryTypes';

interface LegacyProfileRow {
  item_id: string;
  category: string;
  field_label: string;
  value_text: string;
  assertion_kind: string;
  status: string;
  temporal_status: string;
  stability: string;
  confidence: number;
  user_locked: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacyCurrentNoteTurnRow {
  turn_id: string;
  session_id: string;
  turn_seq: number;
  title: string;
  session_status: string;
  note_id: string;
  relative_path: string;
  note_content_hash: string;
  user_text: string;
  assistant_text: string | null;
  route: string;
  context_mode: string;
  status: string;
  model: string;
  created_at: string;
  finished_at: string | null;
}

/** One-time, audited M8 migration into canonical L3/L4 stores. */
export class MemoryMigrationService {
  constructor(
    private readonly databaseOwner: QaMemoryDatabase,
    private readonly assistantMemoryDatabase: AssistantMemoryDatabase,
    private readonly storageWorkspacePath: string,
  ) {}

  migrate(scope: TrustedMemoryScope, libraryPaths: readonly string[]): MemoryMigrationReport {
    const report: MemoryMigrationReport = {
      profile: { completed: 0, skipped: 0, failed: 0 },
      currentNote: { completed: 0, skipped: 0, failed: 0 },
    };
    this.migrateProfile(scope, report);
    for (const libraryPath of [...new Set(libraryPaths.map((value) => value.trim()).filter(Boolean))]) {
      this.migrateCurrentNote(scope, libraryPath, report);
    }
    return report;
  }

  private migrateProfile(scope: TrustedMemoryScope, report: MemoryMigrationReport): void {
    const database = this.database();
    const rows = database.prepare(`
      SELECT item_id, category, field_label, value_text, assertion_kind, status,
        temporal_status, stability, confidence, user_locked, expires_at, created_at, updated_at
      FROM user_profile_items ORDER BY created_at ASC, item_id ASC
    `).all() as LegacyProfileRow[];
    for (const row of rows) {
      const sourceFingerprint = hash(JSON.stringify(row));
      if (alreadyMigrated(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint)) {
        report.profile.skipped += 1;
        continue;
      }
      try {
        const mapping = mapProfile(row);
        runInImmediateTransaction(database, () => {
          ensureScopeRows(database, scope, row.updated_at || new Date().toISOString());
          if (!mapping) {
            writeAudit(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint, 'memory_item', null, { reason: 'one-off-or-ineligible' }, 'skipped');
            return;
          }
          const rawContent = mapping.kind === 'profile'
            ? `${row.field_label.trim()}：${row.value_text.trim()}`
            : row.value_text;
          const needsManualReview = Array.from(rawContent).length > MEMORY_CONSTANTS.writeAndExtraction.contentMaxCodePoints;
          const effectiveMapping = needsManualReview
            ? { ...mapping, status: 'pending' as const, manualReviewReason: 'content-over-300-code-points' }
            : mapping;
          const content = sanitizeMemoryContent(rawContent);
          const redacted = redactSensitiveMemoryContent(content).content;
          if (!redacted || isMostlyRedacted(redacted)) {
            writeAudit(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint, 'memory_item', null, { reason: 'sensitive-or-empty' }, 'skipped');
            return;
          }
          const topic = sanitizeMemoryTopic(row.field_label);
          const fingerprint = memoryFingerprint(redacted);
          const targetId = `migrated-profile-${hash(`${row.item_id}\u0000${sourceFingerprint}`).slice(0, 32)}`;
          if (mapping.rejected) {
            database.prepare(`
              INSERT INTO memory_tombstones (
                id, workspace_id, principal_id, kind, topic, fingerprint, memory_generation, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(workspace_id, principal_id, fingerprint) DO NOTHING
            `).run(`tombstone-${targetId}`, scope.workspaceId, scope.principalId, mapping.kind, topic, fingerprint, row.updated_at);
            writeAudit(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint, 'memory_tombstone', `tombstone-${targetId}`, effectiveMapping, 'completed');
            return;
          }
          const normalizedKey = memoryItemKey(topic, redacted);
          const duplicate = database.prepare(`
            SELECT id FROM memory_items WHERE workspace_id = ? AND principal_id = ? AND kind = ?
              AND normalized_key = ? AND status IN ('active', 'pending') LIMIT 1
          `).get(scope.workspaceId, scope.principalId, mapping.kind, normalizedKey) as { id: string } | undefined;
          const actualTargetId = duplicate?.id ?? targetId;
          if (!duplicate) database.prepare(`
            INSERT OR IGNORE INTO memory_items (
              id, workspace_id, principal_id, kind, content, topic, normalized_key,
              importance, origin, status, expires_at, memory_generation, created_at, updated_at,
              valid_from, invalid_at, proposal_action, review_reason, write_protection
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'legacy')
          `).run(
            targetId, scope.workspaceId, scope.principalId, mapping.kind, redacted, topic, normalizedKey,
            effectiveMapping.importance, effectiveMapping.origin, effectiveMapping.status, row.expires_at, row.created_at, row.updated_at,
            row.created_at, ['archived', 'superseded'].includes(effectiveMapping.status) ? row.updated_at : null,
            effectiveMapping.status === 'pending' ? 'add' : null,
            effectiveMapping.status === 'pending' ? 'LEGACY_PROPOSAL' : null,
          );
          writeAudit(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint, 'memory_item', actualTargetId, effectiveMapping, 'completed');
          refreshSubject(database, scope, row.updated_at);
        });
        const audit = auditStatus(database, 'qa-memory', 'user_profile_items', row.item_id);
        report.profile[audit === 'completed' ? 'completed' : 'skipped'] += 1;
      } catch (error) {
        writeAudit(database, 'qa-memory', 'user_profile_items', row.item_id, sourceFingerprint, 'memory_item', null, {}, 'failed', error);
        report.profile.failed += 1;
      }
    }
  }

  private migrateCurrentNote(scope: TrustedMemoryScope, libraryPath: string, report: MemoryMigrationReport): void {
    if (!fs.existsSync(getAssistantMemoryDatabasePath(libraryPath))) return;
    let source: Database.Database;
    try {
      source = this.assistantMemoryDatabase.getDatabase(libraryPath);
    } catch {
      report.currentNote.failed += 1;
      return;
    }
    const sourceStore = `assistant-memory:${hash(libraryPath).slice(0, 16)}`;
    const rows = source.prepare(`
      SELECT turns.turn_id, turns.session_id, turns.turn_seq, sessions.title,
        sessions.status AS session_status, notes.note_id, notes.relative_path,
        turns.note_content_hash, turns.user_text, turns.assistant_text, turns.route,
        turns.context_mode, turns.status, turns.model, turns.created_at, turns.finished_at
      FROM assistant_turns AS turns
      JOIN assistant_sessions AS sessions ON sessions.session_id = turns.session_id
      JOIN assistant_note_identity AS notes ON notes.note_id = sessions.note_id
      ORDER BY sessions.created_at ASC, turns.turn_seq ASC
    `).all() as LegacyCurrentNoteTurnRow[];
    const database = this.database();
    for (const row of rows) {
      const sourceFingerprint = hash(JSON.stringify(row));
      if (alreadyMigrated(database, sourceStore, 'assistant_turns', row.turn_id, sourceFingerprint)) {
        report.currentNote.skipped += 1;
        continue;
      }
      try {
        if (!['complete', 'partial', 'not-found'].includes(row.status) || !row.assistant_text?.trim()) {
          writeAudit(database, sourceStore, 'assistant_turns', row.turn_id, sourceFingerprint, 'qa_turn', null, { sourceStatus: row.status }, 'skipped');
          report.currentNote.skipped += 1;
          continue;
        }
        const targetSessionId = `current-note-session-${hash(`${sourceStore}\u0000${row.session_id}`).slice(0, 32)}`;
        const targetTurnId = `current-note-turn-${hash(`${sourceStore}\u0000${row.turn_id}`).slice(0, 32)}`;
        runInImmediateTransaction(database, () => {
          ensureScopeRows(database, scope, row.created_at);
          database.prepare(`
            INSERT INTO qa_sessions (
              session_id, scope, title, library_path, is_pinned, last_turn_seq,
              summarized_through_seq, created_at, updated_at
            ) VALUES (?, 'knowledge-base', ?, ?, 0, ?, 0, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              title = excluded.title, last_turn_seq = MAX(qa_sessions.last_turn_seq, excluded.last_turn_seq),
              updated_at = MAX(qa_sessions.updated_at, excluded.updated_at)
          `).run(targetSessionId, row.title || '当前笔记历史', libraryPath, row.turn_seq, row.created_at, row.finished_at ?? row.created_at);
          const metadata = JSON.stringify({
            schemaVersion: 1,
            route: `current-note-${row.route}`,
            attachments: [],
            memoryScope: { workspaceId: scope.workspaceId, principalId: scope.principalId },
            legacyCurrentNote: {
              libraryPath, noteId: row.note_id, relativePath: row.relative_path,
              contentHash: row.note_content_hash, contextMode: row.context_mode,
            },
          });
          database.prepare(`
            INSERT OR IGNORE INTO qa_turns (
              turn_id, session_id, turn_seq, request_id, attempt_no, user_text,
              assistant_text, scope_label, status, user_tokens, assistant_tokens,
              result_json, result_metadata_json, created_at, finished_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, '当前笔记', ?, ?, ?, '{}', ?, ?, ?)
          `).run(
            targetTurnId, targetSessionId, row.turn_seq, targetTurnId, row.user_text,
            row.assistant_text, row.status, estimateTokenCount(row.user_text), estimateTokenCount(row.assistant_text),
            metadata, row.created_at, row.finished_at ?? row.created_at,
          );
          const archiveHash = hash(`${row.user_text.trim()}\n${row.assistant_text!.trim()}`);
          database.prepare(`
            INSERT OR IGNORE INTO conversation_search_documents (
              turn_id, workspace_id, principal_id, session_id, question, answer,
              search_text, content_hash, index_state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
          `).run(
            targetTurnId, scope.workspaceId, scope.principalId, targetSessionId,
            row.user_text, row.assistant_text, normalizeSearchText(`${row.user_text}\n${row.assistant_text}`), archiveHash, row.created_at,
          );
          writeAudit(database, sourceStore, 'assistant_turns', row.turn_id, sourceFingerprint, 'qa_turn', targetTurnId, {
            targetSessionId, contentHash: row.note_content_hash,
          }, 'completed');
        });
        report.currentNote.completed += 1;
      } catch (error) {
        writeAudit(database, sourceStore, 'assistant_turns', row.turn_id, sourceFingerprint, 'qa_turn', null, {}, 'failed', error);
        report.currentNote.failed += 1;
      }
    }
  }

  private database(): Database.Database {
    return this.databaseOwner.getDatabase(this.storageWorkspacePath);
  }
}

function mapProfile(row: LegacyProfileRow): { kind: MemoryKind; origin: MemoryOrigin; status: MemoryStatus; importance: number; rejected?: boolean } | undefined {
  const kind: MemoryKind = ['identity', 'professional', 'expertise'].includes(row.category) ? 'profile'
    : ['communication', 'collaboration', 'decision'].includes(row.category) ? 'preference'
      : ['technical-environment', 'constraints'].includes(row.category) ? 'fact'
        : row.category === 'goals' ? 'task'
          : row.category === 'interests' ? 'interest'
            : 'fact';
  if (row.category === 'decision' && row.stability === 'contextual') return undefined;
  const origin: MemoryOrigin = row.assertion_kind === 'manual' ? 'manual' : row.assertion_kind === 'explicit' ? 'explicit' : 'extracted';
  if (row.status === 'rejected') return { kind, origin, status: 'archived', importance: 2, rejected: true };
  let status: MemoryStatus = row.status === 'suggested' ? 'pending' : row.status === 'superseded' ? 'superseded' : 'active';
  if (kind === 'task' && row.temporal_status === 'historical') status = 'archived';
  if (kind === 'interest' && origin === 'extracted') status = 'pending';
  if (kind === 'fact' && (row.stability === 'contextual' || row.expires_at)) status = 'pending';
  const importance = row.user_locked ? 4 : row.confidence >= 0.8 ? 3 : 2;
  return { kind, origin, status, importance };
}

function alreadyMigrated(database: Database.Database, sourceStore: string, sourceTable: string, sourceId: string, fingerprint: string): boolean {
  const row = database.prepare(`
    SELECT source_fingerprint, status FROM memory_migration_audit
    WHERE source_store = ? AND source_table = ? AND source_id = ?
  `).get(sourceStore, sourceTable, sourceId) as { source_fingerprint: string; status: string } | undefined;
  return row?.source_fingerprint === fingerprint && ['completed', 'skipped'].includes(row.status);
}

function auditStatus(database: Database.Database, sourceStore: string, sourceTable: string, sourceId: string): string {
  return (database.prepare(`SELECT status FROM memory_migration_audit WHERE source_store = ? AND source_table = ? AND source_id = ?`)
    .get(sourceStore, sourceTable, sourceId) as { status: string } | undefined)?.status ?? 'failed';
}

function writeAudit(
  database: Database.Database,
  sourceStore: string,
  sourceTable: string,
  sourceId: string,
  sourceFingerprint: string,
  targetType: string,
  targetId: string | null,
  mapping: unknown,
  status: 'completed' | 'skipped' | 'failed',
  error?: unknown,
): void {
  const timestamp = new Date().toISOString();
  database.prepare(`
    INSERT INTO memory_migration_audit (
      source_store, source_table, source_id, source_fingerprint, target_type,
      target_id, mapping_json, status, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_store, source_table, source_id) DO UPDATE SET
      source_fingerprint = excluded.source_fingerprint, target_type = excluded.target_type,
      target_id = excluded.target_id, mapping_json = excluded.mapping_json,
      status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at
  `).run(
    sourceStore, sourceTable, sourceId, sourceFingerprint, targetType, targetId,
    JSON.stringify(mapping), status, error instanceof Error ? error.message.slice(0, 200) : null,
    timestamp, timestamp,
  );
}

function refreshSubject(database: Database.Database, scope: TrustedMemoryScope, timestamp: string): void {
  const rows = database.prepare(`
    SELECT kind, content FROM memory_items WHERE workspace_id = ? AND principal_id = ? AND status = 'active'
    ORDER BY importance DESC, COALESCE(last_used_at, valid_from) DESC, id DESC
  `).all(scope.workspaceId, scope.principalId) as Array<{ kind: MemoryKind; content: string }>;
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `- ${row.kind}：${row.content}`;
    const length = Array.from(line).length + (lines.length ? 1 : 0);
    if (used + length > MEMORY_CONSTANTS.recall.residentBlockMaxCodePoints) continue;
    lines.push(line);
    used += length;
  }
  database.prepare(`
    UPDATE memory_subjects SET block_text = ?, item_count = ?, updated_at = ?
    WHERE workspace_id = ? AND principal_id = ?
  `).run(lines.join('\n'), rows.length, timestamp, scope.workspaceId, scope.principalId);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSearchText(value: string): string {
  return value.replace(/\0/gu, '').replace(/[ \t]+/gu, ' ').replace(/\r\n?/gu, '\n').trim();
}
