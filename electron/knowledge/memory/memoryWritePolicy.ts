import { createHash } from 'node:crypto';
import { memoryFingerprint, normalizeMemoryForMatch, truncateCodePoints } from './memoryText';
import { MEMORY_CONSTANTS } from './memoryConstants';
import type { MemoryItemRecord, MemoryProposalAction, MemoryReviewReason, MemoryTargetSnapshot, MemoryWriteProtection } from './memoryTypes';

/** A release capability gate, independent of the user's saved write mode and authorization. */
export const MEMORY_EXTRACTION_PROTOCOL_VERSION = 2;
export const MEMORY_REVIEW_CAPABILITY_VERSION = 1;
export const MEMORY_AUTOMATIC_WRITE_READY = MEMORY_EXTRACTION_PROTOCOL_VERSION === 2 && MEMORY_REVIEW_CAPABILITY_VERSION === 1;

export interface MemoryItemMetadataRow {
  proposal_action: MemoryProposalAction | null;
  replaces_id: string | null;
  replaces_fingerprint: string | null;
  replaces_snapshot_json: string | null;
  review_reason: MemoryReviewReason | null;
  write_protection: MemoryWriteProtection;
}

export function mapMemoryItemMetadata(row: MemoryItemMetadataRow) {
  return {
    proposalAction: row.proposal_action, replacesId: row.replaces_id,
    replacesFingerprint: row.replaces_fingerprint,
    replacesSnapshot: row.replaces_snapshot_json ? JSON.parse(row.replaces_snapshot_json) as MemoryTargetSnapshot : null,
    reviewReason: row.review_reason, writeProtection: row.write_protection,
  };
}

/** Recall counters and timestamps are not semantic edits and must not invalidate review. */
export function memoryTargetFingerprint(item: Pick<MemoryItemRecord, 'id' | 'kind' | 'content' | 'topic' | 'importance' | 'expiresAt' | 'status' | 'memoryGeneration' | 'writeProtection'>): string {
  return createHash('sha256').update(JSON.stringify([item.id, item.kind, item.content, item.topic,
    item.importance, item.expiresAt, item.status, item.memoryGeneration, item.writeProtection])).digest('hex');
}

export function memoryProposalFingerprint(item: MemoryItemRecord): string {
  return createHash('sha256').update(JSON.stringify([memoryTargetFingerprint(item), item.proposalAction,
    item.replacesId, item.replacesFingerprint, item.replacesSnapshot, item.reviewReason])).digest('hex');
}

export function memoryTargetSnapshot(item: MemoryItemRecord): MemoryTargetSnapshot {
  return { id: item.id, kind: item.kind, content: item.content, topic: item.topic, importance: item.importance,
    expiresAt: item.expiresAt, memoryGeneration: item.memoryGeneration };
}

/** A topic classifies facts; collision disambiguation never authorizes replacement. */
export function independentMemoryKey(baseKey: string, content: string): string {
  return `${truncateCodePoints(baseKey, MEMORY_CONSTANTS.writeAndExtraction.topicNormalizedKeyMaxCodePoints)}#${memoryFingerprint(content)}`;
}

export function sameMemoryStatement(left: string, right: string): boolean {
  return normalizeMemoryForMatch(left) === normalizeMemoryForMatch(right);
}

/** Explicit-only remains model-free; unrecognized corrections are reviewable additions. */
export function isExplicitMemoryCorrection(content: string): boolean {
  return /更正|不再|改为|(?:之前|刚才|原来).{0,12}(?:说错|记错|错误)|\b(?:correction|no longer|instead of)\b/iu.test(content);
}
